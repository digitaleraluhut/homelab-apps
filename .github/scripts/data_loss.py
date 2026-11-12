#!/usr/bin/env python3
"""Data-loss check for pull requests (.github/workflows/data-loss.yml, issue #58).

Renders the changed apps with Pulumi mocks (render_app.cjs: no credentials, no secrets, no
network) on two trees, main as the PR merges onto it (base) and the PR's merge result (head),
and reports only changes that lose data: a deleted or replaced PersistentVolumeClaim,
PersistentVolume, Namespace, StatefulSet with volumeClaimTemplates, CNPG Cluster, Longhorn
Volume or Helm Release (charts keep their PVCs inside), a removed apps/<name>/ directory or a
changed Pulumi project name. An app that fails to render is reported too: it cannot be checked.
Such a PR needs the approval of its head commit by a code owner of this check's workflow
(the last .github/CODEOWNERS rule matching .github/workflows/data-loss.yml; users only).

  data_loss.py plan <base> <head>              render=true|false to $GITHUB_OUTPUT
  data_loss.py check <base> <head> <out.json>  write the findings
  data_loss.py report <findings.json>          sticky comment, label, review request, gate
                                               (env: GH_TOKEN, GITHUB_REPOSITORY, PR_NUMBER,
                                               HEAD_SHA, GITHUB_EVENT_NAME)

Limit: the render does not know the live state (e.g. foreign entries in a stack). Only a real
preview against the stack sees those; PR code never gets the deploy credentials.
"""

import dataclasses
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
RENDERER = HERE / "render_app.cjs"
MARKER = "<!-- data-loss-check -->"
LABEL = "data-loss"
SECRET_PLACEHOLDER = "render-placeholder-secret"
# Root files that change what every app renders (shared dependencies).
SHARED = ("package.json", "package-lock.json")
RENDER_TIMEOUT = 300
# Who approves data loss: the code owners of this check's workflow (last matching CODEOWNERS rule).
WORKFLOW = ".github/workflows/data-loss.yml"

PVC = "kubernetes:core/v1:PersistentVolumeClaim"
PV = "kubernetes:core/v1:PersistentVolume"
NAMESPACE = "kubernetes:core/v1:Namespace"
STATEFULSET = "kubernetes:apps/v1:StatefulSet"
HELM_RELEASE = "kubernetes:helm.sh/v3:Release"
CNPG_CLUSTER = re.compile(r"^kubernetes:postgresql\.cnpg\.io/[^:]+:Cluster$")
LONGHORN_VOLUME = re.compile(r"^kubernetes:longhorn\.io/[^:]+:Volume$")

# Fields whose change makes Pulumi replace the object (delete + create), per type.
IDENTITY = ("metadata.name", "metadata.namespace")
REPLACE_FIELDS = {
    PVC: IDENTITY
    + tuple(
        f"spec.{f}"
        for f in ("storageClassName", "accessModes", "volumeMode", "volumeName", "selector", "dataSource", "dataSourceRef")
    ),
    STATEFULSET: IDENTITY + ("spec.volumeClaimTemplates",),
    HELM_RELEASE: ("name", "namespace"),
}
# PersistentVolume: the whole spec is the volume, except these.
PV_MUTABLE = {"capacity", "persistentVolumeReclaimPolicy", "mountOptions", "claimRef"}


@dataclasses.dataclass(frozen=True)
class Finding:
    app: str
    kind: str  # deleted | replaced | app-removed | project-renamed | render-failed
    resource: str
    detail: str


class RenderError(Exception):
    pass


# ---------------------------------------------------------------------------
# Comparing two renders of one app
# ---------------------------------------------------------------------------


def _get(obj, path):
    for part in path.split("."):
        if not isinstance(obj, dict):
            return None
        obj = obj.get(part)
    return obj


def holds_data(r: dict) -> bool:
    t = r["type"]
    if t == STATEFULSET:
        return bool(_get(r["inputs"], "spec.volumeClaimTemplates"))
    return t in (PVC, PV, NAMESPACE, HELM_RELEASE) or bool(CNPG_CLUSTER.match(t) or LONGHORN_VOLUME.match(t))


def replace_fields(r: dict) -> list[str]:
    if r["type"] == PV:
        spec = {**(_get(r["inputs"], "spec") or {})}
        return list(IDENTITY) + sorted(f"spec.{k}" for k in spec if k not in PV_MUTABLE)
    return list(REPLACE_FIELDS.get(r["type"], IDENTITY))


def key(r: dict) -> str:
    """The URN without stack and project: qualified type (parent chain) and name."""
    return r["urn"].split("::", 2)[2]


def _object(r: dict):
    i = r["inputs"]
    if r["type"] == HELM_RELEASE:
        return (r["type"], i.get("name"), i.get("namespace"))
    return (r["type"], _get(i, "metadata.name"), _get(i, "metadata.namespace"))


def compare(app: str, base: list[dict], head: list[dict]) -> list[Finding]:
    heads = {r["urn"]: r for r in head}
    findings = []
    for old in base:
        if not holds_data(old):
            continue
        new = heads.get(old["urn"])
        if new is None:
            same = [key(r) for r in head if _object(r) == _object(old) and _object(old)[1]]
            detail = (
                f"same object now as `{same[0]}`: Pulumi creates that and deletes this one"
                if same
                else "removed from the app"
            )
            findings.append(Finding(app, "deleted", key(old), detail))
            continue
        changed = [
            f"{f}: {json.dumps(_get(old['inputs'], f))} → {json.dumps(_get(new['inputs'], f))}"
            for f in replace_fields(old)
            if _get(old["inputs"], f) != _get(new["inputs"], f)
        ]
        if changed:
            findings.append(Finding(app, "replaced", key(old), "; ".join(changed)))
    return findings


# ---------------------------------------------------------------------------
# Rendering two trees
# ---------------------------------------------------------------------------


def apps(root: pathlib.Path) -> dict:
    """apps/<name>/ with a Pulumi.yaml -> Pulumi project name."""
    out = {}
    for p in sorted((root / "apps").glob("*/Pulumi.yaml")):
        name = next((ln.split(":", 1)[1].strip() for ln in p.read_text().splitlines() if ln.startswith("name:")), None)
        out[p.parent.name] = name
    return out


def _digest(d: pathlib.Path) -> str:
    h = hashlib.sha256()
    for p in sorted(d.rglob("*")):
        rel = p.relative_to(d)
        if "node_modules" in rel.parts or not p.is_file() or p.suffix == ".md":
            continue
        h.update(str(rel).encode() + b"\0" + p.read_bytes() + b"\0")
    return h.hexdigest()


def changed_apps(base: pathlib.Path, head: pathlib.Path) -> list[str]:
    """Apps in both trees whose rendering may differ: own files, or the shared dependencies."""
    common = sorted(apps(base).keys() & apps(head).keys())
    shared = any(
        (base / f).read_bytes() != (head / f).read_bytes() if (base / f).exists() and (head / f).exists()
        else (base / f).exists() != (head / f).exists()
        for f in SHARED
    )
    return [a for a in common if shared or _digest(base / "apps" / a) != _digest(head / "apps" / a)]


def render(app_dir: pathlib.Path, renderer: pathlib.Path = RENDERER) -> list[dict]:
    try:
        p = subprocess.run(
            ["node", str(renderer), str(app_dir)], capture_output=True, text=True, timeout=RENDER_TIMEOUT
        )
    except subprocess.TimeoutExpired:
        raise RenderError(f"no result after {RENDER_TIMEOUT}s")
    if p.returncode != 0:
        # The error and where it was thrown; the rest of the stack is node internals.
        raise RenderError("\n".join(p.stderr.strip().splitlines()[:6]) or f"exit {p.returncode}")
    return json.loads(p.stdout)


def check(base: pathlib.Path, head: pathlib.Path, renderer: pathlib.Path = RENDERER) -> list[Finding]:
    base_apps, head_apps = apps(base), apps(head)
    findings = []
    for name in sorted(base_apps.keys() - head_apps.keys()):
        findings.append(
            Finding(name, "app-removed", f"apps/{name}/", "the next deploy no longer manages its stack and data")
        )
    for name in sorted(base_apps.keys() & head_apps.keys()):
        if base_apps[name] != head_apps[name]:
            findings.append(
                Finding(
                    name,
                    "project-renamed",
                    f"apps/{name}/Pulumi.yaml",
                    f"Pulumi project `{base_apps[name]}` → `{head_apps[name]}`: a new stack, the old one's data is orphaned",
                )
            )
    for name in changed_apps(base, head):
        try:
            findings += compare(name, render(base / "apps" / name, renderer), render(head / "apps" / name, renderer))
        except RenderError as e:
            findings.append(Finding(name, "render-failed", f"apps/{name}/", str(e)))
    return findings


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------

LIMIT = (
    "The check renders the apps with Pulumi mocks; it does not see the live state of a stack "
    "(e.g. foreign entries a deploy would delete) or what a Helm chart creates inside its release."
)


def comment_body(findings: list[Finding]) -> str:
    if not findings:
        return f"{MARKER}\n### Data-loss check\n\nNo data loss found any more in this PR.\n\n_{LIMIT}_\n"
    cell = lambda s: s.replace("|", "\\|").replace("\n", "<br>")  # noqa: E731
    rows = "\n".join(f"| {f.app} | {f.kind} | `{f.resource}` | {cell(f.detail)} |" for f in findings)
    return (
        f"{MARKER}\n### Data-loss check: owner review needed\n\n"
        "Merging this PR deploys changes that delete or replace data:\n\n"
        f"| App | Change | Resource | Detail |\n|---|---|---|---|\n{rows}\n\n"
        "The check `data-loss` stays red until a code owner of the check approves the PR's head commit. "
        "Snapshot or back up the data first if it must survive.\n\n"
        f"_{LIMIT}_\n"
    )


def _codeowners_regex(pattern: str) -> re.Pattern:
    """A CODEOWNERS (gitignore-style) path pattern as a regex over repository paths."""
    anchored = pattern.startswith("/") or "/" in pattern.strip("/")
    body = "".join(
        ".*" if tok == "**" else "[^/]*" if tok == "*" else "[^/]" if tok == "?" else re.escape(tok)
        for tok in re.findall(r"\*\*|\*|\?|[^*?]+", pattern.strip("/"))
    )
    return re.compile(("^" if anchored else "^(?:.*/)?") + body + "(?:/.*)?$")


def code_owners(text: str, path: str) -> list[str]:
    """GitHub users of the last CODEOWNERS rule matching path. Teams and e-mails are skipped:
    the workflow token cannot read team membership."""
    owners: list[str] = []
    for line in text.splitlines():
        fields = line.split("#", 1)[0].split()
        if fields and _codeowners_regex(fields[0]).match(path):
            owners = [o[1:] for o in fields[1:] if o.startswith("@") and "/" not in o]
    return owners


def approved(reviews: list[dict], owners: list[str], head_sha: str) -> bool:
    """One owner's latest decision (approve, request changes, dismissed) approves head_sha."""
    for owner in owners:
        decisions = sorted(
            (r for r in reviews if r["user"]["login"] == owner and r["state"] in ("APPROVED", "CHANGES_REQUESTED", "DISMISSED")),
            key=lambda r: r["submitted_at"] or "",
        )
        if decisions and decisions[-1]["state"] == "APPROVED" and decisions[-1]["commit_id"] == head_sha:
            return True
    return False


def _gh(*args: str, check_: bool = True) -> str:
    return subprocess.run(["gh", "api", *args], capture_output=True, text=True, check=check_).stdout


def _lines(out: str) -> list[dict]:
    return [json.loads(ln) for ln in out.splitlines() if ln.strip()]


def report(findings: list[Finding]) -> int:
    repo, pr = os.environ["GITHUB_REPOSITORY"], os.environ["PR_NUMBER"]
    head_sha = os.environ["HEAD_SHA"]
    codeowners = HERE.parent / "CODEOWNERS"
    owners = code_owners(codeowners.read_text() if codeowners.exists() else "", WORKFLOW)
    event = os.environ.get("GITHUB_EVENT_NAME", "")

    comments = _lines(_gh(f"repos/{repo}/issues/{pr}/comments", "--paginate", "--jq", ".[]"))
    mine = next((c for c in comments if MARKER in c["body"] and c["user"]["login"] == "github-actions[bot]"), None)
    if findings or mine:
        body = comment_body(findings)
        if mine and mine["body"] != body:
            _gh("-X", "PATCH", f"repos/{repo}/issues/comments/{mine['id']}", "-f", f"body={body}")
        elif not mine:
            _gh("-X", "POST", f"repos/{repo}/issues/{pr}/comments", "-f", f"body={body}")

    labels = [lb["name"] for lb in _lines(_gh(f"repos/{repo}/issues/{pr}/labels", "--jq", ".[]"))]
    if findings and LABEL not in labels:
        _gh("-X", "POST", f"repos/{repo}/issues/{pr}/labels", "-f", f"labels[]={LABEL}")
    elif not findings and LABEL in labels:
        _gh("-X", "DELETE", f"repos/{repo}/issues/{pr}/labels/{LABEL}", check_=False)

    if not findings:
        print("No data loss found.")
        return 0
    if not owners:
        print(f"::error title=No owner::.github/CODEOWNERS names no user for {WORKFLOW}; nobody can approve.")
        return 1
    reviews = _lines(_gh(f"repos/{repo}/pulls/{pr}/reviews", "--paginate", "--jq", ".[]"))
    if approved(reviews, owners, head_sha):
        print(f"Data loss found; approved by a code owner ({', '.join(owners)}) at {head_sha}.")
        return 0
    if event == "pull_request":
        r = subprocess.run(
            ["gh", "api", "-X", "POST", f"repos/{repo}/pulls/{pr}/requested_reviewers"]
            + [a for o in owners for a in ("-f", f"reviewers[]={o}")],
            capture_output=True,
            text=True,
        )
        if r.returncode != 0:
            print(f"::warning title=Review request failed::{r.stderr.strip()}")
    for f in findings:
        print(f"::error title=Data loss ({f.app})::{f.kind} {f.resource}: {f.detail}".replace("\n", " "))
    print(f"Data loss found: needs a code owner's approval ({', '.join(owners)}) of {head_sha}.")
    return 1


def main(argv: list[str]) -> None:
    if len(argv) == 3 and argv[0] == "plan":
        base, head = pathlib.Path(argv[1]), pathlib.Path(argv[2])
        render_needed = bool(changed_apps(base, head))
        print(f"render={'true' if render_needed else 'false'}")
        if out := os.environ.get("GITHUB_OUTPUT"):
            with open(out, "a") as f:
                f.write(f"render={'true' if render_needed else 'false'}\n")
    elif len(argv) == 4 and argv[0] == "check":
        findings = check(pathlib.Path(argv[1]), pathlib.Path(argv[2]))
        pathlib.Path(argv[3]).write_text(json.dumps([dataclasses.asdict(f) for f in findings], indent=2))
        print(comment_body(findings) if findings else "No data loss found.")
        if summary := os.environ.get("GITHUB_STEP_SUMMARY"):
            with open(summary, "a") as f:
                f.write(comment_body(findings) if findings else "### Data-loss check\n\nNo data loss found.\n")
    elif len(argv) == 2 and argv[0] == "report":
        findings = [Finding(**f) for f in json.loads(pathlib.Path(argv[1]).read_text())]
        sys.exit(report(findings))
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])

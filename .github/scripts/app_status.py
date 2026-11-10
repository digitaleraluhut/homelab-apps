#!/usr/bin/env python3
"""Evaluate .github/apps.yaml, the single source of truth for app status.

  app_status.py gate <app>               set enabled=true|false in $GITHUB_OUTPUT;
                                         loud notice + job summary when disabled
  app_status.py readme                   print the README apps table
  app_status.py check-readme             fail if README.md's table is out of date
  app_status.py check-pr <base> <head>   fail if the diff touches apps/<disabled>/
"""

import json
import os
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
MANIFEST = ROOT / ".github" / "apps.yaml"
README = ROOT / "README.md"
START, END = "<!-- apps:start -->", "<!-- apps:end -->"


def load() -> dict:
    try:
        import yaml  # PyYAML, if available

        data = yaml.safe_load(MANIFEST.read_text())
    except ImportError:  # GitHub runners ship yq instead
        out = subprocess.run(
            ["yq", "-o=json", ".", str(MANIFEST)], check=True, capture_output=True, text=True
        ).stdout
        data = json.loads(out)
    apps = data.get("apps") or {}
    for name, app in apps.items():
        if app.get("status") not in ("active", "disabled"):
            sys.exit(f"apps.yaml: {name}: status must be 'active' or 'disabled'")
        if not (ROOT / "apps" / name).is_dir():
            sys.exit(f"apps.yaml: {name}: apps/{name}/ does not exist")
    if errors := naming_errors(apps, ROOT):
        sys.exit("\n".join(errors))
    return apps


def naming_errors(apps: dict, root: pathlib.Path) -> list[str]:
    """One name per app: apps/<name> = Pulumi project <name> = namespace <name> = stack */<name>/*.

    Two apps with the same Pulumi project share one stack, and a deploy of one deletes the other.
    """
    errors = []
    for d in sorted(p.parent for p in (root / "apps").glob("*/Pulumi.yaml")):
        project = next(
            (ln.split(":", 1)[1].strip() for ln in (d / "Pulumi.yaml").read_text().splitlines()
             if ln.startswith("name:")),
            None,
        )
        if project != d.name:
            errors.append(f"apps/{d.name}/Pulumi.yaml: name must be '{d.name}', is '{project}'")
    for name, app in apps.items():
        if app.get("namespace", name) != name:
            errors.append(f"apps.yaml: {name}: namespace must be '{name}', is '{app['namespace']}'")
        stack = app.get("stack")
        if stack and stack.split("/")[1:2] != [name]:
            errors.append(f"apps.yaml: {name}: stack must be '<org>/{name}/<stack>', is '{stack}'")
    return errors


def gh(*lines: str, summary: str = "") -> None:
    """Print workflow commands and append to the job summary, if running in Actions."""
    for line in lines:
        print(line)
    if summary and os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write(summary + "\n")


def gate(app: str) -> None:
    apps = load()
    if app not in apps:
        sys.exit(f"apps.yaml has no entry for '{app}'. Add one (status: active|disabled).")
    a = apps[app]
    enabled = a["status"] == "active"
    if out := os.environ.get("GITHUB_OUTPUT"):
        with open(out, "a") as f:
            f.write(f"enabled={'true' if enabled else 'false'}\n")
    if enabled:
        print(f"{app}: active")
        return
    reason = a.get("reason", "no reason given")
    gh(
        f"::notice title={app} is disabled::Deploy skipped. {reason} (.github/apps.yaml)",
        summary=f"## ⏸️ `{app}` is disabled\n\n{reason}\n\nDeploy skipped. "
        "Re-enable in `.github/apps.yaml` (and the CI access list in digitaleraluhut/homelab).",
    )


def table(apps: dict) -> str:
    rows = ["| App | Status | What it does |", "|-----|--------|-------------|"]
    for name in sorted(apps):
        a = apps[name]
        if a["status"] == "active":
            status = "✅ active" + (" (manual deploy)" if a.get("deploy") == "manual" else "")
        else:
            status = f"⏸️ **disabled**: {a.get('reason', '')}"
        rows.append(f"| [{name}](./apps/{name}/) | {status} | {a.get('description', '')} |")
    return "\n".join(rows)


def readme_block(apps: dict) -> str:
    note = "<!-- generated from .github/apps.yaml by .github/scripts/app_status.py readme; do not edit -->"
    return f"{START}\n{note}\n{table(apps)}\n{END}"


def check_readme() -> None:
    text = README.read_text()
    if START not in text or END not in text:
        sys.exit(f"README.md lacks the {START} … {END} block")
    current = text[text.index(START) : text.index(END) + len(END)]
    expected = readme_block(load())
    if current != expected:
        gh(
            "::error file=README.md,title=Apps table out of date::"
            "Regenerate: python3 .github/scripts/app_status.py readme",
            summary=f"README apps table is out of date. Expected:\n\n```\n{expected}\n```",
        )
        sys.exit(1)
    print("README apps table is up to date")


def check_pr(base: str, head: str) -> None:
    apps = load()
    disabled = {n for n, a in apps.items() if a["status"] == "disabled"}
    files = subprocess.run(
        ["git", "diff", "--name-only", f"{base}...{head}"], check=True, capture_output=True, text=True
    ).stdout.split()
    hits: dict[str, list[str]] = {}
    for f in files:
        parts = f.split("/")
        if len(parts) > 2 and parts[0] == "apps" and parts[1] in disabled:
            hits.setdefault(parts[1], []).append(f)
    if not hits:
        print("No changes to disabled apps")
        return
    lines, summary = [], ["## ⏸️ This PR changes disabled apps", ""]
    for app, fs in sorted(hits.items()):
        reason = apps[app].get("reason", "")
        lines.append(f"::error title={app} is disabled::{len(fs)} file(s) changed in apps/{app}/. {reason}")
        summary.append(f"- **{app}**: {reason} ({len(fs)} file(s))")
    summary.append("\nIntended? Re-enable it in `.github/apps.yaml`, or merge anyway (this check is advisory).")
    gh(*lines, summary="\n".join(summary))
    sys.exit(1)


if __name__ == "__main__":
    cmd, args = (sys.argv[1] if len(sys.argv) > 1 else ""), sys.argv[2:]
    if cmd == "gate" and len(args) == 1:
        gate(args[0])
    elif cmd == "readme" and not args:
        print(readme_block(load()))
    elif cmd == "check-readme" and not args:
        check_readme()
    elif cmd == "check-pr" and len(args) == 2:
        check_pr(*args)
    else:
        sys.exit(__doc__)

#!/usr/bin/env python3
"""The apps of this repository.

An app is a directory apps/<name>/ with a Pulumi.yaml; nothing else registers it. One name per
app: directory = Pulumi project = stack <org>/<name>/dev = namespace <name> (the app creates it
with createAppNamespace from homelab-core-components) = hostname <name>.<domain> by default.
To retire an app, delete its directory (git history keeps it).

  app_status.py readme         print the README apps table
  app_status.py check-readme   fail if a Pulumi.yaml breaks the naming rule or README.md's table
                               is out of date
"""

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
README = ROOT / "README.md"
START, END = "<!-- apps:start -->", "<!-- apps:end -->"
ORG = "mrsimpson"  # Pulumi Cloud organization of all stacks


def _field(text: str, key: str) -> str | None:
    return next((ln.split(":", 1)[1].strip() for ln in text.splitlines() if ln.startswith(f"{key}:")), None)


def apps(root: pathlib.Path = ROOT) -> dict:
    return {
        p.parent.name: {"description": _field(p.read_text(), "description") or ""}
        for p in sorted((root / "apps").glob("*/Pulumi.yaml"))
    }


def stack(name: str) -> str:
    return f"{ORG}/{name}/dev"


def naming_errors(root: pathlib.Path = ROOT) -> list[str]:
    """Two apps with the same Pulumi project share one stack; a deploy of one deletes the other."""
    errors = []
    for p in sorted((root / "apps").glob("*/Pulumi.yaml")):
        project = _field(p.read_text(), "name")
        if project != p.parent.name:
            errors.append(f"apps/{p.parent.name}/Pulumi.yaml: name must be '{p.parent.name}', is '{project}'")
    return errors


def load(root: pathlib.Path = ROOT) -> dict:
    if errors := naming_errors(root):
        sys.exit("\n".join(errors))
    return apps(root)


def table(all_apps: dict) -> str:
    rows = ["| App | What it does |", "|-----|-------------|"]
    rows += [f"| [{n}](./apps/{n}/) | {all_apps[n]['description']} |" for n in sorted(all_apps)]
    return "\n".join(rows)


def readme_block(all_apps: dict) -> str:
    note = "<!-- generated from apps/*/Pulumi.yaml by .github/scripts/app_status.py readme; do not edit -->"
    return f"{START}\n{note}\n{table(all_apps)}\n{END}"


def check_readme() -> None:
    expected = readme_block(load())
    text = README.read_text()
    if START not in text or END not in text or text[text.index(START) : text.index(END) + len(END)] != expected:
        print(
            "::error file=README.md,title=Apps table out of date::"
            "Regenerate: python3 .github/scripts/app_status.py readme"
        )
        sys.exit(1)
    print("Naming rule holds; README apps table is up to date")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "readme" and len(sys.argv) == 2:
        print(readme_block(load()))
    elif cmd == "check-readme" and len(sys.argv) == 2:
        check_readme()
    else:
        sys.exit(__doc__)

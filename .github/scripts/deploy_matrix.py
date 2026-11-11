#!/usr/bin/env python3
"""Build the deploy matrix for .github/workflows/deploy-apps.yml.

  deploy_matrix.py <base> <head>      apps changed between the commits
  deploy_matrix.py --app <name>       one app (manual run)

Every app (apps/<name>/ with a Pulumi.yaml, see app_status.py) is deployed to stack
<org>/<name>/dev. Writes `matrix={"include":[...]}` and `any=true|false` to $GITHUB_OUTPUT.
"""

import json
import os
import subprocess
import sys

IGNORED = ("docs/", ".vibe/")


def relevant(path: str) -> bool:
    return not path.endswith(".md") and not path.startswith(IGNORED)


def entry(name: str) -> dict:
    from app_status import stack

    return {"app": name, "stack": stack(name), "dir": f"apps/{name}"}


def select(apps: dict, files: list[str], only: str | None = None) -> list[dict]:
    if only:
        if only not in apps:
            sys.exit(f"{only}: no such app (apps/{only}/Pulumi.yaml)")
        return [entry(only)]
    hit = set()
    for f in files:
        parts = f.split("/")
        if len(parts) > 2 and parts[0] == "apps" and relevant("/".join(parts[2:])):
            hit.add(parts[1])
    return [entry(n) for n in sorted(hit) if n in apps]


def main(argv: list[str]) -> None:
    sys.path.insert(0, os.path.dirname(__file__))
    import app_status

    apps = app_status.load()
    if len(argv) == 2 and argv[0] == "--app":
        include = select(apps, [], only=argv[1])
    elif len(argv) == 2:
        files = subprocess.run(
            ["git", "diff", "--name-only", argv[0], argv[1]], check=True, capture_output=True, text=True
        ).stdout.split()
        include = select(apps, files)
    else:
        sys.exit(__doc__)
    print(json.dumps(include))
    if out := os.environ.get("GITHUB_OUTPUT"):
        with open(out, "a") as f:
            f.write(f"matrix={json.dumps({'include': include})}\nany={'true' if include else 'false'}\n")


if __name__ == "__main__":
    main(sys.argv[1:])

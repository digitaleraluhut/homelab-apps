# opencode (v2)

Upstream [opencode](https://github.com/anomalyco/opencode) v2 web UI: one persistent instance behind OAuth2-Proxy (group `developers`),
independent of `apps/opencode-router` and namespace `code`.

- Image: `ghcr.io/anomalyco/opencode`, public, pinned by tag and digest in `src/index.ts`. No pull secret.
- State: one PVC on `longhorn-persistent` (Retain, R2 backups) at `/data`; `XDG_*` and `HOME` point into it.
- Projects: PVC `opencode-projects` (`longhorn-uncritical`, no backup: Longhorn cannot skip ignored paths, so
  projects live in their git remotes; reclaim Delete; 20Gi, config `opencode:projectsSize`) at `~/projects`
  (`/data/home/projects`). opencode starts there (`cd` before `opencode serve`, which has no directory
  argument), so the web UI opens in that directory.
- Plugins (pinned, `plugins` key of opencode 2.x, installed from npm at start): `@ex-machina/opencode-anthropic-auth`
  (Claude subscription, v2 line `next`), `@codemcp/workflows-opencode`, `opencode-antigravity-auth` (Google).
  Both sign-in plugins are unofficial and warn about the providers' terms (accounts may be restricted); the
  owner decided to use them (2026-11-25). Sign in once in the web UI; tokens live under `/data`.
- Agent and instructions: `config/agents/workflow.md` (from opencode-router, with its base permissions merged)
  is the default agent; `config/AGENTS.md` is the global instruction for every agent ("Always work in
  worktrees"). Both are mounted into `~/.config/opencode` from a ConfigMap named after their hash.
- Models: local-ai router (`http://flinker:8080/v1`) via `OPENCODE_CONFIG_CONTENT`; no keys. Only resident models answer.
- Namespace `opencode` and the CI's deployer rights are created by this stack (`createAppNamespace`).
- Owner step before the first deploy: `pulumi stack init mrsimpson/opencode/dev` (with its config).
- Sign-in: opencode 2.x protects its server with a password (`opencode:serverPassword`, secret),
  behind OAuth2 (since homelab#177 the OAuth chain lets opencode's own 401 through). In the browser:
  "No pairing link? Use password" on opencode's connect screen (user `opencode`). For the app or a local client, a pairing link is easier:
  `OPENCODE_PASSWORD=<password> opencode pair --url https://opencode.<domain>` (valid once, 5 minutes).
  Sessions last 30 days; changing the password signs every session out.

Web UI verified by the owner on 2026-11-25 (password sign-in).

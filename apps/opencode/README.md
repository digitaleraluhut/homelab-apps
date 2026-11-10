# opencode (v2)

Upstream [opencode](https://github.com/anomalyco/opencode) v2 web UI: one persistent instance behind OAuth2-Proxy (group `developers`),
independent of `apps/opencode-router` and namespace `code`.

- Image: `ghcr.io/anomalyco/opencode`, public, pinned by tag and digest in `src/index.ts`. No pull secret.
- State: one PVC on `longhorn-persistent` (Retain, R2 backups) at `/data`; `XDG_*` and `HOME` point into it.
- Models: local-ai router (`http://flinker:8080/v1`) via `OPENCODE_CONFIG_CONTENT`; no keys. Only resident models answer.
- Namespace `opencode` is created by the homelab stack (`appNamespaces`); this stack only references it.
- Owner steps: namespace PR in homelab, `pulumi stack init mrsimpson/opencode/dev`, workflow + `.github/apps.yaml` (runbook add-app).

Not verified before the first deploy: the `web` subcommand and flags of v2, and non-root operation on the PVC (fsGroup).

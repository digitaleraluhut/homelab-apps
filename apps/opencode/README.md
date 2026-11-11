# opencode (v2)

Upstream [opencode](https://github.com/anomalyco/opencode) v2 web UI: one persistent instance behind OAuth2-Proxy (group `developers`),
independent of `apps/opencode-router` and namespace `code`.

- Image: `ghcr.io/anomalyco/opencode`, public, pinned by tag and digest in `src/index.ts`. No pull secret.
- State: one PVC on `longhorn-persistent` (Retain, R2 backups) at `/data`; `XDG_*` and `HOME` point into it.
- Models: local-ai router (`http://flinker:8080/v1`) via `OPENCODE_CONFIG_CONTENT`; no keys. Only resident models answer.
- Namespace `opencode` and the CI's deployer rights are created by this stack (`createAppNamespace`).
- Owner step before the first deploy: `pulumi stack init mrsimpson/opencode/dev` (with its config).
- Sign-in: opencode 2.x protects its server with a password (`opencode:serverPassword`, secret),
  behind OAuth2. Sign a browser in once per device with a pairing link (valid 5 minutes, once):
  `OPENCODE_PASSWORD=<password> opencode pair --url https://opencode.<domain>`. Sessions last 30 days;
  changing the password signs every session out.

Not verified before the first deploy: the `web` subcommand and flags of v2, and non-root operation on the PVC (fsGroup).

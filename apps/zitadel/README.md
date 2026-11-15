# zitadel

ZITADEL v4.20.3 identity provider with PostgreSQL on homelab k3s.

Purpose: single identity per person in the homelab — local login (password, passkey, 2FA) or linked external identity (GitHub). Apps talk to ZITADEL via OIDC.

## Upstream facts

| Question | Answer | Source |
|----------|--------|--------|
| Latest release | v4.20.3 (published 2026-11-13) | <https://github.com/zitadel/zitadel/releases/tag/v4.20.3> |
| Image tag and digest | `ghcr.io/zitadel/zitadel:v4.20.3@sha256:1b30fea7ed88826dc0a98dacee4e2f2c8b05201fd26f5e4cb5386615b29f7638` | <https://github.com/zitadel/zitadel/releases/tag/v4.20.3> |
| In-container HTTP port | `8080` (`ZITADEL_PORT` default) | <https://zitadel.com/docs/self-hosting/manage/configure/configure> (defaults.yaml: `Port: 8080`) |
| Components | Single container — the `zitadel` binary handles API, gRPC, and UI (Login V1) | <https://zitadel.com/docs/self-hosting/deploy/kubernetes> ("The stack runs: your ingress/gateway controller → ZITADEL API (Go) + ZITADEL Login (Next.js) → PostgreSQL") |
| Database | PostgreSQL 14–18 | <https://zitadel.com/docs/self-hosting/manage/database> |
| Init phase | `zitadel init` creates DB user + database + schemas (idempotent). `zitadel init schema` skips provisioning (managed DB). | <https://zitadel.com/docs/self-hosting/manage/updating_scaling#the-init-phase> |
| Setup phase | `zitadel setup` creates first instance/org/human from config (idempotent). | <https://zitadel.com/docs/self-hosting/manage/updating_scaling#the-setup-phase> |
| Runtime | `zitadel start` serves requests | <https://zitadel.com/docs/self-hosting/manage/updating_scaling#the-runtime-phase> |
| TLS mode | `external` — Traefik terminates TLS; ZITADEL uses h2c for backend connections | <https://zitadel.com/docs/self-hosting/manage/tls_modes> |
| Protocol | Management console requires HTTP/2. Backend needs h2c (cleartext HTTP/2) from Traefik. | <https://zitadel.com/docs/self-hosting/manage/http2> ("by default HTTP/2 is always encrypted, but … h2c … is possible through h2c") |
| First admin | Created during `zitadel setup` via `FirstInstance.Org.Human.UserName`, `Email`, `Password`. `PasswordChangeRequired: true` forces change at first login. | <https://zitadel.com/docs/self-hosting/deploy/kubernetes> (production config example) |
| Master key | Encrypts sensitive data at rest; **cannot be changed after first run**. Generated once (`tr -dc A-Za-z0-9 </dev/urandom | head -c 32`). Passed via env `ZITADEL_MASTERKEY` or file. | <https://zitadel.com/docs/self-hosting/deploy/kubernetes> |
| Upgrade (v4 minor) | Update image, run `zitadel setup` (idempotent, handles migrations). | <https://zitadel.com/docs/self-hosting/manage/updating_scaling> ("The setup phase … takes care of database migrations") |
| Upgrade (v3→v4) | Requires following the v3→v4 migration path (OIDC web key staging). Not applicable for fresh installs. | <https://zitadel.com/docs/self-hosting/manage/upgrade-v3-to-v4> |
| Init container image | docker.io/library/busybox:1.36 (pinned by digest) | Registry API of docker.io |

## Deployment notes

- No oauth2-proxy in front: ZITADEL is the login itself (`AuthType.NONE`).
- Master key: generated at deploy time by Pulumi, encrypted in the stack's state. Never appears in the repository.
- First admin password: stored in a Kubernetes Secret (`zitadel-first-admin-password`), generated at deploy time from a Pulumi-encrypted secret. The owner reads it once at first login (and changes it, because `PasswordChangeRequired: true`).
- Database: CloudNativePG via `PostgresInstance`. The init Job bootstraps schemas; the setup Job creates the first instance.
- Exposure: HTTPS at `id.<domain>` via the Cloudflare Tunnel / Traefik Gateway. The Service uses `appProtocol: h2c` for HTTP/2 to the pod.
- The Deployment runs `zitadel start` with `TLS.Enabled: false` (external TLS termination).
- Health check: `GET /debug/health` on port 8080.
- No persistent storage needed: ZITADEL is stateless; all state is in PostgreSQL.

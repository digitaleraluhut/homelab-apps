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
| Setup phase | `zitadel setup --masterkeyFromEnv --config /config/zitadel.yaml` creates first instance/org/human from config (idempotent). The `--config` flag is mandatory; without it ZITADEL ignores ExternalDomain, ExternalPort, TLS, and FirstInstance from the ConfigMap. | <https://zitadel.com/docs/self-hosting/manage/updating_scaling#the-setup-phase> + <https://zitadel.com/docs/self-hosting/manage/configure/configure> ("For overwriting the default configuration for the first instance created by zitadel setup, use the FirstInstance section in the database initialization file") |
| Runtime | `/app/zitadel start --masterkeyFromEnv --config /config/zitadel.yaml` (the Dockerfile ENTRYPOINT is `/app/zitadel`; the root command at cmd/zitadel.go:41 requires a subcommand) | <https://github.com/zitadel/zitadel/blob/v4.20.3/cmd/zitadel.go> (lines 41-43: `RunE: ... return errors.New("no additional command provided")`) + <https://github.com/zitadel/zitadel/blob/v4.20.3/cmd/start/start.go> + <https://github.com/zitadel/zitadel/blob/v4.20.3/cmd/zitadel.go> (line 56: `StringArrayVar(&configFiles, "config", ...)`; line 97: `initConfig` merges them) |
| TLS mode | `external` — Traefik terminates TLS; ZITADEL uses h2c for backend connections | <https://zitadel.com/docs/self-hosting/manage/tls_modes> |
| Protocol | Management console requires HTTP/2. Backend needs h2c (cleartext HTTP/2) from Traefik. | <https://zitadel.com/docs/self-hosting/manage/http2> ("by default HTTP/2 is always encrypted, but … h2c … is possible through h2c") |
| First admin | Created during `zitadel setup` via `FirstInstance.Org.Human.UserName`, `Email`, `Password`. `PasswordChangeRequired: true` forces change at first login. FirstInstance settings belong in the config file (the "database initialization file" passed via `--config`), not in a steps file — the config overrides the default step file (steps.yaml). | <https://zitadel.com/docs/self-hosting/deploy/kubernetes> (production config example) + <https://zitadel.com/docs/self-hosting/manage/configure/configure> ("database initialization file") + <https://raw.githubusercontent.com/zitadel/zitadel/v4.20.3/cmd/setup/steps.yaml> (FirstInstance section) |
| Master key | Encrypts sensitive data at rest; **cannot be changed after first run**. Generated once (`tr -dc A-Za-z0-9 </dev/urandom | head -c 32`). Passed via env `ZITADEL_MASTERKEY` **and** the flag `--masterkeyFromEnv` (cmd/key/masterkey.go:31-48: `MasterKey()` reads the variable only when this flag is set; otherwise it reads a file or the `--masterkey` arg). | <https://zitadel.com/docs/self-hosting/deploy/kubernetes> + <https://github.com/zitadel/zitadel/blob/v4.20.3/cmd/key/masterkey.go> (lines 31-48: `MasterKey()` function) |
| Config file | ZITADEL reads config files only from the `--config` flag (cmd/zitadel.go:56). The `ZITADEL_CONFIG` env var is not read by anything. Without `--config`, ExternalDomain, ExternalPort, TLS, and FirstInstance from the ConfigMap are ignored. | <https://zitadel.com/docs/self-hosting/manage/configure/configure> + <https://github.com/zitadel/zitadel/blob/v4.20.3/cmd/zitadel.go> (line 56) |
| Upgrade (v4 minor) | Update image, run `zitadel setup` (idempotent, handles migrations). | <https://zitadel.com/docs/self-hosting/manage/updating_scaling> ("The setup phase … takes care of database migrations") |
| Upgrade (v3→v4) | Requires following the v3→v4 migration path (OIDC web key staging). Not applicable for fresh installs. | <https://zitadel.com/docs/self-hosting/manage/upgrade-v3-to-v4> |
| Binary path | `zitadel` resolves to `/app/zitadel` (PATH includes `/app`) | <https://github.com/zitadel/zitadel/blob/v4.20.3/apps/api/Dockerfile> (builder stage: `ENV PATH="/app:${PATH}"`, inherited in final stage) |
| Init container image | N/A — no init container needed. The setup Job depends on the init Job, which confirms the database is ready when `zitadel setup` runs. | <https://zitadel.com/docs/self-hosting/manage/updating_scaling#the-init-phase> (init Job runs `zitadel init schema` first) |

## Deployment notes

- No oauth2-proxy in front: ZITADEL is the login itself (`AuthType.NONE`).
- Master key: generated at deploy time by Pulumi, encrypted in the stack's state. Never appears in the repository.
- First admin password: stored in a Kubernetes Secret (`zitadel-first-admin-password`), generated at deploy time from a Pulumi-encrypted secret. The owner reads it once at first login (and changes it, because `PasswordChangeRequired: true`).
- Database: CloudNativePG via `PostgresInstance`. The init Job bootstraps schemas (`zitadel init schema`); the setup Job creates the first instance (`zitadel setup --masterkeyFromEnv --config /config/zitadel.yaml`).
- Exposure: HTTPS at `id.<domain>` via the Cloudflare Tunnel / Traefik Gateway. The Service uses `appProtocol: h2c` for HTTP/2 to the pod.
- The Deployment runs `/app/zitadel start --masterkeyFromEnv --config /config/zitadel.yaml` (the root command refuses to run without a subcommand; `zitadel start` starts the server: cmd/start/start.go; `--config` is mandatory to read ExternalDomain, TLS, FirstInstance etc. from the ConfigMap: cmd/zitadel.go:56,97).
- Config file: mounted at `/config/zitadel.yaml` from a ConfigMap. Contains ExternalDomain, ExternalPort, ExternalSecure, TLS settings and the FirstInstance section (org name, admin user). FirstInstance belongs in the config file (the "database initialization file"), not in a steps file.
- Health check: `GET /debug/healthz` on port 8080.
- No persistent storage needed: ZITADEL is stateless; all state is in PostgreSQL.

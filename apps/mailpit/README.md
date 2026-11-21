# mailpit

SMTP sink for mail from homelab apps (first: Zitadel's verification and password mails). Mail never
leaves the cluster; it is read in the web inbox at `https://mail.<domain>`, behind OAuth2-Proxy (group
`users`). Sending to real mailboxes from the homelab would need a reputable IP, PTR, SPF, DKIM and DMARC;
when other people need mail, an external provider replaces this in Zitadel's SMTP setting.

## Upstream facts

| Question | Answer | Source |
|----------|--------|--------|
| Latest release | v1.34.0 (published 2026-11-17) | <https://github.com/axllent/mailpit/releases/tag/v1.34.0> |
| Image tag and digest | `docker.io/axllent/mailpit:v1.34.0@sha256:23a2ef85bc50853ab3093645d1d64679afd8887e89da5e48a88940c172591a4e` (multi-arch index, registry API 2026-11-21) | <https://github.com/axllent/mailpit/releases/tag/v1.34.0> |
| Ports | SMTP 1025, web UI 8025 | <https://github.com/axllent/mailpit/blob/v1.34.0/Dockerfile> (EXPOSE) |
| Settings by environment | `MP_UI_BIND_ADDR`, `MP_SMTP_BIND_ADDR`, `MP_DATABASE`, `MP_MAX_MESSAGES`, `MP_DISABLE_VERSION_CHECK` | <https://github.com/axllent/mailpit/blob/v1.34.0/cmd/root.go> (lines 170-258) |
| Health endpoints | `GET /livez`, `GET /readyz` | <https://github.com/axllent/mailpit/blob/v1.34.0/server/server.go> (lines 68-69) |

## Deployment notes

- `createExposedWebApp` with OAuth2-Proxy for the UI at `mail.<domain>`; a second Service `mailpit-smtp`
  (ClusterIP, port 1025) for SMTP inside the cluster, without authentication.
- The database lives in an emptyDir (`/data`, 256Mi): it survives container restarts, not pod replacement.
  Up to 500 messages are kept.
- No calls home (`MP_DISABLE_VERSION_CHECK`); Renovate tracks the version.
- Senders: Zitadel (apps/zitadel, configure Job).

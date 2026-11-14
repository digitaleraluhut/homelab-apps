# gitea

Self-hosted Git server (Gitea 28.3.0, rootless image) with PostgreSQL, on homelab k3s.

Purpose: exchange between the operator and the owner (review requests become pull requests here).
Runs next to GitHub, not as a replacement.

## Upstream facts

| Question | Answer | Source |
|----------|--------|--------|
| Image tag and digest | `docker.io/gitea/gitea:28.3.0-rootless@sha256:40c5a68a0463c0940e1ae32626c8300dd0572f3558e390073ad8379ca67c0e1d` | <https://hub.docker.com/v2/repositories/gitea/gitea/tags/28.3.0-rootless> |
| User / UID | `1000:1000` (git user) | <https://raw.githubusercontent.com/go-gitea/gitea/v28.3.0/Dockerfile.rootless> |
| Data directory | `/var/lib/gitea` (`GITEA_WORK_DIR`) | <https://raw.githubusercontent.com/go-gitea/gitea/v28.3.0/Dockerfile.rootless> |
| Config directory | `/etc/gitea` (app.ini) + `/var/lib/gitea/custom` | <https://raw.githubusercontent.com/go-gitea/gitea/v28.3.0/Dockerfile.rootless> |
| Config format | `GITEA__<section>__<KEY>=<value>` env vars (written to app.ini at startup by entrypoint) | <https://docs.gitea.com/administration/config-cheat-sheet> |
| First-run lock | `GITEA__security__INSTALL_LOCK=true` prevents anyone from creating an admin account | <https://raw.githubusercontent.com/go-gitea/gitea/v28.3.0/custom/conf/app.example.ini> |
| Database env vars | `GITEA__database__DB_TYPE`, `HOST`, `NAME`, `USER`, `PASSWD` | <https://docs.gitea.com/administration/config-cheat-sheet> |
| Health endpoint | `GET /api/healthz` | <https://raw.githubusercontent.com/go-gitea/gitea/v28.3.0/routers/web/web.go> (main web routes: `routes.Get("/api/healthz", healthcheck.Check)`) |
| HTTP port | `3000` (in-container) | <https://raw.githubusercontent.com/go-gitea/gitea/v28.3.0/Dockerfile.rootless> |
| SSH port | `2222` (in-container, disabled by config) | <https://raw.githubusercontent.com/go-gitea/gitea/v28.3.0/Dockerfile.rootless> |

## Deployment notes

- The owner creates the admin account after the first deploy (installer is locked).
- SSH is disabled (`DISABLE_SSH = true`); git clients reach Gitea over HTTPS.
- Viewing requires an account (`REQUIRE_SIGNIN_VIEW = true`, <https://raw.githubusercontent.com/go-gitea/gitea/v28.3.0/modules/setting/service.go>); only the login page and `/api/healthz` are public.
- No OAuth2-proxy — Gitea's own accounts.
- A NodePort (30300) makes Gitea reachable from the host for non-HTTPS git operations if needed.
- Data stored on `longhorn-persistent` PVC (`/var/lib/gitea`, `/etc/gitea`), backed up daily.

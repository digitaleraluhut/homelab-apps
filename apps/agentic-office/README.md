# agentic-office

Hub of [mrsimpson/agentic-office](https://github.com/mrsimpson/agentic-office) (issue homelab#105).

- Image: `ghcr.io/mrsimpson/agentic-office/office-hub`, pinned in `Pulumi.dev.yaml` (`agentic-office:hubImage`).
  Tags are `0.0.2`, not `v0.0.2`. The Renovate custom manager in `renovate.json` matches the key.
- State: 5Gi Longhorn volume on `/data` (identity, archive, TLS certificate, signing key).
- **Internal only.** The hub speaks only TLS with a self-signed certificate and uses its own tokens,
  so it does not fit `ExposedWebApp` as is. Reachable at `https://office-hub.agentic-office.svc:8740`.
  Public exposure (Cloudflare tunnel to an HTTPS origin, or a certificate from cert-manager) is open.
- Admins: optional config `agentic-office:admins` (public keys, format see `identity.LoadAdmins` in the
  product). Without it nobody can register keys.
- Needs the namespace `agentic-office` in `appNamespaces` (homelab, owner review) and an entry in
  `.github/apps.yaml` with `stack: mrsimpson/agentic-office/dev`.
- Rollback: revert the tag PR. Verify: `kubectl -n agentic-office rollout status deploy/office-hub`.

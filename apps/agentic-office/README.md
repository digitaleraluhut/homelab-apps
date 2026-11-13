# agentic-office

> Part of [homelab-apps](../../README.md) — the hub of [agentic-office](https://github.com/mrsimpson/agentic-office):
> meetings for humans and agents (`office-hub`). Participants use the `office` client on their own computers.

One pod, one volume:

- Deployment, **1 replica, strategy `Recreate`** (the volume is ReadWriteOnce and the hub is the only writer of its git archive).
- PVC `agentic-office-data` (`longhorn-persistent`, `storageSize`) mounted at `/data`: users and keys, TLS certificate, the archive of all sessions, and the signing key.
- Init container `signing-key`: runs `office-hub keygen /data/signing.key` **only if the file is missing**, then `chmod 0400`.
  It runs as uid 10001 (the image's user `office`), `fsGroup` 10001. The hub never creates the key itself and refuses to start without it.
  **Back up `/data/signing.key`**: without it, old tree heads cannot be checked any more. A restart never replaces it.
- Service on **8740, TLS only** (the hub creates a self-signed certificate in `/data/tls.crt`).
- Exposure through the Cloudflare tunnel at `<domainPrefix>.<domain>` **without OAuth**: the hub has its own key-based login
  (every call except `GetChallenge`/`ExchangeChallenge` needs a token). The tunnel delivers HTTP to Traefik; a Traefik
  `IngressRoute` talks TLS to the hub (`ServersTransport` with `insecureSkipVerify`, because the certificate is self-signed
  and only valid for the hub's own names; this hop stays inside the cluster).
- Args: `-data-dir /data -addr 0.0.0.0:8740 -signing-key /data/signing.key -public-url <url> -first-system-admin <id>=<public key>`.
- Public image, no pull secret. TCP readiness probe on 8740 (the hub needs a token for every real call). Requests 128Mi, limit 512Mi.

## Why not ExposedWebApp

`createExposedWebApp` from homelab-core-components cannot express three things this hub needs, so the app creates
Deployment, Service and route itself (the namespace still comes from `createAppNamespace`). Gaps in the component:

1. **TLS-only origin**: it always creates a Service on port 80 and routes plain HTTP to it (HTTPRoute or IngressRoute without `scheme`/`serversTransport`).
2. **Deployment strategy**: no option; it is always the default `RollingUpdate`, which cannot work with a ReadWriteOnce volume and a single writer.
3. **Signing key init step** is expressible (`initContainers` and `extraVolumes`), so it is not a gap by itself; it only needs the same volume as the app, which this app defines itself anyway.

## Configuration

| Key | Required | Meaning |
|---|---|---|
| `agentic-office:homelabStack` | yes | StackReference of the base stack |
| `agentic-office:hubImage` | yes | `ghcr.io/mrsimpson/agentic-office/office-hub:<tag>`; Renovate bumps the tag (the key ends in `Image`, see `renovate.json`) |
| `agentic-office:systemAdminId` | yes | ID of the first system admin, e.g. `root` |
| `agentic-office:systemAdminPublicKey` | yes | public key of the first system admin (from `office key create`; no secret) |
| `agentic-office:domainPrefix` | no (`office`) | subdomain |
| `agentic-office:storageSize` | no (`5Gi`) | size of the volume |
| `agentic-office:publicUrl` | no (`https://<domainPrefix>.<domain>`) | base URL in stage links |

`Pulumi.dev.yaml` holds the placeholder `REPLACE-WITH-PUBLIC-KEY`. Set the real key **before the first deploy**
(the first start is the only time the hub reads `-first-system-admin`):

```sh
office key create        # on your own computer; prints "public key: …"
cd apps/agentic-office
pulumi config set agentic-office:systemAdminId root --stack dev
pulumi config set agentic-office:systemAdminPublicKey '<public key>' --stack dev
```

The deploy workflow's smoke check needs the repository variable `AGENTIC_OFFICE_URL` (`https://<domainPrefix>.<domain>`).

## Updates and rollback

- Latest release is "current": Renovate opens a PR with the new `hubImage` tag; merging it deploys (Recreate: a short outage).
- After the rollout, the `Smoke agentic-office` job in `deploy-apps.yml` checks the TLS handshake and that an unauthenticated
  `GetChallenge` with an unregistered public key answers `unauthenticated` (`.github/scripts/smoke_agentic_office.py`).
- Rollback: revert the tag change in `Pulumi.dev.yaml` and merge. The volume is kept. (A release that migrates data in `/data` is not undone by this.)

## First start

After the first deploy (`kubectl -n agentic-office logs deploy/agentic-office` shows `signing key of tree heads …`).
Details: [USER_GUIDE](https://github.com/mrsimpson/agentic-office/blob/main/USER_GUIDE.md).

1. On your computer, install the `office` client and point it at the hub: `export OFFICE_HUB=https://<domainPrefix>.<domain>`.
   The public name has a certificate from Cloudflare, so the client needs no certificate file. Check with `office whoami`.
2. The system admin (`root`) creates users and tenants. A system admin is **never a member of a tenant**: use another key for your work in a tenant.

```sh
office admin user create grace <public key of grace> --name "Grace Hopper" --kind human
office admin user create minutes-bot <public key of the bot> --name "Minute Bot" --kind agent
office admin tenant create acme grace --name "Acme Corp"      # grace is the first tenant admin
office admin member set acme minutes-bot                      # the tenant admin may do this too
office admin member list acme
```

More: `office admin key add|revoke`, `office admin member set <tenant> <user> --role tenant-admin`, `office admin link` (admin view in the browser).

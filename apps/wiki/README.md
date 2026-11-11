# wiki

> Part of [homelab-apps](../../README.md) — serves the LLM-maintained homelab wiki.

The wiki content lives in a **private** git repository. Its CI builds a static site (Quartz) and pushes it to
the branch `site`. This stack runs one pod:

- `git-sync` sidecar: pulls the `site` branch over HTTPS every `syncPeriod`, authenticating as a **read-only GitHub App**
  (Contents: read-only, installed only on the content repo; short-lived installation tokens). The checkout is exposed as `/git/current`.
- `nginx` (unprivileged) serves `/git/current` on port 8080.
- Exposure: `createExposedWebApp` with OAuth2-Proxy (group `users`) at `<domainPrefix>.<domain>`.

No database, no PVC, no custom image: a restart re-clones the branch.

## Namespace

This stack creates the namespace `wiki` and the CI's deployer rights in it (`createAppNamespace`
from homelab-core-components). The homelab stack's admission policies only admit it with
`homelab/deployer=homelab-apps` and pod-security `restricted`.

## Configuration

| Key | Required | Meaning |
|---|---|---|
| `wiki:homelabStack` | yes | StackReference of the base stack |
| `wiki:gitRepo` | yes | HTTPS URL of the content repo |
| `wiki:githubAppId` | yes | numeric App ID |
| `wiki:githubAppInstallationId` | yes | installation ID of the app on the content repo |
| `wiki:githubAppPrivateKey` | yes (secret) | the app's private key (PEM) |
| `wiki:gitRef` | no (`site`) | branch with the built static site |
| `wiki:syncPeriod` | no (`60s`) | git-sync polling interval |
| `wiki:domainPrefix` | no (`wiki`) | subdomain |
| `wiki:syncImage`, `wiki:nginxImage` | no | override the pinned images (tag **and** digest) |

Create a GitHub App (org settings → Developer settings): permission *Contents: Read-only*, no webhook, install it
**only** on the content repo. Generate a private key (PEM), then:

```sh
pulumi config set wiki:githubAppId <App ID> --stack dev
pulumi config set wiki:githubAppInstallationId <installation ID> --stack dev
pulumi config set wiki:githubAppPrivateKey --secret --stack dev < ./app.pem
shred -u ./app.pem
```

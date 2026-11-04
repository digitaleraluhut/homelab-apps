# wiki

> Part of [homelab-apps](../../README.md) — serves the LLM-maintained homelab wiki.

The wiki content lives in a **private** git repository. Its CI builds a static site (Quartz) and pushes it to
the branch `site`. This stack runs one pod:

- `git-sync` sidecar: pulls the `site` branch over SSH with a **read-only deploy key** every `syncPeriod`
  (host keys of github.com are pinned in a ConfigMap; host key checking stays on). The checkout is exposed as `/git/current`.
- `nginx` (unprivileged) serves `/git/current` on port 8080.
- Exposure: `createExposedWebApp` with OAuth2-Proxy (group `users`) at `<domainPrefix>.<domain>`.

No database, no PVC, no custom image: a restart re-clones the branch.

## Namespace

The namespace `wiki` is **created by the `homelab` stack** (listed in `appNamespaces`, not in `existingNamespaces`).
This stack only references it. Deploy `homelab` first.

## Configuration

| Key | Required | Meaning |
|---|---|---|
| `wiki:homelabStack` | yes | StackReference of the base stack |
| `wiki:gitRepo` | yes | SSH URL of the content repo |
| `wiki:gitSshKey` | yes (secret) | private half of a read-only deploy key |
| `wiki:gitRef` | no (`site`) | branch with the built static site |
| `wiki:syncPeriod` | no (`60s`) | git-sync polling interval |
| `wiki:domainPrefix` | no (`wiki`) | subdomain |
| `wiki:syncImage`, `wiki:nginxImage` | no | override the pinned images (tag **and** digest) |

Create the key pair, register the public half as a *read-only* deploy key on the content repo, and set the private half:

```sh
ssh-keygen -t ed25519 -N '' -C wiki-readonly -f ./deploy_key
pulumi config set wiki:gitSshKey --secret --stack dev < ./deploy_key
shred -u ./deploy_key
```

# homelab-apps

> Part of [digitaleraluhut](https://github.com/digitaleraluhut) — the application layer. Each app deploys onto the [homelab](https://github.com/digitaleraluhut/homelab) cluster and connects to [local-ai](https://github.com/digitaleraluhut/local-ai) for inference, transcription, and image generation.

Personal homelab app deployments — each app is a [Pulumi](https://www.pulumi.com/) project
that consumes [`@mrsimpson/homelab-core-components`](https://www.npmjs.com/package/@mrsimpson/homelab-core-components)
and deploys onto the homelab k3s cluster.

## Apps

<!-- apps:start -->
<!-- generated from apps/*/Pulumi.yaml by .github/scripts/app_status.py readme; do not edit -->
| App | What it does |
|-----|-------------|
| [librechat](./apps/librechat/) | LibreChat deployment — self-hosted agent chat on homelab k8s |
| [opencode](./apps/opencode/) | opencode v2 (upstream release), persistent with its own config dir, behind OAuth, on homelab k8s |
| [opencode-router](./apps/opencode-router/) | opencode-router deployment — per-user isolated OpenCode instances on homelab k8s |
| [soundtouch](./apps/soundtouch/) | soundtouch deployment — AfterTouch (Bose SoundTouch cloud replacement), unprivileged and LAN-only via node ports, on homelab k8s |
| [wiki](./apps/wiki/) | wiki deployment — static wiki site synced from a private git repo, protected by OAuth, on homelab k8s |
<!-- apps:end -->

## Repository layout

```
homelab-apps/
├── package.json               ← npm workspaces root; shared devDeps (typescript, @types/node)
├── tsconfig.base.json         ← shared TypeScript compiler options
├── apps/
│   └── lobehub/               ← self-hosted LobeHub (AI chat)
│       ├── Pulumi.yaml
│       ├── Pulumi.dev.yaml
│       ├── src/
│       │   ├── index.ts
│       │   └── models.ts
│       ├── package.json
│       └── tsconfig.json
└── .github/
    └── workflows/
        └── deploy-lobehub.yml ← calls digitaleraluhut/homelab/.github/workflows/deploy-to-cluster.yml
```

## How it works

Each app in `apps/<name>/` is a standalone Pulumi project.  It reads shared
infrastructure outputs (domain, tunnel CNAME, Cloudflare zone) via a
`StackReference` to your homelab base stack and manages its own Kubernetes resources
in an isolated Pulumi state.

GitHub Actions deploys to the cluster by calling the reusable
[`deploy-to-cluster.yml`](https://github.com/digitaleraluhut/homelab/blob/main/.github/workflows/deploy-to-cluster.yml)
workflow from the `digitaleraluhut/homelab` repo.

### Data-loss check on pull requests

`data-loss.yml` renders every changed app with Pulumi mocks (`.github/scripts/render_app.cjs`:
no credentials, no secrets, no network) on `main` and on the PR's merge result, and compares
them (`.github/scripts/data_loss.py`). It reports only changes that lose data: a deleted or
replaced PersistentVolumeClaim, PersistentVolume, Namespace, StatefulSet with
volumeClaimTemplates, CNPG `Cluster`, Longhorn `Volume` or Helm `Release`, a removed
`apps/<name>/` or a changed Pulumi project name. Then the PR gets a sticky comment, the label
`data-loss` and a review request to the owner, and the required check `data-loss` stays red
until the owner approves the PR's head commit. Without findings nothing changes.

It does not see the live state of a stack (e.g. foreign entries a deploy would delete) or what a
Helm chart creates inside its release. Apps must render offline: the renderer stubs `fetch` and
stops the clock; a new app that needs more (another network client, a new StackReference
output) has to be covered in `render_app.cjs`, or the check reports it as `render-failed`.

## Deploying to your own homelab

These apps are designed to be forkable. They depend on a separate
[homelab](https://github.com/digitaleraluhut/homelab) base stack that provides shared
infrastructure (Cloudflare tunnel, domain, zone ID). You need to run that first.

### Prerequisites

1. A running k3s (or compatible) cluster
2. The [homelab](https://github.com/digitaleraluhut/homelab) base stack deployed and its
   Pulumi stack outputs available (exports `domain`, `cloudflareZoneId`, `tunnelId`)
3. A [Pulumi Cloud](https://app.pulumi.com) account (free tier works)
4. `pulumi` CLI authenticated: `pulumi login`

### One-time setup per app

```bash
cd apps/<name>

# Create your stack
pulumi stack init dev

# Point it at YOUR homelab base stack (replace with your Pulumi org)
pulumi config set <app>:homelabStack <your-pulumi-org>/homelab/dev

# Copy the example config and fill in your values
cp Pulumi.dev.yaml.example Pulumi.dev.yaml
# Edit Pulumi.dev.yaml — replace all <placeholder> values
# Then import it:
pulumi config --path < Pulumi.dev.yaml

# Set required secrets (see Pulumi.dev.yaml.example comments for what's needed)
pulumi config set <app>:someSecret <value> --secret

# Deploy
pulumi up
```

> **Note:** `homelabStack` has no default — Pulumi will error immediately if it is not set,
> preventing silent cross-org stack references.

### CI/CD with GitHub Actions

Fork both repos ([homelab](https://github.com/digitaleraluhut/homelab) and this one),
then add these secrets to your fork of `homelab-apps`:

| Secret | How to get it |
|--------|---------------|
| `PULUMI_ACCESS_TOKEN` | Pulumi Cloud → Access Tokens |
| `KUBECONFIG` | the homelab stack output `ciAppsKubeconfig` (CI ServiceAccount `ci-access/homelab-apps`), `base64 -w0` |
| `TS_OAUTH_CLIENT_ID` | Tailscale admin → OAuth clients (`tag:ci`) |
| `TS_OAUTH_CLIENT_SECRET` | Same OAuth client |

`deploy-apps.yml` calls a reusable
[`deploy-to-cluster.yml`](https://github.com/digitaleraluhut/homelab/blob/main/.github/workflows/deploy-to-cluster.yml)
from the homelab repo — update its `uses:` line to point to your fork.

## Security & Secrets

### How secrets are stored

| What | Mechanism | Tracked in git? |
|------|-----------|-----------------|
| Pulumi stack config (passwords, tokens, keys) | Pulumi Cloud AES-256-GCM encryption (`secure:` values) | Yes — `Pulumi.dev.yaml`, secrets only as ciphertext |
| Example config structure | `Pulumi.dev.yaml.example` per app | Yes — placeholders only |

### Local setup on a new machine

```bash
# 1. Authenticate with Pulumi Cloud (restores all encrypted stack config)
pulumi login

# 2. For each app, select the stack. Its Pulumi.dev.yaml is in git (secrets only as ciphertext),
#    so no copying is needed.
cd apps/<name>
pulumi stack select mrsimpson/<name>/dev
```

## Required repository secrets

| Secret | Description |
|--------|-------------|
| `PULUMI_ACCESS_TOKEN` | Pulumi Cloud access token |
| `KUBECONFIG` | base64-encoded kubeconfig of the CI ServiceAccount (one for all apps, Tailscale address) |
| `TS_OAUTH_CLIENT_ID` | Tailscale OAuth client ID (`tag:ci`) |
| `TS_OAUTH_CLIENT_SECRET` | Tailscale OAuth client secret |

Bootstrap all secrets in one step from the `digitaleraluhut/homelab` repo:

```bash
./scripts/setup-homelab-apps.sh
```

## Agent skills

This repo ships [agentskills.io](https://agentskills.io)-compatible skills under `skills/`.
Load them in your AI agent to deploy and configure apps without reading documentation manually.

| Skill | When to use |
|-------|-------------|
| [`deploy-homelab-app`](./skills/deploy-homelab-app/SKILL.md) | Add a new app end-to-end (name → scaffold → stack → PR) |
| [`add-app-with-database`](./skills/add-app-with-database/SKILL.md) | App needs a PostgreSQL database (CNPG) |
| [`add-app-with-oauth`](./skills/add-app-with-oauth/SKILL.md) | Protect an app with GitHub OAuth (oauth2-proxy) |
| [`add-app-with-secrets`](./skills/add-app-with-secrets/SKILL.md) | Wire secrets from Pulumi ESC into an app |

## Adding a new app

Load the [`deploy-homelab-app`](./skills/deploy-homelab-app/SKILL.md) skill in your AI agent and say *"add a new app to homelab-apps"*.

In short: create `apps/<name>/` with a `Pulumi.yaml` named `<name>` (that name is also the stack
`mrsimpson/<name>/dev`, the namespace and the default hostname); the app creates its namespace
with `createAppNamespace(<name>)`; init the stack and its config; open a PR. On merge,
`deploy-apps.yml` deploys it. No workflow, kubeconfig or homelab change per app. Apps here run
with pod-security `restricted`; privileged workloads belong in the homelab repo.

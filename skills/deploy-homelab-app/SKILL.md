---
name: deploy-homelab-app
description: Add a new personal app to the homelab-apps monorepo and deploy it to the homelab k3s cluster via GitHub Actions CI/CD. Use when the user wants to self-host a new application (e.g. Vaultwarden, Gitea, Jellyfin) on their homelab cluster using the homelab-apps pattern.
compatibility: Requires the homelab-apps repo cloned locally, the pulumi CLI (logged in to Pulumi Cloud) and gh. kubectl only for checking the result.
metadata:
  author: mrsimpson
  homelab-repo: https://github.com/digitaleraluhut/homelab
  homelab-apps-repo: https://github.com/digitaleraluhut/homelab-apps
---

# Deploy a New App to homelab-apps

## The rule

**One name per app.** `apps/<name>/` = Pulumi project `<name>` = stack `mrsimpson/<name>/dev`
= namespace `<name>` = config prefix `<name>:` (default hostname `<name>.<domain>`).
There is no registry: a directory with a `Pulumi.yaml` *is* an app. The PR check fails if a
`Pulumi.yaml` name differs from its directory.

**The app creates its own namespace** with `createAppNamespace(name)` from
`@mrsimpson/homelab-core-components`. That also binds the CI's deployer role there. The cluster's
admission policies (homelab, ci-access) only admit it with `homelab/deployer=homelab-apps` and
pod-security `restricted`, so apps here run unprivileged. Privileged workloads (hostNetwork,
hostPath, root) belong in the homelab repo, like aftertouch.

**Deploys are automatic.** `deploy-apps.yml` deploys every app whose directory changed on `main`.
No per-app workflow, no per-app kubeconfig, no change in the homelab repo.

## Step 1 — Check the name

```bash
APP=<app-name>   # lowercase, hyphens only; becomes namespace and hostname
grep -h '^name:' apps/*/Pulumi.yaml   # must not exist yet
```

A Pulumi stack is identified by project name. Reusing a name means a deploy of the new app
deletes the old one's resources.

## Step 2 — Scaffold

Copy the structure of a small app (`apps/wiki/`): `package.json` (name `@homelab-apps/$APP`,
current `@mrsimpson/homelab-core-components`), `tsconfig.json`, `Pulumi.yaml` with
`name: $APP` and its config schema, `Pulumi.dev.yaml.example`. Then `npm install` at the root.

## Step 3 — `src/index.ts`

```typescript
import * as pulumi from '@pulumi/pulumi';
import {
  AuthType,
  createAppNamespace,
  createHomelabContextFromStack,
} from '@mrsimpson/homelab-core-components';

const APP_NAME = '<app-name>';
const APP_PORT = 8080; // the container's listen port

const cfg = new pulumi.Config(APP_NAME);
const homelabStack = new pulumi.StackReference(cfg.require('homelabStack'));
const homelab = createHomelabContextFromStack(homelabStack);
const domain = homelabStack.getOutput('domain') as pulumi.Output<string>;

// Namespace + the CI's deployer rights. Use `ns` for everything else: it resolves only once
// the CI may create resources there.
const { namespace: ns } = createAppNamespace(APP_NAME);

export const app = homelab.createExposedWebApp(APP_NAME, {
  namespace: ns,
  image: cfg.require('image'),
  domain: pulumi.interpolate`${APP_NAME}.${domain}`,
  port: APP_PORT,
  replicas: 1,
  auth: AuthType.OAUTH2_PROXY,
  oauth2Proxy: { group: 'users' },
});
```

For resources you create yourself, set `namespace: ns.metadata.name` (not a string constant),
so they wait for the namespace and the CI's rights. Pods must satisfy pod-security
`restricted` (non-root, no privilege escalation, dropped capabilities, seccomp RuntimeDefault).

Check: `npm run type-check --workspace=apps/$APP` and `npm test`.

## Step 4 — Stack and config (owner: Pulumi Cloud)

```bash
cd apps/$APP
pulumi stack init mrsimpson/$APP/dev
pulumi config set $APP:homelabStack mrsimpson/homelab/dev
pulumi config set $APP:image <registry>/<image>:<tag>@<digest>
pulumi config set --secret $APP:<key> <value>   # secrets: encrypted in Pulumi.dev.yaml
```

Commit `Pulumi.dev.yaml` (secrets are only stored encrypted).

## Step 5 — Pull request and deploy

Open a PR. Checks: types, tests, naming rule, README apps table
(`python3 .github/scripts/app_status.py readme` regenerates it). On merge, `deploy-apps.yml`
deploys the app. Manual run: Actions → "Deploy apps" → `app=<name>`.

## Step 6 — Verify

```bash
gh run list -R digitaleraluhut/homelab-apps -w deploy-apps.yml --limit 3
kubectl get pods,ingressroute -n $APP
```

## Common issues

**`admission webhook … denied`** on the namespace: it lacks `createAppNamespace`'s labels, or
the app needs a privileged pod. Privileged apps go to the homelab repo.

**Forbidden while refreshing** an existing stack whose resources live in a namespace without
the CI's RoleBinding: the first deploy after switching to `createAppNamespace` must run once
locally with admin rights (`pulumi up --refresh`); then CI takes over.

**Image not found**: Docker Hub images have no registry prefix; GHCR is `ghcr.io/owner/image`;
tags often lack the `v` of the release name.

## See also

- `apps/wiki/`, `apps/opencode/` — small reference apps
- `skills/add-app-with-oauth`, `add-app-with-secrets`, `add-app-with-database`
- homelab: `packages/core/infrastructure/src/ci-access` (CI rights and admission policies)

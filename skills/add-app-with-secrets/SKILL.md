---
name: add-app-with-secrets
description: Wire application secrets from Pulumi ESC into an app in homelab-apps using the External Secrets Operator, or generate a secret or key pair once and keep it in the stack state (@pulumi/random, @pulumi/tls). Use when the user says "this app needs an API key", "add a secret to this app", "configure credentials for this service", or "pull a secret from ESC into the app".
compatibility: Requires the homelab cluster with External Secrets Operator running and the pulumi-esc ClusterSecretStore configured. App workspace must already exist under apps/<name>/.
metadata:
  author: mrsimpson
  homelab-apps-repo: https://github.com/digitaleraluhut/homelab-apps
---

# Add Secrets to an App

Wire secrets from **Pulumi ESC** into a `homelab-apps` app via the External Secrets Operator (ESO).
Secrets are stored centrally in Pulumi ESC and synced automatically to Kubernetes every hour.

## Architecture

```
Pulumi ESC (digitaleraluhut/homelab/dev)
  ↓  ClusterSecretStore: pulumi-esc
External Secrets Operator
  ↓  ExternalSecret (per app)
Kubernetes Secret (synced every hour)
  ↓  envFrom / env / volume
App Pod
```

## Step 1 — Add the secret to Pulumi ESC

```bash
# View current secrets
pulumi env open digitaleraluhut/homelab/dev

# Edit and add your secret (use flat key naming: service-type-identifier)
pulumi env edit digitaleraluhut/homelab/dev
```

Naming convention: `{service}-{type}-{identifier}`, e.g.:
- `stripe-api-key`
- `sendgrid-api-key`
- `myapp-admin-token`

## Step 2 — Create an ExternalSecret in `src/index.ts`

```typescript
import * as k8s from '@pulumi/kubernetes';

const appSecrets = new k8s.apiextensions.CustomResource(`${APP_NAME}-secrets`, {
  apiVersion: 'external-secrets.io/v1beta1',
  kind: 'ExternalSecret',
  metadata: {
    name: `${APP_NAME}-secrets`,
    namespace: ns.metadata.name,
  },
  spec: {
    refreshInterval: '1h',
    secretStoreRef: {
      name: 'pulumi-esc',           // shared ClusterSecretStore
      kind: 'ClusterSecretStore',
    },
    target: {
      name: `${APP_NAME}-secrets`,  // name of the resulting K8s Secret
      creationPolicy: 'Owner',
    },
    data: [
      {
        secretKey: 'STRIPE_API_KEY',           // env var name in the pod
        remoteRef: { key: 'stripe-api-key' },  // key in Pulumi ESC
      },
      {
        secretKey: 'SENDGRID_API_KEY',
        remoteRef: { key: 'sendgrid-api-key' },
      },
    ],
  },
}, { dependsOn: ns });
```

## Step 3 — Mount the secret into the app

```typescript
export const app = homelab.createExposedWebApp(APP_NAME, {
  namespace: ns,
  image: pulumi.output(image),
  domain: pulumi.interpolate`${APP_NAME}.${domain}`,
  port: APP_PORT,
  auth: AuthType.OAUTH2_PROXY,
  // Mount all keys from the secret as env vars:
  envFrom: [{ secretRef: { name: `${APP_NAME}-secrets` } }],
  // Or mount specific keys:
  // env: [{ name: 'STRIPE_KEY', valueFrom: { secretKeyRef: { name: `${APP_NAME}-secrets`, key: 'STRIPE_API_KEY' } } }],
});
```

Make sure `appSecrets` is created before the app:
```typescript
export const app = homelab.createExposedWebApp(APP_NAME, {
  // ...
}, { dependsOn: [ns, appSecrets] });
```

## Step 4 — Deploy and verify

```bash
cd apps/<name>
pulumi up --stack digitaleraluhut/<name>/dev

# Check ExternalSecret status (should be Ready)
kubectl describe externalsecret <name>-secrets -n <name>

# Verify secret was created
kubectl get secret <name>-secrets -n <name>
```

## Secrets the app generates itself (no ESC)

For values nobody has to know, only the app (a master key, an initial admin password, a session
secret), let Pulumi generate them once and keep them in the stack state, with `@pulumi/random`.
It is installed at the workspace root; declare it in your app's `package.json` as well
(`"@pulumi/random": "^4.21.6"`) and run `npm install --package-lock-only --offline --ignore-scripts`.

```typescript
import * as random from '@pulumi/random';

// Generated on the first `pulumi up`, then read from the stack state: the same value on every
// later deploy. It changes only if the resource is replaced (renamed, or an input such as
// `length` changed). `.result` is a secret Output: Pulumi stores it encrypted and masks it.
const masterKey = new random.RandomPassword(`${APP_NAME}-masterkey`, {
  length: 32,      // e.g. an app that requires exactly 32 characters
  special: false,  // letters and digits only, for keys with a fixed charset
});

const generated = new k8s.core.v1.Secret(`${APP_NAME}-generated`, {
  metadata: { name: `${APP_NAME}-generated`, namespace: ns.metadata.name },
  stringData: { MASTER_KEY: masterKey.result },
});
// In the app: env: [{ name: 'MASTER_KEY', valueFrom: { secretKeyRef: { name: `${APP_NAME}-generated`, key: 'MASTER_KEY' } } }]
```

Do not use `crypto.randomBytes` or `Math.random` in the program: they produce a new value on every
deploy (a new master key makes existing data unreadable). Never put the value in a ConfigMap, a
literal `env` value or a stack export; reference the Secret.

### Key pairs and certificates (@pulumi/tls)

When two components authenticate with a key (a service account key, a JWT signing key, a client
certificate), generate the key pair with `@pulumi/tls`, installed at the workspace root like
`@pulumi/random` (in your app's `package.json`: `"@pulumi/tls": "^5.6.3"`).

```typescript
import * as tls from '@pulumi/tls';

// Generated once, then read from the stack state. `.privateKeyPem` is a secret Output.
const key = new tls.PrivateKey(`${APP_NAME}-login-key`, { algorithm: 'RSA', rsaBits: 2048 });

// Only if the other side needs a certificate, not just the public key (`key.publicKeyPem`).
// It is replaced by a deploy within `earlyRenewalHours` of its expiry; the key stays.
const cert = new tls.SelfSignedCert(`${APP_NAME}-login-cert`, {
  privateKeyPem: key.privateKeyPem,
  subject: { commonName: `${APP_NAME}-login` },
  validityPeriodHours: 24 * 365 * 10,
  earlyRenewalHours: 24 * 30,
  allowedUses: ['digital_signature', 'key_encipherment'],
});

const keyPair = new k8s.core.v1.Secret(`${APP_NAME}-login-key`, {
  metadata: { name: `${APP_NAME}-login-key`, namespace: ns.metadata.name },
  type: 'kubernetes.io/tls',
  stringData: { 'tls.key': key.privateKeyPem, 'tls.crt': cert.certPem },
});
// Mount it as a volume (files tls.key, tls.crt), or one key with secretKeyRef.
```

**Never write key material as a literal** (a PEM block, base64 of one, a long encoded string): the
repository is public, and its gitleaks scan rejects it. If no building block can produce what the app
needs, ask for one instead of working around it.

## Rotating secrets

1. Update the value in Pulumi ESC:
   ```bash
   pulumi env edit digitaleraluhut/homelab/dev
   ```

2. Force immediate sync (instead of waiting up to 1h):
   ```bash
   kubectl annotate externalsecret <name>-secrets \
     force-sync="$(date +%s)" -n <name>
   ```

3. Restart the app to pick up the new value:
   ```bash
   kubectl rollout restart deployment/<name> -n <name>
   ```

## Troubleshooting

**ExternalSecret not syncing** — check status and ESO logs:
```bash
kubectl describe externalsecret <name>-secrets -n <name>
kubectl logs -n external-secrets -l app.kubernetes.io/name=external-secrets
```

**Pod can't read secret** — verify the secret exists and check env var names:
```bash
kubectl get secret <name>-secrets -n <name> -o yaml
kubectl exec -n <name> deploy/<name> -- env | grep <KEY_NAME>
```

**Key not found in ESC** — the `remoteRef.key` must exactly match the key in the ESC environment:
```bash
pulumi env open digitaleraluhut/homelab/dev | grep <key-name>
```

## See also

- [ADR-008: Secrets Management](https://github.com/digitaleraluhut/homelab/blob/main/docs/adr/008-secrets-management.md)
- [manage-secrets.md](https://github.com/digitaleraluhut/homelab/blob/main/docs/howto/manage-secrets.md) — full ESC + ESO architecture
- [External Secrets Operator docs](https://external-secrets.io)

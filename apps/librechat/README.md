# LibreChat

LibreChat is deployed as the first replacement increment for LobeHub. This stack deploys the official LibreChat Helm chart with MongoDB and Meilisearch, connects custom model requests to the existing Flinker OpenAI-compatible endpoint, and exposes the app through the homelab Traefik/Cloudflare Tunnel path.

## Scope

Included:

- LibreChat chart `2.0.8` / app `v0.8.8-rc1` from the official OCI registry
- LibreChat native GitHub OAuth
- Bitnami MongoDB, standalone, with an 8Gi Longhorn PVC
- Meilisearch with an 8Gi Longhorn PVC
- LibreChat image-volume with a 10Gi Longhorn PVC
- Cloudflare R2-compatible S3 storage for chat images and documents
- Local avatar storage for the first increment, so OAuth login does not depend on R2 avatar writes
- Flinker at `http://flinker:8080/v1`
- Traefik `IngressRoute` and ClusterIP services

Deferred to a later increment: the RAG API and the sandbox-mcp sidecar. Redis is disabled for the single-replica deployment.

## Chart source decision

The upstream GitHub repository does not publish a conventional Helm repository index; its `helm/librechat` chart also declares remote dependencies. The official chart is therefore consumed from its pinned OCI package with Pulumi's Helm `Release`. The OCI package includes the required MongoDB and Meilisearch dependencies, avoiding runtime dependency downloads during deployment. The exact chart version and OCI reference are in `src/index.ts`.

## Configuration

Copy `Pulumi.dev.yaml.example` as a starting point, then set secrets through Pulumi. Never commit a real `Pulumi.dev.yaml` or plaintext credentials.

```sh
pulumi stack init dev
pulumi config set librechat:homelabStack <your-pulumi-org>/homelab/dev
pulumi config set librechat:image ghcr.io/danny-avila/librechat:v0.8.8-rc1
pulumi config set librechat:domainPrefix chat

pulumi config set librechat:mongodbPassword '<value>' --secret
pulumi config set librechat:mongodbRootPassword '<value>' --secret
pulumi config set librechat:credsKey '<32-byte-value>' --secret
pulumi config set librechat:credsIv '<16-byte-value>' --secret
pulumi config set librechat:jwtSecret '<32-byte-value>' --secret
pulumi config set librechat:jwtRefreshSecret '<32-byte-value>' --secret
pulumi config set librechat:meiliMasterKey '<value>' --secret
pulumi config set librechat:githubClientId '<value>' --secret
pulumi config set librechat:githubClientSecret '<value>' --secret
pulumi config set librechat:awsAccessKeyId '<R2-access-key>' --secret
pulumi config set librechat:awsSecretAccessKey '<R2-secret-key>' --secret

pulumi config set librechat:s3Endpoint 'https://<account-id>.eu.r2.cloudflarestorage.com'
pulumi config set librechat:s3Bucket lobehub
pulumi config set librechat:s3Region auto
```

The existing GitHub OAuth application is reused because LobeHub is shut down. Configure this LibreChat callback URL in that application:

```text
https://chat.<homelab-domain>/oauth/github/callback
```

The stack disables email login and email registration and enables only the native social-login path. LibreChat's user and session data remain in MongoDB; the OAuth client ID and secret are injected from the Pulumi-managed application Secret.

## Secret and database wiring

`librechat-credentials-env` contains the LibreChat encryption/JWT values, Meilisearch master key, GitHub OAuth credentials, R2 credentials, and the generated MongoDB connection URI. It is referenced by the chart's `global.librechat.existingSecretName` and by Meilisearch's `auth.existingMasterKeySecret`.

`librechat-mongodb-credentials` is a separate Pulumi-managed Secret referenced by `mongodb.auth.existingSecret`. It must keep Bitnami's exact keys:

- `mongodb-passwords` — the `librechat` application-user password
- `mongodb-root-password` — the MongoDB root password

The MongoDB StatefulSet and both Secrets must remain stable across Helm upgrades. Updating a Secret alone does not rotate credentials in an initialized MongoDB instance; rotate the database credential and Kubernetes Secret as one coordinated operation, then restart LibreChat.

## Persistence

| Component | Size | Storage class | Purpose |
|---|---:|---|---|
| MongoDB | 8Gi | `longhorn-uncritical` | LibreChat users, sessions, conversations |
| Meilisearch | 8Gi | `longhorn-uncritical` | Conversation search index |
| LibreChat images | 10Gi | `longhorn-uncritical` | Local image cache |

R2 is the primary store for chat images and documents. Avatars use the LibreChat image PVC locally in the first increment because avatar processing is part of the OAuth login path. The R2 credentials must be fixed before switching avatars to S3.

## Deployment and verification

Run from this directory:

```sh
npm run type-check
pulumi preview
pulumi up
```

Useful checks after deployment:

```sh
kubectl -n librechat get deploy,statefulset,pvc,ingressroute
kubectl -n librechat get secret librechat-credentials-env librechat-mongodb-credentials
kubectl -n librechat rollout status deployment/librechat
```

The route is `chat.<homelab-domain>` and uses Traefik's `web` entrypoint because Cloudflare Tunnel terminates external TLS before forwarding into the cluster.

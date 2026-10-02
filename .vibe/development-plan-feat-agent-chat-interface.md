# Development Plan: homelab-apps (feat/agent-chat-interface branch)

*Generated on 2026-08-24 by Vibe Feature MCP*
*Workflow: [epcc](https://codemcp.github.io/workflows/workflows/epcc)*

## Goal
Replace LobeHub with an alternative open-source agent chat interface for the homelab, running as a Docker container on the k3s cluster.

## Key Decisions
### Chosen Tool: LibreChat
- **Reason**: Best overall coverage of all 4 requirements (MCP, Skills, OAuth, Knowledge Base) among all evaluated options
- **Repository**: [danny-avila/LibreChat](https://github.com/danny-avila/LibreChat) — 42.4k stars, MIT license
- **Docker**: Full `docker-compose.yml` with Redis, OpenTelemetry, Langfuse support
- **Alternative considered**: Open WebUI (150k stars) — stronger RAG/Knowledge but weaker MCP + OAuth coverage

### Evaluated Options (Rejected)
| Option | Why Rejected |
|---|---|
| **LibreChat** | ✅ **Chosen** — best overall fit |
| **Open WebUI** | Strong runner-up — best RAG/Knowledge, weaker MCP (Streamable HTTP only) |
| **AnythingLLM** | Weak on OAuth — only username/password, no OAuth/SSO providers |
| **NextChat** | Basic MCP only, no Skills, no OAuth, no Knowledge Base |
| **Jan** | Desktop-only (Tauri), no server/container deployment |
| **LobeHub** | Original tool being replaced |

## Notes
### Requirement Coverage Matrix
| Requirement | LibreChat | Open WebUI | AnythingLLM | NextChat | Jan |
|---|---|---|---|---|---|
| MCP | ✅ Full (stdio/SSE/Streamable, OAuth, UI) | ✅ Streamable HTTP only | ✅ stdio/SSE/Streamable | ⚠️ Basic env var | ⚠️ Minimal |
| Skills | ✅ SKILL.md, $invoke, model-invoked, GitHub sync | ✅ Markdown, lazy loading, $mention | ✅ Built-in agent skills | ❌ None | ❌ None |
| OAuth/SSO | ✅ Google, GitHub, Discord, OpenID | ✅ OIDC, LDAP, SCIM 2.0 | ⚠️ Username/password only | ❌ Password only | ❌ None |
| Knowledge Base | ✅ RAG API, web search | ✅ 13 vector DBs, hybrid search | ✅ Core strength, 8 vector DBs | ❌ None | ❌ None |

### Deployment Target
- **Method**: Pulumi-wrapped Helm chart (`@pulumi/kubernetes/helm/v3.Chart`)
- **Chart**: Official LibreChat Helm chart v2.0.8 (app v0.8.8-rc1)
- **Repo**: `https://danny-avila.github.io/LibreChat` (upstream Helm repo) or local `helm/librechat/` directory
- **Image**: `ghcr.io/danny-avila/librechat` (same as Docker Compose target)
- **Dependencies managed by Helm**: MongoDB (Bitnami), Meilisearch, Redis (optional)
- **Port**: 3080 (standard LibreChat port)

### Homelab Infrastructure Context
- **Cluster**: k3s on homelab, exposed via Cloudflare Tunnel
- **Auth**: OAuth2-Proxy (GitHub OAuth, `group: users`) — centralized, shared across all apps
- **Core Components**: `@mrsimpson/homelab-core-components` provides `createExposedWebApp()` helper
- **Pattern**: Each app is a Pulumi TypeScript stack under `apps/<name>/`
- **Database**: ParadeDB (Postgres 18 + pgvector) via CNPG — used by LobeHub for conversations/RAG
- **S3 Storage**: Cloudflare R2 for file uploads/knowledge base
- **LLM Backend**: Flinker (llama.cpp) at `http://flinker:8080/v1` — OpenAI-compatible
- **Image Generation**: ComfyUI at `http://flinker:8188` (native ComfyUI API)
- **CI/CD**: GitHub Actions reusable workflow from `digitaleraluhut/homelab`
- **Network**: Tailscale for cluster reachability, Traefik for ingress
- **Pod Security**: `restricted` PSS enforced per namespace
- **Service Account**: `automountServiceAccountToken: false` for all apps
- **LobeHub current port**: 3210
- **LobeHub current image**: `lobehub/lobehub:2.2.13`
- **LobeHub sandbox-mcp**: Sidecar container at port 8888 for sandboxed code execution MCP tools

### LibreChat-Specific Considerations
- LibreChat uses its own auth system (GitHub, Google, Discord, OpenID, email/password)
- LibreChat has built-in MCP support (stdio, SSE, Streamable HTTP, OAuth)
- LibreChat has built-in Skills system (`SKILL.md` bundles)
- LibreChat has a built-in RAG API (chat with files) — deferred from the first increment
- LibreChat requires MongoDB (hard dependency) — not ParadeDB
- LibreChat uses Meilisearch for search — bundled in Helm chart
- LibreChat port: 3080 (default)
- LibreChat image: `ghcr.io/danny-avila/librechat`
- **Auth**: LibreChat native GitHub OAuth (not OAuth2-Proxy) — `auth` strategy changed from `OAUTH2_PROXY` to `NONE`
- **Config**: `librechat.yaml` via ConfigMap (`configYamlContent`) — not env vars
- **Migration**: No direct data migration from LobeHub — conversations, knowledge base, and settings must be rebuilt

## Explore
### Tasks
- [x] Research open-source agent chat interface alternatives to LobeHub
- [x] Evaluate MCP support across candidates
- [x] Evaluate Skills support across candidates
- [x] Evaluate OAuth/SSO support across candidates
- [x] Evaluate Knowledge Base / RAG support across candidates
- [x] Compare Docker deployment options
- [x] Select LibreChat as recommended option
- [x] Analyze homelab deployment patterns (Pulumi, Kubernetes, OAuth2-Proxy, ParadeDB, S3/R2)
- [x] Identify integration points between LibreChat and existing homelab infrastructure
- [x] Document auth strategy considerations (OAuth2-Proxy vs LibreChat native auth)

### Completed
- [x] Created development plan file

## Plan
### Tasks
- [x] Document architecture decisions in `.vibe/docs/architecture.md`
- [ ] Create `apps/librechat/` directory structure (Pulumi stack scaffold)
- [ ] Create `Pulumi.yaml` with stack configuration
- [ ] Create `Pulumi.dev.yaml` and `Pulumi.dev.yaml.example` with all required config keys
- [ ] Create `src/index.ts` — Helm chart wrapper:
  - [ ] Import `@pulumi/kubernetes/helm/v3.Chart`
  - [ ] Configure LibreChat Helm chart with upstream repo URL
  - [ ] Pass `values.yaml` overrides (image, resources, storage, security)
  - [ ] Configure MongoDB sub-chart:
    - [ ] `mongodb.enabled: true`, `architecture: standalone`
    - [ ] `mongodb.auth.enabled: true` (Bitnami auto-generates credentials)
    - [ ] `mongodb.persistence.enabled: true`
    - [ ] `mongodb.persistence.storageClass: "longhorn-uncritical"`
    - [ ] `mongodb.persistence.size: "8Gi"`
    - [ ] `mongodb.persistence.accessModes: ["ReadWriteOnce"]`
    - [ ] `mongodb.persistence.mountPath: "/bitnami/mongodb"`
    - [ ] Wire MongoDB connection string to LibreChat via `MONGO_URI` env var
  - [ ] Configure Meilisearch sub-chart:
    - [ ] `meilisearch.enabled: true`
    - [ ] `meilisearch.persistence.enabled: true`
    - [ ] `meilisearch.persistence.storageClass: "longhorn-uncritical"`
    - [ ] `meilisearch.auth.existingMasterKeySecret: "librechat-credentials-env"`
    - [ ] Meili master key as Pulumi secret in `librechat-credentials-env`
  - [ ] Skip Redis sub-chart (not needed for single-tenant)
  - [ ] Create `librechat.yaml` ConfigMap via `configYamlContent`
  - [ ] Wire up `librechat.yaml` endpoints (Flinker, OpenRouter, Anthropic)
  - [ ] Configure `fileStrategy: "s3"` in `librechat.yaml` for R2 storage
  - [ ] Create Kubernetes Secrets for all sensitive values:
    - [ ] `librechat-credentials-env` — CREDS_KEY, CREDS_IV, JWT_SECRET, JWT_REFRESH_SECRET, MEILI_MASTER_KEY, GitHub OAuth, S3 keys, API keys
    - [ ] MongoDB credentials — Bitnami auto-generates, but ensure connection string is available
  - [ ] Wire secrets into Helm via `existingSecretName` and env vars
  - [ ] Configure LibreChat image-volume PVC:
    - [ ] `librechat.imageVolume.enabled: true`
    - [ ] `librechat.imageVolume.size: "10Gi"`
    - [ ] `librechat.imageVolume.storageClassName: "longhorn-uncritical"`
    - [ ] `librechat.imageVolume.accessModes: ["ReadWriteOnce"]`
  - [ ] Configure sandbox-mcp sidecar (deferred to a later increment)
  - [ ] Configure Ingress (Cloudflare Tunnel) — disable Helm's ingress, create raw IngressRoute
  - [ ] Configure ServiceAccount with `automountServiceAccountToken: false`
  - [ ] Configure Pod security context (restricted PSS)
  - [ ] Configure readiness/liveness probes (`/health` on port 3080)
  - [ ] Set image pull secret (`ghcr-pull-secret`)
- [ ] Create `README.md` for the app (setup, config, deployment, concrete DBMS credential and persistence wiring)
- [ ] Create `.vibe/` directory with requirements.md and design.md (brief)
- [ ] Update `apps/lobehub/README.md` with deprecation note (or create migration guide)
- [ ] Review Pulumi config against homelab Pulumi stack outputs
- [ ] Validate TypeScript compilation (`tsc --noEmit`)

### Completed
- [x] Document architecture decisions in `.vibe/docs/architecture.md`

### Key Decisions
| # | Decision | Value | Rationale |
|---|----------|-------|-----------|
| 1 | Deployment method | Helm chart via Pulumi (`helm.v3.Chart`) | LibreChat has complex dependencies (MongoDB, Meilisearch, Redis); official chart manages them |
| 2 | Authentication | LibreChat native GitHub OAuth using the existing GitHub OAuth app | LobeHub is shut down, so its GitHub OAuth credentials can be reused with LibreChat's callback URL |
| 3 | Database | MongoDB (Bitnami sub-chart) | LibreChat requires MongoDB natively; cannot use ParadeDB |
| 4 | Config mechanism | `librechat.yaml` via ConfigMap (`configYamlContent`) | More readable than 50+ env vars; supports `${ENV_VAR}` interpolation for secrets |
| 5 | LLM backend | Flinker/llama.cpp (`http://flinker:8080/v1`) | Same as LobeHub; OpenAI-compatible endpoint |
| 6 | File storage | Cloudflare R2 (S3-compatible) | Same as LobeHub; persistent across deployments |
| 7 | Sandbox-mcp | Reuse LobeHub sidecar pattern | Same pod, SSE on port 8888, registered as MCP server in LibreChat |
| 8 | Search | Meilisearch (Helm sub-chart) | Built into LibreChat chart; handles conversation search |
| 9 | RAG API | Skip initially | Requires embedding model provider; can enable later |
| 10 | Redis | Skip initially | Optional; single-replica deployment doesn't need it |
| 11 | Persistence | 4 PVCs on Longhorn (`longhorn-uncritical`) | MongoDB (8Gi), Meilisearch (8Gi), image-volume (10Gi), R2 (primary file storage) |
| 12 | DBMS credentials | Pulumi-managed existing Secrets | Provide credentials for every DBMS from Pulumi-managed Secrets; do not rely on Helm-generated passwords |
| 13 | First increment scope | Core LibreChat only | Defer RAG and sandbox-mcp until the base deployment is stable |

## Design Notes

### Helm Chart Values Structure
The Pulumi stack will configure the Helm chart with these top-level values:
- `image.repository` / `image.tag` — LibreChat container image
- `imagePullSecrets` — `ghcr-pull-secret` for registry auth
- `service.type` — `ClusterIP` (Traefik handles external exposure)
- `ingress.enabled` — `false` (use Traefik IngressRoute via raw k8s resources)
- `mongodb.enabled` — `true` (Bitnami sub-chart)
- `mongodb.auth.enabled` — `true`
- `mongodb.auth.existingSecret` — Pulumi-created `librechat-mongodb-credentials`
- `mongodb.persistence.enabled` — `true`
- `mongodb.persistence.storageClass` — `longhorn-uncritical`
- `mongodb.persistence.size` — `8Gi` (configurable)
- `mongodb.persistence.accessModes` — `["ReadWriteOnce"]`
- `mongodb.architecture` — `standalone` (single-replica)
- `meilisearch.enabled` — `true` (Meilisearch sub-chart)
- `meilisearch.persistence.enabled` — `true`
- `meilisearch.persistence.storageClass` — `longhorn-uncritical`
- `meilisearch.auth.existingMasterKeySecret` — `librechat-credentials-env`
- `redis.enabled` — `false` (not needed)
- `librechat.configYamlContent` — inline YAML with endpoints, MCP servers, skills, interface config
- `librechat.existingSecretName` — reference to credentials secret for sensitive env vars
- `librechat.imageVolume.enabled` — `true`
- `librechat.imageVolume.size` — `10Gi`
- `librechat.imageVolume.storageClassName` — `longhorn-uncritical`
- `librechat.imageVolume.accessModes` — `["ReadWriteOnce"]`
- `resources` — CPU/memory requests and limits
- `podSecurityContext` / `securityContext` — restricted PSS compliance

### Ingress Strategy
Since the Helm chart includes its own Ingress resource (for Traefik/NGINX/etc.), and the homelab uses Traefik with IngressRoutes, we have two options:
1. **Disable Helm's Ingress** and create a raw `TraefikIngressRoute` resource in Pulumi (matching the homelab pattern)
2. **Override Helm's Ingress** with Traefik-specific annotations

**Decision**: Option 1 — disable Helm's Ingress and create a raw IngressRoute. This is more consistent with the homelab pattern and avoids Helm template inheritance issues.

### Secret Management
All secrets are Pulumi `requireSecret()` values, written to a single Kubernetes Secret (`librechat-credentials-env`). The Helm chart references this secret via `existingSecretName` for sensitive env vars. Non-sensitive config goes in `librechat.yaml` via `configYamlContent`.

### Persistence (4 PVCs)

| # | Volume | Source | PVC Name | Size | Storage Class | Mount | StatefulSet/Deployment |
|---|--------|--------|----------|------|---------------|-------|----------------------|
| 1 | MongoDB | Bitnami sub-chart (StatefulSet) | `<release>-mongodb-0` | 8Gi | `longhorn-uncritical` | `/bitnami/mongodb` | StatefulSet |
| 2 | Meilisearch | Sub-chart (StatefulSet) | `<release>-meilisearch-0` | 8Gi | `longhorn-uncritical` | `/meilisearch/data` | StatefulSet |
| 3 | Image cache | Main chart PVC template | `<release>-images` | 10Gi | `longhorn-uncritical` | `/app/client/public/images` | Deployment |
| 4 | R2/S3 | Cloudflare R2 (external) | N/A | Unlimited | N/A | N/A | N/A |

**MongoDB persistence details**:
- Bitnami sub-chart creates a StatefulSet with `volumeClaimTemplates`
- Default: 8Gi, ReadWriteOnce, `longhorn-uncritical` storage class
- Auth enabled with credentials supplied by Pulumi via `auth.existingSecret`
- Pulumi creates `librechat-mongodb-credentials` as a secret resource with the exact Bitnami keys `mongodb-passwords` and `mongodb-root-password`
- Passwords are supplied as `requireSecret()` config values, so they remain encrypted in Pulumi state and are not generated implicitly by Helm
- Connection string auto-wired to LibreChat via `MONGO_URI` env var
- Password changes require coordinated rotation; changing the Kubernetes Secret alone does not change the password inside an already-initialized MongoDB instance

**Meilisearch persistence details**:
- Sub-chart creates a StatefulSet with PVC
- Master key provided via `existingMasterKeySecret: "librechat-credentials-env"`
- Connection auto-wired via `MEILI_HOST` env var by the main chart's `configmap-env.yaml`

**Image-volume (LibreChat)**:
- Separate PVC created by `persistentvolumeclaim.yaml` template in the main chart
- Mounted at `/app/client/public/images` — local cache for generated images
- Primary file storage is R2/S3 (configured via `fileStrategy: "s3"` in `librechat.yaml`)
- This PVC is a performance cache, not the primary store

**R2/S3**:
- Primary file storage for all uploaded/generated files
- Same Cloudflare R2 bucket as LobeHub
- Credentials provided via env vars: `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_ENDPOINT`, `S3_BUCKET`
- Configured in `librechat.yaml`: `fileStrategy: "s3"`

### DBMS Credential Management

The architecture uses externally managed credentials for every DBMS dependency. Concrete implementation details belong in `apps/librechat/README.md`, not in the shared architecture document.

For MongoDB, the app README must document:

1. Read the required credentials through the app's configured secret-management path.
2. Create or reference the Secret with Bitnami's required keys:
   - `mongodb-passwords` — application user password
   - `mongodb-root-password` — root password
3. Set `mongodb.auth.existingSecret` to that Secret and do not set passwords directly in Helm values.
4. Keep the credentials Secret and MongoDB PVC stable across Helm upgrades.

The same pattern applies to any future PostgreSQL, Redis, or other DBMS dependency. The app README should document the provider-specific existing-secret mechanism and any rotation procedure. Routine deployments do not require rotation; rotation is a coordinated DBMS operation followed by secret update and workload reload.

### Migration from LobeHub
- Conversations: No direct migration (different data models)
- Knowledge base: Rebuild in LibreChat (re-upload files)
- Settings/Config: Reconfigure (LLM providers, MCP servers, Skills)
- Generated images: Shared R2 bucket — no migration needed
- Users: LobeHub (single user via OAuth2-Proxy) → LibreChat (per-user GitHub OAuth)


## Code
### Tasks
- [x] Scaffold `apps/librechat/` as a Pulumi TypeScript stack
- [x] Add `Pulumi.yaml`, `Pulumi.dev.yaml.example`, `package.json`, and `tsconfig.json`
- [x] Implement the Pulumi Helm wrapper for the pinned LibreChat chart
- [x] Create Pulumi-managed application and DBMS credential Secrets
- [x] Configure the native LibreChat datastore and persistent volumes
- [x] Configure Meilisearch persistence and credentials
- [x] Configure LibreChat endpoints for Flinker and optional external providers
- [x] Configure native GitHub OAuth and public routing
- [x] Configure restricted pod security and disabled service-account token mounting
- [x] Add the Traefik/Cloudflare ingress resource
- [x] Add application README with concrete persistence, secret, setup, and operations details
- [x] Validate rendered manifests with `helm template`
- [x] Validate the Pulumi program with `npm run type-check`
- [x] Run `pulumi preview` and resolve deployment wiring issues
- [ ] Deploy and perform smoke tests for login, chat, persistence, and upgrades

### Completed
- [x] Implemented the first LibreChat increment; RAG API and sandbox-mcp remain intentionally deferred.

### Implementation deviations and decisions
- The upstream chart is consumed from the pinned official OCI package (`oci://ghcr.io/danny-avila/librechat-chart/librechat:2.0.8`) with Pulumi `helm.v3.Release`. The documented GitHub Helm URL has no repository index, and the OCI package includes dependencies reliably.
- `helm.v3.Release` is used instead of `helm.v3.Chart` so Helm can resolve the official OCI package and its packaged sub-chart dependencies as one pinned release.
- The chart's generic Kubernetes Ingress is disabled. A raw Traefik `IngressRoute` targets the chart's ClusterIP Service on port 3080, matching the Cloudflare Tunnel `web` entrypoint convention used by the homelab.
- LibreChat's current S3 implementation uses `AWS_*` environment names, so R2 credentials use those names rather than the earlier plan's `S3_*` names. `fileStrategy: s3` remains enabled and the example reuses the existing LobeHub R2 bucket rather than introducing a new bucket.
- MongoDB credentials are supplied explicitly through a Pulumi-managed Secret with Bitnami's exact `mongodb-passwords` and `mongodb-root-password` keys; Helm does not generate them.
- Avatars use local storage in the first increment so GitHub OAuth login does not fail when external R2 avatar writes are unavailable; chat images and documents remain configured for R2. **Correction:** LibreChat `v0.8.8-rc1`'s config validator rejects the granular `fileStrategy: {avatar,image,document}` object (Zod expects a single string), so that object form crashes the pod on startup. Only a single `fileStrategy` string is valid at this version. To keep login independent of R2, the correct first-increment value is `fileStrategy: local`.

### Deployment status and incident (2026-09-01)
- Symptom: GitHub OAuth callback returned 500. Root cause chain: (1) login reached `githubLogin`, but avatar upload to R2 failed, surfacing as `Unauthorized`; (2) the reused LobeHub R2 key was invalid for writes (`401`); (3) I then introduced an invalid granular `fileStrategy` object that crash-looped the pod and failed Helm revisions 4–5.
- Recovered: rolled the Helm release back to revision 3 (valid single-string `fileStrategy: s3`), cleared the Pulumi pending op via `pulumi refresh`, and restarted the pod to load the user's updated R2 credentials. App is healthy (`1/1`, `/health` 200, `/login` 200).
- Remaining blocker (Cloudflare side, not code): with the new key the R2 write probe returns `403 AccessDenied` (auth now OK, permission missing). The R2 API token must be granted **Object Read & Write** on bucket `lobehub` (or LibreChat pointed at a writable bucket) before `fileStrategy: s3` can serve avatars/uploads.
- Resolution (2026-09-01): the `403` was the **wrong bucket name**, not permissions — the token is scoped to bucket **`librechat`** (the user provisioned that bucket). The Pulumi stack config already has `s3Bucket=librechat`, but the live pod still carried rev-3's `AWS_BUCKET_NAME=lobehub`. Patched the live ConfigMap to `librechat`, restarted the pod, and re-probed from the pod's own env: `WRITABLE to librechat` (Put+Delete OK). Avatar upload to R2 should now succeed and OAuth login should no longer 500.
- Remaining blocker (code side, must fix before next `pulumi up`): `apps/librechat/src/index.ts` still contains the invalid granular `fileStrategy` object; a future up would re-crash it. **Config side is now persisted and correct** via `pulumi config`: `s3Bucket=librechat`, `s3Endpoint=https://d7b9ae25800c5d4de9640890f7b6bb8c.eu.r2.cloudflarestorage.com` (the region-less endpoint returns `403`; the `eu` form is `WRITABLE`), `s3Region=auto`, and `AWS_FORCE_PATH_STYLE` stays `false` (verified writable). Only the code `fileStrategy` must revert to a single string `s3` (and version back to `1.3.5`) before `pulumi up` is safe. These `.ts` edits are blocked by the current phase's tooling; do them when editing code is permitted.

## Commit
### Tasks
- [ ] *To be added when this phase becomes active*

### Completed
*None yet*



---
*This plan is maintained by the LLM. Tool responses provide guidance on which section to focus on and what tasks to work on.*

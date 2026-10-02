# Architecture: LibreChat Deployment

*Generated 2026-08-24*

## Overview

Replace LobeHub with LibreChat as the homelab's agent chat interface. LibreChat is deployed as a Pulumi-wrapped Helm chart (official `danny-avila/LibreChat` chart v2.0.8, app v0.8.8-rc1) on the k3s cluster, exposed via Cloudflare Tunnel.

## Architecture Decisions

### A-1: Deployment via Helm chart (Pulumi `helm.v3.Chart`)

**Decision**: Use the official LibreChat Helm chart wrapped in Pulumi, rather than raw Kubernetes resources via `createExposedWebApp`.

**Rationale**:
- LibreChat has multiple stateful dependencies for application data, search, and optional caching
- The official Helm chart manages all sub-charts and version compatibility
- Manual wiring of multiple stateful dependencies + LibreChat would be more fragile and harder to upgrade
- One-off Helm adoption is justified by the dependency complexity
- LibreChat's chart supports both env vars and `librechat.yaml` config file via `configYamlContent`

**Trade-offs**:
- Slightly different from the homelab pattern (all other apps use `createExposedWebApp`)
- Helm chart upgrades may require manual values.yaml review (upstream changes)
- Stateful sub-chart dependencies add deployment surface area

### A-2: LibreChat native GitHub OAuth (not OAuth2-Proxy)

**Decision**: Use LibreChat's built-in GitHub OAuth for authentication, bypassing the homelab's centralized OAuth2-Proxy.

**Rationale**:
- LibreChat has native OAuth providers: GitHub, Google, Discord, OpenID, SAML, Facebook, Apple
- OAuth2-Proxy would interfere with LibreChat's auth flow (it injects headers, not login redirects)
- LibreChat's auth is per-app, not cluster-wide — appropriate for a chat app
- Simplifies: no separate OAuth2-Proxy deployment, no group-based access control needed
- Can still restrict to GitHub OAuth only (matching current LobeHub pattern of GitHub-only SSO)

**Trade-offs**:
- Loses centralized auth management (users must be added in LibreChat admin, not via GitHub team membership)
- Can be mitigated by using GitHub OAuth scopes to restrict to specific org/teams
- Future: LibreChat supports OpenID Connect, which could integrate with homelab's IdP

### A-3: Use the application's native datastore

**Decision**: Use the datastore required by the selected application and manage it through the deployment packaging where appropriate.

**Rationale**:
- The application data model and supported datastore are application concerns
- Replacing a required datastore with another technology would require changing the application
- Packaging stateful dependencies with the application keeps version compatibility explicit

**Trade-offs**:
- Adds stateful infrastructure to the application deployment
- May use a different datastore technology than other homelab applications
- Stateful dependencies increase resource and backup requirements

### A-4: `librechat.yaml` config via ConfigMap (not env vars)

**Decision**: Use LibreChat's YAML config file (`librechat.yaml`) mounted as a ConfigMap for application configuration.

**Rationale**:
- `librechat.yaml` is LibreChat's primary config mechanism (supports endpoints, MCP servers, skills, agents, etc.)
- Much more readable and maintainable than 50+ env vars (compare LobeHub's 40+ env vars)
- Supports `${ENV_VAR}` interpolation for secrets
- Helm chart supports `configYamlContent` values key for inline YAML
- Secrets still go in Kubernetes Secrets, referenced via `${VAR}` syntax in the YAML

**Trade-offs**:
- Secrets in ConfigMap are technically readable (but ConfigMap data is base64-encoded, not encrypted)
- Sensitive values (API keys, OAuth secrets) should go in Kubernetes Secrets + env var injection
- Non-sensitive config (endpoints, features) goes in ConfigMap

### A-5: Same LLM backend (Flinker/llama.cpp)

**Decision**: Connect LibreChat to the existing Flinker (llama.cpp) endpoint at `http://flinker:8080/v1`.

**Rationale**:
- Flinker provides OpenAI-compatible API — LibreChat natively supports OpenAI endpoints
- Same model list as LobeHub (local models from llama.cpp)
- No additional infrastructure needed
- Can also add OpenRouter, Anthropic, etc. as optional providers

**Implementation**:
- Add custom endpoint in `librechat.yaml`: `endpoints.custom[]` with `baseURL: http://flinker:8080/v1`
- Use a dummy API key (llama.cpp ignores it)

### A-6: S3/R2 for file storage

**Decision**: Use Cloudflare R2 (S3-compatible) for file uploads and knowledge base storage.

**Rationale**:
- Same as LobeHub — R2 is already configured in the homelab
- LibreChat natively supports S3 file storage
- Persistent across deployments

**Implementation**:
- Set `fileStrategy: "s3"` in `librechat.yaml`
- Provide S3 credentials via environment variables

### A-7: Sandbox-mcp is deferred

**Decision**: Defer sandbox-mcp and sandboxed code execution to a later increment. The first increment deploys LibreChat without it.

**Rationale**:
- Keeps the first deployment focused on the core chat experience
- Avoids chart customization or post-rendering before the base deployment is validated

**Follow-up**:
- Choose a sidecar injection strategy
- Add sandbox-mcp and validate its security boundary

### A-8: Meilisearch for search (via Helm sub-chart)

**Decision**: Use Meilisearch via the Helm chart's sub-chart for chat search.

**Rationale**:
- LibreChat uses Meilisearch for full-text search on conversations
- Built into the Helm chart — just enable it
- No need to manage separately

### A-9: RAG is deferred

**Decision**: Defer the `librechat-rag-api` sub-chart to a later increment. The first increment does not provide knowledge-base/RAG functionality.

**Rationale**:
- RAG API requires an embedding model provider (OpenAI, Azure, HuggingFace)
- Adds a separate deployment, service, and datastore connection
- Deferring it keeps the first deployment focused and reduces initial operational complexity

**Follow-up**:
- Select and deploy an embedding provider
- Enable RAG and validate ingestion, retrieval, and persistence

### A-10: Skip Redis initially

**Decision**: Do not enable Redis in the initial deployment.

**Rationale**:
- Redis is optional for LibreChat — used for caching, sessions, and resumable streams
- Single-replica deployment doesn't need Redis for session consistency
- Can enable later for performance optimization

### A-11: Persistence via Longhorn PVCs (4 volumes total)

**Decision**: All persistent data uses Longhorn PVCs with `storageClass: "longhorn-uncritical"`, matching the LobeHub storage class.

**Rationale**:
- Stateful Helm dependencies and the application image volume create PVCs
- Longhorn is the homelab's default storage provisioner
- `longhorn-uncritical` matches LobeHub's storage class (not `longhorn-persistent` used by ParadeDB)
- All volumes are ReadWriteOnce (single-replica deployment)

**Volume breakdown**:

| # | Volume | Source | Mount Path | Default Size | Storage Class | Purpose |
|---|--------|--------|------------|-------------|---------------|---------|
| 1 | Application datastore PVC | Stateful datastore sub-chart | Application-specific | Configurable | `longhorn-uncritical` | Conversations, users, settings, messages |
| 2 | Meilisearch PVC (`<release>-meilisearch-0`) | Bitnami sub-chart (StatefulSet) | `/meilisearch/data` | 8Gi (default) | `longhorn-uncritical` | Conversation search index |
| 3 | LibreChat image-volume PVC (`<release>-images`) | Helm chart (Deployment) | `/app/client/public/images` | 10Gi | `longhorn-uncritical` | Local cache for generated images |
| 4 | S3/R2 | Cloudflare R2 (external) | N/A | Unlimited | N/A | Primary file storage (uploaded docs, generated images) |

**Key details**:

- **Application datastore**: The selected datastore runs with persistent storage and provides the connection details required by the application.

- **Meilisearch**: Bitnami-compatible chart (from `meilisearch.github.io` Helm repo). Persistence enabled by default. Master key comes from `existingMasterKeySecret` (our Pulumi-created Kubernetes secret). The Helm chart auto-sets `MEILI_HOST` env var pointing to the Meilisearch Service.

- **LibreChat image-volume**: Separate PVC created by the main chart's `persistentvolumeclaim.yaml` template. Mounted at `/app/client/public/images`. This is a **local cache** — actual file storage goes to S3/R2 (set via `fileStrategy: "s3"` in `librechat.yaml`). The PVC is optional (`imageVolume.enabled: true` is the default).

- **R2/S3**: Primary file storage — same Cloudflare R2 bucket as LobeHub. Files uploaded to LibreChat (documents, images) are stored in R2, not on the PVC. The image-volume PVC is just a local cache for generated images to improve performance.

**Size planning** (to be configured in Pulumi values):
- Application datastore: size according to conversations, settings, and application growth
- Meilisearch: 8Gi default — sufficient for search index (search data is small)
- Image-volume: 10Gi default — sufficient for cached generated images (primary store is R2)
- R2: Unlimited — primary storage for all uploaded/generated files

## Component Diagram

```
┌─────────────────────────────────────────────────────────┐
│                    Cloudflare Tunnel                     │
│                    (chat.homelab.domain)                  │
└──────────────────────────┬──────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│                    Traefik Ingress                       │
│                    (k3s cluster)                         │
└──────────────────────────┬──────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│              librechat namespace                          │
│                                                         │
│  ┌─────────────────────────────────────────────────┐    │
│  │  LibreChat Deployment (Helm chart)               │    │
│  │  LibreChat App (port 3080)                       │    │
│  └──────────────────────┬───────────────────────────┘    │
│              │                                           │
│  ┌───────────┴────────────────────────────────────────┐ │
│  │  Application datastore (stateful dependency)         │ │
│  │  PVC: application-specific, Longhorn-backed          │ │
│  │  Mount: application-specific                          │ │
│  └────────────────────────────────────────────────────┘ │
│                                                         │
│  ┌────────────────────────────────────────────────────┐ │
│  │  Meilisearch StatefulSet (sub-chart)                │ │
│  │  PVC: <release>-meilisearch-0 (8Gi, longhorn)      │ │
│  │  Mount: /meilisearch/data                            │ │
│  └────────────────────────────────────────────────────┘ │
│                                                         │
│  ┌────────────────────────────────────────────────────┐ │
│  │  LibreChat image-volume PVC                         │ │
│  │  PVC: <release>-images (10Gi, longhorn-uncritical)  │ │
│  │  Mount: /app/client/public/images                    │ │
│  └────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
                           │
         ┌──────────────────┼──────────────────┐
         │                  │                  │
         ▼                  ▼                  ▼
    ┌─────────┐      ┌──────────┐      ┌──────────┐
    │  R2/S3  │      │ Flinker  │      │ OpenRouter│
    │ (files) │      │ (:8080)  │      │ (optional)│
    └─────────┘      └──────────┘      └──────────┘
```

## Persistence Summary

| Component | PVC Name | Size | Storage Class | Mount | StatefulSet/Deployment |
|---|---|---|---|---|---|
| Application datastore | Application-specific | Configurable | `longhorn-uncritical` | Application-specific | Stateful workload |
| Meilisearch | `<release>-meilisearch-0` | 8Gi (default) | `longhorn-uncritical` | `/meilisearch/data` | StatefulSet (sub-chart) |
| Image cache | `<release>-images` | 10Gi (default) | `longhorn-uncritical` | `/app/client/public/images` | Deployment (main chart) |
| R2/S3 | N/A (external) | Unlimited | N/A | N/A | N/A |

**PVC creation**:
- Application datastore: Created by its stateful dependency chart's persistent-volume mechanism
- Search service: Created by its stateful dependency chart's persistent-volume mechanism
- Image-volume: Created by main chart's `persistentvolumeclaim.yaml` template
- All PVCs use `accessModes: ReadWriteOnce`

### A-12: DBMS credentials are externally managed

**Decision**: Applications must obtain credentials for their database management system dependencies from the platform's secret-management path, rather than generating or embedding credentials as part of application deployment.

The deployment architecture should prefer references to existing Secrets. The concrete Secret names, provider-specific keys, chart settings, and wiring are application implementation details.

**Rationale**:
- Separates credential ownership from application packaging and deployment
- Keeps credentials out of source-controlled manifests and ordinary configuration
- Provides stable credentials across application upgrades and replacement of deployment tooling
- Establishes a consistent policy for all current and future DBMS dependencies

**Operational implication**: Credential rotation is normally unnecessary during routine deployments. When rotation is required, it is a coordinated operational procedure: update the credential in the DBMS, update the platform secret, and restart or reload dependent workloads as required. Updating a Secret alone is not assumed to rotate an initialized DBMS credential. Persistent data must remain intact throughout the procedure.

## Secret Management

Sensitive application configuration is supplied through the platform secret-management path and referenced by workloads. Secret names, keys, and environment-variable mappings are application-specific and belong in the application's operational documentation.

## Migration from LobeHub

- **Conversations**: No direct migration path — LibreChat and LobeHub use different data models
- **Knowledge base**: Will need to be rebuilt in LibreChat (upload files again)
- **Settings/Config**: Will need to be reconfigured (LLM providers, MCP servers, etc.)
- **Images**: Generated images stored in R2 are shared — LibreChat can use the same R2 bucket
- **Users**: LobeHub uses OAuth2-Proxy (single user/group); LibreChat uses GitHub OAuth (per-user accounts)

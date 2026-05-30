# Development Plan: homelab-apps (feat/lobehub-comfyui-image-generation branch)

*Generated on 2026-05-29 by Vibe Feature MCP*
*Workflow: [epcc](https://codemcp.github.io/workflows/workflows/epcc)*

## Goal
Wire LobeHub's native ComfyUI image-generation provider to the local `flinker` ComfyUI instance running on port `8188`, so that LobeHub users can generate images locally via FLUX.1 dev GGUF (and schnell as a fast alternative) without leaving the homelab network.

## Key Decisions

1. **LobeHub's ComfyUI provider is fully server-side** — `COMFYUI_BASE_URL` is never sent to the browser. All traffic flows: Browser → tRPC (HTTPS) → Next.js server → loopback HTTP → `/webapi/create-image/comfyui` → `@saintno/comfyui-sdk` using Node.js `ws` package → `ws://flinker:8188`. The browser never opens a WebSocket to ComfyUI. `flinker:8188` is a cluster-internal DNS name, reachable from the pod. This architecture is correct and our `COMFYUI_BASE_URL=http://flinker:8188` wiring is right.
2. **Port 8188 is ComfyUI's native API; port 8082 is the OpenAI bridge** — The local-ai README documents `:8082` for OpenAI-compat image generation, and `:8188` is ComfyUI's internal port. LobeHub's `COMFYUI_BASE_URL` must point to the *native* port `8188` because LobeHub implements the ComfyUI WebSocket+REST protocol directly.
3. **No API key required** — `COMFYUI_AUTH_TYPE` defaults to `none`; the local ComfyUI instance has no auth configured.
4. **Add opt-in `enableComfyUI` flag** — mirrors the existing `enableMemory` / `enableSearch` pattern. Defaults to `false` to keep deploys without flinker working.
5. **`comfyuiUrl` is REQUIRED when `enableComfyUI=true`** — no hardcoded default; `cfg.require('comfyuiUrl')` is called when enabled, `cfg.get('comfyuiUrl')` (optional) when disabled. Avoids silent misconfiguration where a stack without flinker would still deploy with a broken URL baked in.
6. **`ENABLED_COMFYUI`** is optional (defaults `1`). Only `COMFYUI_BASE_URL` needs to be set; LobeHub enables the provider automatically when the URL is present.
7. **No model-list management needed** — ComfyUI provider in LobeHub does not use a model list env var; workflows/models are discovered at runtime via the ComfyUI native API.
8. **`INTERNAL_APP_URL=http://localhost:3210` is required inside the pod** — discovered during deployment testing. LobeHub's async task system (used by ComfyUI image generation, chunk embedding, etc.) makes server-to-server tRPC calls via `createAsyncServerClient` which uses `urlJoin(appEnv.INTERNAL_APP_URL!, '/trpc/async')`. When `INTERNAL_APP_URL` is not set, it falls back to `APP_URL` which is the public HTTPS URL (`https://lobehub.no-panic.org`). The loopback then goes through the oauth2-proxy ingress and gets an HTML redirect response → `InvalidProviderAPIKey` / `TaskTimeout` errors in `async_tasks` table. Setting `INTERNAL_APP_URL=http://localhost:${APP_PORT}` makes the loopback stay inside the pod, bypassing auth entirely, while keeping `APP_URL` as the public domain for OAuth callbacks, file proxy URLs, and messenger bindings. LobeHub source code at `src/server/routers/async/caller.ts` line 32 explicitly documents: "Use INTERNAL_APP_URL for server-to-server calls to bypass CDN/proxy".

9. **`LobeComfyUI.createImage()` uses `APP_URL` directly — root cause of the oauth2-proxy block** — `packages/model-runtime/src/providers/comfyui/index.ts` line 79: `process.env.APP_URL || http://localhost:${PORT||3010}`. The `/webapi/create-image/comfyui` endpoint is called with `Authorization: Bearer ${KEY_VAULTS_SECRET}` for internal bypass — Next.js validates this and skips user-session auth. However, the request must first pass through the Traefik ingress → oauth2-proxy chain, which intercepts it before Next.js can check the bearer token. `INTERNAL_APP_URL` is NOT read by `LobeComfyUI` — it only reads `APP_URL`. Setting `APP_URL=localhost` fixes the loopback but breaks GitHub OAuth because Better Auth's `baseURL` (line 105 of `define-config.ts`) uses `APP_URL` to construct `redirectURI: ${baseURL}/callback/github` for OAuth registration. A Traefik bypass IngressRoute was considered but rejected — it exposes the endpoint to the public web before Next.js auth. **The correct fix requires a custom LobeHub image** that changes `LobeComfyUI.createImage()` to use `process.env.INTERNAL_APP_URL || process.env.APP_URL`.
10. **Upstream fix filed and PR submitted** — upstream issue https://github.com/lobehub/lobehub/issues/15328 created; upstream PR https://github.com/lobehub/lobehub/pull/15329 opened from `mrsimpson/lobehub:fix/comfyui-internal-app-url` → `lobehub/lobe-chat:canary`. The fix branch was created in the fork at commit `c21d7f09c7`. The fork's existing `build-lobehub-image.yml` workflow only re-tags the upstream image (no source compile); `pr-build-docker.yml` builds from source but requires Docker Hub org credentials unavailable in the fork.
11. **Image generation switched to OpenAI-compat endpoint (flinker:8082)** — while the upstream ComfyUI loopback fix is pending, image generation is configured via the OpenAI-compatible image endpoint at `http://flinker:8082` (handled by a separate agent/change). The native ComfyUI provider wiring (`COMFYUI_BASE_URL`, `enableComfyUI`, `comfyuiUrl`) remains in the codebase as deployed infrastructure but image generation now uses the OpenAI bridge at `:8082`.
12. **All connections are server-side** — confirmed from LobeHub source. Browser → tRPC HTTPS → Next.js server → loopback HTTP (`INTERNAL_APP_URL`) → ComfyUI WebSocket (`@saintno/comfyui-sdk` with Node.js `ws` package) → `flinker:8188`. Browser never directly touches ComfyUI.
13. **Changes are purely additive** — `apps/lobehub/src/index.ts`, `apps/lobehub/Pulumi.yaml`, and `apps/lobehub/Pulumi.dev.yaml` edited. No new files.

14. **Final fix: use `xinference` provider slot for flinker:8082 image generation** — instead of hijacking the `openai` provider (which would occupy the real OpenAI slot), the `xinference` (Xorbits Inference) provider slot is used. `xinference` is a registered `ModelProvider` in model-bank, uses `createOpenAICompatibleRuntime` (so `POST /v1/images/generations` is natively supported), and has no predefined chat models — it's a clean slate. `XINFERENCE_API_KEY=not-needed` enables the provider. `XINFERENCE_PROXY_URL=http://flinker:8082/v1` routes calls to flinker. `XINFERENCE_MODEL_LIST=flux-dev` adds only the FLUX Dev image model. The xinference provider appears in the LobeHub UI as its own entry (Settings → Providers → Xinference), separate from OpenAI. `flux-dev` has `type:'image'` via `getModelPropertyWithFallback` fallback to BFL in model-bank → shows up in AI Image panel. `enableImageGen`/`flinkerImageUrl` Pulumi config keys control activation.

15. **S3 storage: use Cloudflare R2 (external), not in-cluster MinIO** — R2 is already provisioned for the lobehub bucket; credentials are stored in Pulumi config as `s3AccessKeyId` / `s3SecretAccessKey` (secrets). `s3Endpoint` and `s3Bucket` are plain config values. R2 does not require `S3_ENABLE_PATH_STYLE` or `S3_PUBLIC_DOMAIN` — standard virtual-hosted-style URLs work and presigned URLs resolve directly via Cloudflare's CDN. Adding MinIO in-cluster was a temporary workaround when R2 credentials expired; revert to R2 by regenerating credentials in the Cloudflare R2 dashboard (R2 → Manage R2 API Tokens) and updating the Pulumi stack config.

## Notes

### ComfyUI env vars (from LobeHub docs)
| Env var | Required | Notes |
|---|---|---|
| `COMFYUI_BASE_URL` | Required to activate | e.g. `http://flinker:8188` |
| `ENABLED_COMFYUI` | Optional | Defaults to `1`; set `0` to disable |
| `COMFYUI_AUTH_TYPE` | Optional | `none` (default) / `basic` / `bearer` / `custom` |
| `COMFYUI_API_KEY` | Optional | Only when `COMFYUI_AUTH_TYPE=bearer` |

### flinker topology (verified live 2026-05-29)
| Port | Service | Protocol | Verified |
|------|---------|----------|---------|
| `:8080` | llama.cpp multi-model router | OpenAI-compatible `/v1/` | ✓ |
| `:8081` | whisper.cpp ASR | `/inference` | (not tested this session) |
| `:8082` | ComfyUI OpenAI bridge (FastAPI) | OpenAI `/v1/images/generations` — returns `flux-dev`, `flux-dev-fast`, `flux-dev-3-2`, `flux-dev-2-3` models | ✓ |
| `:8188` | ComfyUI native API + UI | ComfyUI WebSocket + REST — `system_stats`, `queue`, `object_info`, `models/*` all respond | ✓ |

- ComfyUI version: **0.22.0** (aiohttp/3.13.5, Python 3.12)
- The bridge at `:8082` wraps `:8188` internally; LobeHub's native ComfyUI provider speaks directly to `:8188`
- ComfyUI is always-on (`systemd`, `Restart=on-failure`)

### Installed models (verified via `/object_info/UnetLoaderGGUF`, updated 2026-05-29)
| Type | Files |
|------|-------|
| GGUF UNet | `flux1-dev-Q4_K_S.gguf` ✓, `flux1-schnell-Q4_K_S.gguf` ✓ |
| VAE | `ae.safetensors` |
| Text encoders | `clip_l.safetensors`, `t5xxl_fp16.safetensors` |
| Checkpoints / diffusion_models | *(empty — GGUF models not listed here, expected)* |

Both FLUX.1 dev and schnell are now installed. ADR target model (dev) is present.

### Existing lobehub opt-in pattern (reference)
```typescript
// Memory / embeddings — controlled by lobehub:enableMemory config flag
const enableMemory = cfg.getBoolean('enableMemory') ?? false;
const lmstudioUrl = cfg.get('lmstudioUrl') ?? '';
// Web search — opt-in; requires a Brave Search API key.
const enableSearch = cfg.getBoolean('enableSearch') ?? false;
```

### Files changed (homelab-apps repo)
- `apps/lobehub/src/index.ts` — `enableImageGen`/`flinkerImageUrl` config; `XINFERENCE_*` env vars; `INTERNAL_APP_URL`
- `apps/lobehub/Pulumi.yaml` — documents `enableImageGen`, `flinkerImageUrl`, R2 S3 config keys
- `apps/lobehub/Pulumi.dev.yaml` — `enableImageGen=true`, `flinkerImageUrl=http://flinker:8082/v1`, R2 credentials
- `apps/lobehub/Pulumi.dev.yaml.example` — template entries for `enableImageGen`/`flinkerImageUrl`

### Files changed (local-ai / flinker repo — separate repo)
- `local-ai/comfyui-bridge/bridge.py` — `response_format` default changed `"url"` → `"b64_json"`
- `local-ai/docs/adr/03-image-generation.md` — status Accepted; implementation notes; S3 storage notes

## Explore
<!-- beads-phase-id: homelab-apps-5.1 -->
### Tasks
<!-- beads-synced: 2026-05-30 -->
*Auto-synced — do not edit here, use `bd` CLI instead.*

- [x] `homelab-apps-5.1.1` Read lobehub index.ts and models.ts in full
- [x] `homelab-apps-5.1.2` Check Pulumi.yaml config schema for lobehub
- [x] `homelab-apps-5.1.3` Research LobeHub ComfyUI env vars from docs/source
- [x] `homelab-apps-5.1.4` Check local-ai flinker ComfyUI endpoints and ports

## Plan
<!-- beads-phase-id: homelab-apps-5.2 -->
### Tasks
<!-- beads-synced: 2026-05-30 -->
*Auto-synced — do not edit here, use `bd` CLI instead.*

- [x] `homelab-apps-5.2.1` Review existing opt-in pattern and design ComfyUI config shape
- [x] `homelab-apps-5.2.2` Add enableComfyUI + comfyuiUrl config reading to index.ts
- [x] `homelab-apps-5.2.3` Inject COMFYUI_BASE_URL into baseEnv when enableComfyUI is true
- [x] `homelab-apps-5.2.4` Document new config keys in Pulumi.yaml
- [x] `homelab-apps-5.2.5` Update ADR 03-image-generation.md to reflect native integration

## Code
<!-- beads-phase-id: homelab-apps-5.3 -->
### Tasks
<!-- beads-synced: 2026-05-30 -->
*Auto-synced — do not edit here, use `bd` CLI instead.*

- [x] `homelab-apps-5.3.1` Edit apps/lobehub/src/index.ts: add enableComfyUI + comfyuiUrl config + COMFYUI_BASE_URL env injection
- [x] `homelab-apps-5.3.10` Configure homelab-apps stack to use custom lobehub image
- [x] `homelab-apps-5.3.11` Switch image generation from ComfyUI native to OpenAI-compat (flinker:8082)
- [x] `homelab-apps-5.3.12` Remove dead bypass IngressRoute code from index.ts
- [x] `homelab-apps-5.3.13` Update Pulumi.dev.yaml: add flinkerImageUrl, remove enableComfyUI
- [x] `homelab-apps-5.3.2` Edit apps/lobehub/Pulumi.yaml: document lobehub:enableComfyUI and lobehub:comfyuiUrl config keys
- [x] `homelab-apps-5.3.3` Update local-ai/docs/adr/03-image-generation.md: status Accepted, note both models + native integration
- [x] `homelab-apps-5.3.4` Run tsc build check and commit
- [x] `homelab-apps-5.3.5` Fix APP_URL to localhost to bypass oauth2-proxy on loopback
- [x] `homelab-apps-5.3.6` Fix /webapi/create-image/comfyui loopback: bypass oauth2-proxy for internal requests
- [x] `homelab-apps-5.3.7` Create upstream issue in lobehub/lobe-chat with fix proposal
- [x] `homelab-apps-5.3.8` Create fix branch in mrsimpson/lobe-chat fork with INTERNAL_APP_URL patch
- [x] `homelab-apps-5.3.9` Build custom lobehub image from fork via GitHub Actions

## Commit
<!-- beads-phase-id: homelab-apps-5.4 -->
### Tasks
<!-- beads-synced: 2026-05-30 -->
*Auto-synced — do not edit here, use `bd` CLI instead.*

- [x] `homelab-apps-5.4.1` Add MinIO in-cluster S3 storage to replace R2
- [x] `homelab-apps-5.4.2` Fix MinIO IngressRoute: use web entrypoint (Cloudflare tunnel)
- [x] `homelab-apps-5.4.3` Fix MinIO pod label: remove app:lobehub to avoid service selector collision
- [x] `homelab-apps-5.4.4` Code cleanup: review debug artifacts, section numbering, comments
- [x] `homelab-apps-5.4.5` Update plan file: log MinIO IngressRoute and label decisions
- [x] `homelab-apps-5.4.6` Update ADR with MinIO lessons learned
- [x] `homelab-apps-5.4.7` Commit all changes and verify CI
- [x] `homelab-apps-5.4.8` Fix S3_ENDPOINT: use public URL for presigned URL browser resolution
- [x] `homelab-apps-5.4.9` Final commit phase: example file + plan file cleanup

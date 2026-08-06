# LobeHub

> Part of [homelab-apps](../../README.md) — self-hosted AI chat frontend.

This directory contains only the **homelab deployment** (Pulumi IaC) for [LobeHub](https://github.com/lobehub/lobe-chat). For the application itself, see the upstream project.

Deploys with:
- Local LLM inference via [local-ai](https://github.com/digitaleraluhut/local-ai) (Qwen3, Devstral, etc.)
- ParadeDB (Postgres + pgvector) for conversation storage and RAG
- Brave Search integration for web-grounded answers
- Image generation via native ComfyUI/FLUX (ComfyUI provider, `COMFYUI_BASE_URL`)
- OAuth2-Proxy authentication (GitHub)

## Endpoints consumed

| Service | Source | URL |
|---------|--------|-----|
| LLM (chat/completions) | local-ai | `http://flinker:8080/v1` |
| Embeddings | local-ai | `http://flinker:8080/v1` |
| STT (whisper) | local-ai | `http://flinker:8081` |
| Image generation (ComfyUI provider) | local-ai ComfyUI | `http://flinker:8188` |

> **Image generation:** the LobeHub ComfyUI provider talks the **native ComfyUI
> API**, so `lobehub:comfyuiUrl` points at the ComfyUI server (`:8188`), not the
> OpenAI bridge (`:8082`). It requires the `flux1-dev-fp8.safetensors` checkpoint
> on that server — GGUF files are not loadable by LobeHub's provider. Install it
> with `local-ai`'s `./scripts/download-flux-models.sh`.

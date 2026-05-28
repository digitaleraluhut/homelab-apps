# Development Plan: homelab-apps (fix/transcription-bot-notice-msgtype-and-llm-debug branch)

*Generated on 2026-05-24 by Vibe Feature MCP*
*Workflow: [minor](https://codemcp.github.io/workflows/workflows/minor)*

## Goal
Fix two bugs in the voice-transcription-bot (GitHub issues #5 and #6):

1. **Issue #5** — Signal bridge posts spurious "not bridged" warnings after every transcription reply because the bot sends `m.text` which the bridge tries to forward upstream. Fix: change all bot replies to `m.notice`.
2. **Issue #6** — Summarization silently fails. Root cause: `LLM_MODEL` defaults to `"default"` which is **unloaded** on flinker; the actually loaded chat model is `qwen3.6-35b-a3b`. Fix: discover the loaded model dynamically from `/v1/models` at startup.

## Key Decisions

### D-1: Use `m.notice` for all bot replies (issue #5)
`_send_reply` currently uses `msgtype: m.text`. mautrix bridges are configured to ignore `m.notice` messages (bots/status messages convention). Changing to `m.notice` stops the bridge from attempting to forward the reply to Signal. `_send_error_reply` already uses `m.notice` correctly — only `_send_reply` needs updating.

### D-2: Discover loaded LLM model dynamically at startup (issue #6)
`/v1/models` on flinker:8080 reveals four models; only `qwen3.6-35b-a3b` and `bge-m3` are `status.value = "loaded"`. `bge-m3` is an embeddings model (not a chat model — it has `--embeddings` flag). The correct model is `qwen3.6-35b-a3b`. Rather than hard-coding it, the bot will call `/v1/models` at startup and pick the first loaded non-embeddings model (heuristic: no `--embeddings` in args). This is robust to future model changes on flinker.

### D-3: Remove `LLM_MODEL` env var entirely
Since we always discover the model dynamically, the `LLM_MODEL` env var is unnecessary and misleading (setting it to `"default"` caused the bug). Remove it from `main.py`, `smoke_test.py`, and any k8s config. The model name will be logged at startup for observability.

### D-4: Improve LLM error logging
`str(aiohttp.ClientResponseError)` is empty string — the error message is in `exc.message` or `exc.status`. Log status code and response body on non-200 responses. Also catch `aiohttp.ClientResponseError` explicitly to surface the HTTP status.

### D-5: Increase LLM timeout
30 s is too short for qwen3.6-35B which may need to load KV cache and run multi-step reasoning. Increase to 120 s (matching the whisper timeout).

### D-6: Structured multilingual summary prompt
Replaced single-sentence summary with a structured format: **TL;DR** (one sentence) + optional **Actions** section (only when CTAs exist) + **Key points** bullets. The prompt instructs the model to translate *all* text including section headings into the detected language. Tested against a German voice note — model produced "Aktionen" and "Wichtige Punkte" correctly. `max_tokens` bumped to 2000 to accommodate the longer structured output plus Qwen3's chain-of-thought.

### D-7: Minimal markdown→HTML renderer for structured output
Added `_markdown_to_html()` in `main.py` to convert the LLM's `**bold**` headings and `- bullet` lists into `<strong>`, `<ul>/<li>` HTML for Matrix clients that render formatted_body. Falls back gracefully — plain text body retains raw markdown which reads naturally in clients without HTML rendering.

### D-8: End-to-end test script (`e2e_test.py`)
Added `e2e_test.py` alongside `smoke_test.py`. It fetches the most recent m.audio event from the Signal bridge room via the Matrix Client-Server API, downloads the file, runs it through whisper.cpp and llama.cpp end-to-end, and prints the structured output. Uses only stdlib (no aiohttp/requests). Run with: `kubectl exec -n matrix <pod> -- python3 /app/e2e_test.py`.

## Notes

### flinker:8080 model inventory (observed 2026-05-24)
| id | status | notes |
|---|---|---|
| `bge-m3` | loaded | embeddings model — not for chat |
| `default` | **unloaded** | placeholder, no model file configured |
| `ggml-org/gpt-oss-120b-GGUF` | unloaded + failed | exit_code=1 |
| `qwen3.6-35b-a3b` | **loaded** | Qwen3 MoE 35B — the correct chat model |

### flinker port mapping
- `:8080` — llama.cpp (multi-model manager, OpenAI-compatible `/v1/`)
- `:8081` — whisper.cpp (ASR, `/inference` endpoint)

### Root cause of `"error": ""`
`aiohttp.ClientResponseError.__str__` returns an empty string in some versions; the useful fields are `.status` and `.message`. The current broad `except Exception` catch loses this context.

## Explore
<!-- beads-phase-id: homelab-apps-3.1 -->
### Tasks
<!-- beads-synced: 2026-05-24 -->
*Auto-synced — do not edit here, use `bd` CLI instead.*


## Implement
<!-- beads-phase-id: homelab-apps-3.2 -->
### Tasks
<!-- beads-synced: 2026-05-24 -->
*Auto-synced — do not edit here, use `bd` CLI instead.*


## Finalize
<!-- beads-phase-id: homelab-apps-3.3 -->
### Tasks
<!-- beads-synced: 2026-05-24 -->
*Auto-synced — do not edit here, use `bd` CLI instead.*


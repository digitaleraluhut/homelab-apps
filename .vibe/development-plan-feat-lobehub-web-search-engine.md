# Development Plan: feat/lobehub-web-search-engine

## Goal
Add web search functionality to the self-hosted LobeHub deployment using Brave Search API.

## Explore
### Tasks
- [x] Fetch LobeHub online search documentation
- [x] Review existing project structure and codebase
- [x] Identify required environment variables and infrastructure
- [x] Evaluate SearXNG vs Brave API vs other providers
- [x] Evaluate Grafana metrics capability for each option

### Completed
- [x] Created development plan file

## Plan
### Tasks
- [x] Add `braveApiKey` and `enableSearch` config options to `Pulumi.yaml` and `Pulumi.dev.yaml`
- [x] Add `SEARCH_PROVIDERS`, `CRAWLER_IMPLS` environment variables to LobeHub's env config
- [x] Wire `BRAVE_API_KEY` into LobeHub's secret

### Completed
- [x] Add `braveApiKey` and `enableSearch` config options to `Pulumi.yaml` and `Pulumi.dev.yaml`
- [x] Add `SEARCH_PROVIDERS`, `CRAWLER_IMPLS` environment variables to LobeHub's env config
- [x] Wire `BRAVE_API_KEY` into LobeHub's secret

## Code
### Tasks
- [x] Add Pulumi config: `enableSearch` (bool, default false) and `braveApiKey` (secret)
- [x] Add `BRAVE_API_KEY` to the app secret
- [x] Add `SEARCH_PROVIDERS="brave"` and `CRAWLER_IMPLS="naive"` to LobeHub env
- [x] Add config values to `Pulumi.dev.yaml`

### Completed
- [x] Added `enableSearch` (bool, default false) and `braveApiKey` (secret) config to `Pulumi.yaml` with usage comments
- [x] Added `lobehub:enableSearch: "false"` to `Pulumi.dev.yaml`
- [x] Added `BRAVE_API_KEY` to LobeHub's Kubernetes secret (conditionally, only when `enableSearch` is true and `braveApiKey` is set)
- [x] Added `SEARCH_PROVIDERS="brave"` and `CRAWLER_IMPLS="naive"` to LobeHub's base env vars (conditionally, only when `enableSearch` is true)
- [x] TypeScript type-check passes (`tsc --noEmit`)

## Commit
### Tasks
- [x] Remove debug output — none found (code was clean from the start)
- [x] Review TODO/FIXME comments — none found
- [x] Remove debugging code blocks — none found
- [x] Fix `enableSearch` config comment: removed erroneous `--secret` flag (boolean, not secret)
- [x] TypeScript type-check passes (`tsc --noEmit`)
- [x] Documentation review — no long-term memory docs to update
- [x] Commit changes with conventional commit message
- [x] Rebase onto origin/main — resolved Pulumi.dev.yaml conflict (kept your `enableSearch: "true"` and `braveApiKey` values)
- [x] Force-push rebased branch
- [x] PR → https://github.com/mrsimpson/homelab-apps/pull/3

### Completed
*All tasks complete.*

## Key Decisions
1. **Brave Search API** — Chosen over SearXNG after evaluating:
    - SearXNG has no conditional/fallback routing between engines
    - Brave API is simpler (one env var, no container to manage)
    - Brave API is a real API with stable contract (not scraping HTML)
    - Brave offers 100 free credits/month (~1,000 searches)
2. **`naive` crawler as default** — Built-in general-purpose crawler, no extra API keys needed. Set via `CRAWLER_IMPLS="naive"`.
3. **No Grafana metrics for Brave** — Brave Search API has no Prometheus metrics endpoint. Brave's usage dashboard at `api-dashboard.search.brave.com` is sufficient for homelab monitoring.
4. **Feature flag `enableSearch`** — Opt-in via Pulumi config, defaulting to `false`.
5. **`BRAVE_API_KEY` conditional in secret** — Only included in the Kubernetes Secret when `enableSearch` is true AND `braveApiKey` is set, avoiding unnecessary secret rotation noise.
6. **`SEARCH_PROVIDERS` and `CRAWLER_IMPLS` conditional in env** — Only injected into the Deployment's env array when `enableSearch` is true, keeping the default deployment unchanged.

## Notes
- Brave API key is required: `BRAVE_API_KEY`
- Brave search depth can be configured: `TAVILY_SEARCH_DEPTH` (not applicable to Brave)
- Brave offers: Web Search, Answers (AI summaries), Images, Videos, News endpoints
- Brave is powered by its own independent index (30B+ pages)
- `enableSearch` is a boolean config (NOT a secret) — only `braveApiKey` needs `--secret`

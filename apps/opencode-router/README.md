# OpenCode Router

> Part of [homelab-apps](../../README.md) — remote AI coding sessions.

This directory contains only the **homelab deployment** (Pulumi IaC) for [OpenCode](https://opencode.ai/). For the application itself, see the upstream project.

Deploys per-user isolated instances with:
- Dynamic Cloudflare DNS routing per session
- OAuth2-Proxy authentication (developers-only allowlist)
- Automatic lifecycle management (spin up on demand, tear down on idle)
- LLM via [local-ai](https://github.com/digitaleraluhut/local-ai) for code completion and chat

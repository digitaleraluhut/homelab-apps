# Matrix

> Part of [homelab-apps](../../README.md) — private messaging with voice transcription.

This directory contains only the **homelab deployment** (Pulumi IaC) for the Matrix stack. For the upstream projects, see:
- [Conduit](https://conduit.rs/) — lightweight Matrix homeserver
- [mautrix-whatsapp](https://github.com/mautrix/whatsapp) / [mautrix-signal](https://github.com/mautrix/signal) — messaging bridges

Deploys with:
- WhatsApp and Signal bridges into Matrix
- Voice transcription bot — transcribes voice messages using Whisper STT, summarizes with LLM

## Endpoints consumed

| Service | Source | URL |
|---------|--------|-----|
| STT (whisper) | local-ai | `http://flinker:8081` |
| LLM (summarization) | local-ai | `http://flinker:8080/v1` |

# Twix AI Router (391 Models + Unlimited Round-Robin + 1-Click Bulk Tester)

OpenAI, Anthropic, and Image Generation compatible API Gateway with:
- **Unlimited Multi-API Key Round-Robin & Auto-Failover**: Automatically switches to Key #2, #3, ... if Key #1 runs out of quota or hits rate limits (`401/402/403/429/5xx`).
- **1-Click Bulk Model Tester**: Sequentially tests all 391 models with a single click (`"hallo"`), showing live status, latency (ms), and response preview.
- **391 Models Catalog**: Built-in searchable catalog with pricing and context window metadata.

## Quick Start

```bash
npm install
export DATABASE_URL="postgresql://..." # Optional: Neon Postgres URL for persistent key pool
export WEBSERVER_PORT=3001
npm start
```

## Endpoints
- `GET /` — Interactive Dashboard, API Key Pool Manager & 1-Click Bulk Tester
- `GET /v1/models` — List all 391 models
- `POST /v1/chat/completions` — OpenAI Chat Completions (Round-Robin + Failover)
- `POST /v1/messages` — Anthropic Messages (Round-Robin + Failover)
- `POST /v1/images/generations` — Image Generation
- `POST /api/models/test` — Fast single-model test endpoint
- `GET | POST | PATCH | DELETE /api/keys` — Manage API key pool

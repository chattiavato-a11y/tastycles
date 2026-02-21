# Cloudflare Worker Requirements for Gabo Chatbot UI Integration

## 1) Repo-driven integration baseline

This repository already expects a Cloudflare Worker gateway and a browser-side `WorkerClient` bridge.
The Worker **must** be compatible with:

- `worker_files/worker.config.json` canonical runtime contract.
- `worker_files/client.worker.js` request behavior.
- `app.js` UI flow (chat submit, voice STT, and TTS).

If the Worker does not match these interfaces, the UI can render but chat interactions fail at runtime.

## 2) Required API surface (must exist)

The Worker must expose these routes (relative to `gatewayEndpoint`):

- `POST /api/chat` → chatbot response stream for the UI.
- `POST /api/voice` → speech-to-text (mode `stt` or `chat`).
- `POST /api/tts` → text-to-speech audio output.
- `GET /health` (and optionally `/`) → operational health/status probe.
- `OPTIONS` for all above routes → CORS preflight support.

> Current gateway file (`worker_files/drastic-measures.gateway.js`) still contains a placeholder block that returns `501` for unimplemented handlers. Production integration requires replacing that placeholder with full route handlers.

## 3) Required request contract (frontend → Worker)

### 3.1 Core headers

Worker must accept and validate:

- `content-type`
- `accept`
- `x-ops-asset-id` (asset identity binding per allowed origin)
- optional integrity: `x-ops-src-sha512-b64`
- language hints:
  - `x-gabo-lang-hint`
  - `x-gabo-lang-list`
  - `x-gabo-voice-language`
- anti-bot honeypot headers:
  - `x-gabo-honeypot`
  - `x-gabo-honeypot-pre`

### 3.2 Chat request expectations

`WorkerClient.postChat()` sends:

- `POST /api/chat`
- `accept: text/event-stream`
- JSON request body

Therefore Worker must support at least one of:

1. **SSE streaming** (`Content-Type: text/event-stream`) for incremental assistant output, or
2. Non-stream JSON fallback that the UI can parse deterministically.

Preferred is SSE because current UI flow is stream-first.

### 3.3 Voice and TTS expectations

- `POST /api/voice` accepts `Blob`/binary audio payloads and query `mode=stt|chat`.
- `POST /api/tts` accepts `{ text, lang_iso2 }` JSON and returns audio bytes (`audio/mpeg` or compatible).

## 4) Required response contract (Worker → frontend)

### 4.1 CORS (hard requirement)

For both preflight and actual responses:

- `Access-Control-Allow-Origin` for approved origins.
- `Access-Control-Allow-Methods: GET, POST, OPTIONS` (or stricter equivalent covering used methods).
- `Access-Control-Allow-Headers` must include all headers used by the client contract.
- `Access-Control-Expose-Headers` should include operational metadata headers consumed by UI.
- `Vary: Origin` (+ request-header variants for preflight).

### 4.2 Metadata headers expected/used by UI stack

Expose (when available):

- `x-gabo-stt-iso2`
- `x-gabo-voice-timeout-sec`
- `x-gabo-tts-iso2`
- `x-gabo-lang-iso2`
- `x-gabo-model`
- `x-gabo-translated`
- `x-gabo-embeddings`
- `x-gabo-asset-verified`

Useful for diagnostics:

- `x-gabo-cors-debug`

### 4.3 Error semantics

Return JSON for non-stream failures with stable shape, e.g.:

```json
{ "error": "message", "code": "origin_not_allowed" }
```

Suggested status codes:

- `400` bad request/validation
- `401/403` auth or origin/asset identity reject
- `413` payload too large
- `415` unsupported media type
- `429` rate limit
- `500/502/503` upstream/model failures

## 5) Security and trust boundary requirements

## 5.1 Origin allowlist

Use strict allowlist from canonical config:

- `https://www.gabos.io`
- `https://gabos.io`
- `https://chattiavato-a11y.github.io`
- Worker origin

Reject other origins early with explicit error response.

### 5.2 Asset identity binding

Map `origin -> asset_id` and enforce `x-ops-asset-id` equality before invoking model APIs.

### 5.3 Honeypot and injection resistance

- Block requests tripping honeypot headers/fields.
- Sanitize/validate incoming text payloads.
- Apply body size/message count limits from config.

### 5.4 Secrets and environment

Do **not** store secrets in public config JSON.
Use Worker secrets for:

- external API keys/tokens
- optional repo handshake secret (`DRASTIC_MEASURES`)

## 6) AI provider/runtime requirements inside Worker

The gateway file indicates Cloudflare AI model usage (guard, chat, STT, TTS). Worker implementation should:

- run guard/safety checks before chat completion
- route chat prompts to configured chat model
- route audio transcription to STT model with timeout
- route speech synthesis to TTS model with language-aware selection
- include graceful fallback model behavior where applicable

## 7) Operational and DevSecOps requirements

- Keep `worker_files/worker.config.json` as canonical public runtime config.
- Keep Worker route names synchronized with `config.routes`.
- Ensure endpoint parity checks pass (`workerEndpointAssetId === gatewayEndpointAssetId`).
- Provide health endpoint for uptime monitoring.
- Emit structured logs with request IDs and security decision points.
- Add rate limiting (per IP + per origin + per asset ID).

## 8) Implementation gaps currently visible in repo

1. Existing Worker file is CORS-hardened but still has placeholder business logic returning `501` for chat/voice/tts handlers.
2. UI and `WorkerClient` already assume `/api/chat`, `/api/voice`, and `/api/tts` are fully implemented.
3. Canonical config is rich and production-shaped, but deployed Worker must enforce the same contract at runtime.

## 9) Definition of done (for this repo)

A Worker implementation is "aligned" when all are true:

1. `POST /api/chat` responds successfully to browser requests from allowed origins using configured asset identity.
2. `POST /api/voice` and `POST /api/tts` complete within configured limits/timeouts.
3. Browser preflight (`OPTIONS`) succeeds for all client-sent headers.
4. No `501` placeholder paths remain in production Worker.
5. `scripts/cf-worker-communication.mjs` succeeds for `health`, `chat`, and optional `handshake` (when enabled).
6. Security checks (`scripts/security-integrity-check.mjs`) remain clean.


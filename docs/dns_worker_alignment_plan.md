# DNS + Cloudflare Worker alignment plan (www.gabos.io)

## What `www.gabos.io returns NXDOMAIN` means

NXDOMAIN means DNS resolvers cannot find a DNS record for that host name.
In plain terms: browsers cannot find an IP/CNAME target for `www.gabos.io`, so they fail before your HTML/CSS/JS app or Worker code runs.

## How to remove NXDOMAIN and return fully to `www.gabos.io`

1. In the authoritative DNS zone for `gabos.io`, create/verify `www`:
   - Type: `CNAME`
   - Name: `www`
   - Target: your Cloudflare Pages/Worker hostname (or the configured canonical target)
   - Proxy: enabled if you are routing via Cloudflare edge.
2. Keep apex (`gabos.io`) redirecting to `https://www.gabos.io` for canonical consistency.
3. Ensure SSL/TLS certificate covers both `gabos.io` and `www.gabos.io`.
4. Wait for propagation and validate from multiple resolvers.

Validation commands:
- `host www.gabos.io`
- `dig +short www.gabos.io @1.1.1.1`
- `dig +short www.gabos.io @8.8.8.8`

Success condition:
- All resolvers return a valid CNAME/A/AAAA chain (not NXDOMAIN).

## Repo alignment to your Cloudflare Worker baseline

This repository is now aligned to the provided gateway baseline in these ways:

1. Canonical worker script is `drastic-measures.gateway.js` in TOML deployment config.
2. Allowed origins in TOML match the baseline origin set:
   - `https://www.gabos.io`
   - `https://gabos.io`
   - `https://chattiavato-a11y.github.io`
   - `https://drastic-measures.rulathemtodos.workers.dev`
3. `worker_files/worker.config.json` is normalized to one schema style and includes:
   - full endpoint set,
   - non-empty gateway endpoint asset id,
   - origin→asset-id mapping parity for all four origins,
   - required header parity (`Content-Type`, `Accept`, `X-Ops-Asset-Id`).
4. Stack remains HTML/CSS/JS + Cloudflare Worker only (no Flutter/Firebase runtime introduced).

## Implementation fix plan

### Phase 0 — DNS recovery (immediate)
- Repair authoritative `www` DNS record.
- Verify resolver parity and capture evidence in release notes.

### Phase 1 — Deployment consistency (same day)
- Deploy only `worker_files/drastic-measures.gateway.js` as gateway main.
- Keep TOML and JSON config in sync from one source.

### Phase 2 — Runtime verification (same day)
- Smoke test:
  - `GET /health`
  - `POST /api/chat`
  - `POST /api/voice?mode=stt`
  - `POST /api/tts`
- Validate CORS and `x-ops-asset-id` enforcement per allowed origin.

### Phase 3 — Guardrails (next)
- Add CI checks for config parity and allowlist parity.
- Add DNS readiness check to release checklist.

# GitHub Actions ↔ Cloudflare Worker handshake

This repository includes a repo-secret handshake job in `.github/workflows/security-integrity.yml`.

## Required repository secrets

Set these repository secrets in GitHub:

- `DRASTIC_MEASURES`
- `TURNSTILE_SECRET_KEY`

`DRASTIC_MEASURES` must match the Cloudflare Worker secret `env.DRASTIC_MEASURES`.
`TURNSTILE_SECRET_KEY` should match the Worker secret used to validate Turnstile tokens server-side.

## Worker contract this repo now matches

- Repo handshake path: `/__repo/handshake`
- Repo handshake header: `x-gabo-repo-id`
- Repo handshake header value: raw shared secret (`DRASTIC_MEASURES`)
- Repo handshake algorithm: `shared-secret-header`

## Turnstile

- Public site key: `0x4AAAAAACf9q_m7LLI2VXXj`
- Local development fallback key: `1x00000000000000000000AA` (used automatically on localhost to avoid Turnstile domain binding errors).
- Browser header to Worker: `cf-turnstile-response`
- Worker validates token against Cloudflare Turnstile API using private secret.

## Runtime config source

Handshake and Turnstile parameters are defined in `worker_files/worker.config.json`.

## Verification behavior

- CI fails if `DRASTIC_MEASURES` is missing.
- Handshake fails if Worker returns a non-2xx response.

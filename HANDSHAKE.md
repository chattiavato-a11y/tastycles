# GitHub Actions ↔ Cloudflare Worker handshake

This repository includes a repo-secret handshake job in `.github/workflows/security-integrity.yml`.

## Required repository secret

Set this repository secret in GitHub:

- `DRASTIC_MEASURES`

This must match the Cloudflare Worker secret `env.DRASTIC_MEASURES`.

## Worker contract this repo now matches

- Path: `/__repo/handshake`
- Header: `x-gabo-repo-id`
- Header value: raw shared secret (`DRASTIC_MEASURES`)
- Algorithm: `shared-secret-header`

## Runtime config source

Handshake parameters are defined in `worker_files/worker.config.json` under `actions_handshake`.

## Verification behavior

- CI fails if `DRASTIC_MEASURES` is missing.
- Handshake fails if Worker returns a non-2xx response.

# Repository health audit and fixing plan

Date: 2026-02-18

This audit captures what is currently wrong in the repository based on file inspection and environment checks, then proposes a concrete fix plan.

## Executive summary

Primary issue: the project has **split deployment truth** (multiple gateway workers, duplicate configuration files, and inconsistent allowlists) while the custom domain setup is also currently unresolved from this environment (`www.gabos.io` returns NXDOMAIN).

The combination creates availability, reliability, and security drift risk.

## What is wrong (evidence-backed)

### 1) Custom domain currently fails resolution

- `CNAME` sets the site hostname to `www.gabos.io`.
- DNS lookups in this environment return NXDOMAIN for `www.gabos.io`.

Impact:
- If authoritative DNS is actually missing or misconfigured, users get hard outage before app code is even reached.

### 2) Two config files define overlapping runtime settings with mismatches

- Root `worker.config.json` and `worker_files/worker.config.json` both define endpoint/origin policy but with conflicting values and schema.
- `worker_files/worker.config.json` contains both `assistant_endpoint` and `assistantEndpoint` (camel + snake mixed), with one empty string.
- `gatewayEndpointAssetId` is populated in root config but empty in `worker_files/worker.config.json`.

Impact:
- Environment behavior depends on which file is loaded by which script.
- Incident response becomes guesswork.

### 3) Gateway allowlists are inconsistent across worker and config

- `worker_files/gateway.worker.toml` allowlist is `https://www.gabos.io,https://dash.cloudflare.com`.
- App/config allowlists include `https://gabos.io`, `https://chattiavato-a11y.github.io`, and workers.dev origin.

Impact:
- Legitimate frontend origins may fail CORS/authorization depending on active artifact.

### 4) Multiple gateway implementations exist with unclear production source of truth

Current repo includes:
- `worker_files/gateway.worker.js`
- `worker_files/drastic-measures.gateway.js`
- `worker_files/gateway.edge.worker.js`
- `worker_files/enlace.worker.js`

Impact:
- High risk of patching the wrong file.
- Security fixes can land in one worker variant while production uses another.

### 5) UI intro language rotates automatically every 30 seconds

- `app.js` sets `startIntroRotation()` with a `setInterval(..., 30000)` cycling locales.

Impact:
- Accessibility and UX regression for users who need stable language context.
- Violates deterministic preference expectations.

### 6) Compliance controls are documented, but enforcement automation is thin

- `docs/security_compliance_controls.md` lists release requirements.
- Repo currently lacks an explicit CI gate implementation to enforce config parity, DNS checks, and schema consistency.

Impact:
- Controls are policy-only unless manually followed.

## Fixing plan

## Phase 0 (same day): restore reachability and stop drift

1. Validate DNS zone for `www.gabos.io` at registrar + DNS provider and restore authoritative record.
2. Add an operations runbook section with the exact DNS verification commands and expected outputs.
3. Declare one active gateway file immediately (temporary decision) and document it in root `worker.config.json` + README.

Exit criteria:
- `www.gabos.io` resolves on at least three external resolvers.
- `/health` returns `200` from production route.

## Phase 1 (1-2 days): establish single configuration authority

1. Keep only one canonical worker config (recommended: `worker_files/worker.config.json`).
2. Generate root `worker.config.json` from canonical source using a script (no hand-edits in both files).
3. Remove duplicate keys (`assistant_endpoint` vs `assistantEndpoint`) and forbid empty critical fields.
4. Move origin→asset map to one registry file and import from app + worker build paths.

Exit criteria:
- Config parity check passes.
- No duplicate schema keys for the same semantic field.

## Phase 2 (2-3 days): consolidate gateways and align allowlists

1. Select one production gateway implementation and archive the others under `worker_files/archive/`.
2. Align `gateway.worker.toml`, app allowlist, and config allowlist from one shared registry artifact.
3. Add smoke tests for `/api/chat`, `/api/voice`, `/api/tts`, `/health`.

Exit criteria:
- Single deployable gateway artifact.
- All route smoke tests pass for each allowed origin.

## Phase 3 (1 day): UX stability and accessibility hardening

1. Disable auto-rotation of intro locale by default.
2. Add explicit language switcher and persist preference (localStorage).
3. Ensure intro copy respects stored preference and does not change unexpectedly.

Exit criteria:
- Locale remains stable across session and refresh.
- Keyboard + screen-reader checks pass for language controls.

## Phase 4 (2-3 days): enforce controls in CI

1. Add CI workflow checks for:
   - JSON schema validation for configs
   - allowlist parity across app/config/worker toml
   - worker file uniqueness (fail if more than one active gateway)
   - SRI hash validation for referenced assets
2. Add secret scanning and dependency audit.

Exit criteria:
- PR cannot merge unless parity and security checks pass.

## Suggested owner map

- DNS and domain recovery: Platform/Ops
- Config canonicalization + generation script: Application engineering
- Gateway consolidation + tests: Edge/Worker engineering
- UX language controls: Frontend engineering + accessibility QA
- CI guardrails: DevSecOps

## Definition of done

The issue is considered fixed when:
1. custom domain is externally resolvable,
2. one gateway artifact is active,
3. one canonical config drives all generated artifacts,
4. allowlists are parity-checked in CI,
5. locale behavior is deterministic and user-controlled.

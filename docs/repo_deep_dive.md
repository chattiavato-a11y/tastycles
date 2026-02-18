# Repository deep dive: what is wrong right now

This document is an evidence-backed audit of the current repository state and the execution plan to stabilize it.

## 1) The screenshot issue is real: DNS resolution is inconsistent

The screenshot shows `DNS_PROBE_FINISHED_NXDOMAIN` for `https://www.gabos.io`.

Repository evidence:
- `CNAME` points the site to `www.gabos.io`. If that hostname is missing/unstable in DNS, the entire site is unreachable.

CLI evidence from this environment:
- `dig +short www.gabos.io` and `nslookup www.gabos.io` return resolver-dependent answers in this environment.

Interpretation:
- You likely have split/propagation/cache inconsistency across resolvers.
- That explains why one user/browser sees NXDOMAIN while others may resolve successfully.

## 2) Config and deployment source-of-truth is fragmented

There are multiple configs with overlapping fields and conflicting values:
- Root `worker.config.json` includes complete endpoints and workers.dev in allowed origins.
- `worker_files/worker.config.json` uses mixed schema (`assistant_endpoint` + `assistantEndpoint`), includes empty fields, and diverges from root config.

Risk:
- Different runtime paths can behave differently depending on which config file is loaded.
- Incident triage becomes slow and error-prone.

## 3) Worker allowlists are inconsistent across files

- `worker_files/gateway.worker.toml` allowlist differs from app/config expectations.
- App + config + worker maps are not generated from one registry source.

Risk:
- Legitimate clients can be blocked depending on which artifact is active.

## 4) Too many gateway variants create operational ambiguity

There are several worker gateway implementations in-tree:
- `gateway.worker.js`
- `drastic-measures.gateway.js`
- `gateway.edge.worker.js`
- `enlace.worker.js`

`worker.config.json` and TOML can reference different artifacts.

Risk:
- Engineers can patch one file while production runs another.
- Security and behavior drift becomes likely.

## 5) UX behavior conflicts with deterministic user preference

Intro copy auto-rotates languages every 30 seconds, regardless of explicit user choice/persistence.

Risk:
- Unexpected language changes reduce trust and accessibility for assistive users.
- QA and localization validation become non-deterministic.

## 6) Governance intent is stronger than executable controls

There is strong compliance/security intent in comments and metadata, but weak automation evidence in the repo snapshot.

Risk:
- No automated guardrails to enforce schema parity, allowlist consistency, and regression checks before shipping.

---

## Execution plan for the rest of the repo

### Phase 0 (24–48h): Restore availability + unblock users
1. Fix authoritative DNS for `www.gabos.io`; verify with multiple public resolvers and record evidence.
2. Keep anti-bot control minimal but reliable (honeypot + origin/asset-id checks currently in place).
3. Publish a short incident note + rollback path in docs.

### Phase 1 (Week 1): Canonical configuration
1. Declare one canonical config (`worker_files/worker.config.json`) and remove duplicate/legacy keys.
2. Generate root `worker.config.json` from canonical source (do not hand-edit both).
3. Move origin + asset-id mapping to one registry artifact and import it from app + worker build steps.

### Phase 2 (Week 2): Worker consolidation
1. Select one production gateway file and mark others as archived/reference.
2. Align `gateway.worker.toml` vars with canonical allowlist and route map.
3. Add smoke tests for `/api/chat`, `/api/voice`, and `/health`.

### Phase 3 (Week 3): UX + accessibility hardening
1. Disable intro locale auto-rotation by default.
2. Persist user language preference and expose explicit language selection.
3. Run WCAG keyboard/focus/ARIA pass and add basic a11y lint checks.

### Phase 4 (Week 4): DevSecOps guardrails
1. Add CI gates: JSON schema validation, JS syntax/lint, and worker config parity check.
2. Add dependency + secret scanning.
3. Add release checklist: DNS verification, config parity, and endpoint smoke validation.

### Phase 5 (Ongoing): Observability + compliance evidence
1. Define SLOs (availability, P95 latency, error rate).
2. Emit structured logs with request ID + origin + route + status.
3. Produce weekly control-evidence snapshots mapped to NIST/CISA/PCI objectives.

---

## Additional findings (not yet fully remediated)

1. **Canonical SEO signals still hard-bind to `www`**
   - `index.html` canonical and OG URL point to `https://www.gabos.io/`.
   - If DNS remains inconsistent, crawlers and social previews inherit that instability.

2. **CORS policy is static and single-origin at edge headers**
   - `_headers` allows one origin (`https://www.gabos.io`) while runtime allows multiple origins via worker logic.
   - This mismatch can create surprising browser behavior across environments.

3. **PWA/governance basics are incomplete**
   - No `manifest.json`, no service worker registration, and no explicit offline strategy in current web root.
   - This conflicts with the stated PWA/compliance direction.

4. **No environment contract artifacts**
   - There is no dedicated `docs/environments.md` or machine-checked env matrix in this snapshot.
   - Secrets/vars expected by workers are not centrally documented in-repo.

5. **No explicit CI workflow checked into `.github/workflows/`**
   - This prevents mandatory quality/security policy execution before deploy.

6. **Language UX lacks explicit user control despite i18n catalog depth**
   - The translation catalog is rich, but there is no visible locale selector and no persistence contract documented.

7. **Security model currently leans on request-shape controls, not identity hardening**
   - Honeypot + origin + asset-id + sanitizers are useful, but abuse resilience can be improved with robust edge rate limiting / challenge escalation.

---

## Other solution options

### Option A — Cloudflare-first hardening (recommended short path)
- Keep static UI simple.
- Put all trust decisions at worker edge:
  - per-origin/token bucket rate limits,
  - IP reputation thresholds,
  - honeypot + content sanitizer + asset-id checks,
  - optional managed challenge escalation for abusive fingerprints.
- Benefits: lower client complexity, centralized controls, better auditability.

### Option B — GitHub Pages fallback + Worker as API only
- Serve UI from GitHub Pages as public fallback.
- Use custom domain only when DNS health checks pass.
- Keep worker endpoints stable and domain-agnostic.
- Benefits: improved continuity during DNS drift events.

### Option C — Zero-trust signed client requests (higher rigor)
- Issue short-lived signed tokens from worker for UI sessions.
- Require signature + timestamp + nonce on chat/voice calls.
- Add replay protection and strict skew checks.
- Benefits: stronger request authenticity beyond origin/header assertions.

### Option D — Config-as-code pipeline
- Build a single canonical config schema.
- Generate `worker.config.json`, TOML vars, and allowlist maps from one source file.
- Fail CI when generated artifacts differ from committed outputs.
- Benefits: eliminates drift class of incidents.

### Option E — Observability-first rollout
- Introduce route-level metrics and error taxonomy (`origin_blocked`, `asset_mismatch`, `sanitize_blocked`, `upstream_timeout`).
- Add dashboards + alerts + weekly trend review.
- Benefits: rapid triage and measurable reliability gains.

---

## 14-day practical action plan

### Days 1–2
- Stabilize DNS and verify from multiple resolvers.
- Publish temporary status page + known-issues communication.

### Days 3–5
- Unify config source and generate derived artifacts.
- Remove/retire non-production gateway variants or clearly mark them.

### Days 6–9
- Add CI workflow with syntax, schema, and config-parity checks.
- Add edge rate limiting and abuse event logging.

### Days 10–14
- Implement locale selector + persistence.
- Define SLOs and wire first alerts (availability, 5xx, latency).
- Produce first governance evidence snapshot for security/legal review.

---

## Remediation updates implemented in this revision

- Added dual honeypot traps (before entry and before action buttons) with Tiny ML risk scoring in client and gateway.
- Added SRI integrity attributes to local CSS/JS assets in `index.html`.
- Updated `_headers` with explicit CORP + Referrer-Policy + HSTS + X-Frame-Options + X-Content-Type-Options + CSP + CORS headers.
- Updated worker and config allow-headers to include dual honeypot headers.
- Added `docs/security_compliance_controls.md` with NIST, CISA, PCI DSS, OWASP, CSP, CORS, SEO/GSC control mapping.

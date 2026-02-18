# Repository deep dive: how to move from **1/10** to **10/10**

## Executive snapshot

Right now, this repo looks like a **prototype with production ambitions**. It has good ingredients (chat UI, Worker gateway, i18n, voice support), but lacks the delivery rigor, governance, and automation expected for a secure/reliable platform.

If you want to go from a **1 (fragile)** to a **10 (best-in-class)**, you need to systematically improve six pillars:

1. Platform engineering (CI/CD + environments)
2. Security/compliance controls (NIST/CISA/PCI-aligned)
3. Product reliability/observability
4. UX/HCI quality and accessibility
5. AI/LLM safety + governance
6. Documentation and operational runbooks

---

## Current scorecard (honest baseline)

| Pillar | Current | Target | Gap summary |
|---|---:|---:|---|
| Architecture/config hygiene | 2/10 | 10/10 | Multiple config sources with drift and mixed schema conventions |
| CI/CD + quality gates | 1/10 | 10/10 | No pipeline-enforced lint/test/security gates |
| Security + compliance | 3/10 | 10/10 | Good intent in code headers, but incomplete operational controls and evidence trails |
| Reliability + observability | 1/10 | 10/10 | No SLOs/alerts/dashboards/error budgets/instrumentation baselines |
| UX/HCI + accessibility | 4/10 | 10/10 | Decent UI shell, but weak persistence, a11y validation, and deterministic localization UX |
| AI/voice governance | 3/10 | 10/10 | Functional integration but no evaluation, policy controls, abuse/quality monitoring |
| Mobile/Flutter readiness | 2/10 | 10/10 | Starter shell only; not integrated to production backend |

---

## What is wrong now (evidence-backed)

### 1) Config drift and duplicated sources of truth
- Runtime behavior can diverge because endpoint/origin/asset-id settings exist in multiple places with conflicting values and conventions.
- `worker_files/worker.config.json` differs from root `worker.config.json` and app defaults in `app.js`.

### 2) No quality gates means no reliability guarantee
- There is no CI workflow to consistently run syntax, lint, tests, security scanning, or policy checks before merge/deploy.

### 3) Gateway deployment config and source code can disagree
- Worker TOML variables and in-code allowlists are not guaranteed to stay synchronized.

### 4) Security model needs stronger operational controls
- Client-carried headers (asset IDs) are useful for routing/tagging but not strong identity.
- Missing production-grade controls like explicit anti-abuse/rate limiting, signed requests, and evidence-producing compliance checks.

### 5) UX/i18n behavior is not deterministic for user preference
- Locale handling and rotating intro copy can conflict with stable user intent expectations.

### 6) Voice lifecycle and long-session hygiene need hardening
- Audio URL lifecycle is partially managed and should be made leak-safe under interruptions/retries.

### 7) Strategy-to-implementation gap
- The repo narrative is enterprise-grade, but delivery artifacts (governance dashboards, runbooks, measurable KPIs) are not yet in place.

---

## The 1→10 upgrade plan (repair + fix + update)

## Phase 0 (Days 1–3): Stop the bleeding — get to **3/10**

### Repair now
1. **Unify config source**
   - Pick one canonical file/schema (recommended: `worker_files/worker.config.json` + JSON schema).
   - Remove duplicated fields and normalize naming (`assistantEndpoint`, not mixed snake_case/camelCase).
   - Generate any secondary config artifacts from canonical source.

2. **Lock environment matrix**
   - Define `dev/stage/prod` with separate endpoint/origin/keys and release channels.
   - Ban direct edits to production config outside PR.

3. **Create minimum CI checks**
   - JS syntax check
   - JSON schema validation
   - Basic linter
   - Block merge on failure

### Deliverables
- `docs/config-contract.md`
- `docs/environments.md`
- `.github/workflows/ci.yml`

---

## Phase 1 (Week 1–2): Build reliability — get to **5/10**

### Fix core engineering quality
1. **Test pyramid foundation**
   - Unit tests: parsers, config loaders, sanitization functions.
   - Integration tests: `/api/chat`, `/api/voice`, `/api/tts` happy + failure paths.
   - UI smoke (Playwright): open app, send message, verify streaming/cancel behavior.

2. **Observability baseline**
   - Structured logs with request IDs.
   - Dashboard for: latency, 4xx/5xx, stream failures, STT/TTS error rates.
   - Alerts on SLO breaches (availability and latency thresholds).

3. **Release discipline**
   - Conventional commits or release notes automation.
   - Tag and rollback process.

### Deliverables
- `tests/` (unit + integration)
- `playwright/` smoke test
- `docs/runbook-release.md`
- `docs/runbook-incident.md`

---

## Phase 2 (Week 2–4): Security/compliance hardening — get to **7/10**

### Update controls to match NIST/CISA/PCI intent
1. **Identify (NIST/CISA)**
   - Asset inventory: app, worker, secrets, domains, third parties.
   - Threat model for chat + voice + edge gateway.

2. **Protect**
   - Secrets management policy + rotation cadence.
   - Principle of least privilege for CI and cloud credentials.
   - Add anti-abuse controls: rate limits, bot defense, anomaly thresholds.

3. **Detect**
   - Audit logging with retention policy (PCI Req.10 style evidence).
   - Security event alerts (origin violations, suspicious payloads, repeated failures).

4. **Respond/Recover**
   - Incident response playbook with severity matrix, comms templates, and postmortem process.
   - Recovery drills with MTTR tracking.

### Deliverables
- `docs/security-threat-model.md`
- `docs/security-controls-matrix.md` (NIST/CISA/PCI mapping)
- `docs/ir-plan.md`

---

## Phase 3 (Month 2): UX/HCI excellence + product trust — get to **8.5/10**

### Improve human-centered quality
1. **Localization UX correctness**
   - Make language persistent and user-controlled.
   - Disable auto-rotation by default or make it optional onboarding/demo mode.

2. **Accessibility conformance**
   - WCAG 2.1 AA audit for keyboard flows, focus states, contrast, SR labels, live regions.
   - Add automated a11y checks in CI.

3. **Performance targets (Core Web Vitals)**
   - Define and enforce budget thresholds (LCP, CLS, INP/TTI).
   - Add Lighthouse CI and regression alerts.

### Deliverables
- `docs/ux-guidelines.md`
- `docs/a11y-checklist.md`
- `lighthouse-ci` config + reports

---

## Phase 4 (Month 2–3): AI/LLM governance + mobile productionization — get to **9.5/10**

### Upgrade AI platform integrity
1. **Model governance**
   - Define model tiers: quality/cost/latency fallback policy.
   - Prompt/version registry and safe rollback for behavior regressions.

2. **Safety & quality evals**
   - Create eval suite for hallucination, toxicity, language fidelity, and policy compliance.
   - Monitor STT/TTS quality by language and error rate.

3. **Mobile integration**
   - Wire Flutter app to same secure API contract.
   - Add mobile telemetry and release gating.

### Deliverables
- `docs/ai-governance.md`
- `evals/` test cases + baseline scores
- Flutter API integration PRs

---

## Phase 5 (Quarterly maturity): Governance as code — reach **10/10**

### Institutionalize excellence
1. **Policy-as-code**
   - Enforce config schema, security headers, dependency checks, and branch protections via CI policy gates.

2. **Compliance evidence automation**
   - Generate machine-readable compliance artifacts each release.
   - Maintain control ownership and audit trails.

3. **Executive dashboard**
   - One view: security posture, reliability SLO, UX quality, AI eval health, release risk.

### Deliverables
- `governance/` policy rules
- `compliance/` evidence snapshots
- periodic maturity score updates

---

## 30-60-90 day practical roadmap

### First 30 days
- Canonical config + schema
- CI baseline
- Unit/integration smoke tests
- Observability MVP
- Incident runbook

### 60 days
- Security controls matrix
- Threat model complete
- A11y + Lighthouse CI
- Language preference persistence

### 90 days
- AI eval harness and policy gates
- Flutter production backend integration
- Quarterly governance dashboard + compliance evidence export

---

## Priority implementation backlog (high ROI)

1. Canonical config + generator scripts
2. CI pipeline with required checks
3. Worker/API integration tests
4. Logging/metrics/alerts
5. A11y and localization persistence
6. Security matrix and incident process
7. AI quality/safety eval framework

---

## Definition of Done for “10/10”

You are at 10/10 when:
- Every merge is policy-checked, tested, and traceable.
- Every deploy is observable, rollback-safe, and auditable.
- Security controls are measurable and mapped to frameworks.
- UX is accessible, fast, and localization-stable by design.
- AI behavior is evaluated, versioned, and governed.
- Documentation is operational, not aspirational.

---

## Suggested ownership model

- **Platform Owner:** CI/CD, environments, release safety
- **Security Owner:** controls, threat model, incident readiness
- **Product/UX Owner:** accessibility, localization, user trust
- **AI Owner:** evals, policy controls, model lifecycle
- **Ops Owner:** observability, SLOs, incident response

This keeps accountability clear and prevents “everyone owns it, so no one owns it” failure.

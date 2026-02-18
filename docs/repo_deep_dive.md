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

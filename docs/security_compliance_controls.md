# Security, SEO, and Compliance Controls

This document defines active controls and required controls for CSP, CORS, CORP, HSTS, SRI, and compliance mapping.

## HTTP Security Headers

- Content Security Policy (CSP): required and configured in `_headers`.
- Cross Origin Resource Sharing (CORS): configured in `_headers` and Worker CORS logic.
- Cross Origin Resource Policy (CORP): configured as `Cross-Origin-Resource-Policy`.
- X-Frame-Options: configured as `DENY`.
- X-Content-Type-Options: configured as `nosniff`.
- Strict Transport Security (HSTS): configured as `Strict-Transport-Security` with preload.
- Referrer Policy: configured as `Referrer-Policy: strict-origin-when-cross-origin`.

## Subresource Integrity (SRI)

- Local CSS and JavaScript assets in `index.html` use SRI `integrity` attributes.
- Any asset update requires hash regeneration before release.

## Tiny ML Security Controls

- Client Tiny ML: sanitize, scan, and integrity-checks user input before send.
- Gateway Tiny ML: sanitize, scan, and integrity-checks last user content and transcript payloads.
- Honeypot Tiny ML: evaluates pre-input and post-input honeypot traps; any signal blocks request.

## SEO + Google Search Console Controls

- Canonical URL and OpenGraph URL are set in `index.html`.
- Google Search Console domain validation should use DNS TXT records and ownership evidence.
- DNS health checks for `gabos.io` and `www.gabos.io` should be part of release gate.

## Compliance Mapping (NIST, CISA, PCI DSS, OWASP)

- NIST CSF: Identify, Protect, Detect, Respond, Recover lifecycle enforced through config governance and runbooks.
- CISA Cyber Essentials: MFA, patching, logging, vulnerability management, and incident readiness.
- PCI DSS: request logging, origin controls, security header enforcement, and change management evidence.
- OWASP: input validation, output safety, anti-automation controls, and secure headers baseline.

## Release Requirements

1. Run syntax + JSON validation checks.
2. Confirm security header policy in `_headers` and Worker responses.
3. Verify SRI hashes in `index.html` match current file contents.
4. Verify honeypot + Tiny ML blocking behavior in client and gateway.
5. Record DNS, SEO, and compliance evidence snapshot.

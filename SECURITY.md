# Security Policy

## Reporting a vulnerability

Report security vulnerabilities **privately** using
[GitHub security advisories](https://github.com/Siddhesh-ai-del/finbrief/security/advisories/new)
("Report a vulnerability"). This opens a private channel visible only to the
maintainer.

Please do **not** open a public issue for a vulnerability.

A useful report includes:

- The affected component and version (or commit)
- Steps to reproduce, or a proof of concept
- Impact assessment — especially anything touching user data, tenant
  isolation, or authentication
- Any suggested remediation, if you have one

You will receive an acknowledgement when the report is seen. Reports are
investigated as capacity allows; there is no bug bounty at this stage.

## Scope

In scope:

- Authentication, session handling, and tenant isolation
- The read-only bank-data pipeline: link tokens, stored credentials, sync
  workers, webhook validation
- Injection risks, including adversarial content arriving via transaction data
  (merchant names, memos) that reaches model prompts
- Exposure of financial or personal data in logs, traces, or error output
- Dependency vulnerabilities with a demonstrable path to impact

Out of scope:

- Reports requiring access to production systems or real user data
- Vulnerabilities in third-party services (Plaid, Stripe, Vercel, and others)
  that we only consume — report those upstream
- Social engineering, physical attacks, and denial-of-service research
- Automated scanner output without demonstrated impact

## User guarantees

The product's design commitments that security reports are judged against:

- **finbrief is read-only.** It is designed so that no code path can initiate
  a payment, transfer, or trade. A finding that can move money is critical.
- **Tenant isolation.** No user or organization may read another tenant's
  data under any request sequence.
- **No secrets in the repository or logs.** Credentials belong in environment
  variables or a secret manager; financial values must not reach unmasked
  logs or traces.

## Supported versions

This project is pre-release. There are no released versions to patch; security
fixes will land on `main` before the first release.

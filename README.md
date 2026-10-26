# finbrief

[![License](https://img.shields.io/badge/License-Apache_2.0-blue?style=for-the-badge&color=0F172A&labelColor=0F172A&logo=apache&logoColor=white)](LICENSE)
[![Build](https://img.shields.io/github/actions/workflow/status/Siddhesh-ai-del/finbrief/ci.yml?style=for-the-badge&color=0F172A&labelColor=0F172A&label=build&logo=githubactions&logoColor=white)](https://github.com/Siddhesh-ai-del/finbrief/actions/workflows/ci.yml)
[![Status](https://img.shields.io/badge/Status-pre--release-blue?style=for-the-badge&color=0F172A&labelColor=0F172A&logo=rocket&logoColor=white)](#project-status)
[![Platform](https://img.shields.io/badge/Platform-Web-blue?style=for-the-badge&color=0F172A&labelColor=0F172A&logo=vercel&logoColor=white)](#architecture)
[![Language](https://img.shields.io/badge/Language-TypeScript-blue?style=for-the-badge&color=0F172A&labelColor=0F172A&logo=typescript&logoColor=white)](#repository-layout)

**finbrief is a read-only personal-finance agent that delivers scheduled, source-linked briefings on where your money went — and whom you owe.**

## Overview

finbrief connects to bank accounts through read-only aggregation, organizes
transactions, maintains a debt/IOU ledger, and — on a cadence the user
chooses — delivers a briefing written by an agent. Every amount in a briefing
is computed by a tested aggregation function and cited back to the data it
came from. The product never moves money.

| Principle                      | What it means                                                                                                                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read-only by design            | Bank connections are read-only. finbrief can never initiate a payment, transfer, or trade.                                                                                                |
| No figure without a source     | Every rendered amount carries a `sourceRef` to its underlying data and an `as_of` timestamp. Figures are computed by code; the model only narrates.                                       |
| Workflows first, agents second | The core intents run as bounded, predefined pipelines. An open-ended tool loop is reserved for genuinely open questions — and is capped by step count, cost budget, and iteration limits. |
| Explain, not advise            | finbrief reports and explains. It does not recommend securities and does not claim to replace a financial professional.                                                                   |

## Why finbrief

The product was scoped from a documented research brief (October 2026). Its
motivating findings:

- **The scheduled briefing is an open position.** Consumer finance apps are
  dashboard-first with chat bolted on. The closest products to a proactive
  agent are event-driven (they reach out only on triggers) or are features of
  a general chatbot — not a recurring, user-scheduled briefing that keeps a
  persistent record.
- **Chat over your transactions is commoditized.** OpenAI made personal
  finance features in ChatGPT free for US Free/Go users on October 2, 2026
  ([OpenAI](https://openai.com/index/personal-finance-chatgpt/)). A product
  whose only job is answering money questions now competes with a free
  assistant. What remains defensible is initiative, cadence, memory of
  obligations, and an auditable ledger.
- **Informal debt has no home.** Incumbents track institutional debt (loans,
  cards). Money owed between people — IOUs, shared expenses, family loans —
  lives in utilities with no view of the rest of your finances.
- **Trust collapses when software acts.** Research collected for the brief
  shows consumers increasingly use AI for money decisions while confidence
  drops sharply when AI moves from recommending to acting. A read-only product
  whose job is to report sits on the safe side of that line.
- **Figures must be computed, not generated.** On finance benchmarks, agents
  writing free-form queries against realistic schemas perform far below their
  benchmark scores ([Spider 2.0](https://arxiv.org/abs/2411.07763)) and
  retrieval QA over finance documents is frequently wrong
  ([FinanceBench](https://arxiv.org/abs/2311.11944)). finbrief therefore
  gives the model fixed, tested aggregation tools instead of a query
  interface.

## Planned capabilities

> None of these are shipped yet. This repository currently contains project
> documentation only — the items below describe the planned v1 scope from the
> implementation plan.

- Read-only bank sync: Plaid Link, cursor-based transaction sync, webhook-driven updates
- Transaction categorization with a human-correction feedback loop
- Spend breakdowns — by merchant, by category, month over month — each figure carrying `as_of` and a source reference
- A debt/IOU ledger: counterparties stored as aliases, entries, settlements, and links to synced transactions
- Scheduled briefings: agent-written, on a user-chosen cadence, fail-closed (if any figure cannot be sourced, nothing is sent)
- Spending and connection-staleness alerts
- Question answering over the user's own data within a bounded, cost-capped tool loop
- Multi-account auth with organizations, and subscription billing with included agent-run credits
- An evaluation gate: golden datasets, exact-match checks on categories, and CI blocking on regressions

## Project status

**Pre-release.** No implementation code exists yet. All capabilities above
are planned; none are available for use. There are no releases, no install
instructions, and no CI badges — those appear only when the corresponding
work is real.

### Roadmap

| Phase | Scope                                                                                                                                                                             | Status  |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 0     | Test harness and coverage gate, multi-tenant skeleton (auth, organizations, billing), plus the non-engineering blockers (Plaid production access, legal review, security program) | Planned |
| 1     | Data core: Plaid Link, encrypted token storage, idempotent sync worker, webhook handling, adversarial input sanitization                                                          | Planned |
| 2     | Insight layer: fixed aggregation tools, freshness rules, first golden dataset                                                                                                     | Planned |
| 3     | Debt/IOU ledger with invariant property tests and transaction linking                                                                                                             | Planned |
| 4     | Agent + evaluation gate as one unit: structured-output source enforcement, bounded loop, prompt-injection suite, CI eval gate, trace masking                                      | Planned |
| 5     | Scheduled briefings: cron with jitter, fail-closed delivery, model routing and credit metering                                                                                    | Planned |
| 6     | Hardening and launch gates: end-to-end tests, security sweep, measured-economics re-run, blocker sign-off                                                                         | Planned |

## Installation

Not yet available. finbrief has no releases. This section will contain
installation instructions once a versioned release exists.

## Architecture

finbrief will be structured as a single TypeScript application with clearly
separated layers (future tense — none of this exists yet):

- **Next.js (App Router)** — web application and server-side API routes
- **PostgreSQL with Drizzle ORM** — tenant data, transactions, ledger entries,
  run-credit accounting; migrations tested in CI
- **Better Auth (organizations)** — accounts and tenant isolation, enforced by
  negative tests against cross-tenant access
- **Plaid (Transactions)** — read-only bank connectivity; encrypted
  credential storage; a cursor-based sync worker with idempotent replay
- **Vercel AI SDK** — a bounded tool-calling loop with explicit step and cost
  limits; structured output validated against schemas before any figure renders
- **Inngest** — durable scheduled runs: briefing cron with jitter, retries,
  and auto-pause on repeated failure
- **Langfuse** — trace capture with span-level masking so financial values
  never reach logs unmasked, plus evaluation runs in CI
- **Stripe** — subscriptions with included agent-run credits and top-up
  metering

## Repository layout

```
finbrief/
├── README.md
├── CHANGELOG.md
├── CONTRIBUTING.md
├── CODE_OF_CONDUCT.md
├── SECURITY.md
├── SUPPORT.md
├── LICENSE
├── package.json
├── drizzle.config.ts
├── vitest.config.ts
├── eslint.config.mjs
├── next.config.ts
├── docs/
│   ├── README.md
│   └── launch-blockers.md
├── src/
│   ├── app/             Next.js app shell
│   ├── auth/            Better Auth sessions + organizations
│   ├── billing/         Stripe webhook state machine + run-credit ledger
│   └── db/              schema/, migrations/, tenant-scoped helpers
├── tests/
│   ├── app/  auth/  billing/  db/  stack/
│   ├── helpers/         shared throwaway-database fixtures
│   └── harness.test.ts
└── .github/
    ├── workflows/ci.yml
    ├── CODEOWNERS
    ├── PULL_REQUEST_TEMPLATE.md
    └── ISSUE_TEMPLATE/
        ├── config.yml
        ├── bug_report.yml
        └── feature_request.yml
```

## Contributing

Contributions are welcome once implementation begins. See
[CONTRIBUTING.md](CONTRIBUTING.md) for bug reports, feature proposals, and
the test-driven development and coverage standards that apply to every change.
By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

Security issues are reported privately through
[GitHub security advisories](SECURITY.md). Please do not open public issues
for vulnerabilities.

## Support

See [SUPPORT.md](SUPPORT.md) for where to ask questions. No support SLA is
offered at this stage.

## License

This project is licensed under the [Apache License 2.0](LICENSE).

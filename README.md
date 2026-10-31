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

## What exists today

The domain and data layers are built and tested; the product surface is not.
The test suite is 356 tests across 36 files, gated at ≥80% line coverage in
CI (currently 100%).

**Shipped** (committed, CI-green):

- Tenancy by construction: PostgreSQL schema + Drizzle migrations, tenant-
  scoped query helpers, Better Auth sessions and organizations, with
  cross-tenant negative tests
- Stripe webhook state machine with exactly-once event handling and a
  run-credit ledger (test mode)
- Read-only Plaid connectivity: link_token lifecycle, public-token exchange,
  AES-256-GCM encrypted item storage, cursor-based `/transactions/sync`
  worker, webhook signature verification, item state machine, and
  unsubscribe as an `/item/remove` state machine
- Ingest sanitization: charset/length allowlists and a send-set reduction
  boundary that keeps Plaid ids and legal names out of model traffic
- Aggregation core: fixed money math in integer cents, `asOf` + `sourceRef`
  on every figure, posted-rows-only, one currency per figure
- Freshness rules: sync-age staleness detection and a prose tense gate
- Debt/IOU ledger: entries, partial settlements, idempotent writes,
  tombstones-never-deletes; ledger ↔ transaction linking with a human
  confirm gate; ledger insight tools on the figure contract
- Structured-output envelope: figures are `{ label, amountCents, sourceRef[] }`
  with an empty `sourceRef` as a typed hard failure; prose may only reference
  money through validated `{{fig:N}}` placeholders
- Categorization evaluation gate: golden dataset v0, exact-match metric,
  a deterministic no-LLM baseline at 0.9597 accuracy, and a blocking npm
  script — PR-blocking evals never call a model
- Agent workflows: the four intents (categorize, ledger entry, briefing
  draft, explain) as predefined code paths with programmatic tool
  selection — the model never picks a tool, a limit, or a figure; the
  explain workflow is the only bounded tool loop

**In progress (Phase 4.3–4.5):** the prompt-injection suite, the CI eval
gate for the AI categorizer, and trace masking.

**Not started:** the UI (only a placeholder page exists; the binding
UI/UX contract is in [docs/design-direction.md](docs/design-direction.md)),
scheduled briefing delivery (Phase 5), alerts, prompt-injection suite and
trace masking (Phase 4.3–4.5), and production Plaid/billing access (see
[docs/launch-blockers.md](docs/launch-blockers.md)).

## Project status

**Pre-release.** No versioned release exists and the product is not usable
end to end — there is no user-facing application yet. What the repository
contains is the tested backend substrate: data core (Phase 1), insight layer
(Phase 2), debt ledger (Phase 3), and the agent layer through the
structured-output envelope and workflow paths (Phase 4.1–4.2).

### Roadmap

| Phase | Scope                                                                                                                                                                             | Status      |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 0     | Test harness and coverage gate, multi-tenant skeleton (auth, organizations, billing), plus the non-engineering blockers (Plaid production access, legal review, security program) | Shipped\*   |
| 1     | Data core: Plaid Link, encrypted token storage, idempotent sync worker, webhook handling, adversarial input sanitization                                                          | Shipped     |
| 2     | Insight layer: fixed aggregation tools, freshness rules, first golden dataset                                                                                                     | Shipped     |
| 3     | Debt/IOU ledger with invariant property tests and transaction linking                                                                                                             | Shipped     |
| 4     | Agent + evaluation gate as one unit: structured-output source enforcement, bounded loop, prompt-injection suite, CI eval gate, trace masking                                      | In progress |
| 5     | Scheduled briefings: cron with jitter, fail-closed delivery, model routing and credit metering                                                                                    | Planned     |
| 6     | Hardening and launch gates: end-to-end tests, security sweep, measured-economics re-run, blocker sign-off                                                                         | Planned     |

\* Phase 0's engineering steps are shipped. Its non-engineering blockers
(Plaid Production access, counsel determination, security program) are open
and tracked in [docs/launch-blockers.md](docs/launch-blockers.md); they gate
launch, not development.

## Development

Requires Node.js ≥ 22 and Docker (tests start a throwaway
`postgres:17-alpine` container; set `TEST_DATABASE_URL` instead to use your
own Postgres, as CI does).

```sh
npm ci               # locked install
npm test             # full suite against a throwaway Postgres
npm run test:coverage
npm run dev          # Next.js dev server
```

Other scripts: `typecheck`, `lint`, `format`, `format:check`,
`db:generate` (Drizzle migrations), `db:migrate`, and
`eval:categorization` (the blocking categorization gate — threshold is
required, the script pins 0.9).

Environment variables (the app server; `.env` is gitignored):

| Variable                                | Purpose                                                             |
| --------------------------------------- | ------------------------------------------------------------------- |
| `DATABASE_URL`                          | PostgreSQL connection string                                        |
| `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` | Auth signing secret and base URL                                    |
| `ENCRYPTION_KEY`                        | Base64 32-byte root key for AES-256-GCM Plaid credential encryption |
| `PLAID_CLIENT_ID`, `PLAID_SECRET`       | Plaid API credentials                                               |
| `PLAID_ENV`                             | Plaid environment (`sandbox` / `production`)                        |

CI runs typecheck, lint, format check, the test suite with the coverage
gate, a production dependency audit, and a secret-pattern sweep on every
push and pull request.

## Architecture

finbrief is a single TypeScript application with clearly separated layers:

- **Next.js (App Router)** — web application and server-side API routes
  (`/api/plaid/link`, `/api/plaid/exchange`, `/api/plaid/webhook`)
- **PostgreSQL with Drizzle ORM** — tenant data, transactions, ledger
  entries, run-credit accounting; migrations tested in CI
- **Better Auth (organizations)** — accounts and tenant isolation, enforced
  by negative tests against cross-tenant access
- **Plaid (Transactions)** — read-only bank connectivity; AES-256-GCM
  encrypted credential storage with keyed (HMAC) equality indexes; a
  cursor-based sync worker with idempotent replay
- **Vercel AI SDK** — a structured-output envelope at every model boundary
  (zod-validated; no figure without a source tool call) and one bounded
  tool-calling loop for open questions, with explicit step limits
- **Stripe** — webhook state machine and run-credit ledger, running in
  test mode pending production terms
- **Inngest** and **Langfuse** — dependencies for durable scheduled runs and
  masked trace capture; wired in Phases 4.5 and 5, not yet active

## Repository layout

```
finbrief/
├── README.md  CHANGELOG.md  CONTRIBUTING.md  CODE_OF_CONDUCT.md
├── SECURITY.md  SUPPORT.md  LICENSE
├── package.json  drizzle.config.ts  vitest.config.ts
├── eslint.config.mjs  next.config.ts  tsconfig.json
├── docs/
│   ├── README.md              documentation index
│   ├── design-direction.md    binding UI/UX contract
│   └── launch-blockers.md     non-engineering launch checklist
├── evals/
│   ├── README.md              eval-gate policy and metric definitions
│   ├── categorization/        taxonomy, dataset loader, baseline categorizer
│   ├── datasets/              categorization-v0.jsonl (golden dataset)
│   └── run-categorization.ts  blocking gate entry point
├── src/
│   ├── app/                   Next.js shell + Plaid API routes
│   ├── agent/                 structured-output envelope + workflows
│   ├── auth/                  Better Auth sessions + organizations
│   ├── billing/               Stripe webhook machine, run credits, unsubscribe
│   ├── db/                    schema/, migrations/, tenancy helpers, pool
│   ├── insight/               aggregation core, freshness, ledger tools
│   ├── ledger/                debt/IOU entries + transaction linking
│   ├── plaid/                 link token, exchange, sync worker, webhooks
│   └── security/              untrusted-text sanitizer
├── tests/                     mirrors src/; fixtures/, helpers/, db setup
└── .github/
    ├── workflows/ci.yml
    ├── CODEOWNERS
    ├── PULL_REQUEST_TEMPLATE.md
    └── ISSUE_TEMPLATE/
```

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for bug
reports, feature proposals, and the test-driven development and coverage
standards that apply to every change. By participating you agree to the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Security

Security issues are reported privately through
[GitHub security advisories](SECURITY.md). Please do not open public issues
for vulnerabilities.

## Support

See [SUPPORT.md](SUPPORT.md) for where to ask questions. No support SLA is
offered at this stage.

## License

This project is licensed under the [Apache License 2.0](LICENSE).

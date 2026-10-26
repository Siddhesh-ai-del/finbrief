# Launch blockers (Phase 0, Step 0.5)

Every item below is **non-engineering**. None of them stop Phase 0–1
development — they gate Plaid Production access and launch sign-off, and all
have calendar latency, so they start **now**, in parallel with the build.
Numbering matches §6.4 of the research brief (October 2026) for traceability.

Status legend: `[ ]` not started · `[~]` in progress · `[x]` done.

## The checklist

### 1. Plaid Production: written pricing quote — `[ ]` · blocks: unit-cost model

Plaid's price list is not published (its billing docs geo-redirect), so the
largest uncaptured line in the unit-cost model stays open until Plaid quotes
it in writing during the Production access application.

- [ ] Production access application submitted from the Plaid dashboard
- [ ] Written price quote received for every product used (Transactions,
      Balance, Identity as scoped in the app) — attach to this repo's issue
      or internal drive, link it here
- [ ] Quote fed into the unit-cost model; margin assumptions re-checked

### 2. Counsel: GLBA "financial institution" / "significantly engaged" determination — `[ ]` · blocks: launch sign-off

A written determination under 16 CFR §314.2(h) on whether finbrief is
operating as a "financial institution" (and whether LLM processing makes it
"significantly engaged" in financial activities) decides the entire federal
privacy/security stack.

- [ ] Engagement letter signed with counsel
- [ ] Written determination received
- [ ] Determination mapped onto the control set (scopes item 6)

### 3. Plaid: written Permitted Use Case approval — `[ ]` · blocks: Production access

Contractually required (MSA §1.1, §1.7, Sch. 1 §1(b)) for the use case:
**LLM-based transaction categorization and user Q&A over personal financial
data**. Submit it as part of the same Production application as item 1, but
track it separately — pricing without approval still blocks.

- [ ] Use case described in the application (LLM categorization + Q&A, no
      training on customer data, no money movement)
- [ ] Plaid's **written** approval received (dashboard note or email — saved)

### 4. End-user consent copy covering the AI processor — `[ ]` · blocks: pre-launch

Plaid Sch. 1 §1(a)(c)(d) requires consent that expressly covers the AI
processor. Engineering is ready: the `consent_records` table (Step 0.2) stores
versioned grants/revocations per tenant and purpose.

- [ ] Consent copy drafted — names the AI processor, the purpose, retention,
      and revocation path, in plain language
- [ ] Counsel approval of the copy
- [ ] Version string pinned (e.g. `consent-v1`) and wired into the sign-up
      flow so every grant is written to `consent_records`

### 5. LLM vendor contract: training-off flow-down, DPA, subprocessors — `[ ]` · blocks: pre-launch

Plaid §1.5(iv) forbids vendors processing data for their own purposes, so the
LLM provider contract must pin training-off, DPA terms, subprocessors, and
retention windows.

- [ ] DPA executed with an explicit no-training-on-inputs commitment
- [ ] Subprocessor list reviewed and accepted
- [ ] Retention/deletion windows documented and configurable

### 6. Written Infosec Program (AICPA TSC) + cyber insurance — `[ ]` · blocks: pre-launch

Required commercially regardless of the GLBA determination (Plaid
Sch. 1 §2(b), §2(g)).

- [ ] Infosec Program documented against AICPA Trust Services Criteria —
      access control, encryption at rest/in transit, key management, logging
      and monitoring, change management, vendor management, incident response
- [ ] Policies approved by the owner
- [ ] Cyber insurance bound (certificate on file)

### 7. Breach runbook with both clocks — `[ ]` · blocks: pre-launch

Two independent clocks must be in the runbook: **Plaid notification ≤ 12h**
of detection (contract) and **FTC notification within 30 days** of discovery
where GLBA applies (≥500 consumers affected). The Plaid clock is strictly
tighter, so operations run on the 12h clock.

- [ ] Runbook drafted: detection → containment → scope → notification
      decision tree with both clocks and named on-call owners
- [ ] Tabletop exercise completed once before launch
- [ ] Contact tree verified (Plaid security contact, counsel, insurer)

## How this file is maintained

Update the status markers as items move; when an item completes, link its
evidence (quote, approval email, policy doc) next to the checkbox. This file
is the launch gate: **no public launch sign-off while any box above is
unchecked.** Engineering phases (0–6) continue regardless.

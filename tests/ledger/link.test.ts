/**
 * Step 3.2 — ledger ↔ transaction linking (plan Phase 3).
 *
 * Ties repayments to reality WITHOUT letting the model invent links:
 *
 * - **Deterministic matching rule.** A settlement entry matches a
 *   POSTED transaction with the SAME signed cents (Plaid: negative =
 *   inflow, which is exactly what a repayment that reduces "they owe
 *   me" looks like) within a config-driven date window (inclusive,
 *   both ends). The rule is code; the caller cannot relax it.
 * - **The model never confirms money facts.** proposeLink only ever
 *   writes status `proposed`; `confirmed` exists solely behind
 *   confirmLink(decidedBy), which requires a human actor id. Tests
 *   assert decidedAt stays null after proposing.
 * - **Ambiguity surfaces.** Two or more matches → ambiguous: true,
 *   both candidates offered, human picks; proposed links form a
 *   review queue (listLinks status=proposed).
 * - **No invented pairings.** proposeLink re-validates the rule
 *   itself (org scope, posted, amount equality, window) — a wrong
 *   amount/date/pending/other-org transaction throws and writes
 *   nothing.
 * - **One live link per entry, one live proof per transaction.**
 *   Partial unique indexes (status <> 'rejected') enforce it at the
 *   storage layer; rejection frees both sides for a fresh proposal.
 * - **Candidate names pass Step 1.5's sanitizer** — Plaid merchant
 *   text is untrusted (§3.8 send-set).
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createScratchDatabase } from "../helpers/scratch-db";
import { createDb, type Db } from "../../src/db/tenancy";
import {
  createCounterparty,
  recordDebt,
  recordSettlement,
  tombstoneEntry,
} from "../../src/ledger/entries";
import { LedgerLinkError, createLedgerLinker } from "../../src/ledger/link";

const DB = "finbrief_ledger_link_test";
const ORG = "org_link_1";
const OTHER_ORG = "org_link_2";

let scratch: Awaited<ReturnType<typeof createScratchDatabase>>;
let pool: Pool;
let db: Db;
let item: string;
let itemOtherOrg: string;

beforeAll(async () => {
  scratch = await createScratchDatabase(DB);
  await scratch.migrate();
  pool = scratch.pool;
  db = createDb(pool);
  for (const [id, slug] of [
    [ORG, "link-one"],
    [OTHER_ORG, "link-two"],
  ] as const) {
    await pool.query(
      `INSERT INTO organization (id, name, slug, created_at)
       VALUES ($1, $2, $3, now())`,
      [id, slug, slug],
    );
  }
}, 60_000);

afterAll(async () => {
  await scratch?.destroy();
});

beforeEach(async () => {
  await pool.query(
    "TRUNCATE ledger_entry_links, ledger_entries, ledger_counterparties, transactions, plaid_items CASCADE",
  );
  item = await insertItem(ORG, "t");
  itemOtherOrg = await insertItem(OTHER_ORG, "x");
});

async function insertItem(orgId: string, label: string): Promise<string> {
  const inserted = await pool.query(
    `INSERT INTO plaid_items
       (id, organization_id, item_id_ciphertext, access_token_ciphertext,
        item_id_index, status, created_at)
     VALUES (gen_random_uuid(), $1, 'ct', 'ct', $2, 'active', now())
     RETURNING id`,
    [orgId, `idx-${label}-${randomBytes(4).toString("hex")}`],
  );
  return (inserted.rows[0] as { id: string }).id;
}

interface TxnFixture {
  date: string;
  amount: number;
  name: string;
  pending?: boolean;
}

async function insertTxn(
  itemId: string,
  orgId: string,
  fixture: TxnFixture,
): Promise<string> {
  const inserted = await pool.query(
    `INSERT INTO transactions
       (id, organization_id, plaid_item_id, plaid_transaction_id, date,
        amount_cents, iso_currency_code, name, pending, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'USD', $6, $7,
             now(), now())
     RETURNING id`,
    [
      orgId,
      itemId,
      `plaid-txn-${randomBytes(4).toString("hex")}`,
      fixture.date,
      fixture.amount,
      fixture.name,
      fixture.pending ?? false,
    ],
  );
  return (inserted.rows[0] as { id: string }).id;
}

let counterpartySeq = 0;
/** Counterparty + signed debt + settlement (a repayment entry). */
async function mkSettlement(options: {
  debtCents: number;
  settleCents: number;
  settleDate: string;
  orgId?: string;
}): Promise<string> {
  counterpartySeq += 1;
  const orgId = options.orgId ?? ORG;
  const cp = await createCounterparty(db, orgId, {
    alias: `Friend ${counterpartySeq}-${randomBytes(3).toString("hex")}`,
  });
  await recordDebt(db, orgId, {
    counterpartyId: cp.id,
    amountCents: options.debtCents,
    entryDate: "2026-10-01",
    idempotencyKey: `d-${counterpartySeq}-${randomBytes(4).toString("hex")}`,
  });
  const settlement = await recordSettlement(db, orgId, {
    counterpartyId: cp.id,
    amountCents: options.settleCents,
    entryDate: options.settleDate,
    idempotencyKey: `s-${counterpartySeq}-${randomBytes(4).toString("hex")}`,
  });
  return settlement.id;
}

const linker = createLedgerLinker(); // defaults: window 3 days, maxRows 100

describe("findRepaymentCandidates — deterministic matching rule", () => {
  it("returns a unique posted match with the same signed cents", async () => {
    const entryId = await mkSettlement({
      debtCents: 5000,
      settleCents: -4000,
      settleDate: "2026-10-05",
    });
    const txnId = await insertTxn(item, ORG, {
      date: "2026-10-05",
      amount: -4000,
      name: "Zelle Transfer",
    });

    const result = await linker.findRepaymentCandidates(db, ORG, entryId);
    expect(result.ambiguous).toBe(false);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toEqual({
      transactionId: txnId,
      date: "2026-10-05",
      amountCents: -4000,
      name: "Zelle Transfer",
    });
  });

  it("marks two or more matches ambiguous and offers both", async () => {
    const entryId = await mkSettlement({
      debtCents: 5000,
      settleCents: -4000,
      settleDate: "2026-10-05",
    });
    const first = await insertTxn(item, ORG, {
      date: "2026-10-04",
      amount: -4000,
      name: "Venmo Cashout",
    });
    const second = await insertTxn(item, ORG, {
      date: "2026-10-06",
      amount: -4000,
      name: "Cash App",
    });

    const result = await linker.findRepaymentCandidates(db, ORG, entryId);
    expect(result.ambiguous).toBe(true);
    expect(result.candidates.map((c) => c.transactionId).sort()).toEqual(
      [first, second].sort(),
    );
  });

  it("returns no candidates when nothing matches", async () => {
    const entryId = await mkSettlement({
      debtCents: 5000,
      settleCents: -4000,
      settleDate: "2026-10-05",
    });
    await insertTxn(item, ORG, {
      date: "2026-10-05",
      amount: -4100, // wrong amount
      name: "Coffee",
    });

    const result = await linker.findRepaymentCandidates(db, ORG, entryId);
    expect(result.candidates).toHaveLength(0);
    expect(result.ambiguous).toBe(false);
  });

  it("never offers pending transactions — posted rows only", async () => {
    const entryId = await mkSettlement({
      debtCents: 5000,
      settleCents: -4000,
      settleDate: "2026-10-05",
    });
    await insertTxn(item, ORG, {
      date: "2026-10-05",
      amount: -4000,
      name: "Zelle Transfer",
      pending: true,
    });

    const result = await linker.findRepaymentCandidates(db, ORG, entryId);
    expect(result.candidates).toHaveLength(0);
  });

  it("treats the window edges as inclusive, config-driven", async () => {
    const entryId = await mkSettlement({
      debtCents: 5000,
      settleCents: -4000,
      settleDate: "2026-10-05",
    });
    await insertTxn(item, ORG, {
      date: "2026-10-02", // exactly 3 days before — inside
      amount: -4000,
      name: "Edge In",
    });
    await insertTxn(item, ORG, {
      date: "2026-10-08", // exactly 3 days after — inside
      amount: -4000,
      name: "Edge Out",
    });
    await insertTxn(item, ORG, {
      date: "2026-10-01", // 4 days before — outside
      amount: -4000,
      name: "Too Early",
    });

    const result = await linker.findRepaymentCandidates(db, ORG, entryId);
    expect(result.candidates.map((c) => c.name).sort()).toEqual([
      "Edge In",
      "Edge Out",
    ]);
  });

  it("respects a configured window and row cap", async () => {
    const strict = createLedgerLinker({ dateWindowDays: 0, maxRows: 1 });
    const entryId = await mkSettlement({
      debtCents: 5000,
      settleCents: -4000,
      settleDate: "2026-10-05",
    });
    await insertTxn(item, ORG, {
      date: "2026-10-04",
      amount: -4000,
      name: "Day Before", // outside a zero-day window
    });
    await insertTxn(item, ORG, {
      date: "2026-10-05",
      amount: -4000,
      name: "ZZZ Same Day", // in window, but the cap binds first
    });
    await insertTxn(item, ORG, {
      date: "2026-10-05",
      amount: -4000,
      name: "AAA Same Day", // in window, sorts first
    });

    const result = await strict.findRepaymentCandidates(db, ORG, entryId);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.name).toBe("AAA Same Day");
  });

  it("never crosses organizations — tenancy by construction", async () => {
    const entryId = await mkSettlement({
      debtCents: 5000,
      settleCents: -4000,
      settleDate: "2026-10-05",
    });
    await insertTxn(itemOtherOrg, OTHER_ORG, {
      date: "2026-10-05",
      amount: -4000,
      name: "Other Tenant",
    });

    const result = await linker.findRepaymentCandidates(db, ORG, entryId);
    expect(result.candidates).toHaveLength(0);
  });

  it("sanitizes candidate names — Plaid text is untrusted (§3.8)", async () => {
    const entryId = await mkSettlement({
      debtCents: 5000,
      settleCents: -4000,
      settleDate: "2026-10-05",
    });
    await insertTxn(item, ORG, {
      date: "2026-10-05",
      amount: -4000,
      name: "Zelle\u202eXfer\u200b  Attack",
    });
    await insertTxn(item, ORG, {
      date: "2026-10-04",
      amount: -4000,
      name: `${"a".repeat(300)} tail`,
    });

    const result = await linker.findRepaymentCandidates(db, ORG, entryId);
    const hostile = result.candidates.find((c) => c.name.startsWith("Zelle"));
    expect(hostile?.name).toBe("Zelle Xfer Attack");
    for (const candidate of result.candidates) {
      expect(candidate.name.length).toBeLessThanOrEqual(128);
    }
  });

  it("rejects unknown entries and non-settlement entries", async () => {
    let code = "";
    try {
      await linker.findRepaymentCandidates(db, ORG, "no-such-entry");
    } catch (error) {
      code = (error as LedgerLinkError).code ?? "";
    }
    expect(code).toBe("ENTRY_NOT_FOUND");

    const cp = await createCounterparty(db, ORG, { alias: "Debt Only" });
    const debt = await recordDebt(db, ORG, {
      counterpartyId: cp.id,
      amountCents: 1000,
      entryDate: "2026-10-01",
      idempotencyKey: `debt-${randomBytes(4).toString("hex")}`,
    });
    code = "";
    try {
      await linker.findRepaymentCandidates(db, ORG, debt.id);
    } catch (error) {
      code = (error as LedgerLinkError).code ?? "";
    }
    expect(code).toBe("NOT_A_REPAYMENT");
  });
});

describe("proposeLink — propose only, never confirm", () => {
  it("writes a proposed link and never a confirmed one", async () => {
    const entryId = await mkSettlement({
      debtCents: 5000,
      settleCents: -4000,
      settleDate: "2026-10-05",
    });
    const txnId = await insertTxn(item, ORG, {
      date: "2026-10-05",
      amount: -4000,
      name: "Zelle Transfer",
    });

    const link = await linker.proposeLink(db, ORG, {
      entryId,
      transactionId: txnId,
    });
    // The money-fact rule: proposing is NOT confirming.
    expect(link.status).toBe("proposed");
    expect(link.decidedAt).toBeNull();
    expect(link.decidedBy).toBeNull();
  });

  it("works for org-owes repayments too (signed symmetry)", async () => {
    // We owe 3000, we pay 1000 back → Plaid outflow +1000.
    const entryId = await mkSettlement({
      debtCents: -3000,
      settleCents: 1000,
      settleDate: "2026-10-05",
    });
    const txnId = await insertTxn(item, ORG, {
      date: "2026-10-05",
      amount: 1000,
      name: "Payment to Friend",
    });

    const link = await linker.proposeLink(db, ORG, {
      entryId,
      transactionId: txnId,
    });
    expect(link.transactionId).toBe(txnId);
    expect(link.status).toBe("proposed");
  });

  it("refuses pairings the model invented — the rule is re-validated", async () => {
    const entryId = await mkSettlement({
      debtCents: 5000,
      settleCents: -4000,
      settleDate: "2026-10-05",
    });

    const cases: Array<{ txn: TxnFixture; orgId?: string }> = [
      { txn: { date: "2026-10-05", amount: -9999, name: "Wrong Amount" } },
      { txn: { date: "2026-09-20", amount: -4000, name: "Wrong Date" } },
      {
        txn: {
          date: "2026-10-05",
          amount: -4000,
          name: "Pending",
          pending: true,
        },
      },
    ];
    for (const testCase of cases) {
      const txnId = await insertTxn(item, ORG, testCase.txn);
      let code = "";
      try {
        await linker.proposeLink(db, ORG, {
          entryId,
          transactionId: txnId,
        });
      } catch (error) {
        code = (error as LedgerLinkError).code ?? "";
      }
      expect(code).toBe("CANDIDATE_MISMATCH");
    }

    // Other org's transaction: not found here, nothing written.
    const foreign = await insertTxn(itemOtherOrg, OTHER_ORG, {
      date: "2026-10-05",
      amount: -4000,
      name: "Foreign",
    });
    let code = "";
    try {
      await linker.proposeLink(db, ORG, { entryId, transactionId: foreign });
    } catch (error) {
      code = (error as LedgerLinkError).code ?? "";
    }
    expect(code).toBe("TRANSACTION_NOT_FOUND");

    const links = await linker.listLinks(db, ORG, { limit: 50 });
    expect(links).toHaveLength(0);
  });

  it("rejects a second live link for the same entry", async () => {
    const entryId = await mkSettlement({
      debtCents: 5000,
      settleCents: -4000,
      settleDate: "2026-10-05",
    });
    const first = await insertTxn(item, ORG, {
      date: "2026-10-05",
      amount: -4000,
      name: "First",
    });
    const second = await insertTxn(item, ORG, {
      date: "2026-10-04",
      amount: -4000,
      name: "Second",
    });
    await linker.proposeLink(db, ORG, {
      entryId,
      transactionId: first,
    });

    let code = "";
    try {
      await linker.proposeLink(db, ORG, {
        entryId,
        transactionId: second,
      });
    } catch (error) {
      code = (error as LedgerLinkError).code ?? "";
    }
    expect(code).toBe("LINK_EXISTS");
  });

  it("refuses reusing one transaction as proof for two entries", async () => {
    const entryA = await mkSettlement({
      debtCents: 5000,
      settleCents: -4000,
      settleDate: "2026-10-05",
    });
    const entryB = await mkSettlement({
      debtCents: 5000,
      settleCents: -4000,
      settleDate: "2026-10-05",
    });
    const txnId = await insertTxn(item, ORG, {
      date: "2026-10-05",
      amount: -4000,
      name: "Shared Proof",
    });
    await linker.proposeLink(db, ORG, {
      entryId: entryA,
      transactionId: txnId,
    });

    let code = "";
    try {
      await linker.proposeLink(db, ORG, {
        entryId: entryB,
        transactionId: txnId,
      });
    } catch (error) {
      code = (error as LedgerLinkError).code ?? "";
    }
    expect(code).toBe("TRANSACTION_LINKED");
  });

  it("will not link a tombstoned repayment", async () => {
    const entryId = await mkSettlement({
      debtCents: 5000,
      settleCents: -4000,
      settleDate: "2026-10-05",
    });
    const txnId = await insertTxn(item, ORG, {
      date: "2026-10-05",
      amount: -4000,
      name: "Zelle",
    });
    await tombstoneEntry(db, ORG, entryId);

    let code = "";
    try {
      await linker.proposeLink(db, ORG, {
        entryId,
        transactionId: txnId,
      });
    } catch (error) {
      code = (error as LedgerLinkError).code ?? "";
    }
    expect(code).toBe("ENTRY_TOMBSTONED");
  });
});

describe("human decisions — confirm and reject", () => {
  async function proposed(): Promise<{ linkId: string; txnId: string }> {
    const entryId = await mkSettlement({
      debtCents: 5000,
      settleCents: -4000,
      settleDate: "2026-10-05",
    });
    const txnId = await insertTxn(item, ORG, {
      date: "2026-10-05",
      amount: -4000,
      name: "Zelle Transfer",
    });
    const link = await linker.proposeLink(db, ORG, {
      entryId,
      transactionId: txnId,
    });
    return { linkId: link.id, txnId };
  }

  it("confirms only with a human decider, recording who and when", async () => {
    const { linkId } = await proposed();
    const confirmed = await linker.confirmLink(db, ORG, linkId, {
      decidedBy: "user_human_1",
    });
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.decidedBy).toBe("user_human_1");
    expect(confirmed.decidedAt).not.toBeNull();

    // Idempotent — a second confirm changes nothing.
    const again = await linker.confirmLink(db, ORG, linkId, {
      decidedBy: "user_human_1",
    });
    expect(again.decidedAt).toEqual(confirmed.decidedAt);
  });

  it("rejects confirming without a decider or from rejected", async () => {
    const { linkId } = await proposed();
    let code = "";
    try {
      await linker.confirmLink(db, ORG, linkId, { decidedBy: "   " });
    } catch (error) {
      code = (error as LedgerLinkError).code ?? "";
    }
    expect(code).toBe("INVALID_DECIDER");

    await linker.rejectLink(db, ORG, linkId, { decidedBy: "user_human_1" });
    code = "";
    try {
      await linker.confirmLink(db, ORG, linkId, {
        decidedBy: "user_human_2",
      });
    } catch (error) {
      code = (error as LedgerLinkError).code ?? "";
    }
    expect(code).toBe("INVALID_TRANSITION");
    // Rejection stands — fresh proposal required to link again.
    const links = await linker.listLinks(db, ORG, { linkId });
    expect(links[0]?.status).toBe("rejected");
  });

  it("frees entry and proof on rejection — a fresh proposal works", async () => {
    const { linkId, txnId } = await proposed();
    await linker.rejectLink(db, ORG, linkId, { decidedBy: "user_human_1" });

    const entryId = (await linker.listLinks(db, ORG, { linkId }))[0]
      ?.entryId as string;
    const repl = await linker.proposeLink(db, ORG, {
      entryId,
      transactionId: txnId,
    });
    expect(repl.id).not.toBe(linkId);
    expect(repl.status).toBe("proposed");
  });

  it("lets a human reverse their own confirmation, but never silently", async () => {
    const { linkId } = await proposed();
    await linker.confirmLink(db, ORG, linkId, {
      decidedBy: "user_human_1",
    });
    const rejected = await linker.rejectLink(db, ORG, linkId, {
      decidedBy: "user_human_1",
    });
    expect(rejected.status).toBe("rejected");
    expect(rejected.decidedBy).toBe("user_human_1");

    // Confirming after rejection is refused — re-propose first.
    let code = "";
    try {
      await linker.confirmLink(db, ORG, linkId, {
        decidedBy: "user_human_1",
      });
    } catch (error) {
      code = (error as LedgerLinkError).code ?? "";
    }
    expect(code).toBe("INVALID_TRANSITION");
  });

  it("scopes decisions to the organization", async () => {
    const { linkId } = await proposed();
    let code = "";
    try {
      await linker.confirmLink(db, OTHER_ORG, linkId, {
        decidedBy: "user_evil",
      });
    } catch (error) {
      code = (error as LedgerLinkError).code ?? "";
    }
    expect(code).toBe("LINK_NOT_FOUND");
    const links = await linker.listLinks(db, ORG, { linkId });
    expect(links[0]?.status).toBe("proposed");
  });
});

describe("listLinks — the human review queue", () => {
  it("filters by status, caps rows, and never crosses tenants", async () => {
    const entryId = await mkSettlement({
      debtCents: 5000,
      settleCents: -4000,
      settleDate: "2026-10-05",
    });
    const txnId = await insertTxn(item, ORG, {
      date: "2026-10-05",
      amount: -4000,
      name: "Zelle Transfer",
    });
    const link = await linker.proposeLink(db, ORG, {
      entryId,
      transactionId: txnId,
    });
    await linker.confirmLink(db, ORG, link.id, {
      decidedBy: "user_human_1",
    });

    const proposedQueue = await linker.listLinks(db, ORG, {
      status: "proposed",
    });
    expect(proposedQueue).toHaveLength(0);
    const confirmed = await linker.listLinks(db, ORG, {
      status: "confirmed",
      limit: 1,
    });
    expect(confirmed).toHaveLength(1);
    const otherTenant = await linker.listLinks(db, OTHER_ORG, {});
    expect(otherTenant).toHaveLength(0);
  });
});

describe("config validation", () => {
  it("rejects nonsensical windows and caps at construction", () => {
    expect(() => createLedgerLinker({ dateWindowDays: -1 })).toThrow(
      LedgerLinkError,
    );
    expect(() => createLedgerLinker({ dateWindowDays: 1.5 })).toThrow(
      LedgerLinkError,
    );
    expect(() => createLedgerLinker({ maxRows: 0 })).toThrow(LedgerLinkError);
  });
});

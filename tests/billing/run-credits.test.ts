/**
 * Step 0.4 — run-credit ledger: grant / topUp / debit with the
 * "refuse when balance ≤ 0" rule from plan §6.3-13. Own scratch
 * database (parallel test files must not share tables).
 *
 * The suite runs sequentially and builds one account's history on
 * purpose: the ledger entries it accumulates are themselves asserted
 * (kind, amount, balance_after), so the accounting trail is checked
 * end to end rather than per call.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createScratchDatabase } from "../helpers/scratch-db";
import { createDb, type Db } from "../../src/db/tenancy";
import { debit, grantIncluded, topUp } from "../../src/billing/run-credits";

const DB = "finbrief_billing_credits_test";
const USER_ID = "user_credits";
const ORG_A = "org_credits_a";
const ORG_B = "org_credits_b";

let scratch: Awaited<ReturnType<typeof createScratchDatabase>>;
let db: Db;

interface EntryRow {
  kind: string;
  amount: number;
  balance_after: number;
}

const balanceOf = async (orgId: string): Promise<number | null> => {
  const res = await scratch.pool.query(
    `SELECT balance FROM run_credit_accounts WHERE organization_id = $1`,
    [orgId],
  );
  const row = res.rows[0] as { balance: number } | undefined;
  return row ? row.balance : null;
};

const entriesOf = async (orgId: string): Promise<EntryRow[]> => {
  const res = await scratch.pool.query(
    `SELECT kind, amount, balance_after FROM run_credit_entries
      WHERE organization_id = $1 ORDER BY created_at`,
    [orgId],
  );
  return res.rows as EntryRow[];
};

beforeAll(async () => {
  scratch = await createScratchDatabase(DB);
  await scratch.migrate();
  db = createDb(scratch.pool);
  const now = new Date().toISOString();
  await scratch.pool.query(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
     VALUES ($1, 'Ledger', 'ledger@example.com', true, $2, $2)`,
    [USER_ID, now],
  );
  await scratch.pool.query(
    `INSERT INTO organization (id, name, slug, created_at) VALUES
       ($1, 'Org A', 'credits-org-a', $2),
       ($3, 'Org B', 'credits-org-b', $2)`,
    [ORG_A, now, ORG_B],
  );
}, 60_000);

afterAll(async () => {
  await scratch?.destroy();
});

describe("run-credit ledger", () => {
  it("grantIncluded opens the account and records a grant entry", async () => {
    const balance = await grantIncluded(db, ORG_A, 100);
    expect(balance).toBe(100);
    expect(await balanceOf(ORG_A)).toBe(100);

    const entries = await entriesOf(ORG_A);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      kind: "grant",
      amount: 100,
      balance_after: 100,
    });
  });

  it("topUp adds to the existing balance with its own entry", async () => {
    const balance = await topUp(db, ORG_A, 25);
    expect(balance).toBe(125);
    expect(await balanceOf(ORG_A)).toBe(125);

    const entries = await entriesOf(ORG_A);
    expect(entries).toHaveLength(2);
    expect(entries[1]).toEqual({
      kind: "topup",
      amount: 25,
      balance_after: 125,
    });
  });

  it("debit spends credits and records the post-debit balance", async () => {
    const balance = await debit(db, ORG_A, 40);
    expect(balance).toBe(85);
    expect(await balanceOf(ORG_A)).toBe(85);

    const entries = await entriesOf(ORG_A);
    expect(entries).toHaveLength(3);
    expect(entries[2]).toEqual({
      kind: "debit",
      amount: 40,
      balance_after: 85,
    });
  });

  it("debit can spend the balance down to exactly zero", async () => {
    const balance = await debit(db, ORG_A, 85);
    expect(balance).toBe(0);
    expect(await balanceOf(ORG_A)).toBe(0);
  });

  it("debit refuses once the balance is empty, writing no entry", async () => {
    const before = await entriesOf(ORG_A);
    const result = await debit(db, ORG_A, 1);
    expect(result).toBeNull();
    expect(await balanceOf(ORG_A)).toBe(0);
    expect(await entriesOf(ORG_A)).toHaveLength(before.length);
  });

  it("topUp revives an empty balance", async () => {
    const balance = await topUp(db, ORG_A, 10);
    expect(balance).toBe(10);
    expect(await balanceOf(ORG_A)).toBe(10);
  });

  it("debit refuses for a tenant that has no credit account", async () => {
    const result = await debit(db, ORG_B, 5);
    expect(result).toBeNull();
    expect(await balanceOf(ORG_B)).toBeNull();
    expect(await entriesOf(ORG_B)).toHaveLength(0);
  });

  describe("amount validation (table-driven)", () => {
    const invalidAmounts = [0, -3, 2.5];
    const operations: [
      string,
      (orgId: string, amount: number) => Promise<unknown>,
    ][] = [
      ["topUp", (orgId, amount) => topUp(db, orgId, amount)],
      ["grantIncluded", (orgId, amount) => grantIncluded(db, orgId, amount)],
      ["debit", (orgId, amount) => debit(db, orgId, amount)],
    ];

    for (const amount of invalidAmounts) {
      for (const [name, op] of operations) {
        it(`${name} rejects ${amount} with a RangeError and leaves the balance untouched`, async () => {
          await expect(op(ORG_A, amount)).rejects.toThrow(RangeError);
          expect(await balanceOf(ORG_A)).toBe(10);
        });
      }
    }
  });

  it("keeps ledger rows strictly per tenant and self-consistent", async () => {
    const orgAEntries = await entriesOf(ORG_A);
    const orgBEntries = await entriesOf(ORG_B);

    expect(orgBEntries).toHaveLength(0);
    expect(orgAEntries.map((e) => e.balance_after)).toEqual([
      100, 125, 85, 0, 10,
    ]);

    // The newest entry's balance_after must equal the account balance —
    // the invariant every consumer relies on when reading the ledger.
    const newest = orgAEntries[orgAEntries.length - 1];
    expect(newest?.balance_after).toBe(await balanceOf(ORG_A));
  });
});

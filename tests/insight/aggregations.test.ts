/**
 * Step 2.1 — aggregation core (plan Phase 2: "fixed aggregations,
 * `as_of` everywhere").
 *
 * The model narrates; it never computes money (§6.2-6/7 — Spider 2.0
 * and FinanceBench). These functions are the only place money math
 * happens, pinned here over seeded fixtures:
 *
 * - **Shape**: every result is `{ values[], asOf, currency, sourceRef[] }`
 *   and frozen. sourceRef carries ONLY our surrogate row ids (the
 *   §3.8 send-set rule from Step 1.5 — no Plaid ids), a capped id
 *   list, and the EXACT rowCount behind the figure.
 * - **Spend = posted outflows only**: `pending` rows are excluded
 *   everywhere (a pending row and its posted replacement would
 *   double-count), inflows never count as spend.
 * - **Scope**: organization_id in WHERE (tenancy by construction);
 *   rows owned by `removed` items are excluded (unsubscribe, Step
 *   1.6); rows owned by `stale` items stay — history is still true.
 * - **Row caps enforced here, not in the prompt**: config-driven
 *   maxRows (default 100, plan Open Q15).
 * - **Currency**: one currency per result. A window spanning two
 *   currency codes throws — summing across currencies would invent
 *   money. All-null codes → currency null.
 * - **Labels are counterparty-controlled**: merchant/category labels
 *   pass through Step 1.5's sanitizer before leaving this module —
 *   they are tool output bound for a prompt.
 * - **monthOverMonth** computes delta in integer cents and basis
 *   points (null when the previous month is zero — no infinity).
 * - **balanceAsOf** is the net position (inflows − outflows) from
 *   synced transactions up to and including the date, NOT a
 *   bank-reported balance; asOf is the requested date itself.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createScratchDatabase } from "../helpers/scratch-db";
import { createDb, type Db } from "../../src/db/tenancy";
import {
  AggregationConfigError,
  AggregationQueryError,
  DEFAULT_MAX_ROWS,
  createAggregations,
} from "../../src/insight/aggregations";

const DB = "finbrief_aggregations_test";
const MAIN_ORG = "org_agg_main";
const OTHER_ORG = "org_agg_other";
const MULTI_ORG = "org_agg_multi";

let scratch: Awaited<ReturnType<typeof createScratchDatabase>>;
let pool: Pool;
let db: Db;
let itemA: string;
let itemB: string;
let itemC: string;
let itemD: string;
let itemMulti: string;

async function insertItem(
  orgId: string,
  label: string,
  status = "active",
): Promise<string> {
  const inserted = await pool.query(
    `INSERT INTO plaid_items
       (id, organization_id, item_id_ciphertext, access_token_ciphertext,
        item_id_index, status, created_at)
     VALUES (gen_random_uuid(), $1, 'ct', 'ct', $2, $3, now())
     RETURNING id`,
    [orgId, `idx-${label}-${randomBytes(4).toString("hex")}`, status],
  );
  return (inserted.rows[0] as { id: string }).id;
}

interface TxnFixture {
  date: string;
  amount: number;
  name: string;
  merchant?: string | null;
  pfc?: string | null;
  currency?: string | null;
  pending?: boolean;
}

async function insertTxn(itemId: string, orgId: string, f: TxnFixture) {
  await pool.query(
    `INSERT INTO transactions
       (id, organization_id, plaid_item_id, plaid_transaction_id, date,
        amount_cents, iso_currency_code, name, merchant_name,
        personal_finance_category_primary, pending, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
             now(), now())`,
    [
      orgId,
      itemId,
      `plaid-txn-${randomBytes(4).toString("hex")}`,
      f.date,
      f.amount,
      f.currency === undefined ? "USD" : f.currency,
      f.name,
      f.merchant ?? null,
      f.pfc ?? null,
      f.pending ?? false,
    ],
  );
}

beforeAll(async () => {
  scratch = await createScratchDatabase(DB);
  await scratch.migrate();
  pool = scratch.pool;
  db = createDb(pool);
  for (const [id, slug] of [
    [MAIN_ORG, "main"],
    [OTHER_ORG, "other"],
    [MULTI_ORG, "multi"],
  ] as const) {
    await pool.query(
      `INSERT INTO organization (id, name, slug, created_at)
       VALUES ($1, $2, $3, now())`,
      [id, slug, `${slug}-org`],
    );
  }
  itemA = await insertItem(MAIN_ORG, "a");
  itemB = await insertItem(MAIN_ORG, "b-stale", "stale");
  itemC = await insertItem(MAIN_ORG, "c-removed", "removed");
  itemD = await insertItem(OTHER_ORG, "d");
  itemMulti = await insertItem(MULTI_ORG, "m");
}, 60_000);

afterAll(async () => {
  await scratch?.destroy();
});

beforeEach(async () => {
  await pool.query("TRUNCATE transactions");
});

/**
 * Fixture ledger (all MAIN_ORG unless noted):
 *  t1  A  2026-09-05  +5000  STARBUCKS        Food and Drink
 *  t2  A  2026-09-10  +3000  STARBUCKS        Food and Drink
 *  t3  A  2026-09-15  -20000 ACME PAYROLL     Salary          (inflow)
 *  t4  A  2026-08-20  +7000  AMAZON           Shops
 *  t5  A  2026-09-12  +1234  "EVIL\u202eSHOP"  Shops           (hostile bidi)
 *  t6  A  2026-09-13  +9999  PENDING MERCHANT Shops           (pending)
 *  t7  A  2026-07-01  +4000  (fallback name)  null
 *  t8  B  2026-09-08  +6000  STALE MERCHANT   Shops           (stale item)
 *  t9  C  2026-09-09  +8000  REMOVED MERCHANT Shops           (removed item)
 *  t10 D  2026-09-01  +55555 OTHER MERCHANT   Shops           (other org)
 *  t11 A  2026-09-20  +100   (unlabelable)    null
 */
async function seedFixtures(): Promise<void> {
  await insertTxn(itemA, MAIN_ORG, {
    date: "2026-09-05",
    amount: 5000,
    name: "STARBUCKS 123 MAIN",
    merchant: "STARBUCKS",
    pfc: "Food and Drink",
  });
  await insertTxn(itemA, MAIN_ORG, {
    date: "2026-09-10",
    amount: 3000,
    name: "STARBUCKS 456 OAK",
    merchant: "STARBUCKS",
    pfc: "Food and Drink",
  });
  await insertTxn(itemA, MAIN_ORG, {
    date: "2026-09-15",
    amount: -20000,
    name: "ACME PAYROLL",
    pfc: "Salary",
  });
  await insertTxn(itemA, MAIN_ORG, {
    date: "2026-08-20",
    amount: 7000,
    name: "AMAZON.COM",
    merchant: "AMAZON",
    pfc: "Shops",
  });
  await insertTxn(itemA, MAIN_ORG, {
    date: "2026-09-12",
    amount: 1234,
    name: "EVIL SHOP",
    merchant: "EVIL\u202eSHOP",
    pfc: "Shops",
  });
  await insertTxn(itemA, MAIN_ORG, {
    date: "2026-09-13",
    amount: 9999,
    name: "PENDING MERCHANT",
    merchant: "PENDING MERCHANT",
    pfc: "Shops",
    pending: true,
  });
  await insertTxn(itemA, MAIN_ORG, {
    date: "2026-07-01",
    amount: 4000,
    name: "OLD COFFEE",
  });
  await insertTxn(itemB, MAIN_ORG, {
    date: "2026-09-08",
    amount: 6000,
    name: "STALE MERCHANT",
    merchant: "STALE MERCHANT",
    pfc: "Shops",
  });
  await insertTxn(itemC, MAIN_ORG, {
    date: "2026-09-09",
    amount: 8000,
    name: "REMOVED MERCHANT",
    merchant: "REMOVED MERCHANT",
    pfc: "Shops",
  });
  await insertTxn(itemD, OTHER_ORG, {
    date: "2026-09-01",
    amount: 55555,
    name: "OTHER MERCHANT",
    merchant: "OTHER MERCHANT",
    pfc: "Shops",
  });
  await insertTxn(itemA, MAIN_ORG, {
    date: "2026-09-20",
    amount: 100,
    name: "\u0007\u0007",
  });
}

const SEPT = { fromDate: "2026-09-01", toDate: "2026-09-30" };

describe("createAggregations config", () => {
  it("rejects a non-positive or fractional row cap", () => {
    for (const maxRows of [0, -1, 2.5]) {
      expect(() => createAggregations({ maxRows })).toThrow(
        AggregationConfigError,
      );
    }
  });

  it("defaults to the plan's 100-row cap", () => {
    expect(DEFAULT_MAX_ROWS).toBe(100);
  });
});

describe("spendByMerchant", () => {
  it("sums posted outflows only, ordered by total desc, labels sanitized", async () => {
    await seedFixtures();
    const result = await createAggregations().spendByMerchant(
      db,
      MAIN_ORG,
      SEPT,
    );

    // Pending t6, inflow t3, removed-item t9, other-org t10 excluded;
    // stale-item t8 included; bidi-override merchant sanitized; blank
    // name → "(unknown)".
    expect(result.values).toEqual([
      { merchant: "STARBUCKS", totalCents: 8000, txnCount: 2 },
      { merchant: "STALE MERCHANT", totalCents: 6000, txnCount: 1 },
      { merchant: "EVIL SHOP", totalCents: 1234, txnCount: 1 },
      { merchant: "(unknown)", totalCents: 100, txnCount: 1 },
    ]);
    expect(result.currency).toBe("USD");
    expect(result.asOf).toBeInstanceOf(Date);
  });

  it("falls back to the raw name when merchant_name is null", async () => {
    await seedFixtures();
    const result = await createAggregations().spendByMerchant(db, MAIN_ORG, {
      fromDate: "2026-07-01",
      toDate: "2026-07-31",
    });
    expect(result.values).toEqual([
      { merchant: "OLD COFFEE", totalCents: 4000, txnCount: 1 },
    ]);
  });

  it("enforces the config row cap over groups, but reports exact rowCount", async () => {
    await seedFixtures();
    const result = await createAggregations({ maxRows: 2 }).spendByMerchant(
      db,
      MAIN_ORG,
      SEPT,
    );
    expect(result.values).toHaveLength(2);
    expect(result.values[0]?.merchant).toBe("STARBUCKS");
    // sourceRef counts ALL window rows (4 groups' rows = 5 posted
    // non-removed Sept rows: t1 t2 t3 t5 t8 t11 — inflows included in
    // provenance) but caps the id list at maxRows.
    const ref = result.sourceRef[0];
    expect(ref?.rowCount).toBe(6);
    expect(ref?.transactionIds).toHaveLength(2);
  });

  it("never leaks Plaid ids — only our surrogate UUIDs", async () => {
    await seedFixtures();
    const result = await createAggregations().spendByMerchant(
      db,
      MAIN_ORG,
      SEPT,
    );
    for (const id of result.sourceRef[0]?.transactionIds ?? []) {
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }
    expect(JSON.stringify(result)).not.toContain("plaid-txn-");
  });

  it("scopes strictly to the organization", async () => {
    await seedFixtures();
    const result = await createAggregations().spendByMerchant(
      db,
      OTHER_ORG,
      SEPT,
    );
    expect(result.values).toEqual([
      { merchant: "OTHER MERCHANT", totalCents: 55555, txnCount: 1 },
    ]);
  });

  it("returns a frozen, empty result for a window with no rows", async () => {
    const result = await createAggregations().spendByMerchant(db, MAIN_ORG, {
      fromDate: "2020-01-01",
      toDate: "2020-01-31",
    });
    expect(result.values).toEqual([]);
    expect(result.currency).toBeNull();
    expect(result.sourceRef[0]?.rowCount).toBe(0);
    expect(result.asOf).toBeInstanceOf(Date);
  });
});

describe("spendByCategory", () => {
  it("groups by Plaid primary category; null → Uncategorized", async () => {
    await seedFixtures();
    const result = await createAggregations().spendByCategory(
      db,
      MAIN_ORG,
      SEPT,
    );
    expect(result.values).toEqual([
      { category: "Food and Drink", totalCents: 8000, txnCount: 2 },
      { category: "Shops", totalCents: 7234, txnCount: 2 },
      { category: "Uncategorized", totalCents: 100, txnCount: 1 },
    ]);
  });
});

describe("monthOverMonth", () => {
  it("computes the pair, delta in cents and basis points", async () => {
    await seedFixtures();
    const result = await createAggregations().monthOverMonth(
      db,
      MAIN_ORG,
      "2026-09",
    );
    // Sept spend 15334 vs Aug 7000 → +8334 cents = +11906 bps.
    expect(result.values).toEqual([
      {
        month: "2026-09",
        previousMonth: "2026-08",
        spendCents: 15334,
        previousSpendCents: 7000,
        deltaCents: 8334,
        deltaBps: 11906,
      },
    ]);
    expect(result.currency).toBe("USD");
    expect(result.sourceRef[0]?.fromDate).toBe("2026-09-01");
    expect(result.sourceRef[0]?.toDate).toBe("2026-09-30");
  });

  it("handles the year boundary and a zero previous month (bps null)", async () => {
    await seedFixtures();
    const result = await createAggregations().monthOverMonth(
      db,
      MAIN_ORG,
      "2026-01",
    );
    expect(result.values).toEqual([
      {
        month: "2026-01",
        previousMonth: "2025-12",
        spendCents: 0,
        previousSpendCents: 0,
        deltaCents: 0,
        deltaBps: null,
      },
    ]);
  });

  it("defaults the month from the injected clock", async () => {
    await seedFixtures();
    const agg = createAggregations({
      now: () => new Date("2026-09-20T12:00:00Z"),
    });
    const result = await agg.monthOverMonth(db, MAIN_ORG);
    expect(result.values[0]?.month).toBe("2026-09");
    expect(result.asOf).toEqual(new Date("2026-09-20T12:00:00Z"));
  });
});

describe("balanceAsOf", () => {
  it("returns the net position through the date, inclusive", async () => {
    await seedFixtures();
    const result = await createAggregations().balanceAsOf(
      db,
      MAIN_ORG,
      "2026-09-30",
    );
    // All posted non-removed rows ≤ Sept 30: net = -6334 cents.
    expect(result.values).toEqual([{ date: "2026-09-30", netCents: -6334 }]);
    expect(result.asOf).toEqual(new Date("2026-09-30T00:00:00.000Z"));
  });

  it("returns zero (not an error) before any data exists", async () => {
    await seedFixtures();
    const result = await createAggregations().balanceAsOf(
      db,
      MAIN_ORG,
      "2026-06-30",
    );
    expect(result.values).toEqual([{ date: "2026-06-30", netCents: 0 }]);
    expect(result.sourceRef[0]?.rowCount).toBe(0);
  });
});

describe("validation and cross-cutting rules", () => {
  it("rejects malformed or inverted date windows without echoing values", async () => {
    const agg = createAggregations();
    for (const window of [
      { fromDate: "2026/09/01" },
      { toDate: "not-a-date" },
      { fromDate: "2026-09-30", toDate: "2026-09-01" },
    ]) {
      await expect(agg.spendByMerchant(db, MAIN_ORG, window)).rejects.toThrow(
        AggregationQueryError,
      );
    }
    let message = "";
    try {
      await agg.spendByMerchant(db, MAIN_ORG, { fromDate: "DROP TABLE x" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain("DROP TABLE");
  });

  it("rejects malformed months", async () => {
    for (const month of ["2026-13", "september", "2026"]) {
      await expect(
        createAggregations().monthOverMonth(db, MAIN_ORG, month),
      ).rejects.toThrow(AggregationQueryError);
    }
  });

  it("refuses to sum across currencies", async () => {
    await insertTxn(itemMulti, MULTI_ORG, {
      date: "2026-09-01",
      amount: 500,
      name: "USD SHOP",
      merchant: "USD SHOP",
    });
    await insertTxn(itemMulti, MULTI_ORG, {
      date: "2026-09-02",
      amount: 300,
      name: "EUR SHOP",
      merchant: "EUR SHOP",
      currency: "EUR",
    });
    await expect(
      createAggregations().spendByMerchant(db, MULTI_ORG, SEPT),
    ).rejects.toThrow(AggregationQueryError);
    await expect(
      createAggregations().balanceAsOf(db, MULTI_ORG, "2026-09-30"),
    ).rejects.toThrow(AggregationQueryError);
  });

  it("returns frozen results all the way down", async () => {
    await seedFixtures();
    const result = await createAggregations().spendByMerchant(
      db,
      MAIN_ORG,
      SEPT,
    );
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.values)).toBe(true);
    expect(Object.isFrozen(result.values[0])).toBe(true);
    expect(Object.isFrozen(result.sourceRef)).toBe(true);
  });
});

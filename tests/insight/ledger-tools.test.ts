/**
 * Step 3.3 — ledger aggregation tools (plan Phase 3).
 *
 * Same figure contract as Step 2.1, provenance pointing at the LEDGER:
 * frozen `{ values[], asOf, currency, sourceRef[] }`, `asOf` from the
 * injected clock, `sourceRef` = surrogate entry ids only (§3.8), id
 * list capped at maxRows with the EXACT rowCount behind it. `currency`
 * is null by construction: manually-recorded obligations carry no ISO
 * code, and inventing one would be a money fiction — Phase 4 must not
 * narrate a unit the data never had.
 *
 * - **whoOwesWhat**: net position per live counterparty (signed cents),
 *   non-zero only — a fully-settled counterparty disappears. Largest
 *   exposure first, row-capped (the model never picks a LIMIT).
 * - **settlementHistory**: live settlement entries only (debts and
 *   tombstoned rows excluded), chronological, optional counterparty
 *   and inclusive date-window filters (validated field-only).
 * - **debtPayoffProjection**: fixed amortization math computed IN
 *   CODE (§6.2-6/7 — the model never divides money): per-period
 *   interest = round(balance * aprBps/120000), payment clamped so the
 *   closing balance lands on exactly zero, summary carries signed
 *   opening balance (direction), total months, total paid. aprBps and
 *   maxMonths are CONSTRUCTION-time policy — a caller cannot set the
 *   rate; a payment that never clears the interest is a typed error;
 *   a schedule past maxMonths is a typed error.
 *
 * Errors name fields, never values (Steps 1.2/1.5).
 */
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
import {
  LedgerToolConfigError,
  LedgerToolQueryError,
  createLedgerTools,
} from "../../src/insight/ledger-tools";

const DB = "finbrief_ledger_tools_test";
const ORG = "org_ltools_1";
const OTHER_ORG = "org_ltools_2";
const FIXED_NOW = new Date("2026-10-20T12:00:00.000Z");

let scratch: Awaited<ReturnType<typeof createScratchDatabase>>;
let pool: Pool;
let db: Db;

beforeAll(async () => {
  scratch = await createScratchDatabase(DB);
  await scratch.migrate();
  pool = scratch.pool;
  db = createDb(pool);
  for (const [id, slug] of [
    [ORG, "ltools-one"],
    [OTHER_ORG, "ltools-two"],
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
    "TRUNCATE ledger_entry_links, ledger_entries, ledger_counterparties CASCADE",
  );
});

let seq = 0;
async function mkCounterparty(alias: string, orgId = ORG): Promise<string> {
  seq += 1;
  const cp = await createCounterparty(db, orgId, { alias });
  return cp.id;
}

async function addDebt(
  counterpartyId: string,
  amountCents: number,
  entryDate: string,
  orgId = ORG,
): Promise<string> {
  seq += 1;
  const entry = await recordDebt(db, orgId, {
    counterpartyId,
    amountCents,
    entryDate,
    idempotencyKey: `lt-d-${seq}`,
  });
  return entry.id;
}

async function addSettlement(
  counterpartyId: string,
  amountCents: number,
  entryDate: string,
  orgId = ORG,
): Promise<string> {
  seq += 1;
  const entry = await recordSettlement(db, orgId, {
    counterpartyId,
    amountCents,
    entryDate,
    idempotencyKey: `lt-s-${seq}`,
  });
  return entry.id;
}

/** Alex owes 50; Bea is owed 30 (we owe Bea); Cy settled to zero. */
async function seedBalances(): Promise<{ alexDebt: string; beaDebt: string }> {
  const alex = await mkCounterparty("Alex");
  const alexDebt = await addDebt(alex, 5000, "2026-10-01");
  const bea = await mkCounterparty("Bea");
  const beaDebt = await addDebt(bea, -3000, "2026-10-02");
  const cy = await mkCounterparty("Cy");
  await addDebt(cy, 2000, "2026-10-03");
  await addSettlement(cy, -2000, "2026-10-04");
  return { alexDebt, beaDebt };
}

describe("whoOwesWhat", () => {
  it("returns signed non-zero positions, largest exposure first, settled gone", async () => {
    await seedBalances();
    const tools = createLedgerTools({ now: () => FIXED_NOW });
    const figure = await tools.whoOwesWhat(db, ORG);

    expect(figure.values).toEqual([
      { counterpartyId: expect.any(String), alias: "Alex", balanceCents: 5000 },
      { counterpartyId: expect.any(String), alias: "Bea", balanceCents: -3000 },
    ]);
    // Cy settled to zero and disappears — "who owes what" is about
    // open positions, not history.
    expect(figure.values.map((v) => v.alias)).not.toContain("Cy");
  });

  it("honors the figure contract: frozen, stamped asOf, ledger sourceRef", async () => {
    const seeded = await seedBalances();
    const tools = createLedgerTools({ now: () => FIXED_NOW });
    const figure = await tools.whoOwesWhat(db, ORG);

    expect(figure.asOf).toBe(FIXED_NOW);
    // Ledger rows carry no ISO code — null, never invented (§6.2).
    expect(figure.currency).toBeNull();
    expect(Object.isFrozen(figure)).toBe(true);
    expect(Object.isFrozen(figure.values)).toBe(true);
    expect(Object.isFrozen(figure.values[0])).toBe(true);
    expect(Object.isFrozen(figure.sourceRef)).toBe(true);

    const source = figure.sourceRef[0];
    expect(source?.kind).toBe("ledger_entry");
    // Surrogate ENTRY ids only (never counterparty ids, never any
    // external id), exact count behind the shown positions: Alex's
    // debt + Bea's debt — Cy's settled entries back no shown row.
    expect([...(source?.entryIds ?? [])].sort()).toEqual(
      [seeded.alexDebt, seeded.beaDebt].sort(),
    );
    expect(source?.rowCount).toBe(2);
    expect(Object.isFrozen(source?.entryIds)).toBe(true);
    expect(source?.fromDate).toBeNull();
    expect(source?.toDate).toBeNull();
  });

  it("caps the id list but keeps the exact rowCount (2.1 discipline)", async () => {
    // Bea: two debts netting 14000; Alex: three entries netting 5000.
    const bea = await mkCounterparty("Bea");
    await addDebt(bea, 10000, "2026-10-01");
    await addDebt(bea, 4000, "2026-10-02");
    const alex = await mkCounterparty("Alex");
    await addDebt(alex, 10000, "2026-10-03");
    await addDebt(alex, 5000, "2026-10-04");
    await addSettlement(alex, -10000, "2026-10-05"); // net 5000

    const tools = createLedgerTools({ maxRows: 1, now: () => FIXED_NOW });
    const figure = await tools.whoOwesWhat(db, ORG);

    // Values capped at 1: the largest exposure only (Bea, 14000).
    expect(figure.values).toHaveLength(1);
    expect(figure.values[0]?.alias).toBe("Bea");
    const source = figure.sourceRef[0];
    // Bea's two entries: id list capped at maxRows=1, count exact.
    expect(source?.entryIds).toHaveLength(1);
    expect(source?.rowCount).toBe(2);
  });

  it("sanitizes aliases at the build point (send-set defense)", async () => {
    // Hostile AT REST — raw SQL bypasses createCounterparty's
    // sanitizer, as a corrupt upstream write would; the tool must
    // still refuse to emit it.
    seq += 1;
    const cpId = `cp-hostile-${seq}`;
    await pool.query(
      `INSERT INTO ledger_counterparties (id, organization_id, alias, created_at)
       VALUES ($1, $2, $3, now())`,
      [cpId, ORG, "R\u202eival\u200b  Crew"],
    );
    await addDebt(cpId, 1500, "2026-10-01");
    const tools = createLedgerTools({ now: () => FIXED_NOW });
    const figure = await tools.whoOwesWhat(db, ORG);
    // The bidi override becomes a space at the replacement position —
    // sanitized output, not the bytes that were stored.
    expect(figure.values[0]?.alias).toBe("R ival Crew");
  });

  it("never crosses organizations and can return an empty figure", async () => {
    const foreign = await mkCounterparty("Foreigner", OTHER_ORG);
    await addDebt(foreign, 9999, "2026-10-01", OTHER_ORG);
    const tools = createLedgerTools({ now: () => FIXED_NOW });

    const mine = await tools.whoOwesWhat(db, ORG);
    expect(mine.values).toHaveLength(0);
    expect(mine.sourceRef[0]?.rowCount).toBe(0);

    const theirs = await tools.whoOwesWhat(db, OTHER_ORG);
    expect(theirs.values).toHaveLength(1);
    expect(theirs.values[0]?.balanceCents).toBe(9999);
  });
});

describe("settlementHistory", () => {
  it("lists live settlements chronologically, excluding debts", async () => {
    const cp = await mkCounterparty("Dana");
    await addDebt(cp, 10000, "2026-10-01");
    await addSettlement(cp, -4000, "2026-10-09");
    await addSettlement(cp, -6000, "2026-10-15");
    const debtId = (
      await pool.query(
        "SELECT id FROM ledger_entries WHERE kind = 'debt' LIMIT 1",
      )
    ).rows[0] as { id: string };

    const tools = createLedgerTools({ now: () => FIXED_NOW });
    const figure = await tools.settlementHistory(db, ORG, {
      counterpartyId: cp,
    });

    expect(figure.values.map((v) => v.entryDate)).toEqual([
      "2026-10-09",
      "2026-10-15",
    ]);
    expect(figure.values.map((v) => v.amountCents)).toEqual([-4000, -6000]);
    expect(figure.values.map((v) => v.entryId)).not.toContain(debtId.id);
    expect(figure.values[0]?.alias).toBe("Dana");
    expect(figure.asOf).toBe(FIXED_NOW);
    expect(figure.currency).toBeNull();
    expect(figure.sourceRef[0]?.kind).toBe("ledger_entry");
    expect(figure.sourceRef[0]?.rowCount).toBe(2);
    expect(Object.isFrozen(figure)).toBe(true);
    expect(Object.isFrozen(figure.values[0])).toBe(true);
  });

  it("excludes tombstoned settlements — history of what still counts", async () => {
    const cp = await mkCounterparty("Eli");
    await addDebt(cp, 10000, "2026-10-01");
    const keep = await addSettlement(cp, -2000, "2026-10-05");
    const drop = await addSettlement(cp, -3000, "2026-10-06");
    await tombstoneEntry(db, ORG, drop);

    const tools = createLedgerTools({ now: () => FIXED_NOW });
    const figure = await tools.settlementHistory(db, ORG);
    expect(figure.values.map((v) => v.entryId)).toEqual([keep]);
    expect(figure.sourceRef[0]?.rowCount).toBe(1);
  });

  it("applies the inclusive window, validated field-only", async () => {
    const cp = await mkCounterparty("Fay");
    await addDebt(cp, 10000, "2026-10-01");
    await addSettlement(cp, -1000, "2026-10-04");
    await addSettlement(cp, -1000, "2026-10-05");
    await addSettlement(cp, -1000, "2026-10-12");

    const tools = createLedgerTools({ now: () => FIXED_NOW });
    const figure = await tools.settlementHistory(db, ORG, {
      fromDate: "2026-10-05",
      toDate: "2026-10-12",
    });
    expect(figure.values).toHaveLength(2);
    expect(figure.sourceRef[0]?.fromDate).toBe("2026-10-05");
    expect(figure.sourceRef[0]?.toDate).toBe("2026-10-12");

    let caught: LedgerToolQueryError | null = null;
    try {
      await tools.settlementHistory(db, ORG, { fromDate: "nope" });
    } catch (error) {
      caught = error as LedgerToolQueryError;
    }
    expect(caught).toBeInstanceOf(LedgerToolQueryError);
    expect(caught?.field).toBe("fromDate");
    expect(caught?.message).toContain("fromDate");
    expect(caught?.message).not.toContain("nope"); // no value echo

    caught = null;
    try {
      await tools.settlementHistory(db, ORG, {
        fromDate: "2026-10-12",
        toDate: "2026-10-05",
      });
    } catch (error) {
      caught = error as LedgerToolQueryError;
    }
    expect(caught?.field).toBe("fromDate");
  });

  it("caps the id list but keeps the exact rowCount", async () => {
    const cp = await mkCounterparty("Gus");
    await addDebt(cp, 10000, "2026-10-01");
    await addSettlement(cp, -1000, "2026-10-01");
    await addSettlement(cp, -2000, "2026-10-02");
    await addSettlement(cp, -3000, "2026-10-03");

    const tools = createLedgerTools({ maxRows: 2, now: () => FIXED_NOW });
    const figure = await tools.settlementHistory(db, ORG);
    expect(figure.values).toHaveLength(2);
    expect(figure.sourceRef[0]?.entryIds).toHaveLength(2);
    expect(figure.sourceRef[0]?.rowCount).toBe(3);
  });

  it("stays inside the organization", async () => {
    const foreign = await mkCounterparty("Stranger", OTHER_ORG);
    await addDebt(foreign, 1000, "2026-10-01", OTHER_ORG);
    await addSettlement(foreign, -500, "2026-10-05", OTHER_ORG);
    const tools = createLedgerTools({ now: () => FIXED_NOW });
    const figure = await tools.settlementHistory(db, ORG);
    expect(figure.values).toHaveLength(0);
    expect(figure.sourceRef[0]?.rowCount).toBe(0);
  });
});

describe("debtPayoffProjection — amortization in code, never by the model", () => {
  it("projects a zero-interest payoff with a clamped final payment", async () => {
    const cp = await mkCounterparty("Hana");
    await addDebt(cp, 10000, "2026-10-01");

    const tools = createLedgerTools({ now: () => FIXED_NOW });
    const figure = await tools.debtPayoffProjection(db, ORG, {
      counterpartyId: cp,
      monthlyPaymentCents: 3000,
    });

    expect(figure.values).toEqual([
      {
        month: 1,
        openingCents: 10000,
        interestCents: 0,
        paymentCents: 3000,
        closingCents: 7000,
      },
      {
        month: 2,
        openingCents: 7000,
        interestCents: 0,
        paymentCents: 3000,
        closingCents: 4000,
      },
      {
        month: 3,
        openingCents: 4000,
        interestCents: 0,
        paymentCents: 3000,
        closingCents: 1000,
      },
      {
        month: 4,
        openingCents: 1000,
        interestCents: 0,
        paymentCents: 1000,
        closingCents: 0,
      },
    ]);
    expect(figure.summary).toEqual({
      counterpartyId: cp,
      alias: "Hana",
      openingBalanceCents: 10000,
      aprBps: 0,
      monthlyPaymentCents: 3000,
      totalMonths: 4,
      totalPaidCents: 10000,
    });
    expect(figure.asOf).toBe(FIXED_NOW);
    expect(figure.currency).toBeNull();
    expect(figure.sourceRef[0]?.kind).toBe("ledger_entry");
    expect(figure.sourceRef[0]?.rowCount).toBe(1);
    expect(Object.isFrozen(figure)).toBe(true);
    expect(Object.isFrozen(figure.values)).toBe(true);
    expect(Object.isFrozen(figure.summary)).toBe(true);
  });

  it("handles an exact division and a negative (we owe) position", async () => {
    const exact = await mkCounterparty("Ivy");
    await addDebt(exact, 6000, "2026-10-01");
    const tools = createLedgerTools({ now: () => FIXED_NOW });
    const a = await tools.debtPayoffProjection(db, ORG, {
      counterpartyId: exact,
      monthlyPaymentCents: 3000,
    });
    expect(a.summary.totalMonths).toBe(2);
    expect(a.summary.totalPaidCents).toBe(6000);
    expect(a.values[1]?.paymentCents).toBe(3000); // no partial needed

    const negative = await mkCounterparty("Jo");
    await addDebt(negative, -6000, "2026-10-01");
    const b = await tools.debtPayoffProjection(db, ORG, {
      counterpartyId: negative,
      monthlyPaymentCents: 3000,
    });
    // Direction lives in the signed opening balance; the schedule
    // clears |balance|.
    expect(b.summary.openingBalanceCents).toBe(-6000);
    expect(b.summary.totalMonths).toBe(2);
    expect(b.summary.totalPaidCents).toBe(6000);
    expect(b.values[1]?.closingCents).toBe(0);
  });

  it("compounds configured interest per period with integer-cent rounding", async () => {
    const cp = await mkCounterparty("Kai");
    await addDebt(cp, 100000, "2026-10-01");
    const tools = createLedgerTools({
      aprBps: 1200, // 12%/yr => 1%/mo
      now: () => FIXED_NOW,
    });
    const figure = await tools.debtPayoffProjection(db, ORG, {
      counterpartyId: cp,
      monthlyPaymentCents: 20000,
    });

    expect(figure.values).toEqual([
      {
        month: 1,
        openingCents: 100000,
        interestCents: 1000,
        paymentCents: 20000,
        closingCents: 81000,
      },
      {
        month: 2,
        openingCents: 81000,
        interestCents: 810,
        paymentCents: 20000,
        closingCents: 61810,
      },
      {
        month: 3,
        openingCents: 61810,
        interestCents: 618,
        paymentCents: 20000,
        closingCents: 42428,
      },
      {
        month: 4,
        openingCents: 42428,
        interestCents: 424,
        paymentCents: 20000,
        closingCents: 22852,
      },
      {
        month: 5,
        openingCents: 22852,
        interestCents: 229,
        paymentCents: 20000,
        closingCents: 3081,
      },
      {
        month: 6,
        openingCents: 3081,
        interestCents: 31,
        paymentCents: 3112,
        closingCents: 0,
      },
    ]);
    expect(figure.summary.totalMonths).toBe(6);
    // 100000 principal + 3112 total interest, paid in 5x20000 + 3112.
    expect(figure.summary.totalPaidCents).toBe(103112);
    expect(figure.summary.aprBps).toBe(1200);
  });

  it("rejects a payment that never clears the interest — typed, value-free", async () => {
    const cp = await mkCounterparty("Lim");
    await addDebt(cp, 100000, "2026-10-01");
    const tools = createLedgerTools({
      aprBps: 1200,
      now: () => FIXED_NOW,
    });
    // First period's interest is exactly 1000: paying it leaves the
    // principal untouched — the balance never converges.
    let caught: LedgerToolQueryError | null = null;
    try {
      await tools.debtPayoffProjection(db, ORG, {
        counterpartyId: cp,
        monthlyPaymentCents: 1000,
      });
    } catch (error) {
      caught = error as LedgerToolQueryError;
    }
    expect(caught).toBeInstanceOf(LedgerToolQueryError);
    expect(caught?.field).toBe("monthlyPaymentCents");
    expect(caught?.message).not.toContain("1000"); // no value echo
  });

  it("refuses zero balances and unknown counterparties", async () => {
    const settled = await mkCounterparty("Mo");
    await addDebt(settled, 4000, "2026-10-01");
    await addSettlement(settled, -4000, "2026-10-02");
    const tools = createLedgerTools({ now: () => FIXED_NOW });

    let caught: LedgerToolQueryError | null = null;
    try {
      await tools.debtPayoffProjection(db, ORG, {
        counterpartyId: settled,
        monthlyPaymentCents: 1000,
      });
    } catch (error) {
      caught = error as LedgerToolQueryError;
    }
    expect(caught?.field).toBe("counterpartyId");

    caught = null;
    try {
      await tools.debtPayoffProjection(db, ORG, {
        counterpartyId: "who-is-this",
        monthlyPaymentCents: 1000,
      });
    } catch (error) {
      caught = error as LedgerToolQueryError;
    }
    expect(caught?.field).toBe("counterpartyId");
    expect(caught?.message).not.toContain("who-is-this");
  });

  it("validates the payment field without echoing the value", async () => {
    const cp = await mkCounterparty("Ned");
    await addDebt(cp, 5000, "2026-10-01");
    const tools = createLedgerTools({ now: () => FIXED_NOW });

    for (const bad of [0, -100, 1.5]) {
      let caught: LedgerToolQueryError | null = null;
      try {
        await tools.debtPayoffProjection(db, ORG, {
          counterpartyId: cp,
          monthlyPaymentCents: bad,
        });
      } catch (error) {
        caught = error as LedgerToolQueryError;
      }
      expect(caught).toBeInstanceOf(LedgerToolQueryError);
      expect(caught?.field).toBe("monthlyPaymentCents");
      expect(caught?.message).not.toContain(String(bad));
    }
  });

  it("caps the returned schedule but reports the full summary", async () => {
    const cp = await mkCounterparty("Ola");
    await addDebt(cp, 10000, "2026-10-01");
    const tools = createLedgerTools({ maxRows: 2, now: () => FIXED_NOW });
    const figure = await tools.debtPayoffProjection(db, ORG, {
      counterpartyId: cp,
      monthlyPaymentCents: 3000,
    });
    expect(figure.values).toHaveLength(2); // months 1-2 only
    expect(figure.summary.totalMonths).toBe(4);
    expect(figure.summary.totalPaidCents).toBe(10000);
  });

  it("refuses schedules past the configured month limit", async () => {
    const cp = await mkCounterparty("Pia");
    await addDebt(cp, 10000, "2026-10-01");
    const tools = createLedgerTools({ maxMonths: 3, now: () => FIXED_NOW });
    let caught: LedgerToolQueryError | null = null;
    try {
      await tools.debtPayoffProjection(db, ORG, {
        counterpartyId: cp,
        monthlyPaymentCents: 3000, // needs 4 months
      });
    } catch (error) {
      caught = error as LedgerToolQueryError;
    }
    expect(caught?.field).toBe("projection");
    expect(caught?.message).toContain("month");
  });
});

describe("configuration — policy values live in config, never hardcoded", () => {
  it("rejects nonsensical caps and rates at construction", () => {
    expect(() => createLedgerTools({ maxRows: 0 })).toThrow(
      LedgerToolConfigError,
    );
    expect(() => createLedgerTools({ maxMonths: 0 })).toThrow(
      LedgerToolConfigError,
    );
    expect(() => createLedgerTools({ maxMonths: -5 })).toThrow(
      LedgerToolConfigError,
    );
    expect(() => createLedgerTools({ aprBps: -1 })).toThrow(
      LedgerToolConfigError,
    );
    expect(() => createLedgerTools({ aprBps: 1.5 })).toThrow(
      LedgerToolConfigError,
    );
    expect(() => createLedgerTools({ maxRows: 2.5 })).toThrow(
      LedgerToolConfigError,
    );
  });
});

/**
 * Step 3.1 — ledger domain invariants (plan Phase 3).
 *
 * The debt/IOU register is the second product pillar: durable money
 * facts a chatbot cannot produce. Everything here is derived from an
 * append-only entry log, pinned by tests:
 *
 * - **Entry sum equals balance**: balance is NEVER stored — it is
 *   always SUM(live entries), so it cannot drift. Amounts are signed
 *   cents from the org's perspective: positive = counterparty owes
 *   the org, negative = the org owes the counterparty. `debt` opens
 *   or shifts exposure, `settlement` reduces it.
 * - **Partial settlements**: settling less than outstanding is legal;
 *   settling the full amount zeroes the balance.
 * - **No double-settlement**: a settlement may never exceed or flip
 *   the outstanding balance (overpayment is rejected, not silently
 *   accepted); AND every write carries an idempotency key — replaying
 *   the same key (retried agent turn, redelivered webhook) returns
 *   the original entry and changes nothing.
 * - **Tombstones, never deletes**: money history is append-only;
 *   `tombstoned_at` excludes an entry from balance arithmetic and is
 *   idempotent. No update path exists for recorded entries.
 * - **Aliases, not legal names (§3.8)**: counterparties store ONE
 *   name field — a Step 1.5-sanitized display alias. There is no
 *   legal-name column to leak; the row shape is asserted.
 * - **Tenancy by construction**: organization_id in every WHERE.
 * - **Property-based**: random settlement sequences (seeded PRNG,
 *   CI-stable) must satisfy balance === model sum after every
 *   operation, and a full replay of every operation with the same
 *   idempotency keys must change nothing.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createScratchDatabase } from "../helpers/scratch-db";
import { createDb, type Db } from "../../src/db/tenancy";
import {
  LedgerError,
  balanceOf,
  createCounterparty,
  listEntries,
  recordDebt,
  recordSettlement,
  tombstoneCounterparty,
  tombstoneEntry,
} from "../../src/ledger/entries";
import type { LedgerEntryKind } from "../../src/db/schema/ledger";

const DB = "finbrief_ledger_test";
const ORG_ID = "org_ledger_1";
const OTHER_ORG = "org_ledger_2";

let scratch: Awaited<ReturnType<typeof createScratchDatabase>>;
let pool: Pool;
let db: Db;

beforeAll(async () => {
  scratch = await createScratchDatabase(DB);
  await scratch.migrate();
  pool = scratch.pool;
  db = createDb(pool);
  for (const [id, slug] of [
    [ORG_ID, "ledger-one"],
    [OTHER_ORG, "ledger-two"],
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
  await pool.query("TRUNCATE ledger_entries, ledger_counterparties");
});

const mk = (suffix: string) => ({
  alias: `Counterparty ${suffix}`,
  key: `key-${suffix}-${randomBytes(4).toString("hex")}`,
});

describe("counterparty aliases (§3.8 — aliases, not legal names)", () => {
  it("stores a sanitized alias as the only name field on the row", async () => {
    const cp = await createCounterparty(db, ORG_ID, {
      alias: "Bidi\u202eFriend\u200b LLC",
    });
    expect(cp.alias).toBe("Bidi Friend LLC");

    const row = (
      await pool.query("SELECT * FROM ledger_counterparties WHERE id = $1", [
        cp.id,
      ])
    ).rows[0] as Record<string, unknown>;
    // The row shape IS the privacy guarantee: no legal-name column
    // exists to leak into a send-set or trace.
    expect(Object.keys(row).sort()).toEqual([
      "alias",
      "created_at",
      "id",
      "organization_id",
      "tombstoned_at",
    ]);
  });

  it("rejects an alias that sanitizes to empty", async () => {
    await expect(
      createCounterparty(db, ORG_ID, { alias: "\u0007\u202e\u200b" }),
    ).rejects.toThrow(LedgerError);
    let code = "";
    try {
      await createCounterparty(db, ORG_ID, { alias: "\u0000" });
    } catch (error) {
      code = (error as LedgerError).code ?? "";
    }
    expect(code).toBe("ALIAS_EMPTY");
  });

  it("scopes every read to the organization", async () => {
    const mine = await createCounterparty(db, ORG_ID, mk("a"));
    await createCounterparty(db, OTHER_ORG, mk("b"));
    expect(await balanceOf(db, OTHER_ORG, mine.id)).toBe(0);
  });
});

describe("recordDebt", () => {
  it("opens signed exposure in both directions", async () => {
    const { alias, key } = mk("debt");
    const cp = await createCounterparty(db, ORG_ID, { alias });

    const theyOwe = await recordDebt(db, ORG_ID, {
      counterpartyId: cp.id,
      amountCents: 5000,
      entryDate: "2026-10-01",
      idempotencyKey: key,
    });
    expect(theyOwe.amountCents).toBe(5000);
    expect(await balanceOf(db, ORG_ID, cp.id)).toBe(5000);

    const weOwe = await recordDebt(db, ORG_ID, {
      counterpartyId: cp.id,
      amountCents: -3000,
      entryDate: "2026-10-02",
      idempotencyKey: `${key}-neg`,
    });
    expect(weOwe.amountCents).toBe(-3000);
    expect(await balanceOf(db, ORG_ID, cp.id)).toBe(2000);
  });

  it("rejects zero and unsafe amounts without echoing values", async () => {
    const { alias, key } = mk("amt");
    const cp = await createCounterparty(db, ORG_ID, { alias });
    await expect(
      recordDebt(db, ORG_ID, {
        counterpartyId: cp.id,
        amountCents: 0,
        entryDate: "2026-10-01",
        idempotencyKey: key,
      }),
    ).rejects.toThrow(/amountCents/);

    let message = "";
    try {
      await recordDebt(db, ORG_ID, {
        counterpartyId: cp.id,
        amountCents: 1.5,
        entryDate: "2026-10-01",
        idempotencyKey: key,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("amountCents");
    expect(message).not.toContain("1.5");
    expect(await balanceOf(db, ORG_ID, cp.id)).toBe(0);
  });

  it("replays idempotently — same key, same entry, no double exposure", async () => {
    const { alias, key } = mk("idem");
    const cp = await createCounterparty(db, ORG_ID, { alias });
    const first = await recordDebt(db, ORG_ID, {
      counterpartyId: cp.id,
      amountCents: 7500,
      entryDate: "2026-10-01",
      idempotencyKey: key,
    });
    const replay = await recordDebt(db, ORG_ID, {
      counterpartyId: cp.id,
      amountCents: 7500,
      entryDate: "2026-10-01",
      idempotencyKey: key,
    });
    expect(replay.id).toBe(first.id);
    expect(await balanceOf(db, ORG_ID, cp.id)).toBe(7500);
    const entries = await listEntries(db, ORG_ID, cp.id);
    expect(entries).toHaveLength(1);
  });

  it("rejects writes against a tombstoned counterparty", async () => {
    const { alias, key } = mk("tomb-cp");
    const cp = await createCounterparty(db, ORG_ID, { alias });
    await tombstoneCounterparty(db, ORG_ID, cp.id);
    let code = "";
    try {
      await recordDebt(db, ORG_ID, {
        counterpartyId: cp.id,
        amountCents: 100,
        entryDate: "2026-10-01",
        idempotencyKey: key,
      });
    } catch (error) {
      code = (error as LedgerError).code ?? "";
    }
    expect(code).toBe("COUNTERPARTY_TOMBSTONED");
  });
});

describe("settlements — partial, bounded, never double", () => {
  it("supports partial settlement and tracks the remainder", async () => {
    const { alias, key } = mk("partial");
    const cp = await createCounterparty(db, ORG_ID, { alias });
    await recordDebt(db, ORG_ID, {
      counterpartyId: cp.id,
      amountCents: 10000,
      entryDate: "2026-10-01",
      idempotencyKey: key,
    });

    await recordSettlement(db, ORG_ID, {
      counterpartyId: cp.id,
      amountCents: -4000, // they pay part of what they owe
      entryDate: "2026-10-05",
      idempotencyKey: `${key}-s1`,
    });
    expect(await balanceOf(db, ORG_ID, cp.id)).toBe(6000);

    await recordSettlement(db, ORG_ID, {
      counterpartyId: cp.id,
      amountCents: -6000, // remainder zeroes it
      entryDate: "2026-10-09",
      idempotencyKey: `${key}-s2`,
    });
    expect(await balanceOf(db, ORG_ID, cp.id)).toBe(0);
  });

  it("settles exposure in the org-owes direction too", async () => {
    const { alias, key } = mk("org-owes");
    const cp = await createCounterparty(db, ORG_ID, { alias });
    await recordDebt(db, ORG_ID, {
      counterpartyId: cp.id,
      amountCents: -3000,
      entryDate: "2026-10-01",
      idempotencyKey: key,
    });
    await recordSettlement(db, ORG_ID, {
      counterpartyId: cp.id,
      amountCents: 1000,
      entryDate: "2026-10-03",
      idempotencyKey: `${key}-p`,
    });
    expect(await balanceOf(db, ORG_ID, cp.id)).toBe(-2000);
  });

  it("rejects over-settlement — the no-double-settlement invariant", async () => {
    const { alias, key } = mk("over");
    const cp = await createCounterparty(db, ORG_ID, { alias });
    await recordDebt(db, ORG_ID, {
      counterpartyId: cp.id,
      amountCents: 5000,
      entryDate: "2026-10-01",
      idempotencyKey: key,
    });

    let code = "";
    try {
      await recordSettlement(db, ORG_ID, {
        counterpartyId: cp.id,
        amountCents: -9000,
        entryDate: "2026-10-02",
        idempotencyKey: `${key}-over`,
      });
    } catch (error) {
      code = (error as LedgerError).code ?? "";
    }
    expect(code).toBe("SETTLEMENT_EXCEEDS_BALANCE");
    // Balance untouched — the rejected settlement wrote nothing.
    expect(await balanceOf(db, ORG_ID, cp.id)).toBe(5000);

    // Settling more against a zero balance is also rejected.
    await recordSettlement(db, ORG_ID, {
      counterpartyId: cp.id,
      amountCents: -5000,
      entryDate: "2026-10-03",
      idempotencyKey: `${key}-full`,
    });
    await expect(
      recordSettlement(db, ORG_ID, {
        counterpartyId: cp.id,
        amountCents: -1,
        entryDate: "2026-10-04",
        idempotencyKey: `${key}-extra`,
      }),
    ).rejects.toThrow(/SETTLEMENT_EXCEEDS_BALANCE|settlement/);
  });

  it("rejects a settlement on the wrong side of the balance", async () => {
    const { alias, key } = mk("wrong-side");
    const cp = await createCounterparty(db, ORG_ID, { alias });
    await recordDebt(db, ORG_ID, {
      counterpartyId: cp.id,
      amountCents: 5000,
      entryDate: "2026-10-01",
      idempotencyKey: key,
    });
    await expect(
      recordSettlement(db, ORG_ID, {
        counterpartyId: cp.id,
        amountCents: 2000, // same sign as balance — not a settlement
        entryDate: "2026-10-02",
        idempotencyKey: `${key}-side`,
      }),
    ).rejects.toThrow(LedgerError);
    expect(await balanceOf(db, ORG_ID, cp.id)).toBe(5000);
  });

  it("replays settlements idempotently — a redelivered webhook cannot double-pay", async () => {
    const { alias, key } = mk("replay");
    const cp = await createCounterparty(db, ORG_ID, { alias });
    await recordDebt(db, ORG_ID, {
      counterpartyId: cp.id,
      amountCents: 8000,
      entryDate: "2026-10-01",
      idempotencyKey: key,
    });
    const params = {
      counterpartyId: cp.id,
      amountCents: -8000,
      entryDate: "2026-10-02",
      idempotencyKey: `${key}-settle`,
    };
    const first = await recordSettlement(db, ORG_ID, params);
    const replay = await recordSettlement(db, ORG_ID, params);
    expect(replay.id).toBe(first.id);
    expect(await balanceOf(db, ORG_ID, cp.id)).toBe(0);
    expect(await listEntries(db, ORG_ID, cp.id)).toHaveLength(2);
  });
});

describe("tombstones — append-only money history", () => {
  it("excludes a tombstoned entry from balance, idempotently", async () => {
    const { alias, key } = mk("tomb");
    const cp = await createCounterparty(db, ORG_ID, { alias });
    const debt = await recordDebt(db, ORG_ID, {
      counterpartyId: cp.id,
      amountCents: 4200,
      entryDate: "2026-10-01",
      idempotencyKey: key,
    });
    await tombstoneEntry(db, ORG_ID, debt.id);
    await tombstoneEntry(db, ORG_ID, debt.id); // idempotent
    expect(await balanceOf(db, ORG_ID, cp.id)).toBe(0);
  });

  it("keeps the row — the entry survives as tombstoned history", async () => {
    const { alias, key } = mk("keep");
    const cp = await createCounterparty(db, ORG_ID, { alias });
    const debt = await recordDebt(db, ORG_ID, {
      counterpartyId: cp.id,
      amountCents: 1000,
      entryDate: "2026-10-01",
      idempotencyKey: key,
    });
    await tombstoneEntry(db, ORG_ID, debt.id);
    const row = (
      await pool.query(
        "SELECT tombstoned_at FROM ledger_entries WHERE id = $1",
        [debt.id],
      )
    ).rows[0] as { tombstoned_at: Date | null };
    expect(row.tombstoned_at).not.toBeNull();
    expect(await listEntries(db, ORG_ID, cp.id)).toHaveLength(0);
  });

  it("rejects tombstoning a counterparty that still holds a balance", async () => {
    const { alias, key } = mk("hold");
    const cp = await createCounterparty(db, ORG_ID, { alias });
    await recordDebt(db, ORG_ID, {
      counterpartyId: cp.id,
      amountCents: 2500,
      entryDate: "2026-10-01",
      idempotencyKey: key,
    });
    let code = "";
    try {
      await tombstoneCounterparty(db, ORG_ID, cp.id);
    } catch (error) {
      code = (error as LedgerError).code ?? "";
    }
    expect(code).toBe("COUNTERPARTY_HAS_BALANCE");
    // Zero it, then tombstone succeeds and is idempotent.
    await recordSettlement(db, ORG_ID, {
      counterpartyId: cp.id,
      amountCents: -2500,
      entryDate: "2026-10-02",
      idempotencyKey: `${key}-settle`,
    });
    await tombstoneCounterparty(db, ORG_ID, cp.id);
    await tombstoneCounterparty(db, ORG_ID, cp.id);
  });
});

describe("listEntries", () => {
  it("enforces the row cap and excludes tombstoned rows", async () => {
    const { alias, key } = mk("cap");
    const cp = await createCounterparty(db, ORG_ID, { alias });
    for (let index = 0; index < 5; index += 1) {
      const entry = await recordDebt(db, ORG_ID, {
        counterpartyId: cp.id,
        amountCents: 100 * (index + 1),
        entryDate: "2026-10-01",
        idempotencyKey: `${key}-${index}`,
      });
      if (index === 0) await tombstoneEntry(db, ORG_ID, entry.id);
    }
    const capped = await listEntries(db, ORG_ID, cp.id, { limit: 3 });
    expect(capped).toHaveLength(3);
    expect(capped.every((e) => e.tombstonedAt === null)).toBe(true);
  });
});

/**
 * Property-based: random settlement sequences. Seeded PRNG keeps CI
 * deterministic (the convention from tests/plaid/sync.test.ts).
 */
function mulberry32(seed: number) {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Op {
  kind: LedgerEntryKind;
  amountCents: number;
  entryDate: string;
  idempotencyKey: string;
}

describe("property: random settlement sequences", () => {
  it("balance always equals the live-entry sum, and replay is a no-op", async () => {
    const random = mulberry32(0xc0ffee);
    const { alias } = mk("prop");
    const cp = await createCounterparty(db, ORG_ID, { alias });

    // Model: signed cents of live entries.
    let model = 0;
    const ops: Op[] = [];
    const tombstoned = new Set<string>();

    for (let step = 0; step < 60; step += 1) {
      const key = `prop-${step}-${randomBytes(3).toString("hex")}`;
      const roll = random();

      if (roll < 0.45 || model === 0) {
        // Debt: random signed amount, non-zero.
        const magnitude = 1 + Math.floor(random() * 10_000);
        const amountCents = random() < 0.5 ? magnitude : -magnitude;
        const op: Op = {
          kind: "debt",
          amountCents,
          entryDate: "2026-10-01",
          idempotencyKey: key,
        };
        await recordDebt(db, ORG_ID, {
          counterpartyId: cp.id,
          ...op,
        });
        ops.push(op);
        model += amountCents;
      } else if (roll < 0.85) {
        // Legal settlement by construction: opposite sign, magnitude
        // anywhere from 1 cent to the full outstanding balance.
        const magnitude = 1 + Math.floor(random() * Math.abs(model));
        const amountCents = model > 0 ? -magnitude : magnitude;
        const op: Op = {
          kind: "settlement",
          amountCents,
          entryDate: "2026-10-02",
          idempotencyKey: key,
        };
        await recordSettlement(db, ORG_ID, {
          counterpartyId: cp.id,
          ...op,
        });
        ops.push(op);
        model += amountCents;
      } else {
        // Illegal settlement fuzz: over-settle or wrong side. Must
        // throw and leave the balance untouched.
        const magnitude = Math.abs(model) + 1 + Math.floor(random() * 500);
        const amountCents = model >= 0 ? magnitude : -magnitude; // over-settle
        const before = await balanceOf(db, ORG_ID, cp.id);
        await expect(
          recordSettlement(db, ORG_ID, {
            counterpartyId: cp.id,
            amountCents,
            entryDate: "2026-10-03",
            idempotencyKey: key,
          }),
        ).rejects.toThrow(LedgerError);
        expect(await balanceOf(db, ORG_ID, cp.id)).toBe(before);
        continue; // nothing was written; not part of the op log
      }

      // Invariant after EVERY operation: balance === model sum.
      expect(await balanceOf(db, ORG_ID, cp.id)).toBe(model);

      // Occasionally tombstone a live entry — balance re-derives.
      if (random() < 0.3 && ops.length > 0) {
        const candidate = ops.find((op) => !tombstoned.has(op.idempotencyKey));
        if (candidate) {
          const listed = await listEntries(db, ORG_ID, cp.id, { limit: 200 });
          const target = listed.find(
            (entry) => entry.idempotencyKey === candidate.idempotencyKey,
          );
          if (target) {
            await tombstoneEntry(db, ORG_ID, target.id);
            tombstoned.add(candidate.idempotencyKey);
            model -= candidate.amountCents;
            expect(await balanceOf(db, ORG_ID, cp.id)).toBe(model);
          }
        }
      }
    }

    // Replay every recorded operation with the same keys: a pure
    // no-op — same entries, same balance.
    const before = await listEntries(db, ORG_ID, cp.id, { limit: 500 });
    for (const op of ops) {
      if (op.kind === "debt") {
        await recordDebt(db, ORG_ID, { counterpartyId: cp.id, ...op });
      } else {
        await recordSettlement(db, ORG_ID, { counterpartyId: cp.id, ...op });
      }
    }
    const after = await listEntries(db, ORG_ID, cp.id, { limit: 500 });
    expect(after.map((e) => e.id)).toEqual(before.map((e) => e.id));
    expect(await balanceOf(db, ORG_ID, cp.id)).toBe(model);
  });
});

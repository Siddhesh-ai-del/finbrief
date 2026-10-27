/**
 * Step 2.2 — freshness rules (plan Phase 2).
 *
 * "Stale data presented as current" is the one §2.7 failure mode with
 * NO sourced mitigation — the labeled-inference mitigation is ours:
 *
 * - **Age-based staleness**: every figure's backing items carry a
 *   sync-commit watermark (`last_synced_at`, stamped by Step 1.3's
 *   cursor commit). Config-driven max-age thresholds per data kind
 *   flag items whose data is too old to narrate as current.
 * - **Scope**: `removed` items (Step 1.6 tombstones) are excluded —
 *   their data is dead, not stale. Never-synced items have no data
 *   to misrepresent (ageHours null, not stale).
 * - **Prose tense gate**: `draftBalanceClaim` / `draftSpendClaim`
 *   are the reference prose generators (the real briefing lands in
 *   Step 5.2 and must compose the same primitive). When the report
 *   is stale, present-tense money claims are FORBIDDEN: the claim
 *   falls back to past tense and carries the as-of stamp. The tests
 *   below assert the generated strings, not just the flag.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createScratchDatabase } from "../helpers/scratch-db";
import { createDb, type Db } from "../../src/db/tenancy";
import {
  FreshnessConfigError,
  draftBalanceClaim,
  draftSpendClaim,
  evaluateFreshness,
  formatCents,
  presentTenseAllowed,
} from "../../src/insight/freshness";

const DB = "finbrief_freshness_test";
const ORG_ID = "org_fresh_1";
const HOUR_MS = 3_600_000;
const NOW = new Date("2026-10-03T12:00:00.000Z");

let scratch: Awaited<ReturnType<typeof createScratchDatabase>>;
let pool: Pool;
let db: Db;

async function insertItem(
  label: string,
  status: string,
  lastSyncedAt: string | null,
): Promise<string> {
  const inserted = await pool.query(
    `INSERT INTO plaid_items
       (id, organization_id, item_id_ciphertext, access_token_ciphertext,
        item_id_index, status, last_synced_at, created_at)
     VALUES (gen_random_uuid(), $1, 'ct', 'ct', $2, $3, $4, now())
     RETURNING id`,
    [
      ORG_ID,
      `idx-${label}-${randomBytes(4).toString("hex")}`,
      status,
      lastSyncedAt,
    ],
  );
  return (inserted.rows[0] as { id: string }).id;
}

beforeAll(async () => {
  scratch = await createScratchDatabase(DB);
  await scratch.migrate();
  pool = scratch.pool;
  db = createDb(pool);
  await pool.query(
    `INSERT INTO organization (id, name, slug, created_at)
     VALUES ($1, 'Org', 'fresh-org', now())`,
    [ORG_ID],
  );
}, 60_000);

afterAll(async () => {
  await scratch?.destroy();
});

beforeEach(async () => {
  await pool.query("TRUNCATE plaid_items CASCADE");
});

const config = (transactionsMaxAgeHours: number) => ({
  thresholds: { transactions: transactionsMaxAgeHours },
  now: () => NOW,
});

describe("evaluateFreshness", () => {
  it("flags nothing when every item synced inside the threshold", async () => {
    const fresh = await insertItem(
      "fresh",
      "active",
      new Date(NOW.getTime() - 1 * HOUR_MS).toISOString(),
    );
    const report = await evaluateFreshness(db, ORG_ID, config(24));

    expect(report.stale).toBe(false);
    expect(report.asOf).toEqual(NOW);
    expect(report.items).toHaveLength(1);
    expect(report.items[0]).toMatchObject({ itemId: fresh, stale: false });
    expect(report.items[0]?.ageHours).toBeCloseTo(1, 5);
  });

  it("flags an item older than the threshold and names it", async () => {
    const old = await insertItem(
      "old",
      "active",
      new Date(NOW.getTime() - 48 * HOUR_MS).toISOString(),
    );
    const report = await evaluateFreshness(db, ORG_ID, config(24));

    expect(report.stale).toBe(true);
    expect(report.items[0]?.stale).toBe(true);
    expect(report.staleItemIds).toEqual([old]);
  });

  it("excludes removed tombstones entirely (dead, not stale)", async () => {
    await insertItem(
      "removed",
      "removed",
      new Date(NOW.getTime() - 999 * HOUR_MS).toISOString(),
    );
    const report = await evaluateFreshness(db, ORG_ID, config(24));
    expect(report.items).toHaveLength(0);
    expect(report.stale).toBe(false);
  });

  it("treats never-synced as no data, not stale", async () => {
    await insertItem("never", "active", null);
    const report = await evaluateFreshness(db, ORG_ID, config(24));
    expect(report.items[0]?.ageHours).toBeNull();
    expect(report.items[0]?.stale).toBe(false);
    expect(report.stale).toBe(false);
  });

  it("evaluates each item independently — one stale poisons the report", async () => {
    const fresh = await insertItem(
      "fresh",
      "active",
      new Date(NOW.getTime() - 1 * HOUR_MS).toISOString(),
    );
    const old = await insertItem(
      "old",
      "stale",
      new Date(NOW.getTime() - 100 * HOUR_MS).toISOString(),
    );
    const report = await evaluateFreshness(db, ORG_ID, config(24));
    expect(report.stale).toBe(true);
    expect(report.staleItemIds).toEqual([old]);
    expect(report.items.find((i) => i.itemId === fresh)?.stale).toBe(false);
  });

  it("rejects a missing or non-positive threshold", async () => {
    await expect(
      evaluateFreshness(db, ORG_ID, { thresholds: {} }),
    ).rejects.toThrow(FreshnessConfigError);
    await expect(
      evaluateFreshness(db, ORG_ID, { thresholds: { transactions: 0 } }),
    ).rejects.toThrow(FreshnessConfigError);
  });

  it("returns a frozen report", async () => {
    const report = await evaluateFreshness(db, ORG_ID, config(24));
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.items)).toBe(true);
  });
});

describe("prose tense gate (the §2.7 mitigation, asserted on strings)", () => {
  it("allows present tense only when fresh", async () => {
    await insertItem(
      "fresh",
      "active",
      new Date(NOW.getTime() - 1 * HOUR_MS).toISOString(),
    );
    const report = await evaluateFreshness(db, ORG_ID, config(24));
    expect(presentTenseAllowed(report)).toBe(true);
    expect(draftBalanceClaim({ netCents: 123_456, asOf: NOW }, report)).toBe(
      "Your balance is $1,234.56.",
    );
  });

  it("a stale balance claim is past-tense and stamped — never present", async () => {
    await insertItem(
      "old",
      "active",
      new Date(NOW.getTime() - 100 * HOUR_MS).toISOString(),
    );
    const report = await evaluateFreshness(db, ORG_ID, config(24));
    expect(presentTenseAllowed(report)).toBe(false);

    const claim = draftBalanceClaim({ netCents: 123_456, asOf: NOW }, report);
    expect(claim).toBe("As of October 3, 2026, your balance was $1,234.56.");
    // The banned present-tense forms, asserted on the generated prose.
    expect(claim).not.toMatch(/\b(is|are|currently)\b/);
  });

  it("a stale spend claim falls back to past perfect, with the stamp", async () => {
    await insertItem(
      "old",
      "active",
      new Date(NOW.getTime() - 100 * HOUR_MS).toISOString(),
    );
    const report = await evaluateFreshness(db, ORG_ID, config(24));
    const claim = draftSpendClaim(
      { merchant: "STARBUCKS", totalCents: 8_000, month: "2026-09", asOf: NOW },
      report,
    );
    expect(claim).toBe(
      "As of October 3, 2026, you had spent $80.00 at STARBUCKS in September 2026.",
    );
    expect(claim).not.toMatch(/\b(is|are|currently)\b/);
  });

  it("a fresh spend claim reads naturally, no stamp needed", async () => {
    await insertItem(
      "fresh",
      "active",
      new Date(NOW.getTime() - 1 * HOUR_MS).toISOString(),
    );
    const report = await evaluateFreshness(db, ORG_ID, config(24));
    expect(
      draftSpendClaim(
        {
          merchant: "STARBUCKS",
          totalCents: 8_000,
          month: "2026-09",
          asOf: NOW,
        },
        report,
      ),
    ).toBe("You spent $80.00 at STARBUCKS in September 2026.");
  });
});

describe("formatCents", () => {
  it("formats integer cents without floats", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(5)).toBe("$0.05");
    expect(formatCents(6_334)).toBe("$63.34");
    expect(formatCents(123_456)).toBe("$1,234.56");
    expect(formatCents(-6_334)).toBe("-$63.34");
  });
});

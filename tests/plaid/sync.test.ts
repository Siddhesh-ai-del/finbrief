/**
 * Step 1.3 — /transactions/sync against recorded fixture payloads.
 *
 * Pins the plan's contract end to end:
 * - initial call with no cursor → save next_cursor → paginate has_more
 * - added / modified / removed applied, mapped (cents, ISO date, PFC)
 * - restart on TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION, bounded
 * - re-delivery of the same page is a no-op (idempotency keyed on
 *   Plaid transaction_id + cursor)
 * - property: arbitrary prefix-replay interleavings across runs leave
 *   the DB in the same state as one clean sync (seeded, CI-stable)
 *
 * Fixtures are recorded-shaped Plaid payloads under
 * tests/fixtures/transactions-sync/; the SDK is a scripted mock, so
 * no network and no Plaid account.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createScratchDatabase } from "../helpers/scratch-db";
import page1 from "../fixtures/transactions-sync/page-1-initial.json";
import page2 from "../fixtures/transactions-sync/page-2-followup.json";
import page3 from "../fixtures/transactions-sync/page-3-final.json";
import { createDb, type Db } from "../../src/db/tenancy";
import {
  MAX_SYNC_RESTARTS,
  SyncItemNotFoundError,
  SyncRestartExhaustedError,
  createTransactionSync,
  type SyncPage,
  type TransactionsSyncClient,
} from "../../src/plaid/sync";
import { ENCRYPTION_KEY_BYTES, createSecretBox } from "../../src/plaid/secrets";

const DB = "finbrief_plaid_sync_test";
const ORG_ID = "org_sync_1";
const ROOT_KEY = randomBytes(ENCRYPTION_KEY_BYTES).toString("base64");
const ACCESS_PLAINTEXT = "plaid-access-credential-0001";
const ITEM_PLAINTEXT = "plaid-item-identifier-0001";
const MUTATION_ERROR = "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION";

const secrets = createSecretBox(ROOT_KEY);

interface SyncMock {
  client: TransactionsSyncClient;
  calls: { access_token?: string; cursor?: string }[];
}

type ScriptStep = SyncPage | { failsWith: string };

/** Scripted queue: the last step repeats so "always fails" works. */
function createSyncMock(script: ScriptStep[]): SyncMock {
  const calls: { access_token?: string; cursor?: string }[] = [];
  let index = 0;
  return {
    calls,
    client: {
      transactionsSync: async (params) => {
        calls.push({
          access_token: params.access_token,
          cursor: params.cursor,
        });
        const step = script[Math.min(index, script.length - 1)];
        index += 1;
        if (!step) throw new Error("sync mock script is empty");
        if ("failsWith" in step) {
          throw { response: { data: { error_code: step.failsWith } } };
        }
        return { data: step };
      },
    },
  };
}

const snapshotSql = `SELECT plaid_transaction_id, organization_id, plaid_item_id,
       date, amount_cents, iso_currency_code, name, merchant_name,
       personal_finance_category_primary, personal_finance_category_detailed,
       pending, pending_transaction_id
  FROM transactions
 ORDER BY plaid_transaction_id`;

let scratch: Awaited<ReturnType<typeof createScratchDatabase>>;
let pool: Pool;
let db: Db;
let itemId: string;

beforeAll(async () => {
  scratch = await createScratchDatabase(DB);
  await scratch.migrate();
  pool = scratch.pool;
  db = createDb(pool);

  await pool.query(
    `INSERT INTO organization (id, name, slug, created_at)
     VALUES ($1, 'Org', 'sync-org', now())`,
    [ORG_ID],
  );
  const inserted = await pool.query(
    `INSERT INTO plaid_items
       (id, organization_id, item_id_ciphertext, access_token_ciphertext,
        item_id_index, created_at)
     VALUES ($1, $2, $3, $4, $5, now())
     RETURNING id`,
    [
      "item_sync_1",
      ORG_ID,
      secrets.encrypt(ITEM_PLAINTEXT),
      secrets.encrypt(ACCESS_PLAINTEXT),
      secrets.index(ITEM_PLAINTEXT),
    ],
  );
  itemId = (inserted.rows[0] as { id: string }).id;
}, 60_000);

afterAll(async () => {
  await scratch?.destroy();
});

beforeEach(async () => {
  await pool.query("TRUNCATE transactions CASCADE");
  await pool.query("UPDATE plaid_items SET sync_cursor = NULL");
});

describe("initial sync with pagination", () => {
  it("walks has_more pages, saving next_cursor after each apply", async () => {
    const mock = createSyncMock([page1, page2, page3]);
    const sync = createTransactionSync({ client: mock.client, secrets });

    const summary = await sync.syncItem(db, itemId);

    expect(summary).toEqual({
      pages: 3,
      added: 5,
      modified: 2,
      removed: 1,
      restarts: 0,
    });
    expect(mock.calls.map((c) => c.cursor)).toEqual([
      undefined,
      "cursor-1",
      "cursor-2",
    ]);
    // The stored credential was decrypted for each upstream call.
    for (const call of mock.calls) {
      expect(call.access_token).toBe(ACCESS_PLAINTEXT);
    }

    const rows = (await pool.query(snapshotSql)).rows as Record<
      string,
      string | number | boolean | null
    >[];
    expect(rows).toHaveLength(4);

    const coffee = rows.find((r) => r.plaid_transaction_id === "txn_coffee");
    expect(coffee).toMatchObject({
      organization_id: ORG_ID,
      plaid_item_id: itemId,
      date: "2026-01-14",
      amount_cents: 475, // 4.75 after the page-3 tip adjustment (4.35 before)
      iso_currency_code: "USD",
      name: "STARBUCKS STORE 123",
      merchant_name: "Starbucks",
      personal_finance_category_primary: "FOOD_AND_DRINK",
      personal_finance_category_detailed: "COFFEE_SHOP",
      pending: false,
      pending_transaction_id: null,
    });

    const market = rows.find((r) => r.plaid_transaction_id === "txn_market");
    expect(market?.amount_cents).toBe(8327);

    const stream = rows.find((r) => r.plaid_transaction_id === "txn_stream");
    expect(stream).toMatchObject({
      amount_cents: 1799, // modified on posting (15.99 pending → 17.99)
      pending: false,
      pending_transaction_id: "txn_stream_pending",
      personal_finance_category_primary: "ENTERTAINMENT",
    });

    // txn_gas was added on page 1 and removed on page 3.
    expect(
      rows.find((r) => r.plaid_transaction_id === "txn_gas"),
    ).toBeUndefined();

    const cursor = await pool.query(
      "SELECT sync_cursor FROM plaid_items WHERE id = $1",
      [itemId],
    );
    expect(cursor.rows[0]?.sync_cursor).toBe("cursor-3");
  });
});

describe("re-delivery is a no-op", () => {
  it("applies the same page twice with identical business state", async () => {
    const mock = createSyncMock([{ ...page2, has_more: false }]);
    const sync = createTransactionSync({ client: mock.client, secrets });

    // Seed rows that page 3 touches (coffee exists, gas exists to remove).
    const seed = createSyncMock([{ ...page1, has_more: false }]);
    await createTransactionSync({ client: seed.client, secrets }).syncItem(
      db,
      itemId,
    );
    const before = (await pool.query(snapshotSql)).rows;

    const first = await sync.syncItem(db, itemId);
    const afterFirst = (await pool.query(snapshotSql)).rows;
    const second = await sync.syncItem(db, itemId);
    const afterSecond = (await pool.query(snapshotSql)).rows;

    expect(first.pages).toBe(1);
    expect(second.pages).toBe(1);
    // Business columns only: id/created_at/updated_at are run-scoped
    // (fresh uuids on insert, timestamps bump on every apply).
    expect(afterFirst).toEqual(afterSecond);
    expect(before).not.toEqual(afterFirst);
    expect(mock.calls).toHaveLength(2);
  });
});

describe("mutation-during-pagination restart", () => {
  it("restarts from the run-start cursor and converges", async () => {
    const mock = createSyncMock([
      page1, // ok (cursor undefined)
      { failsWith: MUTATION_ERROR }, // cursor-1 → data moved under us
      page1, // restart: run-start cursor (undefined) replays page 1
      { ...page2, has_more: false }, // cursor-1 now succeeds
    ]);
    const sync = createTransactionSync({ client: mock.client, secrets });

    const summary = await sync.syncItem(db, itemId);

    expect(mock.calls.map((c) => c.cursor)).toEqual([
      undefined,
      "cursor-1",
      undefined,
      "cursor-1",
    ]);
    expect(summary).toEqual({
      pages: 3, // page1 applied twice (idempotent) + page2
      added: 9,
      modified: 1,
      removed: 0,
      restarts: 1,
    });

    const rows = (await pool.query(snapshotSql)).rows as {
      plaid_transaction_id: string;
    }[];
    expect(rows.map((r) => r.plaid_transaction_id).sort()).toEqual([
      "txn_coffee",
      "txn_dept",
      "txn_gas",
      "txn_market",
      "txn_stream",
    ]);
  });

  it("fails loudly after the restart budget is exhausted", async () => {
    const mock = createSyncMock([{ failsWith: MUTATION_ERROR }]);
    const sync = createTransactionSync({ client: mock.client, secrets });

    await expect(sync.syncItem(db, itemId)).rejects.toThrow(
      SyncRestartExhaustedError,
    );
    // initial attempt + MAX_SYNC_RESTARTS retries
    expect(mock.calls).toHaveLength(1 + MAX_SYNC_RESTARTS);
    for (const call of mock.calls) {
      expect(call.cursor).toBeUndefined();
    }
  });

  it("rethrows non-mutation upstream errors untouched", async () => {
    const mock = createSyncMock([{ failsWith: "INVALID_ACCESS_TOKEN" }]);
    const sync = createTransactionSync({ client: mock.client, secrets });

    const thrown = await sync
      .syncItem(db, itemId)
      .catch((error: unknown) => error);
    expect(thrown).toEqual({
      response: { data: { error_code: "INVALID_ACCESS_TOKEN" } },
    });
    expect(thrown).not.toBeInstanceOf(SyncRestartExhaustedError);
    expect(mock.calls).toHaveLength(1);
  });
});

describe("unknown item", () => {
  it("refuses before any upstream call", async () => {
    const mock = createSyncMock([page1]);
    const sync = createTransactionSync({ client: mock.client, secrets });

    await expect(sync.syncItem(db, "missing_item")).rejects.toThrow(
      SyncItemNotFoundError,
    );
    expect(mock.calls).toHaveLength(0);
  });
});

describe("removed item (Step 1.6 tombstone)", () => {
  it("syncs as a no-op without calling Plaid or decrypting the dead token", async () => {
    await pool.query(
      `UPDATE plaid_items
          SET status = 'removed', removed_at = now(),
              purge_after = now() + interval '30 days',
              access_token_ciphertext = ''
        WHERE id = $1`,
      [itemId],
    );
    try {
      const mock = createSyncMock([page1]);
      const sync = createTransactionSync({ client: mock.client, secrets });

      const summary = await sync.syncItem(db, itemId);

      // The access token is dead at Plaid: calling would fail and make
      // the scheduled catch-up crash-loop on a deleted connection.
      expect(summary).toEqual({
        pages: 0,
        added: 0,
        modified: 0,
        removed: 0,
        restarts: 0,
      });
      expect(mock.calls).toHaveLength(0);
    } finally {
      await pool.query(
        `UPDATE plaid_items
            SET status = 'active', removed_at = NULL, purge_after = NULL,
                access_token_ciphertext = $2
          WHERE id = $1`,
        [itemId, secrets.encrypt(ACCESS_PLAINTEXT)],
      );
    }
  });
});

describe("freshness watermark (Step 2.2)", () => {
  it("advances last_synced_at with the cursor commit", async () => {
    await pool.query(
      "UPDATE plaid_items SET last_synced_at = '2020-01-01T00:00:00Z' WHERE id = $1",
      [itemId],
    );
    const before = (
      await pool.query("SELECT last_synced_at FROM plaid_items WHERE id = $1", [
        itemId,
      ])
    ).rows[0] as { last_synced_at: Date };

    const mock = createSyncMock([page3]);
    const sync = createTransactionSync({ client: mock.client, secrets });
    await sync.syncItem(db, itemId);

    const after = (
      await pool.query("SELECT last_synced_at FROM plaid_items WHERE id = $1", [
        itemId,
      ])
    ).rows[0] as { last_synced_at: Date };
    expect(new Date(after.last_synced_at).getTime()).toBeGreaterThan(
      new Date(before.last_synced_at).getTime(),
    );
  });
});

/** Deterministic PRNG so the property test is CI-stable. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(values: number[], rand: () => number): number[] {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a !== undefined && b !== undefined) {
      out[i] = b;
      out[j] = a;
    }
  }
  return out;
}

describe("property: interleavings converge", () => {
  it("prefix-replay interleavings leave the same state as a clean sync", async () => {
    // Each fixture page becomes a single-run page (has_more false) so
    // one syncItem call applies exactly one queue entry.
    const pages: SyncPage[] = [page1, page2, page3].map((page) => ({
      ...page,
      has_more: false,
    }));

    const runSync = async (script: ScriptStep[]): Promise<number> => {
      await pool.query("TRUNCATE transactions CASCADE");
      await pool.query("UPDATE plaid_items SET sync_cursor = NULL");
      const mock = createSyncMock(script);
      const sync = createTransactionSync({ client: mock.client, secrets });
      let applied = 0;
      for (let i = 0; i < script.length; i += 1) {
        const summary = await sync.syncItem(db, itemId);
        applied += summary.pages;
      }
      return applied;
    };

    // Reference: one clean sync, pages in canonical order.
    const referenceApplied = await runSync(pages);
    expect(referenceApplied).toBe(3);
    const reference = (await pool.query(snapshotSql)).rows;

    for (let seed = 1; seed <= 12; seed += 1) {
      const rand = mulberry32(seed);
      // Random prefix-runs (replays after crash/restart), always
      // finishing with a full run so every page is delivered.
      const runLengths = shuffled([1, 2, 3, 2], rand);
      runLengths.push(3);
      const flat = runLengths.flatMap((length) => pages.slice(0, length));

      const applied = await runSync(flat);
      expect(applied, `seed ${seed} page count`).toBe(flat.length);
      const state = (await pool.query(snapshotSql)).rows;
      expect(state, `seed ${seed} state`).toEqual(reference);
    }
  });
});

/**
 * Step 1.6 — unsubscribe = /item/remove (plan: TDT state machine).
 *
 * The plan's chain, pinned end to end:
 *   cancel subscription → /item/remove called → access token
 *   invalidated (Plaid billing stops there) → local data enters the
 *   deletion schedule (tombstone + purge_after; the purge job itself
 *   is Phase 6.3).
 *
 * Correctness properties asserted here:
 * - **Order**: the Stripe cancel runs BEFORE any Plaid removal — if it
 *   fails, nothing else happened (retry re-runs cleanly).
 * - **Idempotency**: a second run makes zero Plaid calls, never
 *   re-cancels, and never moves an existing purge_after.
 * - **Billing-ended codes**: ITEM_NOT_FOUND / INVALID_ACCESS_TOKEN
 *   mean no valid access_token exists — Plaid stops billing on token
 *   validity, so these count as success, not failure.
 * - **Partial failure**: one dead item never blocks the rest; failed
 *   items stay active with their credentials intact for a retry.
 * - **Data minimization**: removal zeroes the stored access-token
 *   ciphertext (the token is dead at Plaid; keeping it only widens a
 *   breach) and stamps purge_after.
 * - **No credential echo**: the decrypted token reaches the Plaid call
 *   and nowhere else — never the summary, never an error message.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { eq } from "drizzle-orm";
import { createScratchDatabase } from "../helpers/scratch-db";
import { createDb, type Db } from "../../src/db/tenancy";
import { entitlements } from "../../src/db/schema/billing";
import {
  UnsubscribeConfigError,
  createUnsubscribe,
  type ItemRemoveClient,
} from "../../src/billing/unsubscribe";
import { ENCRYPTION_KEY_BYTES, createSecretBox } from "../../src/plaid/secrets";

const DB = "finbrief_unsubscribe_test";
const ORG_ID = "org_unsub_1";
const ROOT_KEY = randomBytes(ENCRYPTION_KEY_BYTES).toString("base64");
const secrets = createSecretBox(ROOT_KEY);
const RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;

let scratch: Awaited<ReturnType<typeof createScratchDatabase>>;
let pool: Pool;
let db: Db;

interface RemoveMock {
  client: ItemRemoveClient;
  /** Access tokens the client received, in call order. */
  calls: string[];
}

/** Scripted mock: per-token error code; otherwise success. */
function createRemoveMock(failures: Record<string, string> = {}): RemoveMock {
  const calls: string[] = [];
  return {
    calls,
    client: {
      itemRemove: async (params) => {
        calls.push(params.access_token);
        const code = failures[params.access_token];
        if (code) {
          throw { response: { data: { error_code: code } } };
        }
        return { data: { removed: true, request_id: "req-1" } };
      },
    },
  };
}

async function insertItem(
  plaintextToken: string,
  status = "active",
): Promise<string> {
  const inserted = await pool.query(
    `INSERT INTO plaid_items
       (id, organization_id, item_id_ciphertext, access_token_ciphertext,
        item_id_index, status, created_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, now())
     RETURNING id`,
    [
      ORG_ID,
      secrets.encrypt(`item-of-${plaintextToken}`),
      secrets.encrypt(plaintextToken),
      secrets.index(plaintextToken),
      status,
    ],
  );
  return (inserted.rows[0] as { id: string }).id;
}

interface ItemRow {
  status: string;
  stale_reason: string | null;
  removed_at: Date | null;
  purge_after: Date | null;
  access_token_ciphertext: string;
}

async function itemState(id: string): Promise<ItemRow> {
  const rows = await pool.query(
    `SELECT status, stale_reason, removed_at, purge_after,
            access_token_ciphertext
       FROM plaid_items WHERE id = $1`,
    [id],
  );
  return rows.rows[0] as ItemRow;
}

async function seedEntitlement(
  overrides: Partial<{
    status: string;
    stripeSubscriptionId: string | null;
  }> = {},
): Promise<void> {
  const subscriptionId =
    "stripeSubscriptionId" in overrides
      ? overrides.stripeSubscriptionId
      : "sub_123";
  await db
    .insert(entitlements)
    .values({
      organizationId: ORG_ID,
      plan: "pro",
      status: overrides.status ?? "active",
      stripeSubscriptionId: subscriptionId,
      includedCredits: 100,
    })
    .onConflictDoUpdate({
      target: entitlements.organizationId,
      set: {
        status: overrides.status ?? "active",
        stripeSubscriptionId: subscriptionId,
      },
    });
}

beforeAll(async () => {
  scratch = await createScratchDatabase(DB);
  await scratch.migrate();
  pool = scratch.pool;
  db = createDb(pool);
  await pool.query(
    `INSERT INTO organization (id, name, slug, created_at)
     VALUES ($1, 'Org', 'unsub-org', now())
     ON CONFLICT (id) DO NOTHING`,
    [ORG_ID],
  );
}, 60_000);

afterAll(async () => {
  await scratch?.destroy();
});

beforeEach(async () => {
  await pool.query(
    "TRUNCATE plaid_items, entitlements, run_credit_accounts, run_credit_entries, webhook_events CASCADE",
  );
});

describe("createUnsubscribe config", () => {
  it("rejects a non-integer or negative retention window", () => {
    const base = {
      client: createRemoveMock().client,
      secrets,
      cancelSubscription: async () => undefined,
    };
    expect(() => createUnsubscribe({ ...base, retentionDays: -1 })).toThrow(
      UnsubscribeConfigError,
    );
    expect(() => createUnsubscribe({ ...base, retentionDays: 1.5 })).toThrow(
      UnsubscribeConfigError,
    );
  });
});

describe("unsubscribeOrganization", () => {
  it("cancels the subscription, removes every item, and schedules the purge", async () => {
    const plainA = "plaid-access-a";
    const plainB = "plaid-access-b";
    const itemA = await insertItem(plainA);
    const itemB = await insertItem(plainB, "stale");
    await seedEntitlement();

    const cancels: string[] = [];
    const mock = createRemoveMock();
    const unsubscribe = createUnsubscribe({
      client: mock.client,
      secrets,
      cancelSubscription: async (id) => {
        cancels.push(id);
      },
      retentionDays: RETENTION_DAYS,
    });

    const summary = await unsubscribe.unsubscribeOrganization(db, ORG_ID);

    expect(cancels).toEqual(["sub_123"]);
    expect(mock.calls.sort()).toEqual([plainA, plainB].sort());
    expect(summary).toMatchObject({
      subscriptionCanceled: true,
      removed: 2,
      alreadyRemoved: 0,
      failed: 0,
    });

    const now = Date.now();
    for (const id of [itemA, itemB]) {
      const row = await itemState(id);
      expect(row.status).toBe("removed");
      expect(row.stale_reason).toBeNull();
      expect(row.removed_at).not.toBeNull();
      expect(row.purge_after).not.toBeNull();
      const purgeMs = (row.purge_after as Date).getTime();
      const removedMs = (row.removed_at as Date).getTime();
      expect(purgeMs - removedMs).toBeCloseTo(RETENTION_DAYS * DAY_MS, -4);
      expect(Math.abs(purgeMs - (now + RETENTION_DAYS * DAY_MS))).toBeLessThan(
        5_000,
      );
      // Data minimization: the dead token's ciphertext is zeroed.
      expect(row.access_token_ciphertext).toBe("");
    }
    expect(summary.purgeAfter).toBeInstanceOf(Date);
  });

  it("never echoes the decrypted token into the summary", async () => {
    const plain = "plaid-access-credential-0009";
    await insertItem(plain);
    await seedEntitlement();
    const mock = createRemoveMock();
    const unsubscribe = createUnsubscribe({
      client: mock.client,
      secrets,
      cancelSubscription: async () => undefined,
      retentionDays: RETENTION_DAYS,
    });
    const summary = await unsubscribe.unsubscribeOrganization(db, ORG_ID);
    expect(JSON.stringify(summary)).not.toContain(plain);
  });

  it("is idempotent — a second run makes no Plaid calls and moves no purge date", async () => {
    const plain = "plaid-access-a";
    const itemId = await insertItem(plain);
    await seedEntitlement();
    const cancels: string[] = [];
    const unsubscribe = createUnsubscribe({
      client: createRemoveMock().client,
      secrets,
      cancelSubscription: async (id) => {
        cancels.push(id);
      },
      retentionDays: RETENTION_DAYS,
    });

    const first = await unsubscribe.unsubscribeOrganization(db, ORG_ID);
    expect(first.removed).toBe(1);
    const firstPurge = (await itemState(itemId)).purge_after;

    // What Step 0.4's Stripe webhook does once Stripe confirms the
    // cancel: the entitlement drops to canceled. A second run after
    // that must not re-cancel.
    await db
      .update(entitlements)
      .set({ status: "canceled" })
      .where(eq(entitlements.organizationId, ORG_ID));

    const secondMock = createRemoveMock();
    const secondUnsubscribe = createUnsubscribe({
      client: secondMock.client,
      secrets,
      cancelSubscription: async () => undefined,
      retentionDays: RETENTION_DAYS,
    });
    const second = await secondUnsubscribe.unsubscribeOrganization(db, ORG_ID);

    expect(secondMock.calls).toEqual([]);
    expect(second).toMatchObject({
      subscriptionCanceled: false,
      removed: 0,
      alreadyRemoved: 1,
      failed: 0,
    });
    expect(cancels).toEqual(["sub_123"]);
    expect((await itemState(itemId)).purge_after).toEqual(firstPurge);
  });

  it("skips the Stripe cancel when there is no active entitled subscription", async () => {
    const scenario = async (
      entitlement: Parameters<typeof seedEntitlement>[0] | null,
    ) => {
      await pool.query("TRUNCATE plaid_items CASCADE");
      if (entitlement === null) {
        await pool.query("TRUNCATE entitlements");
      } else {
        await seedEntitlement(entitlement);
      }
      await insertItem("plaid-access-a");
      const cancels: string[] = [];
      const mock = createRemoveMock();
      const unsubscribe = createUnsubscribe({
        client: mock.client,
        secrets,
        cancelSubscription: async (id) => {
          cancels.push(id);
        },
        retentionDays: RETENTION_DAYS,
      });
      const summary = await unsubscribe.unsubscribeOrganization(db, ORG_ID);
      expect(cancels).toEqual([]);
      expect(summary.subscriptionCanceled).toBe(false);
      expect(summary.removed).toBe(1);
    };
    // No entitlement row at all; already canceled; active but without
    // a Stripe subscription id.
    await scenario(null);
    await scenario({ status: "canceled" });
    await scenario({ stripeSubscriptionId: null });
  });

  it("aborts before touching items when the subscription cancel fails", async () => {
    const itemId = await insertItem("plaid-access-a");
    await seedEntitlement();
    const mock = createRemoveMock();
    const unsubscribe = createUnsubscribe({
      client: mock.client,
      secrets,
      cancelSubscription: async () => {
        throw new Error("stripe down");
      },
      retentionDays: RETENTION_DAYS,
    });

    await expect(
      unsubscribe.unsubscribeOrganization(db, ORG_ID),
    ).rejects.toThrow("stripe down");

    expect(mock.calls).toEqual([]);
    const row = await itemState(itemId);
    expect(row.status).toBe("active");
    expect(row.access_token_ciphertext).not.toBe("");
    expect(row.purge_after).toBeNull();
  });

  it("treats ITEM_NOT_FOUND and INVALID_ACCESS_TOKEN as billing already stopped", async () => {
    const plainDead = "plaid-access-dead";
    const plainRevoked = "plaid-access-revoked";
    const itemDead = await insertItem(plainDead);
    const itemRevoked = await insertItem(plainRevoked);
    await seedEntitlement();
    const mock = createRemoveMock({
      [plainDead]: "ITEM_NOT_FOUND",
      [plainRevoked]: "INVALID_ACCESS_TOKEN",
    });
    const unsubscribe = createUnsubscribe({
      client: mock.client,
      secrets,
      cancelSubscription: async () => undefined,
      retentionDays: RETENTION_DAYS,
    });

    const summary = await unsubscribe.unsubscribeOrganization(db, ORG_ID);
    expect(summary).toMatchObject({ removed: 2, failed: 0 });
    expect((await itemState(itemDead)).status).toBe("removed");
    expect((await itemState(itemRevoked)).status).toBe("removed");
  });

  it("collects failures without aborting; a retry finishes the job", async () => {
    const plainOk = "plaid-access-ok";
    const plainFlaky = "plaid-access-flaky";
    const itemOk = await insertItem(plainOk);
    const itemFlaky = await insertItem(plainFlaky);
    await seedEntitlement({ stripeSubscriptionId: null });
    const failing = createRemoveMock({ [plainFlaky]: "API_UNAVAILABLE" });
    const unsubscribe = createUnsubscribe({
      client: failing.client,
      secrets,
      cancelSubscription: async () => undefined,
      retentionDays: RETENTION_DAYS,
    });

    const summary = await unsubscribe.unsubscribeOrganization(db, ORG_ID);
    expect(summary).toMatchObject({ removed: 1, failed: 1 });
    expect((await itemState(itemOk)).status).toBe("removed");
    // The failed item keeps its credentials so the retry can call Plaid.
    const flakyRow = await itemState(itemFlaky);
    expect(flakyRow.status).toBe("active");
    expect(flakyRow.access_token_ciphertext).not.toBe("");
    expect(flakyRow.purge_after).toBeNull();

    const retryMock = createRemoveMock();
    const retry = createUnsubscribe({
      client: retryMock.client,
      secrets,
      cancelSubscription: async () => undefined,
      retentionDays: RETENTION_DAYS,
    });
    const retrySummary = await retry.unsubscribeOrganization(db, ORG_ID);
    expect(retryMock.calls).toEqual([plainFlaky]);
    expect(retrySummary).toMatchObject({
      removed: 1,
      alreadyRemoved: 1,
      failed: 0,
    });
    expect((await itemState(itemFlaky)).status).toBe("removed");
  });

  it("handles an organization with no items or entitlement", async () => {
    const mock = createRemoveMock();
    const unsubscribe = createUnsubscribe({
      client: mock.client,
      secrets,
      cancelSubscription: async () => undefined,
      retentionDays: RETENTION_DAYS,
    });
    const summary = await unsubscribe.unsubscribeOrganization(
      db,
      "org_with_nothing",
    );
    expect(summary).toEqual({
      subscriptionCanceled: false,
      removed: 0,
      alreadyRemoved: 0,
      failed: 0,
      purgeAfter: null,
    });
    expect(mock.calls).toEqual([]);
  });

  it("works without a cancelSubscription seam for item-only removal", async () => {
    const itemId = await insertItem("plaid-access-a");
    await seedEntitlement();
    const mock = createRemoveMock();
    const unsubscribe = createUnsubscribe({
      client: mock.client,
      secrets,
      retentionDays: RETENTION_DAYS,
    });
    const summary = await unsubscribe.unsubscribeOrganization(db, ORG_ID);
    expect(summary.subscriptionCanceled).toBe(false);
    expect((await itemState(itemId)).status).toBe("removed");
  });

  it("does not resurrect a removed item's tombstone when cancel is retried", async () => {
    const itemId = await insertItem("plaid-access-a");
    await seedEntitlement();
    let failFirst = true;
    const mock = createRemoveMock();
    const unsubscribe = createUnsubscribe({
      client: mock.client,
      secrets,
      cancelSubscription: async () => {
        if (failFirst) {
          failFirst = false;
          throw new Error("stripe down");
        }
      },
      retentionDays: RETENTION_DAYS,
    });

    await expect(
      unsubscribe.unsubscribeOrganization(db, ORG_ID),
    ).rejects.toThrow("stripe down");
    const summary = await unsubscribe.unsubscribeOrganization(db, ORG_ID);
    expect(summary).toMatchObject({ subscriptionCanceled: true, removed: 1 });
    expect((await itemState(itemId)).status).toBe("removed");
    // Item removed exactly once — no duplicate Plaid call for it.
    expect(mock.calls).toEqual(["plaid-access-a"]);
  });
});

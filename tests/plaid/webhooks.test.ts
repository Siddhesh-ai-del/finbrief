/**
 * Step 1.4b — webhook state machine (plan: state transitions that
 * close the stale-data-as-current gap, §2.7).
 *
 * The item row is looked up by keyed HMAC index (payloads carry
 * Plaid's plaintext item id — the same credential-free rule as
 * Step 1.2). Transitions pinned here:
 * - SYNC_UPDATES_AVAILABLE → run sync (idempotent, status untouched)
 * - TRANSACTIONS_REMOVED → delete rows for THIS item only
 * - four ITEM codes → active→stale with a reason; the notify seam
 *   fires once per transition, so webhook retries don't re-notify
 * - unknown code / unknown item → acknowledged no-op (a 500 here
 *   would make Plaid retry forever)
 */
import { randomBytes } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { Pool } from "pg";
import { createScratchDatabase } from "../helpers/scratch-db";
import { createDb, type Db } from "../../src/db/tenancy";
import {
  createWebhookHandler,
  type PlaidWebhookPayload,
  type StaleNotice,
} from "../../src/plaid/webhooks/handler";
import { ENCRYPTION_KEY_BYTES, createSecretBox } from "../../src/plaid/secrets";

const DB = "finbrief_plaid_webhooks_test";
const ORG_ID = "org_webhook_1";
const ROOT_KEY = randomBytes(ENCRYPTION_KEY_BYTES).toString("base64");
const ITEM_PLAINTEXT = "plaid-item-identifier-0001";
const secrets = createSecretBox(ROOT_KEY);

let scratch: Awaited<ReturnType<typeof createScratchDatabase>>;
let pool: Pool;
let db: Db;
let ourItemId: string;
let syncItem: Mock<(itemId: string) => Promise<unknown>>;
let onStale: Mock<(notice: StaleNotice) => void>;
let handler: ReturnType<typeof createWebhookHandler>;

function payload(
  webhookCode: string,
  overrides: Partial<PlaidWebhookPayload> = {},
): PlaidWebhookPayload {
  return {
    webhook_type: "ITEM",
    webhook_code: webhookCode,
    item_id: ITEM_PLAINTEXT,
    environment: "sandbox",
    ...overrides,
  };
}

/** Insert a transaction row directly (minimal required columns). */
async function insertTxn(
  plaidItemId: string,
  plaidTransactionId: string,
  organizationId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO transactions
       (id, organization_id, plaid_item_id, plaid_transaction_id, date,
        amount_cents, name, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, '2026-01-15', 1000, $4,
             now(), now())`,
    [
      organizationId,
      plaidItemId,
      plaidTransactionId,
      `name ${plaidTransactionId}`,
    ],
  );
}

async function itemState(): Promise<{
  status: string;
  stale_reason: string | null;
}> {
  const rows = await pool.query(
    "SELECT status, stale_reason FROM plaid_items WHERE id = $1",
    [ourItemId],
  );
  return rows.rows[0] as { status: string; stale_reason: string | null };
}

beforeAll(async () => {
  scratch = await createScratchDatabase(DB);
  await scratch.migrate();
  pool = scratch.pool;
  db = createDb(pool);

  await pool.query(
    `INSERT INTO organization (id, name, slug, created_at)
     VALUES ($1, 'Org', 'webhook-org', now())`,
    [ORG_ID],
  );
  const inserted = await pool.query(
    `INSERT INTO plaid_items
       (id, organization_id, item_id_ciphertext, access_token_ciphertext,
        item_id_index, created_at)
     VALUES ($1, $2, $3, $4, $5, now())
     RETURNING id`,
    [
      "item_webhook_1",
      ORG_ID,
      secrets.encrypt(ITEM_PLAINTEXT),
      secrets.encrypt("plaid-access-credential-0001"),
      secrets.index(ITEM_PLAINTEXT),
    ],
  );
  ourItemId = (inserted.rows[0] as { id: string }).id;
}, 60_000);

afterAll(async () => {
  await scratch?.destroy();
});

beforeEach(async () => {
  await pool.query("TRUNCATE transactions");
  await pool.query(
    `UPDATE plaid_items
        SET status = 'active', stale_reason = NULL,
            access_token_ciphertext = $2
      WHERE id = $1`,
    [ourItemId, secrets.encrypt("plaid-access-credential-0001")],
  );
  syncItem = vi.fn(async () => ({ pages: 0 }));
  onStale = vi.fn();
  handler = createWebhookHandler({ syncItem, onStale, secrets });
});

describe("SYNC_UPDATES_AVAILABLE", () => {
  it("runs sync for our item and leaves status untouched", async () => {
    const outcome = await handler.handle(
      db,
      payload("SYNC_UPDATES_AVAILABLE", { webhook_type: "TRANSACTIONS" }),
    );

    expect(outcome).toBe("synced");
    expect(syncItem).toHaveBeenCalledTimes(1);
    expect(syncItem).toHaveBeenCalledWith(ourItemId);
    expect(await itemState()).toEqual({
      status: "active",
      stale_reason: null,
    });
    expect(onStale).not.toHaveBeenCalled();
  });
});

describe("removed items (Step 1.6 tombstones)", () => {
  it("ignores SYNC_UPDATES_AVAILABLE for a removed item — no sync, no resurrection", async () => {
    await pool.query(
      `UPDATE plaid_items
          SET status = 'removed', removed_at = now(),
              purge_after = now() + interval '30 days',
              access_token_ciphertext = ''
        WHERE id = $1`,
      [ourItemId],
    );

    const outcome = await handler.handle(
      db,
      payload("SYNC_UPDATES_AVAILABLE", { webhook_type: "TRANSACTIONS" }),
    );

    // Acknowledged so Plaid stops retrying; nothing else happens —
    // the access token is dead at Plaid, so syncing would only 500.
    expect(outcome).toBe("ignored");
    expect(syncItem).not.toHaveBeenCalled();
    expect(await itemState()).toEqual({
      status: "removed",
      stale_reason: null,
    });
  });

  it("a stale-transition code does not overwrite a removed tombstone", async () => {
    await pool.query(
      `UPDATE plaid_items
          SET status = 'removed', removed_at = now(),
              purge_after = now() + interval '30 days'
        WHERE id = $1`,
      [ourItemId],
    );

    const outcome = await handler.handle(db, payload("ITEM_LOGIN_REQUIRED"));

    expect(outcome).toBe("ignored");
    expect(await itemState().then((s) => s.status)).toBe("removed");
    expect(onStale).not.toHaveBeenCalled();
  });
});

describe("TRANSACTIONS_REMOVED", () => {
  it("deletes only this item's removed rows", async () => {
    // A second item (separate tenant row) with its own transaction.
    const second = await pool.query(
      `INSERT INTO plaid_items
         (id, organization_id, item_id_ciphertext, access_token_ciphertext,
          item_id_index, created_at)
       VALUES ($1, $2, $3, $4, $5, now()) RETURNING id`,
      [
        "item_webhook_2",
        ORG_ID,
        secrets.encrypt("plaid-item-identifier-0002"),
        secrets.encrypt("plaid-access-credential-0002"),
        secrets.index("plaid-item-identifier-0002"),
      ],
    );
    const secondId = (second.rows[0] as { id: string }).id;

    await insertTxn(ourItemId, "txn_gone", ORG_ID);
    await insertTxn(ourItemId, "txn_stays", ORG_ID);
    await insertTxn(secondId, "txn_gone", ORG_ID); // same txn id, other item

    const outcome = await handler.handle(
      db,
      payload("TRANSACTIONS_REMOVED", {
        webhook_type: "TRANSACTIONS",
        removed_transactions: ["txn_gone"],
      }),
    );

    expect(outcome).toBe("removed");
    const remaining = (
      await pool.query(
        "SELECT plaid_transaction_id FROM transactions ORDER BY 1",
      )
    ).rows as { plaid_transaction_id: string }[];
    // Our "txn_gone" is deleted; "txn_stays" plus the OTHER item's
    // identically-named row survive — removals are item-scoped.
    expect(remaining.map((r) => r.plaid_transaction_id)).toEqual([
      "txn_gone",
      "txn_stays",
    ]);
    expect(syncItem).not.toHaveBeenCalled();
  });

  it("is a no-op when removed_transactions is absent or empty", async () => {
    await insertTxn(ourItemId, "txn_stays", ORG_ID);
    const outcome = await handler.handle(
      db,
      payload("TRANSACTIONS_REMOVED", { webhook_type: "TRANSACTIONS" }),
    );
    expect(outcome).toBe("removed");
    expect((await pool.query("SELECT 1 FROM transactions")).rowCount).toBe(1);
  });
});

describe("stale transitions (the §2.7 mitigation)", () => {
  const cases: [string, string][] = [
    ["ITEM_LOGIN_REQUIRED", "login_required"],
    ["PENDING_EXPIRATION", "pending_expiration"],
    ["PENDING_DISCONNECT", "pending_disconnect"],
    ["USER_PERMISSION_REVOKED", "permission_revoked"],
  ];

  for (const [code, reason] of cases) {
    it(`${code} marks the item stale as "${reason}" and notifies once`, async () => {
      const outcome = await handler.handle(db, payload(code));

      expect(outcome).toBe("stale");
      expect(await itemState()).toEqual({
        status: "stale",
        stale_reason: reason,
      });
      expect(onStale).toHaveBeenCalledTimes(1);
      const notice = onStale.mock.calls[0]?.[0] as StaleNotice;
      expect(notice).toEqual({
        itemId: ourItemId,
        organizationId: ORG_ID,
        reason,
        webhookCode: code,
      });
    });
  }

  it("webhook retry (same code again) does not re-notify", async () => {
    await handler.handle(db, payload("ITEM_LOGIN_REQUIRED"));
    const outcome = await handler.handle(db, payload("ITEM_LOGIN_REQUIRED"));

    expect(outcome).toBe("stale");
    expect(await itemState().then((s) => s.status)).toBe("stale");
    expect(onStale).toHaveBeenCalledTimes(1);
  });

  it("a DIFFERENT stale reason counts as a new transition", async () => {
    await handler.handle(db, payload("ITEM_LOGIN_REQUIRED"));
    const outcome = await handler.handle(
      db,
      payload("USER_PERMISSION_REVOKED"),
    );

    expect(outcome).toBe("stale");
    expect(await itemState()).toEqual({
      status: "stale",
      stale_reason: "permission_revoked",
    });
    expect(onStale).toHaveBeenCalledTimes(2);
  });
});

describe("unknown input", () => {
  it("acknowledges an unknown webhook code without state change", async () => {
    const outcome = await handler.handle(db, payload("ITEM_UPDATED"));
    expect(outcome).toBe("ignored");
    expect(await itemState().then((s) => s.status)).toBe("active");
    expect(syncItem).not.toHaveBeenCalled();
    expect(onStale).not.toHaveBeenCalled();
  });

  it("acknowledges a webhook for an item we no longer hold", async () => {
    const outcome = await handler.handle(
      db,
      payload("ITEM_LOGIN_REQUIRED", { item_id: "deleted-item-id" }),
    );
    expect(outcome).toBe("ignored");
    expect(syncItem).not.toHaveBeenCalled();
    expect(onStale).not.toHaveBeenCalled();
  });
});

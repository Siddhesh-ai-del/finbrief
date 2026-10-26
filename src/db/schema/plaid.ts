/**
 * Plaid item storage (plan Step 1.2).
 *
 * Credentials are encrypted at rest: the plaintext `access_token` and
 * `item_id` exist only inside AES-256-GCM ciphertext columns (see
 * src/plaid/secrets.ts). The one searchable surface is
 * `item_id_index` — a keyed HMAC digest — so webhook and sync lookups
 * can find an item without a plaintext column or a decrypt-scan, and
 * a unique index on it makes re-linking the same item exactly-once.
 *
 * Organization FKs cascade (an item dies with its tenant, matching
 * consent_records and the billing tables).
 */
import { randomUUID } from "node:crypto";
import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization } from "./organization";

const ts = (name: string) => timestamp(name, { withTimezone: true });

export const plaidItems = pgTable(
  "plaid_items",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    itemIdCiphertext: text("item_id_ciphertext").notNull(),
    accessTokenCiphertext: text("access_token_ciphertext").notNull(),
    itemIdIndex: text("item_id_index").notNull(),
    /**
     * Watermark for /transactions/sync (Step 1.3). Committed in the
     * same transaction as the page it advances, so it is always a
     * resume point, never ahead of applied data. Null = never synced.
     */
    syncCursor: text("sync_cursor"),
    /**
     * Lifecycle (Step 1.4 + 1.6): `stale` means the connection lost
     * login/permission and its data must not be presented as
     * current; `removed` means unsubscribe ran /item/remove — Plaid
     * has invalidated the access token (billing stops there) and the
     * row is now a tombstone whose data is retained only until
     * `purge_after` (Phase 6.3's deletion job). The status is the
     * suppression source Phase 4's briefing reads; transitions are
     * applied by the webhook state machine (src/plaid/webhooks/
     * handler.ts) and unsubscribe (src/billing/unsubscribe.ts).
     */
    status: text("status").notNull().default("active"),
    staleReason: text("stale_reason"),
    statusChangedAt: ts("status_changed_at").notNull().defaultNow(),
    /** Set when unsubscribe removes the item (Step 1.6). */
    removedAt: ts("removed_at"),
    /**
     * When the tombstone and its cascading transactions become
     * eligible for deletion — `removed_at` plus the configured
     * retention window (Step 1.6; the purge job is Phase 6.3).
     */
    purgeAfter: ts("purge_after"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("plaid_items_org_idx").on(t.organizationId),
    uniqueIndex("plaid_items_item_id_idx").on(t.itemIdIndex),
  ],
);

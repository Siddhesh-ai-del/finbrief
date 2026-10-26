/**
 * Plaid webhook dispatch + item state machine (plan Step 1.4).
 *
 * This is the mitigation for the stale-data-as-current gap (§2.7):
 * an item that has lost login or permission is marked `stale` with a
 * machine-readable reason, and that status is the single source the
 * briefing consults — stale data is never presented as current.
 *
 * Transitions (table pinned in tests/plaid/webhooks.test.ts):
 * - `TRANSACTIONS/SYNC_UPDATES_AVAILABLE` → run /transactions/sync.
 *   Sync is idempotent (Step 1.3), so a lost webhook just means a
 *   later one — or the scheduled catch-up — closes the gap.
 * - `TRANSACTIONS/TRANSACTIONS_REMOVED` → delete those rows, scoped
 *   to the webhook's item (a removal never crosses items).
 * - `ITEM/ITEM_LOGIN_REQUIRED`, `PENDING_EXPIRATION`,
 *   `PENDING_DISCONNECT`, `USER_PERMISSION_REVOKED` → active→stale
 *   with a mapped reason; the notify seam fires once per TRANSITION
 *   so Plaid's delivery retries don't re-notify. (The delivery
 *   channel itself lands with the notification step; until then the
 *   seam is the contract.)
 * - anything else → `ignored`: unknown codes and unknown items are
 *   acknowledged, never 500'd — Plaid retries non-2xx forever.
 *
 * Lookup goes through the keyed HMAC index (`item_id_index`), not a
 * plaintext column: webhook payloads carry Plaid's plaintext item id,
 * and the credential-free rule from Step 1.2 applies here too.
 */
import { and, eq, inArray } from "drizzle-orm";
import { plaidItems } from "../../db/schema/plaid";
import { transactions } from "../../db/schema/transactions";
import type { Db } from "../../db/tenancy";
import type { SecretBox } from "../secrets";

export interface PlaidWebhookPayload {
  webhook_type: string;
  webhook_code: string;
  item_id: string;
  environment?: string;
  error?: {
    error_code?: string;
    error_message?: string;
    display_message?: string | null;
  } | null;
  removed_transactions?: string[];
}

export type ItemStaleReason =
  | "login_required"
  | "pending_expiration"
  | "pending_disconnect"
  | "permission_revoked";

/** What the notify seam receives — enough to build user-facing copy. */
export interface StaleNotice {
  itemId: string;
  organizationId: string;
  reason: ItemStaleReason;
  webhookCode: string;
}

/** Result of handling one webhook — asserted by tests and the route. */
export type WebhookOutcome = "synced" | "removed" | "stale" | "ignored";

export interface WebhookHandlerOptions {
  /** Run /transactions/sync for one of OUR item ids. */
  syncItem: (itemId: string) => Promise<unknown>;
  /**
   * Fired exactly once per active→stale (or reason-change)
   * transition. The notification channel wires in later; this seam
   * is what "user notified" pins today.
   */
  onStale?: (notice: StaleNotice) => void | Promise<void>;
  /** Keyed index over Plaid's plaintext item id (see module doc). */
  secrets: SecretBox;
}

const STALE_TRANSITIONS: Record<string, ItemStaleReason> = {
  ITEM_LOGIN_REQUIRED: "login_required",
  PENDING_EXPIRATION: "pending_expiration",
  PENDING_DISCONNECT: "pending_disconnect",
  USER_PERMISSION_REVOKED: "permission_revoked",
};

export function createWebhookHandler(options: WebhookHandlerOptions) {
  async function handle(
    runner: Db,
    payload: PlaidWebhookPayload,
  ): Promise<WebhookOutcome> {
    const rows = await runner
      .select({
        id: plaidItems.id,
        organizationId: plaidItems.organizationId,
        status: plaidItems.status,
        staleReason: plaidItems.staleReason,
      })
      .from(plaidItems)
      .where(eq(plaidItems.itemIdIndex, options.secrets.index(payload.item_id)))
      .limit(1);
    const item = rows[0];
    if (!item) {
      // Deleted item or a webhook for a link we never stored —
      // acknowledge so Plaid stops retrying.
      return "ignored";
    }

    // Step 1.6 tombstone: /item/remove invalidated the access token
    // at Plaid, so there is nothing to sync and nothing to grow stale
    // about — acknowledge every code without touching state (a stale
    // transition here would overwrite the tombstone).
    if (item.status === "removed") {
      return "ignored";
    }

    const { webhook_type: type, webhook_code: code } = payload;

    if (type === "TRANSACTIONS" && code === "SYNC_UPDATES_AVAILABLE") {
      await options.syncItem(item.id);
      return "synced";
    }

    if (type === "TRANSACTIONS" && code === "TRANSACTIONS_REMOVED") {
      const removedIds = (payload.removed_transactions ?? []).filter(
        (id) => id.length > 0,
      );
      if (removedIds.length > 0) {
        await runner
          .delete(transactions)
          .where(
            and(
              eq(transactions.plaidItemId, item.id),
              inArray(transactions.plaidTransactionId, removedIds),
            ),
          );
      }
      return "removed";
    }

    const reason = STALE_TRANSITIONS[code];
    if (reason) {
      const isTransition =
        item.status !== "stale" || item.staleReason !== reason;
      if (isTransition) {
        await runner
          .update(plaidItems)
          .set({
            status: "stale",
            staleReason: reason,
            statusChangedAt: new Date(),
          })
          .where(eq(plaidItems.id, item.id));
        await options.onStale?.({
          itemId: item.id,
          organizationId: item.organizationId,
          reason,
          webhookCode: code,
        });
      }
      return "stale";
    }

    return "ignored";
  }

  return { handle };
}

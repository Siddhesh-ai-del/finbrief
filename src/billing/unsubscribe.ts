/**
 * Unsubscribe = /item/remove (plan Step 1.6).
 *
 * Plaid bills monthly for every Item while a valid `access_token`
 * exists for it; `/item/remove` is the only thing that ends that
 * (§3.1 — billing is keyed to token validity, and it is not
 * pro-rated). This module is the orchestration the plan's TDT chain
 * pins, in order:
 *
 *   1. **Cancel the Stripe subscription** (through the injected seam).
 *      Step 0.4's webhook then drops the entitlement exactly once when
 *      Stripe confirms — we do not update entitlements here, so there
 *      is one authority for that state and it keeps its exactly-once
 *      claim. A cancel failure aborts the whole run before any item
 *      is touched: the user must not lose the Plaid connection while
 *      still paying.
 *   2. **Call /item/remove per item** with the decrypted access token
 *      (the credential lives only in local scope — same rule as Step
 *      1.2/1.3). `ITEM_NOT_FOUND` and `INVALID_ACCESS_TOKEN` count as
 *      SUCCESS: Plaid stops billing on token validity, so an already-
 *      dead token means billing already stopped. Any other upstream
 *      failure is collected, not thrown — healthy items are removed
 *      anyway, and the failed one keeps its credentials so a retry
 *      can finish the job.
 *   3. **Local tombstone**: status `removed`, timestamps set, and the
 *      access-token ciphertext ZEROED — the token is dead at Plaid,
 *      so retaining it only widens a breach. The row (and its
 *      cascading transactions) survives until `purge_after`; Phase
 *      6.3's deletion job is the purge.
 *
 * Idempotency: already-removed items are skipped without a Plaid
 * call, the cancel seam is skipped once the entitlement is no longer
 * active, and a re-run never moves an existing `purge_after` — a
 * Stripe webhook retry or a user double-click is harmless.
 *
 * Downstream guards (same step, same reasoning): the webhook state
 * machine and the sync worker both treat `removed` items as
 * `ignored`/no-op — the access token is dead, so calling Plaid would
 * only crash-loop the scheduled catch-up (src/plaid/webhooks/
 * handler.ts, src/plaid/sync.ts).
 */
import { eq, inArray } from "drizzle-orm";
import { entitlements } from "../db/schema/billing";
import { plaidItems } from "../db/schema/plaid";
import type { Db } from "../db/tenancy";
import type { SecretBox } from "../plaid/secrets";

/**
 * Plaid errors that mean "no valid access_token exists for this Item"
 * — per Plaid's billing docs that is exactly the condition under which
 * the Item stops incurring the subscription fee, so both are a
 * successful removal from this state machine's point of view.
 */
export const BILLING_ENDED_ERROR_CODES: ReadonlySet<string> = new Set([
  "ITEM_NOT_FOUND",
  "INVALID_ACCESS_TOKEN",
]);

const DAY_MS = 86_400_000;

export class UnsubscribeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsubscribeConfigError";
  }
}

/** The subset of Plaid's client this module uses (mockable offline). */
export interface ItemRemoveClient {
  itemRemove(params: { access_token: string }): Promise<unknown>;
}

export interface UnsubscribeOptions {
  client: ItemRemoveClient;
  secrets: SecretBox;
  /**
   * Cancel the org's Stripe subscription. Step 0.4's webhook applies
   * the entitlement side when Stripe confirms. Omit for item-only
   * removal (e.g. a user disconnecting one bank without
   * unsubscribing).
   */
  cancelSubscription?: (stripeSubscriptionId: string) => Promise<void>;
  /** Retention window between removal and the Phase 6.3 purge. */
  retentionDays: number;
}

export interface UnsubscribeSummary {
  subscriptionCanceled: boolean;
  /** Items newly removed (and tombstoned) by this call. */
  removed: number;
  /** Items already tombstoned before this call — no Plaid call made. */
  alreadyRemoved: number;
  /** Items whose /item/remove failed with a retriable error. */
  failed: number;
  /** When this call's tombstones become purge-eligible (null if none). */
  purgeAfter: Date | null;
}

/** Plaid surfaces errors as an axios response body (see Step 1.3). */
function plaidErrorCode(error: unknown): string | undefined {
  return (error as { response?: { data?: { error_code?: string } } } | null)
    ?.response?.data?.error_code;
}

export function createUnsubscribe(options: UnsubscribeOptions) {
  if (!Number.isInteger(options.retentionDays) || options.retentionDays < 0) {
    throw new UnsubscribeConfigError(
      "retentionDays must be a non-negative integer",
    );
  }

  /**
   * Run the unsubscribe chain for one organization. Safe to re-run at
   * any point: every step is idempotent, and a partial failure leaves
   * a state the next run continues from.
   */
  async function unsubscribeOrganization(
    db: Db,
    organizationId: string,
  ): Promise<UnsubscribeSummary> {
    const summary: UnsubscribeSummary = {
      subscriptionCanceled: false,
      removed: 0,
      alreadyRemoved: 0,
      failed: 0,
      purgeAfter: null,
    };

    // 1. Cancel first, before touching any Plaid connection.
    const rows = await db
      .select({
        status: entitlements.status,
        stripeSubscriptionId: entitlements.stripeSubscriptionId,
      })
      .from(entitlements)
      .where(eq(entitlements.organizationId, organizationId))
      .limit(1);
    const entitlement = rows[0];
    if (
      options.cancelSubscription &&
      entitlement?.status === "active" &&
      entitlement.stripeSubscriptionId
    ) {
      await options.cancelSubscription(entitlement.stripeSubscriptionId);
      summary.subscriptionCanceled = true;
    }

    // 2. /item/remove per live item; failures collected, not thrown.
    const items = await db
      .select({
        id: plaidItems.id,
        status: plaidItems.status,
        accessTokenCiphertext: plaidItems.accessTokenCiphertext,
      })
      .from(plaidItems)
      .where(eq(plaidItems.organizationId, organizationId));

    const succeeded: string[] = [];
    for (const item of items) {
      if (item.status === "removed") {
        summary.alreadyRemoved += 1;
        continue;
      }
      try {
        const accessToken = options.secrets.decrypt(item.accessTokenCiphertext);
        await options.client.itemRemove({ access_token: accessToken });
        succeeded.push(item.id);
      } catch (error) {
        const code = plaidErrorCode(error);
        if (code !== undefined && BILLING_ENDED_ERROR_CODES.has(code)) {
          succeeded.push(item.id);
        } else {
          // Keeps status + credentials so the retry can call Plaid.
          summary.failed += 1;
        }
      }
    }

    // 3. Tombstone everything that reached billing-ended state.
    if (succeeded.length > 0) {
      const now = new Date();
      const purgeAfter = new Date(
        now.getTime() + options.retentionDays * DAY_MS,
      );
      await db.transaction(async (tx) => {
        await tx
          .update(plaidItems)
          .set({
            status: "removed",
            staleReason: null,
            statusChangedAt: now,
            removedAt: now,
            purgeAfter,
            accessTokenCiphertext: "",
          })
          .where(inArray(plaidItems.id, succeeded));
      });
      summary.removed = succeeded.length;
      summary.purgeAfter = purgeAfter;
    }

    return summary;
  }

  return { unsubscribeOrganization };
}

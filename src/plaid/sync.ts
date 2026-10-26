/**
 * /transactions/sync worker (plan Step 1.3).
 *
 * Contract pinned by tests/plaid/sync.test.ts against recorded
 * fixture payloads:
 *
 * - **Cursor commit**: the item's `sync_cursor` advances in the SAME
 *   transaction that applies its page. A crash between pages leaves a
 *   resumable state (cursor never runs ahead of applied data), and a
 *   replayed page is harmless: upserts are keyed on Plaid's
 *   `transaction_id`, removals re-delete nothing, and the cursor
 *   rewrite is idempotent.
 * - **Pagination**: call without a cursor, follow `has_more` with the
 *   returned `next_cursor` until a page reports no more.
 * - **Restart**: on `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION`
 *   Plaid's data moved under us mid-pagination. Recovery restarts the
 *   run from the cursor it STARTED with (replaying the run is safe —
 *   see cursor commit), bounded by `MAX_RESTARTS` so a permanently
 *   churning item fails loudly instead of spinning forever. Any other
 *   upstream error is rethrown untouched.
 * - **Secrets**: the stored access token is decrypted into a local
 *   for the upstream call and never logged — Step 1.2's negative test
 *   applies to this module by the same reasoning (the upstream call
 *   is plain network I/O outside any transaction).
 *
 * The client type is structural (mirrors `PlaidLinkClient` from Step
 * 1.1): the real `PlaidApi` satisfies it, tests script it offline.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { plaidItems } from "../db/schema/plaid";
import { transactions } from "../db/schema/transactions";
import type { Db } from "../db/tenancy";
import type { SecretBox } from "./secrets";

/** Restart budget for mutation-during-pagination within one run. */
export const MAX_SYNC_RESTARTS = 3;

const MUTATION_ERROR_CODE = "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION";

/** The transaction handle type underlying the pool-backed Db. */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Anything the sync can run on: a Db, or an open transaction. */
export type SyncRunner = Db | Tx;

/**
 * The transaction fields sync reads — a structural subset of Plaid's
 * `Transaction` (deliberately not the SDK type: it would drag string
 * enums in and make recorded JSON fixtures untyped).
 */
export interface SyncTransaction {
  transaction_id: string;
  date: string;
  amount: number;
  name: string;
  pending: boolean;
  pending_transaction_id: string | null;
  iso_currency_code: string | null;
  merchant_name?: string | null;
  personal_finance_category?: {
    primary: string;
    detailed: string;
  } | null;
}

export interface SyncRemovedTransaction {
  transaction_id: string;
}

/** One /transactions/sync response page. */
export interface SyncPage {
  added: SyncTransaction[];
  modified: SyncTransaction[];
  removed: SyncRemovedTransaction[];
  next_cursor: string;
  has_more: boolean;
  request_id?: string;
}

/** The subset of Plaid's client this worker uses (mockable offline). */
export interface TransactionsSyncClient {
  transactionsSync(params: {
    access_token: string;
    cursor?: string;
  }): Promise<{ data: SyncPage }>;
}

/** What one syncItem call did — observability for callers/tests. */
export interface SyncSummary {
  pages: number;
  added: number;
  modified: number;
  removed: number;
  restarts: number;
}

export interface SyncItemOptions {
  client: TransactionsSyncClient;
  secrets: SecretBox;
}

export class SyncItemNotFoundError extends Error {
  constructor(itemId: string) {
    super(`plaid item not found: ${itemId}`);
    this.name = "SyncItemNotFoundError";
  }
}

export class SyncRestartExhaustedError extends Error {
  constructor(itemId: string) {
    super(
      `transactions sync for item ${itemId} still mutating after ${MAX_SYNC_RESTARTS} restarts`,
    );
    this.name = "SyncRestartExhaustedError";
  }
}

/**
 * Plaid surfaces this error as an axios response body:
 * `{ response: { data: { error_code: "TRANSACTIONS_SYNC_MUTATION..." } } }`.
 */
function isMutationDuringPagination(error: unknown): boolean {
  const response = (
    error as { response?: { data?: { error_code?: string } } } | null
  )?.response;
  return response?.data?.error_code === MUTATION_ERROR_CODE;
}

/** Plaid row → table row. Amounts rounded once, to integer cents. */
function toRow(
  item: { id: string; organizationId: string },
  transaction: SyncTransaction,
  updatedAt: Date,
) {
  return {
    organizationId: item.organizationId,
    plaidItemId: item.id,
    plaidTransactionId: transaction.transaction_id,
    date: transaction.date,
    amountCents: Math.round(transaction.amount * 100),
    isoCurrencyCode: transaction.iso_currency_code,
    name: transaction.name,
    merchantName: transaction.merchant_name ?? null,
    personalFinanceCategoryPrimary:
      transaction.personal_finance_category?.primary ?? null,
    personalFinanceCategoryDetailed:
      transaction.personal_finance_category?.detailed ?? null,
    pending: transaction.pending,
    pendingTransactionId: transaction.pending_transaction_id,
    updatedAt,
  };
}

/**
 * Apply one page atomically: upsert added+modified, delete removed,
 * advance the cursor — one transaction, so the cursor and the data
 * it describes commit together. `excluded.*` keeps re-delivery
 * byte-identical (created_at is never in the conflict set).
 */
async function applyPage(
  tx: Tx,
  item: { id: string; organizationId: string },
  page: SyncPage,
): Promise<void> {
  const upserted = [...page.added, ...page.modified];
  if (upserted.length > 0) {
    const updatedAt = new Date();
    await tx
      .insert(transactions)
      .values(upserted.map((t) => toRow(item, t, updatedAt)))
      .onConflictDoUpdate({
        target: [transactions.plaidItemId, transactions.plaidTransactionId],
        set: {
          date: sql`excluded.date`,
          amountCents: sql`excluded.amount_cents`,
          isoCurrencyCode: sql`excluded.iso_currency_code`,
          name: sql`excluded.name`,
          merchantName: sql`excluded.merchant_name`,
          personalFinanceCategoryPrimary: sql`excluded.personal_finance_category_primary`,
          personalFinanceCategoryDetailed: sql`excluded.personal_finance_category_detailed`,
          pending: sql`excluded.pending`,
          pendingTransactionId: sql`excluded.pending_transaction_id`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  }

  const removedIds = page.removed.map((r) => r.transaction_id);
  if (removedIds.length > 0) {
    await tx
      .delete(transactions)
      .where(
        and(
          eq(transactions.plaidItemId, item.id),
          inArray(transactions.plaidTransactionId, removedIds),
        ),
      );
  }

  await tx
    .update(plaidItems)
    .set({ syncCursor: page.next_cursor })
    .where(eq(plaidItems.id, item.id));
}

export function createTransactionSync(options: SyncItemOptions) {
  /**
   * Sync one stored item to its latest state (idempotent — safe to
   * re-run any number of times, and to re-run after a crash mid-
   * pagination).
   */
  async function syncItem(
    runner: SyncRunner,
    itemId: string,
  ): Promise<SyncSummary> {
    const rows = await runner
      .select({
        id: plaidItems.id,
        organizationId: plaidItems.organizationId,
        accessTokenCiphertext: plaidItems.accessTokenCiphertext,
        syncCursor: plaidItems.syncCursor,
        status: plaidItems.status,
      })
      .from(plaidItems)
      .where(eq(plaidItems.id, itemId))
      .limit(1);
    const item = rows[0];
    if (!item) {
      throw new SyncItemNotFoundError(itemId);
    }

    // Step 1.6 tombstone: unsubscribe invalidated the token at Plaid
    // (and zeroed the ciphertext here) — calling upstream would only
    // crash-loop the scheduled catch-up on a deleted connection.
    if (item.status === "removed") {
      return { pages: 0, added: 0, modified: 0, removed: 0, restarts: 0 };
    }

    const accessToken = options.secrets.decrypt(item.accessTokenCiphertext);
    const runStartCursor = item.syncCursor ?? undefined;
    let cursor = runStartCursor;
    const summary: SyncSummary = {
      pages: 0,
      added: 0,
      modified: 0,
      removed: 0,
      restarts: 0,
    };

    for (;;) {
      let page: SyncPage;
      try {
        const response = await options.client.transactionsSync({
          access_token: accessToken,
          cursor,
        });
        page = response.data;
      } catch (error) {
        if (isMutationDuringPagination(error)) {
          if (summary.restarts >= MAX_SYNC_RESTARTS) {
            throw new SyncRestartExhaustedError(itemId);
          }
          summary.restarts += 1;
          // Replay from where the run began — the failed page was
          // never applied, and replays are idempotent by key.
          cursor = runStartCursor;
          continue;
        }
        throw error;
      }

      await runner.transaction((tx) => applyPage(tx, item, page));

      summary.pages += 1;
      summary.added += page.added.length;
      summary.modified += page.modified.length;
      summary.removed += page.removed.length;
      cursor = page.next_cursor;
      if (!page.has_more) {
        return summary;
      }
    }
  }

  return { syncItem };
}

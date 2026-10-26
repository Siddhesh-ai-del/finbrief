/**
 * Transaction storage (plan Step 1.3) — the correctness core Phase
 * 2's aggregations read.
 *
 * Identity: `(plaid_item_id, plaid_transaction_id)` is the natural
 * key. Plaid's `transaction_id` is stable per item and is exactly
 * the idempotency key re-delivery needs — `ON CONFLICT` turns a
 * replayed sync page into an overwrite with identical values, so a
 * crash-replay or a pagination restart is a no-op by construction.
 *
 * `date` is TEXT in ISO `YYYY-MM-DD`: lexicographic order equals
 * chronological order, so range scans and month grouping work
 * without timezone conversion at the driver boundary (Plaid's date
 * has no time component; a timestamptz would invent one).
 * `amount_cents` is a signed integer in cents (Plaid: positive =
 * outflow, negative = inflow) — no floats ever reach aggregation.
 *
 * Tenant scoping is denormalized onto the row (`organization_id`,
 * FK cascade) so every Phase 2 query filters by organization
 * without joining through plaid_items. Rows cascade from BOTH
 * owners: their tenant and their owning item.
 *
 * Raw values are stored as Plaid sent them; the prompt-facing
 * sanitization in plan Step 1.5 happens at send-set build time,
 * not at rest.
 */
import { randomUUID } from "node:crypto";
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization } from "./organization";
import { plaidItems } from "./plaid";

const ts = (name: string) => timestamp(name, { withTimezone: true });

export const transactions = pgTable(
  "transactions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    plaidItemId: text("plaid_item_id")
      .notNull()
      .references(() => plaidItems.id, { onDelete: "cascade" }),
    /** Plaid's transaction_id — the sync idempotency key (per item). */
    plaidTransactionId: text("plaid_transaction_id").notNull(),
    /** ISO-8601 calendar date as sent by Plaid ("YYYY-MM-DD"). */
    date: text("date").notNull(),
    /** Signed integer cents; Plaid's decimal dollars rounded once. */
    amountCents: integer("amount_cents").notNull(),
    isoCurrencyCode: text("iso_currency_code"),
    name: text("name").notNull(),
    merchantName: text("merchant_name"),
    personalFinanceCategoryPrimary: text("personal_finance_category_primary"),
    personalFinanceCategoryDetailed: text("personal_finance_category_detailed"),
    pending: boolean("pending").notNull().default(false),
    pendingTransactionId: text("pending_transaction_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("transactions_org_date_idx").on(t.organizationId, t.date),
    uniqueIndex("transactions_item_txn_idx").on(
      t.plaidItemId,
      t.plaidTransactionId,
    ),
  ],
);

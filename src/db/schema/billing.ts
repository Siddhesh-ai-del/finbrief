/**
 * Billing tables (plan Step 0.4) — Stripe entitlements, the run-credit
 * ledger, and the webhook idempotency record.
 *
 * Design notes:
 * - `entitlements` is one row per organization (PK), upserted on each
 *   activation; status is "active" | "canceled".
 * - `run_credit_accounts` holds the cached balance; `run_credit_entries`
 *   is an append-only audit trail whose `balance_after` makes the whole
 *   ledger self-reconciling (newest entry must equal account balance).
 * - `webhook_events.id` is the Stripe event id — the primary key IS the
 *   idempotency guard: ON CONFLICT DO NOTHING claims an event exactly
 *   once, inside the same transaction as its effects.
 * - Organization FKs cascade (matches consent_records: billing data
 *   dies with its tenant); user FKs are not involved here.
 */
import { randomUUID } from "node:crypto";
import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organization } from "./organization";

const ts = (name: string) => timestamp(name, { withTimezone: true });

export const entitlements = pgTable(
  "entitlements",
  {
    organizationId: text("organization_id")
      .primaryKey()
      .references(() => organization.id, { onDelete: "cascade" }),
    plan: text("plan").notNull(),
    status: text("status").notNull(),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    currentPeriodEnd: ts("current_period_end"),
    includedCredits: integer("included_credits").notNull(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("entitlements_subscription_idx").on(t.stripeSubscriptionId)],
);

export const runCreditAccounts = pgTable("run_credit_accounts", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  balance: integer("balance").notNull().default(0),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const runCreditEntries = pgTable(
  "run_credit_entries",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    amount: integer("amount").notNull(),
    balanceAfter: integer("balance_after").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("run_credit_entries_org_idx").on(t.organizationId)],
);

export const webhookEvents = pgTable("webhook_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  receivedAt: ts("received_at").notNull().defaultNow(),
});

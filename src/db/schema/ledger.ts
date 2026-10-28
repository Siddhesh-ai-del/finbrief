/**
 * Debt/IOU ledger schema (plan Step 3.1) — the second product
 * pillar: durable money facts a chatbot cannot produce.
 *
 * Shape follows the invariants the domain pins (tests/ledger):
 *
 * - **Append-only money history.** Entries are never updated or
 *   hard-deleted; `tombstoned_at` excludes an entry from balance
 *   arithmetic while the row survives as history. There is no
 *   update path in the API and no delete cascade between entries.
 * - **Balance is derived, never stored.** No balance column exists —
 *   balance = SUM(amount_cents) over live entries, so it cannot
 *   drift from the entries that justify it.
 * - **Signed cents.** Positive = counterparty owes the organization;
 *   negative = the organization owes the counterparty. `debt` opens
 *   or shifts exposure, `settlement` reduces it. Integer cents only
 *   (no floats touch money).
 * - **Idempotency at the storage layer.** (organization_id,
 *   idempotency_key) is UNIQUE — a redelivered webhook or retried
 *   agent turn cannot double-apply a settlement even past the
 *   application check (Step 1.3's redelivery lesson, applied here).
 * - **Aliases, not legal names (§3.8 send-set).** A counterparty
 *   stores exactly ONE name field — the sanitized display alias.
 *   There is deliberately no legal-name/SSN/email column: data we
 *   never hold cannot leak into a prompt, trace, or send-set.
 */
import { relations, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization } from "./organization";

export const LEDGER_ENTRY_KINDS = ["debt", "settlement"] as const;
export type LedgerEntryKind = (typeof LEDGER_ENTRY_KINDS)[number];

export const ledgerCounterparties = pgTable(
  "ledger_counterparties",
  {
    // text ids — the repo-wide convention (better-auth's id type);
    // drizzle 0.45 has no defaultRandom() on text columns.
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** Step 1.5-sanitized display alias — the ONLY name stored (§3.8). */
    alias: text("alias").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    tombstonedAt: timestamp("tombstoned_at"),
  },
  (t) => [index("ledger_counterparties_org_idx").on(t.organizationId)],
);

export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    counterpartyId: text("counterparty_id")
      .notNull()
      .references(() => ledgerCounterparties.id),
    kind: text("kind").$type<LedgerEntryKind>().notNull(),
    /** Signed cents: + they owe the org, − the org owes them. */
    amountCents: integer("amount_cents").notNull(),
    /** ISO date of the obligation/settlement, inclusive. */
    entryDate: text("entry_date").notNull(),
    /**
     * Replay guard (Step 1.3's lesson): unique per organization, so
     * a redelivered event is deduplicated at the storage layer.
     */
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    tombstonedAt: timestamp("tombstoned_at"),
  },
  (t) => [
    uniqueIndex("ledger_entries_idem_idx").on(
      t.organizationId,
      t.idempotencyKey,
    ),
    index("ledger_entries_counterparty_idx").on(
      t.organizationId,
      t.counterpartyId,
    ),
    // Signed-cents sanity at the storage layer: zero is never a
    // meaningful money event (matches the API's validation).
    check("ledger_entries_amount_nonzero", sql`amount_cents <> 0`),
  ],
);

export const ledgerCounterpartiesRelations = relations(
  ledgerCounterparties,
  ({ many }) => ({
    entries: many(ledgerEntries),
  }),
);

export const ledgerEntriesRelations = relations(ledgerEntries, ({ one }) => ({
  counterparty: one(ledgerCounterparties, {
    fields: [ledgerEntries.counterpartyId],
    references: [ledgerCounterparties.id],
  }),
}));

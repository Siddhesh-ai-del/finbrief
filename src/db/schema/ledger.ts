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
import { transactions } from "./transactions";

export const LEDGER_ENTRY_KINDS = ["debt", "settlement"] as const;
export type LedgerEntryKind = (typeof LEDGER_ENTRY_KINDS)[number];

export const LINK_STATUSES = ["proposed", "confirmed", "rejected"] as const;
export type LinkStatus = (typeof LINK_STATUSES)[number];

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

/**
 * Repayment ↔ transaction link (plan Step 3.2) — the proposal/decision
 * split that keeps the model away from money facts:
 *
 * - `proposed` is the ONLY status a caller (agent or code) can write.
 *   `confirmed` exists solely behind an explicit human decision with a
 *   `decided_by` actor id — never auto-confirm (plan: "ambiguous
 *   matches surface for human confirmation").
 * - `decided_by` is plain text with deliberately NO foreign key: if a
 *   user row ever disappears, the record of who confirmed a money fact
 *   must not disappear with it. (The reverse — link rows cascading
 *   with their transaction — is intentional: a "proof" link whose
 *   proof row is gone asserts something nobody can verify.)
 * - The two partial unique indexes ARE the "one live link per entry,
 *   one live proof per transaction" invariant: rejected links fall out
 *   of the index, so a rejection frees both sides for a fresh
 *   proposal while history of the rejected row remains.
 */
export const ledgerEntryLinks = pgTable(
  "ledger_entry_links",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    entryId: text("entry_id")
      .notNull()
      .references(() => ledgerEntries.id, { onDelete: "cascade" }),
    transactionId: text("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    status: text("status").$type<LinkStatus>().notNull().default("proposed"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    decidedAt: timestamp("decided_at"),
    decidedBy: text("decided_by"),
  },
  (t) => [
    index("ledger_entry_links_org_idx").on(t.organizationId),
    uniqueIndex("ledger_entry_links_entry_live_idx")
      .on(t.entryId)
      .where(sql`${t.status} <> 'rejected'`),
    uniqueIndex("ledger_entry_links_txn_live_idx")
      .on(t.transactionId)
      .where(sql`${t.status} <> 'rejected'`),
  ],
);

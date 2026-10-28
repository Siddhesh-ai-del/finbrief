/**
 * Debt/IOU ledger domain (plan Step 3.1).
 *
 * The second product pillar: a durable register of who owes whom,
 * with money arithmetic the model never does (§6.2-6/7 applies here
 * too — the agent RECORDS facts, code DERIVES balances).
 *
 * Invariants, pinned by tests/ledger/entries.test.ts:
 *
 * - **Entry sum equals balance.** Balance is derived on every read —
 *   SUM(amount_cents) over live (non-tombstoned) entries, signed
 *   cents from the org's perspective. Nothing stores a balance, so
 *   nothing can drift from the entries that justify it.
 * - **Partial settlements** are legal; a settlement must oppose the
 *   current balance's sign and may not exceed its magnitude. That
 *   single rule IS the no-double-settlement invariant: you cannot
 *   settle more than is owed, settle twice past zero, or settle in
 *   the wrong direction (which would be new exposure, not a
 *   settlement — record a debt instead).
 * - **Idempotency keys** on every write: a retried agent turn or
 *   redelivered webhook replays to the SAME entry (the DB unique
 *   index (organization_id, idempotency_key) is the backstop —
 *   Step 1.3's redelivery lesson, applied to money).
 * - **Tombstones, never deletes.** Money history is append-only;
 *   tombstoning excludes an entry from balance and is idempotent.
 *   A counterparty can only be tombstoned at zero balance — you
 *   cannot erase a relationship that still holds money.
 * - **Aliases, not legal names (§3.8 send-set).** Counterparty
 *   aliases pass through Step 1.5's sanitizer; the schema holds no
 *   legal-name field at all, so a send-set built from this domain
 *   cannot leak one.
 * - **Tenancy by construction**: organization_id in every WHERE.
 * - **Errors never echo values** (Steps 1.2/1.5 discipline): typed
 *   codes + field names only.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { ledgerCounterparties, ledgerEntries } from "../db/schema/ledger";
import type { Db } from "../db/tenancy";
import { sanitizeUntrustedText } from "../security/untrusted-text";

export type LedgerErrorCode =
  | "ALIAS_EMPTY"
  | "COUNTERPARTY_NOT_FOUND"
  | "COUNTERPARTY_TOMBSTONED"
  | "COUNTERPARTY_HAS_BALANCE"
  | "SETTLEMENT_EXCEEDS_BALANCE"
  | "INVALID_AMOUNT"
  | "INVALID_DATE";

export class LedgerError extends Error {
  readonly code: LedgerErrorCode;

  constructor(code: LedgerErrorCode, reason: string) {
    // Code + field expectation only — never the offending value.
    super(`ledger ${code}: ${reason}`);
    this.name = "LedgerError";
    this.code = code;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Row cap for entry listings — enforced here, never in a prompt. */
export const DEFAULT_MAX_ROWS = 100;

export interface Counterparty {
  readonly id: string;
  readonly alias: string;
  readonly createdAt: Date;
  readonly tombstonedAt: Date | null;
}

export interface LedgerEntry {
  readonly id: string;
  readonly counterpartyId: string;
  readonly kind: "debt" | "settlement";
  readonly amountCents: number;
  readonly entryDate: string;
  readonly idempotencyKey: string;
  readonly createdAt: Date;
  readonly tombstonedAt: Date | null;
}

function freezeCounterparty(
  row: typeof ledgerCounterparties.$inferSelect,
): Counterparty {
  return Object.freeze({
    id: row.id,
    alias: row.alias,
    createdAt: row.createdAt,
    tombstonedAt: row.tombstonedAt,
  });
}

function freezeEntry(row: typeof ledgerEntries.$inferSelect): LedgerEntry {
  return Object.freeze({
    id: row.id,
    counterpartyId: row.counterpartyId,
    kind: row.kind,
    amountCents: row.amountCents,
    entryDate: row.entryDate,
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt,
    tombstonedAt: row.tombstonedAt,
  });
}

function validateAmount(amountCents: number): void {
  if (!Number.isSafeInteger(amountCents) || amountCents === 0) {
    throw new LedgerError(
      "INVALID_AMOUNT",
      "amountCents must be a non-zero safe integer",
    );
  }
}

function validateDate(field: string, value: string): void {
  if (!ISO_DATE.test(value)) {
    throw new LedgerError("INVALID_DATE", `${field} must be ISO YYYY-MM-DD`);
  }
}

/**
 * Create a counterparty under a sanitized alias. No legal name is
 * accepted because none is stored — the parameter surface IS the
 * privacy control (§3.8).
 */
export async function createCounterparty(
  db: Db,
  organizationId: string,
  input: { alias: string },
): Promise<Counterparty> {
  const alias = sanitizeUntrustedText(input.alias);
  if (alias === "") {
    throw new LedgerError(
      "ALIAS_EMPTY",
      "alias must contain readable characters after sanitization",
    );
  }
  const inserted = await db
    .insert(ledgerCounterparties)
    .values({ organizationId, alias })
    .returning();
  return freezeCounterparty(inserted[0]!);
}

/** Live-entry balance: + they owe the org, − the org owes them. */
export async function balanceOf(
  db: Db,
  organizationId: string,
  counterpartyId: string,
): Promise<number> {
  const rows = await db
    .select({
      total: sql<number>`COALESCE(SUM(${ledgerEntries.amountCents}), 0)::int`,
    })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.organizationId, organizationId),
        eq(ledgerEntries.counterpartyId, counterpartyId),
        isNull(ledgerEntries.tombstonedAt),
      ),
    );
  return rows[0]?.total ?? 0;
}

async function requireLiveCounterparty(
  db: Db,
  organizationId: string,
  counterpartyId: string,
): Promise<void> {
  const rows = await db
    .select({ tombstonedAt: ledgerCounterparties.tombstonedAt })
    .from(ledgerCounterparties)
    .where(
      and(
        eq(ledgerCounterparties.id, counterpartyId),
        eq(ledgerCounterparties.organizationId, organizationId),
      ),
    );
  const found = rows[0];
  if (!found) {
    throw new LedgerError("COUNTERPARTY_NOT_FOUND", "counterparty id");
  }
  if (found.tombstonedAt !== null) {
    throw new LedgerError("COUNTERPARTY_TOMBSTONED", "counterparty is closed");
  }
}

/**
 * Idempotent insert: on a key collision the existing entry is
 * returned unchanged. The unique index (organization_id,
 * idempotency_key) makes this safe under concurrency — the losing
 * writer reads the winner's row instead of double-applying money.
 */
async function insertIdempotent(
  db: Db,
  organizationId: string,
  counterpartyId: string,
  input: {
    kind: "debt" | "settlement";
    amountCents: number;
    entryDate: string;
    idempotencyKey: string;
  },
): Promise<LedgerEntry> {
  const inserted = await db
    .insert(ledgerEntries)
    .values({ organizationId, counterpartyId, ...input })
    .onConflictDoNothing({
      target: [ledgerEntries.organizationId, ledgerEntries.idempotencyKey],
    })
    .returning();
  const row = inserted[0];
  if (row) return freezeEntry(row);

  const existing = await db
    .select()
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.organizationId, organizationId),
        eq(ledgerEntries.idempotencyKey, input.idempotencyKey),
      ),
    );
  return freezeEntry(existing[0]!);
}

/** Record a debt: signed exposure (+ they owe, − we owe). */
export async function recordDebt(
  db: Db,
  organizationId: string,
  input: {
    counterpartyId: string;
    amountCents: number;
    entryDate: string;
    idempotencyKey: string;
  },
): Promise<LedgerEntry> {
  validateAmount(input.amountCents);
  validateDate("entryDate", input.entryDate);
  await requireLiveCounterparty(db, organizationId, input.counterpartyId);
  return insertIdempotent(db, organizationId, input.counterpartyId, {
    kind: "debt",
    ...input,
  });
}

/**
 * Record a settlement. Rules, in order:
 * 1. idempotent replay short-circuits (a redelivered event changes
 *    nothing — checked BEFORE the balance rule, since the original
 *    application already satisfied it);
 * 2. amount must oppose the current balance's sign;
 * 3. magnitude may not exceed the outstanding balance — partial is
 *    fine, overpayment is rejected (no double-settlement).
 * The balance read and the insert share one transaction so two
 * concurrent settlements cannot both pass rule 3 against the same
 * remaining balance.
 */
export async function recordSettlement(
  db: Db,
  organizationId: string,
  input: {
    counterpartyId: string;
    amountCents: number;
    entryDate: string;
    idempotencyKey: string;
  },
): Promise<LedgerEntry> {
  validateAmount(input.amountCents);
  validateDate("entryDate", input.entryDate);
  await requireLiveCounterparty(db, organizationId, input.counterpartyId);

  return db.transaction(async (tx) => {
    const replay = await tx
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.organizationId, organizationId),
          eq(ledgerEntries.idempotencyKey, input.idempotencyKey),
        ),
      );
    if (replay[0]) return freezeEntry(replay[0]);

    const balance = await balanceOf(
      tx as Db,
      organizationId,
      input.counterpartyId,
    );
    const opposesSign =
      balance !== 0 && Math.sign(input.amountCents) !== Math.sign(balance);
    if (!opposesSign || Math.abs(input.amountCents) > Math.abs(balance)) {
      throw new LedgerError(
        "SETTLEMENT_EXCEEDS_BALANCE",
        "settlement must oppose and not exceed the outstanding balance",
      );
    }

    const inserted = await tx
      .insert(ledgerEntries)
      .values({
        organizationId,
        counterpartyId: input.counterpartyId,
        kind: "settlement",
        amountCents: input.amountCents,
        entryDate: input.entryDate,
        idempotencyKey: input.idempotencyKey,
      })
      .returning();
    return freezeEntry(inserted[0]!);
  });
}

/** Tombstone an entry — excluded from balance, row survives as history. */
export async function tombstoneEntry(
  db: Db,
  organizationId: string,
  entryId: string,
): Promise<void> {
  await db
    .update(ledgerEntries)
    .set({ tombstonedAt: new Date() })
    .where(
      and(
        eq(ledgerEntries.id, entryId),
        eq(ledgerEntries.organizationId, organizationId),
        isNull(ledgerEntries.tombstonedAt),
      ),
    );
}

/**
 * Tombstone a counterparty — only at zero balance. You cannot erase
 * a relationship that still holds money; settle or tombstone the
 * entries first.
 */
export async function tombstoneCounterparty(
  db: Db,
  organizationId: string,
  counterpartyId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const rows = await tx
      .select({ tombstonedAt: ledgerCounterparties.tombstonedAt })
      .from(ledgerCounterparties)
      .where(
        and(
          eq(ledgerCounterparties.id, counterpartyId),
          eq(ledgerCounterparties.organizationId, organizationId),
        ),
      );
    const found = rows[0];
    if (!found) {
      throw new LedgerError("COUNTERPARTY_NOT_FOUND", "counterparty id");
    }
    if (found.tombstonedAt !== null) return; // idempotent

    const balance = await balanceOf(tx as Db, organizationId, counterpartyId);
    if (balance !== 0) {
      throw new LedgerError(
        "COUNTERPARTY_HAS_BALANCE",
        "settle or tombstone outstanding entries first",
      );
    }
    await tx
      .update(ledgerCounterparties)
      .set({ tombstonedAt: new Date() })
      .where(eq(ledgerCounterparties.id, counterpartyId));
  });
}

/** Live entries for one counterparty, newest first, row-capped. */
export async function listEntries(
  db: Db,
  organizationId: string,
  counterpartyId: string,
  options: { limit?: number } = {},
): Promise<readonly LedgerEntry[]> {
  const limit = options.limit ?? DEFAULT_MAX_ROWS;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new LedgerError("INVALID_AMOUNT", "limit must be a positive integer");
  }
  const rows = await db
    .select()
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.organizationId, organizationId),
        eq(ledgerEntries.counterpartyId, counterpartyId),
        isNull(ledgerEntries.tombstonedAt),
      ),
    )
    .orderBy(sql`${ledgerEntries.createdAt} desc, ${ledgerEntries.id} desc`)
    .limit(limit);
  return Object.freeze(rows.map(freezeEntry));
}

/**
 * Ledger ↔ transaction linking (plan Step 3.2).
 *
 * Ties a repayment entry to the synced transaction that proves it,
 * without letting the model invent or confirm money facts:
 *
 * - **The matching rule is code, not a prompt.** A settlement entry
 *   matches a POSTED transaction with the same signed cents (Plaid:
 *   negative = inflow = repayment received; positive = outflow =
 *   repayment made) whose date falls inside a config-driven window
 *   (inclusive, both ends). proposeLink re-validates the rule itself —
 *   a caller-supplied pairing that fails it throws and writes nothing.
 *   The model can *offer* candidates from findRepaymentCandidates; it
 *   can never widen what counts as a match.
 * - **Propose ≠ confirm.** proposeLink only ever writes `proposed`.
 *   `confirmed` exists solely behind confirmLink(decidedBy), which
 *   requires a human actor id (INVALID_DECIDER otherwise). Ambiguous
 *   matches (ambiguous: true) stay proposed until a human picks —
 *   "never auto-confirm money facts."
 * - **One live link per entry, one live proof per transaction**, at
 *   the storage layer via partial unique indexes (status <> rejected);
 *   rejection frees both sides for a fresh proposal. The in-transaction
 *   checks give good errors; the unique index is the race backstop
 *   (constraint violations map to the same typed codes).
 * - **Candidates are a menu of *available* proofs**: transactions
 *   already carrying a live link are excluded, and names pass Step
 *   1.5's sanitizer (Plaid text is untrusted, §3.8).
 * - **Tenancy by construction**: organization_id in every WHERE;
 *   typed LedgerLinkError codes, field names only in messages.
 */
import { and, asc, desc, eq, gte, lte, ne, notInArray } from "drizzle-orm";
import {
  ledgerEntryLinks,
  ledgerEntries,
  type LinkStatus,
} from "../db/schema/ledger";
import { transactions } from "../db/schema/transactions";
import type { Db } from "../db/tenancy";
import { sanitizeUntrustedText } from "../security/untrusted-text";
import { DEFAULT_MAX_ROWS } from "./entries";

/** How far (calendar days) a transaction date may sit from the entry. */
export const DEFAULT_DATE_WINDOW_DAYS = 3;

export type LinkErrorCode =
  | "ENTRY_NOT_FOUND"
  | "ENTRY_TOMBSTONED"
  | "NOT_A_REPAYMENT"
  | "TRANSACTION_NOT_FOUND"
  | "CANDIDATE_MISMATCH"
  | "LINK_EXISTS"
  | "TRANSACTION_LINKED"
  | "LINK_NOT_FOUND"
  | "INVALID_TRANSITION"
  | "INVALID_DECIDER"
  | "INVALID_CONFIG";

export class LedgerLinkError extends Error {
  readonly code: LinkErrorCode;

  constructor(code: LinkErrorCode, reason: string) {
    // Code + field expectation only — never the offending value.
    super(`link ${code}: ${reason}`);
    this.name = "LedgerLinkError";
    this.code = code;
  }
}

export interface LinkConfig {
  readonly dateWindowDays?: number;
  readonly maxRows?: number;
}

export interface LinkCandidate {
  readonly transactionId: string;
  readonly date: string;
  readonly amountCents: number;
  readonly name: string; // Step 1.5-sanitized (§3.8)
}

export interface RepaymentCandidates {
  readonly entryId: string;
  readonly amountCents: number;
  readonly entryDate: string;
  readonly candidates: readonly LinkCandidate[];
  readonly ambiguous: boolean; // candidates.length > 1
}

export interface LedgerLink {
  readonly id: string;
  readonly entryId: string;
  readonly transactionId: string;
  readonly status: LinkStatus;
  readonly createdAt: Date;
  readonly decidedAt: Date | null;
  readonly decidedBy: string | null;
}

export interface ListLinkFilters {
  readonly linkId?: string;
  readonly entryId?: string;
  readonly status?: LinkStatus;
  readonly limit?: number;
}

function freezeLink(row: typeof ledgerEntryLinks.$inferSelect): LedgerLink {
  return Object.freeze({
    id: row.id,
    entryId: row.entryId,
    transactionId: row.transactionId,
    status: row.status,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
    decidedBy: row.decidedBy,
  });
}

/** "YYYY-MM-DD" shifted by whole calendar days (UTC — date-only). */
function shiftIsoDate(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * The entry a link may attach to: must exist in this organization,
 * be live (not tombstoned), and be a settlement — only repayments
 * link to transactions.
 */
async function loadRepayableEntry(
  db: Db,
  organizationId: string,
  entryId: string,
): Promise<typeof ledgerEntries.$inferSelect> {
  const rows = await db
    .select()
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.id, entryId),
        eq(ledgerEntries.organizationId, organizationId),
      ),
    );
  const entry = rows[0];
  if (!entry) {
    throw new LedgerLinkError("ENTRY_NOT_FOUND", "entry id");
  }
  if (entry.tombstonedAt !== null) {
    throw new LedgerLinkError("ENTRY_TOMBSTONED", "entry is tombstoned");
  }
  if (entry.kind !== "settlement") {
    throw new LedgerLinkError("NOT_A_REPAYMENT", "entry kind");
  }
  return entry;
}

function validateDecider(decidedBy: string): string {
  const decider = decidedBy.trim();
  if (decider === "") {
    throw new LedgerLinkError(
      "INVALID_DECIDER",
      "decidedBy must identify a user",
    );
  }
  return decider;
}

/** Postgres unique-violation backstop for the partial unique indexes. */
function mapDuplicate(error: unknown): never {
  const pgError = error as { code?: string; constraint?: string };
  if (pgError?.code === "23505") {
    if (pgError.constraint?.includes("entry_live")) {
      throw new LedgerLinkError("LINK_EXISTS", "entry already has a link");
    }
    if (pgError.constraint?.includes("txn_live")) {
      throw new LedgerLinkError(
        "TRANSACTION_LINKED",
        "transaction already proves another entry",
      );
    }
  }
  throw error;
}

export function createLedgerLinker(config: LinkConfig = {}) {
  const window = config.dateWindowDays ?? DEFAULT_DATE_WINDOW_DAYS;
  if (!Number.isInteger(window) || window < 0) {
    throw new LedgerLinkError(
      "INVALID_CONFIG",
      "dateWindowDays must be a non-negative integer",
    );
  }
  const maxRows = config.maxRows ?? DEFAULT_MAX_ROWS;
  if (!Number.isInteger(maxRows) || maxRows <= 0) {
    throw new LedgerLinkError(
      "INVALID_CONFIG",
      "maxRows must be a positive integer",
    );
  }

  /**
   * Deterministic candidates for a repayment: same signed cents,
   * posted, within the window, in this organization, and not already
   * carrying a live link (a menu offers only available proofs).
   */
  async function findRepaymentCandidates(
    db: Db,
    organizationId: string,
    entryId: string,
  ): Promise<RepaymentCandidates> {
    const entry = await loadRepayableEntry(db, organizationId, entryId);
    const from = shiftIsoDate(entry.entryDate, -window);
    const to = shiftIsoDate(entry.entryDate, window);
    const liveLinkedTxns = db
      .select({ transactionId: ledgerEntryLinks.transactionId })
      .from(ledgerEntryLinks)
      .where(ne(ledgerEntryLinks.status, "rejected"));

    const rows = await db
      .select({
        transactionId: transactions.id,
        date: transactions.date,
        amountCents: transactions.amountCents,
        name: transactions.name,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.organizationId, organizationId),
          eq(transactions.amountCents, entry.amountCents),
          gte(transactions.date, from),
          lte(transactions.date, to),
          eq(transactions.pending, false),
          notInArray(transactions.id, liveLinkedTxns),
        ),
      )
      .orderBy(asc(transactions.date), asc(transactions.name))
      .limit(maxRows);

    const candidates = rows.map((row) =>
      Object.freeze({
        transactionId: row.transactionId,
        date: row.date,
        amountCents: row.amountCents,
        name: sanitizeUntrustedText(row.name),
      }),
    );
    return Object.freeze({
      entryId,
      amountCents: entry.amountCents,
      entryDate: entry.entryDate,
      candidates: Object.freeze(candidates),
      ambiguous: candidates.length > 1,
    });
  }

  /**
   * Propose a link. The matching rule is re-validated here — never
   * trusted from the caller — so an invented pairing writes nothing.
   * Only `proposed` is ever written; confirming is a separate human
   * decision (confirmLink).
   */
  async function proposeLink(
    db: Db,
    organizationId: string,
    input: { entryId: string; transactionId: string },
  ): Promise<LedgerLink> {
    const entry = await loadRepayableEntry(db, organizationId, input.entryId);
    const txns = await db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.id, input.transactionId),
          eq(transactions.organizationId, organizationId),
        ),
      );
    const txn = txns[0];
    if (!txn) {
      throw new LedgerLinkError("TRANSACTION_NOT_FOUND", "transaction id");
    }
    const matchesRule =
      !txn.pending &&
      txn.amountCents === entry.amountCents &&
      txn.date >= shiftIsoDate(entry.entryDate, -window) &&
      txn.date <= shiftIsoDate(entry.entryDate, window);
    if (!matchesRule) {
      throw new LedgerLinkError(
        "CANDIDATE_MISMATCH",
        "transaction does not satisfy the matching rule",
      );
    }

    try {
      return await db.transaction(async (tx) => {
        const liveForEntry = await tx
          .select({ id: ledgerEntryLinks.id })
          .from(ledgerEntryLinks)
          .where(
            and(
              eq(ledgerEntryLinks.entryId, input.entryId),
              ne(ledgerEntryLinks.status, "rejected"),
            ),
          );
        if (liveForEntry.length > 0) {
          throw new LedgerLinkError("LINK_EXISTS", "entry already has a link");
        }
        const liveForTxn = await tx
          .select({ id: ledgerEntryLinks.id })
          .from(ledgerEntryLinks)
          .where(
            and(
              eq(ledgerEntryLinks.transactionId, input.transactionId),
              ne(ledgerEntryLinks.status, "rejected"),
            ),
          );
        if (liveForTxn.length > 0) {
          throw new LedgerLinkError(
            "TRANSACTION_LINKED",
            "transaction already proves another entry",
          );
        }
        const inserted = await tx
          .insert(ledgerEntryLinks)
          .values({
            organizationId,
            entryId: input.entryId,
            transactionId: input.transactionId,
            status: "proposed",
          })
          .returning();
        return freezeLink(inserted[0]!);
      });
    } catch (error) {
      if (error instanceof LedgerLinkError) throw error;
      mapDuplicate(error);
    }
  }

  /**
   * Human decision: confirm a proposed link. Idempotent when already
   * confirmed; refused once rejected (a fresh proposal is required).
   * The row is locked for the read-modify-write so two decisions
   * cannot interleave.
   */
  async function confirmLink(
    db: Db,
    organizationId: string,
    linkId: string,
    decision: { decidedBy: string },
  ): Promise<LedgerLink> {
    const decider = validateDecider(decision.decidedBy);
    return db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(ledgerEntryLinks)
        .where(
          and(
            eq(ledgerEntryLinks.id, linkId),
            eq(ledgerEntryLinks.organizationId, organizationId),
          ),
        )
        .for("update");
      const link = rows[0];
      if (!link) {
        throw new LedgerLinkError("LINK_NOT_FOUND", "link id");
      }
      if (link.status === "confirmed") return freezeLink(link); // idempotent
      if (link.status === "rejected") {
        throw new LedgerLinkError(
          "INVALID_TRANSITION",
          "confirm requires a live proposed link",
        );
      }
      const updated = await tx
        .update(ledgerEntryLinks)
        .set({ status: "confirmed", decidedAt: new Date(), decidedBy: decider })
        .where(eq(ledgerEntryLinks.id, linkId))
        .returning();
      return freezeLink(updated[0]!);
    });
  }

  /**
   * Human decision: reject — from `proposed` or from `confirmed`
   * (correcting one's own confirmation). Rejection frees the entry
   * and transaction for a fresh proposal.
   */
  async function rejectLink(
    db: Db,
    organizationId: string,
    linkId: string,
    decision: { decidedBy: string },
  ): Promise<LedgerLink> {
    const decider = validateDecider(decision.decidedBy);
    return db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(ledgerEntryLinks)
        .where(
          and(
            eq(ledgerEntryLinks.id, linkId),
            eq(ledgerEntryLinks.organizationId, organizationId),
          ),
        )
        .for("update");
      const link = rows[0];
      if (!link) {
        throw new LedgerLinkError("LINK_NOT_FOUND", "link id");
      }
      if (link.status === "rejected") return freezeLink(link); // idempotent
      const updated = await tx
        .update(ledgerEntryLinks)
        .set({ status: "rejected", decidedAt: new Date(), decidedBy: decider })
        .where(eq(ledgerEntryLinks.id, linkId))
        .returning();
      return freezeLink(updated[0]!);
    });
  }

  /** Review queue / lookup, org-scoped and row-capped. */
  async function listLinks(
    db: Db,
    organizationId: string,
    filters: ListLinkFilters = {},
  ): Promise<readonly LedgerLink[]> {
    const limit = filters.limit ?? DEFAULT_MAX_ROWS;
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new LedgerLinkError(
        "INVALID_CONFIG",
        "limit must be a positive integer",
      );
    }
    const conditions = [eq(ledgerEntryLinks.organizationId, organizationId)];
    if (filters.linkId !== undefined) {
      conditions.push(eq(ledgerEntryLinks.id, filters.linkId));
    }
    if (filters.entryId !== undefined) {
      conditions.push(eq(ledgerEntryLinks.entryId, filters.entryId));
    }
    if (filters.status !== undefined) {
      conditions.push(eq(ledgerEntryLinks.status, filters.status));
    }
    const rows = await db
      .select()
      .from(ledgerEntryLinks)
      .where(and(...conditions))
      .orderBy(desc(ledgerEntryLinks.createdAt), desc(ledgerEntryLinks.id))
      .limit(limit);
    return Object.freeze(rows.map(freezeLink));
  }

  return Object.freeze({
    findRepaymentCandidates,
    proposeLink,
    confirmLink,
    rejectLink,
    listLinks,
  });
}

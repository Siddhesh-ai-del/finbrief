/**
 * Ledger aggregation tools (plan Step 3.3) — whoOwesWhat,
 * settlementHistory, debtPayoffProjection on the Step 2.1 figure
 * contract, with provenance pointing at the LEDGER.
 *
 * §6.2-6/7 applies verbatim: the model narrates over these fixed,
 * code-computed figures and never divides money itself. The payoff
 * projection is amortization math — per-period interest, clamped
 * final payment, month counting — performed here in integer cents,
 * with the interest policy (aprBps) and schedule limit (maxMonths)
 * fixed at CONSTRUCTION time so a caller cannot negotiate the rate.
 *
 * Contract (mirrors 2.1, pinned by tests/insight/ledger-tools.test.ts):
 *
 * - Frozen `{ values[], asOf, currency, sourceRef[] }` all the way
 *   down (immutability); `asOf` from the injected clock.
 * - `sourceRef` = `{ kind: "ledger_entry" }` with OUR surrogate
 *   entry ids only (§3.8 send-set), id list capped at maxRows and
 *   the EXACT rowCount behind it — a capped list is never mistaken
 *   for full provenance.
 * - `currency` is ALWAYS null: manually-recorded obligations carry
 *   no ISO code, and inventing one would be a money fiction. Phase
 *   4 must not narrate a unit the data never had.
 * - Row caps enforced here, never chosen by the model (Open Q15).
 * - Aliases re-sanitized at this send-set build point (§3.8) —
 *   hostile bytes at rest still never leave the boundary.
 * - Tenancy by construction: organization_id in every WHERE.
 * - Errors name fields, never values (Steps 1.2/1.5).
 *
 * whoOwesWhat shows live positions only (non-zero balances — a
 * settled counterparty disappears); settlementHistory shows live
 * settlement entries only (debts and tombstoned rows excluded).
 * Projection direction lives in the signed opening balance: positive
 * = the counterparty owes the org, negative = the org owes them; the
 * schedule always clears |balance|.
 */
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  sql,
  type SQL,
} from "drizzle-orm";
import { ledgerCounterparties, ledgerEntries } from "../db/schema/ledger";
import type { Db } from "../db/tenancy";
import { sanitizeUntrustedText } from "../security/untrusted-text";
import { DEFAULT_MAX_ROWS } from "./aggregations";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Default schedule limit: 100 years of monthly payments. */
export const DEFAULT_MAX_MONTHS = 1200;

/** Default interest policy: 0 bps — informal IOUs are interest-free. */
export const DEFAULT_APR_BPS = 0;

/** Invalid construction-time policy values. */
export class LedgerToolConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerToolConfigError";
  }
}

/** Invalid query parameters (dates, counterparty, payment, schedule). */
export class LedgerToolQueryError extends Error {
  readonly field: string;

  constructor(field: string, reason: string) {
    // Field + expectation only — never the offending value.
    super(`ledger tool field "${field}" ${reason}`);
    this.name = "LedgerToolQueryError";
    this.field = field;
  }
}

/** Provenance for one figure — OUR entry ids, never an external id. */
export interface LedgerSourceRef {
  readonly kind: "ledger_entry";
  /** Capped sample of contributing entry ids (deterministic order). */
  readonly entryIds: readonly string[];
  /** Exact number of entries behind the figure (may exceed the cap). */
  readonly rowCount: number;
  readonly fromDate: string | null;
  readonly toDate: string | null;
}

export interface LedgerFigure<T> {
  readonly values: readonly T[];
  readonly asOf: Date;
  /** Always null — ledger rows carry no ISO code (see module doc). */
  readonly currency: string | null;
  readonly sourceRef: readonly LedgerSourceRef[];
}

export interface WhoOwesWhatValue {
  readonly counterpartyId: string;
  readonly alias: string;
  readonly balanceCents: number;
}

export interface SettlementValue {
  readonly entryId: string;
  readonly counterpartyId: string;
  readonly alias: string;
  readonly amountCents: number;
  readonly entryDate: string;
}

export interface ScheduleRow {
  readonly month: number;
  readonly openingCents: number;
  readonly interestCents: number;
  readonly paymentCents: number;
  readonly closingCents: number;
}

export interface ProjectionSummary {
  readonly counterpartyId: string;
  readonly alias: string;
  /** Signed: + the counterparty owes the org, − the org owes them. */
  readonly openingBalanceCents: number;
  readonly aprBps: number;
  readonly monthlyPaymentCents: number;
  readonly totalMonths: number;
  readonly totalPaidCents: number;
}

export interface ProjectionFigure {
  readonly values: readonly ScheduleRow[];
  readonly summary: ProjectionSummary;
  readonly asOf: Date;
  readonly currency: string | null;
  readonly sourceRef: readonly LedgerSourceRef[];
}

export interface LedgerToolsConfig {
  /** Row/sample cap (the model never chooses a LIMIT). */
  readonly maxRows?: number;
  /** Interest policy in basis points — construction-time only. */
  readonly aprBps?: number;
  /** Schedule month limit for projections. */
  readonly maxMonths?: number;
  /** Injectable clock for asOf (tests). */
  readonly now?: () => Date;
}

export interface SettlementHistoryOptions {
  readonly counterpartyId?: string;
  readonly fromDate?: string;
  readonly toDate?: string;
}

export interface PayoffInput {
  readonly counterpartyId: string;
  readonly monthlyPaymentCents: number;
}

/** The transaction handle type underlying the pool-backed Db. */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

function validateDate(field: string, value: string): void {
  if (!ISO_DATE.test(value)) {
    throw new LedgerToolQueryError(field, "expected ISO YYYY-MM-DD");
  }
}

function validateWindow(options: SettlementHistoryOptions): void {
  if (options.fromDate !== undefined)
    validateDate("fromDate", options.fromDate);
  if (options.toDate !== undefined) validateDate("toDate", options.toDate);
  if (
    options.fromDate !== undefined &&
    options.toDate !== undefined &&
    options.fromDate > options.toDate
  ) {
    throw new LedgerToolQueryError("fromDate", "must not exceed toDate");
  }
}

function emptySource(): LedgerSourceRef {
  return Object.freeze({
    kind: "ledger_entry" as const,
    entryIds: Object.freeze([]) as readonly string[],
    rowCount: 0,
    fromDate: null,
    toDate: null,
  });
}

/** Capped id sample + exact count behind a set of entry conditions. */
async function ledgerSourceRef(
  tx: Tx,
  conditions: SQL[],
  maxRows: number,
  fromDate: string | null,
  toDate: string | null,
): Promise<LedgerSourceRef> {
  const where = and(...conditions);
  const ids = await tx
    .select({ id: ledgerEntries.id })
    .from(ledgerEntries)
    .where(where)
    .orderBy(asc(ledgerEntries.createdAt), asc(ledgerEntries.id))
    .limit(maxRows);
  const counted = await tx
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(ledgerEntries)
    .where(where);
  return Object.freeze({
    kind: "ledger_entry" as const,
    entryIds: Object.freeze(ids.map((r) => r.id)),
    rowCount: counted[0]?.n ?? 0,
    fromDate,
    toDate,
  });
}

function freezeFigure<T>(
  values: T[],
  asOf: Date,
  source: LedgerSourceRef,
): LedgerFigure<T> {
  return Object.freeze({
    values: Object.freeze(values.map((v) => Object.freeze(v))),
    asOf,
    currency: null,
    sourceRef: Object.freeze([source]),
  });
}

export function createLedgerTools(config: LedgerToolsConfig = {}) {
  const maxRows = config.maxRows ?? DEFAULT_MAX_ROWS;
  if (!Number.isInteger(maxRows) || maxRows <= 0) {
    throw new LedgerToolConfigError("maxRows must be a positive integer");
  }
  const maxMonths = config.maxMonths ?? DEFAULT_MAX_MONTHS;
  if (!Number.isInteger(maxMonths) || maxMonths <= 0) {
    throw new LedgerToolConfigError("maxMonths must be a positive integer");
  }
  const aprBps = config.aprBps ?? DEFAULT_APR_BPS;
  if (!Number.isSafeInteger(aprBps) || aprBps < 0) {
    throw new LedgerToolConfigError(
      "aprBps must be a non-negative safe integer",
    );
  }
  const now = config.now ?? (() => new Date());

  /**
   * Open positions: signed net balance per live counterparty,
   * non-zero only, largest exposure first, row-capped.
   */
  async function whoOwesWhat(
    db: Db,
    organizationId: string,
  ): Promise<LedgerFigure<WhoOwesWhatValue>> {
    const asOf = now();
    return db.transaction(async (tx) => {
      const rows = await tx
        .select({
          counterpartyId: ledgerEntries.counterpartyId,
          alias: ledgerCounterparties.alias,
          balance: sql<string>`COALESCE(SUM(${ledgerEntries.amountCents}), 0)::bigint`,
        })
        .from(ledgerEntries)
        .innerJoin(
          ledgerCounterparties,
          eq(ledgerCounterparties.id, ledgerEntries.counterpartyId),
        )
        .where(
          and(
            eq(ledgerEntries.organizationId, organizationId),
            eq(ledgerCounterparties.organizationId, organizationId),
            isNull(ledgerEntries.tombstonedAt),
            isNull(ledgerCounterparties.tombstonedAt),
          ),
        )
        .groupBy(ledgerEntries.counterpartyId, ledgerCounterparties.alias)
        .having(sql`COALESCE(SUM(${ledgerEntries.amountCents}), 0) <> 0`)
        .orderBy(
          desc(sql`ABS(COALESCE(SUM(${ledgerEntries.amountCents}), 0))`),
          asc(ledgerEntries.counterpartyId),
        )
        .limit(maxRows);

      const values = rows.map((r) => ({
        counterpartyId: r.counterpartyId,
        alias: sanitizeUntrustedText(r.alias) || "(unknown)",
        balanceCents: Number(r.balance),
      }));

      const cpIds = values.map((v) => v.counterpartyId);
      const source =
        cpIds.length === 0
          ? emptySource()
          : await ledgerSourceRef(
              tx,
              [
                eq(ledgerEntries.organizationId, organizationId),
                isNull(ledgerEntries.tombstonedAt),
                inArray(ledgerEntries.counterpartyId, cpIds),
              ],
              maxRows,
              null,
              null,
            );
      return freezeFigure(values, asOf, source);
    });
  }

  /**
   * Live settlement entries in chronological order, optionally for
   * one counterparty inside an inclusive entry-date window. Debts
   * and tombstoned rows are excluded — this is the history of what
   * still counts. Tombstoned counterparties keep their history (a
   * closed relationship is exactly what an audit wants to read).
   */
  async function settlementHistory(
    db: Db,
    organizationId: string,
    options: SettlementHistoryOptions = {},
  ): Promise<LedgerFigure<SettlementValue>> {
    validateWindow(options);
    const asOf = now();
    return db.transaction(async (tx) => {
      const conditions = [
        eq(ledgerEntries.organizationId, organizationId),
        eq(ledgerEntries.kind, "settlement"),
        isNull(ledgerEntries.tombstonedAt),
      ];
      if (options.counterpartyId !== undefined) {
        conditions.push(
          eq(ledgerEntries.counterpartyId, options.counterpartyId),
        );
      }
      if (options.fromDate !== undefined) {
        conditions.push(gte(ledgerEntries.entryDate, options.fromDate));
      }
      if (options.toDate !== undefined) {
        conditions.push(lte(ledgerEntries.entryDate, options.toDate));
      }

      const rows = await tx
        .select({
          entryId: ledgerEntries.id,
          counterpartyId: ledgerEntries.counterpartyId,
          alias: ledgerCounterparties.alias,
          amountCents: ledgerEntries.amountCents,
          entryDate: ledgerEntries.entryDate,
        })
        .from(ledgerEntries)
        .innerJoin(
          ledgerCounterparties,
          eq(ledgerCounterparties.id, ledgerEntries.counterpartyId),
        )
        .where(and(...conditions))
        .orderBy(asc(ledgerEntries.entryDate), asc(ledgerEntries.id))
        .limit(maxRows);

      const values = rows.map((r) => ({
        entryId: r.entryId,
        counterpartyId: r.counterpartyId,
        alias: sanitizeUntrustedText(r.alias) || "(unknown)",
        amountCents: r.amountCents,
        entryDate: r.entryDate,
      }));
      const source = await ledgerSourceRef(
        tx,
        conditions,
        maxRows,
        options.fromDate ?? null,
        options.toDate ?? null,
      );
      return freezeFigure(values, asOf, source);
    });
  }

  /**
   * Fixed amortization in code (§6.2-6/7 — never the model):
   *
   *   each month: interest = round(balance × aprBps/120000)
   *               payment   = min(monthlyPaymentCents, balance + interest)
   *               balance  := balance + interest − payment
   *
   * Integer cents throughout; the final payment is clamped so the
   * closing balance lands on exactly zero. Guards: a payment that
   * does not exceed the first period's interest can never converge
   * (typed error before any schedule is built), and a schedule past
   * maxMonths is a typed error instead of an unbounded loop.
   */
  async function debtPayoffProjection(
    db: Db,
    organizationId: string,
    input: PayoffInput,
  ): Promise<ProjectionFigure> {
    if (
      !Number.isSafeInteger(input.monthlyPaymentCents) ||
      input.monthlyPaymentCents <= 0
    ) {
      throw new LedgerToolQueryError(
        "monthlyPaymentCents",
        "expected a positive integer",
      );
    }
    const asOf = now();
    return db.transaction(async (tx) => {
      const cpRows = await tx
        .select({
          alias: ledgerCounterparties.alias,
          tombstonedAt: ledgerCounterparties.tombstonedAt,
        })
        .from(ledgerCounterparties)
        .where(
          and(
            eq(ledgerCounterparties.id, input.counterpartyId),
            eq(ledgerCounterparties.organizationId, organizationId),
          ),
        );
      const cp = cpRows[0];
      if (!cp) {
        throw new LedgerToolQueryError(
          "counterpartyId",
          "not found in this organization",
        );
      }
      const balanceRows = await tx
        .select({
          total: sql<string>`COALESCE(SUM(${ledgerEntries.amountCents}), 0)::bigint`,
        })
        .from(ledgerEntries)
        .where(
          and(
            eq(ledgerEntries.organizationId, organizationId),
            eq(ledgerEntries.counterpartyId, input.counterpartyId),
            isNull(ledgerEntries.tombstonedAt),
          ),
        );
      const balance = Number(balanceRows[0]?.total ?? 0);
      if (balance === 0) {
        // 3.1 guarantees a tombstoned counterparty lands here too.
        throw new LedgerToolQueryError(
          "counterpartyId",
          "has no outstanding balance",
        );
      }

      const principal = Math.abs(balance);
      const monthlyRate = aprBps / 120_000; // bps/yr → monthly fraction
      if (aprBps > 0) {
        const firstInterest = Math.round(principal * monthlyRate);
        if (input.monthlyPaymentCents <= firstInterest) {
          throw new LedgerToolQueryError(
            "monthlyPaymentCents",
            "must exceed the first period's interest",
          );
        }
      }

      const schedule: ScheduleRow[] = [];
      let closing = principal;
      let month = 0;
      let totalPaid = 0;
      while (closing > 0) {
        month += 1;
        if (month > maxMonths) {
          throw new LedgerToolQueryError(
            "projection",
            "schedule exceeds the configured month limit",
          );
        }
        const opening = closing;
        const interest = aprBps === 0 ? 0 : Math.round(opening * monthlyRate);
        const withInterest = opening + interest;
        const payment = Math.min(input.monthlyPaymentCents, withInterest);
        closing = withInterest - payment;
        totalPaid += payment;
        schedule.push({
          month,
          openingCents: opening,
          interestCents: interest,
          paymentCents: payment,
          closingCents: closing,
        });
      }

      const source = await ledgerSourceRef(
        tx,
        [
          eq(ledgerEntries.organizationId, organizationId),
          eq(ledgerEntries.counterpartyId, input.counterpartyId),
          isNull(ledgerEntries.tombstonedAt),
        ],
        maxRows,
        null,
        null,
      );
      return Object.freeze({
        values: Object.freeze(
          schedule.slice(0, maxRows).map((row) => Object.freeze(row)),
        ),
        summary: Object.freeze({
          counterpartyId: input.counterpartyId,
          alias: sanitizeUntrustedText(cp.alias) || "(unknown)",
          openingBalanceCents: balance,
          aprBps,
          monthlyPaymentCents: input.monthlyPaymentCents,
          totalMonths: month,
          totalPaidCents: totalPaid,
        }),
        asOf,
        currency: null,
        sourceRef: Object.freeze([source]),
      });
    });
  }

  return Object.freeze({
    whoOwesWhat,
    settlementHistory,
    debtPayoffProjection,
  });
}

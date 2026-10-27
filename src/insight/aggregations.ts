/**
 * Aggregation core (plan Step 2.1) — where money math lives.
 *
 * The product rule this module exists for (§6.2-6/7): the model
 * narrates over fixed, code-computed aggregates; it never does
 * arithmetic over money itself (Spider 2.0: 21.3% arithmetic error;
 * FinanceBench: 81% wrong/refused). Every figure therefore leaves
 * this module stamped with `asOf`, a `currency`, and `sourceRef`
 * (§6.2-7/10) — Phase 4's envelope refuses to render a figure whose
 * sourceRef is empty.
 *
 * Invariants, pinned by tests/insight/aggregations.test.ts:
 *
 * - **Shape**: `{ values[], asOf, currency, sourceRef[] }`, frozen
 *   all the way down (immutability — a caller cannot mutate a figure
 *   after the fact).
 * - **sourceRef** carries only OUR surrogate row ids (§3.8 send-set
 *   rule, Step 1.5 — Plaid ids never leave this boundary), an id
 *   list capped at the row cap, and the EXACT rowCount behind the
 *   figure so a capped id list can never be mistaken for the whole
 *   provenance.
 * - **Posted rows only**: `pending` rows are excluded everywhere. A
 *   pending row and its posted replacement can coexist briefly in
 *   the sync stream; including both would double-count.
 * - **Scope**: `organization_id` in every WHERE (tenancy by
 *   construction, Step 0.2), joined to plaid_items to drop rows
 *   owned by `removed` items (unsubscribe tombstones, Step 1.6).
 *   `stale` items keep their history — stale data is old data, not
 *   false data; Step 2.2 flags its age.
 * - **One currency per figure**: a window spanning two ISO codes
 *   throws instead of summing across currencies (that would invent
 *   money). All-null codes → currency null.
 * - **Row caps enforced here, not in the prompt** (Open Q15): the
 *   model never chooses a LIMIT; config sets maxRows, default 100.
 * - **Labels are counterparty-controlled**: merchant/category labels
 *   pass through Step 1.5's sanitizer — this is the send-set build
 *   point where "sanitize at prompt-assembly time" happens.
 * - **No echoed values in errors**: validation messages name the
 *   field, never the offending input (Steps 1.2/1.5 discipline).
 *
 * `balanceAsOf` is the NET POSITION (inflows − outflows) computed
 * from synced transactions — not a bank-reported balance (Plaid's
 * balance endpoint is not wired in Phase 1/2; the distinction is
 * documented so no caller narrates it as "your bank says").
 */
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  isNotNull,
  lte,
  sql,
  type SQL,
} from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { plaidItems } from "../db/schema/plaid";
import { transactions } from "../db/schema/transactions";
import type { Db } from "../db/tenancy";
import { sanitizeUntrustedText } from "../security/untrusted-text";

/** Plan Open Q15: row/page caps start at 100, config-driven. */
export const DEFAULT_MAX_ROWS = 100;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export class AggregationConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AggregationConfigError";
  }
}

/** Invalid query parameters (dates, months, currency mixing). */
export class AggregationQueryError extends Error {
  readonly field: string;

  constructor(field: string, reason: string) {
    // Field + expectation only — never the offending value.
    super(`aggregation field "${field}" ${reason}`);
    this.name = "AggregationQueryError";
    this.field = field;
  }
}

/** Inclusive ISO-date window; both bounds optional. */
export interface AggregationWindow {
  fromDate?: string;
  toDate?: string;
}

/** Provenance for one figure — ids are OUR surrogates, never Plaid's. */
export interface TransactionSourceRef {
  readonly kind: "transaction";
  /** Capped sample of contributing row ids (deterministic order). */
  readonly transactionIds: readonly string[];
  /** Exact number of rows behind the figure (may exceed the cap). */
  readonly rowCount: number;
  readonly fromDate: string | null;
  readonly toDate: string | null;
}

export interface AggregationResult<T> {
  readonly values: readonly T[];
  asOf: Date;
  currency: string | null;
  sourceRef: readonly TransactionSourceRef[];
}

export interface SpendValue {
  merchant: string;
  totalCents: number;
  txnCount: number;
}

export interface CategoryValue {
  category: string;
  totalCents: number;
  txnCount: number;
}

export interface MonthOverMonthValue {
  month: string;
  previousMonth: string;
  spendCents: number;
  previousSpendCents: number;
  deltaCents: number;
  /** Relative change in basis points; null when previous is zero. */
  deltaBps: number | null;
}

export interface BalanceValue {
  date: string;
  netCents: number;
}

export interface AggregationsConfig {
  /** Row/group cap (plan: enforced in the tool, never the model). */
  maxRows?: number;
  /** Injectable clock for the default month and asOf (tests). */
  now?: () => Date;
}

const scopeConditions = (
  organizationId: string,
  window?: AggregationWindow,
  includeWindow = true,
) => {
  const conditions = [
    eq(transactions.organizationId, organizationId),
    eq(transactions.pending, false),
    sql`${plaidItems.status} <> 'removed'`,
  ];
  if (includeWindow && window?.fromDate) {
    conditions.push(gte(transactions.date, window.fromDate));
  }
  if (includeWindow && window?.toDate) {
    conditions.push(lte(transactions.date, window.toDate));
  }
  return conditions;
};

const MERCHANT_KEY = sql`COALESCE(${transactions.merchantName}, ${transactions.name})`;

/** Internal grouped row before the label is split into its field. */
interface LabeledValue {
  label: string;
  totalCents: number;
  txnCount: number;
}

/** The transaction handle type underlying the pool-backed Db. */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

function validateDate(field: string, value: string): void {
  if (!ISO_DATE.test(value)) {
    throw new AggregationQueryError(field, "expected ISO YYYY-MM-DD");
  }
}

function validateWindow(window: AggregationWindow | undefined): void {
  if (window?.fromDate) validateDate("fromDate", window.fromDate);
  if (window?.toDate) validateDate("toDate", window.toDate);
  if (window?.fromDate && window?.toDate && window.fromDate > window.toDate) {
    throw new AggregationQueryError("fromDate", "must not exceed toDate");
  }
}

/** One currency per figure, or null when none is known. */
async function resolveCurrency(
  tx: Tx,
  conditions: ReturnType<typeof scopeConditions>,
): Promise<string | null> {
  const rows = await tx
    .selectDistinct({ code: transactions.isoCurrencyCode })
    .from(transactions)
    .innerJoin(plaidItems, eq(plaidItems.id, transactions.plaidItemId))
    .where(and(...conditions, isNotNull(transactions.isoCurrencyCode)));
  const codes = [...new Set(rows.map((r) => r.code).filter(Boolean))];
  if (codes.length > 1) {
    throw new AggregationQueryError(
      "currency",
      "window spans multiple currencies",
    );
  }
  return (codes[0] as string | undefined) ?? null;
}

async function sourceRefFor(
  tx: Tx,
  conditions: ReturnType<typeof scopeConditions>,
  maxRows: number,
  window: AggregationWindow | undefined,
): Promise<TransactionSourceRef> {
  const ids = await tx
    .select({ id: transactions.id })
    .from(transactions)
    .innerJoin(plaidItems, eq(plaidItems.id, transactions.plaidItemId))
    .where(and(...conditions))
    .orderBy(asc(transactions.date), asc(transactions.id))
    .limit(maxRows);
  const counted = await tx
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(transactions)
    .innerJoin(plaidItems, eq(plaidItems.id, transactions.plaidItemId))
    .where(and(...conditions));
  return Object.freeze({
    kind: "transaction" as const,
    transactionIds: Object.freeze(ids.map((r) => r.id)),
    rowCount: counted[0]?.n ?? 0,
    fromDate: window?.fromDate ?? null,
    toDate: window?.toDate ?? null,
  });
}

function freezeResult<T>(
  values: T[],
  asOf: Date,
  currency: string | null,
  source: TransactionSourceRef,
): AggregationResult<T> {
  return Object.freeze({
    values: Object.freeze(values.map((v) => Object.freeze(v))),
    asOf,
    currency,
    sourceRef: Object.freeze([source]),
  });
}

function monthBounds(month: string): { from: string; to: string } {
  const [year, mon] = month.split("-").map(Number) as [number, number];
  const lastDay = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return {
    from: `${month}-01`,
    to: `${month}-${String(lastDay).padStart(2, "0")}`,
  };
}

function previousMonth(month: string): string {
  const [year, mon] = month.split("-").map(Number) as [number, number];
  return mon === 1
    ? `${year - 1}-12`
    : `${year}-${String(mon - 1).padStart(2, "0")}`;
}

function validateMonth(month: string): void {
  if (!ISO_MONTH.test(month)) {
    throw new AggregationQueryError("month", "expected ISO YYYY-MM");
  }
}

export function createAggregations(config: AggregationsConfig = {}) {
  const maxRows = config.maxRows ?? DEFAULT_MAX_ROWS;
  if (!Number.isInteger(maxRows) || maxRows <= 0) {
    throw new AggregationConfigError("maxRows must be a positive integer");
  }
  const now = config.now ?? (() => new Date());

  async function spendBy(
    db: Db,
    organizationId: string,
    window: AggregationWindow | undefined,
    groupKey: PgColumn | SQL,
    label: (raw: string | null) => string,
  ): Promise<AggregationResult<LabeledValue>> {
    validateWindow(window);
    const asOf = now();
    return db.transaction(async (tx) => {
      const conditions = scopeConditions(organizationId, window);
      const currency = await resolveCurrency(tx, conditions);
      const rows = await tx
        .select({
          key: sql<string | null>`${groupKey}`,
          total: sql<string>`SUM(${transactions.amountCents})::bigint`,
          n: sql<number>`COUNT(*)::int`,
        })
        .from(transactions)
        .innerJoin(plaidItems, eq(plaidItems.id, transactions.plaidItemId))
        .where(and(...conditions, gt(transactions.amountCents, 0)))
        .groupBy(groupKey)
        .orderBy(desc(sql`SUM(${transactions.amountCents})`), asc(groupKey))
        .limit(maxRows);
      const values = rows.map((r) => ({
        label: label(r.key),
        totalCents: Number(r.total),
        txnCount: r.n,
      }));
      const source = await sourceRefFor(tx, conditions, maxRows, window);
      return freezeResult(values, asOf, currency, source);
    });
  }

  /** Posted outflows by merchant (name fallback), total desc. */
  async function spendByMerchant(
    db: Db,
    organizationId: string,
    window?: AggregationWindow,
  ): Promise<AggregationResult<SpendValue>> {
    const result = await spendBy(
      db,
      organizationId,
      window,
      MERCHANT_KEY,
      (raw) => sanitizeUntrustedText(raw) || "(unknown)",
    );
    return freezeResult(
      result.values.map(({ label, ...rest }) => ({
        merchant: label,
        ...rest,
      })),
      result.asOf,
      result.currency,
      result.sourceRef[0] as TransactionSourceRef,
    );
  }

  /** Posted outflows by Plaid primary category, total desc. */
  async function spendByCategory(
    db: Db,
    organizationId: string,
    window?: AggregationWindow,
  ): Promise<AggregationResult<CategoryValue>> {
    const result = await spendBy(
      db,
      organizationId,
      window,
      transactions.personalFinanceCategoryPrimary,
      (raw) => sanitizeUntrustedText(raw) || "Uncategorized",
    );
    return freezeResult(
      result.values.map(({ label, ...rest }) => ({
        category: label,
        ...rest,
      })),
      result.asOf,
      result.currency,
      result.sourceRef[0] as TransactionSourceRef,
    );
  }

  /** Spend for a month vs the previous month, in cents and bps. */
  async function monthOverMonth(
    db: Db,
    organizationId: string,
    month?: string,
  ): Promise<AggregationResult<MonthOverMonthValue>> {
    const effectiveMonth = month ?? now().toISOString().slice(0, 7);
    validateMonth(effectiveMonth);
    const current = monthBounds(effectiveMonth);
    const previous = monthBounds(previousMonth(effectiveMonth));
    const currentWindow: AggregationWindow = {
      fromDate: current.from,
      toDate: current.to,
    };
    const asOf = now();
    return db.transaction(async (tx) => {
      // Currency spans BOTH months: a delta across currencies would
      // invent money. The union is contiguous (Dec+Jan, ...).
      const conditions = scopeConditions(organizationId, {
        fromDate: previous.from,
        toDate: current.to,
      });
      const currency = await resolveCurrency(tx, conditions);

      const spendFor = async (from: string, to: string) => {
        const rows = await tx
          .select({
            total: sql<string>`COALESCE(SUM(${transactions.amountCents}), 0)::bigint`,
          })
          .from(transactions)
          .innerJoin(plaidItems, eq(plaidItems.id, transactions.plaidItemId))
          .where(
            and(
              ...scopeConditions(organizationId, {
                fromDate: from,
                toDate: to,
              }),
              gt(transactions.amountCents, 0),
            ),
          );
        return Number(rows[0]?.total ?? 0);
      };

      const spendCents = await spendFor(current.from, current.to);
      const previousSpendCents = await spendFor(previous.from, previous.to);
      const deltaCents = spendCents - previousSpendCents;
      const deltaBps =
        previousSpendCents > 0
          ? Math.round((deltaCents * 10_000) / previousSpendCents)
          : null;

      const source = await sourceRefFor(
        tx,
        scopeConditions(organizationId, currentWindow),
        maxRows,
        currentWindow,
      );
      return freezeResult(
        [
          {
            month: effectiveMonth,
            previousMonth: previousMonth(effectiveMonth),
            spendCents,
            previousSpendCents,
            deltaCents,
            deltaBps,
          },
        ],
        asOf,
        currency,
        source,
      );
    });
  }

  /** Net position (inflows − outflows) through `asOfDate`, inclusive. */
  async function balanceAsOf(
    db: Db,
    organizationId: string,
    asOfDate: string,
  ): Promise<AggregationResult<BalanceValue>> {
    validateDate("asOfDate", asOfDate);
    const asOf = new Date(`${asOfDate}T00:00:00.000Z`);
    return db.transaction(async (tx) => {
      const conditions = [
        ...scopeConditions(organizationId, undefined, false),
        lte(transactions.date, asOfDate),
      ];
      const currency = await resolveCurrency(tx, conditions);
      const rows = await tx
        .select({
          net: sql<string>`COALESCE(SUM(-${transactions.amountCents}), 0)::bigint`,
        })
        .from(transactions)
        .innerJoin(plaidItems, eq(plaidItems.id, transactions.plaidItemId))
        .where(and(...conditions));
      const source = await sourceRefFor(tx, conditions, maxRows, {
        toDate: asOfDate,
      });
      return freezeResult(
        [{ date: asOfDate, netCents: Number(rows[0]?.net ?? 0) }],
        asOf,
        currency,
        source,
      );
    });
  }

  return { spendByMerchant, spendByCategory, monthOverMonth, balanceAsOf };
}

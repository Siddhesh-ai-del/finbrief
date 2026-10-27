/**
 * Freshness rules (plan Step 2.2) — the §2.7 mitigation for "stale
 * data presented as current", the one failure mode the cited papers
 * have no sourced defense for. The mitigation is labeled inference:
 * staleness is computed here, from data, and the prose layer must
 * obey it.
 *
 * - **Age source**: `plaid_items.last_synced_at`, stamped by Step
 *   1.3's cursor-commit transaction — the moment the bank's data
 *   actually landed, not `MAX(updated_at)` (which lies for a quiet
 *   account whose syncs succeed with zero new rows).
 * - **Scope**: items with status `removed` (Step 1.6 tombstones) are
 *   excluded entirely — their data is dead, not stale. Items that
 *   never synced have no data to misrepresent: ageHours null, not
 *   stale.
 * - **Config-driven thresholds** (product decision list): max age in
 *   hours per data kind. Only `transactions` is evaluated now;
 *   `ledger` joins when Phase 3 lands its source table.
 * - **Prose tense gate**: `presentTenseAllowed` is the primitive the
 *   Step 5.2 briefing generator MUST compose. The reference
 *   generators here (`draftBalanceClaim`, `draftSpendClaim`) pin the
 *   enforced behavior on generated strings: when the report is
 *   stale, present-tense money claims are forbidden — the claim
 *   falls back to past tense and carries the as-of stamp. A missing
 *   briefing beats a wrong one.
 *
 * All results are frozen (immutability); config values come from
 * config, never hardcoded here (plan anti-pattern).
 */
import { and, eq, ne } from "drizzle-orm";
import { plaidItems } from "../db/schema/plaid";
import type { Db } from "../db/tenancy";

export class FreshnessConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FreshnessConfigError";
  }
}

/** Data kinds with freshness thresholds (transactions now, ledger at 3.x). */
export type DataKind = "transactions" | "ledger";

export interface FreshnessConfig {
  /** Max age in hours per data kind before results are stale. */
  thresholds: Partial<Record<DataKind, number>>;
  /** Injectable clock (tests pin asOf and ages). */
  now?: () => Date;
}

export interface ItemFreshness {
  readonly itemId: string;
  readonly kind: DataKind;
  readonly lastSyncedAt: Date | null;
  /** Sync age in hours; null = never synced (no data, not stale). */
  readonly ageHours: number | null;
  readonly stale: boolean;
}

export interface FreshnessReport {
  readonly asOf: Date;
  /** Any stale item ⇒ figures must not be narrated present-tense. */
  readonly stale: boolean;
  readonly staleItemIds: readonly string[];
  readonly items: readonly ItemFreshness[];
}

const HOUR_MS = 3_600_000;

export async function evaluateFreshness(
  db: Db,
  organizationId: string,
  config: FreshnessConfig,
): Promise<FreshnessReport> {
  const threshold = config.thresholds.transactions;
  if (
    typeof threshold !== "number" ||
    !Number.isFinite(threshold) ||
    threshold <= 0
  ) {
    throw new FreshnessConfigError(
      "thresholds.transactions must be a positive number of hours",
    );
  }
  const now = config.now ?? (() => new Date());
  const asOf = now();

  const rows = await db
    .select({ id: plaidItems.id, lastSyncedAt: plaidItems.lastSyncedAt })
    .from(plaidItems)
    .where(
      and(
        eq(plaidItems.organizationId, organizationId),
        ne(plaidItems.status, "removed"),
      ),
    );

  const items: ItemFreshness[] = rows.map((row) => {
    const ageHours = row.lastSyncedAt
      ? (asOf.getTime() - row.lastSyncedAt.getTime()) / HOUR_MS
      : null;
    return Object.freeze({
      itemId: row.id,
      kind: "transactions" as const,
      lastSyncedAt: row.lastSyncedAt,
      ageHours,
      // Future watermarks (clock skew) are not stale — only old ones.
      stale: ageHours !== null && ageHours > threshold,
    });
  });

  const staleItemIds = items.filter((i) => i.stale).map((i) => i.itemId);
  return Object.freeze({
    asOf,
    stale: staleItemIds.length > 0,
    staleItemIds: Object.freeze(staleItemIds),
    items: Object.freeze(items),
  });
}

/**
 * The tense gate. Fresh data may be narrated in the present ("your
 * balance is $X"); stale data may not — the reference generators
 * below enforce this on the produced strings.
 */
export function presentTenseAllowed(report: FreshnessReport): boolean {
  return !report.stale;
}

/** Integer-cents money formatting — no floats touch money here. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.trunc(abs / 100).toLocaleString("en-US");
  const remainder = String(abs % 100).padStart(2, "0");
  return `${sign}$${dollars}.${remainder}`;
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

function stampDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Reference balance claim: present only when fresh; stamped past when stale. */
export function draftBalanceClaim(
  input: { netCents: number; asOf: Date },
  report: FreshnessReport,
): string {
  const money = formatCents(input.netCents);
  return presentTenseAllowed(report)
    ? `Your balance is ${money}.`
    : `As of ${stampDate(input.asOf)}, your balance was ${money}.`;
}

/** Reference spend claim: past tense always; stale adds the stamp. */
export function draftSpendClaim(
  input: { merchant: string; totalCents: number; month: string; asOf: Date },
  report: FreshnessReport,
): string {
  const money = formatCents(input.totalCents);
  const [year, month] = input.month.split("-").map(Number) as [number, number];
  const monthLabel = `${MONTH_NAMES[month - 1]} ${year}`;
  return presentTenseAllowed(report)
    ? `You spent ${money} at ${input.merchant} in ${monthLabel}.`
    : `As of ${stampDate(input.asOf)}, you had spent ${money} at ${input.merchant} in ${monthLabel}.`;
}

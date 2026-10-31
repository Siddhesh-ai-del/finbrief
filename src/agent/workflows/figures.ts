/**
 * Figure converters (plan Step 4.2) — the ONLY bridge between
 * Step 2.1/3.3 tool results and Step 4.1 drafts. Each converter is
 * pure and deterministic: label + integer cents + the tool's OWN
 * source ref, passed through unchanged. The model never transforms
 * a figure; it can only reference what these functions collected.
 */
import { formatCents } from "../../insight/freshness";
import type {
  AggregationResult,
  BalanceValue,
  CategoryValue,
  MonthOverMonthValue,
  SpendValue,
  TransactionSourceRef,
} from "../../insight/aggregations";
import type {
  LedgerFigure,
  LedgerSourceRef,
  SettlementValue,
  WhoOwesWhatValue,
} from "../../insight/ledger-tools";

export interface DraftFigure {
  readonly label: string;
  readonly amountCents: number;
  readonly sourceRef: readonly (TransactionSourceRef | LedgerSourceRef)[];
}

function convert<T>(
  result: AggregationResult<T> | LedgerFigure<T>,
  pick: (value: T) => { label: string; amountCents: number },
): readonly DraftFigure[] {
  return Object.freeze(
    result.values.map((value) => {
      const { label, amountCents } = pick(value);
      return Object.freeze({ label, amountCents, sourceRef: result.sourceRef });
    }),
  );
}

export function spendFigures(
  result: AggregationResult<SpendValue>,
): readonly DraftFigure[] {
  return convert(result, (v) => ({
    label: v.merchant,
    amountCents: v.totalCents,
  }));
}

export function categoryFigures(
  result: AggregationResult<CategoryValue>,
): readonly DraftFigure[] {
  return convert(result, (v) => ({
    label: v.category,
    amountCents: v.totalCents,
  }));
}

export function monthFigures(
  result: AggregationResult<MonthOverMonthValue>,
): readonly DraftFigure[] {
  return convert(result, (v) => ({
    label: v.month,
    amountCents: v.spendCents,
  }));
}

export function balanceFigures(
  result: AggregationResult<BalanceValue>,
): readonly DraftFigure[] {
  return convert(result, (v) => ({ label: v.date, amountCents: v.netCents }));
}

export function whoOwesFigures(
  result: LedgerFigure<WhoOwesWhatValue>,
): readonly DraftFigure[] {
  return convert(result, (v) => ({
    label: v.alias,
    amountCents: v.balanceCents,
  }));
}

export function settlementFigures(
  result: LedgerFigure<SettlementValue>,
): readonly DraftFigure[] {
  return convert(result, (v) => ({
    label: v.alias,
    amountCents: v.amountCents,
  }));
}

/** Numbered figure list for model prompts: `[0] Alex: $50.00`. */
export function describeFigures(figures: readonly DraftFigure[]): string {
  return figures
    .map(
      (figure, index) =>
        `[${index}] ${figure.label}: ${formatCents(figure.amountCents)}`,
    )
    .join("\n");
}

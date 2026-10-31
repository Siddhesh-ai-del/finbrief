/**
 * Step 4.2 — figure converters (plan Phase 4).
 *
 * Every tool result shape that a workflow may cite becomes envelope
 * figures here: label + integer cents + the tool's OWN source ref,
 * unchanged. The model never transforms a figure; these functions
 * are the only bridge between Step 2.1/3.3 results and Step 4.1
 * drafts, and they are pure — deterministic, frozen, no I/O.
 */
import { describe, expect, it } from "vitest";
import {
  balanceFigures,
  categoryFigures,
  describeFigures,
  monthFigures,
  settlementFigures,
  spendFigures,
  whoOwesFigures,
} from "../../../src/agent/workflows/figures";
import type { TransactionSourceRef } from "../../../src/insight/aggregations";
import type { LedgerSourceRef } from "../../../src/insight/ledger-tools";

const txnSource: TransactionSourceRef = {
  kind: "transaction",
  transactionIds: ["t1"],
  rowCount: 3,
  fromDate: "2026-10-01",
  toDate: "2026-10-31",
};

const ledgerSource: LedgerSourceRef = {
  kind: "ledger_entry",
  entryIds: ["e1"],
  rowCount: 2,
  fromDate: null,
  toDate: null,
};

const asOf = new Date("2026-10-20T12:00:00.000Z");

describe("figure converters", () => {
  it("maps spend and category rows onto the transaction source ref", () => {
    const spend = spendFigures({
      values: [
        { merchant: "Grocery Mart", totalCents: 4050, txnCount: 2 },
        { merchant: "Cafe Luna", totalCents: 1299, txnCount: 1 },
      ],
      asOf,
      currency: "USD",
      sourceRef: [txnSource],
    });
    expect(spend).toEqual([
      { label: "Grocery Mart", amountCents: 4050, sourceRef: [txnSource] },
      { label: "Cafe Luna", amountCents: 1299, sourceRef: [txnSource] },
    ]);
    expect(Object.isFrozen(spend)).toBe(true);
    expect(Object.isFrozen(spend[0])).toBe(true);

    const byCategory = categoryFigures({
      values: [{ category: "FOOD_AND_DRINK", totalCents: 5349, txnCount: 3 }],
      asOf,
      currency: "USD",
      sourceRef: [txnSource],
    });
    expect(byCategory[0]).toEqual({
      label: "FOOD_AND_DRINK",
      amountCents: 5349,
      sourceRef: [txnSource],
    });
  });

  it("maps month-over-month and balance series", () => {
    const months = monthFigures({
      values: [
        {
          month: "2026-10",
          previousMonth: "2026-09",
          spendCents: 5349,
          previousSpendCents: 8000,
          deltaCents: -2651,
          deltaBps: -3314,
        },
      ],
      asOf,
      currency: "USD",
      sourceRef: [txnSource],
    });
    expect(months[0]).toEqual({
      label: "2026-10",
      amountCents: 5349,
      sourceRef: [txnSource],
    });

    const balance = balanceFigures({
      values: [{ date: "2026-10-20", netCents: -1234 }],
      asOf,
      currency: "USD",
      sourceRef: [txnSource],
    });
    expect(balance[0]).toEqual({
      label: "2026-10-20",
      amountCents: -1234,
      sourceRef: [txnSource],
    });
  });

  it("maps ledger positions and settlements onto the ledger source ref", () => {
    const who = whoOwesFigures({
      values: [
        { counterpartyId: "cp1", alias: "Alex", balanceCents: 5000 },
        { counterpartyId: "cp2", alias: "Sam", balanceCents: -2000 },
      ],
      asOf,
      currency: null,
      sourceRef: [ledgerSource],
    });
    expect(who).toEqual([
      { label: "Alex", amountCents: 5000, sourceRef: [ledgerSource] },
      { label: "Sam", amountCents: -2000, sourceRef: [ledgerSource] },
    ]);

    const settlements = settlementFigures({
      values: [
        {
          entryId: "e1",
          counterpartyId: "cp1",
          alias: "Alex",
          amountCents: -2000,
          entryDate: "2026-10-10",
        },
      ],
      asOf,
      currency: null,
      sourceRef: [ledgerSource],
    });
    expect(settlements[0]).toEqual({
      label: "Alex",
      amountCents: -2000,
      sourceRef: [ledgerSource],
    });
  });

  it("describes figures for prompts with index and formatted amount", () => {
    const lines = describeFigures([
      { label: "Alex", amountCents: 5000, sourceRef: [ledgerSource] },
      { label: "Cafe Luna", amountCents: -1234, sourceRef: [txnSource] },
    ]);
    expect(lines).toBe("[0] Alex: $50.00\n[1] Cafe Luna: -$12.34");
    expect(describeFigures([])).toBe("");
  });
});

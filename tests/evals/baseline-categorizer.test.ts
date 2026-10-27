/**
 * Step 2.3 — baseline categorizer sanity.
 *
 * This is the deterministic, no-LLM reference implementation. It
 * serves two documented roles: the eval harness's default subject
 * (so the harness itself is testable without a model, per the plan's
 * "PR CI stays deterministic" rule), and the compliance fallback the
 * risk register requires ("keep a no-LLM fallback — categorization
 * ... must still work if Plaid conditions the Permitted Use Case").
 *
 * These tests pin BEHAVIOR (token matching, case-insensitivity,
 * first-rule-wins, OTHER default), not corpus accuracy — quality
 * gating of whatever categorizer ships is the 4.5 eval gate's job.
 */
import { describe, expect, it } from "vitest";
import { baselineCategorize } from "../../evals/categorization/baseline-categorizer.ts";

const predict = (name: string, merchantName: string | null = null) =>
  baselineCategorize({ name, merchantName, amountCents: 1000 });

describe("baselineCategorize", () => {
  it("maps clear merchant signals to their PFCv2 primaries", () => {
    expect(predict("STARBUCKS #14397", "STARBUCKS")).toBe("FOOD_AND_DRINK");
    expect(predict("UBER *TRIP", "UBER")).toBe("TRANSPORTATION");
    expect(predict("NETFLIX.COM", "NETFLIX")).toBe("ENTERTAINMENT");
    expect(predict("HOME DEPOT #6042", "HOME DEPOT")).toBe("HOME_IMPROVEMENT");
    expect(predict("CONEDISON OF NY BILL PAY", "CONEDISON")).toBe(
      "RENT_AND_UTILITIES",
    );
    expect(predict("CVS/PHARMACY #3391", "CVS")).toBe("MEDICAL");
    expect(predict("SUPERCUTS #993", "SUPERCUTS")).toBe("PERSONAL_CARE");
    expect(predict("SHELL OIL 5748293", "SHELL")).toBe("TRANSPORTATION");
  });

  it("is case-insensitive and falls back to the raw name", () => {
    expect(predict("starbucks cafe seattle")).toBe("FOOD_AND_DRINK");
    expect(predict("MCDONALD'S #2211", null)).toBe("FOOD_AND_DRINK");
  });

  it("defaults to OTHER when nothing matches", () => {
    expect(predict("XQZTP FLDW 5529", "XQZTP FLDW")).toBe("OTHER");
  });

  it("first matching rule wins deterministically", () => {
    // A payroll payout through a ride-hail app is INCOME, not a ride.
    expect(predict("UBER *DRIVER PAYOUT", "UBER")).toBe("INCOME");
  });
});

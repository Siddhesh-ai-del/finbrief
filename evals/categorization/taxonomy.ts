/**
 * Plaid PFCv2 primary taxonomy, vendored.
 *
 * Provenance: the primary column of Plaid's published taxonomy CSV
 * (https://plaid.com/documents/pfc-taxonomy-all.csv), fetched
 * 2026-10-27. PFCv2 is a superset of PFCv1; Plaid puts all new
 * customers on PFCv2 (post December 2025), so new items synced by
 * this product speak v2 — the golden corpus and exact-match gate key
 * off these primaries.
 *
 * Vendored rather than fetched at runtime: evals must be
 * deterministic (plan: "PR CI stays deterministic — fixtures/mocks,
 * real-model evals isolated to nightly"). A taxonomy change is a
 * deliberate, reviewed diff to this file, never a silent CI drift.
 */

export const PFC_V2_PRIMARIES = [
  "BANK_FEES",
  "ENTERTAINMENT",
  "FOOD_AND_DRINK",
  "GENERAL_MERCHANDISE",
  "GENERAL_SERVICES",
  "GOVERNMENT_AND_NON_PROFIT",
  "HOME_IMPROVEMENT",
  "INCOME",
  "LOAN_DISBURSEMENTS",
  "LOAN_PAYMENTS",
  "MEDICAL",
  "OTHER",
  "PERSONAL_CARE",
  "RENT_AND_UTILITIES",
  "TRANSFER_IN",
  "TRANSFER_OUT",
  "TRANSPORTATION",
  "TRAVEL",
] as const;

export type PfcPrimary = (typeof PFC_V2_PRIMARIES)[number];

const PRIMARIES: ReadonlySet<string> = new Set(PFC_V2_PRIMARIES);

export function isPfcPrimary(value: string): value is PfcPrimary {
  return PRIMARIES.has(value);
}

/**
 * Baseline categorizer — deterministic, no-LLM, token-based.
 *
 * Two documented roles:
 *
 * 1. **Eval subject for the harness** (Step 2.3): the runner needs
 *    something deterministic to evaluate so the GATE machinery is
 *    testable without a model — plan: "PR CI stays deterministic;
 *    real-model evals isolated to nightly".
 * 2. **Compliance fallback** (risk register): if Plaid conditions or
 *    refuses the Permitted Use Case for LLM categorization, the
 *    product keeps a no-LLM categorization path. This module is that
 *    path's reference implementation — generic merchant-family
 *    tokens, not dataset-row-specific rules (overfitting the golden
 *    corpus would make the gate circular and worthless).
 *
 * Semantics (pinned by tests/evals/baseline-categorizer.test.ts):
 * first matching rule wins in declaration order — rule order encodes
 * genuine precedence (a "UBER *DRIVER PAYOUT" is income, not a
 * ride). No match → OTHER, Plaid's own escape hatch.
 */
import type { PfcPrimary } from "./taxonomy.ts";

export interface CategorizerInput {
  /** Step 1.5-sanitized transaction name (the production boundary). */
  name: string;
  /** Step 1.5-sanitized merchant, when Plaid resolved one. */
  merchantName: string | null;
  amountCents: number;
}

export type Categorizer = (input: CategorizerInput) => PfcPrimary | string;

interface Rule {
  readonly tokens: readonly string[];
  readonly category: PfcPrimary;
}

/** Ordered: precedence is semantic (income beats the app it arrived through). */
const RULES: readonly Rule[] = [
  {
    category: "INCOME",
    tokens: [
      "PAYROLL",
      "SALARY",
      "DIRECT DEP",
      "PAYOUT",
      "DIVIDEND",
      "APY",
      "SSA TREAS",
      "TREAS 310",
      "VETERANS AFFAIRS",
      "GUSTO",
      "ADP ",
    ],
  },
  {
    category: "BANK_FEES",
    tokens: [
      "ATM FEE",
      "OVERDRAFT",
      "INSUFFICIENT FUNDS",
      "FOREIGN TXN FEE",
      "LATE FEE",
      "ANNUAL FEE",
      "NSF FEE",
    ],
  },
  {
    category: "LOAN_DISBURSEMENTS",
    tokens: ["DISBURSE", "CASH ADVANCE", "PAYDAY", "EWA "],
  },
  {
    category: "LOAN_PAYMENTS",
    tokens: [
      "LOAN PMT",
      "LOAN PAYMENT",
      "AUTO LOAN",
      "STUDENT LOAN",
      "CREDIT CARD PAYMENT",
      "BNPL",
      "AFFIRM",
      "KLARNA",
      "MORTGAGE",
      "SALLIE MAE",
      "SOFI",
      "AMEX",
    ],
  },
  {
    category: "TRANSFER_OUT",
    tokens: [
      "TRANSFER TO",
      "ZELLE SENT",
      "VENMO PAYMENT",
      "ACATS",
      "WIRE OUT",
      "CRYPTO",
      "COINBASE",
      "VANGUARD",
      "FIDELITY",
    ],
  },
  {
    category: "TRANSFER_IN",
    tokens: [
      "TRANSFER FROM",
      "ZELLE RECEIPT",
      "VENMO CASHOUT",
      "CASHOUT",
      "WIRE INCOMING",
      "ATM DEPOSIT",
      "DEPOSIT",
    ],
  },
  {
    category: "GOVERNMENT_AND_NON_PROFIT",
    tokens: [
      "IRS ",
      "IRS USATA",
      "DMV",
      "FRANCHISE TAX",
      "TAX BOARD",
      "RED CROSS",
      "SALVATION ARMY",
      "STATE OF",
      "CITY OF",
      "COUNTY OF",
      "DONATION",
      "CHARITY",
    ],
  },
  {
    category: "RENT_AND_UTILITIES",
    tokens: [
      "CONEDISON",
      "PG&E",
      "COMCAST",
      "VERIZON",
      "AT&T",
      "INTERNET",
      "ELECTRIC",
      "WATER BILL",
      "SEWER",
      "RENT PAYMENT",
      "UTILITY",
    ],
  },
  {
    category: "TRAVEL",
    tokens: [
      "DELTA AIR",
      "UNITED AIR",
      "AIRLINES",
      "AIRBNB",
      "MARRIOTT",
      "HILTON",
      "HOTEL",
      "MOTEL",
      "RENT A CAR",
      "SIXT",
    ],
  },
  {
    category: "TRANSPORTATION",
    tokens: [
      "UBER",
      "LYFT",
      "SHELL",
      "EXXON",
      "CHEVRON",
      "MTA",
      "PARKMOBIL",
      "PARKING",
      "CAR WASH",
      "TRANSIT",
    ],
  },
  {
    category: "ENTERTAINMENT",
    tokens: [
      "NETFLIX",
      "SPOTIFY",
      "AMC ",
      "STEAM ",
      "DRAFTKINGS",
      "TICKETMASTER",
      "SPORTSBOOK",
      "CASINO",
      "MOVIE",
      "THEATRE",
      "THEATER",
      "MUSIC",
    ],
  },
  {
    category: "FOOD_AND_DRINK",
    tokens: [
      "STARBUCKS",
      "COFFEE",
      "CAFE",
      "MCDONALD",
      "CHIPOTLE",
      "BISTRO",
      "GRILL",
      "PIZZA",
      "SUSHI",
      "TACO",
      "BURGER",
      "WENDY",
      "SUBWAY",
      "DUNKIN",
      "PANERA",
      "WHOLE FOODS",
      "TRADER JOE",
      "SAFEWAY",
      "KROGER",
      "GROCER",
      "FARMERS MARKET",
      "BAR TAB",
      "TAQUERIA",
      "DELI",
    ],
  },
  {
    category: "GENERAL_MERCHANDISE",
    tokens: [
      "AMAZON",
      "TARGET",
      "WALMART",
      "COSTCO",
      "BEST BUY",
      "BARNES",
      "BOOKSTORE",
      "DEPARTMENT STORE",
      "CLOTHING",
      "ELECTRONICS",
    ],
  },
  {
    category: "HOME_IMPROVEMENT",
    tokens: [
      "HOME DEPOT",
      "LOWES",
      "ACE HARDWARE",
      "SHERWIN",
      "ROTO ROOTER",
      "TERMINIX",
      "HARDWARE",
      "LUMBER",
      "PEST CONTROL",
      "PLUMBING",
    ],
  },
  {
    category: "MEDICAL",
    tokens: [
      "CVS",
      "WALGREENS",
      "PHARMACY",
      "QUEST DIAGNOSTICS",
      "DENTAL",
      "MEDICAL",
      "CLINIC",
      "MENTAL HEALTH",
      "CONSULT",
    ],
  },
  {
    category: "PERSONAL_CARE",
    tokens: [
      "SUPERCUTS",
      "SPORTS CLIPS",
      "BARBERSHOP",
      "MASSAGE ENVY",
      "SPA ",
      "SALON",
      "HAIRCUT",
      "NAIL ",
      "FITNESS",
      "GYM",
    ],
  },
  {
    category: "GENERAL_SERVICES",
    tokens: [
      "ADOBE",
      "LEGALZOOM",
      "H&R BLOCK",
      "HR BLOCK",
      "CHEGG",
      "NOTARY",
      "CREATIVE CLOUD",
      "SUBSCRIPTION",
    ],
  },
] as const;

export const baselineCategorize: Categorizer = (input) => {
  const haystack = `${input.merchantName ?? ""} ${input.name}`.toUpperCase();
  for (const rule of RULES) {
    if (rule.tokens.some((token) => haystack.includes(token))) {
      return rule.category;
    }
  }
  return "OTHER";
};

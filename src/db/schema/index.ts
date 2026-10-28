/**
 * Central schema barrel. `schema` is the object passed to Better
 * Auth's drizzleAdapter — its keys are better-auth model names
 * ("user", "session", ...), which is why they stay singular and
 * camel-free even where the SQL table names differ (consent_records).
 */
import * as billing from "./billing";
import * as consent from "./consent";
import * as core from "./core";
import * as ledger from "./ledger";
import * as organization from "./organization";
import * as plaid from "./plaid";
import * as transactions from "./transactions";

export * from "./billing";
export * from "./consent";
export * from "./core";
export * from "./ledger";
export * from "./organization";
export * from "./plaid";
export * from "./transactions";

export const schema = {
  ...core,
  ...organization,
  ...consent,
  ...billing,
  ...plaid,
  ...transactions,
  ...ledger,
};

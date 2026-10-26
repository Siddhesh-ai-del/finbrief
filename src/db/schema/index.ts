/**
 * Central schema barrel. `schema` is the object passed to Better
 * Auth's drizzleAdapter — its keys are better-auth model names
 * ("user", "session", ...), which is why they stay singular and
 * camel-free even where the SQL table names differ (consent_records).
 */
import * as consent from "./consent";
import * as core from "./core";
import * as organization from "./organization";

export * from "./consent";
export * from "./core";
export * from "./organization";

export const schema = {
  ...core,
  ...organization,
  ...consent,
};

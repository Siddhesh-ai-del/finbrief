/**
 * consent_records — versioned consent audit trail (plan Step 0.5c).
 *
 * Records which copy version a user consented to, per tenant, for a
 * given purpose (notably the AI-processor disclosure). A NULL
 * revoked_at means the consent is active. One user may hold several
 * rows per tenant over time (grant → revoke → re-grant at a new
 * version), so uniqueness is intentionally not enforced; lookups go
 * through getActiveConsent, which filters on revoked_at IS NULL.
 */
import { randomUUID } from "node:crypto";
import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./core";
import { organization } from "./organization";

const ts = (name: string) => timestamp(name, { withTimezone: true });

export const consentRecords = pgTable(
  "consent_records",
  {
    // text + app-side default: matches better-auth's text id convention;
    // drizzle 0.45 has no defaultRandom() on text columns.
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    purpose: text("purpose").notNull(),
    consentVersion: text("consent_version").notNull(),
    grantedAt: ts("granted_at").notNull().defaultNow(),
    revokedAt: ts("revoked_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("consent_records_org_user_idx").on(t.organizationId, t.userId),
    index("consent_records_user_id_idx").on(t.userId),
  ],
);

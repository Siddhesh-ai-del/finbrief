/**
 * Better Auth organization plugin tables — the tenancy backbone.
 *
 * Mirrors better-auth@1.7.13's plugin schema (introspected via
 * `organization().schema`):
 *   - organization.slug: unique + indexed (tenant lookup key)
 *   - member: organizationId indexed, userId indexed with ON DELETE
 *     CASCADE (matches better-auth's field definition), role defaults
 *     to "member"
 *   - invitation: organizationId + email indexed; no onDelete rule on
 *     its FKs, exactly as better-auth declares them (no cascade)
 */
import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./core";

const ts = (name: string) => timestamp(name, { withTimezone: true });

export const organization = pgTable(
  "organization",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    logo: text("logo"),
    createdAt: ts("created_at").notNull().defaultNow(),
    metadata: text("metadata"),
  },
  (t) => [index("organization_slug_idx").on(t.slug)],
);

export const member = pgTable(
  "member",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("member_organization_id_idx").on(t.organizationId),
    index("member_user_id_idx").on(t.userId),
  ],
);

export const invitation = pgTable(
  "invitation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    email: text("email").notNull(),
    role: text("role"),
    status: text("status").notNull().default("pending"),
    expiresAt: ts("expires_at").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => user.id),
  },
  (t) => [
    index("invitation_organization_id_idx").on(t.organizationId),
    index("invitation_email_idx").on(t.email),
  ],
);

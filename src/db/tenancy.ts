/**
 * Tenant-scoped query helpers (Step 0.2).
 *
 * Tenancy rule enforced by construction: every helper that touches
 * tenant-owned rows takes the tenant id (organizationId) as a required
 * parameter and applies it in the WHERE clause — reads and writes
 * both. No helper accepts a row without a tenant scope.
 *
 * Cross-tenant behavior is pinned by tests/db/tenancy.test.ts.
 */
import { and, eq, isNull } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type pg from "pg";
import {
  consentRecords,
  invitation,
  member,
  organization,
  schema,
} from "./schema";

export type Db = NodePgDatabase<typeof schema>;

/** Build a typed db handle bound to the shared schema. */
export function createDb(client: pg.Pool): Db {
  return drizzle(client, { schema });
}

/** All tenant memberships held by a user (never another user's). */
export async function listMemberships(db: Db, userId: string) {
  return db
    .select({
      id: member.id,
      organizationId: member.organizationId,
      role: member.role,
      createdAt: member.createdAt,
    })
    .from(member)
    .where(eq(member.userId, userId));
}

/** Members of one tenant. Scoped by definition. */
export async function listMembers(db: Db, organizationId: string) {
  return db
    .select({
      id: member.id,
      organizationId: member.organizationId,
      userId: member.userId,
      role: member.role,
      createdAt: member.createdAt,
    })
    .from(member)
    .where(eq(member.organizationId, organizationId));
}

/** Outstanding invitations for one tenant. */
export async function listInvitations(db: Db, organizationId: string) {
  return db
    .select({
      id: invitation.id,
      organizationId: invitation.organizationId,
      email: invitation.email,
      role: invitation.role,
      status: invitation.status,
      expiresAt: invitation.expiresAt,
    })
    .from(invitation)
    .where(eq(invitation.organizationId, organizationId));
}

/** Consent records for one tenant. */
export async function listConsents(db: Db, organizationId: string) {
  return db
    .select({
      id: consentRecords.id,
      organizationId: consentRecords.organizationId,
      userId: consentRecords.userId,
      purpose: consentRecords.purpose,
      consentVersion: consentRecords.consentVersion,
      grantedAt: consentRecords.grantedAt,
      revokedAt: consentRecords.revokedAt,
    })
    .from(consentRecords)
    .where(eq(consentRecords.organizationId, organizationId));
}

/**
 * The one active consent row for a (tenant, user, purpose, version),
 * or null. The tenant predicate is part of the key: the same user's
 * consent under a different tenant must not be found.
 */
export async function getActiveConsent(
  db: Db,
  organizationId: string,
  userId: string,
  purpose: string,
  consentVersion: string,
) {
  const rows = await db
    .select()
    .from(consentRecords)
    .where(
      and(
        eq(consentRecords.organizationId, organizationId),
        eq(consentRecords.userId, userId),
        eq(consentRecords.purpose, purpose),
        eq(consentRecords.consentVersion, consentVersion),
        isNull(consentRecords.revokedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Record a consent grant, pinned to the (tenant, user) pair. */
export async function recordConsent(
  db: Db,
  input: {
    organizationId: string;
    userId: string;
    purpose: string;
    consentVersion: string;
  },
) {
  const rows = await db.insert(consentRecords).values(input).returning();
  const row = rows[0];
  if (!row) {
    throw new Error("consent insert returned no row");
  }
  return row;
}

/**
 * Revoke by id within a tenant. Returns the updated row, or null when
 * the id does not belong to the tenant — the cross-tenant write
 * negative test depends on this returning null instead of widening
 * the predicate.
 */
export async function revokeConsent(
  db: Db,
  organizationId: string,
  consentId: string,
) {
  const rows = await db
    .update(consentRecords)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(consentRecords.id, consentId),
        eq(consentRecords.organizationId, organizationId),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/** Tenant display info for an org id (404s handled by callers). */
export async function getOrganization(db: Db, organizationId: string) {
  const rows = await db
    .select()
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1);
  return rows[0] ?? null;
}

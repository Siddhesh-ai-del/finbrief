/**
 * Step 0.2 — tenant-scoped query helper tests.
 *
 * The core assertion pattern is table-driven cross-tenant isolation:
 * every helper is invoked for tenant A and tenant B, and the results
 * must be disjoint — a helper called with A's id can never surface B's
 * rows, including on writes (revokeConsent with the wrong tenant id
 * must update zero rows).
 */
import { describe, expect, beforeAll, afterAll, it } from "vitest";
import { Pool } from "pg";
import {
  createDb,
  getActiveConsent,
  getOrganization,
  listConsents,
  listInvitations,
  listMembers,
  listMemberships,
  recordConsent,
  revokeConsent,
  type Db,
} from "../../src/db/tenancy";

const CONSENT_VERSION = "ai-processor-v1";
const PURPOSE = "ai_processing";

let pool: Pool;
let db: Db;

const ids = {
  userA: "user_a",
  userB: "user_b",
  orgA: "org_a",
  orgB: "org_b",
  memberA: "member_a",
  memberB: "member_b",
  invA: "invitation_a",
  invB: "invitation_b",
  consentA: "consent_a",
  consentB: "consent_b",
};

function requireTestUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL is not set — did the vitest global setup run?",
    );
  }
  return url;
}

beforeAll(async () => {
  pool = new Pool({ connectionString: requireTestUrl() });
  pool.on("error", () => undefined);
  db = createDb(pool);

  // Clean slate: this database is dedicated to these tests.
  await pool.query(
    'TRUNCATE TABLE consent_records, invitation, member, organization, session, account, verification, "user" RESTART IDENTITY CASCADE',
  );

  const now = new Date().toISOString();
  await pool.query(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES
       ($1, 'Alice', 'alice@example.com', true, $3, $3),
       ($2, 'Bob',   'bob@example.com',   true, $3, $3)`,
    [ids.userA, ids.userB, now],
  );
  await pool.query(
    `INSERT INTO organization (id, name, slug, created_at) VALUES
       ($1, 'Org A', 'org-a', $3),
       ($2, 'Org B', 'org-b', $3)`,
    [ids.orgA, ids.orgB, now],
  );
  await pool.query(
    `INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES
       ($1, $4, $6, 'owner',  $8),
       ($2, $5, $7, 'owner',  $8),
       ($3, $4, $7, 'member', $8)`,
    [
      ids.memberA,
      ids.memberB,
      "member_a2",
      ids.orgA,
      ids.orgB,
      ids.userA,
      ids.userB,
      now,
    ],
  );
  await pool.query(
    `INSERT INTO invitation (id, organization_id, email, role, status, expires_at, created_at, inviter_id) VALUES
       ($1, $3, 'invite-a@example.com', 'member', 'pending', $6, $6, $5),
       ($2, $4, 'invite-b@example.com', 'member', 'pending', $6, $6, $5)`,
    [ids.invA, ids.invB, ids.orgA, ids.orgB, ids.userA, now],
  );
  await pool.query(
    `INSERT INTO consent_records
       (id, organization_id, user_id, purpose, consent_version, granted_at, created_at)
     VALUES
       ($1, $3, $5, $8, $9, $7, $7),
       ($2, $4, $6, $8, $9, $7, $7)`,
    [
      ids.consentA,
      ids.consentB,
      ids.orgA,
      ids.orgB,
      ids.userA,
      ids.userB,
      now,
      PURPOSE,
      CONSENT_VERSION,
    ],
  );
}, 60_000);

afterAll(async () => {
  await pool?.end();
});

describe("cross-tenant isolation on reads (table-driven)", () => {
  const readCases: {
    name: string;
    forTenant: (orgId: string) => Promise<{ id: string }[]>;
    ownedByA: string[];
    ownedByB: string[];
  }[] = [
    {
      name: "listMembers",
      forTenant: (orgId) => listMembers(db, orgId),
      ownedByA: [ids.memberA, "member_a2"],
      ownedByB: [ids.memberB],
    },
    {
      name: "listInvitations",
      forTenant: (orgId) => listInvitations(db, orgId),
      ownedByA: [ids.invA],
      ownedByB: [ids.invB],
    },
    {
      name: "listConsents",
      forTenant: (orgId) => listConsents(db, orgId),
      ownedByA: [ids.consentA],
      ownedByB: [ids.consentB],
    },
  ];

  for (const c of readCases) {
    it(`${c.name} returns only the calling tenant's rows`, async () => {
      const rowsA = await c.forTenant(ids.orgA);
      const rowsB = await c.forTenant(ids.orgB);

      expect(rowsA.map((r) => r.id).sort()).toEqual([...c.ownedByA].sort());
      expect(rowsB.map((r) => r.id).sort()).toEqual([...c.ownedByB].sort());

      const idsA = new Set(c.ownedByA);
      expect(rowsB.some((r) => idsA.has(r.id))).toBe(false);
    });
  }
});

describe("cross-tenant isolation on user-scoped reads", () => {
  it("listMemberships returns only orgs the user belongs to", async () => {
    const orgsOfA = await listMemberships(db, ids.userA);
    expect(orgsOfA.map((m) => m.organizationId)).toEqual([ids.orgA]);
    expect(orgsOfA.some((m) => m.organizationId === ids.orgB)).toBe(false);

    const orgsOfB = await listMemberships(db, ids.userB);
    expect(orgsOfB.map((m) => m.organizationId).sort()).toEqual(
      [ids.orgA, ids.orgB].sort(),
    );
  });
});

describe("consent lifecycle", () => {
  it("finds an active consent only within the tenant that granted it", async () => {
    const inA = await getActiveConsent(
      db,
      ids.orgA,
      ids.userA,
      PURPOSE,
      CONSENT_VERSION,
    );
    expect(inA?.id).toBe(ids.consentA);

    // Same user + same version, but queried under tenant B: must not leak.
    const inB = await getActiveConsent(
      db,
      ids.orgB,
      ids.userA,
      PURPOSE,
      CONSENT_VERSION,
    );
    expect(inB).toBeNull();
  });

  it("records a new consent scoped to its tenant", async () => {
    const row = await recordConsent(db, {
      organizationId: ids.orgB,
      userId: ids.userB,
      purpose: PURPOSE,
      consentVersion: "ai-processor-v2",
    });
    expect(row.organizationId).toBe(ids.orgB);
    expect(row.revokedAt).toBeNull();
    expect(row.id).toBeTruthy();

    const leak = await listConsents(db, ids.orgA);
    expect(leak.some((r) => r.id === row.id)).toBe(false);
  });

  it("revokeConsent refuses to write across tenants", async () => {
    const crossTenant = await revokeConsent(db, ids.orgB, ids.consentA);
    expect(crossTenant).toBeNull();

    const stillActive = await getActiveConsent(
      db,
      ids.orgA,
      ids.userA,
      PURPOSE,
      CONSENT_VERSION,
    );
    expect(stillActive).not.toBeNull();

    const ownTenant = await revokeConsent(db, ids.orgA, ids.consentA);
    expect(ownTenant?.id).toBe(ids.consentA);
    expect(ownTenant?.revokedAt).not.toBeNull();

    const nowInactive = await getActiveConsent(
      db,
      ids.orgA,
      ids.userA,
      PURPOSE,
      CONSENT_VERSION,
    );
    expect(nowInactive).toBeNull();
  });
});

describe("tenant lookup", () => {
  it("returns the tenant for its id and null for an unknown id", async () => {
    const org = await getOrganization(db, ids.orgA);
    expect(org?.slug).toBe("org-a");
    expect(await getOrganization(db, "org_missing")).toBeNull();
  });
});

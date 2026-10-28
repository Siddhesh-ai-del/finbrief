/**
 * Step 0.2 — migration tests against a throwaway Postgres.
 *
 * "Up/down" is exercised as up → verify → full teardown (DROP SCHEMA) →
 * re-up → verify byte-identical schema. drizzle-kit 0.31 has no `down`
 * command (generate/migrate/up/drop only), so a clean re-apply after
 * teardown is the strongest rollback-shaped guarantee available; it
 * proves the migration set is self-contained and repeatable on an
 * empty database.
 *
 * Runs against its own scratch database (shared helper) so it never
 * disturbs the database the other test files use.
 */
import { describe, expect, beforeAll, afterAll, it } from "vitest";
import type { Pool } from "pg";
import {
  createScratchDatabase,
  type ScratchDatabase,
} from "../helpers/scratch-db";

const SCRATCH_DB = "finbrief_migration_test";

const EXPECTED_TABLES = [
  "account",
  "consent_records",
  "entitlements",
  "invitation",
  "ledger_counterparties",
  "ledger_entries",
  "ledger_entry_links",
  "member",
  "organization",
  "plaid_items",
  "run_credit_accounts",
  "run_credit_entries",
  "session",
  "transactions",
  "user",
  "verification",
  "webhook_events",
];

/**
 * Tables whose primary key is the tenant id instead of `id` — the
 * one-row-per-organization billing tables.
 */
const ORG_SCOPED_PK_TABLES = new Set(["entitlements", "run_credit_accounts"]);

interface SchemaSnapshot {
  columns: unknown[];
  constraints: unknown[];
  indexes: unknown[];
}

async function snapshot(pool: Pool): Promise<SchemaSnapshot> {
  const [columns, constraints, indexes] = await Promise.all([
    pool.query(
      `SELECT table_name, column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public'
        ORDER BY table_name, column_name`,
    ),
    pool.query(
      `SELECT conrelid::regclass::text AS tbl, pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE connamespace = 'public'::regnamespace
        ORDER BY 1, 2`,
    ),
    pool.query(
      `SELECT indexname, indexdef
         FROM pg_indexes
        WHERE schemaname = 'public'
        ORDER BY 1`,
    ),
  ]);
  return {
    columns: columns.rows,
    constraints: constraints.rows,
    indexes: indexes.rows,
  };
}

async function appTables(pool: Pool): Promise<string[]> {
  const res = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name NOT LIKE '\\_%'
      ORDER BY table_name`,
  );
  return res.rows.map((r: { table_name: string }) => r.table_name);
}

let scratch: ScratchDatabase;
let firstRun: SchemaSnapshot;

beforeAll(async () => {
  scratch = await createScratchDatabase(SCRATCH_DB);
  await scratch.migrate();
  firstRun = await snapshot(scratch.pool);
}, 60_000);

afterAll(async () => {
  await scratch?.destroy();
});

describe("migration up", () => {
  it("creates exactly the application's tables from the plan", async () => {
    expect(await appTables(scratch.pool)).toEqual(EXPECTED_TABLES);
  });

  it("gives every table a text primary key (better-auth id type)", async () => {
    // pg_catalog, not information_schema: regclass::text quotes reserved
    // names like "user", and information_schema joins proved unreliable.
    const res = await scratch.pool.query(
      `SELECT c.relname AS table_name, a.attname AS column_name
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a
           ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
        WHERE n.nspname = 'public' AND con.contype = 'p'`,
    );
    const pks = res.rows as { table_name: string; column_name: string }[];
    for (const table of EXPECTED_TABLES) {
      const pk = pks.find((r) => r.table_name === table);
      expect(pk, `missing PK on ${table}`).toBeDefined();
      const expected = ORG_SCOPED_PK_TABLES.has(table)
        ? "organization_id"
        : "id";
      expect(pk?.column_name, `PK column on ${table}`).toBe(expected);
    }
    const idType = await scratch.pool.query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'user' AND column_name = 'id'`,
    );
    expect(idType.rows[0]?.data_type).toBe("text");
  });

  it("types columns the way better-auth's adapter expects", async () => {
    const res = await scratch.pool.query(
      `SELECT table_name, column_name, data_type
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (table_name, column_name) IN (
            ('user', 'email'), ('user', 'email_verified'),
            ('user', 'created_at'), ('session', 'expires_at'),
            ('session', 'user_id'), ('organization', 'slug'),
            ('invitation', 'status'), ('consent_records', 'revoked_at')
          )`,
    );
    const byKey = new Map(
      (
        res.rows as {
          table_name: string;
          column_name: string;
          data_type: string;
        }[]
      ).map((r) => [`${r.table_name}.${r.column_name}`, r.data_type]),
    );
    expect(byKey.get("user.email")).toBe("text");
    expect(byKey.get("user.email_verified")).toBe("boolean");
    expect(byKey.get("session.expires_at")).toBe("timestamp with time zone");
    expect(byKey.get("session.user_id")).toBe("text");
    expect(byKey.get("invitation.status")).toBe("text");
    expect(byKey.get("consent_records.revoked_at")).toBe(
      "timestamp with time zone",
    );
  });

  it("cascades session deletion to the owning user, and no further", async () => {
    const res = await scratch.pool.query(
      `SELECT conrelid::regclass::text AS tbl, pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE connamespace = 'public'::regnamespace AND contype = 'f'`,
    );
    const fks = res.rows as { tbl: string; def: string }[];
    const sessionFk = fks.find(
      (r) => r.tbl === "session" && r.def.includes("user_id"),
    );
    expect(sessionFk?.def).toContain("ON DELETE CASCADE");
    // member.invitation FKs must NOT cascade from organization (mirrors
    // better-auth's own field definitions, which omit onDelete here).
    const memberOrgFk = fks.find(
      (r) => r.tbl === "member" && r.def.includes("organization_id"),
    );
    expect(memberOrgFk?.def).not.toContain("ON DELETE CASCADE");
  });

  it("enforces the uniqueness better-auth relies on", async () => {
    const res = await scratch.pool.query(
      `SELECT c.relname AS tbl, pg_get_constraintdef(con.oid) AS def
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND con.contype = 'u'`,
    );
    const uniques = res.rows as { tbl: string; def: string }[];
    expect(
      uniques.some((r) => r.tbl === "user" && r.def === "UNIQUE (email)"),
    ).toBe(true);
    expect(
      uniques.some((r) => r.tbl === "session" && r.def === "UNIQUE (token)"),
    ).toBe(true);
    expect(
      uniques.some(
        (r) => r.tbl === "organization" && r.def === "UNIQUE (slug)",
      ),
    ).toBe(true);
  });

  it("indexes every tenant-scoped lookup column", async () => {
    const res = await scratch.pool.query(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public' AND indexname IN (
          'member_organization_id_idx', 'member_user_id_idx',
          'invitation_organization_id_idx', 'invitation_email_idx',
          'consent_records_org_user_idx', 'entitlements_subscription_idx',
          'run_credit_entries_org_idx'
        )`,
    );
    expect(res.rows).toHaveLength(7);
  });
});

describe("migration down/up (teardown and re-apply)", () => {
  it("rebuilds an identical schema from an empty database", async () => {
    // drizzle keeps its migration journal in a dedicated "drizzle"
    // schema (0.45 default) — dropping only public would leave the
    // journal intact and make the re-apply a silent no-op.
    await scratch.pool.query("DROP SCHEMA public, drizzle CASCADE");
    await scratch.pool.query("CREATE SCHEMA public");

    await scratch.migrate();
    const secondRun = await snapshot(scratch.pool);

    expect(secondRun).toEqual(firstRun);
  });
});

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
 * Runs against its own scratch database so it never disturbs the
 * database the other test files use.
 */
import { describe, expect, beforeAll, afterAll, it } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const SCRATCH_DB = "finbrief_migration_test";
const MIGRATIONS_FOLDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/db/migrations",
);

const EXPECTED_TABLES = [
  "account",
  "consent_records",
  "invitation",
  "member",
  "organization",
  "session",
  "user",
  "verification",
];

function adminUrl(): string {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) {
    throw new Error(
      "TEST_DATABASE_URL is not set — did the vitest global setup run?",
    );
  }
  const u = new URL(base);
  u.pathname = "/postgres";
  return u.toString();
}

function scratchUrl(): string {
  const u = new URL(adminUrl());
  u.pathname = `/${SCRATCH_DB}`;
  return u.toString();
}

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

let adminPool: Pool;
let scratchPool: Pool;
let firstRun: SchemaSnapshot;

beforeAll(async () => {
  adminPool = new Pool({ connectionString: adminUrl() });
  // Idle-client errors (e.g. a server-side terminate during teardown)
  // must not surface as unhandled test errors.
  adminPool.on("error", () => undefined);
  await adminPool.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  await adminPool.query(`CREATE DATABASE ${SCRATCH_DB}`);

  scratchPool = new Pool({ connectionString: scratchUrl() });
  scratchPool.on("error", () => undefined);
  const db = drizzle(scratchPool);
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  firstRun = await snapshot(scratchPool);
}, 60_000);

afterAll(async () => {
  await scratchPool?.end();
  // Drain server-side connections before dropping: DROP ... WITH (FORCE)
  // would otherwise deliver a FATAL to a socket that is still closing.
  for (let attempt = 0; attempt < 20; attempt++) {
    const { rows } = await adminPool.query(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1",
      [SCRATCH_DB],
    );
    if ((rows[0] as { n: number }).n === 0) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  await adminPool.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
  await adminPool?.end();
});

describe("migration up", () => {
  it("creates exactly the tenancy + consent tables from the plan", async () => {
    expect(await appTables(scratchPool!)).toEqual(EXPECTED_TABLES);
  });

  it("gives every table a text primary key (better-auth id type)", async () => {
    // pg_catalog, not information_schema: regclass::text quotes reserved
    // names like "user", and information_schema joins proved unreliable.
    const res = await scratchPool!.query(
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
      expect(pk?.column_name).toBe("id");
    }
    const idType = await scratchPool!.query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'user' AND column_name = 'id'`,
    );
    expect(idType.rows[0]?.data_type).toBe("text");
  });

  it("types columns the way better-auth's adapter expects", async () => {
    const res = await scratchPool!.query(
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
    const res = await scratchPool!.query(
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
    const res = await scratchPool!.query(
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
    const res = await scratchPool!.query(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public' AND indexname IN (
          'member_organization_id_idx', 'member_user_id_idx',
          'invitation_organization_id_idx', 'invitation_email_idx',
          'consent_records_org_user_idx'
        )`,
    );
    expect(res.rows).toHaveLength(5);
  });
});

describe("migration down/up (teardown and re-apply)", () => {
  it("rebuilds an identical schema from an empty database", async () => {
    // drizzle keeps its migration journal in a dedicated "drizzle"
    // schema (0.45 default) — dropping only public would leave the
    // journal intact and make the re-apply a silent no-op.
    await scratchPool!.query("DROP SCHEMA public, drizzle CASCADE");
    await scratchPool!.query("CREATE SCHEMA public");

    const db = drizzle(scratchPool!);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    const secondRun = await snapshot(scratchPool!);

    expect(secondRun).toEqual(firstRun);
  });
});

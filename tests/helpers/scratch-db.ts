/**
 * Throwaway Postgres database for test files that must not share the
 * suite's main database — other files TRUNCATE those tables in
 * parallel workers, so shared data would race.
 *
 * Teardown drains server-side connections before DROP: a plain
 * `DROP ... WITH (FORCE)` can deliver a FATAL to a socket that is
 * still closing, which surfaces as an unhandled error in vitest.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const MIGRATIONS_FOLDER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/db/migrations",
);

export interface ScratchDatabase {
  /** Pool connected to the scratch database (error events swallowed). */
  pool: Pool;
  /** Apply all repo migrations to the scratch database. */
  migrate: () => Promise<void>;
  /** Close pools, drain connections, drop the database. */
  destroy: () => Promise<void>;
}

/** The suite database URL; throws loudly if global setup did not run. */
export function requireTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL is not set — did the vitest global setup run?",
    );
  }
  return url;
}

function urlWithPathname(base: string, pathname: string): string {
  const u = new URL(base);
  u.pathname = pathname;
  return u.toString();
}

export async function createScratchDatabase(
  name: string,
): Promise<ScratchDatabase> {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new Error(`invalid scratch database name: ${name}`);
  }
  const admin = new Pool({
    connectionString: urlWithPathname(requireTestDatabaseUrl(), "/postgres"),
  });
  admin.on("error", () => undefined);
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);

  const pool = new Pool({
    connectionString: urlWithPathname(requireTestDatabaseUrl(), `/${name}`),
  });
  pool.on("error", () => undefined);

  return {
    pool,
    migrate: async () => {
      await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
    },
    destroy: async () => {
      await pool.end();
      for (let attempt = 0; attempt < 20; attempt++) {
        const { rows } = await admin.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1",
          [name],
        );
        const first = rows[0] as { n: number } | undefined;
        if (!first || first.n === 0) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
      await admin.end();
    },
  };
}

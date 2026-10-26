/**
 * Shared application connection pool.
 *
 * Route handlers must not each open their own Pool — per-instance
 * pools multiply under concurrency until Postgres refuses the
 * connection count. One pool per process, created lazily so importing
 * a module never forces a connection before env is ready.
 *
 * Tests call `closePool()` in teardown: an idle checked-out socket
 * keeps the vitest worker's event loop alive and hangs the run.
 */
import { Pool } from "pg";

let shared: Pool | null = null;

export function getPool(): Pool {
  if (!shared) {
    shared = new Pool({ connectionString: process.env.DATABASE_URL });
    shared.on("error", () => undefined);
  }
  return shared;
}

export async function closePool(): Promise<void> {
  if (!shared) return;
  const pool = shared;
  shared = null;
  await pool.end();
}

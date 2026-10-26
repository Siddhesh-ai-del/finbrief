/**
 * Shared pool lifecycle — one pool per process, idempotent shutdown.
 * Pool construction is lazy (no connection until first query), so
 * these run without any database.
 */
import { describe, expect, it } from "vitest";
import { closePool, getPool } from "../../src/db/pool";

describe("shared pool", () => {
  it("returns the same instance for every caller", () => {
    expect(getPool()).toBe(getPool());
  });

  it("recreates after closePool, and closePool is idempotent", async () => {
    const first = getPool();
    await closePool();
    await closePool(); // no-op path — already closed

    const second = getPool();
    expect(second).not.toBe(first);
    await closePool();
  });
});

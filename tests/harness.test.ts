/**
 * Harness smoke test — proves the test harness itself works:
 * Vitest runs, TypeScript paths resolve, and the coverage gate
 * configuration is present (80% threshold is enforced by CI).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("quality harness", () => {
  it("runs assertions under Vitest", () => {
    expect(1 + 1).toBe(2);
  });

  it("keeps the coverage threshold at 80% as required by the plan", () => {
    const config = readFileSync(
      new URL("../vitest.config.ts", import.meta.url),
      "utf8",
    );
    expect(config).toMatch(/statements:\s*80/);
    expect(config).toMatch(/lines:\s*80/);
  });

  it("pins exact dependency versions (no ranges) for the stack libraries", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { dependencies: Record<string, string> };
    for (const dep of ["next", "ai", "drizzle-orm", "better-auth", "inngest"]) {
      expect(pkg.dependencies[dep]).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});

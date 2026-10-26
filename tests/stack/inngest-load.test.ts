/**
 * Stack smoke test for the `zod` override (package.json `overrides`).
 *
 * inngest@4.26.0 hard-depends on zod@^3.25.0, but zod 3.x is affected by
 * GHSA-mrhx-c7xc-m3w5 (high, unpatched on the v3 line). We force zod 4.6.7
 * everywhere because:
 *   - inngest has ZERO runtime imports of zod (only type-level / JSDoc refs)
 *   - inngest's peerDependencies range is `^3.25.0 || ^4.0.0` (accepts v4)
 * This test proves the inngest SDK still loads and constructs offline.
 * The CI `npm audit --omit=dev --audit-level=high` step is the guard that
 * keeps the vulnerable v3 copy from coming back.
 */
import { describe, expect, it } from "vitest";
import { Inngest } from "inngest";
import { z } from "zod";

describe("inngest under the zod override", () => {
  it("constructs a client offline without touching the network", () => {
    const client = new Inngest({ id: "finbrief-test" });
    expect(client).toBeDefined();
    expect(typeof client.createFunction).toBe("function");
  });

  it("resolves a zod 4-only API from the app's own zod copy", () => {
    const schema = z.object({ amount: z.number() });
    expect(schema.parse({ amount: 12.5 })).toEqual({ amount: 12.5 });
    expect(() => schema.parse({ amount: "nope" })).toThrow();
    // z.toJSONSchema exists only in zod v4 (asserts the resolved copy is v4).
    expect(z.toJSONSchema(schema)).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { amount: { type: "number" } },
      required: ["amount"],
      additionalProperties: false,
    });
  });
});

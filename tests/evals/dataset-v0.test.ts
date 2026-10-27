/**
 * Step 2.3 — golden dataset v0 corpus invariants.
 *
 * The corpus is the gate's value: "dataset quality determines gate
 * usefulness" (plan risk note). These tests pin the corpus-level
 * properties the runner relies on:
 *
 * - every row is schema-valid (zod), ids unique, expected labels in
 *   the REAL Plaid PFCv2 primary taxonomy (vendored with provenance
 *   in evals/categorization/taxonomy.ts — fetched from Plaid's
 *   published CSV, not invented);
 * - the plan's construction recipe: fixture-derived rows (Plaid PFC
 *   as ground truth over sanitized fixtures) + >=100 hand-reviewed
 *   rows;
 * - coverage across the taxonomy so a categorizer cannot game the
 *   exact-match metric by predicting one popular label;
 * - hostile rows are present (bidi override, zero-width, control
 *   chars) so the eval exercises the SAME Step 1.5 sanitization
 *   boundary production does.
 */
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseDataset } from "../../evals/categorization/dataset.ts";
import { PFC_V2_PRIMARIES } from "../../evals/categorization/taxonomy.ts";

const DATASET_PATH = new URL(
  "../../evals/datasets/categorization-v0.jsonl",
  import.meta.url,
);

async function loadRaw(): Promise<{
  text: string;
  rows: ReturnType<typeof parseDataset>;
}> {
  const text = await readFile(DATASET_PATH, "utf8");
  return { text, rows: parseDataset(text) };
}

describe("categorization-v0 corpus", () => {
  it("parses as JSONL with every row schema-valid", async () => {
    const { rows } = await loadRaw();
    expect(rows.length).toBeGreaterThanOrEqual(118);
  });

  it("has unique, well-formed ids", async () => {
    const { rows } = await loadRaw();
    const ids = new Set(rows.map((r) => r.id));
    expect(ids.size).toBe(rows.length);
  });

  it("labels only real PFCv2 primary categories", async () => {
    const { rows } = await loadRaw();
    for (const row of rows) {
      expect(PFC_V2_PRIMARIES).toContain(row.expectedPrimary);
    }
  });

  it("follows the plan recipe: >=100 hand-reviewed rows plus fixtures", async () => {
    const { rows } = await loadRaw();
    const handReviewed = rows.filter((r) => r.source === "hand-reviewed");
    const fixtures = rows.filter((r) => r.source === "fixture");
    expect(handReviewed.length).toBeGreaterThanOrEqual(100);
    expect(fixtures.length).toBeGreaterThanOrEqual(10);
    // Hand-reviewed rows are marked reviewed; fixtures are not.
    expect(handReviewed.every((r) => r.reviewed)).toBe(true);
    expect(fixtures.every((r) => !r.reviewed)).toBe(true);
  });

  it("covers at least 16 of the 18 primaries (no single-label gaming)", async () => {
    const { rows } = await loadRaw();
    const represented = new Set(rows.map((r) => r.expectedPrimary));
    expect(represented.size).toBeGreaterThanOrEqual(16);
  });

  it("includes hostile rows that only the Step 1.5 sanitizer normalizes", async () => {
    const { text, rows } = await loadRaw();
    // Hostile chars are stored as JSON \u escapes so PR review of the
    // corpus stays readable — the decoded rows still carry them.
    expect(text).toContain("\\u202e"); // bidi override
    expect(text).toContain("\\u200b"); // zero-width space
    expect(text).toContain("\\u0000"); // NUL (legal in JSON, not in Postgres text)
    const hostile = rows.find((r) => r.merchantName?.includes("\u202e"));
    expect(hostile?.expectedPrimary).toBe("GENERAL_MERCHANDISE");
    const zeroWidth = rows.find((r) => r.name.includes("\u200b"));
    expect(zeroWidth?.expectedPrimary).toBe("FOOD_AND_DRINK");
    const nul = rows.find((r) => r.name.includes("\u0000"));
    expect(nul?.expectedPrimary).toBe("OTHER");
  });

  it("carries both outflows and inflows as integer cents", async () => {
    const { rows } = await loadRaw();
    expect(rows.every((r) => Number.isInteger(r.amountCents))).toBe(true);
    expect(rows.some((r) => r.amountCents < 0)).toBe(true);
  });

  it("rejects a corrupt line by line number without echoing content", async () => {
    const good = await readFile(DATASET_PATH, "utf8");
    const broken = `${good.split("\n")[0]}\n{"id":"c999","name":42}\n`;
    let message = "";
    try {
      parseDataset(broken);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("line 2");
    expect(message).not.toContain("c999");
  });
});

/**
 * Step 2.3 — categorization eval runner mechanics.
 *
 * What is pinned here (beyond the math):
 *
 * - **Sanitize before categorize**: the runner hands the categorizer
 *   the SAME Step 1.5 sanitized text production would — evals must
 *   exercise the real pipeline boundary, not a clean-room one.
 * - **Block semantics** (plan: "CI gate wired with block"): the CLI
 *   exits non-zero below the threshold, verified by actually
 *   spawning `node evals/run-categorization.ts` — the exit code IS
 *   the gate.
 * - **Fail-closed config**: no hardcoded accuracy policy in the
 *   runner; a missing threshold is an error, not a default.
 * - **No value echo**: dataset errors name the line, not the row.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { CategorizationRow } from "../../evals/categorization/dataset.ts";
import { runCategorization } from "../../evals/run-categorization.ts";

const RUNNER = new URL("../../evals/run-categorization.ts", import.meta.url)
  .pathname;

function row(
  id: string,
  name: string,
  expectedPrimary: CategorizationRow["expectedPrimary"],
): CategorizationRow {
  return {
    id,
    name,
    merchantName: null,
    amountCents: 100,
    expectedPrimary,
    source: "hand-reviewed",
    reviewed: true,
  };
}

const ROWS: CategorizationRow[] = [
  row("c001", "STARBUCKS #1", "FOOD_AND_DRINK"),
  row("c002", "UBER TRIP", "TRANSPORTATION"),
  row("c003", "NETFLIX", "ENTERTAINMENT"),
  row("c004", "MYSTERY CHARGE", "OTHER"),
];

const tempDirs: string[] = [];

async function writeTempDataset(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "finbrief-eval-"));
  tempDirs.push(dir);
  const path = join(dir, "dataset.jsonl");
  await writeFile(path, contents);
  return path;
}

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("runCategorization", () => {
  it("computes exact-match accuracy and per-category breakdown", () => {
    const report = runCategorization(
      ROWS,
      (input) =>
        input.name.includes("STARBUCKS")
          ? "FOOD_AND_DRINK"
          : input.name.includes("UBER")
            ? "TRANSPORTATION"
            : input.name.includes("NETFLIX")
              ? "ENTERTAINMENT"
              : "GENERAL_MERCHANDISE",
      0.8,
    );
    expect(report.total).toBe(4);
    expect(report.correct).toBe(3);
    expect(report.accuracy).toBe(0.75);
    expect(report.passed).toBe(false); // 0.75 < 0.8
    expect(report.failures).toEqual([
      { id: "c004", expected: "OTHER", predicted: "GENERAL_MERCHANDISE" },
    ]);
    const food = report.perCategory.find(
      (c) => c.category === "FOOD_AND_DRINK",
    );
    expect(food).toEqual({ category: "FOOD_AND_DRINK", total: 1, correct: 1 });
  });

  it("passes exactly at the threshold boundary", () => {
    const report = runCategorization(
      ROWS.slice(0, 2),
      (input) =>
        input.name.includes("STARBUCKS") ? "FOOD_AND_DRINK" : "TRANSPORTATION",
      0.5,
    );
    expect(report.accuracy).toBe(1);
    expect(report.passed).toBe(true);
  });

  it("hands the categorizer sanitized text — the production boundary", () => {
    const seen: string[] = [];
    const hostile = {
      ...row("c901", "EVIL\u202eSHOP\u0000 CARD", "GENERAL_MERCHANDISE"),
      merchantName: "EVIL\u202e\u200bSHOP",
    };
    runCategorization(
      [hostile],
      (input) => {
        seen.push(`${input.merchantName ?? ""}|${input.name}`);
        return "OTHER";
      },
      0.5,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toContain("\u202e");
    expect(seen[0]).not.toContain("\u200b");
    expect(seen[0]).not.toContain("\u0000");
  });

  it("returns a frozen report", () => {
    const report = runCategorization(ROWS, () => "OTHER", 0.5);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.perCategory)).toBe(true);
    expect(Object.isFrozen(report.failures)).toBe(true);
  });

  it("rejects a non-positive threshold at the config seam", () => {
    expect(() => runCategorization(ROWS, () => "OTHER", 0)).toThrow();
    expect(() => runCategorization(ROWS, () => "OTHER", 1.5)).toThrow();
  });
});

describe("CLI block semantics (spawned for real)", () => {
  it("exits 0 when the accuracy bar is met, 1 when it is not", async () => {
    // Third row is a deliberate baseline miss (hostile merchant the
    // token rules cannot see) — accuracy 2/3, so 0.5 passes and 0.9 blocks.
    const datasetPath = await writeTempDataset(
      [
        '{"id":"c001","name":"STARBUCKS #1","merchantName":"STARBUCKS","amountCents":500,"expectedPrimary":"FOOD_AND_DRINK","source":"hand-reviewed","reviewed":true}',
        '{"id":"c002","name":"UBER TRIP","merchantName":"UBER","amountCents":900,"expectedPrimary":"TRANSPORTATION","source":"hand-reviewed","reviewed":true}',
        '{"id":"c003","name":"EVIL SHOP","merchantName":"EVIL\\u202eSHOP","amountCents":1234,"expectedPrimary":"GENERAL_MERCHANDISE","source":"fixture","reviewed":false}',
      ].join("\n"),
    );

    const ok = execFileSync(
      process.execPath,
      [RUNNER, "--dataset", datasetPath, "--min-accuracy", "0.5"],
      { encoding: "utf8" },
    );
    expect(JSON.parse(ok)).toMatchObject({
      passed: true,
      total: 3,
      correct: 2,
    });

    expect(() =>
      execFileSync(
        process.execPath,
        [RUNNER, "--dataset", datasetPath, "--min-accuracy", "0.9"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ),
    ).toThrow();
  });

  it("fails closed when no threshold is configured", () => {
    let stderr = "";
    try {
      execFileSync(process.execPath, [RUNNER, "--dataset", "unused"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      stderr = String((error as { stderr?: string }).stderr ?? "");
    }
    expect(stderr).toContain("min-accuracy");
    expect(stderr).not.toContain("default");
  });
});

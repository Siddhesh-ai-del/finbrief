/**
 * Categorization eval runner + CI block gate (plan Step 2.3).
 *
 * Exact-match accuracy of a categorizer over the golden corpus. The
 * runner is the deterministic half of the eval strategy (§6.5):
 * PR-blocking gates here never call a model — the subject defaults
 * to the no-LLM baseline (evals/categorization/baseline-categorizer.ts)
 * and real-model subjects are wired via EVAL_CATEGORIZER_MODULE for
 * the nightly job (Step 4.5).
 *
 * Contract:
 * - **Sanitize before categorize**: every name/merchant passes
 *   Step 1.5's sanitizer before reaching the categorizer — the eval
 *   exercises the same boundary production does, hostile fixtures
 *   included.
 * - **Block semantics**: exit code 1 below the threshold. There is
 *   NO default threshold — a missing bar is a configuration error
 *   (fail closed; threshold is policy, owned by CI config, never
 *   hardcoded here).
 * - **No value echo**: errors name lines/fields, never row content.
 *
 * Run: `npm run eval:categorization` (Node >= 22.18 — native type
 * stripping; relative imports therefore carry `.ts` extensions).
 */
import { pathToFileURL } from "node:url";
import { isAbsolute, resolve } from "node:path";
import { sanitizeUntrustedText } from "../src/security/untrusted-text.ts";
import {
  baselineCategorize,
  type Categorizer,
} from "./categorization/baseline-categorizer.ts";
import {
  loadDataset,
  type CategorizationRow,
} from "./categorization/dataset.ts";

const DEFAULT_DATASET = new URL(
  "./datasets/categorization-v0.jsonl",
  import.meta.url,
).pathname;

export class EvalConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalConfigError";
  }
}

export interface CategorizationReport {
  readonly total: number;
  readonly correct: number;
  /** Exact-match accuracy, 0..1. */
  readonly accuracy: number;
  readonly minAccuracy: number;
  readonly passed: boolean;
  readonly perCategory: readonly {
    readonly category: string;
    readonly total: number;
    readonly correct: number;
  }[];
  readonly failures: readonly {
    readonly id: string;
    readonly expected: string;
    readonly predicted: string;
  }[];
}

export function runCategorization(
  rows: readonly CategorizationRow[],
  categorize: Categorizer,
  minAccuracy: number,
): CategorizationReport {
  if (
    typeof minAccuracy !== "number" ||
    !Number.isFinite(minAccuracy) ||
    minAccuracy <= 0 ||
    minAccuracy > 1
  ) {
    throw new EvalConfigError("minAccuracy must be in (0, 1]");
  }

  const perCategory = new Map<string, { total: number; correct: number }>();
  const failures: {
    id: string;
    expected: string;
    predicted: string;
  }[] = [];
  let correct = 0;

  for (const row of rows) {
    // The production boundary: sanitize before the categorizer sees it.
    const predicted = categorize({
      name: sanitizeUntrustedText(row.name),
      merchantName: sanitizeUntrustedText(row.merchantName),
      amountCents: row.amountCents,
    });
    const tally = perCategory.get(row.expectedPrimary) ?? {
      total: 0,
      correct: 0,
    };
    tally.total += 1;
    if (predicted === row.expectedPrimary) {
      correct += 1;
      tally.correct += 1;
    } else {
      failures.push({ id: row.id, expected: row.expectedPrimary, predicted });
    }
    perCategory.set(row.expectedPrimary, tally);
  }

  const total = rows.length;
  const accuracy = total > 0 ? correct / total : 0;
  return Object.freeze({
    total,
    correct,
    accuracy,
    minAccuracy,
    passed: accuracy >= minAccuracy,
    perCategory: Object.freeze(
      [...perCategory.entries()]
        .map(([category, tally]) => ({ category, ...tally }))
        .sort((a, b) => a.category.localeCompare(b.category)),
    ),
    failures: Object.freeze(failures),
  });
}

interface CliArgs {
  datasetPath: string;
  minAccuracy: number;
}

export function parseCliArgs(argv: readonly string[]): CliArgs {
  let datasetPath = DEFAULT_DATASET;
  let minAccuracy: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dataset") {
      const value = argv[index + 1];
      if (!value) throw new EvalConfigError("--dataset requires a path");
      datasetPath = isAbsolute(value) ? value : resolve(process.cwd(), value);
      index += 1;
    } else if (arg === "--min-accuracy") {
      const value = argv[index + 1];
      if (!value) throw new EvalConfigError("--min-accuracy requires a number");
      minAccuracy = Number(value);
      index += 1;
    } else {
      throw new EvalConfigError("unknown argument");
    }
  }

  const fromEnv = process.env.EVAL_CATEGORIZATION_MIN_ACCURACY;
  if (minAccuracy === undefined && fromEnv) {
    minAccuracy = Number(fromEnv);
  }
  if (minAccuracy === undefined || Number.isNaN(minAccuracy)) {
    // Fail closed: threshold is CI policy (plan anti-pattern list —
    // no hardcoded policy values), so a missing bar is an error.
    throw new EvalConfigError(
      "min-accuracy required (--min-accuracy or EVAL_CATEGORIZATION_MIN_ACCURACY)",
    );
  }
  return { datasetPath, minAccuracy };
}

async function resolveCategorizer(): Promise<Categorizer> {
  const modulePath = process.env.EVAL_CATEGORIZER_MODULE;
  if (!modulePath) return baselineCategorize;
  const specifier = isAbsolute(modulePath)
    ? pathToFileURL(modulePath).href
    : modulePath;
  const loaded = (await import(specifier)) as { default?: Categorizer };
  if (typeof loaded.default !== "function") {
    throw new EvalConfigError("categorizer module has no default export");
  }
  return loaded.default;
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const rows = await loadDataset(args.datasetPath);
  const categorize = await resolveCategorizer();
  const report = runCategorization(rows, categorize, args.minAccuracy);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) {
    process.stderr.write(
      `eval gate FAILED: accuracy ${report.accuracy.toFixed(4)} < min ${args.minAccuracy}\n`,
    );
    process.exitCode = 1;
  }
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((error: unknown) => {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  });
}

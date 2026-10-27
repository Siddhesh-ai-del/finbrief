/**
 * Golden dataset loader (plan Step 2.3).
 *
 * The corpus is JSONL — one row per line — because dataset diffs
 * must stay reviewable in PRs (a one-line change per row) and the
 * runner must fail on the FIRST corrupt line rather than silently
 * evaluating a smaller set.
 *
 * Error discipline (Steps 1.2/1.5): validation errors name the LINE
 * NUMBER, never echo the row content — dataset text is
 * counterparty-shaped (it contains hostile fixtures by design), so
 * it never lands in an error stream or CI log.
 *
 * Note: relative imports carry `.ts` extensions because the runner
 * executes under Node's native type stripping (Node >= 22.18) with
 * real ESM resolution — extensionless specifiers do not resolve.
 */
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { isPfcPrimary } from "./taxonomy.ts";

export const categorizationRowSchema = z.object({
  id: z.string().regex(/^[cf]\d{3,4}$/),
  name: z.string().min(1),
  merchantName: z.string().min(1).nullable(),
  amountCents: z.number().int(),
  expectedPrimary: z.string().refine(isPfcPrimary, {
    message: "expectedPrimary is not a PFCv2 primary",
  }),
  source: z.enum(["hand-reviewed", "fixture"]),
  reviewed: z.boolean(),
});

export type CategorizationRow = z.infer<typeof categorizationRowSchema>;

export class DatasetValidationError extends Error {
  readonly line: number;

  constructor(line: number, reason: string) {
    // Line number only — row content never echoes (it may be hostile).
    super(`dataset line ${line}: ${reason}`);
    this.name = "DatasetValidationError";
    this.line = line;
  }
}

export function parseDataset(text: string): CategorizationRow[] {
  const rows: CategorizationRow[] = [];
  const seenIds = new Set<string>();
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const raw = (lines[index] ?? "").trim();
    if (raw === "") continue;
    const line = index + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new DatasetValidationError(line, "invalid JSON");
    }
    const result = categorizationRowSchema.safeParse(parsed);
    if (!result.success) {
      throw new DatasetValidationError(
        line,
        `schema mismatch (${result.error.issues
          .map((issue) => issue.path.join("."))
          .join(", ")})`,
      );
    }
    if (seenIds.has(result.data.id)) {
      throw new DatasetValidationError(line, "duplicate id");
    }
    seenIds.add(result.data.id);
    rows.push(result.data);
  }
  return rows;
}

export async function loadDataset(path: string): Promise<CategorizationRow[]> {
  return parseDataset(await readFile(path, "utf8"));
}

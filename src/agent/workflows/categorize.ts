/**
 * Categorize workflow (plan Step 4.2) — deterministic first
 * (§6.2-5): the stored Plaid primary category IS the answer
 * whenever it exists, so the model is consulted only for rows Plaid
 * left unclassified. The model's command crosses the Step 4.1
 * envelope; a command naming a different transaction than the one
 * asked about is refused. Rows load scoped to the tenant, so an id
 * outside the organization is WORKFLOW_NOT_FOUND — the model cannot
 * direct the workflow at someone else's data.
 */
import { and, eq, inArray } from "drizzle-orm";
import { transactions } from "../../db/schema/transactions";
import { segmentUntrusted } from "../../security/untrusted-text";
import { categorizeCommandSchema } from "../envelope";
import {
  generateStructured,
  type WorkflowContext,
  WorkflowError,
} from "./context";

export interface CategorizedTransaction {
  readonly transactionId: string;
  readonly category: string;
  readonly source: "stored" | "model";
}

const INSTRUCTIONS = [
  "You categorize bank transactions.",
  "Return a command for the ONE transaction in the user message.",
  "transactionId must be exactly the id you were given.",
  "category must be a Plaid-style primary category name",
  "(for example FOOD_AND_DRINK, TRAVEL, TRANSPORTATION, RENT_AND_UTILITIES).",
].join(" ");

export async function runCategorizeWorkflow(
  ctx: WorkflowContext,
  input: { readonly transactionIds: readonly string[] },
): Promise<readonly CategorizedTransaction[]> {
  if (input.transactionIds.length === 0) {
    throw new WorkflowError(
      "WORKFLOW_INPUT",
      "transactionIds must not be empty",
      { field: "transactionIds" },
    );
  }
  const ordered = [...new Set(input.transactionIds)];
  const rows = await ctx.db
    .select({
      id: transactions.id,
      date: transactions.date,
      amountCents: transactions.amountCents,
      name: transactions.name,
      pfc: transactions.personalFinanceCategoryPrimary,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.organizationId, ctx.organizationId),
        inArray(transactions.id, ordered),
      ),
    );
  if (rows.length !== ordered.length) {
    throw new WorkflowError(
      "WORKFLOW_NOT_FOUND",
      "some transaction ids are not visible to this organization",
      { field: "transactionIds" },
    );
  }

  const byId = new Map(rows.map((row) => [row.id, row]));
  const results: CategorizedTransaction[] = [];
  for (const id of ordered) {
    const row = byId.get(id)!;
    const stored = row.pfc;
    if (typeof stored === "string" && stored !== "") {
      results.push({ transactionId: id, category: stored, source: "stored" });
      continue;
    }
    const command = await generateStructured(ctx, {
      schema: categorizeCommandSchema,
      instructions: INSTRUCTIONS,
      prompt: segmentUntrusted(
        "transaction",
        JSON.stringify({
          id: row.id,
          date: row.date,
          amountCents: row.amountCents,
          name: row.name,
        }),
      ),
    });
    if (command.transactionId !== id) {
      throw new WorkflowError(
        "WORKFLOW_INPUT",
        "the categorize command referenced a different transaction",
        { field: "transactionId" },
      );
    }
    results.push({
      transactionId: id,
      category: command.category,
      source: "model",
    });
  }
  return Object.freeze(results);
}

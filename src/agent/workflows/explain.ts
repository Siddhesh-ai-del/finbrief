/**
 * Explain workflow (plan Step 4.2) — the ONLY place the AI SDK
 * tool loop runs (§6.2-5 workflows-first). The model may call
 * read-only insight tools; tool definitions are built FROM the
 * allowlist (programmatic surface limit, mirrored by activeTools)
 * and their closures capture the per-tenant DB handle and
 * organization id — the model never supplies tenancy, limits, or
 * currencies. Every figure the answer may cite comes from tool
 * RESULTS converted by code; the draft only references figures by
 * index. A tool call that fails or names an unavailable tool
 * lands in step errors and the workflow stops hard — fail closed,
 * never a narrated guess. The user's question crosses the model
 * boundary inside the Step 1.5 send-set delimiters.
 */
import { z } from "zod";
import { stepCountIs, tool, generateText, type ToolSet } from "ai";
import { createAggregations } from "../../insight/aggregations";
import { createLedgerTools } from "../../insight/ledger-tools";
import {
  sanitizeUntrustedText,
  segmentUntrusted,
} from "../../security/untrusted-text";
import { renderChatAnswer } from "../envelope";
import {
  generateStructured,
  type WorkflowContext,
  WorkflowError,
} from "./context";
import {
  balanceFigures,
  categoryFigures,
  describeFigures,
  monthFigures,
  settlementFigures,
  spendFigures,
  whoOwesFigures,
  type DraftFigure,
} from "./figures";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;
const MAX_TOOL_STEPS = 2;

export const EXPLAIN_TOOL_NAMES = [
  "spendByMerchant",
  "spendByCategory",
  "monthOverMonth",
  "balanceAsOf",
  "whoOwesWhat",
  "settlementHistory",
] as const;

export type ExplainToolName = (typeof EXPLAIN_TOOL_NAMES)[number];

const draftSchema = z.object({
  text: z.string(),
  figureRefs: z.array(z.number().int().min(0)),
});

const INSTRUCTIONS = [
  "You answer the user's finance question using the provided tools.",
  "In your final answer draft, reference figures ONLY as {{fig:N}}",
  "placeholders matching the numbered figure list; never write",
  "amounts, decimals, or currency symbols into the prose.",
].join(" ");

export interface ExplainWorkflowResult {
  readonly text: string;
  readonly figures: readonly DraftFigure[];
}

export async function runExplainWorkflow(
  ctx: WorkflowContext,
  input: { readonly question: string },
  options: { readonly allowedTools?: readonly string[] } = {},
): Promise<ExplainWorkflowResult> {
  const allowlist = options.allowedTools ?? EXPLAIN_TOOL_NAMES;
  for (const name of allowlist) {
    if (!(EXPLAIN_TOOL_NAMES as readonly string[]).includes(name)) {
      throw new WorkflowError("WORKFLOW_INPUT", "unknown explain tool name", {
        field: "allowedTools",
      });
    }
  }

  const aggregations = createAggregations();
  const ledgerTools = createLedgerTools();
  // Collected per tool, flattened in registry order after the loop:
  // figures come from tool results, never from the model.
  const collected = new Map<ExplainToolName, readonly DraftFigure[]>();
  const window = (args: { fromDate?: string; toDate?: string }) =>
    args.fromDate || args.toDate
      ? { fromDate: args.fromDate, toDate: args.toDate }
      : undefined;

  const record = (name: ExplainToolName, figures: readonly DraftFigure[]) => {
    collected.set(name, figures);
    return figures;
  };
  const date = z.string().regex(ISO_DATE);

  const tools: ToolSet = {};
  if (allowlist.includes("spendByMerchant")) {
    tools.spendByMerchant = tool({
      description: "Posted outflows by merchant",
      inputSchema: z.object({
        fromDate: date.optional(),
        toDate: date.optional(),
      }),
      execute: async (args: { fromDate?: string; toDate?: string }) =>
        record(
          "spendByMerchant",
          spendFigures(
            await aggregations.spendByMerchant(
              ctx.db,
              ctx.organizationId,
              window(args),
            ),
          ),
        ),
    });
  }
  if (allowlist.includes("spendByCategory")) {
    tools.spendByCategory = tool({
      description: "Posted outflows by category",
      inputSchema: z.object({
        fromDate: date.optional(),
        toDate: date.optional(),
      }),
      execute: async (args: { fromDate?: string; toDate?: string }) =>
        record(
          "spendByCategory",
          categoryFigures(
            await aggregations.spendByCategory(
              ctx.db,
              ctx.organizationId,
              window(args),
            ),
          ),
        ),
    });
  }
  if (allowlist.includes("monthOverMonth")) {
    tools.monthOverMonth = tool({
      description: "Month-over-month spend change",
      inputSchema: z.object({ month: z.string().regex(MONTH).optional() }),
      execute: async (args: { month?: string }) =>
        record(
          "monthOverMonth",
          monthFigures(
            await aggregations.monthOverMonth(
              ctx.db,
              ctx.organizationId,
              args.month,
            ),
          ),
        ),
    });
  }
  if (allowlist.includes("balanceAsOf")) {
    tools.balanceAsOf = tool({
      description: "Net posted balance as of a date",
      inputSchema: z.object({ asOfDate: date }),
      execute: async (args: { asOfDate: string }) =>
        record(
          "balanceAsOf",
          balanceFigures(
            await aggregations.balanceAsOf(
              ctx.db,
              ctx.organizationId,
              args.asOfDate,
            ),
          ),
        ),
    });
  }
  if (allowlist.includes("whoOwesWhat")) {
    tools.whoOwesWhat = tool({
      description: "Open ledger positions per counterparty",
      inputSchema: z.object({}),
      execute: async () =>
        record(
          "whoOwesWhat",
          whoOwesFigures(
            await ledgerTools.whoOwesWhat(ctx.db, ctx.organizationId),
          ),
        ),
    });
  }
  if (allowlist.includes("settlementHistory")) {
    tools.settlementHistory = tool({
      description: "Recorded settlements, chronological",
      inputSchema: z.object({
        counterpartyId: z.string().min(1).optional(),
        fromDate: date.optional(),
        toDate: date.optional(),
      }),
      execute: async (args: {
        counterpartyId?: string;
        fromDate?: string;
        toDate?: string;
      }) =>
        record(
          "settlementHistory",
          settlementFigures(
            await ledgerTools.settlementHistory(ctx.db, ctx.organizationId, {
              counterpartyId: args.counterpartyId,
              fromDate: args.fromDate,
              toDate: args.toDate,
            }),
          ),
        ),
    });
  }

  const result = await generateText({
    model: ctx.model,
    tools,
    activeTools: [...allowlist],
    stopWhen: stepCountIs(MAX_TOOL_STEPS),
    prompt:
      INSTRUCTIONS +
      "\n" +
      segmentUntrusted("user-question", sanitizeUntrustedText(input.question)),
  });

  // Fail closed: a tool call with no result — a failing execute or
  // a call to a tool outside the allowlist — kills the turn instead
  // of being narrated around.
  for (const step of result.steps) {
    if (step.toolResults.length < step.toolCalls.length) {
      throw new WorkflowError(
        "TOOL_ERROR",
        "a tool call failed or named an unavailable tool",
      );
    }
  }

  const collectedFigures: DraftFigure[] = [];
  for (const name of EXPLAIN_TOOL_NAMES) {
    if (!allowlist.includes(name)) continue;
    const figures = collected.get(name);
    if (figures) collectedFigures.push(...figures);
  }
  const frozenFigures = Object.freeze(collectedFigures);

  const draft = await generateStructured(ctx, {
    schema: draftSchema,
    instructions: INSTRUCTIONS,
    prompt:
      segmentUntrusted("user-question", sanitizeUntrustedText(input.question)) +
      "\n" +
      segmentUntrusted("figures", describeFigures(frozenFigures)),
  });

  const answerFigures = draft.figureRefs.map((index) => {
    const figure = frozenFigures[index];
    if (!figure) {
      throw new WorkflowError(
        "WORKFLOW_INPUT",
        "the draft referenced a figure index that does not exist",
        { field: "figureRefs" },
      );
    }
    return figure;
  });

  return Object.freeze({
    text: renderChatAnswer({ text: draft.text, figures: answerFigures }),
    figures: frozenFigures,
  });
}

/**
 * Briefing-draft workflow (plan Step 4.2): the insight tools are
 * selected BY CODE (a deterministic list — whoOwesWhat +
 * spendByMerchant); the model never picks a tool, a limit, or a
 * figure. The model drafts sections that may only REFERENCE
 * collected figures by index (`figureRefs`) — the workflow composes
 * the envelope draft with ITS OWN tool-backed figures, so junk
 * figures in the draft are ignored by construction and an
 * out-of-range reference is a typed refusal. Rendering goes
 * through the Step 4.1 envelope: literal amounts in a draft are
 * PROSE_LITERAL_AMOUNT hard failures, placeholders bind formatCents
 * from the figure, and the empty-data case is a deterministic
 * fallback that never wakes the model at all.
 */
import { z } from "zod";
import { segmentUntrusted } from "../../security/untrusted-text";
import { renderBriefing } from "../envelope";
import { createAggregations } from "../../insight/aggregations";
import { createLedgerTools } from "../../insight/ledger-tools";
import {
  generateStructured,
  type WorkflowContext,
  WorkflowError,
} from "./context";
import { describeFigures, spendFigures, whoOwesFigures } from "./figures";

/** Honest, amount-free answer when there is nothing to report. */
export const EMPTY_BRIEFING_TEXT =
  "There is no activity to report yet — no open ledger positions and no posted transactions.";

const draftSchema = z.object({
  sections: z
    .array(
      z.object({
        headline: z.string().min(1),
        body: z.string(),
        figureRefs: z.array(z.number().int().min(0)),
      }),
    )
    .min(1),
});

const INSTRUCTIONS = [
  "You draft a short financial briefing.",
  "Reference figures ONLY as {{fig:N}} placeholders matching the",
  "numbered figure list you are given; never write amounts,",
  "digits with decimals, or currency symbols into the prose.",
].join(" ");

export interface BriefingWorkflowResult {
  readonly text: string;
  readonly figures: ReturnType<typeof whoOwesFigures>;
}

export async function runBriefingWorkflow(
  ctx: WorkflowContext,
  _input: object,
): Promise<BriefingWorkflowResult> {
  const ledgerTools = createLedgerTools();
  const aggregations = createAggregations();
  const figures = Object.freeze([
    ...whoOwesFigures(
      await ledgerTools.whoOwesWhat(ctx.db, ctx.organizationId),
    ),
    ...spendFigures(
      await aggregations.spendByMerchant(ctx.db, ctx.organizationId),
    ),
  ]);

  if (figures.length === 0) {
    return Object.freeze({ text: EMPTY_BRIEFING_TEXT, figures });
  }

  const draft = await generateStructured(ctx, {
    schema: draftSchema,
    instructions: INSTRUCTIONS,
    prompt: segmentUntrusted("figures", describeFigures(figures)),
  });

  const sections = draft.sections.map((section) => ({
    headline: section.headline,
    body: section.body,
    figures: section.figureRefs.map((index) => {
      const figure = figures[index];
      if (!figure) {
        throw new WorkflowError(
          "WORKFLOW_INPUT",
          "the draft referenced a figure index that does not exist",
          { field: "figureRefs" },
        );
      }
      return figure;
    }),
  }));

  return Object.freeze({ text: renderBriefing({ sections }), figures });
}

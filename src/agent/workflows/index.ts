/**
 * Agent workflows (plan Step 4.2) — predefined code paths for the
 * four intents; the AI SDK tool loop lives only in explain.ts.
 */
export {
  WorkflowError,
  type WorkflowContext,
  type WorkflowErrorCode,
} from "./context";
export {
  runCategorizeWorkflow,
  type CategorizedTransaction,
} from "./categorize";
export {
  runLedgerEntryWorkflow,
  type LedgerEntryWorkflowResult,
} from "./ledger-entry";
export {
  runBriefingWorkflow,
  EMPTY_BRIEFING_TEXT,
  type BriefingWorkflowResult,
} from "./briefing";
export {
  runExplainWorkflow,
  EXPLAIN_TOOL_NAMES,
  type ExplainToolName,
  type ExplainWorkflowResult,
} from "./explain";
export { describeFigures, type DraftFigure } from "./figures";

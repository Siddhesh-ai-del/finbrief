/**
 * Workflow plumbing (plan Step 4.2): the typed error, the per-tenant
 * context, and the one structured-generation helper every workflow
 * shares. Model calls always go through `generateStructured`, which
 * funnels the SDK's no-object failure into the Step 4.1 envelope —
 * a model that produced nothing parseable is a hard, typed stop,
 * never a silent null.
 */
import { Output, generateText, zodSchema, type LanguageModel } from "ai";
import type { z } from "zod";
import type { Db } from "../../db/tenancy";
import { mapModelError } from "../envelope";

export type WorkflowErrorCode =
  "WORKFLOW_INPUT" | "WORKFLOW_NOT_FOUND" | "TOOL_ERROR";

/**
 * Field-only failures (Steps 1.2/1.5): code plus a structural reason,
 * never the offending value.
 */
export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;
  readonly field: string | null;

  constructor(
    code: WorkflowErrorCode,
    reason: string,
    options?: { cause?: unknown; field?: string },
  ) {
    super(
      `agent workflow ${code}${options?.field ? ` (${options.field})` : ""}: ${reason}`,
      options,
    );
    this.name = "WorkflowError";
    this.code = code;
    this.field = options?.field ?? null;
  }
}

export interface WorkflowContext {
  readonly db: Db;
  readonly organizationId: string;
  readonly model: LanguageModel;
  /** Required by write workflows; a retry must reuse it (idempotency). */
  readonly requestId?: string;
}

export function requireRequestId(ctx: WorkflowContext): string {
  const requestId = ctx.requestId;
  if (typeof requestId !== "string" || requestId.trim() === "") {
    throw new WorkflowError(
      "WORKFLOW_INPUT",
      "a requestId is required for write workflows",
      { field: "requestId" },
    );
  }
  return requestId;
}

/**
 * One structured generation through the SDK's output path. Any SDK
 * failure — unparseable text, schema mismatch — surfaces via
 * mapModelError as a typed envelope failure; unrelated errors are
 * rethrown untouched.
 */
export async function generateStructured<S extends z.ZodType>(
  ctx: WorkflowContext,
  options: {
    schema: S;
    instructions: string;
    prompt: string;
  },
): Promise<z.infer<S>> {
  try {
    const result = await generateText({
      model: ctx.model,
      instructions: options.instructions,
      prompt: options.prompt,
      output: Output.object({ schema: zodSchema(options.schema) }),
    });
    return result.output as z.infer<S>;
  } catch (error) {
    mapModelError(error);
  }
}

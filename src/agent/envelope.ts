/**
 * Structured-output envelope (plan Step 4.1) — the anti-hallucination
 * device (§6.2-7).
 *
 * Every stage boundary the model crosses is a zod schema, and the
 * rule **"no figure without a source tool call"** is structural, not
 * prompt-discipline:
 *
 * - A figure is `{ label, amountCents, sourceRef[] }`. Figures only
 *   exist in this shape because a Step 2.1/3.3 tool call produced
 *   them; an EMPTY `sourceRef[]` is a typed hard failure
 *   (EMPTY_SOURCE_REF). The model cannot smuggle a number past this
 *   boundary without provenance.
 * - User-facing prose may contain monetary amounts ONLY through
 *   `{{fig:N}}` placeholders bound to a validated figure. Prose is
 *   scanned for literal money (PROSE_LITERAL_AMOUNT) and placeholders
 *   are range-checked (INVALID_PLACEHOLDER); rendering substitutes
 *   formatCents() from the figure, so every amount a user reads
 *   traces to a tool-backed figure. When the envelope refuses, the
 *   workflow shows USER_FALLBACK_PROSE — a constant with no monetary
 *   amount in it (tested with the same scanner).
 * - Zod failures surface as INVALID_OUTPUT carrying path+code only,
 *   never the offending value (Steps 1.2/1.5: no value echo).
 * - `AI_NoObjectGeneratedError` (the pinned AI SDK's class; its
 *   .name is literally that) maps to a typed NO_OBJECT_GENERATED
 *   failure with the cause preserved — a model that produced no
 *   parseable object is a hard, catchable stop, never a silent null
 *   that lets a workflow narrate nothing as if it were something.
 *
 * Stage boundaries (the four intents of Step 4.2): categorize,
 * explain (chat answer), ledger-entry, briefing-draft. The
 * ledger-entry command sanitizes the counterparty alias AT THE WALL
 * (§3.8) and demands a positive integer amount — direction and all
 * money arithmetic remain the ledger domain's job (Step 3.1), which
 * the model never touches.
 */
import { z } from "zod";
import { NoObjectGeneratedError } from "ai";
import { formatCents } from "../insight/freshness";
import { sanitizeUntrustedText } from "../security/untrusted-text";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type EnvelopeErrorCode =
  | "INVALID_OUTPUT"
  | "EMPTY_SOURCE_REF"
  | "PROSE_LITERAL_AMOUNT"
  | "INVALID_PLACEHOLDER"
  | "NO_OBJECT_GENERATED";

export class EnvelopeError extends Error {
  readonly code: EnvelopeErrorCode;
  /** Path+code pairs for INVALID_OUTPUT — never offending values. */
  readonly issues: readonly { path: string; code: string }[];

  constructor(
    code: EnvelopeErrorCode,
    reason: string,
    options?: {
      cause?: unknown;
      issues?: readonly { path: string; code: string }[];
    },
  ) {
    // Code + structural reason only — never the offending value.
    super(`agent envelope ${code}: ${reason}`, options);
    this.name = "EnvelopeError";
    this.code = code;
    this.issues = options?.issues ?? [];
  }
}

/**
 * What the user sees when the envelope refuses a draft: honest, no
 * figures, no amounts. Fail-closed UI mirrors fail-closed data
 * (docs/design-direction.md).
 */
export const USER_FALLBACK_PROSE =
  "I could not verify that answer against its sources, so I am not showing it. Please try again.";

/** Provenance, as produced by Step 2.1 (transaction) / 3.3 (ledger). */
const transactionSourceRefSchema = z.object({
  kind: z.literal("transaction"),
  transactionIds: z.array(z.string().min(1)),
  rowCount: z.number().int().min(0),
  fromDate: z.string().nullable(),
  toDate: z.string().nullable(),
});

const ledgerSourceRefSchema = z.object({
  kind: z.literal("ledger_entry"),
  entryIds: z.array(z.string().min(1)),
  rowCount: z.number().int().min(0),
  fromDate: z.string().nullable(),
  toDate: z.string().nullable(),
});

export const sourceRefSchema = z.discriminatedUnion("kind", [
  transactionSourceRefSchema,
  ledgerSourceRefSchema,
]);

/**
 * A figure at a stage boundary. `sourceRef` is allowed to arrive
 * empty ONLY so the rule below can reject it with the specific typed
 * error — shape errors and provenance errors are different failures
 * and workflows must be able to tell them apart.
 */
export const figureSchema = z.object({
  label: z
    .string()
    .transform((raw) => sanitizeUntrustedText(raw))
    .refine((label) => label !== "", {
      message: "label must contain readable characters after sanitization",
    }),
  amountCents: z.number().int(),
  sourceRef: z.array(sourceRefSchema),
});

/** Stage boundary: categorize (Step 4.2 intent 1). */
export const categorizeCommandSchema = z.object({
  transactionId: z.string().min(1),
  category: z.string().min(1),
});

/** Stage boundary: explain / open Q&A (intent 2). */
export const chatAnswerSchema = z.object({
  text: z.string(),
  figures: z.array(figureSchema).default([]),
});

/**
 * Stage boundary: ledger-entry (intent 3). No idempotency key — the
 * WORKFLOW generates keys in code; the model never chooses them.
 */
export const ledgerEntryCommandSchema = z.object({
  counterpartyAlias: z
    .string()
    .transform((raw) => sanitizeUntrustedText(raw))
    .refine((alias) => alias !== "", {
      message: "alias must contain readable characters after sanitization",
    }),
  kind: z.enum(["debt", "settlement"]),
  amountCents: z.number().int().positive(),
  entryDate: z.string().regex(ISO_DATE, {
    message: "entryDate must be ISO YYYY-MM-DD",
  }),
});

/** Stage boundary: briefing-draft (intent 4). */
export const briefingDraftSchema = z.object({
  sections: z
    .array(
      z.object({
        headline: z.string().min(1),
        body: z.string(),
        figures: z.array(figureSchema),
      }),
    )
    .min(1),
});

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    for (const item of Object.values(value)) deepFreeze(item);
    return Object.freeze(value);
  }
  return value;
}

/**
 * Parse a stage boundary. On failure the typed error carries
 * path+code pairs only — zod issue messages are dropped because
 * some embed received values, and this module never echoes input
 * (Steps 1.2/1.5).
 */
export function parseStageOutput<S extends z.ZodTypeAny>(
  schema: S,
  raw: unknown,
): z.infer<S> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      code: String(issue.code),
    }));
    throw new EnvelopeError(
      "INVALID_OUTPUT",
      `stage output failed schema validation (${issues.length} issues)`,
      { issues },
    );
  }
  return deepFreeze(result.data) as z.infer<S>;
}

/** The rule: every figure must carry at least one source tool call. */
function validateFigures(
  figures: readonly z.infer<typeof figureSchema>[],
): void {
  for (const figure of figures) {
    if (figure.sourceRef.length === 0) {
      throw new EnvelopeError(
        "EMPTY_SOURCE_REF",
        "figures must carry at least one sourceRef from a tool call",
      );
    }
  }
}

/**
 * Money-shaped strings in prose. Symbol amounts and bare two-decimal
 * numbers count; dates and integer counts do not (documented
 * heuristic — the placeholder rule below is what makes amounts
 * provenance-safe; this scanner is the tripwire for literals that
 * skipped it).
 */
const MONETARY = /[$€£₹]\s?-?\d[\d,]*(?:\.\d{1,2})?\b|\b\d[\d,]*\.\d{2}\b/u;

export function containsMonetaryAmount(text: string): boolean {
  return MONETARY.test(text);
}

const PLACEHOLDER = /\{\{fig:(\d+)\}\}/g;

/** Substitute `{{fig:N}}` placeholders; scan for literal money first. */
function renderProse(
  where: string,
  text: string,
  figures: readonly z.infer<typeof figureSchema>[],
): string {
  if (containsMonetaryAmount(text)) {
    throw new EnvelopeError(
      "PROSE_LITERAL_AMOUNT",
      `${where} contains a literal monetary amount; reference figures via {{fig:N}} placeholders`,
    );
  }
  return text.replace(PLACEHOLDER, (_match, index: string) => {
    const figure = figures[Number(index)];
    if (!figure) {
      throw new EnvelopeError(
        "INVALID_PLACEHOLDER",
        `${where} references a figure index that does not exist`,
      );
    }
    return formatCents(figure.amountCents);
  });
}

/** Explain-intent draft → user-facing prose, or a hard typed failure. */
export function renderChatAnswer(raw: unknown): string {
  const draft = parseStageOutput(chatAnswerSchema, raw);
  validateFigures(draft.figures);
  return renderProse("chat answer text", draft.text, draft.figures);
}

/** Briefing-draft → user-facing prose, or a hard typed failure. */
export function renderBriefing(raw: unknown): string {
  const draft = parseStageOutput(briefingDraftSchema, raw);
  return draft.sections
    .map((section, index) => {
      validateFigures(section.figures);
      const headline = renderProse(
        `briefing section ${index} headline`,
        section.headline,
        section.figures,
      );
      const body = renderProse(
        `briefing section ${index} body`,
        section.body,
        section.figures,
      );
      return `${headline}\n${body}`;
    })
    .join("\n\n");
}

/**
 * Map a model-side failure to a hard, catchable envelope failure.
 * The SDK's NoObjectGeneratedError (class .name:
 * "AI_NoObjectGeneratedError") means no parseable structured object
 * was produced — typed, cause preserved, never swallowed. Anything
 * else is rethrown untouched: this function classifies one specific
 * failure and pretends nothing else.
 */
export function mapModelError(error: unknown): never {
  if (error instanceof NoObjectGeneratedError) {
    throw new EnvelopeError(
      "NO_OBJECT_GENERATED",
      "model returned no parseable structured output",
      { cause: error },
    );
  }
  throw error;
}

/**
 * Ingest sanitization pipeline (plan Step 1.5).
 *
 * Merchant names and memos are counterparty-controlled text stored in
 * our database — Microsoft's Zero Trust catalog names "database
 * records" as an indirect-prompt-injection vector (OWASP LLM01–03,
 * §2.7). By the time this text reaches a prompt it is *tool output*,
 * which models treat as data-bearing instructions. This module is the
 * control boundary; everything downstream may assume its output is
 * inert.
 *
 * Design, pinned by tests/security/untrusted-text.test.ts:
 *
 * - **Allowlist, not blocklist.** Detection of instruction phrasing is
 *   unwinnable (§2.7's measurement study: blocklists trail new
 *   injections), so we allow a fixed character set and map everything
 *   else — control chars, bidi overrides, zero-width format chars,
 *   `<`, quotes, backticks — to a space. The output charset is the
 *   guarantee; the words inside it are inert data.
 * - **Length allowlist.** A 10KB blob truncates to
 *   MAX_UNTRUSTED_TEXT_LENGTH on a word boundary, so token cost and
 *   context-flooding are bounded at the same choke point.
 * - **Unforgeable delimiters.** The untrusted-content sentinels are
 *   built from characters OUTSIDE the allowlist (U+27E6/U+27E7), so
 *   sanitized text can never contain them — a merchant cannot forge
 *   the boundary that marks its own text as data.
 * - **Drop, don't redact.** The send-set (§3.8) carries `date`,
 *   integer cents, `currency`, `personal_finance_category`, the
 *   sanitized merchant, and our own surrogate id. The raw `name`/memo
 *   field, Plaid `transaction_id`/`item_id`/`pending_transaction_id`,
 *   and any account mask are *absent* from the returned object — not
 *   scrubbed strings that could un-scrub. Structured money fields
 *   fail loudly (`SendSetValidationError`) rather than emit a
 *   plausible-but-wrong figure; free-text fields degrade to null.
 * - **No echoing.** Validation errors name the field, never the
 *   value — a hostile string must not travel into logs via an error
 *   message (same reasoning as Step 1.2's no-secrets-in-logs test).
 *
 * Pure module: no I/O, no DB. Callers build the send-set at prompt
 * assembly time (Step 2.1 tools / Phase 4 envelope); stored rows keep
 * their raw values at rest (see src/db/schema/transactions.ts).
 */

/**
 * Length allowlist for any single untrusted text field, truncation
 * marker included.
 */
export const MAX_UNTRUSTED_TEXT_LENGTH = 128;

/**
 * Delimiters marking untrusted content inside a prompt. U+27E6/U+27E7
 * are outside the charset allowlist, so they are stripped from any
 * input — these sequences cannot be forged by the text they enclose.
 */
export const UNTRUSTED_OPEN = "\u27e6untrusted:data\u27e7";
export const UNTRUSTED_CLOSE = "\u27e6/untrusted:data\u27e7";

/**
 * The charset allowlist. Letters, digits, space, and a tight
 * punctuation set seen in real merchant strings (apostrophes, "#1234"
 * store numbers, Plaid's " > " category separators). `<` is never
 * allowed while `>` is — no tag can be opened, and categories keep
 * their hierarchy. Everything else maps to a space so hostile
 * characters cannot merge two words into one token.
 */
const ALLOWED = /[^A-Za-z0-9 \-.,'&%$#+/()>:*@!?]/g;

const MULTI_SPACE = / {2,}/g;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_CURRENCY = /^[A-Z]{3}$/;

/** Structured-field validation failure (date, cents, currency, id). */
export class SendSetValidationError extends Error {
  readonly field: string;

  constructor(field: string, reason: string) {
    // Field name and reason only — never the offending value.
    super(`send-set field "${field}" ${reason}`);
    this.name = "SendSetValidationError";
    this.field = field;
  }
}

function truncate(text: string): string {
  if (text.length <= MAX_UNTRUSTED_TEXT_LENGTH) {
    return text;
  }
  const head = text.slice(0, MAX_UNTRUSTED_TEXT_LENGTH - 3);
  const lastSpace = head.lastIndexOf(" ");
  const base =
    lastSpace >= MAX_UNTRUSTED_TEXT_LENGTH / 2
      ? head.slice(0, lastSpace)
      : head;
  return `${base.trimEnd()}...`;
}

/**
 * Reduce any input to inert, bounded, allowlisted text. Non-strings
 * (including DB nulls via the `string | null` call sites) are empty
 * text — there is nothing to preserve.
 */
export function sanitizeUntrustedText(raw: string | null | undefined): string {
  if (typeof raw !== "string") {
    return "";
  }
  const spaced = raw.replace(ALLOWED, " ");
  return truncate(spaced.replace(MULTI_SPACE, " ").trim());
}

/**
 * Mark text as untrusted data for a prompt: sanitized, delimiter-
 * segmented, with an allowlisted field label. Empty values are stated
 * as "(empty)" rather than left blank so the model cannot mistake
 * absence for the delimiter's end.
 */
export function segmentUntrusted(label: string, value: string): string {
  const safeLabel = sanitizeUntrustedText(label) || "text";
  const safeValue = sanitizeUntrustedText(value);
  return `${UNTRUSTED_OPEN} ${safeLabel}: ${safeValue || "(empty)"} ${UNTRUSTED_CLOSE}`;
}

/** One transaction as reduced for prompts (§3.8 send-set). */
export interface SendSetTransaction {
  /** Our surrogate id (row UUID) — never a Plaid id. */
  id: string;
  date: string;
  /** Signed integer cents; never a float, never computed downstream. */
  amountCents: number;
  currency: string | null;
  categoryPrimary: string | null;
  categoryDetailed: string | null;
  merchant: string | null;
}

/**
 * A stored transaction row as input. Extra fields (name, Plaid ids,
 * pending id) are accepted on purpose so the test that they are DROPPED
 * uses the real row shape — they never appear in the output.
 */
export interface SendSetInput {
  id: string;
  date: string;
  amountCents: number;
  isoCurrencyCode: string | null;
  personalFinanceCategoryPrimary: string | null;
  personalFinanceCategoryDetailed: string | null;
  merchantName: string | null;
  name?: string | null;
  plaidTransactionId?: string | null;
  plaidItemId?: string | null;
  pendingTransactionId?: string | null;
}

/**
 * Build the frozen send-set for one transaction. Structured fields are
 * validated, not sanitized: a malformed date/cents/currency means the
 * row is corrupt, and emitting a "fixed" version would invent a money
 * fact (§6.2-6/7 — figures come from validated tool data only).
 */
export function buildSendSet(
  input: SendSetInput,
): Readonly<SendSetTransaction> {
  if (typeof input?.id !== "string" || input.id.length === 0) {
    throw new SendSetValidationError("id", "missing surrogate id");
  }
  if (typeof input.date !== "string" || !ISO_DATE.test(input.date)) {
    throw new SendSetValidationError("date", "expected ISO YYYY-MM-DD");
  }
  if (!Number.isInteger(input.amountCents)) {
    throw new SendSetValidationError("amountCents", "expected integer cents");
  }
  let currency: string | null = null;
  if (input.isoCurrencyCode !== null && input.isoCurrencyCode !== undefined) {
    if (!ISO_CURRENCY.test(input.isoCurrencyCode)) {
      throw new SendSetValidationError("currency", "expected ISO 4217 code");
    }
    currency = input.isoCurrencyCode;
  }

  return Object.freeze({
    id: input.id,
    date: input.date,
    amountCents: input.amountCents,
    currency,
    categoryPrimary:
      sanitizeUntrustedText(input.personalFinanceCategoryPrimary) || null,
    categoryDetailed:
      sanitizeUntrustedText(input.personalFinanceCategoryDetailed) || null,
    merchant: sanitizeUntrustedText(input.merchantName) || null,
  });
}

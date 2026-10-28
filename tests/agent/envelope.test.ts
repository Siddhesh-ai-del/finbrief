/**
 * Step 4.1 — structured-output envelope (plan Phase 4).
 *
 * The anti-hallucination device (§6.2-7): every stage boundary the
 * model crosses is a zod schema, and the rule **"no figure without a
 * source tool call"** is enforced structurally:
 *
 * - A figure whose `sourceRef[]` is empty is a typed hard failure
 *   (EMPTY_SOURCE_REF) — the model cannot smuggle a number past the
 *   boundary without provenance from a Step 2.1/3.3 tool call.
 * - User-facing prose may contain monetary amounts ONLY through
 *   `{{fig:N}}` placeholders bound to a validated figure. A literal
 *   "$99.99" in prose is rejected (PROSE_LITERAL_AMOUNT); on any
 *   failure the user sees USER_FALLBACK_PROSE, which by construction
 *   contains no monetary amount (asserted with the same scanner).
 * - Zod failures surface as INVALID_OUTPUT carrying path+code only —
 *   never the offending value (Steps 1.2/1.5 discipline).
 * - `AI_NoObjectGeneratedError` (the installed AI SDK's class — its
 *   .name is literally that) is mapped to a typed, catchable
 *   NO_OBJECT_GENERATED failure with the cause preserved: a model
 *   that produced no parseable object is a hard stop, not a
 *   silent-null continuation.
 *
 * Four stage boundaries (the four intents of Step 4.2): categorize,
 * explain (chat answer), ledger-entry, briefing-draft. The
 * ledger-entry command sanitizes the counterparty alias AT THE
 * BOUNDARY (§3.8) — a model never emits a raw alias to the ledger.
 */
import { describe, expect, it } from "vitest";
import { NoObjectGeneratedError, type LanguageModelUsage } from "ai";
import {
  EnvelopeError,
  USER_FALLBACK_PROSE,
  briefingDraftSchema,
  categorizeCommandSchema,
  chatAnswerSchema,
  containsMonetaryAmount,
  ledgerEntryCommandSchema,
  mapModelError,
  parseStageOutput,
  renderBriefing,
  renderChatAnswer,
} from "../../src/agent/envelope";

/** A legitimate figure, as produced by a Step 2.1/3.3 tool call. */
const backedFigure = {
  label: "Groceries",
  amountCents: 4050,
  sourceRef: [
    {
      kind: "transaction",
      transactionIds: ["txn-1", "txn-2"],
      rowCount: 2,
      fromDate: "2026-10-01",
      toDate: "2026-10-31",
    },
  ],
};

const ledgerBackedFigure = {
  label: "Alex",
  amountCents: 5000,
  sourceRef: [
    {
      kind: "ledger_entry",
      entryIds: ["entry-1"],
      rowCount: 1,
      fromDate: null,
      toDate: null,
    },
  ],
};

function catchEnvelope(fn: () => unknown): EnvelopeError {
  try {
    fn();
  } catch (error) {
    return error as EnvelopeError;
  }
  throw new Error("expected a throw");
}

describe("stage schemas — every boundary is a schema", () => {
  it("parses the categorize boundary", () => {
    const parsed = parseStageOutput(categorizeCommandSchema, {
      transactionId: "txn-abc",
      category: "FOOD_AND_DRINK",
    });
    expect(parsed.transactionId).toBe("txn-abc");
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it("parses the ledger-entry boundary, sanitizing the alias at the wall", () => {
    const parsed = parseStageOutput(ledgerEntryCommandSchema, {
      counterpartyAlias: "R\u202eival\u200b  Crew",
      kind: "debt",
      amountCents: 4000,
      entryDate: "2026-10-05",
    });
    // §3.8: the alias the ledger will ever see is sanitized — the
    // model cannot emit hostile bytes past this boundary.
    expect(parsed.counterpartyAlias).toBe("R ival Crew");
  });

  it("rejects nonsense on the ledger-entry boundary without echoing values", () => {
    const caught = catchEnvelope(() =>
      parseStageOutput(ledgerEntryCommandSchema, {
        counterpartyAlias: "Alex",
        kind: "iou", // not a kind
        amountCents: "lots", // not a number
        entryDate: "05-10-2026",
      }),
    );
    expect(caught).toBeInstanceOf(EnvelopeError);
    expect(caught.code).toBe("INVALID_OUTPUT");
    // Issues are path+code only — the offending values are gone.
    expect(caught.issues.length).toBeGreaterThan(0);
    for (const issue of caught.issues) {
      expect(Object.keys(issue).sort()).toEqual(["code", "path"]);
      expect(typeof issue.path).toBe("string");
      expect(typeof issue.code).toBe("string");
    }
    expect(caught.message).not.toContain("lots");
    expect(caught.message).not.toContain("iou");
    expect(caught.message).not.toContain("05-10-2026");
  });

  it("rejects zero and negative amounts on the ledger-entry boundary", () => {
    for (const amountCents of [0, -100, 1.5]) {
      const caught = catchEnvelope(() =>
        parseStageOutput(ledgerEntryCommandSchema, {
          counterpartyAlias: "Alex",
          kind: "debt",
          amountCents,
          entryDate: "2026-10-05",
        }),
      );
      expect(caught.code).toBe("INVALID_OUTPUT");
      expect(caught.message).not.toContain(String(amountCents));
    }
  });

  it("parses the explain and briefing-draft boundaries, frozen", () => {
    const chat = parseStageOutput(chatAnswerSchema, {
      text: "You spent {{fig:0}} on groceries.",
      figures: [backedFigure],
    });
    expect(Object.isFrozen(chat)).toBe(true);
    expect(Object.isFrozen(chat.figures[0])).toBe(true);

    const briefing = parseStageOutput(briefingDraftSchema, {
      sections: [
        {
          headline: "This month",
          body: "Alex owes you {{fig:0}}.",
          figures: [ledgerBackedFigure],
        },
      ],
    });
    expect(Object.isFrozen(briefing)).toBe(true);
    expect(Object.isFrozen(briefing.sections[0])).toBe(true);
  });
});

describe("no figure without a source tool call", () => {
  it("rejects a figure whose sourceRef is empty — typed, hard", () => {
    const caught = catchEnvelope(() =>
      renderChatAnswer({
        text: "You spent {{fig:0}}.",
        figures: [{ label: "Mystery", amountCents: 1234, sourceRef: [] }],
      }),
    );
    expect(caught).toBeInstanceOf(EnvelopeError);
    expect(caught.code).toBe("EMPTY_SOURCE_REF");
  });

  it("on failure the user-facing prose carries no monetary amount", () => {
    // The fallback the workflow shows when the envelope refuses.
    expect(containsMonetaryAmount(USER_FALLBACK_PROSE)).toBe(false);
    expect(USER_FALLBACK_PROSE.length).toBeGreaterThan(0);

    const caught = catchEnvelope(() =>
      renderChatAnswer({
        text: "You spent {{fig:0}}.",
        figures: [{ label: "Mystery", amountCents: 98765, sourceRef: [] }],
      }),
    );
    // Even the error text itself must not leak a money-shaped string.
    expect(containsMonetaryAmount(caught.message)).toBe(false);
  });
});

describe("renderChatAnswer — amounts only through placeholders", () => {
  it("substitutes figure amounts, formatted from integer cents", () => {
    const rendered = renderChatAnswer({
      text: "You spent {{fig:0}} on groceries and {{fig:1}} overall.",
      figures: [
        backedFigure,
        {
          label: "Total",
          amountCents: -1234,
          sourceRef: backedFigure.sourceRef,
        },
      ],
    });
    expect(rendered).toBe("You spent $40.50 on groceries and -$12.34 overall.");
  });

  it("rejects a literal monetary amount in prose", () => {
    const caught = catchEnvelope(() =>
      renderChatAnswer({
        text: "You spent $9999.99 somehow.",
        figures: [backedFigure],
      }),
    );
    expect(caught.code).toBe("PROSE_LITERAL_AMOUNT");
    expect(caught.message).not.toContain("9999.99");
  });

  it("rejects placeholders that reference nothing", () => {
    const caught = catchEnvelope(() =>
      renderChatAnswer({
        text: "You spent {{fig:3}}.",
        figures: [backedFigure],
      }),
    );
    expect(caught.code).toBe("INVALID_PLACEHOLDER");
  });

  it("allows an answer with no figures and no amounts", () => {
    const rendered = renderChatAnswer({ text: "Nothing was charged today." });
    expect(rendered).toBe("Nothing was charged today.");
    expect(containsMonetaryAmount(rendered)).toBe(false);
  });
});

describe("renderBriefing — per-section figures, scanned headlines", () => {
  it("renders sections with their own figures", () => {
    const rendered = renderBriefing({
      sections: [
        {
          headline: "Who owes what",
          body: "Alex owes you {{fig:0}}.",
          figures: [ledgerBackedFigure],
        },
        {
          headline: "Spending",
          body: "You spent {{fig:0}} on groceries.",
          figures: [backedFigure],
        },
      ],
    });
    expect(rendered).toBe(
      "Who owes what\nAlex owes you $50.00.\n\nSpending\nYou spent $40.50 on groceries.",
    );
  });

  it("scans headlines for literal amounts too", () => {
    const caught = catchEnvelope(() =>
      renderBriefing({
        sections: [
          {
            headline: "Down $50.00",
            body: "A hard month.",
            figures: [],
          },
        ],
      }),
    );
    expect(caught.code).toBe("PROSE_LITERAL_AMOUNT");
  });

  it("rejects an unbacked figure inside any section", () => {
    const caught = catchEnvelope(() =>
      renderBriefing({
        sections: [
          {
            headline: "Ledger",
            body: "Someone owes {{fig:0}}.",
            figures: [{ label: "Ghost", amountCents: 500, sourceRef: [] }],
          },
        ],
      }),
    );
    expect(caught.code).toBe("EMPTY_SOURCE_REF");
  });
});

describe("AI_NoObjectGeneratedError — a hard, catchable failure", () => {
  it("maps the SDK's no-object error to a typed failure with cause", () => {
    // Token counts are irrelevant here: the mapping is instanceof
    // based, so a real (minimally populated) instance is what counts.
    const sdkError = new NoObjectGeneratedError({
      response: {
        id: "resp-test",
        timestamp: new Date(0),
        modelId: "test-model",
      },
      usage: {} as LanguageModelUsage,
      finishReason: "stop",
    });
    let caught: EnvelopeError | null = null;
    try {
      mapModelError(sdkError);
    } catch (error) {
      caught = error as EnvelopeError;
    }
    expect(caught).toBeInstanceOf(EnvelopeError);
    expect(caught?.code).toBe("NO_OBJECT_GENERATED");
    expect(caught?.cause).toBe(sdkError);
  });

  it("rethrows anything else untouched — never swallows", () => {
    const other = new TypeError("connection reset");
    let rethrown: unknown = null;
    try {
      mapModelError(other);
    } catch (error) {
      rethrown = error;
    }
    expect(rethrown).toBe(other);
  });
});

describe("containsMonetaryAmount — the prose scanner", () => {
  it("detects symbol amounts and bare decimals, ignores dates and counts", () => {
    expect(containsMonetaryAmount("You spent $40.50.")).toBe(true);
    expect(containsMonetaryAmount("It was -$1,234.56 total.")).toBe(true);
    expect(containsMonetaryAmount("Roughly 40.50 dollars back.")).toBe(true);
    expect(containsMonetaryAmount("On 2026-10-05, 3 items shipped.")).toBe(
      false,
    );
    expect(containsMonetaryAmount("Alex owes you 50 dollars.")).toBe(false);
  });
});

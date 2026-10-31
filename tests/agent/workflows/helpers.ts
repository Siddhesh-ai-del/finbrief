/**
 * Shared AI SDK mock builders for the workflow tests (Step 4.2).
 *
 * The workflows take a LanguageModelV4-compatible model, so tests
 * script real SDK calls through MockLanguageModelV4 — the tool loop,
 * output parsing, and NoObjectGeneratedError behavior are the REAL
 * SDK paths, not fakes of them.
 *
 * The result-shape types come from @ai-sdk/provider (the SDK's own
 * contract); each scripted result is built through one typed helper.
 */
import { MockLanguageModelV4 } from "ai/test";
import type {
  LanguageModelV4GenerateResult,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";

export const mockUsage: LanguageModelV4Usage = {
  inputTokens: {
    total: 1,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: undefined, reasoning: undefined },
};

function scripted(
  content: unknown[],
  unified: "stop" | "tool-calls",
): LanguageModelV4GenerateResult {
  return {
    content: content as LanguageModelV4GenerateResult["content"],
    finishReason: { unified, raw: undefined },
    usage: mockUsage,
  } as LanguageModelV4GenerateResult;
}

/** A model that answers every call with the same JSON text. */
export function jsonMock(value: unknown): MockLanguageModelV4 {
  return textMock(JSON.stringify(value));
}

/** A model that answers every call with the same raw text. */
export function textMock(text: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: scripted([{ type: "text", text }], "stop"),
  });
}

/**
 * A model that records every call and returns unparseable text — a
 * test that expects NO model call asserts calls === 0; a call that
 * slips through fails loudly at the envelope (no object generated).
 */
export function countingMock(): {
  model: MockLanguageModelV4;
  state: { calls: number };
} {
  const state = { calls: 0 };
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      state.calls += 1;
      return scripted([{ type: "text", text: "not json" }], "stop");
    },
  });
  return { model, state };
}

export interface ScriptedPart {
  content: unknown[];
  finishReason?: "stop" | "tool-calls";
}

/** A model that plays a scripted sequence and records each prompt. */
export function scriptedMock(
  parts: ScriptedPart[],
  prompts?: string[],
): MockLanguageModelV4 {
  let call = 0;
  return new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts?.push(JSON.stringify(options.prompt));
      const part = parts[Math.min(call, parts.length - 1)]!;
      call += 1;
      return scripted(part.content, part.finishReason ?? "stop");
    },
  });
}

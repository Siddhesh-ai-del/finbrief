/**
 * Step 4.2 — ledger-entry workflow (plan Phase 4).
 *
 * The model PARSES the user's statement into a command (envelope-
 * sanitized alias, positive integer cents, ISO date); the workflow
 * executes it deterministically: counterparty lookup-or-create by
 * exact alias, then the Step 3.1 domain call. The model never picks
 * an idempotency key — the workflow derives it from the caller's
 * requestId, so a redelivered turn replays to the same entry
 * (Steps 1.3/3.1) instead of double-recording a debt. Settlement
 * amounts are translated to the opposing sign IN CODE; the domain
 * keeps its no-double-settlement rule and its typed refusals
 * propagate — the workflow never swallows them.
 *
 * The result carries a balance figure with real ledger provenance
 * (capped entry-id sample + exact live-entry rowCount) so the
 * Step 4.1 envelope will accept it in user-facing prose.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { createScratchDatabase } from "../../helpers/scratch-db";
import { createDb, type Db } from "../../../src/db/tenancy";
import {
  EnvelopeError,
  figureSchema,
  parseStageOutput,
} from "../../../src/agent/envelope";
import { type WorkflowError } from "../../../src/agent/workflows/context";
import { runLedgerEntryWorkflow } from "../../../src/agent/workflows/ledger-entry";
import {
  LedgerError,
  createCounterparty,
  recordDebt,
} from "../../../src/ledger/entries";
import { countingMock, jsonMock, textMock } from "./helpers";

const DB = "finbrief_wf_ledger_test";
const ORG = "org_wfl_1";

let scratch: Awaited<ReturnType<typeof createScratchDatabase>>;
let pool: Pool;
let db: Db;

beforeAll(async () => {
  scratch = await createScratchDatabase(DB);
  await scratch.migrate();
  pool = scratch.pool;
  db = createDb(pool);
  await pool.query(
    `INSERT INTO organization (id, name, slug, created_at)
     VALUES ($1, 'wf-ledger', 'wf-ledger', now())`,
    [ORG],
  );
}, 60_000);

afterAll(async () => {
  await scratch?.destroy();
});

beforeEach(async () => {
  await pool.query(
    "TRUNCATE ledger_entry_links, ledger_entries, ledger_counterparties CASCADE",
  );
});

function context(
  model: ReturnType<typeof jsonMock>,
  requestId: string | null | undefined = "req-1",
) {
  return { db, organizationId: ORG, model, requestId: requestId ?? undefined };
}

function command(overrides: Record<string, unknown> = {}) {
  return jsonMock({
    counterpartyAlias: "Alex",
    kind: "debt",
    amountCents: 4000,
    entryDate: "2026-10-05",
    ...overrides,
  });
}

async function catchAsync(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (error) {
    return error as WorkflowError | EnvelopeError | LedgerError;
  }
  throw new Error("expected a throw");
}

describe("runLedgerEntryWorkflow", () => {
  it("turns a parsed command into a domain entry with provenance", async () => {
    const result = await runLedgerEntryWorkflow(
      context(command()),
      "I lent Alex $40",
    );

    expect(result.alias).toBe("Alex");
    expect(result.entry.kind).toBe("debt");
    expect(result.entry.amountCents).toBe(4000);
    expect(result.balanceCents).toBe(4000);
    expect(result.figure).toEqual({
      label: "Alex",
      amountCents: 4000,
      sourceRef: [
        {
          kind: "ledger_entry",
          entryIds: [result.entry.id],
          rowCount: 1,
          fromDate: null,
          toDate: null,
        },
      ],
    });
    // The figure is a Step 4.1 figure: it passes the envelope.
    expect(() => parseStageOutput(figureSchema, result.figure)).not.toThrow();
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("translates a settlement to the opposing sign in code", async () => {
    const cp = await createCounterparty(db, ORG, { alias: "Alex" });
    await recordDebt(db, ORG, {
      counterpartyId: cp.id,
      amountCents: 4000,
      entryDate: "2026-10-01",
      idempotencyKey: "seed-debt-1",
    });

    const result = await runLedgerEntryWorkflow(
      context(command({ kind: "settlement", amountCents: 2000 })),
      "Alex paid me back $20",
    );

    expect(result.entry.kind).toBe("settlement");
    expect(result.entry.amountCents).toBe(-2000);
    expect(result.balanceCents).toBe(2000);
  });

  it("replays the same requestId to the same entry — no double debt", async () => {
    const ctx = context(command(), "req-replay");
    const first = await runLedgerEntryWorkflow(ctx, "I lent Alex $40");
    const second = await runLedgerEntryWorkflow(ctx, "I lent Alex $40 again");

    expect(second.entry.id).toBe(first.entry.id);
    expect(second.balanceCents).toBe(4000); // still one debt, not two
  });

  it("lets the domain refuse a settlement above the outstanding balance", async () => {
    const caught = await catchAsync(() =>
      runLedgerEntryWorkflow(
        context(command({ kind: "settlement", amountCents: 2000 })),
        "Alex paid me back $20",
      ),
    );

    expect(caught).toBeInstanceOf(LedgerError);
    expect((caught as LedgerError).code).toBe("SETTLEMENT_EXCEEDS_BALANCE");
  });

  it("refuses to run without a requestId — before any model call", async () => {
    const { model, state } = countingMock();
    const caught = await catchAsync(() =>
      runLedgerEntryWorkflow(context(model, null), "I lent Alex $40"),
    );

    expect((caught as WorkflowError).code).toBe("WORKFLOW_INPUT");
    expect(state.calls).toBe(0);
  });

  it("treats model output that never parses as NO_OBJECT_GENERATED", async () => {
    const caught = await catchAsync(() =>
      runLedgerEntryWorkflow(
        context(textMock("nope") as unknown as ReturnType<typeof jsonMock>),
        "I lent Alex $40",
      ),
    );

    expect(caught).toBeInstanceOf(EnvelopeError);
    expect((caught as EnvelopeError).code).toBe("NO_OBJECT_GENERATED");
  });

  it("stores only the sanitized alias — hostile bytes never reach rows", async () => {
    const result = await runLedgerEntryWorkflow(
      context(
        command({ counterpartyAlias: "R\u202eival\u200b Crew" }),
        "I lent the rival crew $40",
      ),
      "I lent the rival crew $40",
    );

    expect(result.alias).toBe("R ival Crew");
    const stored = await pool.query(
      "SELECT alias FROM ledger_counterparties WHERE id = $1",
      [result.counterpartyId],
    );
    expect((stored.rows[0] as { alias: string }).alias).toBe("R ival Crew");
  });

  it("reuses an existing live counterparty instead of duplicating it", async () => {
    await runLedgerEntryWorkflow(context(command(), "req-a"), "lent Alex $40");
    const second = await runLedgerEntryWorkflow(
      context(command({ amountCents: 1500 }), "req-b"),
      "lent Alex $15",
    );

    const counterparties = await pool.query(
      "SELECT id FROM ledger_counterparties WHERE organization_id = $1",
      [ORG],
    );
    expect(counterparties.rowCount).toBe(1);
    expect(second.balanceCents).toBe(5500);
    expect(second.figure.sourceRef[0]?.rowCount).toBe(2);
  });
});

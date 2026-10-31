/**
 * Step 4.2 — briefing-draft workflow (plan Phase 4).
 *
 * The insight tools are selected BY CODE (whoOwesWhat +
 * spendByMerchant, deterministic list); the model never picks a
 * tool, a limit, or a figure. The model drafts sections that may
 * only REFERENCE collected figures by index (`figureRefs`) — the
 * workflow composes the envelope draft with ITS OWN tool-backed
 * figures, so a model that emits junk figures is ignored by
 * construction, and an out-of-range reference is a typed refusal.
 * Rendering goes through the Step 4.1 envelope: literal amounts in
 * a draft are PROSE_LITERAL_AMOUNT hard failures, placeholders bind
 * formatCents from the figure, and the empty-data case is a
 * deterministic fallback that never wakes the model at all.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { createScratchDatabase } from "../../helpers/scratch-db";
import { createDb, type Db } from "../../../src/db/tenancy";
import {
  EnvelopeError,
  containsMonetaryAmount,
} from "../../../src/agent/envelope";
import { WorkflowError } from "../../../src/agent/workflows/context";
import {
  EMPTY_BRIEFING_TEXT,
  runBriefingWorkflow,
} from "../../../src/agent/workflows/briefing";
import { createCounterparty, recordDebt } from "../../../src/ledger/entries";
import { countingMock, jsonMock, textMock } from "./helpers";

const DB = "finbrief_wf_briefing_test";
const ORG = "org_wfb_1";

let scratch: Awaited<ReturnType<typeof createScratchDatabase>>;
let pool: Pool;
let db: Db;
let item: string;

beforeAll(async () => {
  scratch = await createScratchDatabase(DB);
  await scratch.migrate();
  pool = scratch.pool;
  db = createDb(pool);
  await pool.query(
    `INSERT INTO organization (id, name, slug, created_at)
     VALUES ($1, 'wf-brief', 'wf-brief', now())`,
    [ORG],
  );
  const inserted = await pool.query(
    `INSERT INTO plaid_items
       (id, organization_id, item_id_ciphertext, access_token_ciphertext,
        item_id_index, status, created_at)
     VALUES (gen_random_uuid(), $1, 'ct', 'ct', $2, 'active', now())
     RETURNING id`,
    [ORG, `idx-${randomBytes(4).toString("hex")}`],
  );
  item = (inserted.rows[0] as { id: string }).id;
}, 60_000);

afterAll(async () => {
  await scratch?.destroy();
});

beforeEach(async () => {
  await pool.query(
    "TRUNCATE transactions, ledger_entry_links, ledger_entries, ledger_counterparties CASCADE",
  );
});

let seq = 0;
async function seedAlexDebt(): Promise<void> {
  seq += 1;
  const cp = await createCounterparty(db, ORG, { alias: "Alex" });
  await recordDebt(db, ORG, {
    counterpartyId: cp.id,
    amountCents: 5000,
    entryDate: "2026-10-01",
    idempotencyKey: `wfb-debt-${seq}`,
  });
}

async function seedSpend(): Promise<void> {
  seq += 1;
  await pool.query(
    `INSERT INTO transactions
       (id, organization_id, plaid_item_id, plaid_transaction_id, date,
        amount_cents, iso_currency_code, name, merchant_name,
        personal_finance_category_primary, pending, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, '2026-10-04', 4050, 'USD',
             'Grocery Mart', 'Grocery Mart', 'FOOD_AND_DRINK', false,
             now(), now())`,
    [ORG, item, `plaid-txn-wfb-${seq}-${randomBytes(3).toString("hex")}`],
  );
}

function context(model: ReturnType<typeof jsonMock>) {
  return { db, organizationId: ORG, model };
}

async function catchAsync(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (error) {
    return error as WorkflowError | EnvelopeError;
  }
  throw new Error("expected a throw");
}

describe("runBriefingWorkflow", () => {
  it("drafts prose over tool figures and binds every amount in code", async () => {
    await seedAlexDebt();
    await seedSpend();
    const model = jsonMock({
      sections: [
        {
          headline: "Who owes what",
          body: "Alex owes you {{fig:0}}. Groceries took {{fig:1}}.",
          figureRefs: [0, 1],
        },
      ],
    });

    const result = await runBriefingWorkflow(context(model), {});

    // fig 0 = Alex's ledger balance; fig 2 = Grocery Mart spend.
    expect(result.text).toBe(
      "Who owes what\nAlex owes you $50.00. Groceries took $40.50.",
    );
    expect(result.figures[0]?.sourceRef[0]?.kind).toBe("ledger_entry");
    expect(result.figures[1]?.sourceRef[0]?.kind).toBe("transaction");
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("with no data at all, answers deterministically — no model call", async () => {
    const { model, state } = countingMock();

    const result = await runBriefingWorkflow(context(model), {});

    expect(result.text).toBe(EMPTY_BRIEFING_TEXT);
    expect(result.figures).toEqual([]);
    expect(containsMonetaryAmount(result.text)).toBe(false);
    expect(state.calls).toBe(0);
  });

  it("hard-refuses a draft that embeds a literal amount", async () => {
    await seedAlexDebt();
    const model = jsonMock({
      sections: [
        { headline: "Report", body: "You spent $99.99.", figureRefs: [] },
      ],
    });

    const caught = await catchAsync(() =>
      runBriefingWorkflow(context(model), {}),
    );

    expect(caught).toBeInstanceOf(EnvelopeError);
    expect((caught as EnvelopeError).code).toBe("PROSE_LITERAL_AMOUNT");
  });

  it("refuses a figure reference that points at nothing", async () => {
    await seedAlexDebt();
    const model = jsonMock({
      sections: [
        {
          headline: "Report",
          body: "Someone owes {{fig:99}}.",
          figureRefs: [99],
        },
      ],
    });

    const caught = await catchAsync(() =>
      runBriefingWorkflow(context(model), {}),
    );

    expect(caught).toBeInstanceOf(WorkflowError);
    expect((caught as WorkflowError).code).toBe("WORKFLOW_INPUT");
  });

  it("treats a draft that never parses as NO_OBJECT_GENERATED", async () => {
    await seedAlexDebt();
    const caught = await catchAsync(() =>
      runBriefingWorkflow(
        context(textMock("nope") as unknown as ReturnType<typeof jsonMock>),
        {},
      ),
    );

    expect(caught).toBeInstanceOf(EnvelopeError);
    expect((caught as EnvelopeError).code).toBe("NO_OBJECT_GENERATED");
  });
});

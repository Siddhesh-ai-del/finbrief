/**
 * Step 4.2 — categorize workflow (plan Phase 4).
 *
 * The deterministic-first pipeline: the stored Plaid primary category
 * IS the answer whenever it exists, so the model is consulted only
 * for transactions Plaid left unclassified — programmatic tool
 * selection (§6.2-5). The model's command crosses the Step 4.1
 * envelope (zod schema); an object that never parses is the typed
 * NO_OBJECT_GENERATED hard stop, and a command that names a
 * different transaction than the one asked about is refused.
 *
 * Tenancy: rows are loaded scoped to the context's organization, so
 * an id outside the tenant is WORKFLOW_NOT_FOUND — the model cannot
 * direct the workflow at someone else's data, and errors never echo
 * the offending id (Steps 1.2/1.5).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { createScratchDatabase } from "../../helpers/scratch-db";
import { createDb, type Db } from "../../../src/db/tenancy";
import { EnvelopeError } from "../../../src/agent/envelope";
import { WorkflowError } from "../../../src/agent/workflows/context";
import { runCategorizeWorkflow } from "../../../src/agent/workflows/categorize";
import { countingMock, jsonMock, textMock } from "./helpers";

const DB = "finbrief_wf_categorize_test";
const ORG = "org_wfcat_1";
const OTHER_ORG = "org_wfcat_2";

let scratch: Awaited<ReturnType<typeof createScratchDatabase>>;
let pool: Pool;
let db: Db;
let itemMain: string;
let itemOther: string;

beforeAll(async () => {
  scratch = await createScratchDatabase(DB);
  await scratch.migrate();
  pool = scratch.pool;
  db = createDb(pool);
  for (const [id, slug] of [
    [ORG, "wfcat-one"],
    [OTHER_ORG, "wfcat-two"],
  ] as const) {
    await pool.query(
      `INSERT INTO organization (id, name, slug, created_at)
       VALUES ($1, $2, $3, now())`,
      [id, slug, slug],
    );
  }
  const a = await pool.query(
    `INSERT INTO plaid_items
       (id, organization_id, item_id_ciphertext, access_token_ciphertext,
        item_id_index, status, created_at)
     VALUES (gen_random_uuid(), $1, 'ct', 'ct', $2, 'active', now())
     RETURNING id`,
    [ORG, `idx-${randomBytes(4).toString("hex")}`],
  );
  itemMain = (a.rows[0] as { id: string }).id;
  const b = await pool.query(
    `INSERT INTO plaid_items
       (id, organization_id, item_id_ciphertext, access_token_ciphertext,
        item_id_index, status, created_at)
     VALUES (gen_random_uuid(), $1, 'ct', 'ct', $2, 'active', now())
     RETURNING id`,
    [OTHER_ORG, `idx-${randomBytes(4).toString("hex")}`],
  );
  itemOther = (b.rows[0] as { id: string }).id;
}, 60_000);

afterAll(async () => {
  await scratch?.destroy();
});

beforeEach(async () => {
  await pool.query("TRUNCATE transactions CASCADE");
});

let seq = 0;
async function insertTxn(
  itemId: string,
  orgId: string,
  f: { date: string; amount: number; name: string; pfc?: string | null },
): Promise<string> {
  seq += 1;
  const inserted = await pool.query(
    `INSERT INTO transactions
       (id, organization_id, plaid_item_id, plaid_transaction_id, date,
        amount_cents, iso_currency_code, name, merchant_name,
        personal_finance_category_primary, pending, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'USD', $6, $7, $8, false,
             now(), now())
     RETURNING id`,
    [
      orgId,
      itemId,
      `plaid-txn-wf-${seq}-${randomBytes(3).toString("hex")}`,
      f.date,
      f.amount,
      f.name,
      f.name,
      f.pfc ?? null,
    ],
  );
  return (inserted.rows[0] as { id: string }).id;
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

describe("runCategorizeWorkflow", () => {
  it("uses the stored Plaid primary without ever calling the model", async () => {
    const txnId = await insertTxn(itemMain, ORG, {
      date: "2026-10-04",
      amount: 1250,
      name: "Grocery Mart",
      pfc: "FOOD_AND_DRINK",
    });
    const { model, state } = countingMock();

    const result = await runCategorizeWorkflow(context(model), {
      transactionIds: [txnId],
    });

    expect(result).toEqual([
      { transactionId: txnId, category: "FOOD_AND_DRINK", source: "stored" },
    ]);
    expect(state.calls).toBe(0);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("consults the model only where Plaid left no category", async () => {
    const classified = await insertTxn(itemMain, ORG, {
      date: "2026-10-04",
      amount: 500,
      name: "Cafe",
      pfc: "FOOD_AND_DRINK",
    });
    const open = await insertTxn(itemMain, ORG, {
      date: "2026-10-05",
      amount: 9900,
      name: "Rail Europe",
      pfc: null,
    });
    const drafted = jsonMock({
      transactionId: open,
      category: "TRAVEL",
    });
    const result = await runCategorizeWorkflow(context(drafted), {
      transactionIds: [classified, open],
    });

    expect(result).toEqual([
      {
        transactionId: classified,
        category: "FOOD_AND_DRINK",
        source: "stored",
      },
      { transactionId: open, category: "TRAVEL", source: "model" },
    ]);
  });

  it("refuses a command that names a different transaction", async () => {
    const txnId = await insertTxn(itemMain, ORG, {
      date: "2026-10-06",
      amount: 300,
      name: "Kiosk",
      pfc: null,
    });
    const model = jsonMock({
      transactionId: "someone-elses-row",
      category: "X",
    });

    const caught = await catchAsync(() =>
      runCategorizeWorkflow(context(model), { transactionIds: [txnId] }),
    );

    expect(caught).toBeInstanceOf(WorkflowError);
    expect((caught as WorkflowError).code).toBe("WORKFLOW_INPUT");
    expect(caught.message).not.toContain("someone-elses-row");
  });

  it("treats model output that never parses as NO_OBJECT_GENERATED", async () => {
    const txnId = await insertTxn(itemMain, ORG, {
      date: "2026-10-06",
      amount: 300,
      name: "Kiosk",
      pfc: null,
    });

    const caught = await catchAsync(() =>
      runCategorizeWorkflow(context(textMock("definitely not json")), {
        transactionIds: [txnId],
      }),
    );

    expect(caught).toBeInstanceOf(EnvelopeError);
    expect((caught as EnvelopeError).code).toBe("NO_OBJECT_GENERATED");
  });

  it("cannot see a transaction outside the organization", async () => {
    const foreign = await insertTxn(itemOther, OTHER_ORG, {
      date: "2026-10-06",
      amount: 300,
      name: "Elsewhere",
      pfc: null,
    });

    const caught = await catchAsync(() =>
      runCategorizeWorkflow(context(textMock("{}")), {
        transactionIds: [foreign],
      }),
    );

    expect(caught).toBeInstanceOf(WorkflowError);
    expect((caught as WorkflowError).code).toBe("WORKFLOW_NOT_FOUND");
    expect(caught.message).not.toContain(foreign);
  });

  it("refuses an empty id list before any I/O", async () => {
    const { model, state } = countingMock();
    const caught = await catchAsync(() =>
      runCategorizeWorkflow(context(model), { transactionIds: [] }),
    );
    expect((caught as WorkflowError).code).toBe("WORKFLOW_INPUT");
    expect(state.calls).toBe(0);
  });
});

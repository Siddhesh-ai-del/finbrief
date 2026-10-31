/**
 * Ledger-entry workflow (plan Step 4.2): the model PARSES the
 * user's statement into a command (envelope-sanitized alias,
 * positive integer cents, ISO date); the workflow executes it
 * deterministically — counterparty lookup-or-create by exact
 * alias, then the Step 3.1 domain call. The model never picks an
 * idempotency key: the workflow derives it from the caller's
 * requestId, so a redelivered turn replays to the same entry
 * (Steps 1.3/3.1) instead of double-recording a debt. Settlement
 * amounts are translated to the opposing sign IN CODE; the
 * domain's no-double-settlement rule and typed refusals propagate
 * untouched — the workflow never swallows them.
 *
 * The result carries a balance figure with real ledger provenance
 * (capped entry-id sample + exact live-entry rowCount) so the
 * Step 4.1 envelope accepts it in user-facing prose.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { ledgerCounterparties, ledgerEntries } from "../../db/schema/ledger";
import {
  balanceOf,
  createCounterparty,
  recordDebt,
  recordSettlement,
} from "../../ledger/entries";
import { segmentUntrusted } from "../../security/untrusted-text";
import { ledgerEntryCommandSchema } from "../envelope";
import {
  generateStructured,
  requireRequestId,
  type WorkflowContext,
} from "./context";
import type { DraftFigure } from "./figures";

const INSTRUCTIONS = [
  "You parse the user's money statement into a ledger command.",
  "counterpartyAlias is the person named in the statement.",
  "kind is 'debt' when the user lent or is owed,",
  "'settlement' when the user was paid back.",
  "amountCents is the amount named, as a positive integer in cents.",
  "entryDate is the date named in the statement as YYYY-MM-DD;",
  "if none is named, use today's date.",
].join(" ");

export interface LedgerEntryWorkflowResult {
  readonly counterpartyId: string;
  readonly alias: string;
  readonly entry: {
    readonly id: string;
    readonly kind: "debt" | "settlement";
    readonly amountCents: number;
    readonly entryDate: string;
  };
  readonly balanceCents: number;
  readonly figure: DraftFigure;
}

export async function runLedgerEntryWorkflow(
  ctx: WorkflowContext,
  utterance: string,
): Promise<LedgerEntryWorkflowResult> {
  const requestId = requireRequestId(ctx);
  const command = await generateStructured(ctx, {
    schema: ledgerEntryCommandSchema,
    instructions: INSTRUCTIONS,
    prompt: segmentUntrusted("user-statement", utterance),
  });

  const existing = await ctx.db
    .select({ id: ledgerCounterparties.id })
    .from(ledgerCounterparties)
    .where(
      and(
        eq(ledgerCounterparties.organizationId, ctx.organizationId),
        eq(ledgerCounterparties.alias, command.counterpartyAlias),
        isNull(ledgerCounterparties.tombstonedAt),
      ),
    );
  const counterpartyId = existing[0]
    ? existing[0].id
    : (
        await createCounterparty(ctx.db, ctx.organizationId, {
          alias: command.counterpartyAlias,
        })
      ).id;

  // One key per caller-supplied requestId: retries replay, never
  // double-record. The model never sees or chooses the key.
  const idempotencyKey = `agent-ledger-entry:${requestId}`;
  const signedAmountCents =
    command.kind === "settlement" ? -command.amountCents : command.amountCents;
  const entry =
    command.kind === "debt"
      ? await recordDebt(ctx.db, ctx.organizationId, {
          counterpartyId,
          amountCents: signedAmountCents,
          entryDate: command.entryDate,
          idempotencyKey,
        })
      : await recordSettlement(ctx.db, ctx.organizationId, {
          counterpartyId,
          amountCents: signedAmountCents,
          entryDate: command.entryDate,
          idempotencyKey,
        });

  const balanceCents = await balanceOf(
    ctx.db,
    ctx.organizationId,
    counterpartyId,
  );
  const liveEntries = await ctx.db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.organizationId, ctx.organizationId),
        eq(ledgerEntries.counterpartyId, counterpartyId),
        isNull(ledgerEntries.tombstonedAt),
      ),
    );

  const figure: DraftFigure = Object.freeze({
    label: command.counterpartyAlias,
    amountCents: balanceCents,
    sourceRef: [
      Object.freeze({
        kind: "ledger_entry",
        entryIds: [entry.id],
        rowCount: liveEntries[0]?.n ?? 0,
        fromDate: null,
        toDate: null,
      }),
    ],
  });

  return Object.freeze({
    counterpartyId,
    alias: command.counterpartyAlias,
    entry: Object.freeze({
      id: entry.id,
      kind: entry.kind,
      amountCents: entry.amountCents,
      entryDate: entry.entryDate,
    }),
    balanceCents,
    figure,
  });
}

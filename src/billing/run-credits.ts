/**
 * Run-credit accounting (plan Step 0.4, §6.3-13): flat subscription +
 * included run credits + top-up.
 *
 * Every balance change is a transactional pair — account upsert plus
 * an append-only entry carrying `balance_after` — so the ledger
 * self-reconciles: the newest entry's balance_after must equal the
 * account balance (asserted in tests/billing/run-credits.test.ts).
 *
 * `debit` only succeeds when the account holds at least `runCost`
 * (single conditional UPDATE — atomic check-and-spend), so an empty
 * or unknown tenant is refused with `null` and nothing is written.
 * Spending the balance down to exactly zero is allowed.
 *
 * Amounts are positive integers; anything else throws RangeError
 * before a transaction is even opened (input validated at the edge).
 */
import { and, eq, gte, sql } from "drizzle-orm";
import { runCreditAccounts, runCreditEntries } from "../db/schema/billing";
import type { Db } from "../db/tenancy";

/** The transaction handle type underlying the pool-backed Db. */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Anything the ledger can run on: a Db, or an already-open transaction. */
export type LedgerRunner = Db | Tx;

export type CreditKind = "grant" | "topup" | "debit";

function requirePositiveInt(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive integer, got ${value}`);
  }
}

/** Upsert the tenant's balance upward and append the matching entry. */
async function credit(
  runner: LedgerRunner,
  organizationId: string,
  amount: number,
  kind: Exclude<CreditKind, "debit">,
): Promise<number> {
  requirePositiveInt(amount, "amount");
  return runner.transaction(async (tx) => {
    const rows = await tx
      .insert(runCreditAccounts)
      .values({ organizationId, balance: amount })
      .onConflictDoUpdate({
        target: runCreditAccounts.organizationId,
        set: {
          balance: sql`${runCreditAccounts.balance} + ${amount}`,
          updatedAt: new Date(),
        },
      })
      .returning({ balance: runCreditAccounts.balance });
    const balance = rows[0]?.balance;
    if (balance === undefined) {
      throw new Error("credit upsert returned no row");
    }
    await tx.insert(runCreditEntries).values({
      organizationId,
      kind,
      amount,
      balanceAfter: balance,
    });
    return balance;
  });
}

/** Add purchased credits. Returns the new balance. */
export async function topUp(
  runner: LedgerRunner,
  organizationId: string,
  amount: number,
): Promise<number> {
  return credit(runner, organizationId, amount, "topup");
}

/** Grant the subscription's included credits on activation. */
export async function grantIncluded(
  runner: LedgerRunner,
  organizationId: string,
  amount: number,
): Promise<number> {
  return credit(runner, organizationId, amount, "grant");
}

/**
 * Spend `runCost` credits. Returns the new balance, or `null` when
 * the tenant has no account or insufficient balance (refused, with
 * no entry written).
 */
export async function debit(
  runner: LedgerRunner,
  organizationId: string,
  runCost: number,
): Promise<number | null> {
  requirePositiveInt(runCost, "runCost");
  return runner.transaction(async (tx) => {
    const rows = await tx
      .update(runCreditAccounts)
      .set({
        balance: sql`${runCreditAccounts.balance} - ${runCost}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(runCreditAccounts.organizationId, organizationId),
          gte(runCreditAccounts.balance, runCost),
        ),
      )
      .returning({ balance: runCreditAccounts.balance });
    const row = rows[0];
    if (!row) return null;
    await tx.insert(runCreditEntries).values({
      organizationId,
      kind: "debit",
      amount: runCost,
      balanceAfter: row.balance,
    });
    return row.balance;
  });
}

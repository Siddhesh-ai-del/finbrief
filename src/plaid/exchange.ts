/**
 * Public-token exchange → encrypted item storage (plan Step 1.2).
 *
 * The flow: exchange the client's `public_token` upstream (network
 * happens OUTSIDE any transaction), encrypt both returned credentials,
 * then claim the item in one transaction — `ON CONFLICT DO NOTHING`
 * on the keyed index, followed by a read-back that either returns
 * the caller's own row (idempotent re-exchange) or refuses a row
 * another organization already holds.
 *
 * The return type is deliberately a DTO with no credential fields:
 * plaintext exists only inside the upstream response locals and the
 * ciphertext columns (the plan's negative test is pinned in
 * tests/plaid/exchange.test.ts).
 */
import { eq } from "drizzle-orm";
import type {
  ItemPublicTokenExchangeRequest,
  ItemPublicTokenExchangeResponse,
} from "plaid";
import { plaidItems } from "../db/schema/plaid";
import type { Db } from "../db/tenancy";
import type { SecretBox } from "./secrets";

/** The transaction handle type underlying the pool-backed Db. */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Anything the exchange can run on: a Db, or an open transaction. */
export type ExchangeRunner = Db | Tx;

/** The subset of Plaid's client this flow uses (mockable offline). */
export interface PublicTokenExchangeClient {
  itemPublicTokenExchange(
    params: ItemPublicTokenExchangeRequest,
  ): Promise<{ data: ItemPublicTokenExchangeResponse }>;
}

/** Everything callers ever receive — no credential surface. */
export interface StoredPlaidItem {
  id: string;
  organizationId: string;
  createdAt: Date;
}

export class ExchangeInputError extends Error {}
export class ExchangeUpstreamError extends Error {}
export class ItemAlreadyLinkedError extends Error {}

export interface ExchangeInput {
  organizationId: string;
  publicToken: string;
}

export interface ItemExchangeOptions {
  client: PublicTokenExchangeClient;
  secrets: SecretBox;
}

export function createItemExchange(options: ItemExchangeOptions) {
  return {
    async exchange(
      runner: ExchangeRunner,
      input: ExchangeInput,
    ): Promise<StoredPlaidItem> {
      if (!input.organizationId) {
        throw new ExchangeInputError("organizationId is required");
      }
      const publicToken = input.publicToken?.trim() ?? "";
      if (!publicToken) {
        throw new ExchangeInputError("publicToken is required");
      }

      const upstream = await options.client.itemPublicTokenExchange({
        public_token: publicToken,
      });
      const accessToken = upstream.data.access_token;
      const itemId = upstream.data.item_id;
      if (!accessToken || !itemId) {
        throw new ExchangeUpstreamError(
          "Plaid exchange returned an incomplete payload",
        );
      }

      const itemIdCiphertext = options.secrets.encrypt(itemId);
      const accessTokenCiphertext = options.secrets.encrypt(accessToken);
      const itemIdIndex = options.secrets.index(itemId);

      return runner.transaction(async (tx) => {
        const inserted = await tx
          .insert(plaidItems)
          .values({
            organizationId: input.organizationId,
            itemIdCiphertext,
            accessTokenCiphertext,
            itemIdIndex,
          })
          .onConflictDoNothing({ target: plaidItems.itemIdIndex })
          .returning({
            id: plaidItems.id,
            organizationId: plaidItems.organizationId,
            createdAt: plaidItems.createdAt,
          });
        const claimed = inserted[0];
        if (claimed) return claimed;

        const rows = await tx
          .select({
            id: plaidItems.id,
            organizationId: plaidItems.organizationId,
            createdAt: plaidItems.createdAt,
          })
          .from(plaidItems)
          .where(eq(plaidItems.itemIdIndex, itemIdIndex))
          .limit(1);
        const existing = rows[0];
        if (!existing) {
          // Conflict claimed but the row vanished (tenant cascade
          // racing this transaction) — refuse rather than guess.
          throw new ExchangeUpstreamError(
            "conflicting item row vanished during exchange",
          );
        }
        if (existing.organizationId !== input.organizationId) {
          // Static message: never echo the item it refers to.
          throw new ItemAlreadyLinkedError(
            "this bank connection is already linked to another workspace",
          );
        }
        return existing;
      });
    },
  };
}

export type ItemExchange = ReturnType<typeof createItemExchange>;

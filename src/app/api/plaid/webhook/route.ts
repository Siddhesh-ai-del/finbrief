/**
 * POST /api/plaid/webhook — Plaid's webhook receiver (plan Step 1.4).
 *
 * Order of operations is the security design:
 * 1. Read the RAW body (Plaid's signature hashes the exact bytes —
 *    parsing first would re-serialize and break the hash).
 * 2. Verify the Plaid-Verification JWT end to end (ES256, kid →
 *    cached JWK, 5-min replay window, body hash). Any failure → one
 *    uniform 401 with no detail, before any DB or upstream work.
 * 3. Parse + validate the payload (unknown JSON keys are stripped;
 *    every field the state machine reads is declared).
 * 4. Dispatch to the state machine and answer 200. Handler outcomes
 *    are logged without payload contents; an unexpected failure
 *    returns 500 so Plaid's retry policy re-delivers it.
 *
 * There is no session auth here by design — Plaid is not a browser.
 */
import { z } from "zod";
import type { JWK } from "jose";
import { getPool } from "@/db/pool";
import { createDb } from "@/db/tenancy";
import { createPlaidClientFromEnv } from "@/plaid/link-token";
import { createSecretBoxFromEnv } from "@/plaid/secrets";
import { createTransactionSync } from "@/plaid/sync";
import { createWebhookHandler } from "@/plaid/webhooks/handler";
import { verifyPlaidWebhook } from "@/plaid/webhooks/verify";

const pool = getPool();
const db = createDb(pool);
const plaid = createPlaidClientFromEnv();
const secrets = createSecretBoxFromEnv();

/** Per-process JWK memo, keyed by kid; cleared on churn (rotation). */
const keyCache = new Map<string, Promise<JWK | null>>();
const KEY_CACHE_LIMIT = 100;

async function fetchKey(kid: string): Promise<JWK | null> {
  const cached = keyCache.get(kid);
  if (cached) {
    return cached;
  }
  const pending = plaid
    .webhookVerificationKeyGet({ key_id: kid })
    .then((response) => response.data.key as unknown as JWK)
    .catch(() => null);
  if (keyCache.size >= KEY_CACHE_LIMIT) {
    keyCache.clear();
  }
  keyCache.set(kid, pending);
  return pending;
}

const sync = createTransactionSync({ client: plaid, secrets });
const handler = createWebhookHandler({
  secrets,
  syncItem: (itemId) => sync.syncItem(db, itemId),
  // The delivery channel wires in with the notification step; the
  // transition itself is what this step pins (see handler doc).
  onStale: undefined,
});

const webhookSchema = z.object({
  webhook_type: z.string().min(1),
  webhook_code: z.string().min(1),
  item_id: z.string().min(1),
  environment: z.string().optional(),
  error: z
    .object({
      error_code: z.string().optional(),
      error_message: z.string().optional(),
      display_message: z.string().nullish(),
    })
    .nullish(),
  removed_transactions: z.array(z.string()).optional(),
});

export async function POST(request: Request): Promise<Response> {
  const raw = await request.text();

  const verified = await verifyPlaidWebhook(
    { fetchKey },
    raw,
    request.headers.get("plaid-verification"),
  );
  if (!verified) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }
  const parsed = webhookSchema.safeParse(json);
  if (!parsed.success) {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }

  // The outcome is Plaid-invisible (they only check status codes);
  // transitions are observable in item status, which tests assert.
  const outcome = await handler.handle(db, parsed.data);
  return Response.json({ received: true, outcome });
}

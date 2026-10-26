/**
 * POST /api/plaid/exchange — exchanges a Link `public_token` and
 * persists the item's credentials encrypted (plan Step 1.2).
 *
 * Auth mirrors /api/plaid/link: a Better Auth session cookie plus an
 * active organization; the organization id scopes the stored item.
 * The response carries only our row id — the upstream
 * `access_token`/`item_id` never cross this boundary in either
 * direction.
 */
import { z } from "zod";
import { createAuth } from "@/auth/auth";
import { getPool } from "@/db/pool";
import { createDb } from "@/db/tenancy";
import { ItemAlreadyLinkedError, createItemExchange } from "@/plaid/exchange";
import { createPlaidClientFromEnv } from "@/plaid/link-token";
import { createSecretBoxFromEnv } from "@/plaid/secrets";

const pool = getPool();
const auth = createAuth(pool);
const db = createDb(pool);
const items = createItemExchange({
  client: createPlaidClientFromEnv(),
  secrets: createSecretBoxFromEnv(),
});

const bodySchema = z.object({ publicToken: z.string().trim().min(1) });

export async function POST(request: Request): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const tenantId = session.session.activeOrganizationId;
  if (!tenantId) {
    return Response.json({ error: "no_active_organization" }, { status: 403 });
  }

  const raw: unknown = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }

  try {
    const item = await items.exchange(db, {
      organizationId: tenantId,
      publicToken: parsed.data.publicToken,
    });
    return Response.json({ id: item.id });
  } catch (error) {
    if (error instanceof ItemAlreadyLinkedError) {
      return Response.json({ error: "item_already_linked" }, { status: 409 });
    }
    throw error;
  }
}

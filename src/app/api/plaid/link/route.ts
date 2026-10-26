/**
 * POST /api/plaid/link — mints a link_token for the caller's active
 * organization (plan Step 1.1).
 *
 * Auth is a Better Auth session cookie plus an active organization;
 * the organization id becomes `client_user_id`, so every Link session
 * is bound to one tenant's session metadata.
 *
 * Update mode is rejected at the body schema until Step 1.2 lands
 * item credential storage — it needs a stored access token, and
 * accepting one through the browser would expose the credential. The
 * schema rejects unknown modes explicitly rather than ignoring them.
 */
import { z } from "zod";
import { createAuth } from "@/auth/auth";
import { getPool } from "@/db/pool";
import {
  createLinkTokenService,
  createPlaidClientFromEnv,
} from "@/plaid/link-token";

const auth = createAuth(getPool());
const linkTokens = createLinkTokenService({
  client: createPlaidClientFromEnv(),
});

const bodySchema = z.object({ mode: z.literal("initial").optional() });

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

  const issued = await linkTokens.getLinkToken({
    tenantId,
    mode: "initial",
  });
  return Response.json({
    linkToken: issued.linkToken,
    mode: issued.mode,
    expiresAt: issued.expiresAt.toISOString(),
  });
}

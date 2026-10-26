/**
 * link_token lifecycle (plan Step 1.1).
 *
 * Plaid mints link_tokens server-side with a fixed lifetime: 4 hours
 * for initial Link and 30 minutes for update mode (their documented
 * defaults — see LinkTokenCreateResponse.expiration). We mirror those
 * TTLs into a client-side `expiresAt` and **never serve a cached
 * token past it** — an expired cache entry is replaced by a fresh
 * upstream create, so a caller can never receive a dead token.
 *
 * Reuse inside the window is deliberate (one upstream create per
 * tenant/mode window) and strictly tenant-scoped: the cache key
 * contains the tenant, so no tenant can be handed another tenant's
 * token. Update-mode keys are keyed by a digest of the item's access
 * token, so the raw credential never becomes a key in any structure
 * that might be inspected. The store is per-process memory: on
 * serverless that degrades to minting more often, never to crossing
 * tenants.
 *
 * The client is constructed from env only (sandbox by default);
 * no credential is ever literal in code.
 */
import { createHash } from "node:crypto";
import { Configuration, CountryCode, PlaidApi, Products } from "plaid";
import type { LinkTokenCreateRequest } from "plaid";

export const INITIAL_TTL_MS = 4 * 60 * 60 * 1000;
export const UPDATE_TTL_MS = 30 * 60 * 1000;

export type LinkMode = "initial" | "update";

/** The subset of Plaid's client this service uses (mockable offline). */
export interface PlaidLinkClient {
  linkTokenCreate(
    params: LinkTokenCreateRequest,
  ): Promise<{ data: { link_token: string } }>;
}

export interface IssuedLinkToken {
  linkToken: string;
  mode: LinkMode;
  tenantId: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface LinkTokenStore {
  get(key: string): IssuedLinkToken | null;
  set(key: string, token: IssuedLinkToken): void;
}

export function createMemoryLinkTokenStore(): LinkTokenStore {
  const tokens = new Map<string, IssuedLinkToken>();
  return {
    get: (key) => tokens.get(key) ?? null,
    set: (key, token) => {
      tokens.set(key, token);
    },
  };
}

/** Input rejected before any upstream call happens. */
export class LinkTokenInputError extends Error {}

export interface GetLinkTokenInput {
  tenantId: string;
  mode: LinkMode;
  /** Required for update mode; never sent over the public route. */
  accessToken?: string;
}

export interface LinkTokenServiceOptions {
  client: PlaidLinkClient;
  store?: LinkTokenStore;
  now?: () => Date;
}

function cacheKey(input: GetLinkTokenInput): string {
  if (input.mode === "initial") return `${input.tenantId}:initial`;
  const digest = createHash("sha256")
    .update(input.accessToken ?? "")
    .digest("hex")
    .slice(0, 16);
  return `${input.tenantId}:update:${digest}`;
}

function buildRequest(input: GetLinkTokenInput): LinkTokenCreateRequest {
  const base = {
    client_name: "finbrief",
    country_codes: [CountryCode.Us],
    language: "en",
    user: { client_user_id: input.tenantId },
  };
  if (input.mode === "update") {
    // Validated non-empty in getLinkToken before this is called.
    return { ...base, access_token: input.accessToken };
  }
  return { ...base, products: [Products.Transactions] };
}

export function createLinkTokenService(options: LinkTokenServiceOptions) {
  const store = options.store ?? createMemoryLinkTokenStore();
  const now = options.now ?? (() => new Date());

  return {
    async getLinkToken(input: GetLinkTokenInput): Promise<IssuedLinkToken> {
      if (!input.tenantId) {
        throw new LinkTokenInputError("tenantId is required");
      }
      if (input.mode === "update" && !input.accessToken) {
        throw new LinkTokenInputError("update mode requires an access token");
      }

      const key = cacheKey(input);
      const cached = store.get(key);
      const at = now();
      if (cached && cached.expiresAt.getTime() > at.getTime()) {
        return cached;
      }

      const response = await options.client.linkTokenCreate(
        buildRequest(input),
      );
      const issued: IssuedLinkToken = {
        linkToken: response.data.link_token,
        mode: input.mode,
        tenantId: input.tenantId,
        createdAt: at,
        expiresAt: new Date(
          at.getTime() +
            (input.mode === "initial" ? INITIAL_TTL_MS : UPDATE_TTL_MS),
        ),
      };
      store.set(key, issued);
      return issued;
    },
  };
}

export type LinkTokenService = ReturnType<typeof createLinkTokenService>;

const PLAID_ENVIRONMENTS = ["sandbox", "production"] as const;

/**
 * Build the Plaid API client from env. Throws loudly on missing or
 * malformed configuration — a misconfigured route should fail at
 * import, not silently issue requests to the wrong host.
 */
export function createPlaidClientFromEnv(
  env: Record<string, string | undefined> = process.env,
): PlaidLinkClient {
  const clientEnv = env.PLAID_ENV ?? "sandbox";
  if (!(PLAID_ENVIRONMENTS as readonly string[]).includes(clientEnv)) {
    throw new Error(
      `PLAID_ENV must be sandbox or production, got "${clientEnv}"`,
    );
  }
  const clientId = env.PLAID_CLIENT_ID;
  const secret = env.PLAID_SECRET;
  if (!clientId || !secret) {
    throw new Error("PLAID_CLIENT_ID and PLAID_SECRET must be set");
  }
  return new PlaidApi(
    new Configuration({
      basePath: `https://${clientEnv}.plaid.com`,
      baseOptions: {
        headers: { "Plaid-Client-Id": clientId, "Plaid-Secret": secret },
      },
    }),
  );
}

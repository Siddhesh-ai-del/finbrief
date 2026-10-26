/**
 * Step 1.2 — POST /api/plaid/exchange route wiring: session auth,
 * active organization requirement, body validation, idempotent
 * response, and the plan's negative assertion that no credential
 * material ever appears in an API response.
 *
 * The plaid SDK is vi.mock'd (construction only, no network), and
 * env is set before the dynamic route import below.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createScratchDatabase } from "../helpers/scratch-db";
import { createAuth } from "../../src/auth/auth";
import type { Auth } from "../../src/auth/auth";
import { closePool } from "../../src/db/pool";
import { ENCRYPTION_KEY_BYTES, createSecretBox } from "../../src/plaid/secrets";
import type * as ExchangeRoute from "../../src/app/api/plaid/exchange/route";

const mocks = vi.hoisted(() => ({ itemPublicTokenExchange: vi.fn() }));

vi.mock("plaid", () => ({
  Products: { Transactions: "transactions" },
  CountryCode: { Us: "US" },
  Configuration: class Configuration {
    constructor() {
      /* mocked — no client config needed offline */
    }
  },
  PlaidApi: class PlaidApi {
    itemPublicTokenExchange = mocks.itemPublicTokenExchange;
  },
}));

const DB = "finbrief_plaid_exchange_route_test";
const ENDPOINT = "http://localhost/api/plaid/exchange";
/** Shared with the route's own auth instance via env — test-mode key. */
const SHARED_SIGNING_KEY = "shared-signing-key-for-exchange-tests";
const LOGIN_FIXTURE = "password1234";
const PLAINTEXT_ITEM = "plaid-item-identifier-0001";
const PLAINTEXT_ACCESS = "plaid-access-credential-0001";
const PUBLIC_TOKEN_FIXTURE = "public-token-fixture-0001";
const ROOT_KEY = randomBytes(ENCRYPTION_KEY_BYTES).toString("base64");

let scratch: Awaited<ReturnType<typeof createScratchDatabase>>;
let route: typeof ExchangeRoute;
let auth: Auth;
let aliceCookie: string;
let bobCookie: string;
let carolCookie: string;
let aliceOrgId: string;
let carolOrgId: string;

async function signUp(email: string, name: string): Promise<void> {
  await auth.api.signUpEmail({
    body: { email, name, password: LOGIN_FIXTURE },
  });
}

async function signIn(email: string): Promise<string> {
  const res = await auth.api.signInEmail({
    body: { email, password: LOGIN_FIXTURE },
    returnHeaders: true,
  });
  return res.headers.get("set-cookie")?.split(";")[0] ?? "";
}

async function joinOrg(
  cookie: string,
  name: string,
  slug: string,
): Promise<string> {
  const org = await auth.api.createOrganization({
    headers: new Headers({ cookie }),
    body: { name, slug },
    returnHeaders: true,
  });
  return ((org.response ?? {}) as { id?: string }).id ?? "";
}

const post = async (cookie: string | undefined, body: string) => {
  const request = new Request(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body,
  });
  return route.POST(request);
};

beforeAll(async () => {
  scratch = await createScratchDatabase(DB);
  await scratch.migrate();

  const scratchUrl = new URL(process.env.TEST_DATABASE_URL as string);
  scratchUrl.pathname = `/${DB}`;
  process.env["DATABASE_URL"] = scratchUrl.toString();
  process.env["BETTER_AUTH_SECRET"] = SHARED_SIGNING_KEY;
  process.env.PLAID_CLIENT_ID = "test-client-id";
  process.env["PLAID_SECRET"] = "test-plaid-credential";
  process.env.PLAID_ENV = "sandbox";
  process.env.ENCRYPTION_KEY = ROOT_KEY;

  mocks.itemPublicTokenExchange.mockResolvedValue({
    data: {
      access_token: PLAINTEXT_ACCESS,
      item_id: PLAINTEXT_ITEM,
      request_id: "req-exchange-1",
    },
  });

  route = await import("../../src/app/api/plaid/exchange/route");
  auth = createAuth(scratch.pool, {
    secret: SHARED_SIGNING_KEY,
    baseURL: "http://localhost:3000",
  });

  await signUp("exchange-alice@example.com", "Alice");
  aliceCookie = await signIn("exchange-alice@example.com");
  aliceOrgId = await joinOrg(aliceCookie, "Alice Org", "exchange-alice-org");

  await signUp("exchange-bob@example.com", "Bob");
  bobCookie = await signIn("exchange-bob@example.com");

  await signUp("exchange-carol@example.com", "Carol");
  carolCookie = await signIn("exchange-carol@example.com");
  carolOrgId = await joinOrg(carolCookie, "Carol Org", "exchange-carol-org");
}, 60_000);

afterAll(async () => {
  // Close the route's shared pool first — destroy() cannot drop a
  // database that still has a live connection.
  await closePool();
  await scratch?.destroy();
});

describe("POST /api/plaid/exchange", () => {
  it("stores the item encrypted under the caller's organization", async () => {
    const response = await post(
      aliceCookie,
      JSON.stringify({ publicToken: PUBLIC_TOKEN_FIXTURE }),
    );

    expect(response.status).toBe(200);
    const text = await response.text();
    const body = JSON.parse(text) as { id: string };
    expect(typeof body.id).toBe("string");

    // The plan's negative test: no credential in the API response.
    expect(text).not.toContain(PLAINTEXT_ITEM);
    expect(text).not.toContain(PLAINTEXT_ACCESS);

    const rows = await scratch.pool.query(
      "SELECT * FROM plaid_items WHERE item_id_index = $1",
      [createSecretBox(ROOT_KEY).index(PLAINTEXT_ITEM)],
    );
    expect(rows.rowCount).toBe(1);
    const row = rows.rows[0] as Record<string, string>;
    expect(row.organization_id).toBe(aliceOrgId);
    expect(row.access_token_ciphertext).not.toContain(PLAINTEXT_ACCESS);
    expect(row.item_id_ciphertext).not.toContain(PLAINTEXT_ITEM);
  });

  it("is idempotent for a repeat of the same exchange", async () => {
    const first = await post(
      aliceCookie,
      JSON.stringify({ publicToken: PUBLIC_TOKEN_FIXTURE }),
    );
    const firstBody = (await first.json()) as { id: string };
    const second = await post(
      aliceCookie,
      JSON.stringify({ publicToken: PUBLIC_TOKEN_FIXTURE }),
    );
    const secondBody = (await second.json()) as { id: string };

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(secondBody.id).toBe(firstBody.id);
    const rows = await scratch.pool.query(
      "SELECT count(*)::int AS n FROM plaid_items WHERE organization_id = $1",
      [aliceOrgId],
    );
    expect((rows.rows[0] as { n: number }).n).toBe(1);
  });

  it("answers 409 when another organization already holds the item", async () => {
    const response = await post(
      carolCookie,
      JSON.stringify({ publicToken: PUBLIC_TOKEN_FIXTURE }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "item_already_linked" });
    const rows = await scratch.pool.query(
      "SELECT count(*)::int AS n FROM plaid_items WHERE organization_id = $1",
      [carolOrgId],
    );
    expect((rows.rows[0] as { n: number }).n).toBe(0);
  });

  it("rejects requests without a session cookie", async () => {
    const response = await post(
      undefined,
      JSON.stringify({ publicToken: PUBLIC_TOKEN_FIXTURE }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(mocks.itemPublicTokenExchange).not.toHaveBeenCalled();
  });

  it("rejects sessions that have no active organization", async () => {
    const response = await post(
      bobCookie,
      JSON.stringify({ publicToken: PUBLIC_TOKEN_FIXTURE }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "no_active_organization" });
    expect(mocks.itemPublicTokenExchange).not.toHaveBeenCalled();
  });

  const badBodies: { name: string; body: string }[] = [
    { name: "a JSON string", body: JSON.stringify("not-an-object") },
    { name: "a missing publicToken", body: JSON.stringify({}) },
    { name: "an empty publicToken", body: JSON.stringify({ publicToken: "" }) },
    {
      name: "a whitespace publicToken",
      body: JSON.stringify({ publicToken: "   " }),
    },
    { name: "malformed JSON", body: "{not json" },
  ];
  for (const testCase of badBodies) {
    it(`rejects ${testCase.name} with 400`, async () => {
      const response = await post(aliceCookie, testCase.body);

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_body" });
      expect(mocks.itemPublicTokenExchange).not.toHaveBeenCalled();
    });
  }
});

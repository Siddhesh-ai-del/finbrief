/**
 * Step 1.1 — POST /api/plaid/link route wiring: session auth, active
 * organization requirement, body validation, tenant metadata flow,
 * and response contract. The plaid SDK is vi.mock'd — construction
 * only, no network.
 *
 * The route module reads env (DATABASE_URL, auth secret, Plaid
 * credentials) at import time, so env is set and the scratch database
 * exists before the dynamic import below.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createScratchDatabase } from "../helpers/scratch-db";
import { createAuth } from "../../src/auth/auth";
import type { Auth } from "../../src/auth/auth";
import { closePool } from "../../src/db/pool";
import type * as LinkRoute from "../../src/app/api/plaid/link/route";

const mocks = vi.hoisted(() => ({ linkTokenCreate: vi.fn() }));

vi.mock("plaid", () => ({
  Products: { Transactions: "transactions" },
  CountryCode: { Us: "US" },
  Configuration: class Configuration {
    constructor() {
      /* mocked — no client config needed offline */
    }
  },
  PlaidApi: class PlaidApi {
    linkTokenCreate = mocks.linkTokenCreate;
  },
}));

const DB = "finbrief_plaid_route_test";
const ENDPOINT = "http://localhost/api/plaid/link";
/** Shared with the route's own auth instance via env — test-mode key. */
const SHARED_SIGNING_KEY = "shared-signing-key-for-route-tests";
const LOGIN_FIXTURE = "password1234";
const LINK_TOKEN_FIXTURE = "link-from-mock";

let scratch: Awaited<ReturnType<typeof createScratchDatabase>>;
let route: typeof LinkRoute;
let auth: Auth;
let aliceCookie: string;
let bobCookie: string;
let aliceOrgId: string;

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

  mocks.linkTokenCreate.mockResolvedValue({
    data: { link_token: LINK_TOKEN_FIXTURE },
  });

  route = await import("../../src/app/api/plaid/link/route");
  auth = createAuth(scratch.pool, {
    secret: SHARED_SIGNING_KEY,
    baseURL: "http://localhost:3000",
  });

  await signUp("route-alice@example.com", "Alice");
  aliceCookie = await signIn("route-alice@example.com");
  const org = await auth.api.createOrganization({
    headers: new Headers({ cookie: aliceCookie }),
    body: { name: "Route Org", slug: "route-org" },
    returnHeaders: true,
  });
  aliceOrgId = ((org.response ?? {}) as { id?: string }).id ?? "";
  expect(aliceOrgId).not.toBe("");

  await signUp("route-bob@example.com", "Bob");
  bobCookie = await signIn("route-bob@example.com");
}, 60_000);

afterAll(async () => {
  // Close the route's shared pool first — destroy() cannot drop a
  // database that still has a live connection.
  await closePool();
  await scratch?.destroy();
});

describe("POST /api/plaid/link", () => {
  it("mints a token scoped to the caller's active organization", async () => {
    const response = await post(aliceCookie, "{}");

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      linkToken: string;
      mode: string;
      expiresAt: string;
    };
    expect(body.linkToken).toBe(LINK_TOKEN_FIXTURE);
    expect(body.mode).toBe("initial");
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());

    expect(mocks.linkTokenCreate).toHaveBeenCalledTimes(1);
    const params = (
      mocks.linkTokenCreate.mock.calls[0] as [
        { user: { client_user_id: string }; products: string[] },
      ]
    )[0];
    expect(params.user.client_user_id).toBe(aliceOrgId);
    expect(params.products).toEqual(["transactions"]);
  });

  it("reuses the cached token across requests (no new upstream call)", async () => {
    // clearMocks wipes vi.fn call state between tests, so 0 calls here
    // proves THIS request hit the service's cache instead of Plaid.
    const response = await post(aliceCookie, "{}");

    expect(response.status).toBe(200);
    const body = (await response.json()) as { linkToken: string };
    expect(body.linkToken).toBe(LINK_TOKEN_FIXTURE);
    expect(mocks.linkTokenCreate).not.toHaveBeenCalled();
  });

  it("rejects requests without a session cookie", async () => {
    const response = await post(undefined, "{}");

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(mocks.linkTokenCreate).not.toHaveBeenCalled();
  });

  it("rejects sessions that have no active organization", async () => {
    const response = await post(bobCookie, "{}");

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "no_active_organization" });
    expect(mocks.linkTokenCreate).not.toHaveBeenCalled();
  });

  it("rejects update mode until item storage lands in Step 1.2", async () => {
    const response = await post(
      aliceCookie,
      JSON.stringify({ mode: "update" }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_body" });
    expect(mocks.linkTokenCreate).not.toHaveBeenCalled();
  });

  it("rejects unknown modes", async () => {
    const response = await post(aliceCookie, JSON.stringify({ mode: "bogus" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_body" });
  });

  it("rejects malformed JSON bodies", async () => {
    const response = await post(aliceCookie, "{not json");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_body" });
  });
});

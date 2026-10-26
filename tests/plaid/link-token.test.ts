/**
 * Step 1.1 — link_token lifecycle against a structural mock client
 * and an injected clock (no network, no real Plaid account).
 *
 * The plan's contract: 4h initial TTL, 30min update-mode TTL,
 * per-tenant session metadata, and **no link_token reuse after
 * expiry** — all three pinned below, plus tenant/mode isolation of
 * the cache.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { LinkTokenCreateRequest } from "plaid";
import {
  INITIAL_TTL_MS,
  UPDATE_TTL_MS,
  LinkTokenInputError,
  createLinkTokenService,
  createMemoryLinkTokenStore,
  createPlaidClientFromEnv,
  type GetLinkTokenInput,
  type PlaidLinkClient,
} from "../../src/plaid/link-token";

/** Test-mode item credential fixture — never a real token. */
const ITEM_FIXTURE = "plaid-item-fixture-0001";
const TENANT = "org_link_1";

interface MockClient {
  client: PlaidLinkClient;
  calls: LinkTokenCreateRequest[];
}

function createMockClient(): MockClient {
  const calls: LinkTokenCreateRequest[] = [];
  let sequence = 0;
  return {
    calls,
    client: {
      linkTokenCreate: async (params) => {
        calls.push(params);
        sequence += 1;
        return { data: { link_token: `lt-${sequence}` } };
      },
    },
  };
}

let mock: MockClient;
let store: ReturnType<typeof createMemoryLinkTokenStore>;
let clock: Date;
const now = () => clock;
const advanceMinutes = (minutes: number) => {
  clock = new Date(clock.getTime() + minutes * 60_000);
};
const service = () =>
  createLinkTokenService({ client: mock.client, store, now });

const getInitial = () =>
  service().getLinkToken({ tenantId: TENANT, mode: "initial" });
const getUpdate = () =>
  service().getLinkToken({
    tenantId: TENANT,
    mode: "update",
    accessToken: ITEM_FIXTURE,
  });

beforeEach(() => {
  mock = createMockClient();
  store = createMemoryLinkTokenStore();
  clock = new Date("2026-01-01T00:00:00.000Z");
});

describe("link_token creation", () => {
  it("creates an initial token with per-tenant session metadata", async () => {
    const issued = await getInitial();

    expect(issued.linkToken).toBe("lt-1");
    expect(issued.mode).toBe("initial");
    expect(issued.tenantId).toBe(TENANT);
    expect(issued.expiresAt.getTime() - issued.createdAt.getTime()).toBe(
      INITIAL_TTL_MS,
    );
    expect(INITIAL_TTL_MS).toBe(4 * 60 * 60 * 1000);

    expect(mock.calls).toHaveLength(1);
    const request = mock.calls[0];
    expect(request?.user?.client_user_id).toBe(TENANT);
    expect(request?.client_name).toBe("finbrief");
    expect(request?.products).toEqual(["transactions"]);
    expect(request?.country_codes).toEqual(["US"]);
    expect(request?.language).toBe("en");
    expect(request?.access_token).toBeUndefined();
  });

  it("reuses the cached token while it is still fresh", async () => {
    advanceMinutes(239);
    const first = await getInitial();
    const second = await getInitial();

    expect(second.linkToken).toBe(first.linkToken);
    expect(mock.calls).toHaveLength(1);
  });

  it("never reuses an expired token — a fresh create replaces it", async () => {
    const first = await getInitial();
    advanceMinutes(240);
    const second = await getInitial();

    expect(second.linkToken).toBe("lt-2");
    expect(second.linkToken).not.toBe(first.linkToken);
    expect(mock.calls).toHaveLength(2);
    expect(second.expiresAt.getTime()).toBeGreaterThan(
      first.expiresAt.getTime(),
    );
  });
});

describe("update mode", () => {
  it("issues a 30-minute token carrying the item's access token", async () => {
    const issued = await getUpdate();

    expect(issued.mode).toBe("update");
    expect(issued.expiresAt.getTime() - issued.createdAt.getTime()).toBe(
      UPDATE_TTL_MS,
    );
    expect(UPDATE_TTL_MS).toBe(30 * 60 * 1000);

    const request = mock.calls[0];
    expect(request?.access_token).toBe(ITEM_FIXTURE);
    expect(request?.products).toBeUndefined();
    expect(request?.user?.client_user_id).toBe(TENANT);
  });

  it("reuses inside 30 minutes, recreates after", async () => {
    const fresh = await getUpdate();
    advanceMinutes(29);
    const reused = await getUpdate();
    advanceMinutes(2);
    const expired = await getUpdate();

    expect(fresh.linkToken).toBe("lt-1");
    expect(reused.linkToken).toBe("lt-1");
    expect(expired.linkToken).toBe("lt-2");
    expect(mock.calls).toHaveLength(2);
  });

  it("keeps initial and update caches separate for one tenant", async () => {
    await getInitial();
    await getUpdate();

    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[0]?.products).toEqual(["transactions"]);
    expect(mock.calls[1]?.access_token).toBe(ITEM_FIXTURE);
  });
});

describe("tenant isolation", () => {
  it("never serves one tenant's cached token to another", async () => {
    const mine = await getInitial();
    const theirs = await service().getLinkToken({
      tenantId: "org_link_2",
      mode: "initial",
    });

    expect(theirs.linkToken).toBe("lt-2");
    expect(theirs.linkToken).not.toBe(mine.linkToken);
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[1]?.user?.client_user_id).toBe("org_link_2");
  });
});

describe("input validation (table-driven)", () => {
  const cases: { name: string; input: GetLinkTokenInput }[] = [
    {
      name: "update mode without an access token",
      input: { tenantId: TENANT, mode: "update" },
    },
    { name: "empty tenant id", input: { tenantId: "", mode: "initial" } },
  ];

  for (const testCase of cases) {
    it(`rejects ${testCase.name} before any upstream call`, async () => {
      await expect(service().getLinkToken(testCase.input)).rejects.toThrow(
        LinkTokenInputError,
      );
      expect(mock.calls).toHaveLength(0);
    });
  }
});

describe("client factory (env-driven)", () => {
  const CLIENT_ID = "test-client-id";
  /** Test-mode credential fixture — never a real value. */
  const CREDENTIAL = "plaid-test-credential";

  it("builds a client from complete configuration", () => {
    const client = createPlaidClientFromEnv({
      PLAID_ENV: "sandbox",
      PLAID_CLIENT_ID: CLIENT_ID,
      PLAID_SECRET: CREDENTIAL,
    });
    expect(typeof client.linkTokenCreate).toBe("function");
  });

  it("accepts production configuration", () => {
    const client = createPlaidClientFromEnv({
      PLAID_ENV: "production",
      PLAID_CLIENT_ID: CLIENT_ID,
      PLAID_SECRET: CREDENTIAL,
    });
    expect(typeof client.linkTokenCreate).toBe("function");
  });

  it("defaults to sandbox when PLAID_ENV is unset", () => {
    const client = createPlaidClientFromEnv({
      PLAID_CLIENT_ID: CLIENT_ID,
      PLAID_SECRET: CREDENTIAL,
    });
    expect(typeof client.linkTokenCreate).toBe("function");
  });

  it("rejects an unknown PLAID_ENV before any request can be built", () => {
    expect(() =>
      createPlaidClientFromEnv({
        PLAID_ENV: "staging",
        PLAID_CLIENT_ID: CLIENT_ID,
        PLAID_SECRET: CREDENTIAL,
      }),
    ).toThrow(/PLAID_ENV must be sandbox or production/);
  });

  it("throws loudly when credentials are missing", () => {
    expect(() =>
      createPlaidClientFromEnv({ PLAID_CLIENT_ID: CLIENT_ID }),
    ).toThrow(/PLAID_CLIENT_ID and PLAID_SECRET/);
    expect(() => createPlaidClientFromEnv({})).toThrow(
      /PLAID_CLIENT_ID and PLAID_SECRET/,
    );
  });
});

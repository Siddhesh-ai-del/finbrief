/**
 * Step 1.4c — POST /api/plaid/webhook end to end: signature gate →
 * JSON validation → dispatch → state change.
 *
 * The Plaid SDK is vi.mock'd (JWK lookup + sync run offline); JWTs
 * are genuinely signed and verified with a per-run ES256 key. No
 * session auth exists here by design — Plaid authenticates with the
 * signature, and an unsigned/invalid request must be rejected before
 * any DB or upstream work (asserted on the key-lookup mock).
 */
import { createHash, randomBytes } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Pool } from "pg";
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
  type JWK,
} from "jose";
import { createScratchDatabase } from "../helpers/scratch-db";
import { ENCRYPTION_KEY_BYTES, createSecretBox } from "../../src/plaid/secrets";
import { closePool } from "../../src/db/pool";
import type * as WebhookRoute from "../../src/app/api/plaid/webhook/route";

const mocks = vi.hoisted(() => ({
  webhookVerificationKeyGet: vi.fn(),
  transactionsSync: vi.fn(),
}));

vi.mock("plaid", () => ({
  Products: { Transactions: "transactions" },
  CountryCode: { Us: "US" },
  Configuration: class {
    constructor() {
      /* mocked — no client config needed offline */
    }
  },
  PlaidApi: class PlaidApi {
    webhookVerificationKeyGet = mocks.webhookVerificationKeyGet;
    transactionsSync = mocks.transactionsSync;
  },
}));

const DB = "finbrief_plaid_webhook_route_test";
const ENDPOINT = "http://localhost/api/plaid/webhook";
const KID = "kid-route-test";
const ORG_ID = "org_route_1";
const ITEM_PLAINTEXT = "plaid-item-identifier-0001";
const AUTH_FIXTURE = "shared-auth-secret-for-route-tests";
const ROOT_KEY = randomBytes(ENCRYPTION_KEY_BYTES).toString("base64");
const secrets = createSecretBox(ROOT_KEY);

const sha256hex = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

let scratch: Awaited<ReturnType<typeof createScratchDatabase>>;
let pool: Pool;
let route: typeof WebhookRoute;
let privateKey: CryptoKey;
let wrongKey: CryptoKey;
let publicJwk: JWK;
let ourItemId: string;

async function signWebhook(
  rawBody: string,
  options: { key?: CryptoKey } = {},
): Promise<string> {
  return new SignJWT({ request_body_sha256: sha256hex(rawBody) })
    .setProtectedHeader({ alg: "ES256", kid: KID })
    .setIssuedAt(Math.floor(Date.now() / 1000))
    .sign(options.key ?? privateKey);
}

const post = async (body: string, headers: Record<string, string> = {}) =>
  route.POST(
    new Request(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    }),
  );

beforeAll(async () => {
  scratch = await createScratchDatabase(DB);
  await scratch.migrate();
  pool = scratch.pool;

  const scratchUrl = new URL(process.env.TEST_DATABASE_URL as string);
  scratchUrl.pathname = `/${DB}`;
  process.env["DATABASE_URL"] = scratchUrl.toString();
  process.env["BETTER_AUTH_SECRET"] = AUTH_FIXTURE;
  process.env.PLAID_CLIENT_ID = "test-client-id";
  process.env["PLAID_SECRET"] = "test-plaid-credential";
  process.env.PLAID_ENV = "sandbox";
  process.env.ENCRYPTION_KEY = ROOT_KEY;

  const pair = await generateKeyPair("ES256", { extractable: true });
  privateKey = pair.privateKey;
  const other = await generateKeyPair("ES256", { extractable: true });
  wrongKey = other.privateKey;
  publicJwk = {
    ...(await exportJWK(pair.publicKey)),
    kid: KID,
    use: "sig",
  };

  mocks.webhookVerificationKeyGet.mockImplementation(
    async (request: { key_id: string }) => {
      if (request.key_id !== KID) {
        throw new Error("unknown kid");
      }
      return { data: { key: publicJwk } };
    },
  );
  mocks.transactionsSync.mockResolvedValue({
    data: {
      added: [],
      modified: [],
      removed: [],
      next_cursor: "cursor-empty",
      has_more: false,
      request_id: "req-route-1",
    },
  });

  route = await import("../../src/app/api/plaid/webhook/route");

  await pool.query(
    `INSERT INTO organization (id, name, slug, created_at)
     VALUES ($1, 'Org', 'route-org', now())`,
    [ORG_ID],
  );
  const inserted = await pool.query(
    `INSERT INTO plaid_items
       (id, organization_id, item_id_ciphertext, access_token_ciphertext,
        item_id_index, created_at)
     VALUES ($1, $2, $3, $4, $5, now())
     RETURNING id`,
    [
      "item_route_1",
      ORG_ID,
      secrets.encrypt(ITEM_PLAINTEXT),
      secrets.encrypt("plaid-access-credential-0001"),
      secrets.index(ITEM_PLAINTEXT),
    ],
  );
  ourItemId = (inserted.rows[0] as { id: string }).id;
}, 60_000);

afterAll(async () => {
  await closePool();
  await scratch?.destroy();
});

beforeEach(async () => {
  await pool.query(
    "UPDATE plaid_items SET status = 'active', stale_reason = NULL",
  );
});

describe("signature gate", () => {
  it("401s a request with no Plaid-Verification header before any key lookup", async () => {
    const res = await post(
      JSON.stringify({
        webhook_type: "ITEM",
        webhook_code: "ITEM_LOGIN_REQUIRED",
        item_id: ITEM_PLAINTEXT,
      }),
    );
    expect(res.status).toBe(401);
    expect(mocks.webhookVerificationKeyGet).not.toHaveBeenCalled();
  });

  it("401s a signature from the wrong key", async () => {
    const body = JSON.stringify({
      webhook_type: "ITEM",
      webhook_code: "ITEM_LOGIN_REQUIRED",
      item_id: ITEM_PLAINTEXT,
    });
    const res = await post(body, {
      "plaid-verification": await signWebhook(body, { key: wrongKey }),
    });
    expect(res.status).toBe(401);
    const rows = await pool.query(
      "SELECT status FROM plaid_items WHERE id = $1",
      [ourItemId],
    );
    expect(rows.rows[0]?.status).toBe("active");
  });
});

describe("dispatch", () => {
  it("400s a body that is not JSON even when correctly signed", async () => {
    const body = "this is not json";
    const res = await post(body, {
      "plaid-verification": await signWebhook(body),
    });
    expect(res.status).toBe(400);
  });

  it("400s a valid signature over a payload missing required fields", async () => {
    const body = JSON.stringify({ hello: "world" });
    const res = await post(body, {
      "plaid-verification": await signWebhook(body),
    });
    expect(res.status).toBe(400);
  });

  it("200s an unknown-item webhook without touching sync", async () => {
    const body = JSON.stringify({
      webhook_type: "ITEM",
      webhook_code: "ITEM_LOGIN_REQUIRED",
      item_id: "item-we-no-longer-hold",
    });
    const res = await post(body, {
      "plaid-verification": await signWebhook(body),
    });
    expect(res.status).toBe(200);
    expect(mocks.transactionsSync).not.toHaveBeenCalled();
  });

  it("applies ITEM_LOGIN_REQUIRED to the stored item (200 + stale)", async () => {
    const body = JSON.stringify({
      webhook_type: "ITEM",
      webhook_code: "ITEM_LOGIN_REQUIRED",
      item_id: ITEM_PLAINTEXT,
      environment: "sandbox",
    });
    const res = await post(body, {
      "plaid-verification": await signWebhook(body),
    });
    expect(res.status).toBe(200);
    const rows = await pool.query(
      "SELECT status, stale_reason FROM plaid_items WHERE id = $1",
      [ourItemId],
    );
    expect(rows.rows[0]).toEqual({
      status: "stale",
      stale_reason: "login_required",
    });
  });

  it("runs transactions sync on SYNC_UPDATES_AVAILABLE", async () => {
    const body = JSON.stringify({
      webhook_type: "TRANSACTIONS",
      webhook_code: "SYNC_UPDATES_AVAILABLE",
      item_id: ITEM_PLAINTEXT,
    });
    const res = await post(body, {
      "plaid-verification": await signWebhook(body),
    });
    expect(res.status).toBe(200);
    expect(mocks.transactionsSync).toHaveBeenCalledTimes(1);
    const call = mocks.transactionsSync.mock.calls[0]?.[0] as {
      access_token?: string;
      cursor?: string;
    };
    expect(call.access_token).toBe("plaid-access-credential-0001");
    expect(call.cursor).toBeUndefined();
  });
});

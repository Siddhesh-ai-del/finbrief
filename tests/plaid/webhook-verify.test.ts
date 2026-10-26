/**
 * Step 1.4a — Plaid webhook verification (plan: signature check +
 * replay tolerance).
 *
 * Exercises the FULL documented scheme offline with real ES256
 * crypto: Plaid-Verification header → unverified decode (alg must be
 * ES256, kid selects the JWK) → JWT signature over the injected key
 * → iat within the 5-minute replay window → constant-time match of
 * request_body_sha256 against the raw body's SHA-256. Each stage's
 * rejection is pinned separately, per the plan's "reject bad
 * signature, replay tolerance" action.
 */
import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
  type JWK,
} from "jose";
import {
  REPLAY_TOLERANCE_SECONDS,
  verifyPlaidWebhook,
} from "../../src/plaid/webhooks/verify";

const KID = "kid-verification-1";
const BODY = JSON.stringify({
  webhook_type: "ITEM",
  webhook_code: "ITEM_LOGIN_REQUIRED",
  item_id: "item-under-test",
});

const sha256hex = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

let publicKey: CryptoKey;
let privateKey: CryptoKey;
let publicJwk: JWK;
let otherPrivateKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  publicKey = pair.publicKey;
  privateKey = pair.privateKey;
  const other = await generateKeyPair("ES256", { extractable: true });
  otherPrivateKey = other.privateKey;
  publicJwk = { ...(await exportJWK(publicKey)), kid: KID, use: "sig" };
});

/** Sign a webhook token the way Plaid does (ES256 + kid + body hash). */
async function signToken(
  options: {
    kid?: string;
    key?: CryptoKey;
    issuedAt?: number;
    bodyHash?: string | null;
    alg?: string;
  } = {},
): Promise<string> {
  const claims: Record<string, unknown> = {};
  if (options.bodyHash !== null) {
    claims["request_body_sha256"] = options.bodyHash ?? sha256hex(BODY);
  }
  const jwt = new SignJWT(claims);
  if (options.alg === "HS256") {
    return jwt
      .setProtectedHeader({ alg: "HS256", kid: options.kid ?? KID })
      .setIssuedAt(options.issuedAt ?? Math.floor(Date.now() / 1000))
      .sign(new TextEncoder().encode("shared-test-secret-material"));
  }
  return jwt
    .setProtectedHeader({ alg: "ES256", kid: options.kid ?? KID })
    .setIssuedAt(options.issuedAt ?? Math.floor(Date.now() / 1000))
    .sign(options.key ?? privateKey);
}

function makeOptions() {
  return {
    fetchKey: vi.fn(async (kid: string): Promise<JWK | null> =>
      kid === KID ? publicJwk : null,
    ),
    now: (): Date => new Date(),
  };
}

describe("verifyPlaidWebhook", () => {
  it("accepts a correctly signed recent webhook", async () => {
    const options = makeOptions();
    const token = await signToken();
    await expect(verifyPlaidWebhook(options, BODY, token)).resolves.toBe(true);
    expect(options.fetchKey).toHaveBeenCalledWith(KID);
  });

  it("rejects a missing Plaid-Verification header", async () => {
    const options = makeOptions();
    await expect(verifyPlaidWebhook(options, BODY, null)).resolves.toBe(false);
    expect(options.fetchKey).not.toHaveBeenCalled();
  });

  it("rejects a non-ES256 algorithm before any key lookup", async () => {
    const options = makeOptions();
    const token = await signToken({ alg: "HS256" });
    await expect(verifyPlaidWebhook(options, BODY, token)).resolves.toBe(false);
    expect(options.fetchKey).not.toHaveBeenCalled();
  });

  it("rejects a body tampered with after signing", async () => {
    const options = makeOptions();
    const token = await signToken();
    const tampered = BODY.replace("ITEM_LOGIN_REQUIRED", "FAKE_CODE");
    await expect(verifyPlaidWebhook(options, tampered, token)).resolves.toBe(
      false,
    );
  });

  it("rejects a token signed by a different key", async () => {
    const options = makeOptions();
    const token = await signToken({ key: otherPrivateKey });
    await expect(verifyPlaidWebhook(options, BODY, token)).resolves.toBe(false);
  });

  it("rejects an iat older than the replay tolerance (5 min)", async () => {
    const options = makeOptions();
    const issuedAt = 1_700_000_000;
    const token = await signToken({ issuedAt });
    options.now = () =>
      new Date((issuedAt + REPLAY_TOLERANCE_SECONDS + 1) * 1000);
    await expect(verifyPlaidWebhook(options, BODY, token)).resolves.toBe(false);
  });

  it("accepts an iat at the tolerance boundary", async () => {
    const options = makeOptions();
    const issuedAt = 1_700_000_000;
    const token = await signToken({ issuedAt });
    options.now = () => new Date((issuedAt + REPLAY_TOLERANCE_SECONDS) * 1000);
    await expect(verifyPlaidWebhook(options, BODY, token)).resolves.toBe(true);
  });

  it("rejects an unknown kid and a failing key lookup", async () => {
    const missing = makeOptions();
    const token = await signToken({ kid: "kid-rotated-away" });
    await expect(verifyPlaidWebhook(missing, BODY, token)).resolves.toBe(false);

    const failing = {
      fetchKey: vi.fn(async (): Promise<JWK | null> => {
        throw new Error("upstream 500");
      }),
    };
    await expect(
      verifyPlaidWebhook(failing, BODY, await signToken()),
    ).resolves.toBe(false);
  });

  it("rejects a valid signature missing the body-hash claim", async () => {
    const options = makeOptions();
    const token = await signToken({ bodyHash: null });
    await expect(verifyPlaidWebhook(options, BODY, token)).resolves.toBe(false);
  });

  it("rejects a garbage header that is not a JWT", async () => {
    const options = makeOptions();
    await expect(verifyPlaidWebhook(options, BODY, "not.a.jwt")).resolves.toBe(
      false,
    );
    await expect(
      verifyPlaidWebhook(options, BODY, "plain-garbage"),
    ).resolves.toBe(false);
    expect(options.fetchKey).not.toHaveBeenCalled();
  });
});

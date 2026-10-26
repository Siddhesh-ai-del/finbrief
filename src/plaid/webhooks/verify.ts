/**
 * Plaid webhook verification (plan Step 1.4 — "signature verification
 * (reject bad signature), replay tolerance").
 *
 * Plaid's documented scheme, in full:
 * 1. The `Plaid-Verification` header is a JWT. Decode it UNVERIFIED
 *    only to read `alg` and `kid`; anything but ES256 is rejected
 *    before any key work (no algorithm-confusion surface).
 * 2. `kid` selects the JWK from Plaid's `/webhook_verification_key/
 *    get` (injected here as `fetchKey` so the route can memoize per
 *    kid and tests stay offline). A failed lookup fails closed.
 * 3. Verify the signature, then enforce the 5-minute replay window
 *    on `iat` (Plaid's guidance — an old JWT is a replayed request).
 * 4. Constant-time compare of the claim `request_body_sha256`
 *    against SHA-256 of the RAW body — the body must be hashed
 *    exactly as bytes arrived (whitespace-sensitive by spec).
 *
 * Every stage returns `false` rather than throwing: the route maps
 * all failures to one uniform 401 so rejection reasons are not
 * distinguishable by an unauthenticated caller.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import {
  decodeJwt,
  decodeProtectedHeader,
  importJWK,
  jwtVerify,
  type JWK,
} from "jose";

/** Plaid's documented replay window: reject iat older than 5 min. */
export const REPLAY_TOLERANCE_SECONDS = 300;

export interface WebhookVerificationOptions {
  /** Fetch the JWK for a `kid`; null/throw = fail closed. */
  fetchKey: (kid: string) => Promise<JWK | null>;
  /** Injectable clock (tests pin time for the replay window). */
  now?: () => Date;
}

export async function verifyPlaidWebhook(
  options: WebhookVerificationOptions,
  rawBody: string,
  headerValue: string | null,
): Promise<boolean> {
  if (!headerValue) {
    return false;
  }

  // Stage 1 — unverified structural decode (alg pin + kid extract).
  let alg: string | undefined;
  let kid: string | undefined;
  let claims: Record<string, unknown>;
  try {
    const header = decodeProtectedHeader(headerValue);
    claims = decodeJwt(headerValue) as Record<string, unknown>;
    alg = header.alg;
    kid = header.kid;
  } catch {
    return false;
  }
  if (alg !== "ES256" || !kid) {
    return false;
  }

  // Stage 2 — the verification key for this kid.
  let jwk: JWK | null;
  try {
    jwk = await options.fetchKey(kid);
  } catch {
    return false;
  }
  if (!jwk) {
    return false;
  }

  // Stage 3 — signature + replay window.
  try {
    const key = await importJWK(jwk, "ES256");
    await jwtVerify(headerValue, key, {
      algorithms: ["ES256"],
      currentDate: options.now?.() ?? new Date(),
      maxTokenAge: `${REPLAY_TOLERANCE_SECONDS} seconds`,
    });
  } catch {
    return false;
  }

  // Stage 4 — body integrity, constant-time.
  const claimed = claims["request_body_sha256"];
  if (typeof claimed !== "string") {
    return false;
  }
  const actual = createHash("sha256").update(rawBody, "utf8").digest("hex");
  const actualBuf = Buffer.from(actual, "utf8");
  const claimedBuf = Buffer.from(claimed, "utf8");
  if (actualBuf.length !== claimedBuf.length) {
    return false;
  }
  return timingSafeEqual(actualBuf, claimedBuf);
}

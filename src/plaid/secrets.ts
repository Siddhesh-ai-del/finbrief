/**
 * Credential encryption at rest (plan Step 1.2).
 *
 * AES-256-GCM with a random 96-bit IV per encryption; payload format
 * `v1.<iv>.<tag>.<ciphertext>` (base64url segments) so a future key
 * rotation can recognise old versions. Authentication failures and
 * malformed payloads raise `SecretBoxError` whose message never
 * contains the plaintext — an error message is a log line, and log
 * lines are an exfiltration surface (the plan's negative test).
 *
 * `index()` is a keyed HMAC-SHA256 digest under a domain-separated
 * subkey derived from the same root key: equality lookups over item
 * ids (stable across processes and instances) without ever
 * persisting them plaintext.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";

export const ENCRYPTION_KEY_BYTES = 32;
const IV_BYTES = 12;
const VERSION = "v1";
const INDEX_DOMAIN = "finbrief:item-id-index:v1";

export class SecretBoxConfigError extends Error {}
export class SecretBoxError extends Error {}

export interface SecretBox {
  encrypt(plaintext: string): string;
  decrypt(payload: string): string;
  index(value: string): string;
}

export function createSecretBox(rootKeyBase64: string): SecretBox {
  const rootKey = Buffer.from(rootKeyBase64, "base64");
  if (rootKey.length !== ENCRYPTION_KEY_BYTES) {
    // Never echo the configured value: it is the secret itself.
    throw new SecretBoxConfigError(
      `encryption key must decode to ${ENCRYPTION_KEY_BYTES} bytes`,
    );
  }
  const indexKey = createHmac("sha256", rootKey)
    .update(INDEX_DOMAIN)
    .digest();

  return {
    encrypt(plaintext: string): string {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", rootKey, iv);
      const ciphertext = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      return [
        VERSION,
        iv.toString("base64url"),
        tag.toString("base64url"),
        ciphertext.toString("base64url"),
      ].join(".");
    },

    decrypt(payload: string): string {
      const segments = payload.split(".");
      const [version, ivRaw, tagRaw, ciphertextRaw] = segments;
      if (
        segments.length !== 4 ||
        version !== VERSION ||
        !ivRaw ||
        !tagRaw ||
        !ciphertextRaw
      ) {
        throw new SecretBoxError("malformed secret payload");
      }
      try {
        const decipher = createDecipheriv(
          "aes-256-gcm",
          rootKey,
          Buffer.from(ivRaw, "base64url"),
        );
        decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
        return Buffer.concat([
          decipher.update(Buffer.from(ciphertextRaw, "base64url")),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        // Tampered or wrong key: both are authentication failures.
        // The message carries no payload material.
        throw new SecretBoxError("secret failed authentication");
      }
    },

    index(value: string): string {
      return createHmac("sha256", indexKey).update(value).digest("base64url");
    },
  };
}

export function createSecretBoxFromEnv(
  env: Record<string, string | undefined> = process.env,
): SecretBox {
  const raw = env.ENCRYPTION_KEY;
  if (!raw) {
    throw new SecretBoxConfigError("ENCRYPTION_KEY must be set");
  }
  return createSecretBox(raw);
}

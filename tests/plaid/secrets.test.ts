/**
 * Step 1.2 — secret storage primitives: AES-256-GCM round-trip,
 * per-encryption IVs, keyed lookup index, and failure modes whose
 * messages never carry plaintext (an error message is a log line).
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ENCRYPTION_KEY_BYTES,
  SecretBoxConfigError,
  SecretBoxError,
  createSecretBox,
  createSecretBoxFromEnv,
} from "../../src/plaid/secrets";

const KEY = randomBytes(ENCRYPTION_KEY_BYTES).toString("base64");
const OTHER_KEY = randomBytes(ENCRYPTION_KEY_BYTES).toString("base64");
const PLAINTEXT_ACCESS = "plaid-access-credential-0001";
const PLAINTEXT_ITEM = "plaid-item-identifier-0001";

const box = createSecretBox(KEY);

describe("SecretBox", () => {
  it("round-trips encrypt → decrypt", () => {
    const payload = box.encrypt(PLAINTEXT_ACCESS);
    expect(payload).not.toContain(PLAINTEXT_ACCESS);
    expect(box.decrypt(payload)).toBe(PLAINTEXT_ACCESS);
  });

  it("produces distinct ciphertexts for the same plaintext (random IV)", () => {
    expect(box.encrypt(PLAINTEXT_ACCESS)).not.toBe(
      box.encrypt(PLAINTEXT_ACCESS),
    );
  });

  it("fails closed under a different key without echoing the plaintext", () => {
    const other = createSecretBox(OTHER_KEY);
    const payload = box.encrypt(PLAINTEXT_ACCESS);

    let message = "";
    try {
      other.decrypt(payload);
    } catch (error) {
      expect(error).toBeInstanceOf(SecretBoxError);
      message = String(error);
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(PLAINTEXT_ACCESS);
  });

  it("rejects tampered ciphertext without echoing the plaintext", () => {
    const parts = box.encrypt(PLAINTEXT_ACCESS).split(".");
    const [version = "", iv = "", tag = "", encoded = ""] = parts;
    const bytes = Buffer.from(encoded, "base64url");
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    const tampered = [version, iv, tag, bytes.toString("base64url")].join(".");

    let message = "";
    try {
      box.decrypt(tampered);
    } catch (error) {
      expect(error).toBeInstanceOf(SecretBoxError);
      message = String(error);
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(PLAINTEXT_ACCESS);
  });

  it("rejects malformed payloads", () => {
    expect(() => box.decrypt("garbage")).toThrow(SecretBoxError);
    expect(() => box.decrypt("v2.a.b.c")).toThrow(SecretBoxError);
    expect(() => box.decrypt("v1.only-three.segments")).toThrow(SecretBoxError);
  });

  it("indexes deterministically across instances, keyed by the root key", () => {
    const digest = box.index(PLAINTEXT_ITEM);

    expect(box.index(PLAINTEXT_ITEM)).toBe(digest);
    expect(createSecretBox(KEY).index(PLAINTEXT_ITEM)).toBe(digest);
    expect(box.index("some-other-item")).not.toBe(digest);
    expect(createSecretBox(OTHER_KEY).index(PLAINTEXT_ITEM)).not.toBe(digest);

    expect(digest).not.toContain(PLAINTEXT_ITEM);
    expect(digest).not.toContain(PLAINTEXT_ACCESS);
  });
});

describe("createSecretBoxFromEnv", () => {
  it("builds a box from configured key material", () => {
    const fromEnv = createSecretBoxFromEnv({ ENCRYPTION_KEY: KEY });
    expect(typeof fromEnv.encrypt).toBe("function");
    expect(fromEnv.decrypt(fromEnv.encrypt(PLAINTEXT_ACCESS))).toBe(
      PLAINTEXT_ACCESS,
    );
  });

  it("throws when the key is missing", () => {
    expect(() => createSecretBoxFromEnv({})).toThrow(SecretBoxConfigError);
  });

  const badKeys: { name: string; value: string }[] = [
    { name: "too short", value: randomBytes(16).toString("base64") },
    { name: "not base64", value: "!!!!!!!!" },
  ];
  for (const badKey of badKeys) {
    it(`rejects a ${badKey.name} key without echoing it`, () => {
      let message = "";
      try {
        createSecretBoxFromEnv({ ENCRYPTION_KEY: badKey.value });
      } catch (error) {
        expect(error).toBeInstanceOf(SecretBoxConfigError);
        message = String(error);
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(badKey.value);
    });
  }
});

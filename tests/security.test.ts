import { describe, it, expect, beforeAll } from "vitest";
import { encrypt, decrypt } from "../src/security/crypto";
import { hashPassword, verifyPassword } from "../src/security/password";

beforeAll(() => {
  process.env.ENCRYPTION_MASTER_KEY = "0".repeat(64);
});

describe("AES-256-GCM envelope encryption", () => {
  it("round-trips plaintext", () => {
    const cipher = encrypt("super-secret-marketplace-token");
    expect(decrypt(cipher)).toBe("super-secret-marketplace-token");
  });

  it("produces a different ciphertext each time (random IV)", () => {
    const a = encrypt("same-plaintext");
    const b = encrypt("same-plaintext");
    expect(a).not.toBe(b);
  });

  it("detects tampering — a flipped byte throws instead of decrypting to garbage", () => {
    const cipher = encrypt("do-not-tamper");
    const raw = Buffer.from(cipher, "base64");
    raw[raw.length - 1] ^= 0xff; // flip the last ciphertext byte
    const tampered = raw.toString("base64");
    expect(() => decrypt(tampered)).toThrow();
  });

  it("rejects decryption under the wrong key", () => {
    const cipher = encrypt("key-bound-secret");
    process.env.ENCRYPTION_MASTER_KEY = "1".repeat(64);
    expect(() => decrypt(cipher)).toThrow();
    process.env.ENCRYPTION_MASTER_KEY = "0".repeat(64);
  });
});

describe("argon2id password hashing", () => {
  it("verifies a correct password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword(hash, "correct horse battery staple")).toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword(hash, "wrong password")).toBe(false);
  });

  it("never stores the plaintext in the hash", async () => {
    const hash = await hashPassword("findable-plaintext-marker");
    expect(hash).not.toContain("findable-plaintext-marker");
  });
});

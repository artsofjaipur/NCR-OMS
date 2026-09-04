import crypto from "crypto";

// AES-256-GCM envelope encryption for anything sensitive at rest: marketplace
// seller credentials, bank account numbers. GCM's auth tag gives us tamper
// detection for free — a flipped ciphertext byte or a wrong key throws
// instead of silently decrypting to garbage.

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // recommended for GCM
const AUTH_TAG_LENGTH = 16;

function getMasterKey(): Buffer {
  const keyHex = process.env.ENCRYPTION_MASTER_KEY;
  if (!keyHex) {
    throw new Error("ENCRYPTION_MASTER_KEY is not set");
  }
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== 32) {
    throw new Error("ENCRYPTION_MASTER_KEY must be 32 bytes (64 hex characters) for AES-256");
  }
  return key;
}

/**
 * Encrypts plaintext into a single base64 envelope: iv || authTag || ciphertext.
 */
export function encrypt(plaintext: string): string {
  const key = getMasterKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

/**
 * Decrypts an envelope produced by encrypt(). Throws if the envelope was
 * tampered with, truncated, or encrypted under a different key.
 */
export function decrypt(envelope: string): string {
  const key = getMasterKey();
  const raw = Buffer.from(envelope, "base64");
  if (raw.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error("Ciphertext envelope is too short to be valid");
  }
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

export function encryptJson(value: unknown): string {
  return encrypt(JSON.stringify(value));
}

export function decryptJson<T>(envelope: string): T {
  return JSON.parse(decrypt(envelope)) as T;
}

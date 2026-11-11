import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function key(): Buffer {
  const k = Buffer.from(process.env.DATA_ENCRYPTION_KEY ?? "", "base64");
  if (k.length !== 32) throw new Error("DATA_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  return k;
}

/** AES-256-GCM. Output: base64(iv[12] || tag[16] || ciphertext). */
export function encrypt(plain: Uint8Array | string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([c.update(typeof plain === "string" ? Buffer.from(plain, "utf8") : plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
}

export function decrypt(blob: string): Buffer {
  const raw = Buffer.from(blob, "base64");
  if (raw.length < 28) throw new Error("ciphertext is too short");
  const d = createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]);
}

export const encryptJson = (value: unknown) => encrypt(JSON.stringify(value));
export const decryptJson = <T>(blob: string): T => JSON.parse(decrypt(blob).toString("utf8")) as T;

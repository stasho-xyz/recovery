import { decrypt as eciesDecrypt } from "eciesjs";
import { createDecipheriv } from "node:crypto";
import type { EncryptedEnvelope } from "./types.js";

/**
 * Decrypt a dual-envelope blob using the user's ECIES-wrapped DEK copy.
 *
 * Mirrors `decryptBlobAsBackend` in the backend, but reads `deks.user`
 * instead of `deks.backend`. Throws on auth tag mismatch or wrong key.
 */
export function decryptBlobAsUser(
  envelope: EncryptedEnvelope,
  userPrivKey: Buffer,
): Record<string, unknown> {
  const wrapped = Buffer.from(envelope.deks.user, "base64");
  const dek = Buffer.from(eciesDecrypt(userPrivKey, wrapped));

  const iv = Buffer.from(envelope.iv, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  const ciphertext = Buffer.from(envelope.ct, "base64");

  const decipher = createDecipheriv("aes-256-gcm", dek, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8")) as Record<string, unknown>;
}

import { decrypt as eciesDecrypt } from "eciesjs";
import { createDecipheriv } from "node:crypto";
import { Wallet, keccak256, getBytes } from "ethers";
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

/**
 * FROZEN — must byte-match apps/web/src/lib/encryption-key.ts derivationMessage.
 * Changing this string changes the derived encryption key for every wallet.
 */
export function derivationMessage(checksummedAddress: string): string {
  return [
    "Stasho Cloud — encryption key",
    "",
    "Sign to derive your personal encryption key. This key lets your",
    "browser decrypt your deployment history.",
    "",
    "This signature does not authorize any transaction, payment, or",
    "spending. It is free and safe.",
    "",
    `Wallet: ${checksummedAddress}`,
    "Version: 1",
  ].join("\n");
}

/**
 * Re-derive the deterministic encryption key from the raw wallet private key.
 *
 * Algorithm (byte-identical to apps/web/src/lib/encryption-key.ts deriveFresh):
 *   E.priv = keccak256(signatureBytes)
 * where signatureBytes is the EIP-191 personal_sign of derivationMessage(checksummedAddress).
 *
 * The recovery script uses this as an alternative decrypt path for envelopes
 * that carry a deks.encryption recipient (Decision #117, v2 envelope format).
 */
export async function deriveEncryptionKey(
  walletPrivKey: Buffer,
): Promise<Buffer> {
  const wallet = new Wallet("0x" + walletPrivKey.toString("hex"));
  const sig = await wallet.signMessage(derivationMessage(wallet.address));
  return Buffer.from(getBytes(keccak256(getBytes(sig))));
}

/**
 * Decrypt via the deterministic encryption-key recipient (deks.encryption).
 *
 * The `deks.user` path (decryptBlobAsUser) remains the primary path for the
 * recovery script — it always works given the raw wallet key and is
 * derivation-independent. This function is exported for advanced use and to
 * prove byte-compatibility with the browser's EncryptionKeyManager via tests.
 *
 * Throws if the envelope has no deks.encryption recipient.
 */
export function decryptBlobAsEncryption(
  envelope: EncryptedEnvelope,
  encryptionPrivKey: Buffer,
): Record<string, unknown> {
  if (!envelope.deks.encryption) {
    throw new Error("envelope has no deks.encryption recipient");
  }
  const wrapped = Buffer.from(envelope.deks.encryption, "base64");
  const dek = Buffer.from(eciesDecrypt(encryptionPrivKey, wrapped));

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

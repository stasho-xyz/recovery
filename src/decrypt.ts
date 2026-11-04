import { decrypt as eciesDecrypt, PrivateKey } from "eciesjs";
import { createDecipheriv } from "node:crypto";
import { Wallet, keccak256, getBytes } from "ethers";
import type { EncryptedEnvelope } from "./types.js";

/**
 * Decrypt an encrypted blob using the user's ECIES-wrapped DEK copy.
 *
 * Mirrors `decryptBlobAsUser` in the backend's `encryption.ts`, reading the
 * `deks.user` slot. Throws on auth tag mismatch or wrong key.
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

/** The uncompressed `0x04…` secp256k1 public key of an encryption private key. */
export function encryptionPubkeyOf(encryptionPrivKey: Buffer): string {
  const pub = new PrivateKey(encryptionPrivKey).publicKey.uncompressed;
  return "0x" + Buffer.from(pub).toString("hex");
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function bundleEnvelopeProblem(envelope: unknown): string | null {
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
    return "not a JSON object";
  }
  const e = envelope as Record<string, unknown>;
  if (e["v"] !== 1) return "v is not 1";
  if (e["kind"] !== "stasho-bundle") return "kind is not stasho-bundle";
  if (e["alg"] !== "aes-256-gcm") return "alg is not aes-256-gcm";
  for (const field of ["ct", "iv", "tag"]) {
    if (!isString(e[field])) return `${field} is missing`;
  }
  const deks = e["deks"];
  if (typeof deks !== "object" || deks === null) return "deks is missing";
  if (!isString((deks as Record<string, unknown>)["encryption"])) {
    return "deks.encryption is missing";
  }
  return null;
}

/**
 * Decrypt a `stasho-bundle` envelope through its `deks.encryption` recipient.
 *
 * The backend builds the envelope in `apps/backend/tests/bundle-encrypt-script.test.ts:38-58`
 * (AES key ECIES-wrapped to the uncompressed encryption pubkey). Returns the raw
 * plaintext bytes; they are never parsed. Throws on a malformed envelope, a wrong
 * key or an auth tag mismatch.
 */
export function decryptBundle(envelope: unknown, encryptionPrivKey: Buffer): Buffer {
  const problem = bundleEnvelopeProblem(envelope);
  if (problem !== null) throw new Error(`not a stasho-bundle envelope: ${problem}`);
  const e = envelope as { ct: string; iv: string; tag: string; deks: { encryption: string } };
  const dek = Buffer.from(
    eciesDecrypt(encryptionPrivKey, Buffer.from(e.deks.encryption, "base64")),
  );
  const decipher = createDecipheriv("aes-256-gcm", dek, Buffer.from(e.iv, "base64"));
  decipher.setAuthTag(Buffer.from(e.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(e.ct, "base64")), decipher.final()]);
}

import { createCipheriv, randomBytes } from "node:crypto";
import { encrypt as eciesEncrypt, PrivateKey } from "eciesjs";
import type { EncryptedEnvelope } from "../../src/types.js";

const TEST_USER_PRIV = Buffer.from("11".repeat(32), "hex");

function deriveUncompressedPub(priv: Buffer): Buffer {
  return Buffer.from(new PrivateKey(priv).publicKey.uncompressed);
}

const TEST_USER_PUB = deriveUncompressedPub(TEST_USER_PRIV);

/**
 * Minimal `encryptBlob` for use in inline test fixtures.
 *
 * Matches the wire format produced by the backend's `encryptBlob` since
 * envelope v3 (Thread 2 step 3, 2026-05-22): `v: 3` with exactly two DEK
 * slots — `user` (wallet pubkey) and `encryption` (deterministic
 * wallet-derived key, Decision #117). The pre-v3 `deks.backend` slot is gone.
 *
 * Pass `encryptionPub` to control which key the `encryption` DEK is wrapped
 * to. Pass `omitEncryption: true` to build a deliberately malformed envelope
 * with no `encryption` recipient (for negative-path coverage).
 */
export function encryptForTest(
  cleartext: Record<string, unknown>,
  opts: {
    userPub?: Buffer;
    encryptionPub?: Buffer;
    omitEncryption?: boolean;
  } = {},
): EncryptedEnvelope {
  const userPub = opts.userPub ?? TEST_USER_PUB;
  const encryptionPub = opts.encryptionPub ?? TEST_USER_PUB;
  const plaintext = Buffer.from(JSON.stringify(cleartext), "utf8");
  const dek = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dek, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 3,
    alg: "aes-256-gcm",
    ct: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    deks: {
      user: Buffer.from(eciesEncrypt(userPub, dek)).toString("base64"),
      ...(opts.omitEncryption
        ? {}
        : {
            encryption: Buffer.from(
              eciesEncrypt(encryptionPub, dek),
            ).toString("base64"),
          }),
    },
  };
}

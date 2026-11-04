import { describe, expect, it } from "vitest";
import { createCipheriv, randomBytes } from "node:crypto";
import { encrypt as eciesEncrypt } from "eciesjs";
import { decryptBundle, deriveEncryptionKey, encryptionPubkeyOf } from "../src/decrypt.js";
import { fetchRawStorage } from "../src/aleph-fetch.js";
import { findDeployment } from "../src/bundle.js";
import type { RecoveredDeployment, RecoveryOutput } from "../src/types.js";

const KEY = Buffer.from("33".repeat(32), "hex");

function sealBundle(plaintext: Buffer, key: Buffer, overrides: Record<string, unknown> = {}) {
  const dek = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dek, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    v: 1,
    kind: "stasho-bundle",
    alg: "aes-256-gcm",
    ct: ct.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    deks: {
      encryption: Buffer.from(eciesEncrypt(encryptionPubkeyOf(key), dek)).toString("base64"),
    },
    ...overrides,
  };
}

describe("decryptBundle", () => {
  it("round-trips 64 KiB of random bytes", () => {
    const plaintext = randomBytes(64 * 1024);
    expect(decryptBundle(sealBundle(plaintext, KEY), KEY).equals(plaintext)).toBe(true);
  });

  it("returns JSON-looking plaintext as unparsed bytes", () => {
    const plaintext = Buffer.from('{"a":1}');
    const out = decryptBundle(sealBundle(plaintext, KEY), KEY);
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out.toString()).toBe('{"a":1}');
  });

  it("rejects another kind", () => {
    expect(() => decryptBundle(sealBundle(Buffer.from("x"), KEY, { kind: "x" }), KEY)).toThrow(
      /not a stasho-bundle envelope/,
    );
  });

  it("rejects a missing deks.encryption", () => {
    expect(() => decryptBundle(sealBundle(Buffer.from("x"), KEY, { deks: {} }), KEY)).toThrow(
      /not a stasho-bundle envelope/,
    );
  });

  it("rejects a non-object", () => {
    expect(() => decryptBundle(null, KEY)).toThrow(/not a stasho-bundle envelope/);
  });
});

describe("encryptionPubkeyOf", () => {
  it("is the 0x04 uncompressed form of the derived key", async () => {
    const derived = await deriveEncryptionKey(Buffer.from("aa".repeat(32), "hex"));
    expect(encryptionPubkeyOf(derived)).toMatch(/^0x04[0-9a-f]{128}$/);
  });
});

describe("fetchRawStorage", () => {
  it("returns the body", async () => {
    const f = (async () => new Response(Buffer.from("hello"))) as unknown as typeof fetch;
    const out = await fetchRawStorage("https://ccn.test", "h1", { fetchImpl: f });
    expect(out.toString()).toBe("hello");
  });

  it("rejects a declared content-length over the cap", async () => {
    const f = (async () =>
      new Response("x", { headers: { "content-length": "100" } })) as unknown as typeof fetch;
    await expect(
      fetchRawStorage("https://ccn.test", "h1", { fetchImpl: f, maxBytes: 10 }),
    ).rejects.toThrow(/content-length/);
  });

  it("aborts a body that grows past the cap", async () => {
    const f = (async () =>
      new Response(new Blob([Buffer.alloc(100)]).stream())) as unknown as typeof fetch;
    await expect(
      fetchRawStorage("https://ccn.test", "h1", { fetchImpl: f, maxBytes: 10 }),
    ).rejects.toThrow(/exceed/);
  });

  it("throws on a non-OK status", async () => {
    const f = (async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
    await expect(fetchRawStorage("https://ccn.test", "h1", { fetchImpl: f })).rejects.toThrow(/404/);
  });
});

describe("findDeployment", () => {
  it("finds a deployment under deletedProjects", () => {
    const dep = { id: "d9" } as RecoveredDeployment;
    const output = {
      projects: [{ deployments: [{ id: "d1" }] }],
      deletedProjects: [{ deployments: [dep] }],
    } as unknown as RecoveryOutput;
    expect(findDeployment(output, "d9")).toBe(dep);
    expect(findDeployment(output, "nope")).toBeNull();
  });
});

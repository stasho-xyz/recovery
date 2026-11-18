import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { PrivateKey, encrypt as eciesEncrypt } from "eciesjs";
import { deriveEncryptionKey, encryptionPubkeyOf } from "../src/decrypt.js";
import { encryptForTest } from "./helpers/envelope.js";
import { startStubCcn } from "./helpers/stub-ccn.js";
import { DELEGATE, WALLET, exportLine, signedMessage } from "./helpers/signed-message.js";
import type { AlephMessage, RecoveryOutput } from "../src/types.js";

const packageRoot = join(import.meta.dirname, "..");
const CHANNEL = "STASHO_CHANNEL_V1";
const STORE_REF = "store_item_hash_1";

interface CliResult {
  code: number;
  stderr: string;
}

function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      "npx",
      ["tsx", "src/main.ts", ...args],
      { cwd: packageRoot, env: { ...process.env, USER_PRIVATE_KEY: "11".repeat(32) } },
      (err, _stdout, stderr) => {
        const code = err === null ? 0 : ((err as { code?: number }).code ?? 1);
        resolve({ code, stderr });
      },
    );
  });
}

function projectAggregate(envelopeKey?: Buffer): Promise<AlephMessage> {
  const sealed = encryptForTest(
    { name: "site", source: "github", buildCommand: "npm run build", outputDir: "dist" },
    envelopeKey ? { userPub: envelopeKey } : {},
  );
  return signedMessage(WALLET, {
    type: "AGGREGATE",
    channel: CHANNEL,
    content: {
      address: WALLET.address,
      key: "projects",
      content: {
        p1: {
          id: "p1",
          schemaVersion: 1,
          public: {
            framework: "nextjs-static",
            deployTarget: "ipfs",
            createdAt: "2026-11-01T00:00:00.000Z",
            updatedAt: "2026-11-01T00:00:00.000Z",
            deleted: false,
          },
          encrypted: sealed,
        },
      },
      time: 1712620800,
    },
  });
}

function deploymentPost(): Promise<AlephMessage> {
  return signedMessage(WALLET, {
    type: "POST",
    channel: CHANNEL,
    content: {
      address: WALLET.address,
      type: "aleph-cloud-deployment",
      content: {
        deploymentId: "d1",
        projectId: "p1",
        schemaVersion: 1,
        public: {
          status: "live",
          storeRef: STORE_REF,
          url: null,
          createdAt: "2026-11-01T00:30:00.000Z",
          finishedAt: "2026-11-01T00:31:00.000Z",
        },
        encrypted: encryptForTest({ commit: "abc1234", branch: "main" }),
      },
      time: 1712622600,
    },
  });
}

const THIRD = "0xDEAD000000000000000000000000000000000000";

function securityAggregate(): Promise<AlephMessage> {
  return signedMessage(WALLET, {
    type: "AGGREGATE",
    channel: CHANNEL,
    content: {
      address: WALLET.address,
      key: "security",
      content: {
        authorizations: [{ address: DELEGATE.address }],
        encryptionKey: { pubkey: "0x04" + "aa".repeat(64), scheme: "wallet-sig-v1" },
      },
      time: 1712620000,
    },
  });
}

function otherWalletProjects(): Promise<AlephMessage> {
  return signedMessage(DELEGATE, {
    type: "AGGREGATE",
    channel: CHANNEL,
    content: {
      address: THIRD,
      key: "projects",
      content: { px: { id: "px", schemaVersion: 1, public: { deleted: false }, encrypted: {} } },
      time: 1712620900,
    },
  });
}

function otherWalletDeployment(): Promise<AlephMessage> {
  return signedMessage(DELEGATE, {
    type: "POST",
    channel: CHANNEL,
    content: {
      address: THIRD,
      type: "aleph-cloud-deployment",
      content: { deploymentId: "dx", projectId: "px", schemaVersion: 1, public: {}, encrypted: {} },
      time: 1712622700,
    },
  });
}

function pageOne(url: URL, byType: Record<string, AlephMessage[]>): AlephMessage[] {
  if (url.searchParams.get("page") !== "1") return [];
  return byType[url.searchParams.get("msgTypes") ?? ""] ?? [];
}

describe("recover CLI", () => {
  let dir: string;
  const closers: Array<() => Promise<void>> = [];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "recover-cli-"));
  });

  afterAll(async () => {
    for (const close of closers) await close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function stub(
    byType: Record<string, AlephMessage[]>,
    total?: number,
  ): Promise<string> {
    const ccn = await startStubCcn({
      messages: (url) => ({
        messages: pageOne(url, byType),
        ...(total === undefined ? {} : { pagination_total: total }),
      }),
      message: () => ({
        status: 200,
        body: {
          status: "processed",
          message: { type: "STORE", content: { item_hash: "bafycid1", item_type: "ipfs" } },
        },
      }),
    });
    closers.push(ccn.close);
    return ccn.url;
  }

  function recover(api: string, name: string, extra: string[] = []): Promise<CliResult> {
    return runCli([
      "--address", WALLET.address, "--output", join(dir, name), "--aleph-api", api, ...extra,
    ]);
  }

  function readOutput(name: string): RecoveryOutput {
    return JSON.parse(readFileSync(join(dir, name), "utf8")) as RecoveryOutput;
  }

  it("an empty wallet exits 0 with an empty, complete file", async () => {
    const res = await recover(await stub({}), "empty.json");
    expect(res.code).toBe(0);
    const out = readOutput("empty.json");
    expect(out.projects).toEqual([]);
    expect(out.deletedProjects).toEqual([]);
    expect(out.complete).toBe(true);
    expect(out.schemaVersion).toBe(4);
    expect(statSync(join(dir, "empty.json")).mode & 0o777).toBe(0o600);
    expect(res.stderr.split("\n")[0]).toMatch(
      /Wrote 0 projects \(0 deleted\), 0 deployments, 0 warnings/,
    );
  }, 30_000);

  it("one project with a resolved live deployment exits 0", async () => {
    const api = await stub({
      AGGREGATE: [await projectAggregate()],
      POST: [await deploymentPost()],
    });
    const res = await recover(api, "one.json");
    expect(res.code).toBe(0);
    const out = readOutput("one.json");
    expect(out.complete).toBe(true);
    expect(out.projects).toHaveLength(1);
    expect(out.projects[0]?.deployments[0]?.cid).toBe("bafycid1");
  }, 30_000);

  it("another wallet's delegate-signed records are skipped silently", async () => {
    const api = await stub({
      AGGREGATE: [await securityAggregate(), await projectAggregate(), await otherWalletProjects()],
      POST: [await deploymentPost(), await otherWalletDeployment()],
    });
    const res = await recover(api, "shared-delegate.json", ["--verbose"]);
    expect(res.code).toBe(0);
    const out = readOutput("shared-delegate.json");
    expect(out.complete).toBe(true);
    expect(out.warnings).toEqual([]);
    expect(out.projects.map((p) => p.id)).toEqual(["p1"]);
    expect(res.stderr).toMatch(/Skipped \d+ messages addressed to other wallets/);
  }, 30_000);

  it("an envelope sealed to another key exits 3 with the file written", async () => {
    const other = Buffer.from(new PrivateKey(Buffer.from("22".repeat(32), "hex")).publicKey.uncompressed);
    const api = await stub({ AGGREGATE: [await projectAggregate(other)] });
    const res = await recover(api, "sealed.json");
    expect(res.code).toBe(3);
    const out = readOutput("sealed.json");
    expect(out.projects).toEqual([]);
    expect(out.warnings.filter((w) => w.code === "DECRYPT_FAILED")).toHaveLength(1);
    expect(out.complete).toBe(false);
    expect(res.stderr).toContain(
      "[recover] INCOMPLETE: 1 decrypt failures, 0 malformed records, 0 untrusted messages, " +
        "0 truncated queries, 0 store fetch failures (exit 3)",
    );
  }, 30_000);

  it("a listing shorter than its reported total exits 3", async () => {
    const api = await stub({ AGGREGATE: [await projectAggregate(), await projectAggregate()] }, 3);
    const res = await recover(api, "truncated.json");
    expect(res.code).toBe(3);
    const out = readOutput("truncated.json");
    expect(out.warnings.map((w) => w.code)).toContain("ALEPH_MESSAGES_TRUNCATED");
    expect(out.complete).toBe(false);
  }, 30_000);

  it("an unreachable API exits 20 and writes nothing", async () => {
    const res = await recover("http://127.0.0.1:1", "unreachable.json");
    expect(res.code).toBe(20);
    expect(existsSync(join(dir, "unreachable.json"))).toBe(false);
  }, 30_000);

  it("--from-export recovers from a file with the network API unreachable", async () => {
    const file = join(dir, "export.ndjson");
    const lines = [await projectAggregate(), await deploymentPost()].map((m) => exportLine(m));
    writeFileSync(file, lines.map((l) => `${l}\n`).join(""));
    const res = await recover("http://127.0.0.1:1", "from-export.json", [
      "--from-export", file, "--verbose",
    ]);
    expect(res.code).toBe(0);
    expect(res.stderr.split("\n")[0]).toBe(
      `[recover] Reading messages from the export at ${file} (channel ${CHANNEL})`,
    );
    const out = readOutput("from-export.json");
    expect(out.complete).toBe(true);
    expect(out.alephApiUrl).toBe("http://127.0.0.1:1");
    expect(out.projects.map((p) => p.id)).toEqual(["p1"]);
    expect(out.projects[0]?.deployments[0]?.storeStatus).toBe("absent");
  }, 30_000);

  it("--from-export on a missing path exits 21 and writes nothing", async () => {
    const res = await recover("http://127.0.0.1:1", "no-export.json", [
      "--from-export", join(dir, "nope.ndjson"),
    ]);
    expect(res.code).toBe(21);
    expect(res.stderr).toContain("error: cannot read the export at ");
    expect(existsSync(join(dir, "no-export.json"))).toBe(false);
  }, 30_000);

  it("a key that does not derive --address exits 12", async () => {
    const res = await runCli([
      "--address", DELEGATE.address, "--output", join(dir, "wrong.json"),
    ]);
    expect(res.code).toBe(12);
  }, 30_000);
});

describe("bundle CLI", () => {
  let dir: string;
  const closers: Array<() => Promise<void>> = [];
  let rawCalls = 0;
  const served = new Map<string, Buffer>();

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "bundle-cli-"));
  });

  afterAll(async () => {
    for (const close of closers) await close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function setup(
    served1: Buffer,
    opts: { bundleHash?: string; pubkey?: string } = {},
  ): Promise<{ from: string; api: string }> {
    const ccn = await startStubCcn({
      messages: () => ({ messages: [] }),
      raw: (hash) => {
        rawCalls++;
        return served.get(hash) ?? null;
      },
    });
    closers.push(ccn.close);
    served.set("bafybundle", served1);
    const derived = await deriveEncryptionKey(Buffer.from("11".repeat(32), "hex"));
    const file = {
      schemaVersion: 4,
      alephApiUrl: ccn.url,
      encryptionKey: { pubkey: opts.pubkey ?? encryptionPubkeyOf(derived), scheme: "x" },
      projects: [
        {
          deployments: [
            {
              id: "d1",
              cid: "bafybundle",
              bundleHash: opts.bundleHash ?? createHash("sha256").update(served1).digest("hex"),
            },
          ],
        },
      ],
      deletedProjects: [],
    };
    const from = join(dir, `rec-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(from, JSON.stringify(file));
    return { from, api: ccn.url };
  }

  async function sealed(plaintext: Buffer, kind = "stasho-bundle"): Promise<Buffer> {
    const derived = await deriveEncryptionKey(Buffer.from("11".repeat(32), "hex"));
    const dek = randomBytes(32);
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", dek, iv);
    const ct = Buffer.concat([c.update(plaintext), c.final()]);
    return Buffer.from(
      JSON.stringify({
        v: 1,
        kind,
        alg: "aes-256-gcm",
        ct: ct.toString("base64"),
        iv: iv.toString("base64"),
        tag: c.getAuthTag().toString("base64"),
        deks: {
          encryption: Buffer.from(eciesEncrypt(encryptionPubkeyOf(derived), dek)).toString("base64"),
        },
      }),
    );
  }

  function bundle(from: string, out: string, id = "d1"): Promise<CliResult> {
    return runCli(["bundle", "--from", from, "--deployment", id, "--output", join(dir, out)]);
  }

  it("writes the decrypted bytes at mode 0600 and exits 0", async () => {
    const plaintext = randomBytes(4096);
    const { from } = await setup(await sealed(plaintext));
    const res = await bundle(from, "ok.tar.gz");
    expect(res.code).toBe(0);
    expect(readFileSync(join(dir, "ok.tar.gz")).equals(plaintext)).toBe(true);
    expect(statSync(join(dir, "ok.tar.gz")).mode & 0o777).toBe(0o600);
    expect(res.stderr).toContain("[recover] Wrote bundle for d1 (4096 bytes, sha256 ");
  }, 30_000);

  it("a hash mismatch exits 30 and prints both digests", async () => {
    const { from } = await setup(await sealed(Buffer.from("x")), { bundleHash: "ab".repeat(32) });
    const res = await bundle(from, "bad-hash.tar.gz");
    expect(res.code).toBe(30);
    expect(res.stderr).toContain("ab".repeat(32));
    expect(existsSync(join(dir, "bad-hash.tar.gz"))).toBe(false);
  }, 30_000);

  it("a different encryption key exits 31 before any fetch", async () => {
    const other = encryptionPubkeyOf(Buffer.from("22".repeat(32), "hex"));
    const { from } = await setup(await sealed(Buffer.from("x")), { pubkey: other });
    rawCalls = 0;
    const res = await bundle(from, "bad-key.tar.gz");
    expect(res.code).toBe(31);
    expect(res.stderr).toContain(other);
    expect(rawCalls).toBe(0);
  }, 30_000);

  it("an unknown deployment exits 32", async () => {
    const { from } = await setup(await sealed(Buffer.from("x")));
    const res = await bundle(from, "unknown.tar.gz", "nope");
    expect(res.code).toBe(32);
    expect(res.stderr).toContain("nope");
  }, 30_000);

  it("a JSON envelope of another kind exits 33", async () => {
    const { from } = await setup(await sealed(Buffer.from("x"), "x"));
    const res = await bundle(from, "bad-env.tar.gz");
    expect(res.code).toBe(33);
  }, 30_000);
});

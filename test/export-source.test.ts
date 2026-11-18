import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportFetcher, forgetsByTarget, loadExport } from "../src/export-source.js";
import type { ExportMessage, ExportSet } from "../src/export-source.js";
import { runRecover } from "../src/run.js";
import type { RecoverArgs } from "../src/run.js";
import type { AlephMessage, RecoveryOutput } from "../src/types.js";
import { Wallet } from "ethers";
import { encryptForTest } from "./helpers/envelope.js";
import { PREFIXLESS_MESSAGES, flipped } from "./helpers/prefixless-messages.js";
import {
  DELEGATE,
  SESSION_KEY,
  WALLET,
  exportLine,
  signedMessage,
} from "./helpers/signed-message.js";

const CHANNEL = "STASHO_CHANNEL_V1";
const USER_PRIV = Buffer.from("11".repeat(32), "hex");
const UNPROVEN = "EXPORT_COMPLETENESS_UNPROVEN";

let dir: string;
let n = 0;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "recover-export-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeExport(lines: string[], name = `e${++n}.ndjson`): string {
  const file = join(dir, name);
  writeFileSync(file, lines.map((l) => `${l}\n`).join(""));
  return file;
}

function load(lines: string[]): Promise<ExportSet> {
  return loadExport(writeExport(lines), CHANNEL);
}

function projectAggregate(framework = "nextjs-static"): Promise<AlephMessage> {
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
            framework,
            deployTarget: "ipfs",
            createdAt: "2026-11-01T00:00:00.000Z",
            updatedAt: "2026-11-01T00:00:00.000Z",
            deleted: false,
          },
          encrypted: encryptForTest({ name: "site", source: "github" }),
        },
      },
      time: 1712620800,
    },
  });
}

/** A valid line on the channel, so a run reaches reconstruct instead of exiting 21. */
function security(): Promise<AlephMessage> {
  return signedMessage(WALLET, {
    type: "AGGREGATE",
    channel: CHANNEL,
    content: {
      address: WALLET.address,
      key: "security",
      content: { authorizations: [], encryptionKey: { pubkey: "0x04", scheme: "x" } },
      time: 1712600000,
    },
  });
}

function deploymentPost(storeRef: string): Promise<AlephMessage> {
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
          storeRef,
          url: null,
          createdAt: "2026-11-01T00:30:00.000Z",
          finishedAt: null,
        },
        encrypted: encryptForTest({ commit: "abc1234" }),
      },
      time: 1712622600,
    },
  });
}

type AnyLine = Parameters<typeof exportLine>[0];

/** A delegate-signed amend for the wallet, as Query B would fetch it. */
function delegateAmend(): Promise<AlephMessage> {
  return signedMessage(DELEGATE, {
    type: "POST",
    channel: CHANNEL,
    content: {
      address: WALLET.address,
      type: "amend",
      ref: "parent",
      content: { deploymentId: "d1", projectId: "p1" },
      time: 1712622650,
    },
  });
}

/** The line as JSON, with `patch` applied on top. */
function patched(m: AlephMessage, patch: Record<string, unknown>): string {
  return JSON.stringify({ ...(JSON.parse(exportLine(m)) as object), ...patch });
}

function tamperedLine(m: AlephMessage): string {
  const tampered = m.item_content?.replace("nextjs-static", "nextjs-statid") ?? "";
  return patched(m, { item_content: tampered });
}

function args(fromExport: string, output = join(dir, `out${++n}.json`)): RecoverArgs {
  return {
    address: WALLET.address,
    output,
    channel: CHANNEL,
    alephApi: "https://api.example.invalid",
    verbose: false,
    fromExport,
  };
}

async function recover(
  path: string,
  opts: { output?: string; verbose?: boolean } = {},
): Promise<{ exitCode: number; output: RecoveryOutput | null; stderr: string[] }> {
  const stderr: string[] = [];
  const noNetwork: typeof fetch = () => {
    throw new Error("the export path made a network request");
  };
  const result = await runRecover(
    { ...args(path, opts.output), verbose: opts.verbose ?? false },
    USER_PRIV,
    {
      fetchImpl: noNetwork,
      stderr: (line) => stderr.push(line),
      now: () => new Date("2026-11-18T00:00:00.000Z"),
    },
  );
  return { ...result, stderr };
}

function codes(output: RecoveryOutput | null): string[] {
  return output?.warnings.map((w) => w.code) ?? [];
}

describe("loadExport: lines this run can use are checked", () => {
  it("rejects a line whose item_content had one byte changed", async () => {
    const m = await projectAggregate();
    const set = await load([tamperedLine(m)]);
    expect(set.messages).toEqual([]);
    expect(set.dropped).toEqual([
      expect.objectContaining({
        code: "EXPORT_LINE_REJECTED",
        line: 1,
        reason: "content hash mismatch",
        itemHash: m.item_hash,
      }),
    ]);
  });

  it("rejects a line signed by a different key", async () => {
    const m = await projectAggregate();
    const forged = await DELEGATE.signMessage(["ETH", m.sender, m.type, m.item_hash].join("\n"));
    const set = await load([patched(m, { signature: forged })]);
    expect(set.messages).toEqual([]);
    expect(set.dropped[0]?.reason).toBe("signature does not recover sender");
  });

  it("keeps the parsed item_content, never the line's content field", async () => {
    const m = await projectAggregate("nextjs-static");
    const altered = { ...m.content, key: "security", address: DELEGATE.address };
    const set = await load([patched(m, { content: altered })]);
    expect(set.dropped).toEqual([]);
    expect(set.messages[0]?.content).toEqual(JSON.parse(m.item_content ?? ""));
  });

  it("rejects a non-JSON line and a truncated last line, naming the cause", async () => {
    const line = exportLine(await projectAggregate());
    const file = join(dir, "causes.ndjson");
    writeFileSync(file, `not json at all\n\n${line}\n${line.slice(0, 40)}`);
    const set = await loadExport(file, CHANNEL);
    expect(set.messages).toHaveLength(1);
    expect(set.dropped.map((d) => [d.code, d.file, d.line, d.reason])).toEqual([
      ["EXPORT_LINE_REJECTED", "causes.ndjson", 1, "not valid JSON"],
      [
        "EXPORT_LINE_REJECTED",
        "causes.ndjson",
        4,
        "not valid JSON (truncated last line: the file does not end with a newline)",
      ],
    ]);
  });

  it("skips a non-inline line and a non-ETH line: they cannot be checked", async () => {
    const m = await projectAggregate();
    const set = await load([
      patched(m, { item_type: "storage", item_content: null }),
      patched(m, { chain: "SOL" }),
    ]);
    expect(set.messages).toEqual([]);
    expect(set.dropped.map((d) => [d.code, d.reason])).toEqual([
      ["EXPORT_LINE_SKIPPED", 'item_type "storage" cannot be checked, only inline'],
      ["EXPORT_LINE_SKIPPED", 'chain "SOL" cannot be checked, only ETH'],
    ]);
  });

  it("keeps a message on no channel; it is never listed for --channel", async () => {
    const forget = await signedMessage(WALLET, {
      type: "FORGET",
      channel: CHANNEL,
      content: { address: WALLET.address, hashes: ["x"], time: 1 },
    });
    const set = await load([
      JSON.stringify({ ...(JSON.parse(exportLine(forget)) as object), channel: null }),
    ]);
    expect(set.dropped).toEqual([]);
    expect(set.messages.map((m) => m.channel)).toEqual([null]);
  });

  it("rejects a missing field, a channel of the wrong type and a non-object line", async () => {
    const m = await projectAggregate();
    const badChannel = patched(m, { type: "STORE", channel: 7 });
    const set = await load([patched(m, { sender: 7 }), badChannel, "[1]"]);
    expect(set.dropped.map((d) => d.reason)).toEqual([
      "field sender is missing or not a string",
      "field channel is not a string or null",
      "not a JSON object",
    ]);
  });

  it("rejects an item_content that is not a JSON object", async () => {
    const m = await signedMessage(WALLET, {
      type: "POST",
      channel: CHANNEL,
      content: [1] as unknown as AlephMessage["content"],
    });
    expect((await load([exportLine(m)])).dropped[0]?.reason).toBe("content is not an object");
  });

  it("reads lines on other channels as unused, except STOREs and FORGETs", async () => {
    const m = await projectAggregate();
    const drops = "STASHO_DROPS_V1";
    const store = await signedMessage(WALLET, {
      type: "STORE",
      channel: drops,
      content: { address: WALLET.address, item_type: "ipfs", item_hash: "bafy", time: 2 },
    });
    const set = await load([
      patched(m, { channel: drops }),
      tamperedLine(m).replace(CHANNEL, drops),
      patched(m, { channel: drops, chain: "SOL" }),
      exportLine(store),
    ]);
    expect([set.linesRead, set.unused]).toEqual([4, 3]);
    expect(set.dropped).toEqual([]);
    expect(set.messages.map((x) => x.item_hash)).toEqual([store.item_hash]);
  });

  it("strips a leading byte-order mark", async () => {
    const file = join(dir, "bom.ndjson");
    writeFileSync(file, `\uFEFF${exportLine(await projectAggregate())}\n`);
    const set = await loadExport(file, CHANNEL);
    expect([set.messages.length, set.dropped.length]).toEqual([1, 0]);
  });

  it("reads every .ndjson of a directory in name order, a duplicate once", async () => {
    const sub = join(dir, "nightly");
    mkdirSync(sub);
    const a = await projectAggregate();
    const b = await deploymentPost("s1");
    writeFileSync(join(sub, "2026-11-02.ndjson"), `${exportLine(b)}\n${exportLine(a)}\n`);
    writeFileSync(join(sub, "2026-11-01.ndjson"), `${exportLine(a)}\n`);
    writeFileSync(join(sub, "notes.txt"), "not an export\n");
    const set = await loadExport(sub, CHANNEL);
    expect(set.messages.map((m) => m.item_hash)).toEqual([a.item_hash, b.item_hash]);
    expect(set.dropped).toEqual([]);
  });
});

describe("forgetsByTarget", () => {
  it("indexes a FORGET repeating one hash 40,000 times in linear time, once per target", () => {
    const forget: ExportMessage = {
      type: "FORGET",
      channel: CHANNEL,
      chain: "ETH",
      sender: WALLET.address,
      signature: "0x",
      item_hash: "f",
      item_type: "inline",
      item_content: "{}",
      content: { hashes: [...Array<string>(40_000).fill("h"), "other", 7] },
      time: 0,
    };
    const started = performance.now();
    const byTarget = forgetsByTarget([forget, forget]);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(byTarget.get("h")).toEqual([forget, forget]);
    expect([...byTarget.keys()]).toEqual(["h", "other"]);
  });
});

describe("exportFetcher", () => {
  it("returns only the asked channel, type and senders, checksummed or not", async () => {
    const mine = await deploymentPost("s1");
    const elsewhere = await signedMessage(WALLET, {
      type: "POST",
      channel: "STASHO_DROPS_V1",
      content: { ...mine.content, time: 1712622601 },
    });
    const otherType = await signedMessage(WALLET, {
      type: "POST",
      channel: CHANNEL,
      content: { ...mine.content, type: "stasho-terms", time: 1712622602 },
    });
    const lines = [mine, elsewhere, otherType, await projectAggregate()].map((m) => exportLine(m));
    const fetcher = exportFetcher(await load(lines), CHANNEL);
    const lower = [WALLET.address.toLowerCase()];
    const posts = await fetcher({ messageType: "POST", addresses: lower });
    expect(posts.messages.map((m) => m.item_hash)).toEqual([mine.item_hash]);
    expect(posts.truncated).toBeNull();
    const none = await fetcher({ messageType: "POST", addresses: [DELEGATE.address] });
    expect(none.messages).toEqual([]);
  });

  describe("a FORGET hides a message only from its sender, its owner or a queried sender", () => {
    const stranger = new Wallet(`0x${"55".repeat(32)}`);
    const forgetBy = (signer: Wallet, hashes: string[]) =>
      signedMessage(signer, {
        type: "FORGET",
        channel: CHANNEL,
        content: { address: signer.address, hashes, time: 1712622700 },
      });
    const query = async (lines: AnyLine[], messageType: "AGGREGATE" | "POST", who: Wallet[]) => {
      const fetcher = exportFetcher(await load(lines.map((m) => exportLine(m))), CHANNEL);
      const res = await fetcher({ messageType, addresses: who.map((w) => w.address) });
      return res.messages.map((m) => m.item_hash);
    };

    it("a stranger's FORGET hides neither the wallet's aggregate nor an amend", async () => {
      const agg = await projectAggregate();
      const amend = await delegateAmend();
      const forged = await forgetBy(stranger, [agg.item_hash, amend.item_hash]);
      expect(await query([agg, forged], "AGGREGATE", [WALLET])).toEqual([agg.item_hash]);
      expect(await query([amend, forged], "POST", [DELEGATE])).toEqual([amend.item_hash]);
    });

    it("the message's own sender's FORGET hides it", async () => {
      const amend = await delegateAmend();
      const own = await forgetBy(DELEGATE, [amend.item_hash]);
      expect(await query([amend, own], "POST", [DELEGATE])).toEqual([]);
    });

    it("the owner's FORGET hides a delegate-signed message", async () => {
      const amend = await delegateAmend();
      const byOwner = await forgetBy(WALLET, [amend.item_hash]);
      expect(await query([amend, byOwner], "POST", [DELEGATE])).toEqual([]);
    });

    it("in a Query B call, another queried sender's FORGET hides it", async () => {
      const amend = await delegateAmend();
      const byNewer = await forgetBy(SESSION_KEY, [amend.item_hash]);
      expect(await query([amend, byNewer], "POST", [DELEGATE, SESSION_KEY])).toEqual([]);
      expect(await query([amend, byNewer], "POST", [DELEGATE])).toEqual([amend.item_hash]);
    });
  });
});

describe("signatures without the 0x prefix in an export", () => {
  it("two real lines api2 lists are kept, and rejected with one hex digit changed", async () => {
    const lines = PREFIXLESS_MESSAGES.map((m) => JSON.stringify(m));
    const set = await loadExport(writeExport(lines), "TEST");
    expect(set.dropped).toEqual([]);
    expect(set.messages.map((m) => m.item_hash)).toEqual(
      PREFIXLESS_MESSAGES.map((m) => m.item_hash),
    );
    const bad = PREFIXLESS_MESSAGES.map((m) =>
      JSON.stringify({ ...m, signature: flipped(m.signature) }),
    );
    const rejected = await loadExport(writeExport(bad), "TEST");
    expect(rejected.messages).toEqual([]);
    expect(rejected.dropped.map((d) => d.reason)).toEqual([
      "signature does not recover sender",
      "signature does not recover sender",
    ]);
  });
});

describe("runRecover --from-export", () => {
  it("recovers without one network request and says where it read from", async () => {
    const store = await signedMessage(WALLET, {
      type: "STORE",
      channel: CHANNEL,
      content: { address: WALLET.address, item_type: "ipfs", item_hash: "bafycid1", time: 1 },
    });
    const lines = [await projectAggregate(), await deploymentPost(store.item_hash), store];
    const res = await recover(writeExport(lines.map((m) => exportLine(m))));
    expect(res.exitCode).toBe(0);
    expect(res.output?.complete).toBe(true);
    expect(res.output?.alephApiUrl).toBe("https://api.example.invalid");
    expect(res.output?.stats.exportLinesRejected).toBe(0);
    expect(res.output?.projects[0]?.deployments[0]?.cid).toBe("bafycid1");
  });

  it("warns first, on every run, that an export cannot prove it is complete", async () => {
    const res = await recover(writeExport([exportLine(await projectAggregate())]));
    expect(res.output?.warnings[0]).toEqual({
      code: UNPROVEN,
      detail:
        "Read from an export. Signatures prove each record is genuine, not that the export holds " +
        "every record: a missing file or line cannot be detected.",
    });
    expect(res.output?.complete).toBe(true);
  });

  it("prints the export path, then the line counts, as its first verbose lines", async () => {
    const m = await projectAggregate();
    const file = writeExport([exportLine(m), patched(m, { channel: "STASHO_TERMS_V1" })]);
    const res = await recover(file, { verbose: true });
    expect(res.stderr.slice(0, 2)).toEqual([
      `[recover] Reading messages from the export at ${file} (channel ${CHANNEL})`,
      "[recover] Read 2 lines, 1 on other channels not used",
    ]);
  });

  it("a tampered line is EXPORT_LINE_REJECTED, exit 3, and its record is left out", async () => {
    const m = await projectAggregate();
    const file = writeExport([exportLine(await security()), tamperedLine(m)], "tampered.ndjson");
    const res = await recover(file);
    expect(res.exitCode).toBe(3);
    expect(res.output?.complete).toBe(false);
    expect(res.output?.projects).toEqual([]);
    expect(res.output?.stats.exportLinesRejected).toBe(1);
    expect(res.output?.warnings.slice(0, 2)).toEqual([
      expect.objectContaining({ code: UNPROVEN }),
      {
        code: "EXPORT_LINE_REJECTED",
        detail: "tampered.ndjson:2: content hash mismatch",
        messageHash: m.item_hash,
      },
    ]);
    expect(res.stderr.at(-1)).toContain("1 rejected export lines (exit 3)");
  });

  it("a forged signature is EXPORT_LINE_REJECTED, exit 3, and its record is left out", async () => {
    const m = await projectAggregate();
    const forged = await DELEGATE.signMessage(["ETH", m.sender, m.type, m.item_hash].join("\n"));
    const lines = [exportLine(await security()), patched(m, { signature: forged })];
    const res = await recover(writeExport(lines));
    expect(res.exitCode).toBe(3);
    expect(res.output?.projects).toEqual([]);
    expect(codes(res.output)).toContain("EXPORT_LINE_REJECTED");
  });

  it("a skipped line leaves the run complete, exit 0", async () => {
    const m = await projectAggregate();
    const res = await recover(writeExport([exportLine(m), patched(m, { chain: "SOL" })]));
    expect(res.exitCode).toBe(0);
    expect(res.output?.complete).toBe(true);
    expect(codes(res.output)).toEqual([UNPROVEN, "EXPORT_LINE_SKIPPED"]);
    expect(res.output?.stats.exportLinesRejected).toBe(0);
    expect(res.output?.projects.map((p) => p.id)).toEqual(["p1"]);
  });

  it("recovers from item_content when the line's content field was altered", async () => {
    const m = await projectAggregate("nextjs-static");
    const altered = JSON.parse(JSON.stringify(m.content)) as {
      content: { p1: { public: { framework: string } } };
    };
    altered.content.p1.public.framework = "altered";
    const store = await signedMessage(WALLET, {
      type: "STORE",
      channel: CHANNEL,
      content: { address: WALLET.address, item_type: "ipfs", item_hash: "bafyreal", time: 1 },
    });
    const storeLine = JSON.stringify({
      ...(JSON.parse(exportLine(store)) as object),
      content: { ...store.content, item_hash: "bafyswapped", item_type: "storage" },
    });
    const lines = [
      patched(m, { content: altered }),
      exportLine(await deploymentPost(store.item_hash)),
      storeLine,
    ];
    const res = await recover(writeExport(lines));
    expect(res.exitCode).toBe(0);
    expect(res.output?.projects[0]?.framework).toBe("nextjs-static");
    const dep = res.output?.projects[0]?.deployments[0];
    expect([dep?.cid, dep?.artifactKind]).toEqual(["bafyreal", "ipfs"]);
  });

  it("an export with no verified message on the channel exits 21 and writes nothing", async () => {
    const m = await projectAggregate();
    const cases: Array<[string[], string]> = [
      [[], ""],
      [[patched(m, { channel: "STASHO_TERMS_V1" })], ""],
      [[tamperedLine(m), "not json"], " that passed its checks (2 lines rejected)"],
    ];
    for (const [lines, why] of cases) {
      const file = writeExport(lines);
      const output = join(dir, `none${++n}.json`);
      const res = await recover(file, { output });
      expect(res.exitCode).toBe(21);
      expect(existsSync(output)).toBe(false);
      expect(res.stderr).toEqual([
        `error: the export at ${file} holds no message on channel ${CHANNEL}${why}`,
      ]);
    }
  });

  it("a FORGET it could not check never says the bytes are gone; a trusted one does", async () => {
    const stranger = new Wallet(`0x${"55".repeat(32)}`);
    const forgetBy = (signer: Wallet) =>
      signedMessage(signer, {
        type: "FORGET",
        channel: CHANNEL,
        content: { address: signer.address, hashes: ["deleted_store"], time: 1712630000 },
      });
    const base = [await projectAggregate(), await deploymentPost("deleted_store")];
    const forgottenDetail = async (signer: Wallet): Promise<string[]> => {
      const lines = [...base, await forgetBy(signer)].map((m) => exportLine(m));
      const res = await recover(writeExport(lines));
      expect(res.exitCode).toBe(0);
      expect(res.output?.projects[0]?.deployments[0]?.storeStatus).toBe("forgotten");
      const warnings = res.output?.warnings ?? [];
      return warnings.filter((w) => w.code === "STORE_FORGOTTEN").map((w) => w.detail);
    };
    const doctored = await forgottenDetail(stranger);
    expect(doctored).toEqual([
      "Deployment d1: STORE deleted_store reads forgotten per an unverified FORGET in the " +
        "export (the bytes may still exist)",
    ]);
    expect(doctored.join()).not.toContain("bytes are gone");
    expect(await forgottenDetail(WALLET)).toEqual([
      "Deployment d1: STORE deleted_store was FORGOTten on the network (bytes are gone)",
    ]);
  });

  it("a missing path exits 21 and writes nothing", async () => {
    const output = join(dir, "missing-out.json");
    const missing = join(dir, "no-such-export");
    const res = await recover(missing, { output });
    expect(res.exitCode).toBe(21);
    expect(res.output).toBeNull();
    expect(existsSync(output)).toBe(false);
    expect(res.stderr).toEqual([
      expect.stringMatching(new RegExp(`^error: cannot read the export at ${missing}: ENOENT`)),
    ]);
  });

  it("a directory with no .ndjson exits 21 and writes nothing", async () => {
    const empty = join(dir, "empty-dir");
    mkdirSync(empty);
    writeFileSync(join(empty, "readme.txt"), "x");
    const output = join(dir, "empty-out.json");
    const res = await recover(empty, { output });
    expect(res.exitCode).toBe(21);
    expect(existsSync(output)).toBe(false);
    expect(res.stderr).toEqual([
      `error: cannot read the export at ${empty}: the directory holds no .ndjson file`,
    ]);
  });

  it("an unreadable .ndjson inside the directory exits 21", async () => {
    const parent = join(dir, "with-subdir");
    mkdirSync(join(parent, "2026-11-01.ndjson"), { recursive: true });
    const res = await recover(parent);
    expect(res.exitCode).toBe(21);
    expect(res.stderr[0]).toContain("2026-11-01.ndjson: EISDIR");
  });

  it("writes the same file shape as the live path", async () => {
    const output = join(dir, "shape.json");
    await recover(writeExport([exportLine(await projectAggregate())]), { output });
    const written = JSON.parse(readFileSync(output, "utf8")) as RecoveryOutput;
    expect(Object.keys(written).sort()).toEqual([
      "alephApiUrl",
      "channel",
      "complete",
      "deletedProjects",
      "encryptionKey",
      "projects",
      "recoveredAt",
      "schemaVersion",
      "stats",
      "wallet",
      "warnings",
    ]);
    expect(written.schemaVersion).toBe(4);
  });
});

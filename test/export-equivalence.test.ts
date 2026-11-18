import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "ethers";
import { runRecover } from "../src/run.js";
import type { AlephMessage, RecoveryOutput } from "../src/types.js";
import { ccnHolding, forgottenBy } from "./helpers/ccn-emulator.js";
import type { HeldMessage } from "./helpers/ccn-emulator.js";
import { encryptForTest } from "./helpers/envelope.js";
import {
  DELEGATE,
  SESSION_KEY,
  WALLET,
  exportLine,
  signedMessage,
} from "./helpers/signed-message.js";
import type { SignedRawMessage } from "./helpers/signed-message.js";
import { startStubCcn } from "./helpers/stub-ccn.js";

const USER_PRIV = Buffer.from("11".repeat(32), "hex");
const FIXTURE_DIR = join(import.meta.dirname, "fixtures/messages");
const FIXTURE_CHANNEL = "TEST-FIXTURES";
const CHANNEL = "STASHO_CHANNEL_V1";
const THIRD = "0xDEAD000000000000000000000000000000000000";
const DROPS = "STASHO_DROPS_V1";
const DROP_SIGNER = new Wallet(`0x${"66".repeat(32)}`);
const STRANGER = new Wallet(`0x${"55".repeat(32)}`);

type AnyMessage = AlephMessage | SignedRawMessage;

/** Warnings only the export path can give: what an export cannot prove or check. */
const EXPORT_ONLY = new Set([
  "EXPORT_COMPLETENESS_UNPROVEN",
  "STORE_FORGET_UNVERIFIED",
  "STORE_FORGET_IGNORED",
]);

const noNetwork: typeof fetch = () => {
  throw new Error("the export path made a network request");
};

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "recover-export-eq-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function timeOf(m: AnyMessage): number {
  const t = (m.content as { time?: unknown }).time;
  return typeof t === "number" ? t : 0;
}

/** What a CCN holding `held` lists, so what its export holds: never a forgotten message. */
function exportOf(held: AnyMessage[]): string[] {
  const forgotten = forgottenBy(held as HeldMessage[]);
  return held.filter((m) => !forgotten.has(m.item_hash)).map((m) => exportLine(m, timeOf(m)));
}

interface Both {
  live: RecoveryOutput;
  fromExport: RecoveryOutput | null;
  liveCode: number;
  code: number;
  stderr: string[];
}

/** Run recovery against a stub CCN holding `held`, then against `lines` (its export). */
async function runBoth(
  name: string,
  held: AnyMessage[],
  channel: string,
  lines: string[] = exportOf(held),
): Promise<Both> {
  const ccn = await startStubCcn(ccnHolding(held as HeldMessage[]));
  const file = join(dir, `${name}.ndjson`);
  writeFileSync(file, lines.map((l) => `${l}\n`).join(""));
  const base = { address: WALLET.address, channel, alephApi: ccn.url, verbose: false };
  const stderr: string[] = [];
  const deps = {
    stderr: (line: string) => stderr.push(line),
    now: () => new Date("2026-11-18T00:00:00.000Z"),
  };
  try {
    const live = await runRecover(
      { ...base, output: join(dir, `${name}.live.json`) },
      USER_PRIV,
      { ...deps, fetchImpl: fetch },
    );
    stderr.length = 0;
    const exp = await runRecover(
      { ...base, output: join(dir, `${name}.export.json`), fromExport: file },
      USER_PRIV,
      { ...deps, fetchImpl: noNetwork },
    );
    if (live.output === null) throw new Error(`${name}: no live output`);
    const codes = { liveCode: live.exitCode, code: exp.exitCode };
    return { live: live.output, fromExport: exp.output, ...codes, stderr };
  } finally {
    await ccn.close();
  }
}

/** An output without `recoveredAt` and the export-only warnings, so the two paths compare. */
function comparable(o: RecoveryOutput | null): unknown {
  if (o === null) throw new Error("the export path wrote no output");
  const { recoveredAt: _ignored, ...rest } = o;
  const warnings = o.warnings.filter((w) => !EXPORT_ONLY.has(w.code));
  return { ...rest, warnings, stats: { ...o.stats, warnings: warnings.length } };
}

function escape(text: string): string {
  return text.replace(/[()]/g, "\\$&");
}

const UNVERIFIED_WORDING =
  "reads forgotten per an unverified FORGET in the export (the bytes may still exist)";
const LIVE_WORDING = "was FORGOTten on the network (bytes are gone)";

/** The export's wording for a FORGET it could not check, replaced by the live one to compare. */
function liveWorded(o: RecoveryOutput | null): RecoveryOutput | null {
  if (o === null) return null;
  const warnings = o.warnings.map((w) => ({
    ...w,
    detail: w.detail.replace(UNVERIFIED_WORDING, LIVE_WORDING),
  }));
  return { ...o, warnings };
}

function forgottenDetails(o: RecoveryOutput | null): string[] {
  return (o?.warnings ?? []).filter((w) => w.code === "STORE_FORGOTTEN").map((w) => w.detail);
}

function exportOnlyCodes(o: RecoveryOutput | null): string[] {
  return (o?.warnings ?? []).filter((w) => EXPORT_ONLY.has(w.code)).map((w) => w.code);
}

interface Fixture {
  messages: AlephMessage[];
  testKeys: { delegateAddress: string };
}

function readFixture(name: string): Fixture {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), "utf8")) as Fixture;
}

function expectedProjectCount(name: string): number {
  const raw = readFileSync(join(FIXTURE_DIR, `${name}.expected.json`), "utf8");
  const expected = JSON.parse(raw) as { projects?: unknown[]; projectCount?: number };
  return expected.projectCount ?? expected.projects?.length ?? 0;
}

const FIXTURES = readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith(".json") && !f.endsWith(".expected.json"))
  .map((f) => f.slice(0, -".json".length))
  .sort();

/**
 * The vendored messages carry no `chain` or `item_content`, but their `item_hash` is the sha256 of
 * `JSON.stringify(content)` and their signatures are over chain `ETH`, so both can be restored.
 */
function completed(m: AlephMessage): AlephMessage {
  return { ...m, chain: "ETH", item_content: JSON.stringify(m.content) };
}

/** The fixtures have no security aggregate, so nothing would fetch their delegate's POSTs. */
function authorize(delegate: string, channel: string): Promise<AlephMessage> {
  return signedMessage(WALLET, {
    type: "AGGREGATE",
    channel,
    content: {
      address: WALLET.address,
      key: "security",
      content: { authorizations: [{ address: delegate }] },
      time: 1712600000,
    },
  });
}

const RAW_TITLE = "%s: live recovers no project; the export holds no verified message, exit 21";

describe("vendored fixtures, as vendored (no item_content): no record on either path", () => {
  it.each(FIXTURES)(RAW_TITLE, async (name) => {
    const fixture = readFixture(name);
    const lines = fixture.messages.map((m) => JSON.stringify(m));
    const r = await runBoth(`raw-${name}`, fixture.messages, FIXTURE_CHANNEL, lines);
    expect(r.live.projects).toEqual([]);
    const untrusted = r.live.warnings.filter((w) => w.code === "UNTRUSTED_MESSAGE");
    expect(untrusted.length > 0).toBe(fixture.messages.length > 0);
    expect(r.code).toBe(21);
    expect(r.fromExport).toBeNull();
    const count = fixture.messages.length;
    const why = count > 0 ? ` that passed its checks (${count} lines rejected)` : "";
    expect(r.stderr).toEqual([
      expect.stringMatching(new RegExp(`holds no message on channel TEST-FIXTURES${escape(why)}$`)),
    ]);
  }, 30_000);
});

describe("vendored fixtures with chain and item_content restored: outputs deep-equal", () => {
  it.each(FIXTURES)("%s: export equals live but for recoveredAt and UNPROVEN", async (name) => {
    const fixture = readFixture(name);
    const messages = [
      await authorize(fixture.testKeys.delegateAddress, FIXTURE_CHANNEL),
      ...fixture.messages.map(completed),
    ];
    const r = await runBoth(`signed-${name}`, messages, FIXTURE_CHANNEL);
    expect(comparable(r.fromExport)).toEqual(comparable(r.live));
    expect(exportOnlyCodes(r.fromExport)).toEqual(["EXPORT_COMPLETENESS_UNPROVEN"]);
    expect(r.code).toBe(r.liveCode);
    expect(r.live.projects).toHaveLength(expectedProjectCount(name));
    expect(r.live.warnings.map((w) => w.code)).not.toContain("UNTRUSTED_MESSAGE");
  }, 30_000);
});

// ─── A richer wallet: delegate + session key, amends, STOREs and FORGETs ─────────────────────

const deploymentPublic = (storeRef: string | null, url: string | null, status = "queued") => ({
  status,
  storeRef,
  url,
  createdAt: "2026-11-01T00:30:00.000Z",
  finishedAt: null,
});

function store(cid: string, time: number, channel = CHANNEL): Promise<SignedRawMessage> {
  return signedMessage(DELEGATE, {
    type: "STORE",
    channel,
    content: { address: WALLET.address, item_type: "ipfs", item_hash: cid, time },
  });
}

function deployment(
  id: string,
  projectId: string,
  pub: Record<string, unknown>,
  time: number,
): Promise<AlephMessage> {
  return signedMessage(DELEGATE, {
    type: "POST",
    channel: CHANNEL,
    content: {
      address: WALLET.address,
      type: "aleph-cloud-deployment",
      content: {
        deploymentId: id,
        projectId,
        schemaVersion: 1,
        public: pub,
        encrypted: encryptForTest({ commit: `c-${id}`, branch: "main" }),
      },
      time,
    },
  });
}

function amend(
  signer: typeof DELEGATE,
  parent: AlephMessage,
  pub: Record<string, unknown>,
  time: number,
): Promise<AlephMessage> {
  const inner = parent.content.content as Record<string, unknown>;
  return signedMessage(signer, {
    type: "POST",
    channel: CHANNEL,
    content: {
      address: WALLET.address,
      type: "amend",
      ref: parent.item_hash,
      content: { ...inner, public: pub },
      time,
    },
  });
}

function projects(address: string, ids: string[], time: number): Promise<AlephMessage> {
  const entries: Record<string, unknown> = {};
  for (const id of ids) {
    entries[id] = {
      id,
      schemaVersion: 1,
      public: {
        framework: "nextjs-static",
        deployTarget: "ipfs",
        createdAt: "2026-11-01T00:00:00.000Z",
        updatedAt: "2026-11-01T00:00:00.000Z",
        deleted: false,
      },
      encrypted: encryptForTest({ name: `site-${id}`, source: "github" }),
    };
  }
  return signedMessage(DELEGATE, {
    type: "AGGREGATE",
    channel: CHANNEL,
    content: { address, key: "projects", content: entries, time },
  });
}

function security(): Promise<AlephMessage> {
  return signedMessage(WALLET, {
    type: "AGGREGATE",
    channel: CHANNEL,
    content: {
      address: WALLET.address,
      key: "security",
      content: {
        authorizations: [{ address: DELEGATE.address }, { address: SESSION_KEY.address }],
        encryptionKey: { pubkey: `0x04${"aa".repeat(64)}`, scheme: "wallet-sig-v1" },
      },
      time: 1712600000,
    },
  });
}

/**
 * A drop STORE on the drops channel, owned by the drop signer the wallet never authorized, which
 * the signer forgot: the network honors that FORGET, and the export no longer holds the STORE.
 */
async function expiredDrop(): Promise<AnyMessage[]> {
  const drop = await signedMessage(DROP_SIGNER, {
    type: "STORE",
    channel: DROPS,
    content: { address: DROP_SIGNER.address, item_type: "ipfs", item_hash: "bafydrop", time: 1 },
  });
  const expired = await signedMessage(DROP_SIGNER, {
    type: "FORGET",
    channel: DROPS,
    content: { address: DROP_SIGNER.address, hashes: [drop.item_hash], time: 2 },
  });
  const dropUrl = "https://bafydrop.ipfs.aleph.sh";
  const d5 = await deployment("d5", "p2", deploymentPublic(drop.item_hash, dropUrl, "live"), 3);
  return [drop, expired, d5];
}

function storeHash(held: AnyMessage[], cid: string): string {
  const found = held.find((m) => m.type === "STORE" && m.content["item_hash"] === cid);
  if (found === undefined) throw new Error(`no STORE for ${cid}`);
  return found.item_hash;
}

/** Every outcome a STORE can have in an export, plus traffic the fetcher must leave out. */
async function richScenario(): Promise<{ held: AnyMessage[]; resolved: SignedRawMessage }> {
  const resolved = await store("bafyresolved", 1712610001);
  const forgottenWithTwin = await store("bafytwin", 1712610002);
  const twin = await store("bafytwin", 1712610003);
  const forgottenAlone = await store("bafygone", 1712610004);
  const forget = await signedMessage(DELEGATE, {
    type: "FORGET",
    channel: CHANNEL,
    content: {
      address: WALLET.address,
      hashes: [forgottenWithTwin.item_hash, forgottenAlone.item_hash],
      time: 1712610005,
    },
  });
  const d1 = await deployment("d1", "p1", deploymentPublic(resolved.item_hash, null), 1712620001);
  const d1a = await amend(
    SESSION_KEY,
    d1,
    deploymentPublic(resolved.item_hash, null, "building"),
    1712620002,
  );
  const d1b = await amend(
    DELEGATE,
    d1a,
    deploymentPublic(resolved.item_hash, "https://bafyresolved.ipfs.aleph.sh", "live"),
    1712620003,
  );
  const twinUrl = "https://bafytwin.ipfs.aleph.sh";
  const d2Pub = deploymentPublic(forgottenWithTwin.item_hash, twinUrl, "live");
  const d2 = await deployment("d2", "p1", d2Pub, 1712620004);
  const goneUrl = "https://bafygone.ipfs.aleph.sh";
  const gonePub = deploymentPublic(forgottenAlone.item_hash, goneUrl, "live");
  const d3 = await deployment("d3", "p2", gonePub, 1712620005);
  const d4 = await deployment("d4", "p2", deploymentPublic("never_stored", null), 1712620006);
  const otherWallet = await projects(THIRD, ["px"], 1712600003);
  const otherDeployment = await signedMessage(DELEGATE, {
    type: "POST",
    channel: CHANNEL,
    content: {
      address: THIRD,
      type: "aleph-cloud-deployment",
      content: { deploymentId: "dx", projectId: "px", schemaVersion: 1, public: {}, encrypted: {} },
      time: 1712620007,
    },
  });
  const otherChannel = await signedMessage(DELEGATE, {
    type: "POST",
    channel: "STASHO_DROPS_V1",
    content: { ...d4.content, time: 1712620008 },
  });
  const otherType = await signedMessage(DELEGATE, {
    type: "POST",
    channel: CHANNEL,
    content: { ...d4.content, type: "stasho-terms", time: 1712620009 },
  });
  const held = [
    await security(),
    await projects(WALLET.address, ["p1", "p2"], 1712600002),
    otherWallet,
    resolved,
    forgottenWithTwin,
    twin,
    forgottenAlone,
    forget,
    d1,
    d1a,
    d1b,
    d2,
    d3,
    d4,
    otherDeployment,
    otherChannel,
    otherType,
    ...(await expiredDrop()),
  ];
  return { held, resolved };
}

describe("a richer wallet: delegate, session key, amends, STOREs, FORGETs, shared delegate", () => {
  it("export equals live but for recoveredAt, UNPROVEN and the drop FORGET", async () => {
    const { held } = await richScenario();
    const r = await runBoth("rich", held, CHANNEL);
    expect(forgottenDetails(r.live).sort()).toEqual([
      `Deployment d3: STORE ${storeHash(held, "bafygone")} ${LIVE_WORDING}`,
      `Deployment d5: STORE ${storeHash(held, "bafydrop")} ${LIVE_WORDING}`,
    ]);
    expect(forgottenDetails(r.fromExport).sort()).toEqual([
      `Deployment d3: STORE ${storeHash(held, "bafygone")} ${LIVE_WORDING}`,
      `Deployment d5: STORE ${storeHash(held, "bafydrop")} ${UNVERIFIED_WORDING}`,
    ]);
    expect(comparable(liveWorded(r.fromExport))).toEqual(comparable(r.live));
    expect(exportOnlyCodes(r.fromExport)).toEqual([
      "EXPORT_COMPLETENESS_UNPROVEN",
      "STORE_FORGET_UNVERIFIED",
    ]);
    expect(r.code).toBe(0);
    const deployments = r.live.projects.flatMap((p) => p.deployments);
    const status = Object.fromEntries(deployments.map((d) => [d.id, [d.status, d.storeStatus]]));
    expect(status).toEqual({
      d1: ["live", "resolved"],
      d2: ["live", "content-match"],
      d3: ["live", "forgotten"],
      d4: ["queued", "absent"],
      d5: ["live", "forgotten"],
    });
    expect(r.live.projects.map((p) => p.id).sort()).toEqual(["p1", "p2"]);
  }, 30_000);

  it("a stranger's FORGET added to the export leaves a live STORE resolved", async () => {
    const { held, resolved } = await richScenario();
    const forged = await signedMessage(STRANGER, {
      type: "FORGET",
      channel: DROPS,
      content: { address: STRANGER.address, hashes: [resolved.item_hash], time: 1712630000 },
    });
    const r = await runBoth("forged", [...held, forged], CHANNEL);
    expect(comparable(liveWorded(r.fromExport))).toEqual(comparable(r.live));
    const d1 = r.fromExport?.projects.flatMap((p) => p.deployments).find((d) => d.id === "d1");
    expect(d1?.storeStatus).toBe("resolved");
    expect(exportOnlyCodes(r.fromExport)).toContain("STORE_FORGET_IGNORED");
    expect(r.code).toBe(0);
  }, 30_000);
});

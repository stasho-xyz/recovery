import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "ethers";
import { loadExport } from "../src/export-source.js";
import { exportStoreResolver } from "../src/export-stores.js";
import type { ExportStoreResolver } from "../src/export-stores.js";
import {
  DELEGATE,
  SESSION_KEY,
  WALLET,
  exportLine,
  signedMessage,
} from "./helpers/signed-message.js";
import type { SignedRawMessage } from "./helpers/signed-message.js";

const CHANNEL = "STASHO_CHANNEL_V1";
const DROPS = "STASHO_DROPS_V1";
const STRANGER = new Wallet(`0x${"55".repeat(32)}`);
const DROP_SIGNER = new Wallet(`0x${"66".repeat(32)}`);
/** The wallet and its two delegates, as `orchestrate` reports them. */
const TRUSTED = new Set([WALLET, DELEGATE, SESSION_KEY].map((w) => w.address.toLowerCase()));

let dir: string;
let n = 0;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "recover-export-stores-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function store(
  signer: Wallet,
  cid: unknown,
  opts: { owner?: string; channel?: string; time?: number } = {},
): Promise<SignedRawMessage> {
  return signedMessage(signer, {
    type: "STORE",
    channel: opts.channel ?? CHANNEL,
    content: {
      address: opts.owner ?? WALLET.address,
      item_type: "ipfs",
      item_hash: cid,
      time: opts.time ?? 1712620000,
    },
  });
}

function forget(signer: Wallet, hashes: string[], channel = CHANNEL): Promise<SignedRawMessage> {
  return signedMessage(signer, {
    type: "FORGET",
    channel,
    content: { address: signer.address, hashes, time: 1712630000 + ++n },
  });
}

async function resolver(messages: SignedRawMessage[]): Promise<ExportStoreResolver> {
  const file = join(dir, `s${++n}.ndjson`);
  const lines = messages.map((m) => `${exportLine(m, Number(m.content["time"]))}\n`);
  writeFileSync(file, lines.join(""));
  return exportStoreResolver(await loadExport(file, CHANNEL), CHANNEL, TRUSTED);
}

describe("exportStoreResolver lookups", () => {
  it("answers resolved, absent not-found, not-a-store and no-item-hash", async () => {
    const kept = await store(DELEGATE, "bafykept");
    const noCid = await store(DELEGATE, "");
    const notAStore = await forget(WALLET, ["unrelated"]);
    const stores = await resolver([kept, noCid, notAStore]);
    expect(await stores.lookup(kept.item_hash)).toEqual({
      kind: "resolved",
      itemHash: "bafykept",
      itemType: "ipfs",
    });
    expect(await stores.lookup("nothing")).toEqual({ kind: "absent", reason: "not-found" });
    const notStore = await stores.lookup(notAStore.item_hash);
    expect(notStore).toEqual({ kind: "absent", reason: "not-a-store" });
    const cidless = await stores.lookup(noCid.item_hash);
    expect(cidless).toEqual({ kind: "absent", reason: "no-item-hash" });
    expect(stores.warnings).toEqual([]);
  });

  it("ignores a stranger's FORGET of a STORE the export holds", async () => {
    const live = await store(DELEGATE, "bafylive");
    const forged = await forget(STRANGER, [live.item_hash], DROPS);
    const stores = await resolver([live, forged]);
    expect((await stores.lookup(live.item_hash)).kind).toBe("resolved");
    await stores.lookup(live.item_hash);
    expect(stores.warnings).toEqual([
      {
        code: "STORE_FORGET_IGNORED",
        detail:
          `STORE ${live.item_hash} is not read as forgotten: ` +
          `FORGET ${forged.item_hash} signed by ` +
          `${STRANGER.address}, which is not the STORE's sender, its owner, or a sender this ` +
          "wallet authorized",
        messageHash: forged.item_hash,
      },
    ]);
  });

  it("reads forgotten, unverified, when a stranger forgets a STORE the export lacks", async () => {
    const gone = await forget(STRANGER, ["store_not_held"]);
    const stores = await resolver([gone]);
    const lookup = await stores.lookup("store_not_held");
    expect(lookup).toStrictEqual({ kind: "forgotten", unverified: true });
    expect(stores.warnings).toEqual([
      {
        code: "STORE_FORGET_UNVERIFIED",
        detail:
          `STORE store_not_held reads forgotten because of FORGET ${gone.item_hash} signed by ` +
          `${STRANGER.address}; the export does not hold the STORE, so the signer could not be ` +
          "checked against its owner.",
        messageHash: gone.item_hash,
      },
    ]);
  });

  it("honors a FORGET by another authorized delegate, held STORE or not", async () => {
    const old = await store(SESSION_KEY, "bafyold");
    const stores = await resolver([old, await forget(DELEGATE, [old.item_hash, "not_held"])]);
    expect(await stores.lookup(old.item_hash)).toStrictEqual({ kind: "forgotten" });
    expect(await stores.lookup("not_held")).toStrictEqual({ kind: "forgotten" });
    expect(stores.warnings).toEqual([]);
  });

  it("honors a FORGET by the STORE's sender or owner the wallet never authorized", async () => {
    const owner = DROP_SIGNER.address;
    const drop = await store(DROP_SIGNER, "bafydrop", { owner, channel: DROPS });
    const owned = await store(DELEGATE, "bafyowned", { owner: DROP_SIGNER.address });
    const byOwner = await forget(DROP_SIGNER, [drop.item_hash, owned.item_hash], DROPS);
    const stores = await resolver([drop, owned, byOwner]);
    expect(await stores.lookup(drop.item_hash)).toStrictEqual({ kind: "forgotten" });
    expect(await stores.lookup(owned.item_hash)).toStrictEqual({ kind: "forgotten" });
    expect(stores.warnings).toEqual([]);
  });
});

describe("exportStoreResolver twin search", () => {
  it("finds the newest surviving twin on the channel only, never a forgotten one", async () => {
    const forgottenTwin = await store(DELEGATE, "bafycid");
    const otherChannel = await store(DELEGATE, "bafycid", { channel: DROPS, time: 1712620009 });
    const byDelegate = await forget(DELEGATE, [forgottenTwin.item_hash]);
    const lines = [forgottenTwin, otherChannel, byDelegate];
    expect(await (await resolver(lines)).findProcessedByContentHash("bafycid")).toBeNull();
    const older = await store(DELEGATE, "bafycid", { time: 1712620002 });
    const twin = await store(DELEGATE, "bafycid", { time: 1712620003 });
    const withTwin = await resolver([...lines, older, twin]);
    expect(await withTwin.findProcessedByContentHash("bafycid")).toBe(twin.item_hash);
  });

  it("counts a twin a stranger forgot as surviving, and says so", async () => {
    const twin = await store(DELEGATE, "bafycid");
    const forged = await forget(STRANGER, [twin.item_hash]);
    const stores = await resolver([twin, forged]);
    expect(await stores.findProcessedByContentHash("bafycid")).toBe(twin.item_hash);
    expect(stores.warnings.map((w) => w.code)).toEqual(["STORE_FORGET_IGNORED"]);
  });
});

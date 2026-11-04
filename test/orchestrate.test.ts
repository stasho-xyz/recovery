import { describe, it, expect } from "vitest";
import { extractAuthorizedSenders, orchestrate } from "../src/orchestrate.js";
import { Wallet } from "ethers";
import type { AlephMessage, MessageFetcher } from "../src/types.js";
import { DELEGATE, SESSION_KEY, WALLET, signedMessage } from "./helpers/signed-message.js";

// ─── Fixture helpers (real signatures — orchestrate applies the trust filter) ──

const ATTACKER = new Wallet(`0x${"55".repeat(32)}`);
const OTHER = "0xDEAD000000000000000000000000000000000000";

function securityAgg(
  authorizations: Array<{ address: string }>,
  time = 1712620800,
  signer: Wallet = WALLET,
): Promise<AlephMessage> {
  return signedMessage(signer, {
    type: "AGGREGATE",
    channel: "TEST",
    content: {
      address: WALLET.address,
      key: "security",
      content: { authorizations },
      time,
    },
  });
}

function projectAgg(
  projectId: string,
  signer: Wallet,
  contentAddress = WALLET.address,
  time = 1712622600,
): Promise<AlephMessage> {
  return signedMessage(signer, {
    type: "AGGREGATE",
    channel: "TEST",
    content: {
      address: contentAddress,
      key: "projects",
      content: { [projectId]: { public: {}, encrypted: {} } },
      time,
    },
  });
}

function deploymentPost(
  deploymentId: string,
  signer: Wallet,
  contentAddress = WALLET.address,
  time = 1712623600,
): Promise<AlephMessage> {
  return signedMessage(signer, {
    type: "POST",
    channel: "TEST",
    content: {
      address: contentAddress,
      type: "aleph-cloud-deployment",
      content: { deploymentId },
      time,
    },
  });
}

// ─── extractAuthorizedSenders ────────────────────────────────────────────────

const W = WALLET.address;
const D = DELEGATE.address;
const S = SESSION_KEY.address;

describe("extractAuthorizedSenders", () => {
  it("returns empty set when there are no security AGGREGATEs", async () => {
    const result = extractAuthorizedSenders([await projectAgg("proj_001", SESSION_KEY)], W);
    expect(result.size).toBe(0);
  });

  it("returns the addresses listed in a single security AGGREGATE (lowercased)", async () => {
    const result = extractAuthorizedSenders(
      [await securityAgg([{ address: D }, { address: S }])],
      W,
    );
    expect([...result].sort()).toEqual([D.toLowerCase(), S.toLowerCase()].sort());
  });

  it("returns the ever-authorized union across multiple security AGGREGATEs in time order", async () => {
    const SK2 = "0x1111111111111111111111111111111111111111";
    const result = extractAuthorizedSenders(
      [
        await securityAgg([{ address: D }, { address: S }], 1712620800),
        await securityAgg([{ address: D }, { address: SK2 }], 1712620900),
      ],
      W,
    );
    expect([...result].sort()).toEqual(
      [D.toLowerCase(), S.toLowerCase(), SK2.toLowerCase()].sort(),
    );
  });

  it("ignores non-security AGGREGATEs", async () => {
    const result = extractAuthorizedSenders(
      [await projectAgg("proj_001", SESSION_KEY), await securityAgg([{ address: D }])],
      W,
    );
    expect([...result]).toEqual([D.toLowerCase()]);
  });

  it("ignores legacy 132-char 0x04 uncompressed-pubkey form (V1 channel hard cut)", async () => {
    const legacyPubkey = "0x04" + "ab".repeat(64);
    expect(legacyPubkey.length).toBe(132);
    const result = extractAuthorizedSenders(
      [await securityAgg([{ address: legacyPubkey }, { address: D }])],
      W,
    );
    expect([...result]).toEqual([D.toLowerCase()]);
  });

  it("ignores a security aggregate whose sender is not the wallet", async () => {
    const result = extractAuthorizedSenders(
      [await securityAgg([{ address: S }], 1712620800, DELEGATE)],
      W.toLowerCase(),
    );
    expect(result.size).toBe(0);
  });
});

// ─── In-memory MessageFetcher ────────────────────────────────────────────────

interface CallRecord {
  messageType: "AGGREGATE" | "POST";
  addresses: readonly string[];
}

interface FetcherEntry {
  messageType: "AGGREGATE" | "POST";
  /** Sorted-lowercased address tuple, comma-joined. */
  addressKey: string;
  messages: AlephMessage[];
  truncated?: { fetched: number; total: number } | null;
}

function makeFetcher(entries: FetcherEntry[]): {
  fetcher: MessageFetcher;
  calls: CallRecord[];
} {
  const calls: CallRecord[] = [];
  const fetcher: MessageFetcher = async ({ messageType, addresses }) => {
    calls.push({ messageType, addresses });
    const key = [...addresses].map((a) => a.toLowerCase()).sort().join(",");
    const match = entries.find(
      (e) => e.messageType === messageType && e.addressKey === key,
    );
    return {
      messages: match ? [...match.messages] : [],
      truncated: match?.truncated ?? null,
    };
  };
  return { fetcher, calls };
}

function addressKey(...addresses: string[]): string {
  return addresses.map((a) => a.toLowerCase()).sort().join(",");
}

// ─── orchestrate ─────────────────────────────────────────────────────────────

describe("orchestrate", () => {
  it("skips Query B when authorized set is empty (only Query A's 2 calls)", async () => {
    const { fetcher, calls } = makeFetcher([
      { messageType: "AGGREGATE", addressKey: addressKey(W), messages: [] },
      { messageType: "POST", addressKey: addressKey(W), messages: [] },
    ]);
    const result = await orchestrate({ fetcher }, W);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.messageType).toBe("AGGREGATE");
    expect(calls[1]?.messageType).toBe("POST");
    expect(result.aggregates).toEqual([]);
    expect(result.posts).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.untrustedMessages).toBe(0);
  });

  it("issues Query B for the ever-authorized union when security aggs are present", async () => {
    const security = await securityAgg([{ address: D }, { address: S }]);
    const { fetcher, calls } = makeFetcher([
      { messageType: "AGGREGATE", addressKey: addressKey(W), messages: [security] },
      { messageType: "POST", addressKey: addressKey(W), messages: [] },
      { messageType: "AGGREGATE", addressKey: addressKey(D, S), messages: [] },
      { messageType: "POST", addressKey: addressKey(D, S), messages: [] },
    ]);
    await orchestrate({ fetcher }, W);
    expect(calls).toHaveLength(4);
    const queryBAggCall = calls[2];
    expect(queryBAggCall?.messageType).toBe("AGGREGATE");
    expect([...(queryBAggCall?.addresses ?? [])].sort()).toEqual(
      [D.toLowerCase(), S.toLowerCase()].sort(),
    );
  });

  it("excludes wallet itself from Query B even if the security agg lists it (defensive)", async () => {
    const security = await securityAgg([{ address: W }, { address: D }]);
    const { fetcher, calls } = makeFetcher([
      { messageType: "AGGREGATE", addressKey: addressKey(W), messages: [security] },
      { messageType: "POST", addressKey: addressKey(W), messages: [] },
      { messageType: "AGGREGATE", addressKey: addressKey(D), messages: [] },
      { messageType: "POST", addressKey: addressKey(D), messages: [] },
    ]);
    await orchestrate({ fetcher }, W);
    const queryBAggCall = calls[2];
    expect(queryBAggCall?.addresses).not.toContain(W.toLowerCase());
    expect(queryBAggCall?.addresses).toContain(D.toLowerCase());
  });

  it("silently skips Query B messages whose content.address is not the wallet", async () => {
    const security = await securityAgg([{ address: D }]);
    const ownProject = await projectAgg("proj_own", DELEGATE, W);
    const otherProject = await projectAgg("proj_other", DELEGATE, OTHER);
    const { fetcher } = makeFetcher([
      { messageType: "AGGREGATE", addressKey: addressKey(W), messages: [security] },
      { messageType: "POST", addressKey: addressKey(W), messages: [] },
      { messageType: "AGGREGATE", addressKey: addressKey(D), messages: [ownProject, otherProject] },
      { messageType: "POST", addressKey: addressKey(D), messages: [] },
    ]);
    const result = await orchestrate({ fetcher }, W);
    const hashes = result.aggregates.map((a) => a.item_hash);
    expect(hashes).toContain(ownProject.item_hash);
    expect(hashes).not.toContain(otherProject.item_hash);
    expect(result.untrustedMessages).toBe(0);
    expect(result.otherWalletMessages).toBe(1);
    expect(result.warnings).toEqual([]);
  });

  it("ignores a security aggregate signed by a delegate (no authorized senders)", async () => {
    const forged = await securityAgg([{ address: S }], 1712620800, DELEGATE);
    const { fetcher, calls } = makeFetcher([
      { messageType: "AGGREGATE", addressKey: addressKey(W), messages: [forged] },
      { messageType: "POST", addressKey: addressKey(W), messages: [] },
    ]);
    await orchestrate({ fetcher }, W);
    expect(calls).toHaveLength(2);
  });

  it("drops an unsigned security aggregate before reading authorizations", async () => {
    const security = await securityAgg([{ address: D }]);
    const tampered = { ...security };
    delete tampered.item_content;
    const { fetcher, calls } = makeFetcher([
      { messageType: "AGGREGATE", addressKey: addressKey(W), messages: [tampered] },
      { messageType: "POST", addressKey: addressKey(W), messages: [] },
    ]);
    const result = await orchestrate({ fetcher }, W);
    expect(calls).toHaveLength(2);
    expect(result.untrustedMessages).toBe(1);
  });

  it("drops an attacker-signed projects aggregate returned in Query B", async () => {
    const security = await securityAgg([{ address: D }]);
    const forged = await projectAgg("proj_evil", ATTACKER);
    const { fetcher } = makeFetcher([
      { messageType: "AGGREGATE", addressKey: addressKey(W), messages: [security] },
      { messageType: "POST", addressKey: addressKey(W), messages: [] },
      { messageType: "AGGREGATE", addressKey: addressKey(D), messages: [forged] },
      { messageType: "POST", addressKey: addressKey(D), messages: [] },
    ]);
    const result = await orchestrate({ fetcher }, W);
    expect(result.aggregates.map((a) => a.item_hash)).toEqual([security.item_hash]);
    expect(result.untrustedMessages).toBe(1);
    expect(result.warnings).toEqual([
      {
        code: "UNTRUSTED_MESSAGE",
        detail: `${forged.item_hash}: sender is not authorized`,
        messageHash: forged.item_hash,
      },
    ]);
  });

  it("drops an attacker-signed deployment POST returned in Query A", async () => {
    const forged = await deploymentPost("deploy_evil", ATTACKER);
    const { fetcher } = makeFetcher([
      { messageType: "AGGREGATE", addressKey: addressKey(W), messages: [] },
      { messageType: "POST", addressKey: addressKey(W), messages: [forged] },
    ]);
    const result = await orchestrate({ fetcher }, W);
    expect(result.posts).toEqual([]);
    expect(result.untrustedMessages).toBe(1);
    expect(result.warnings).toEqual([
      {
        code: "UNTRUSTED_MESSAGE",
        detail: `${forged.item_hash}: sender is not authorized`,
        messageHash: forged.item_hash,
      },
    ]);
  });

  it("dedups across Query A and Query B by item_hash", async () => {
    const security = await securityAgg([{ address: D }]);
    const dupInB = { ...security };
    const { fetcher } = makeFetcher([
      { messageType: "AGGREGATE", addressKey: addressKey(W), messages: [security] },
      { messageType: "POST", addressKey: addressKey(W), messages: [] },
      { messageType: "AGGREGATE", addressKey: addressKey(D), messages: [dupInB] },
      { messageType: "POST", addressKey: addressKey(D), messages: [] },
    ]);
    const result = await orchestrate({ fetcher }, W);
    expect(result.aggregates).toHaveLength(1);
    expect(result.aggregates[0]?.item_hash).toBe(security.item_hash);
    expect(result.warnings).toEqual([]);
    expect(result.untrustedMessages).toBe(0);
  });

  it("end-to-end regression: post-#98 fixture produces messages for reconstruct", async () => {
    const security = await securityAgg([{ address: D }, { address: S }]);
    const project = await projectAgg("proj_001", SESSION_KEY);
    const deploy = await deploymentPost("deploy_001", DELEGATE);
    const { fetcher } = makeFetcher([
      { messageType: "AGGREGATE", addressKey: addressKey(W), messages: [security] },
      { messageType: "POST", addressKey: addressKey(W), messages: [] },
      { messageType: "AGGREGATE", addressKey: addressKey(D, S), messages: [project] },
      { messageType: "POST", addressKey: addressKey(D, S), messages: [deploy] },
    ]);
    const result = await orchestrate({ fetcher }, W);
    expect(result.aggregates.map((a) => a.item_hash).sort()).toEqual(
      [project.item_hash, security.item_hash].sort(),
    );
    expect(result.posts.map((p) => p.item_hash)).toEqual([deploy.item_hash]);
    expect(result.warnings).toEqual([]);
  });

  it("turns a truncated POST fetch into one ALEPH_MESSAGES_TRUNCATED warning", async () => {
    const security = await securityAgg([{ address: D }]);
    const { fetcher } = makeFetcher([
      { messageType: "AGGREGATE", addressKey: addressKey(W), messages: [security] },
      {
        messageType: "POST",
        addressKey: addressKey(W),
        messages: [],
        truncated: { fetched: 300, total: 350 },
      },
      { messageType: "AGGREGATE", addressKey: addressKey(D), messages: [] },
      { messageType: "POST", addressKey: addressKey(D), messages: [] },
    ]);
    const result = await orchestrate({ fetcher }, W);
    const truncated = result.warnings.filter((w) => w.code === "ALEPH_MESSAGES_TRUNCATED");
    expect(truncated).toHaveLength(1);
    expect(truncated[0]?.detail).toBe("POST query for 1 addresses: fetched 300 of 350");
    expect(result.truncatedQueries).toBe(1);
    expect(result.untrustedMessages).toBe(0);
  });
});

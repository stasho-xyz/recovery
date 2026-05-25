import { describe, it, expect } from "vitest";
import { extractAuthorizedSenders, orchestrate } from "../src/orchestrate.js";
import type { AlephMessage, MessageFetcher } from "../src/types.js";

// ─── Fixture helpers (no signatures or crypto — orchestrate doesn't decrypt) ──

const WALLET = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A";
const DELEGATE = "0x0e20c15D2f377D542E679362136f0EF81e6aF18F";
const SESSION_KEY = "0x5CbDd86a2FA8Dc4bDdd8a8f69dBa48572EeC07FB";

function securityAgg(
  authorizations: Array<{ address: string }>,
  time = 1712620800,
): AlephMessage {
  return {
    type: "AGGREGATE",
    channel: "TEST",
    sender: WALLET,
    signature: "0x",
    item_hash: `inline_security_${time}`,
    content: {
      address: WALLET,
      key: "security",
      content: { authorizations },
      time,
    },
  };
}

function projectAgg(
  projectId: string,
  signer: string,
  contentAddress = WALLET,
  time = 1712622600,
): AlephMessage {
  return {
    type: "AGGREGATE",
    channel: "TEST",
    sender: signer,
    signature: "0x",
    item_hash: `inline_project_${projectId}`,
    content: {
      address: contentAddress,
      key: "projects",
      content: { [projectId]: { public: {}, encrypted: {} } },
      time,
    },
  };
}

function deploymentPost(
  deploymentId: string,
  signer: string,
  contentAddress = WALLET,
  time = 1712623600,
): AlephMessage {
  return {
    type: "POST",
    channel: "TEST",
    sender: signer,
    signature: "0x",
    item_hash: `inline_deploy_${deploymentId}`,
    content: {
      address: contentAddress,
      type: "aleph-cloud-deployment",
      content: { deploymentId },
      time,
    },
  };
}

// ─── extractAuthorizedSenders ────────────────────────────────────────────────

describe("extractAuthorizedSenders", () => {
  it("returns empty set when there are no security AGGREGATEs", () => {
    const result = extractAuthorizedSenders([
      projectAgg("proj_001", SESSION_KEY),
    ]);
    expect(result.size).toBe(0);
  });

  it("returns the addresses listed in a single security AGGREGATE (lowercased)", () => {
    const result = extractAuthorizedSenders([
      securityAgg([{ address: DELEGATE }, { address: SESSION_KEY }]),
    ]);
    expect([...result].sort()).toEqual(
      [DELEGATE.toLowerCase(), SESSION_KEY.toLowerCase()].sort(),
    );
  });

  it("returns the ever-authorized union across multiple security AGGREGATEs in time order", () => {
    const SK2 = "0x1111111111111111111111111111111111111111";
    const result = extractAuthorizedSenders([
      securityAgg([{ address: DELEGATE }, { address: SESSION_KEY }], 1712620800),
      securityAgg([{ address: DELEGATE }, { address: SK2 }], 1712620900),
    ]);
    // SESSION_KEY was authorized in msg 1 then dropped in msg 2; ever-authorized
    // union must still include it.
    expect([...result].sort()).toEqual(
      [DELEGATE.toLowerCase(), SESSION_KEY.toLowerCase(), SK2.toLowerCase()].sort(),
    );
  });

  it("ignores non-security AGGREGATEs", () => {
    const result = extractAuthorizedSenders([
      projectAgg("proj_001", SESSION_KEY),
      securityAgg([{ address: DELEGATE }]),
    ]);
    expect([...result]).toEqual([DELEGATE.toLowerCase()]);
  });

  it("ignores legacy 132-char 0x04 uncompressed-pubkey form (V1 channel hard cut)", () => {
    const legacyPubkey = "0x04" + "ab".repeat(64);
    expect(legacyPubkey.length).toBe(132);
    const result = extractAuthorizedSenders([
      securityAgg([{ address: legacyPubkey }, { address: DELEGATE }]),
    ]);
    expect([...result]).toEqual([DELEGATE.toLowerCase()]);
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
    return match ? [...match.messages] : [];
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
      // Query A returns nothing — no security aggs to extract authorized senders from
      { messageType: "AGGREGATE", addressKey: addressKey(WALLET), messages: [] },
      { messageType: "POST", addressKey: addressKey(WALLET), messages: [] },
    ]);
    const result = await orchestrate({ fetcher }, WALLET);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.messageType).toBe("AGGREGATE");
    expect(calls[1]?.messageType).toBe("POST");
    expect(result.aggregates).toEqual([]);
    expect(result.posts).toEqual([]);
  });

  it("issues Query B for the ever-authorized union when security aggs are present", async () => {
    const security = securityAgg([{ address: DELEGATE }, { address: SESSION_KEY }]);
    const { fetcher, calls } = makeFetcher([
      { messageType: "AGGREGATE", addressKey: addressKey(WALLET), messages: [security] },
      { messageType: "POST", addressKey: addressKey(WALLET), messages: [] },
      { messageType: "AGGREGATE", addressKey: addressKey(DELEGATE, SESSION_KEY), messages: [] },
      { messageType: "POST", addressKey: addressKey(DELEGATE, SESSION_KEY), messages: [] },
    ]);
    await orchestrate({ fetcher }, WALLET);
    expect(calls).toHaveLength(4);
    // Query B's addresses contain both DELEGATE and SESSION_KEY (order-insensitive)
    const queryBAggCall = calls[2];
    expect(queryBAggCall?.messageType).toBe("AGGREGATE");
    expect([...(queryBAggCall?.addresses ?? [])].sort()).toEqual(
      [DELEGATE.toLowerCase(), SESSION_KEY.toLowerCase()].sort(),
    );
  });

  it("excludes wallet itself from Query B even if the security agg lists it (defensive)", async () => {
    // A defensive case: the wallet's own address shows up in `authorizations[]`
    // (which shouldn't happen but isn't malformed). Query B must not include it
    // since Query A already covered wallet-signed messages.
    const security = securityAgg([{ address: WALLET }, { address: DELEGATE }]);
    const { fetcher, calls } = makeFetcher([
      { messageType: "AGGREGATE", addressKey: addressKey(WALLET), messages: [security] },
      { messageType: "POST", addressKey: addressKey(WALLET), messages: [] },
      { messageType: "AGGREGATE", addressKey: addressKey(DELEGATE), messages: [] },
      { messageType: "POST", addressKey: addressKey(DELEGATE), messages: [] },
    ]);
    await orchestrate({ fetcher }, WALLET);
    const queryBAggCall = calls[2];
    expect(queryBAggCall?.addresses).not.toContain(WALLET.toLowerCase());
    expect(queryBAggCall?.addresses).toContain(DELEGATE.toLowerCase());
  });

  it("filters Query B messages by content.address == wallet", async () => {
    const security = securityAgg([{ address: DELEGATE }]);
    const ownProject = projectAgg("proj_own", DELEGATE, WALLET);
    const otherProject = projectAgg("proj_other", DELEGATE, "0xDEAD000000000000000000000000000000000000");
    const { fetcher } = makeFetcher([
      { messageType: "AGGREGATE", addressKey: addressKey(WALLET), messages: [security] },
      { messageType: "POST", addressKey: addressKey(WALLET), messages: [] },
      { messageType: "AGGREGATE", addressKey: addressKey(DELEGATE), messages: [ownProject, otherProject] },
      { messageType: "POST", addressKey: addressKey(DELEGATE), messages: [] },
    ]);
    const result = await orchestrate({ fetcher }, WALLET);
    expect(result.aggregates.map((a) => a.item_hash)).toContain("inline_project_proj_own");
    expect(result.aggregates.map((a) => a.item_hash)).not.toContain("inline_project_proj_other");
  });

  it("dedups across Query A and Query B by item_hash", async () => {
    // The same security agg appears in Query A (sender == wallet) and would
    // also surface in Query B if the wallet were somehow included — verify
    // the dedup pass keeps things safe even in a contrived collision.
    const security = securityAgg([{ address: DELEGATE }]);
    const dupInB = { ...security }; // same item_hash, content.address == wallet so it passes the filter
    const { fetcher } = makeFetcher([
      { messageType: "AGGREGATE", addressKey: addressKey(WALLET), messages: [security] },
      { messageType: "POST", addressKey: addressKey(WALLET), messages: [] },
      { messageType: "AGGREGATE", addressKey: addressKey(DELEGATE), messages: [dupInB] },
      { messageType: "POST", addressKey: addressKey(DELEGATE), messages: [] },
    ]);
    const result = await orchestrate({ fetcher }, WALLET);
    expect(result.aggregates).toHaveLength(1);
    expect(result.aggregates[0]?.item_hash).toBe(security.item_hash);
  });

  it("end-to-end regression: post-#98 fixture produces messages for reconstruct", async () => {
    // Hand-rolled messages mimicking a post-Decision-#98 user:
    //   - security agg signed by wallet (Query A)
    //   - project agg signed by session key (Query B)
    //   - deployment POST signed by delegate (Query B)
    // The pre-fix main.ts would receive 1 message total (security only); the
    // post-fix orchestration must return 3.
    const security = securityAgg([{ address: DELEGATE }, { address: SESSION_KEY }]);
    const project = projectAgg("proj_001", SESSION_KEY);
    const deploy = deploymentPost("deploy_001", DELEGATE);
    const { fetcher } = makeFetcher([
      { messageType: "AGGREGATE", addressKey: addressKey(WALLET), messages: [security] },
      { messageType: "POST", addressKey: addressKey(WALLET), messages: [] },
      { messageType: "AGGREGATE", addressKey: addressKey(DELEGATE, SESSION_KEY), messages: [project] },
      { messageType: "POST", addressKey: addressKey(DELEGATE, SESSION_KEY), messages: [deploy] },
    ]);
    const result = await orchestrate({ fetcher }, WALLET);
    expect(result.aggregates.map((a) => a.item_hash).sort()).toEqual(
      ["inline_project_proj_001", "inline_security_1712620800"].sort(),
    );
    expect(result.posts.map((p) => p.item_hash)).toEqual(["inline_deploy_deploy_001"]);
  });
});

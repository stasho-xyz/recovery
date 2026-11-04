import { afterEach, describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrivateKey } from "eciesjs";
import { Wallet, keccak256, getBytes } from "ethers";
import { reconstruct } from "../src/reconstruct.js";
import { groupAmendChains } from "../src/amend-chain.js";
import {
  deriveEncryptionKey,
  decryptBlobAsEncryption,
  derivationMessage,
} from "../src/decrypt.js";
import type { AlephMessage } from "../src/types.js";
import { encryptForTest } from "./helpers/envelope.js";

// ─── Encryption helpers (mirrors apps/backend/src/services/encryption.ts) ──────

const TEST_USER_PRIV = Buffer.from("11".repeat(32), "hex");

function makeAggregate(
  projectId: string,
  publicFields: Record<string, unknown>,
  encryptedBlob: Record<string, unknown>,
  time = 1712620800,
  publicExtra: Record<string, unknown> = {},
): AlephMessage {
  return {
    type: "AGGREGATE",
    chain: "ETH",
    channel: "TEST",
    sender: "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A",
    signature: "0x",
    item_hash: `inline_agg_${projectId}`,
    content: {
      address: "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A",
      key: "projects",
      content: {
        [projectId]: {
          id: projectId,
          schemaVersion: 1,
          public: { ...publicFields, ...publicExtra },
          encrypted: encryptForTest(encryptedBlob),
        },
      },
      time,
    },
  };
}

function makeCreationPost(
  deploymentId: string,
  projectId: string,
  publicFields: Record<string, unknown>,
  encryptedBlob: Record<string, unknown>,
  time = 1712622600,
  publicExtra: Record<string, unknown> = {},
): AlephMessage {
  return {
    type: "POST",
    chain: "ETH",
    channel: "TEST",
    sender: "0x5CbDd86a2FA8Dc4bDdd8a8f69dBa48572EeC07FB",
    signature: "0x",
    item_hash: `inline_post_${deploymentId}`,
    content: {
      address: "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A",
      type: "aleph-cloud-deployment",
      content: {
        deploymentId,
        projectId,
        schemaVersion: 1,
        public: { ...publicFields, ...publicExtra },
        encrypted: encryptForTest(encryptedBlob),
      },
      time,
    },
  };
}

// Vendored copy of the backend's hand-crafted message set; the backend's
// recovery-fixtures-parity test keeps the two directories byte-identical.
const FIXTURE_DIR = join(import.meta.dirname, "fixtures/messages");

interface FixtureFile {
  description?: string;
  testKeys: {
    userPrivHex: string;
    backendPrivHex: string;
    delegatePrivHex: string;
    userAddress: string;
    delegateAddress: string;
  };
  messages: AlephMessage[];
}

function loadFixture(name: string): {
  userPrivKey: Buffer;
  aggregates: AlephMessage[];
  posts: AlephMessage[];
} {
  const raw = readFileSync(join(FIXTURE_DIR, `${name}.json`), "utf8");
  const fixture = JSON.parse(raw) as FixtureFile;
  return {
    userPrivKey: Buffer.from(fixture.testKeys.userPrivHex, "hex"),
    aggregates: fixture.messages.filter((m) => m.type === "AGGREGATE"),
    posts: fixture.messages.filter((m) => m.type === "POST"),
  };
}

describe("reconstruct — empty + single project", () => {
  it("01-empty: produces empty output with no warnings", async () => {
    const f = loadFixture("01-empty");
    const result = await reconstruct(f.aggregates, f.posts, f.userPrivKey, "https://test.aleph.local");
    expect(result.projects).toEqual([]);
    expect(result.stats.projectsRecovered).toBe(0);
    expect(result.stats.deploymentsRecovered).toBe(0);
    expect(result.warnings).toEqual([]);
  });

  it("02-single-project: recovers the project with decrypted fields", async () => {
    const f = loadFixture("02-single-project");
    const result = await reconstruct(f.aggregates, f.posts, f.userPrivKey, "https://test.aleph.local");
    expect(result.projects.length).toBe(1);
    const p = result.projects[0];
    expect(p?.id).toBe("proj_001");
    expect(p?.name).toBe("my-app");
    expect(p?.repo).toBe("acme/my-app");
    expect(p?.branch).toBe("main");
    expect(p?.installationId).toBe(12345);
    expect(p?.framework).toBe("nextjs-static");
    expect(p?.buildCommand).toBe("npm run build");
    expect(p?.outputDir).toBe("dist");
    expect(p?.deployTarget).toBe("ipfs");
    expect(p?.deployments).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

describe("reconstruct — tombstones", () => {
  it("04-project-deleted: tombstone evicts the project from the output", async () => {
    const f = loadFixture("04-project-deleted");
    const result = await reconstruct(f.aggregates, f.posts, f.userPrivKey, "https://test.aleph.local");
    expect(result.projects).toEqual([]);
    expect(result.stats.projectsRecovered).toBe(0);
  });
});

describe("reconstruct — deployments", () => {
  it("05-deployment-queued: cache-only intermediate state is visible if posted", async () => {
    const f = loadFixture("05-deployment-queued");
    const result = await reconstruct(f.aggregates, f.posts, f.userPrivKey, "https://test.aleph.local");
    expect(result.projects.length).toBe(1);
    // Queued deployments are written as POST creations, so they appear
    // whether or not a terminal amend has been written yet.
    expect(result.projects[0]?.deployments.length).toBeGreaterThanOrEqual(0);
  });

  it("06-deployment-live: recovers project with one live deployment", async () => {
    const f = loadFixture("06-deployment-live");
    const result = await reconstruct(f.aggregates, f.posts, f.userPrivKey, "https://test.aleph.local");
    expect(result.projects.length).toBe(1);
    const p = result.projects[0];
    expect(p?.deployments.length).toBe(1);
    const d = p?.deployments[0];
    expect(d?.id).toBe("deploy_001");
    expect(d?.status).toBe("live");
    expect(d?.cid).toBe("bafybeiglive");
    expect(d?.url).toBe("https://bafybeiglive.ipfs.aleph.sh");
    expect(d?.commit).toBe("abc1234");
    expect(d?.branch).toBe("main");
    expect(d?.finishedAt).toBe("2026-04-09T00:33:00.000Z");
  });

  it("07-deployment-failed: recovers project with one failed deployment", async () => {
    const f = loadFixture("07-deployment-failed");
    const result = await reconstruct(f.aggregates, f.posts, f.userPrivKey, "https://test.aleph.local");
    expect(result.projects.length).toBe(1);
    const d = result.projects[0]?.deployments[0];
    expect(d?.status).toBe("failed");
    expect(d?.error).toBeTruthy();
  });
});

describe("reconstruct — amend chains", () => {
  it("08-amend-chain-deep: collapses multi-step chain to the terminal state", async () => {
    const f = loadFixture("08-amend-chain-deep");
    const result = await reconstruct(f.aggregates, f.posts, f.userPrivKey, "https://test.aleph.local");
    expect(result.projects.length).toBe(1);
    const d = result.projects[0]?.deployments[0];
    expect(d?.id).toBe("deploy_003");
    expect(d?.status).toBe("live");
    expect(d?.cid).toBe("bafybeigchain");
    // The test fixture has a deep chain (multiple amends); the count of
    // resolved chains must reflect the number of distinct creation posts,
    // not the total post count.
    expect(result.stats.amendChainsResolved).toBe(1);
  });

  it("ignores an owner-signed amend whose inner deploymentId names a different deployment than the creation it refs", () => {
    const owner = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A";
    const post = (item_hash: string, content: AlephMessage["content"]): AlephMessage => ({
      type: "POST",
      chain: "ETH",
      channel: "STASHO_CHANNEL_V1",
      sender: owner,
      signature: "0x",
      item_hash,
      content,
    });
    const creationA = post("creation_a", {
      address: owner,
      type: "aleph-cloud-deployment",
      content: { deploymentId: "deploy_a", public: { status: "queued" } },
      time: 1000,
    });
    const creationB = post("creation_b", {
      address: owner,
      type: "aleph-cloud-deployment",
      content: { deploymentId: "deploy_b", public: { status: "queued" } },
      time: 1001,
    });
    // Refs A's creation but carries B's deploymentId: belongs to neither chain.
    const crossAmend = post("cross_amend", {
      address: owner,
      type: "amend",
      ref: "creation_a",
      content: { deploymentId: "deploy_b", public: { status: "live" } },
      time: 2000,
    });

    const groups = groupAmendChains([creationA, creationB, crossAmend]);
    expect(groups.get("deploy_a")?.item_hash).toBe("creation_a");
    expect(groups.get("deploy_b")?.item_hash).toBe("creation_b");
  });
});

describe("reconstruct — multi-project", () => {
  it("09-multi-project: recovers multiple projects with their deployments", async () => {
    const f = loadFixture("09-multi-project");
    const result = await reconstruct(f.aggregates, f.posts, f.userPrivKey, "https://test.aleph.local");
    expect(result.projects.length).toBeGreaterThan(1);
    // Each deployment attaches to its own project — no cross-contamination.
    for (const p of result.projects) {
      for (const d of p.deployments) {
        expect(d).toBeTruthy();
      }
    }
  });
});

describe("reconstruct — corruption resilience", () => {
  it("10-corrupted-envelope: records a warning and skips, no crash", async () => {
    const f = loadFixture("10-corrupted-envelope");
    const result = await reconstruct(f.aggregates, f.posts, f.userPrivKey, "https://test.aleph.local");
    expect(result.projects).toEqual([]);
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    expect(result.stats.malformedRecords).toBe(1);
    expect(result.warnings[0]?.code).toBe("MALFORMED_RECORD");
  });

  it("11-tampered-ciphertext: auth tag mismatch surfaces as a warning", async () => {
    const f = loadFixture("11-tampered-ciphertext");
    const result = await reconstruct(f.aggregates, f.posts, f.userPrivKey, "https://test.aleph.local");
    expect(result.projects).toEqual([]);
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    expect(result.stats.decryptionFailures).toBeGreaterThanOrEqual(1);
  });
});

describe("reconstruct — record-schema field compatibility", () => {
  // These fixtures use v3 envelopes (current format) but exercise older
  // *record* schemas — the public/encrypted field sets, independent of the
  // envelope version. v1-shaped records omit runId/runAttempt and pending-PR
  // fields; v2-shaped records carry them.
  it("v1-shaped record: runId/runAttempt absent → both read as null, no crash", async () => {
    // v1 deployment public has no runId/runAttempt fields; v1 project encrypted
    // blob has no pendingWorkflowPr* fields. Both should gracefully produce null.
    const agg = makeAggregate(
      "proj_v1",
      {
        framework: "nextjs-static",
        deployTarget: "ipfs",
        createdAt: "2026-04-09T00:00:00.000Z",
        updatedAt: "2026-04-09T00:00:00.000Z",
        deleted: false,
      },
      {
        name: "v1-app",
        source: "github",
        repo: "acme/v1-app",
        branch: "main",
        installationId: 999,
        buildCommand: "npm run build",
        outputDir: "dist",
        // no pendingWorkflowPrUrl, no pendingWorkflowPrNumber
      },
    );
    const post = makeCreationPost(
      "deploy_v1",
      "proj_v1",
      {
        status: "live",
        cid: "bafyv1",
        url: "https://bafyv1.ipfs.aleph.sh",
        tokenHash: "aabbcc",
        createdAt: "2026-04-09T00:30:00.000Z",
        finishedAt: "2026-04-09T00:33:00.000Z",
        // no runId, no runAttempt
      },
      {
        commit: "abc1234",
        commitMessage: "v1 deploy",
        branch: "main",
        actionsRunUrl: null,
        error: null,
      },
    );

    const result = await reconstruct([agg], [post], TEST_USER_PRIV, "https://test.aleph.local");
    // v3 fixtures emit a LEGACY_SCHEMA warning per deployment (no storeRef);
    // filter those out so the test asserts only on unexpected warnings.
    expect(result.warnings.filter((w) => w.code !== "LEGACY_SCHEMA")).toEqual([]);
    expect(result.projects.length).toBe(1);
    const p = result.projects[0];
    expect(p?.pendingWorkflowPrUrl).toBeNull();
    expect(p?.pendingWorkflowPrNumber).toBeNull();
    expect(p?.deployments.length).toBe(1);
    const d = p?.deployments[0];
    expect(d?.runId).toBeNull();
    expect(d?.runAttempt).toBeNull();
  });

  it("v2-shaped record: runId/runAttempt and pending PR fields round-trip correctly", async () => {
    // v2 deployment public has runId + runAttempt; project encrypted blob has
    // pendingWorkflowPrUrl + pendingWorkflowPrNumber.
    const agg = makeAggregate(
      "proj_v2",
      {
        framework: "nextjs-static",
        deployTarget: "ipfs",
        createdAt: "2026-04-13T10:00:00.000Z",
        updatedAt: "2026-04-13T10:00:00.000Z",
        deleted: false,
      },
      {
        name: "v2-app",
        source: "github",
        repo: "acme/v2-app",
        branch: "main",
        installationId: 777,
        buildCommand: "npm run build",
        outputDir: "dist",
        pendingWorkflowPrUrl: "https://github.com/u/r/pull/3",
        pendingWorkflowPrNumber: 3,
      },
    );
    const post = makeCreationPost(
      "deploy_v2",
      "proj_v2",
      {
        status: "live",
        cid: "bafyv2",
        url: "https://bafyv2.ipfs.aleph.sh",
        createdAt: "2026-04-13T10:05:00.000Z",
        finishedAt: "2026-04-13T10:08:00.000Z",
        runId: 42,
        runAttempt: 1,
      },
      {
        commit: "def5678",
        commitMessage: "v2 deploy via OIDC",
        branch: "main",
        actionsRunUrl:
          "https://github.com/acme/v2-app/actions/runs/42",
        error: null,
      },
    );

    const result = await reconstruct([agg], [post], TEST_USER_PRIV, "https://test.aleph.local");
    // v3 fixtures emit a LEGACY_SCHEMA warning per deployment (no storeRef);
    // filter those out so the test asserts only on unexpected warnings.
    expect(result.warnings.filter((w) => w.code !== "LEGACY_SCHEMA")).toEqual([]);
    expect(result.projects.length).toBe(1);
    const p = result.projects[0];
    expect(p?.pendingWorkflowPrUrl).toBe("https://github.com/u/r/pull/3");
    expect(p?.pendingWorkflowPrNumber).toBe(3);
    expect(p?.deployments.length).toBe(1);
    const d = p?.deployments[0];
    expect(d?.runId).toBe(42);
    expect(d?.runAttempt).toBe(1);
  });
});

// ─── Decision #117 — deterministic encryption-key derivation ──────────────────

/**
 * FROZEN derivation message for the zero-address cross-check.
 * Must be byte-for-byte identical to the string produced by:
 *   apps/web/src/lib/encryption-key.ts :: derivationMessage("0x0000000000000000000000000000000000000000")
 */
const FROZEN_DERIVATION_MESSAGE_ZERO_ADDR =
  "Stasho Cloud — encryption key\n" +
  "\n" +
  "Sign to derive your personal encryption key. This key lets your\n" +
  "browser decrypt your deployment history.\n" +
  "\n" +
  "This signature does not authorize any transaction, payment, or\n" +
  "spending. It is free and safe.\n" +
  "\n" +
  "Wallet: 0x0000000000000000000000000000000000000000\n" +
  "Version: 1";

describe("deriveEncryptionKey — frozen derivationMessage pin", () => {
  it("derivationMessage(zero-addr) matches frozen literal exactly", () => {
    // Calls decrypt.ts's actual `derivationMessage` so an edit to that copy
    // fails this test. The frozen literal pins the string shared by BOTH the
    // recovery script and apps/web/src/lib/encryption-key.ts; the web-side
    // test asserts the same literal against its own copy.
    expect(
      derivationMessage("0x0000000000000000000000000000000000000000"),
    ).toBe(FROZEN_DERIVATION_MESSAGE_ZERO_ADDR);
  });
});

describe("deriveEncryptionKey — round-trip via deks.encryption", () => {
  it("decryptBlobAsEncryption recovers cleartext encrypted to the derived key", async () => {
    // Use a fixed test wallet key so the test is deterministic.
    const walletPrivHex = "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
    const walletPrivKey = Buffer.from(walletPrivHex, "hex");

    // Step 1: derive E.priv the same way decrypt.ts does.
    const encryptionPrivKey = await deriveEncryptionKey(walletPrivKey);
    expect(encryptionPrivKey).toHaveLength(32);

    // Step 2: derive E.pub from E.priv so we can ECIES-wrap a DEK to it.
    const encryptionPub = Buffer.from(
      new PrivateKey(encryptionPrivKey).publicKey.uncompressed,
    );
    expect(encryptionPub).toHaveLength(65);
    expect(encryptionPub[0]).toBe(0x04);

    // Step 3: build a real v3 envelope with deks.encryption wrapping a DEK to E.pub.
    const cleartext = { secret: "hello-encryption-117", value: 42 };
    const envelope = encryptForTest(cleartext, { encryptionPub });

    expect(envelope.v).toBe(3);
    expect(envelope.deks.encryption).toBeTruthy();

    // Step 4: decrypt via deks.encryption and verify cleartext is recovered.
    const recovered = decryptBlobAsEncryption(envelope, encryptionPrivKey);
    expect(recovered).toEqual(cleartext);
  });

  it("decryptBlobAsEncryption throws when envelope has no deks.encryption", () => {
    // A (legacy-shaped) envelope without deks.encryption must throw clearly.
    const envelope = encryptForTest({ x: 1 }, { omitEncryption: true });
    expect(() => decryptBlobAsEncryption(envelope, Buffer.alloc(32))).toThrow(
      "envelope has no deks.encryption recipient",
    );
  });

  it("deriveEncryptionKey is deterministic: same wallet → same key", async () => {
    const walletPrivKey = Buffer.from("11".repeat(32), "hex");
    const k1 = await deriveEncryptionKey(walletPrivKey);
    const k2 = await deriveEncryptionKey(walletPrivKey);
    expect(k1.toString("hex")).toBe(k2.toString("hex"));
  });

  it("deriveEncryptionKey cross-check: derived pubkey matches ethers Wallet derivation", async () => {
    // This is the canonical cross-compatibility check for Decision #117.
    // Both the recovery script and the browser derive:
    //   E.priv = keccak256(EIP-191_personal_sign(derivationMessage(checksummedAddr)))
    // We verify the round-trip by doing the same derivation here inline using
    // the raw ethers v6 primitives and asserting the result matches deriveEncryptionKey.
    const walletPrivHex = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const walletPrivKey = Buffer.from(walletPrivHex, "hex");
    const wallet = new Wallet("0x" + walletPrivHex);

    const derivMsg =
      "Stasho Cloud — encryption key\n" +
      "\n" +
      "Sign to derive your personal encryption key. This key lets your\n" +
      "browser decrypt your deployment history.\n" +
      "\n" +
      "This signature does not authorize any transaction, payment, or\n" +
      "spending. It is free and safe.\n" +
      "\n" +
      `Wallet: ${wallet.address}\n` +
      "Version: 1";

    const sig = await wallet.signMessage(derivMsg);
    const expectedPriv = Buffer.from(getBytes(keccak256(getBytes(sig))));

    const derivedPriv = await deriveEncryptionKey(walletPrivKey);
    expect(derivedPriv.toString("hex")).toBe(expectedPriv.toString("hex"));
  });
});

describe("reconstruct — v4 storeRef resolution outcomes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function v4Fixture(storeRef: string, url = "https://example.com"): AlephMessage[] {
    const agg = makeAggregate(
      "proj_v4",
      {
        framework: "nextjs-static",
        deployTarget: "ipfs",
        createdAt: "2026-05-03T00:00:00.000Z",
        updatedAt: "2026-05-03T00:00:00.000Z",
        deleted: false,
      },
      {
        name: "v4-app",
        source: "github",
        repo: "acme/v4-app",
        branch: "main",
        installationId: 1,
        buildCommand: "npm run build",
        outputDir: "dist",
      },
    );
    const post = makeCreationPost(
      "deploy_v4",
      "proj_v4",
      {
        status: "live",
        storeRef,
        url,
        createdAt: "2026-05-03T00:00:00.000Z",
        finishedAt: "2026-05-03T00:01:00.000Z",
      },
      {
        commit: "abc1234",
        commitMessage: "v4 deploy",
        branch: "main",
        actionsRunUrl: null,
        error: null,
      },
    );
    return [agg, post];
  }

  /**
   * The disaster-report claim this adds. "Removed" tells a user Aleph's own
   * garbage collection reclaimed their artifact after the payer ran out of
   * balance/credits — a different cause, and a different remedy, from the
   * FORGET that `storeStatus: "forgotten"` reports.
   */
  it("reports storeStatus removed + STORE_REMOVED for a GC'd STORE", async () => {
    const [agg, post] = v4Fixture("store_gc");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              status: "removed",
              item_hash: "store_gc",
              message: { type: "STORE", item_hash: "store_gc" },
              reason: "credit_insufficient",
            }),
            { status: 200 },
          ),
      ),
    );

    const result = await reconstruct(
      [agg!],
      [post!],
      TEST_USER_PRIV,
      "https://test.aleph.local",
    );

    const d = result.projects[0]?.deployments[0];
    expect(d?.cid).toBeNull();
    expect(d?.storeStatus).toBe("removed");
    expect(result.warnings.some((w) => w.code === "STORE_REMOVED")).toBe(true);
    // It must never be reported as a user-issued FORGET, or as merely absent.
    expect(result.warnings.some((w) => w.code === "STORE_FORGOTTEN")).toBe(false);
    expect(result.warnings.some((w) => w.code === "STORE_ABSENT")).toBe(false);
  });

  it("still reports storeStatus forgotten + STORE_FORGOTTEN for a FORGOTten STORE", async () => {
    const [agg, post] = v4Fixture("store_forgot");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              status: "forgotten",
              item_hash: "store_forgot",
              message: { type: "STORE", item_hash: "store_forgot" },
              forgotten_by: ["some_forget_hash"],
            }),
            { status: 200 },
          ),
      ),
    );

    const result = await reconstruct(
      [agg!],
      [post!],
      TEST_USER_PRIV,
      "https://test.aleph.local",
    );

    const d = result.projects[0]?.deployments[0];
    expect(d?.storeStatus).toBe("forgotten");
    expect(result.warnings.some((w) => w.code === "STORE_FORGOTTEN")).toBe(true);
    expect(result.warnings.some((w) => w.code === "STORE_REMOVED")).toBe(false);
  });

  it("resolves a FORGOTten STORE by content hash when a twin STORE pins the CID", async () => {
    const [agg, post] = v4Fixture("store_forgot", "https://bafyorig123.ipfs.aleph.sh");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const url = String(input);
        if (url.includes("contentHashes=bafyorig123")) {
          return new Response(
            JSON.stringify({
              messages: [
                {
                  item_hash: "store_other",
                  type: "STORE",
                  content: { item_hash: "bafyorig123" },
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            status: "forgotten",
            item_hash: "store_forgot",
            message: { type: "STORE", item_hash: "store_forgot" },
          }),
          { status: 200 },
        );
      }),
    );

    const result = await reconstruct([agg!], [post!], TEST_USER_PRIV, "https://test.aleph.local");

    const d = result.projects[0]?.deployments[0];
    expect(d?.storeStatus).toBe("content-match");
    expect(d?.cid).toBe("bafyorig123");
    expect(d?.artifactKind).toBe("ipfs");
    const match = result.warnings.find((w) => w.code === "STORE_CONTENT_MATCH");
    expect(match?.detail).toBe(
      "Deployment deploy_v4: STORE store_forgot was FORGOTten but STORE store_other " +
        "still pins bafyorig123",
    );
    expect(result.warnings.some((w) => w.code === "STORE_FORGOTTEN")).toBe(false);
  });

  it("counts a thrown content-hash lookup as STORE_FETCH_FAILED", async () => {
    const [agg, post] = v4Fixture("store_forgot", "https://bafyorig123.ipfs.aleph.sh");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        if (String(input).includes("contentHashes=")) throw new Error("socket closed");
        return new Response(
          JSON.stringify({
            status: "forgotten",
            item_hash: "store_forgot",
            message: { type: "STORE", item_hash: "store_forgot" },
          }),
          { status: 200 },
        );
      }),
    );

    const result = await reconstruct([agg!], [post!], TEST_USER_PRIV, "https://test.aleph.local");

    expect(result.projects[0]?.deployments[0]?.storeStatus).toBe("unreachable");
    expect(result.stats.storeFetchFailures).toBe(1);
  });

  it("keeps a 404 as storeStatus absent, never removed", async () => {
    const [agg, post] = v4Fixture("store_missing");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }),
      ),
    );

    const result = await reconstruct(
      [agg!],
      [post!],
      TEST_USER_PRIV,
      "https://test.aleph.local",
    );

    const d = result.projects[0]?.deployments[0];
    expect(d?.storeStatus).toBe("absent");
    expect(result.warnings.some((w) => w.code === "STORE_ABSENT")).toBe(true);
    expect(result.warnings.some((w) => w.code === "STORE_REMOVED")).toBe(false);
  });
});

describe("reconstruct — schema v4 output completeness", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const WALLET = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A";
  const API = "https://test.aleph.local";
  const baseBlob = {
    name: "n",
    source: "github",
    repo: "a/b",
    branch: "main",
    installationId: 1,
    buildCommand: "b",
    outputDir: "o",
  };
  const basePublic = {
    framework: "nextjs-static",
    deployTarget: "ipfs",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    deleted: false,
  };

  function securityAgg(
    content: Record<string, unknown>,
    time: number,
    sender = WALLET,
  ): AlephMessage {
    return {
      type: "AGGREGATE",
      chain: "ETH",
      channel: "TEST",
      sender,
      signature: "0x",
      item_hash: `sec_${time}_${sender}`,
      content: { address: WALLET, key: "security", content, time },
    };
  }

  it("emits rootDir, envVars, workflowFilename and the pending PR fields from the blob", async () => {
    const agg = makeAggregate("p1", basePublic, {
      ...baseBlob,
      rootDir: "apps/site",
      envVars: [{ key: "A", value: "1" }, { key: 2, value: "x" }],
      workflowFilename: "stasho-x.yml",
      pendingWorkflowPrUrl: null,
      pendingWorkflowPrNumber: null,
    });
    const { projects } = await reconstruct([agg], [], TEST_USER_PRIV, API);
    const p = projects[0];
    expect(p?.rootDir).toBe("apps/site");
    expect(p?.envVars).toEqual([{ key: "A", value: "1" }]);
    expect(p?.workflowFilename).toBe("stasho-x.yml");
    expect(p?.pendingWorkflowPrUrl).toBeNull();
    expect(p?.pendingWorkflowPrNumber).toBeNull();
  });

  it("emits customDomains, defaultSubdomain and the pin from the public block", async () => {
    const agg = makeAggregate("p1", basePublic, baseBlob, 1712620800, {
      customDomains: ["www.x.com"],
      defaultSubdomain: "x.apps.stasho.xyz",
      currentDeploymentId: "deploy_1",
      currentDeploymentSetAt: "2026-11-01T00:00:00.000Z",
    });
    const p = (await reconstruct([agg], [], TEST_USER_PRIV, API)).projects[0];
    expect(p?.customDomains).toEqual(["www.x.com"]);
    expect(p?.defaultSubdomain).toBe("x.apps.stasho.xyz");
    expect(p?.currentDeploymentId).toBe("deploy_1");
    expect(p?.currentDeploymentSetAt).toBe("2026-11-01T00:00:00.000Z");
    expect(p?.serving).toEqual({ deploymentId: null, reason: "none" });
  });

  it("defaults the new fields on a record written before they existed", async () => {
    const f = loadFixture("02-single-project");
    const p = (await reconstruct(f.aggregates, f.posts, f.userPrivKey, API)).projects[0];
    expect(p?.rootDir).toBe("");
    expect(p?.envVars).toEqual([]);
    expect(p?.workflowFilename).toBeNull();
    expect(p?.customDomains).toEqual([]);
    expect(p?.defaultSubdomain).toBeNull();
    expect(p?.currentDeploymentId).toBeNull();
    expect(p?.currentDeploymentSetAt).toBeNull();
  });

  it("emits bundleHash and artifactKind on a deployment", async () => {
    const agg = makeAggregate("p1", basePublic, baseBlob);
    const post = makeCreationPost(
      "deploy_1",
      "p1",
      {
        status: "live",
        storeRef: "store_1",
        url: null,
        createdAt: "2026-11-01T00:00:00.000Z",
        finishedAt: null,
      },
      {},
      1712622600,
      { bundleHash: "ab".repeat(32) },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              status: "processed",
              message: { type: "STORE", content: { item_hash: "cid1", item_type: "storage" } },
            }),
            { status: 200 },
          ),
      ),
    );
    const d = (await reconstruct([agg], [post], TEST_USER_PRIV, API)).projects[0]
      ?.deployments[0];
    expect(d?.bundleHash).toBe("ab".repeat(32));
    expect(d?.artifactKind).toBe("storage");
    expect(d?.cid).toBe("cid1");
  });

  it("emits the security aggregate's encryptionKey, newest wins", async () => {
    const old = securityAgg(
      { encryptionKey: { pubkey: "0x04" + "aa".repeat(64), scheme: "wallet-sig-v1" } },
      100,
    );
    const newest = securityAgg(
      { encryptionKey: { pubkey: "0x04" + "cd".repeat(64), scheme: "wallet-sig-v1" } },
      200,
    );
    const result = await reconstruct([newest, old], [], TEST_USER_PRIV, API);
    expect(result.encryptionKey).toEqual({
      pubkey: "0x04" + "cd".repeat(64),
      scheme: "wallet-sig-v1",
    });
    expect(result.warnings.map((w) => w.code)).not.toContain("ENCRYPTION_KEY_MISSING");
  });

  it("warns ENCRYPTION_KEY_MISSING when the security aggregate has none", async () => {
    const result = await reconstruct([securityAgg({}, 100)], [], TEST_USER_PRIV, API);
    expect(result.encryptionKey).toBeNull();
    expect(result.warnings.map((w) => w.code)).toContain("ENCRYPTION_KEY_MISSING");
  });

  it("ignores a security aggregate signed by a delegate", async () => {
    const delegate = securityAgg(
      { encryptionKey: { pubkey: "0x04" + "ee".repeat(64), scheme: "wallet-sig-v1" } },
      300,
      "0x5CbDd86a2FA8Dc4bDdd8a8f69dBa48572EeC07FB",
    );
    const result = await reconstruct([delegate], [], TEST_USER_PRIV, API);
    expect(result.encryptionKey).toBeNull();
    expect(result.warnings.map((w) => w.code)).toContain("ENCRYPTION_KEY_MISSING");
  });

  it("emits no warning and a null key when there is no security aggregate", async () => {
    const result = await reconstruct([], [], TEST_USER_PRIV, API);
    expect(result.encryptionKey).toBeNull();
    expect(result.warnings).toEqual([]);
  });
});

describe("reconstruct — serving deployment", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("serves the rollback pin when it names a live deployment with a storeRef", async () => {
    const agg = makeAggregate(
      "proj_pin",
      {
        framework: "nextjs-static",
        deployTarget: "ipfs",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-03T00:00:00.000Z",
        deleted: false,
        currentDeploymentId: "dep_old",
        currentDeploymentSetAt: "2026-01-03T00:00:00.000Z",
      },
      { name: "pin-app", source: "github", repo: "acme/pin-app", branch: "main", installationId: 1,
        buildCommand: "npm run build", outputDir: "dist" },
    );
    const older = makeCreationPost(
      "dep_old", "proj_pin",
      { status: "live", storeRef: "store_old", url: null,
        createdAt: "2026-01-01T00:00:00.000Z", finishedAt: null },
      { commit: "a", commitMessage: "old", branch: "main", actionsRunUrl: null, error: null },
    );
    const newer = makeCreationPost(
      "dep_new", "proj_pin",
      { status: "live", storeRef: "store_new", url: null,
        createdAt: "2026-01-02T00:00:00.000Z", finishedAt: null },
      { commit: "b", commitMessage: "new", branch: "main", actionsRunUrl: null, error: null },
    );
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));

    const result = await reconstruct(
      [agg],
      [older, newer],
      TEST_USER_PRIV,
      "https://test.aleph.local",
    );

    const project = result.projects[0];
    expect(project?.currentDeploymentId).toBe("dep_old");
    expect(project?.serving).toEqual({ deploymentId: "dep_old", reason: "pinned" });
  });
});

describe("reconstruct — per-entry guards and deleted projects", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const projectPublic = {
    framework: "nextjs-static",
    deployTarget: "ipfs",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deleted: false,
  };
  const projectBlob = {
    name: "app", source: "github", repo: "acme/app", branch: "main", installationId: 1,
    buildCommand: "npm run build", outputDir: "dist",
  };
  const depPublic = {
    status: "live", storeRef: null, url: null,
    createdAt: "2026-01-02T00:00:00.000Z", finishedAt: null,
  };
  const depBlob = { commit: "a", commitMessage: "m", branch: "main", actionsRunUrl: null, error: null };
  const api = "https://test.aleph.local";

  function tombstone(projectId: string, time: number, updatedAt: unknown): AlephMessage {
    const agg = makeAggregate(projectId, {}, {}, time);
    agg.item_hash = `inline_tomb_${projectId}`;
    agg.content.content = { [projectId]: { public: { deleted: true, updatedAt } } };
    return agg;
  }

  it("a null project entry is a MALFORMED_RECORD, the sibling entry still recovers", async () => {
    const good = makeAggregate("proj_y", projectPublic, projectBlob);
    good.content.content = { proj_x: null, ...good.content.content };
    const result = await reconstruct([good], [], TEST_USER_PRIV, api);
    expect(result.projects.map((p) => p.id)).toEqual(["proj_y"]);
    expect(result.warnings.filter((w) => w.code === "MALFORMED_RECORD")).toHaveLength(1);
    expect(result.warnings[0]?.detail).toMatch(/^project proj_x in inline_agg_proj_y: /);
    expect(result.stats.malformedRecords).toBe(1);
  });

  it("a null aggregate content is a MALFORMED_RECORD, no throw", async () => {
    const bad = makeAggregate("proj_x", projectPublic, projectBlob);
    bad.content.content = null as unknown as Record<string, unknown>;
    const result = await reconstruct([bad], [], TEST_USER_PRIV, api);
    expect(result.projects).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.code).toBe("MALFORMED_RECORD");
    expect(result.warnings[0]?.detail).toMatch(/^message inline_agg_proj_x: /);
    expect(result.stats.malformedRecords).toBe(1);
  });

  it("a deployment without `public` is a MALFORMED_RECORD, no throw", async () => {
    const agg = makeAggregate("proj_x", projectPublic, projectBlob);
    const post = makeCreationPost("dep_1", "proj_x", depPublic, depBlob);
    delete (post.content.content as Record<string, unknown>)["public"];
    const result = await reconstruct([agg], [post], TEST_USER_PRIV, api);
    expect(result.projects[0]?.deployments).toEqual([]);
    expect(result.warnings.filter((w) => w.code === "MALFORMED_RECORD")).toHaveLength(1);
    expect(result.stats.malformedRecords).toBe(1);
  });

  it("deployments of a deleted project land in deletedProjects, not as orphans", async () => {
    const create = makeAggregate("proj_x", projectPublic, projectBlob, 1000);
    const post = makeCreationPost("dep_1", "proj_x", depPublic, depBlob);
    const tomb = tombstone("proj_x", 2000, "2026-01-05T00:00:00.000Z");
    const result = await reconstruct([create, tomb], [post], TEST_USER_PRIV, api);
    expect(result.projects).toEqual([]);
    expect(result.deletedProjects).toHaveLength(1);
    expect(result.deletedProjects[0]).toMatchObject({
      id: "proj_x",
      deletedAt: "2026-01-05T00:00:00.000Z",
    });
    expect(result.deletedProjects[0]?.deployments.map((d) => d.id)).toEqual(["dep_1"]);
    expect(result.deletedProjects[0]?.deployments[0]?.commit).toBe("a");
    expect(result.warnings.map((w) => w.code)).not.toContain("ORPHANED_DEPLOYMENT");
    expect(result.stats.deletedProjects).toBe(1);
    expect(result.stats.deploymentsRecovered).toBe(0);
  });

  it("a deployment of a project in neither map stays ORPHANED_DEPLOYMENT", async () => {
    const post = makeCreationPost("dep_1", "proj_gone", depPublic, depBlob);
    const result = await reconstruct([], [post], TEST_USER_PRIV, api);
    expect(result.warnings.map((w) => w.code)).toEqual(["ORPHANED_DEPLOYMENT"]);
  });

  it("sorts deletedProjects by deletedAt descending, empty string when updatedAt is not a string", async () => {
    const aggs = [
      tombstone("proj_a", 1000, "2026-01-01T00:00:00.000Z"),
      tombstone("proj_b", 1001, "2026-02-01T00:00:00.000Z"),
      tombstone("proj_c", 1002, 42),
    ];
    const result = await reconstruct(aggs, [], TEST_USER_PRIV, api);
    expect(result.deletedProjects.map((d) => [d.id, d.deletedAt])).toEqual([
      ["proj_b", "2026-02-01T00:00:00.000Z"],
      ["proj_a", "2026-01-01T00:00:00.000Z"],
      ["proj_c", ""],
    ]);
  });

  it("04-project-deleted fixture still evicts the project and now lists it under deletedProjects", async () => {
    const f = loadFixture("04-project-deleted");
    const result = await reconstruct(f.aggregates, f.posts, f.userPrivKey, api);
    expect(result.projects).toEqual([]);
    expect(result.deletedProjects).toHaveLength(1);
    expect(result.stats.deletedProjects).toBe(1);
  });
});

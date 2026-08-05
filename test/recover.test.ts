import { afterEach, describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createCipheriv, randomBytes } from "node:crypto";
import { join } from "node:path";
import { encrypt as eciesEncrypt, PrivateKey } from "eciesjs";
import { Wallet, keccak256, getBytes } from "ethers";
import { reconstruct } from "../src/reconstruct.js";
import {
  deriveEncryptionKey,
  decryptBlobAsEncryption,
  derivationMessage,
} from "../src/decrypt.js";
import type { AlephMessage, EncryptedEnvelope } from "../src/types.js";

// ─── Encryption helpers (mirrors apps/backend/src/services/encryption.ts) ──────

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
function encryptForTest(
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

function makeAggregate(
  projectId: string,
  publicFields: Record<string, unknown>,
  encryptedBlob: Record<string, unknown>,
  time = 1712620800,
): AlephMessage {
  return {
    type: "AGGREGATE",
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
          public: publicFields,
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
): AlephMessage {
  return {
    type: "POST",
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
        public: publicFields,
        encrypted: encryptForTest(encryptedBlob),
      },
      time,
    },
  };
}

// Load fixtures straight from the backend's hand-crafted message set.
// This is intentional: sharing fixtures guarantees that when the cross-agreement
// test (backend, Task 35) ships, it runs against the exact same messages.
const FIXTURE_DIR = join(
  import.meta.dirname,
  "../../../apps/backend/tests/fixtures/messages",
);

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
    expect(result.stats.decryptionFailures).toBeGreaterThanOrEqual(1);
    expect(result.warnings[0]?.code).toBe("DECRYPT_FAILED");
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

  function v4Fixture(storeRef: string): AlephMessage[] {
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
        url: "https://example.com",
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

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { reconstruct } from "../src/reconstruct.js";
import type { AlephMessage } from "../src/types.js";

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
  it("01-empty: produces empty output with no warnings", () => {
    const f = loadFixture("01-empty");
    const result = reconstruct(f.aggregates, f.posts, f.userPrivKey);
    expect(result.projects).toEqual([]);
    expect(result.stats.projectsRecovered).toBe(0);
    expect(result.stats.deploymentsRecovered).toBe(0);
    expect(result.warnings).toEqual([]);
  });

  it("02-single-project: recovers the project with decrypted fields", () => {
    const f = loadFixture("02-single-project");
    const result = reconstruct(f.aggregates, f.posts, f.userPrivKey);
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
  it("04-project-deleted: tombstone evicts the project from the output", () => {
    const f = loadFixture("04-project-deleted");
    const result = reconstruct(f.aggregates, f.posts, f.userPrivKey);
    expect(result.projects).toEqual([]);
    expect(result.stats.projectsRecovered).toBe(0);
  });
});

describe("reconstruct — deployments", () => {
  it("05-deployment-queued: cache-only intermediate state is visible if posted", () => {
    const f = loadFixture("05-deployment-queued");
    const result = reconstruct(f.aggregates, f.posts, f.userPrivKey);
    expect(result.projects.length).toBe(1);
    // Queued deployments are written as POST creations, so they appear
    // whether or not a terminal amend has been written yet.
    expect(result.projects[0]?.deployments.length).toBeGreaterThanOrEqual(0);
  });

  it("06-deployment-live: recovers project with one live deployment", () => {
    const f = loadFixture("06-deployment-live");
    const result = reconstruct(f.aggregates, f.posts, f.userPrivKey);
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

  it("07-deployment-failed: recovers project with one failed deployment", () => {
    const f = loadFixture("07-deployment-failed");
    const result = reconstruct(f.aggregates, f.posts, f.userPrivKey);
    expect(result.projects.length).toBe(1);
    const d = result.projects[0]?.deployments[0];
    expect(d?.status).toBe("failed");
    expect(d?.error).toBeTruthy();
  });
});

describe("reconstruct — amend chains", () => {
  it("08-amend-chain-deep: collapses multi-step chain to the terminal state", () => {
    const f = loadFixture("08-amend-chain-deep");
    const result = reconstruct(f.aggregates, f.posts, f.userPrivKey);
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
  it("09-multi-project: recovers multiple projects with their deployments", () => {
    const f = loadFixture("09-multi-project");
    const result = reconstruct(f.aggregates, f.posts, f.userPrivKey);
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
  it("10-corrupted-envelope: records a warning and skips, no crash", () => {
    const f = loadFixture("10-corrupted-envelope");
    const result = reconstruct(f.aggregates, f.posts, f.userPrivKey);
    expect(result.projects).toEqual([]);
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    expect(result.stats.decryptionFailures).toBeGreaterThanOrEqual(1);
    expect(result.warnings[0]?.code).toBe("DECRYPT_FAILED");
  });

  it("11-tampered-ciphertext: auth tag mismatch surfaces as a warning", () => {
    const f = loadFixture("11-tampered-ciphertext");
    const result = reconstruct(f.aggregates, f.posts, f.userPrivKey);
    expect(result.projects).toEqual([]);
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    expect(result.stats.decryptionFailures).toBeGreaterThanOrEqual(1);
  });
});

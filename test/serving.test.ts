import { describe, it, expect } from "vitest";
import { selectServing } from "../src/serving.js";
import type { RecoveredDeployment } from "../src/types.js";

function dep(
  id: string,
  status: string,
  createdAt: string,
  storeRef: string | null,
): RecoveredDeployment {
  return {
    id,
    status,
    storeRef,
    cid: null,
    bundleHash: null,
    artifactKind: null,
    storeStatus: "no-artifact",
    url: null,
    commit: null,
    commitMessage: null,
    branch: null,
    actionsRunUrl: null,
    error: null,
    createdAt,
    finishedAt: null,
    runId: null,
    runAttempt: null,
  };
}

describe("selectServing — rollback pin rule (Decision #520)", () => {
  it("no pin: the newest live deployment serves", () =>
    expect(
      selectServing(
        [
          dep("a", "live", "2026-01-01T00:00:00Z", "s"),
          dep("b", "live", "2026-01-02T00:00:00Z", "s"),
        ],
        null,
        null,
      ),
    ).toEqual({ deploymentId: "b", reason: "newest-live" }));

  it("a pin set after the newest live build serves", () =>
    expect(
      selectServing(
        [
          dep("a", "live", "2026-01-01T00:00:00Z", "s"),
          dep("b", "live", "2026-01-02T00:00:00Z", "s"),
        ],
        "a",
        "2026-01-03T00:00:00Z",
      ),
    ).toEqual({ deploymentId: "a", reason: "pinned" }));

  it("a live build created after the pin was set supersedes it", () =>
    expect(
      selectServing(
        [
          dep("a", "live", "2026-01-01T00:00:00Z", "s"),
          dep("b", "live", "2026-01-04T00:00:00Z", "s"),
        ],
        "a",
        "2026-01-03T00:00:00Z",
      ),
    ).toEqual({ deploymentId: "b", reason: "pin-superseded" }));

  it(
    "a pin on a deployment that is not live, or has no storeRef, falls back to newest (Review Focus 2)",
    () => {
    expect(
      selectServing(
        [
          dep("a", "failed", "2026-01-01T00:00:00Z", null),
          dep("b", "live", "2026-01-02T00:00:00Z", "s"),
        ],
        "a",
        "2026-01-03T00:00:00Z",
      ),
    ).toEqual({ deploymentId: "b", reason: "newest-live" });
    expect(
      selectServing(
        [
          dep("a", "live", "2026-01-01T00:00:00Z", null),
          dep("b", "live", "2026-01-02T00:00:00Z", "s"),
        ],
        "a",
        "2026-01-03T00:00:00Z",
      ),
    ).toEqual({ deploymentId: "b", reason: "newest-live" });
    },
  );

  it("a pin naming no listed deployment, set after the newest live build, is pin-missing", () =>
    expect(
      selectServing(
        [
          dep("a", "live", "2026-01-01T00:00:00Z", "s"),
          dep("b", "live", "2026-01-02T00:00:00Z", "s"),
        ],
        "zzz",
        "2026-01-03T00:00:00Z",
      ),
    ).toEqual({ deploymentId: null, reason: "pin-missing" }));

  it("no live deployment: none", () =>
    expect(
      selectServing([dep("a", "failed", "2026-01-01T00:00:00Z", null)], null, null),
    ).toEqual({ deploymentId: null, reason: "none" }));

  it("an unparseable set time never supersedes", () =>
    expect(
      selectServing(
        [
          dep("a", "live", "2026-01-01T00:00:00Z", "s"),
          dep("b", "live", "2026-01-02T00:00:00Z", "s"),
        ],
        "a",
        "not-a-date",
      ),
    ).toEqual({ deploymentId: "a", reason: "pinned" }));
});

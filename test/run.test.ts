import { describe, expect, it } from "vitest";
import { summarize } from "../src/run.js";
import type { RecoveryOutput } from "../src/types.js";

function output(complete: boolean, exportLinesRejected = 0): RecoveryOutput {
  return {
    complete,
    projects: [{}, {}],
    deletedProjects: [{}],
    warnings: [{}, {}, {}],
    stats: {
      deploymentsRecovered: 4,
      decryptionFailures: 1,
      malformedRecords: 2,
      untrustedMessages: 3,
      truncatedQueries: 4,
      storeFetchFailures: 5,
      exportLinesRejected,
    },
  } as unknown as RecoveryOutput;
}

describe("summarize", () => {
  it("prints one line for a complete run", () => {
    expect(summarize(output(true), "out.json")).toEqual([
      "[recover] Wrote 2 projects (1 deleted), 4 deployments, 3 warnings to out.json",
    ]);
  });

  it("adds the INCOMPLETE line with every failure count", () => {
    expect(summarize(output(false), "out.json")).toEqual([
      "[recover] Wrote 2 projects (1 deleted), 4 deployments, 3 warnings to out.json",
      "[recover] INCOMPLETE: 1 decrypt failures, 2 malformed records, 3 untrusted messages, " +
        "4 truncated queries, 5 store fetch failures (exit 3)",
    ]);
  });

  it("lists rejected export lines only when there are some", () => {
    expect(summarize(output(false, 6), "out.json")[1]).toBe(
      "[recover] INCOMPLETE: 1 decrypt failures, 2 malformed records, 3 untrusted messages, " +
        "4 truncated queries, 5 store fetch failures, 6 rejected export lines (exit 3)",
    );
  });
});

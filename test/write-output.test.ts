import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeRecoveryFile } from "../src/write-output.js";

const modeOf = (path: string): number => statSync(path).mode & 0o777;

describe("writeRecoveryFile", () => {
  it("creates the file readable by the owner only", () => {
    const path = join(mkdtempSync(join(tmpdir(), "recovery-")), "out.json");
    writeRecoveryFile(path, "{}\n");
    expect(readFileSync(path, "utf8")).toBe("{}\n");
    expect(modeOf(path)).toBe(0o600);
  });

  it("narrows and truncates a file a previous run left world-readable", () => {
    const path = join(mkdtempSync(join(tmpdir(), "recovery-")), "out.json");
    writeFileSync(path, "older and longer contents", { mode: 0o644 });
    writeRecoveryFile(path, "{}\n");
    expect(readFileSync(path, "utf8")).toBe("{}\n");
    expect(modeOf(path)).toBe(0o600);
  });
});

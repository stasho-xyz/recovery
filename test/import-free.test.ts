import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// CI typechecks these two files from apps/web without installing the script's
// dependencies, so they may only import `./types.js`.
describe.each(["src/types.ts", "src/amend-chain.ts"])("%s", (file) => {
  it("imports nothing but ./types.js", () => {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    const specifiers = [...text.matchAll(/^import\b[^;]*?from\s+"([^"]+)"/gms)].map((m) => m[1]);
    for (const spec of specifiers) expect(spec).toBe("./types.js");
    expect(text).not.toMatch(/^import\s+"/m);
  });
});

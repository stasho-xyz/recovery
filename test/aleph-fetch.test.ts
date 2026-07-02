import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAllMessages } from "../src/aleph-fetch.js";

const LOWER = "0x89668b401cd9ae7664af2647dcab0b069c459354";
const CHECK = "0x89668B401Cd9Ae7664AF2647DcAB0b069C459354";

describe("fetchAllMessages CCN address boundary", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("checksums every address in the addresses param (CCN is case-sensitive)", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(String(url));
        return new Response(JSON.stringify({ messages: [] }), { status: 200 });
      }),
    );

    await fetchAllMessages("https://ccn.test", "CH", [LOWER, CHECK], "AGGREGATE");

    const decoded = decodeURIComponent(calls[0]!);
    expect(decoded).toContain(`${CHECK},${CHECK}`);
  });
});

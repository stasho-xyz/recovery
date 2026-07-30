import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAllMessages, fetchStoreMessage } from "../src/aleph-fetch.js";

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

describe("fetchStoreMessage single-message endpoint shape", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetchJson(body: unknown, status = 200) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body), { status })),
    );
  }

  it("resolves the CID from the nested message.content.item_hash", async () => {
    // Real single-message endpoint shape, verified live 2026-07-30 against
    // api2.aleph.im: the message is nested under `message`, not flat at the
    // top level (top-level keys: item_hash / message / reception_time /
    // status).
    stubFetchJson({
      status: "processed",
      item_hash: "store_hash",
      reception_time: "2026-07-30T00:00:00Z",
      message: {
        type: "STORE",
        content: { item_hash: "bafyabc", item_type: "ipfs" },
      },
    });
    const result = await fetchStoreMessage("https://ccn.test", "store_hash");
    expect(result).toEqual({ content: { item_hash: "bafyabc" } });
  });

  it("returns null for the OLD (flat, wrong) shape — regression guard", async () => {
    // The shape this function used to assume. It never matched production
    // reality, so it must NOT resolve — pins that the flat-shape read is
    // gone for good (no flat fallback, Decision #310).
    stubFetchJson({
      item_hash: "store_hash",
      type: "STORE",
      content: { item_hash: "bafyabc", item_type: "ipfs" },
    });
    const result = await fetchStoreMessage("https://ccn.test", "store_hash");
    expect(result).toBeNull();
  });

  it("returns null on 404 (hash never existed)", async () => {
    stubFetchJson({ message: "Not Found" }, 404);
    const result = await fetchStoreMessage("https://ccn.test", "never_existed");
    expect(result).toBeNull();
  });

  it("returns null on a forgotten STORE (200 + status forgotten, not 404)", async () => {
    // A FORGOTten STORE returns HTTP 200 with status "forgotten" and its
    // content stripped — never a 404 (verified live 2026-07-30).
    stubFetchJson({
      status: "forgotten",
      item_hash: "forgotten_hash",
      message: {
        type: "STORE",
        item_hash: "forgotten_hash",
        forgotten_at: 1777628237.743,
      },
      forgotten_by: ["some_forget_item_hash"],
    });
    const result = await fetchStoreMessage("https://ccn.test", "forgotten_hash");
    expect(result).toBeNull();
  });

  it("returns null when the message exists but is not a STORE", async () => {
    stubFetchJson({
      status: "processed",
      item_hash: "post_hash",
      message: { type: "POST", content: {} },
    });
    const result = await fetchStoreMessage("https://ccn.test", "post_hash");
    expect(result).toBeNull();
  });

  it("throws on non-404 transport errors", async () => {
    stubFetchJson({ error: "boom" }, 500);
    await expect(
      fetchStoreMessage("https://ccn.test", "anything"),
    ).rejects.toThrow();
  });
});

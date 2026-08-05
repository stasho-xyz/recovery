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

  it("filters by type via the CCN-honored msgTypes param, not the ignored messageType", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(String(url));
        return new Response(JSON.stringify({ messages: [] }), { status: 200 });
      }),
    );

    await fetchAllMessages("https://ccn.test", "CH", [CHECK], "AGGREGATE");

    expect(calls[0]).toContain("msgTypes=AGGREGATE");
    expect(calls[0]).not.toContain("messageType=");
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
    expect(result).toEqual({ kind: "resolved", itemHash: "bafyabc" });
  });

  it("does not resolve the OLD (flat, wrong) shape — regression guard", async () => {
    // The shape this function used to assume. It never matched production
    // reality, so it must NOT resolve — pins that the flat-shape read is
    // gone for good (no flat fallback, Decision #310).
    stubFetchJson({
      item_hash: "store_hash",
      type: "STORE",
      content: { item_hash: "bafyabc", item_type: "ipfs" },
    });
    const result = await fetchStoreMessage("https://ccn.test", "store_hash");
    expect(result).toEqual({ kind: "absent", reason: "not-a-store" });
  });

  it("classifies a 404 as absent/not-found, NOT as forgotten", async () => {
    // The conflation this split exists to prevent: a 404 means the CCN has no
    // such message. Under the live-verified vendor behavior below, a genuinely
    // forgotten STORE is a 200 — so a 404 is never the forgotten case, and
    // reporting one as "forgotten" tells a user their bytes are gone when
    // nothing established that.
    stubFetchJson({ message: "Not Found" }, 404);
    const result = await fetchStoreMessage("https://ccn.test", "never_existed");
    expect(result).toEqual({ kind: "absent", reason: "not-found" });
  });

  it("classifies a forgotten STORE (200 + status forgotten, not 404) as forgotten", async () => {
    // A FORGOTten STORE returns HTTP 200 with status "forgotten" and its
    // content stripped — never a 404 (verified live 2026-07-30). This is the
    // ONLY outcome that may claim the bytes are gone.
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
    expect(result).toEqual({ kind: "forgotten" });
  });

  it("classifies a non-STORE message as absent/not-a-store", async () => {
    stubFetchJson({
      status: "processed",
      item_hash: "post_hash",
      message: { type: "POST", content: {} },
    });
    const result = await fetchStoreMessage("https://ccn.test", "post_hash");
    expect(result).toEqual({ kind: "absent", reason: "not-a-store" });
  });

  it("classifies a STORE with no content.item_hash as absent/no-item-hash", async () => {
    stubFetchJson({
      status: "processed",
      item_hash: "store_hash",
      message: { type: "STORE", content: { item_type: "ipfs" } },
    });
    const result = await fetchStoreMessage("https://ccn.test", "store_hash");
    expect(result).toEqual({ kind: "absent", reason: "no-item-hash" });
  });

  it("classifies a STORE with an empty content.item_hash as absent", async () => {
    stubFetchJson({
      status: "processed",
      item_hash: "store_hash",
      message: { type: "STORE", content: { item_hash: "" } },
    });
    const result = await fetchStoreMessage("https://ccn.test", "store_hash");
    expect(result).toEqual({ kind: "absent", reason: "no-item-hash" });
  });

  it("throws on non-404 transport errors", async () => {
    stubFetchJson({ error: "boom" }, 500);
    await expect(
      fetchStoreMessage("https://ccn.test", "anything"),
    ).rejects.toThrow();
  });
});

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

  it("classifies a REMOVED STORE (200 + status removed) as removed, not forgotten", async () => {
    // Aleph's own garbage collection, not a FORGET. `remove_message` deletes
    // the `messages` row and the GC drops the `files` row before the status
    // flips, so the payload is a skeleton with no `content` — the bytes are
    // gone, but the cause (and the user's remedy) differs from a FORGET.
    stubFetchJson({
      status: "removed",
      item_hash: "removed_hash",
      message: { type: "STORE", item_hash: "removed_hash" },
      reason: "balance_insufficient",
      removed_at: 1777628237.743,
      size: 1234,
    });
    const result = await fetchStoreMessage("https://ccn.test", "removed_hash");
    expect(result).toEqual({ kind: "removed" });
  });

  it("classifies HTTP 410 Gone as removed rather than throwing", async () => {
    // pyaleph raises `web.HTTPGone` when the status is REMOVED but the
    // `removed_messages` snapshot row is missing (legacy removals). The body
    // is plain text, so this must be decided before any JSON parse.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("This message has been removed: gone_hash", { status: 410 }),
      ),
    );
    const result = await fetchStoreMessage("https://ccn.test", "gone_hash");
    expect(result).toEqual({ kind: "removed" });
  });

  it("classifies a REMOVING STORE as resolved — it is still forgettable", async () => {
    // Scheduled-but-not-executed removal. pyaleph's `_forget_item_hash`
    // accepts a target whose status is PROCESSED or REMOVING, and the response
    // still carries the full message, so this must resolve like a normal one.
    stubFetchJson({
      status: "removing",
      item_hash: "removing_hash",
      message: { type: "STORE", content: { item_hash: "bafyremoving" } },
      reason: "credit_insufficient",
    });
    const result = await fetchStoreMessage("https://ccn.test", "removing_hash");
    expect(result).toEqual({ kind: "resolved", itemHash: "bafyremoving" });
  });

  it("classifies a rejected message as absent even when it carries a content CID", async () => {
    // `RejectedMessageDb.message` is the raw sender-supplied dict, so a
    // `content` object can be present. Classifying on shape would call this
    // resolved and report a CID for a message the network never accepted.
    stubFetchJson({
      status: "rejected",
      item_hash: "bad_hash",
      message: { type: "STORE", content: { item_hash: "bafyneveraccepted" } },
      error_code: 5,
    });
    const result = await fetchStoreMessage("https://ccn.test", "bad_hash");
    expect(result).toEqual({ kind: "absent", reason: "rejected" });
  });

  it("classifies a pending message as absent/pending", async () => {
    // `PendingMessageStatus` serializes a `messages` ARRAY, not `message` — so
    // the reason, not the kind, is what pins this branch.
    stubFetchJson({
      status: "pending",
      item_hash: "pending_hash",
      messages: [{ type: "STORE", item_hash: "pending_hash" }],
    });
    const result = await fetchStoreMessage("https://ccn.test", "pending_hash");
    expect(result).toEqual({ kind: "absent", reason: "pending" });
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

  /**
   * 410 is the ONLY non-OK status carrying evidence about the STORE. Widening
   * the interception to any 4xx would turn a proxy's 403/429 into a false
   * "your bytes are gone".
   */
  it.each([403, 429, 500, 503])("still throws on HTTP %i", async (status) => {
    stubFetchJson({ error: "boom" }, status);
    await expect(
      fetchStoreMessage("https://ccn.test", "anything"),
    ).rejects.toThrow();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cidFromGatewayUrl,
  fetchAllMessages,
  fetchStoreMessage,
  fetchWithRetry,
  findProcessedStoreByContentHash,
} from "../src/aleph-fetch.js";

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
    expect(result).toEqual({ kind: "resolved", itemHash: "bafyabc", itemType: "ipfs" });
  });

  it("carries itemType storage on a resolved STORE", async () => {
    stubFetchJson({
      status: "processed",
      item_hash: "store_hash",
      message: { type: "STORE", content: { item_hash: "abc123", item_type: "storage" } },
    });
    const result = await fetchStoreMessage("https://ccn.test", "store_hash");
    expect(result).toEqual({ kind: "resolved", itemHash: "abc123", itemType: "storage" });
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
    expect(result).toEqual({ kind: "resolved", itemHash: "bafyremoving", itemType: "" });
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

// ─── Batching, paging and truncation ─────────────────────────────────────────

function msg(n: number): { item_hash: string } {
  return { item_hash: `h${n}` };
}

function addrs(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `0x${i.toString(16).padStart(40, "0")}`);
}

function jsonFetch(
  handler: (url: URL) => unknown,
): { fetchImpl: typeof fetch; urls: URL[] } {
  const urls: URL[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(url);
    return new Response(JSON.stringify(handler(url)), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, urls };
}

describe("fetchAllMessages batching and truncation", () => {
  it("batches 250 addresses into 3 requests and dedups by item_hash", async () => {
    const { fetchImpl, urls } = jsonFetch((url) => {
      const n = url.searchParams.get("addresses")!.split(",").length;
      return { messages: [msg(n), msg(0)] };
    });
    const result = await fetchAllMessages("https://ccn.test", "CH", addrs(250), "POST", {
      fetchImpl,
    });
    expect(urls.map((u) => u.searchParams.get("addresses")!.split(",").length)).toEqual([
      100, 100, 50,
    ]);
    expect(result.messages.map((m) => m.item_hash).sort()).toEqual(["h0", "h100", "h50"]);
    expect(result.truncated).toBeNull();
  });

  function cappedNode(total: number, pageCap: number, pages: number) {
    return jsonFetch((url) => {
      const page = Number(url.searchParams.get("page"));
      const start = (page - 1) * pageCap;
      const count = page > pages ? 0 : Math.min(pageCap, total - start);
      // A real CCN reports (page-1) × pagination as the total on an empty page.
      return {
        messages: Array.from({ length: Math.max(count, 0) }, (_, i) => msg(start + i)),
        pagination_total: count > 0 ? total : start,
        pagination_per_page: pageCap,
      };
    });
  }

  it("is not truncated when a capped node's last page completes the total", async () => {
    const { fetchImpl } = cappedNode(350, 100, 4);
    const result = await fetchAllMessages("https://ccn.test", "CH", [CHECK], "POST", {
      fetchImpl,
    });
    expect(result.messages).toHaveLength(350);
    expect(result.truncated).toBeNull();
  });

  it("is truncated when a capped node stops short of the total", async () => {
    const { fetchImpl } = cappedNode(350, 100, 3);
    const result = await fetchAllMessages("https://ccn.test", "CH", [CHECK], "POST", {
      fetchImpl,
    });
    expect(result.messages).toHaveLength(300);
    expect(result.truncated).toEqual({ fetched: 300, total: 350 });
  });

  it("reports truncated null for an absent pagination_total and a short page", async () => {
    const { fetchImpl } = jsonFetch(() => ({ messages: [msg(1)] }));
    const result = await fetchAllMessages("https://ccn.test", "CH", [CHECK], "POST", {
      fetchImpl,
    });
    expect(result.truncated).toBeNull();
  });

  it("stops at MAX_PAGES on full pages and reports truncated", async () => {
    let calls = 0;
    const { fetchImpl } = jsonFetch((url) => {
      calls++;
      const page = Number(url.searchParams.get("page"));
      return {
        messages: Array.from({ length: 200 }, (_, i) => msg(page * 1000 + i)),
      };
    });
    const result = await fetchAllMessages("https://ccn.test", "CH", [CHECK], "POST", {
      fetchImpl,
    });
    expect(calls).toBe(500);
    expect(result.truncated).toEqual({ fetched: 100_000, total: 100_000 });
  });

  it("drops non-object elements of the messages array", async () => {
    const { fetchImpl } = jsonFetch(() => ({ messages: [null, 7, "x", [1], msg(1)] }));
    const result = await fetchAllMessages("https://ccn.test", "CH", [CHECK], "POST", {
      fetchImpl,
    });
    expect(result.messages.map((m) => m.item_hash)).toEqual(["h1"]);
  });

  it("sends contentTypes and aggregateKeys comma-joined, with pagination=200", async () => {
    const { fetchImpl, urls } = jsonFetch(() => ({ messages: [] }));
    await fetchAllMessages("https://ccn.test", "CH", [CHECK], "POST", {
      fetchImpl,
      contentTypes: ["aleph-cloud-deployment", "amend"],
      aggregateKeys: ["projects", "security"],
    });
    const raw = urls[0]!.search;
    expect(raw).toContain("contentTypes=aleph-cloud-deployment%2Camend");
    expect(raw).toContain("aggregateKeys=projects%2Csecurity");
    expect(raw).toContain("pagination=200");
  });

  it("throws on a non-OK page", async () => {
    const fetchImpl = (async () => new Response("no", { status: 400 })) as typeof fetch;
    await expect(
      fetchAllMessages("https://ccn.test", "CH", [CHECK], "POST", { fetchImpl }),
    ).rejects.toThrow(/400/);
  });
});

describe("fetchWithRetry", () => {
  const fast = { timeoutMs: 1000, retries: 3 };

  it("retries a 503 then a thrown fetch and returns the third 200", async () => {
    const outcomes: Array<() => Response> = [
      () => new Response("x", { status: 503 }),
      () => {
        throw new Error("socket hang up");
      },
      () => new Response("ok", { status: 200 }),
    ];
    let i = 0;
    const fetchImpl = (async () => outcomes[i++]!()) as typeof fetch;
    const res = await fetchWithRetry("https://ccn.test/x", { ...fast, fetchImpl });
    expect(res.status).toBe(200);
    expect(i).toBe(3);
  });

  it("gives up after retries with the last error", async () => {
    let i = 0;
    const fetchImpl = (async () => {
      i++;
      throw new Error(`boom ${i}`);
    }) as typeof fetch;
    await expect(
      fetchWithRetry("https://ccn.test/x", { timeoutMs: 1000, retries: 2, fetchImpl }),
    ).rejects.toThrow("boom 2");
    expect(i).toBe(2);
  });

  it("returns the last 5xx response when retries run out", async () => {
    const fetchImpl = (async () => new Response("x", { status: 502 })) as typeof fetch;
    const res = await fetchWithRetry("https://ccn.test/x", {
      timeoutMs: 1000,
      retries: 2,
      fetchImpl,
    });
    expect(res.status).toBe(502);
  });

  it("does not retry a 400", async () => {
    let i = 0;
    const fetchImpl = (async () => {
      i++;
      return new Response("bad", { status: 400 });
    }) as typeof fetch;
    const res = await fetchWithRetry("https://ccn.test/x", { ...fast, fetchImpl });
    expect(res.status).toBe(400);
    expect(i).toBe(1);
  });

  it("aborts a request that never resolves after timeoutMs", async () => {
    const fetchImpl = ((_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch;
    await expect(
      fetchWithRetry("https://ccn.test/x", { timeoutMs: 20, retries: 1, fetchImpl }),
    ).rejects.toThrow("aborted");
  });
});

describe("findProcessedStoreByContentHash", () => {
  it("returns the item_hash of the STORE whose content pins the hash", async () => {
    const { fetchImpl, urls } = jsonFetch(() => ({
      messages: [
        { item_hash: "post1", type: "POST", content: { item_hash: "bafy1" } },
        { item_hash: "store1", type: "STORE", content: { item_hash: "bafy0" } },
        { item_hash: "store2", type: "STORE", content: { item_hash: "bafy1" } },
      ],
    }));
    const found = await findProcessedStoreByContentHash("https://ccn.test", "CH", "bafy1", {
      fetchImpl,
    });
    expect(found).toBe("store2");
    expect(urls[0]!.search).toBe(
      "?channels=CH&msgTypes=STORE&contentHashes=bafy1&pagination=50",
    );
  });

  it("returns null for an empty list and for no matching STORE", async () => {
    const empty = jsonFetch(() => ({ messages: [] }));
    expect(
      await findProcessedStoreByContentHash("https://ccn.test", "CH", "bafy1", {
        fetchImpl: empty.fetchImpl,
      }),
    ).toBeNull();
    const other = jsonFetch(() => ({
      messages: [{ item_hash: "s", type: "STORE", content: { item_hash: "bafy9" } }],
    }));
    expect(
      await findProcessedStoreByContentHash("https://ccn.test", "CH", "bafy1", {
        fetchImpl: other.fetchImpl,
      }),
    ).toBeNull();
  });

  it("throws on a non-OK response", async () => {
    const fetchImpl = (async () => new Response("no", { status: 400 })) as typeof fetch;
    await expect(
      findProcessedStoreByContentHash("https://ccn.test", "CH", "bafy1", { fetchImpl }),
    ).rejects.toThrow(/400/);
  });
});

describe("cidFromGatewayUrl", () => {
  it("extracts the CID from an Aleph IPFS gateway URL", () => {
    expect(cidFromGatewayUrl("https://bafybeid3xa.ipfs.aleph.sh")).toBe("bafybeid3xa");
  });

  it("returns null for other hosts and null", () => {
    expect(cidFromGatewayUrl("https://x.apps.stasho.xyz")).toBeNull();
    expect(cidFromGatewayUrl(null)).toBeNull();
  });
});

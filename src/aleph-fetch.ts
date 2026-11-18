import type { AlephMessage, FetchOptions, FetchResult } from "./types.js";
import { ccnAddress } from "./ccn-address.js";

const PAGE_SIZE = 200;

/** 100 × 43 chars ≈ 4,300 chars of `addresses`; the CCN 400s between 6,863 and 9,113. */
export const ADDRESS_BATCH = 100;
export const MAX_PAGES = 500;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 3;
const RETRY_BASE_MS = 500;

export type { FetchResult, FetchOptions } from "./types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `fetch` with a per-attempt timeout and bounded retries. Ported from
 * `apps/agent/src/aleph.ts:116-260`. Retries a thrown fetch, a 5xx or a 429 up
 * to `retries` attempts with `500 × 2^attempt` ms between; any other non-OK
 * response is returned as is for the caller to throw on. Out of retries, the
 * last error is thrown, or the last 5xx/429 response is returned.
 */
export async function fetchWithRetry(
  url: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs: number; retries: number },
): Promise<Response> {
  const doFetch = opts.fetchImpl ?? fetch;
  const attempts = Math.max(1, opts.retries);
  for (let attempt = 0; ; attempt++) {
    const last = attempt + 1 >= attempts;
    try {
      const res = await doFetch(url, { signal: AbortSignal.timeout(opts.timeoutMs) });
      const retryable = res.status >= 500 || res.status === 429;
      if (!retryable || last) return res;
      await res.body?.cancel();
    } catch (err) {
      if (last) throw err;
    }
    await sleep(RETRY_BASE_MS * 2 ** attempt);
  }
}

function buildListUrl(
  apiUrl: string,
  channel: string,
  addresses: readonly string[],
  messageType: string,
  page: number,
  opts: FetchOptions,
): string {
  const params = new URLSearchParams({
    channels: channel,
    addresses: addresses.map(ccnAddress).join(","),
    // `msgTypes` (plural) is the one type-filter param the CCN honors
    // server-side; `messageType` is silently ignored (verified live
    // 2026-07-28 — apps/backend/src/services/aleph-http-adapter.ts has
    // the full writeup). Callers still filter by `type` client-side.
    msgTypes: messageType,
    pagination: String(PAGE_SIZE),
    page: String(page),
  });
  // `contentTypes` is honored by the CCN; `aggregateKeys` is best-effort, so
  // callers still filter by `content.key`.
  if (opts.contentTypes) params.set("contentTypes", opts.contentTypes.join(","));
  if (opts.aggregateKeys) params.set("aggregateKeys", opts.aggregateKeys.join(","));
  return `${apiUrl}/api/v0/messages.json?${params.toString()}`;
}

interface ChunkResult {
  messages: AlephMessage[];
  truncated: { fetched: number; total: number } | null;
}

/** One address batch, every page. Truncated when the CCN reports more than it served. */
async function fetchChunk(
  apiUrl: string,
  channel: string,
  addresses: readonly string[],
  messageType: "AGGREGATE" | "POST",
  opts: FetchOptions,
): Promise<ChunkResult> {
  const retry = {
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    retries: opts.retries ?? DEFAULT_RETRIES,
  };
  const messages: AlephMessage[] = [];
  let total: number | null = null;
  let stopped = false;
  for (let page = 1; page <= MAX_PAGES && !stopped; page++) {
    const url = buildListUrl(apiUrl, channel, addresses, messageType, page, opts);
    const res = await fetchWithRetry(url, retry);
    if (!res.ok) {
      throw new Error(
        `Message fetch failed (${messageType}, page ${page}): ${res.status} ${res.statusText}`,
      );
    }
    const body = (await res.json()) as { messages?: unknown[]; pagination_total?: unknown };
    const raw = body.messages ?? [];
    // An empty page past the end reports (page-1) × pagination, not a count.
    if (raw.length > 0) {
      total = typeof body.pagination_total === "number" ? body.pagination_total : null;
    }
    messages.push(...raw.filter(isPlainObject));
    // A node may cap a page below PAGE_SIZE, so with a known total keep paging
    // until the total is met or a page comes back empty; without one, a short
    // page is the last.
    const complete = total === null ? raw.length < PAGE_SIZE : messages.length >= total;
    stopped = raw.length === 0 || complete;
  }
  const fetched = messages.length;
  if (total !== null && total > fetched) return { messages, truncated: { fetched, total } };
  if (!stopped) return { messages, truncated: { fetched, total: total ?? fetched } };
  return { messages, truncated: null };
}

function isPlainObject(value: unknown): value is AlephMessage {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Fetch every message of a given type for a set of senders in a channel,
 * batching addresses and walking the Aleph HTTP API's pagination.
 *
 * `addresses` must be non-empty (throws otherwise). Results merge and dedup by
 * `item_hash`; `truncated` sums fetched/total over the batches that the CCN
 * did not serve completely, and is `null` when every batch was complete.
 *
 * Depends only on the public `/api/v0/messages.json` endpoint — no SDK.
 */
export async function fetchAllMessages(
  apiUrl: string,
  channel: string,
  addresses: readonly string[],
  messageType: "AGGREGATE" | "POST",
  opts: FetchOptions = {},
): Promise<FetchResult> {
  if (addresses.length === 0) {
    throw new Error("fetchAllMessages: addresses must be non-empty");
  }
  const byHash = new Map<string, AlephMessage>();
  const sum = { fetched: 0, total: 0, any: false };
  for (let i = 0; i < addresses.length; i += ADDRESS_BATCH) {
    const chunk = await fetchChunk(
      apiUrl,
      channel,
      addresses.slice(i, i + ADDRESS_BATCH),
      messageType,
      opts,
    );
    for (const m of chunk.messages) byHash.set(m.item_hash, m);
    if (chunk.truncated) {
      sum.any = true;
      sum.fetched += chunk.truncated.fetched;
      sum.total += chunk.truncated.total;
    }
  }
  return {
    messages: [...byHash.values()],
    truncated: sum.any ? { fetched: sum.fetched, total: sum.total } : null,
  };
}

/**
 * The item_hash of a processed STORE in `channel` whose content pins
 * `contentHash`, or null. Finds a surviving twin of a FORGOTten STORE.
 */
export async function findProcessedStoreByContentHash(
  apiUrl: string,
  channel: string,
  contentHash: string,
  opts: FetchOptions = {},
): Promise<string | null> {
  const params = new URLSearchParams({
    channels: channel,
    msgTypes: "STORE",
    contentHashes: contentHash,
    pagination: "50",
  });
  const url = `${apiUrl}/api/v0/messages.json?${params.toString()}`;
  const res = await fetchWithRetry(url, {
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    retries: opts.retries ?? DEFAULT_RETRIES,
  });
  if (!res.ok) {
    throw new Error(
      `findProcessedStoreByContentHash ${contentHash}: HTTP ${res.status} ${res.statusText}`,
    );
  }
  const body = (await res.json()) as { messages?: unknown[] };
  for (const m of body.messages ?? []) {
    const msg = m as { item_hash?: string; type?: string; content?: { item_hash?: string } };
    if (msg?.type === "STORE" && msg.content?.item_hash === contentHash && msg.item_hash) {
      return msg.item_hash;
    }
  }
  return null;
}

/** The CID in an Aleph IPFS gateway URL (`https://<cidV1>.ipfs.aleph.sh`), else null. */
export function cidFromGatewayUrl(url: string | null): string | null {
  if (url === null) return null;
  return /^https?:\/\/(baf[a-z0-9]+)\.ipfs\./.exec(url)?.[1] ?? null;
}

/**
 * Why a STORE lookup produced no CID, short of the STORE being gone
 * (`forgotten` / `removed`).
 *
 * `rejected` and `pending` are CCN message states, not response shapes:
 * pyaleph's single-message endpoint answers 200 with those `status` values and
 * a payload that is not an accepted message. Neither says the bytes are gone.
 */
export type StoreAbsentReason =
  | "not-found"
  | "not-a-store"
  | "no-item-hash"
  | "rejected"
  | "pending";

/**
 * The distinguishable outcomes of resolving a STORE message by item_hash.
 * Mirrors `StoreLookup` in `apps/backend/src/services/aleph-replay.ts` — this
 * package is a standalone zero-backend recovery tool and cannot import from
 * the backend workspace, so the shape is duplicated deliberately.
 *
 * The "gone" kinds are kept distinct from `absent`, and from each other,
 * because the recovery report tells a user, in a disaster, whether their bytes
 * are gone and why:
 *
 *   - `forgotten` — someone broadcast a FORGET (typically a project delete).
 *   - `removed` — Aleph's own garbage collection reclaimed the message after
 *     its payer ran out of balance/credits. Same outcome for the bytes, a
 *     completely different cause, so it gets its own warning code.
 *   - `absent` — a 404, a non-STORE, a CID-less STORE, or a `rejected` /
 *     `pending` message. None of these is a statement that the bytes are gone;
 *     a 404 in particular is just the CCN not having the message.
 */
export type StoreLookup =
  | { kind: "resolved"; itemHash: string; itemType: string }
  /**
   * `unverified`: only an export sets it, for a FORGET whose signer it could not check, so the
   * report must not say the bytes are gone. A CCN lookup never sets it.
   */
  | { kind: "forgotten"; unverified?: true }
  | { kind: "removed" }
  | { kind: "absent"; reason: StoreAbsentReason };

/**
 * Classify the 200 body of the single-message endpoint by pyaleph's
 * `MessageStatus` (`types/message_status.py` has six values), not by whether a
 * `content.item_hash` happens to be present.
 *
 * `removing` and `processed` are the two states that serialize the full
 * message, so they fall through to the STORE checks and resolve normally; a
 * `removing` STORE is still retrievable, its removal has only been scheduled.
 */
function classifyStoreBody(body: {
  status?: string;
  message?: {
    type?: string;
    content?: { item_hash?: string; item_type?: string };
  };
}): StoreLookup {
  if (body.status === "forgotten") return { kind: "forgotten" };
  if (body.status === "removed") return { kind: "removed" };
  if (body.status === "rejected") return { kind: "absent", reason: "rejected" };
  if (body.status === "pending") return { kind: "absent", reason: "pending" };
  if (body.message?.type !== "STORE") {
    return { kind: "absent", reason: "not-a-store" };
  }
  const contentItemHash = body.message.content?.item_hash;
  if (!contentItemHash) return { kind: "absent", reason: "no-item-hash" };
  const itemType = body.message.content?.item_type;
  return {
    kind: "resolved",
    itemHash: contentItemHash,
    itemType: typeof itemType === "string" ? itemType : "",
  };
}

/**
 * Fetch a single STORE message by its item_hash and classify the outcome.
 * Throws on transient transport / parse failures so callers can differentiate
 * "gone" from "unreachable."
 *
 * A FORGOTten STORE is a 200 with `status: "forgotten"` and its content
 * stripped — NOT a 404 (verified live 2026-07-30, Decision #310). So a 404
 * means "the CCN has no such message", never "the bytes were forgotten".
 *
 * HTTP 410 Gone is the second face of `removed`: pyaleph's
 * `_get_message_with_status` raises `web.HTTPGone` when the status is `REMOVED`
 * but the `removed_messages` snapshot row is missing (legacy removals that
 * predate the snapshot). It is intercepted before the generic non-OK throw
 * because it carries the same "the bytes are gone" evidence as the 200 form.
 *
 * The single-message endpoint (`/api/v0/messages/<hash>`) wraps the message
 * under a `message` key — `{status, item_hash, message: {type, content,
 * ...}}` — unlike the list endpoint (`/api/v0/messages.json`, see
 * `fetchAllMessages` above) which returns flat `{type, content}` objects
 * per message. No flat-shape fallback.
 */
export async function fetchStoreMessage(
  apiUrl: string,
  itemHash: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<StoreLookup> {
  const url = `${apiUrl}/api/v0/messages/${itemHash}`;
  const res = await fetchWithRetry(url, {
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    retries: DEFAULT_RETRIES,
  });
  if (res.status === 404) return { kind: "absent", reason: "not-found" };
  if (res.status === 410) return { kind: "removed" };
  if (!res.ok) {
    throw new Error(
      `fetchStoreMessage ${itemHash}: HTTP ${res.status} ${res.statusText}`,
    );
  }
  const body = (await res.json()) as {
    status?: string;
    message?: {
      type?: string;
      content?: { item_hash?: string; item_type?: string };
    };
  };
  return classifyStoreBody(body);
}

/**
 * Where `reconstruct` resolves a deployment's STORE: the two lookups it makes,
 * so a source other than a CCN (an export on disk) can answer them.
 */
export interface StoreResolver {
  lookup(itemHash: string): Promise<StoreLookup>;
  findProcessedByContentHash(cid: string): Promise<string | null>;
}

/** The default resolver: the CCN at `apiUrl`, through the two HTTP lookups above. */
export function ccnStoreResolver(
  apiUrl: string,
  channel: string,
  fetchImpl?: typeof fetch,
): StoreResolver {
  const opts = fetchImpl ? { fetchImpl } : {};
  return {
    lookup: (itemHash) => fetchStoreMessage(apiUrl, itemHash, opts),
    findProcessedByContentHash: (cid) =>
      findProcessedStoreByContentHash(apiUrl, channel, cid, opts),
  };
}

const RAW_TIMEOUT_MS = 300_000;
const RAW_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Download the raw bytes of a stored object (`/api/v0/storage/raw/<hash>`),
 * capped at `maxBytes` (default 64 MiB). A declared `content-length` over the cap
 * is rejected before reading; a streamed body is abandoned once it passes it.
 * Ported from `resolveCiphertext` in `apps/agent/src/bundle.ts:95-160`, buffering
 * in memory instead of a temp file.
 */
export async function fetchRawStorage(
  apiUrl: string,
  storageHash: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; maxBytes?: number } = {},
): Promise<Buffer> {
  const maxBytes = opts.maxBytes ?? RAW_MAX_BYTES;
  const url = `${apiUrl}/api/v0/storage/raw/${storageHash}`;
  const res = await fetchWithRetry(url, {
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    timeoutMs: opts.timeoutMs ?? RAW_TIMEOUT_MS,
    retries: DEFAULT_RETRIES,
  });
  if (!res.ok) throw new Error(`GET ${url} failed: HTTP ${res.status}`);
  const declared = res.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    await res.body?.cancel();
    throw new Error(`GET ${url} declared content-length ${declared} over the ${maxBytes}-byte cap`);
  }
  if (!res.body) throw new Error(`GET ${url} returned an empty response body`);
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    received += chunk.byteLength;
    if (received > maxBytes) {
      throw new Error(`GET ${url} body exceeds the ${maxBytes}-byte cap`);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

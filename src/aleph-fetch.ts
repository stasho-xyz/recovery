import type { AlephMessage } from "./types.js";
import { ccnAddress } from "./ccn-address.js";

const PAGE_SIZE = 200;

/**
 * Fetch every message of a given type for a set of senders in a channel,
 * walking the Aleph HTTP API's pagination until the last page is drained.
 *
 * `addresses` must be non-empty (throws otherwise); the Aleph HTTP API
 * accepts comma-separated values in the `addresses` query parameter and
 * returns the union of messages sent by any of them.
 *
 * Depends only on the public `/api/v0/messages.json` endpoint — no SDK.
 */
export async function fetchAllMessages(
  apiUrl: string,
  channel: string,
  addresses: readonly string[],
  messageType: "AGGREGATE" | "POST",
): Promise<AlephMessage[]> {
  if (addresses.length === 0) {
    throw new Error("fetchAllMessages: addresses must be non-empty");
  }
  const all: AlephMessage[] = [];
  let page = 1;

  while (true) {
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
    const url = `${apiUrl}/api/v0/messages.json?${params.toString()}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(
        `Message fetch failed (${messageType}, page ${page}): ${res.status} ${res.statusText}`,
      );
    }
    const body = (await res.json()) as { messages?: AlephMessage[] };
    const messages = body.messages ?? [];
    all.push(...messages);
    if (messages.length < PAGE_SIZE) break;
    page++;
  }

  return all;
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
  | { kind: "resolved"; itemHash: string }
  | { kind: "forgotten" }
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
  message?: { type?: string; content?: { item_hash?: string } };
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
  return { kind: "resolved", itemHash: contentItemHash };
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
): Promise<StoreLookup> {
  const url = `${apiUrl}/api/v0/messages/${itemHash}`;
  const res = await fetch(url);
  if (res.status === 404) return { kind: "absent", reason: "not-found" };
  if (res.status === 410) return { kind: "removed" };
  if (!res.ok) {
    throw new Error(
      `fetchStoreMessage ${itemHash}: HTTP ${res.status} ${res.statusText}`,
    );
  }
  const body = (await res.json()) as {
    status?: string;
    message?: { type?: string; content?: { item_hash?: string } };
  };
  return classifyStoreBody(body);
}

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
        `Aleph fetch failed (${messageType}, page ${page}): ${res.status} ${res.statusText}`,
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
 * Fetch a single STORE message by its item_hash. Returns the message's
 * inner content (only the bits the reconstructor needs) or null when the
 * hash never existed (404), when the STORE is FORGOTten (a 200 with
 * `status: "forgotten"` and its content stripped — NOT a 404), or when the
 * message exists but isn't a STORE. Throws on transient transport / parse
 * failures so callers can differentiate "deleted" from "unreachable."
 *
 * The single-message endpoint (`/api/v0/messages/<hash>`) wraps the message
 * under a `message` key — `{status, item_hash, message: {type, content,
 * ...}}` — unlike the list endpoint (`/api/v0/messages.json`, see
 * `fetchAllMessages` above) which returns flat `{type, content}` objects
 * per message. Verified live 2026-07-30 (Decision #310). No flat-shape
 * fallback.
 */
export async function fetchStoreMessage(
  apiUrl: string,
  itemHash: string,
): Promise<{ content: { item_hash: string } } | null> {
  const url = `${apiUrl}/api/v0/messages/${itemHash}`;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(
      `fetchStoreMessage ${itemHash}: HTTP ${res.status} ${res.statusText}`,
    );
  }
  const body = (await res.json()) as {
    status?: string;
    message?: { type?: string; content?: { item_hash?: string } };
  };
  if (body.status === "forgotten") return null;
  if (body.message?.type !== "STORE" || !body.message.content?.item_hash) {
    return null;
  }
  return { content: { item_hash: body.message.content.item_hash } };
}

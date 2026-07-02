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
      messageType,
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
 * STORE is FORGOTten (404) or the message exists but isn't a STORE.
 * Throws on transient transport / parse failures so callers can
 * differentiate "deleted" from "unreachable."
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
    type?: string;
    content?: { item_hash?: string };
  };
  if (body.type !== "STORE" || !body.content?.item_hash) return null;
  return { content: { item_hash: body.content.item_hash } };
}

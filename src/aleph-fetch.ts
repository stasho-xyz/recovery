import type { AlephMessage } from "./types.js";

const PAGE_SIZE = 200;

/**
 * Fetch every message of a given type for an address in a channel,
 * walking the Aleph HTTP API's pagination until the last page is drained.
 *
 * Depends only on the public `/api/v0/messages.json` endpoint — no SDK.
 */
export async function fetchAllMessages(
  apiUrl: string,
  channel: string,
  address: string,
  messageType: "AGGREGATE" | "POST",
): Promise<AlephMessage[]> {
  const all: AlephMessage[] = [];
  let page = 1;

  while (true) {
    const params = new URLSearchParams({
      channels: channel,
      addresses: address,
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

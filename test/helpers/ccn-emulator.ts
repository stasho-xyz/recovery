import type { AlephMessage } from "../../src/types.js";
import type { StubRoutes } from "./stub-ccn.js";

/** Any message a CCN can hold: the fields its filters read. */
export interface HeldMessage {
  type: string;
  channel: string;
  sender: string;
  item_hash: string;
  content: object;
}

function field(m: HeldMessage, name: string): unknown {
  return (m.content as Record<string, unknown>)[name];
}

function listParam(url: URL, name: string): string[] | null {
  const value = url.searchParams.get(name);
  return value === null ? null : value.split(",");
}

function lower(value: unknown): string {
  return String(value).toLowerCase();
}

/** Senders `owner` authorized in a security aggregate it signed itself. */
function authorizedBy(owner: string, messages: readonly HeldMessage[]): Set<string> {
  const senders = new Set<string>();
  for (const m of messages) {
    const own = lower(m.sender) === owner && lower(field(m, "address")) === owner;
    if (m.type !== "AGGREGATE" || field(m, "key") !== "security" || !own) continue;
    const auths = (field(m, "content") as { authorizations?: unknown } | undefined)?.authorizations;
    for (const a of Array.isArray(auths) ? auths : []) {
      senders.add(lower((a as { address?: unknown }).address));
    }
  }
  return senders;
}

/**
 * The hashes a CCN holding `messages` treats as forgotten: a FORGET counts only when it is signed
 * by its target's sender, its owner (`content.address`), or a sender the owner authorized.
 */
export function forgottenBy(messages: readonly HeldMessage[]): Set<string> {
  const byHash = new Map(messages.map((m) => [m.item_hash, m]));
  const hashes = new Set<string>();
  for (const f of messages) {
    const listed = field(f, "hashes");
    if (f.type !== "FORGET" || !Array.isArray(listed)) continue;
    const signer = lower(f.sender);
    for (const h of listed) {
      const target = byHash.get(String(h));
      if (target === undefined) continue;
      const owner = lower(field(target, "address"));
      const allowed =
        signer === lower(target.sender) ||
        signer === owner ||
        authorizedBy(owner, messages).has(signer);
      if (allowed) hashes.add(target.item_hash);
    }
  }
  return hashes;
}

function matches(m: HeldMessage, url: URL): boolean {
  const filters: Array<[string[] | null, unknown]> = [
    [listParam(url, "channels"), m.channel],
    [listParam(url, "msgTypes"), m.type],
    // The CCN compares addresses exactly; `ccnAddress` checksums them on the way out.
    [listParam(url, "addresses"), m.sender],
    [listParam(url, "contentTypes"), field(m, "type")],
    [listParam(url, "contentHashes"), field(m, "item_hash")],
  ];
  return filters.every(([wanted, value]) => wanted === null || wanted.includes(String(value)));
}

/**
 * Routes for `startStubCcn` that answer as a CCN holding exactly `messages`: the list endpoint
 * filters by channel, type, sender, content type and content hash, hides FORGOTten messages (see
 * `forgottenBy`) and lists newest first by `content.time`, paged; the single-message endpoint
 * answers `forgotten`, `processed` or 404.
 */
export function ccnHolding(messages: readonly HeldMessage[]): StubRoutes {
  const forgotten = forgottenBy(messages);
  const listed = [...messages].sort(
    (a, b) => Number(field(b, "time") ?? 0) - Number(field(a, "time") ?? 0),
  );
  return {
    messages: (url) => {
      const hits = listed.filter((m) => !forgotten.has(m.item_hash) && matches(m, url));
      const size = Number(url.searchParams.get("pagination") ?? "20");
      const page = Number(url.searchParams.get("page") ?? "1");
      const served = hits.slice((page - 1) * size, page * size);
      return { messages: served as unknown as AlephMessage[], pagination_total: hits.length };
    },
    message: (hash) => {
      if (forgotten.has(hash)) {
        return { status: 200, body: { status: "forgotten", item_hash: hash } };
      }
      const m = messages.find((x) => x.item_hash === hash);
      if (m === undefined) return { status: 404, body: {} };
      return { status: 200, body: { status: "processed", item_hash: hash, message: m } };
    },
  };
}

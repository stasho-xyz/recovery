import type { AlephMessage, MessageFetcher } from "./types.js";

export interface OrchestrateDeps {
  fetcher: MessageFetcher;
}

export interface OrchestrateResult {
  aggregates: AlephMessage[];
  posts: AlephMessage[];
}

/**
 * Walk security AGGREGATEs in chronological order and accumulate every
 * `entry.address` ever listed in `authorizations[]`. The ever-authorized
 * union — never narrowed by revocations or filter changes (Decision #99
 * trust model).
 *
 * STASHO_CHANNEL_V1 stores addresses in canonical 0x-prefixed 42-char form
 * (Decision #117 hard cut). Legacy 132-char uncompressed-pubkey form
 * (0x04...) is dropped — it cannot appear on V1 data. The backend's
 * `parseAuthorizationsTimeline` handles legacy form via `utils.computeAddress`;
 * recovery is intentionally simpler since the channel hard-cut retired all
 * V0 data. If V0 recovery is ever revived, port that derivation back here.
 */
export function extractAuthorizedSenders(
  aggregates: readonly AlephMessage[],
): Set<string> {
  const securityAggs = aggregates
    .filter((m) => m.type === "AGGREGATE" && m.content.key === "security")
    .slice()
    .sort((a, b) => (a.content.time ?? 0) - (b.content.time ?? 0));

  const addresses = new Set<string>();
  for (const msg of securityAggs) {
    const inner = msg.content.content as { authorizations?: unknown };
    const auths = Array.isArray(inner.authorizations) ? inner.authorizations : [];
    for (const entry of auths) {
      if (typeof entry !== "object" || entry === null) continue;
      const addr = (entry as { address?: unknown }).address;
      if (typeof addr !== "string") continue;
      if (!addr.startsWith("0x") || addr.length !== 42) continue;
      addresses.add(addr.toLowerCase());
    }
  }
  return addresses;
}

/**
 * Reconstruct the message set for a wallet by fetching:
 *   - Query A: messages where sender == wallet (security AGGREGATEs + legacy
 *     wallet-signed data).
 *   - Query B: messages where sender ∈ ever-authorized union (delegate +
 *     session keys), filtered client-side by content.address == wallet.
 *
 * Merge + dedup by item_hash. Returns {aggregates, posts} ready to hand to
 * `reconstruct`.
 *
 * Mirrors `apps/backend/src/routes/audit.ts`'s three-query pattern (Decision
 * #100), collapsed to two queries because recovery doesn't surface
 * `senderRole` and doesn't need the per-source split.
 */
export async function orchestrate(
  deps: OrchestrateDeps,
  walletAddress: string,
): Promise<OrchestrateResult> {
  // Query A: wallet-signed messages.
  const aggA = await deps.fetcher({
    messageType: "AGGREGATE",
    addresses: [walletAddress],
  });
  const postA = await deps.fetcher({
    messageType: "POST",
    addresses: [walletAddress],
  });

  // Extract ever-authorized union from Query A's security AGGREGATEs.
  const authorized = extractAuthorizedSenders(aggA);
  authorized.delete(walletAddress.toLowerCase()); // wallet is Query A's job

  // Query B: messages signed by anyone else the user has ever authorized.
  let aggB: AlephMessage[] = [];
  let postB: AlephMessage[] = [];
  if (authorized.size > 0) {
    const addrs = [...authorized];
    aggB = await deps.fetcher({ messageType: "AGGREGATE", addresses: addrs });
    postB = await deps.fetcher({ messageType: "POST", addresses: addrs });
  }

  const walletLc = walletAddress.toLowerCase();
  const matchesWallet = (m: AlephMessage): boolean =>
    m.content.address.toLowerCase() === walletLc;

  // Merge + dedup by item_hash. Query B filtered to content.address == wallet
  // because an authorized address can write on behalf of multiple users in
  // principle.
  const seen = new Set<string>();
  const aggregates: AlephMessage[] = [];
  const posts: AlephMessage[] = [];

  for (const m of [...aggA, ...aggB.filter(matchesWallet)]) {
    if (seen.has(m.item_hash)) continue;
    seen.add(m.item_hash);
    aggregates.push(m);
  }
  for (const m of [...postA, ...postB.filter(matchesWallet)]) {
    if (seen.has(m.item_hash)) continue;
    seen.add(m.item_hash);
    posts.push(m);
  }

  return { aggregates, posts };
}

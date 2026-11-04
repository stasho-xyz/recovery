import { filterTrusted } from "./trust.js";
import type { AlephMessage, MessageFetcher, RecoveryWarning } from "./types.js";

export interface OrchestrateDeps {
  fetcher: MessageFetcher;
}

export interface OrchestrateResult {
  aggregates: AlephMessage[];
  posts: AlephMessage[];
  warnings: RecoveryWarning[];
  untrustedMessages: number;
  otherWalletMessages: number;
  truncatedQueries: number;
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
 *
 * Only security aggregates signed by the wallet count: the wallet-signed
 * security aggregate is the trust root (`apps/agent/src/aleph.ts:180-186`).
 */
export function extractAuthorizedSenders(
  aggregates: readonly AlephMessage[],
  walletAddress: string,
): Set<string> {
  const securityAggs = aggregates
    .filter(
      (m) =>
        m.type === "AGGREGATE" &&
        m.content.key === "security" &&
        m.sender.toLowerCase() === walletAddress.toLowerCase(),
    )
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
 *     session keys).
 *
 * Both queries pass through `filterTrusted` (hash binding, signature, and
 * content.address == wallet) before anything else reads them.
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
  const warnings: RecoveryWarning[] = [];
  const truncationWarnings: RecoveryWarning[] = [];
  const walletLc = walletAddress.toLowerCase();
  let otherWalletMessages = 0;
  const trust = (
    messages: AlephMessage[],
    allowedSenders: ReadonlySet<string>,
  ): AlephMessage[] => {
    const result = filterTrusted(messages, walletAddress);
    warnings.push(...result.warnings);
    otherWalletMessages += result.otherWalletMessages;
    const kept: AlephMessage[] = [];
    for (const m of result.trusted) {
      if (allowedSenders.has(m.sender.toLowerCase())) {
        kept.push(m);
        continue;
      }
      warnings.push({
        code: "UNTRUSTED_MESSAGE",
        detail: `${m.item_hash}: sender is not authorized`,
        messageHash: m.item_hash,
      });
    }
    return kept;
  };

  const fetchMessages = async (
    messageType: "AGGREGATE" | "POST",
    addresses: readonly string[],
  ): Promise<AlephMessage[]> => {
    const { messages, truncated } = await deps.fetcher({ messageType, addresses });
    if (truncated) {
      truncationWarnings.push({
        code: "ALEPH_MESSAGES_TRUNCATED",
        detail:
          `${messageType} query for ${addresses.length} addresses: ` +
          `fetched ${truncated.fetched} of ${truncated.total}`,
      });
    }
    return messages;
  };

  // Query A: wallet-signed messages; only the wallet may sign them.
  const walletOnly = new Set([walletLc]);
  const aggA = trust(
    await fetchMessages("AGGREGATE", [walletAddress]),
    walletOnly,
  );
  const postA = trust(
    await fetchMessages("POST", [walletAddress]),
    walletOnly,
  );

  // Extract ever-authorized union from Query A's security AGGREGATEs.
  const authorized = extractAuthorizedSenders(aggA, walletAddress);
  authorized.delete(walletLc); // wallet is Query A's job

  // Query B: messages signed by anyone else the user has ever authorized.
  let aggB: AlephMessage[] = [];
  let postB: AlephMessage[] = [];
  if (authorized.size > 0) {
    const addrs = [...authorized];
    const allowedB = new Set([...authorized, walletLc]);
    aggB = trust(await fetchMessages("AGGREGATE", addrs), allowedB);
    postB = trust(await fetchMessages("POST", addrs), allowedB);
  }

  // Merge + dedup by item_hash.
  const seen = new Set<string>();
  const aggregates: AlephMessage[] = [];
  const posts: AlephMessage[] = [];

  for (const m of [...aggA, ...aggB]) {
    if (seen.has(m.item_hash)) continue;
    seen.add(m.item_hash);
    aggregates.push(m);
  }
  for (const m of [...postA, ...postB]) {
    if (seen.has(m.item_hash)) continue;
    seen.add(m.item_hash);
    posts.push(m);
  }

  const distinctWarnings: RecoveryWarning[] = [];
  const warnedHashes = new Set<string>();
  for (const w of warnings) {
    if (w.messageHash !== undefined) {
      if (warnedHashes.has(w.messageHash)) continue;
      warnedHashes.add(w.messageHash);
    }
    distinctWarnings.push(w);
  }

  return {
    aggregates,
    posts,
    warnings: [...distinctWarnings, ...truncationWarnings],
    untrustedMessages: distinctWarnings.length,
    otherWalletMessages,
    truncatedQueries: truncationWarnings.length,
  };
}

import type { StoreLookup, StoreResolver } from "./aleph-fetch.js";
import { forgetsByTarget, newestFirst } from "./export-source.js";
import type { ExportMessage, ExportSet } from "./export-source.js";
import type { RecoveryWarning } from "./types.js";

/** A `StoreResolver` that also reports the FORGETs it ignored or could not verify. */
export interface ExportStoreResolver extends StoreResolver {
  /** Filled while `reconstruct` resolves STOREs; append after its warnings. */
  readonly warnings: RecoveryWarning[];
}

function lower(value: unknown): string | null {
  return typeof value === "string" ? value.toLowerCase() : null;
}

/**
 * The network rule a doctored export could otherwise bypass: a FORGET removes a message only
 * when signed by its sender, its owner (`content.address`), or a sender the wallet authorized.
 */
function forgetCounts(
  forget: ExportMessage,
  target: ExportMessage,
  trusted: ReadonlySet<string>,
): boolean {
  const signer = forget.sender.toLowerCase();
  return (
    signer === target.sender.toLowerCase() ||
    signer === lower(target.content["address"]) ||
    trusted.has(signer)
  );
}

function classify(m: ExportMessage): StoreLookup {
  if (m.type !== "STORE") return { kind: "absent", reason: "not-a-store" };
  const itemHash = m.content["item_hash"];
  if (typeof itemHash !== "string" || itemHash === "") {
    return { kind: "absent", reason: "no-item-hash" };
  }
  const itemType = m.content["item_type"];
  return { kind: "resolved", itemHash, itemType: typeof itemType === "string" ? itemType : "" };
}

function ignored(target: string, forget: ExportMessage): RecoveryWarning {
  return {
    code: "STORE_FORGET_IGNORED",
    detail:
      `STORE ${target} is not read as forgotten: FORGET ${forget.item_hash} signed by ` +
      `${forget.sender}, which is not the STORE's sender, its owner, or a sender this wallet ` +
      "authorized",
    messageHash: forget.item_hash,
  };
}

function unverified(target: string, forget: ExportMessage): RecoveryWarning {
  return {
    code: "STORE_FORGET_UNVERIFIED",
    detail:
      `STORE ${target} reads forgotten because of FORGET ${forget.item_hash} signed by ` +
      `${forget.sender}; the export does not hold the STORE, so the signer could not be ` +
      "checked against its owner.",
    messageHash: forget.item_hash,
  };
}

/**
 * STORE lookups answered from the export, as the CCN's single-message endpoint and its
 * `contentHashes` listing would answer them.
 *
 * A FORGET counts when the export holds its target and the FORGET passes `forgetCounts`; one that
 * does not is ignored (`STORE_FORGET_IGNORED`). When the export lacks the target, as it lacks
 * every message the network forgot, its owner is unknown: the FORGET still counts, with
 * `STORE_FORGET_UNVERIFIED` unless a sender the wallet trusts signed it.
 *
 * `removed` (Aleph's garbage collection of a STORE whose payer ran out of funds) leaves no
 * message behind, so an export cannot show it and this never returns it: a deployment whose
 * bytes were collected reads `resolved`.
 */
export function exportStoreResolver(
  set: ExportSet,
  channel: string,
  trusted: ReadonlySet<string>,
): ExportStoreResolver {
  const forgets = forgetsByTarget(set.messages);
  const byHash = new Map(set.messages.map((m) => [m.item_hash, m]));
  const listed = newestFirst(set.messages);
  const warnings: RecoveryWarning[] = [];
  const warned = new Set<string>();
  const warn = (w: RecoveryWarning): void => {
    const key = `${w.code}:${w.detail}`;
    if (warned.has(key)) return;
    warned.add(key);
    warnings.push(w);
  };

  const heldForgotten = (target: ExportMessage): boolean => {
    const naming = forgets.get(target.item_hash) ?? [];
    if (naming.some((f) => forgetCounts(f, target, trusted))) return true;
    for (const f of naming) warn(ignored(target.item_hash, f));
    return false;
  };

  const lookup = (itemHash: string): StoreLookup => {
    const target = byHash.get(itemHash);
    if (target !== undefined) {
      return heldForgotten(target) ? { kind: "forgotten" } : classify(target);
    }
    const naming = forgets.get(itemHash) ?? [];
    if (naming.length === 0) return { kind: "absent", reason: "not-found" };
    if (naming.some((f) => trusted.has(f.sender.toLowerCase()))) return { kind: "forgotten" };
    for (const f of naming) warn(unverified(itemHash, f));
    return { kind: "forgotten", unverified: true };
  };

  const findTwin = (cid: string): string | null => {
    for (const m of listed) {
      if (m.type !== "STORE" || m.channel !== channel || m.content["item_hash"] !== cid) continue;
      if (!heldForgotten(m)) return m.item_hash;
    }
    return null;
  };

  return {
    warnings,
    lookup: (itemHash) => Promise.resolve(lookup(itemHash)),
    findProcessedByContentHash: (cid) => Promise.resolve(findTwin(cid)),
  };
}

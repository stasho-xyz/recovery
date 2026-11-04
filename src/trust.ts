import { createHash } from "node:crypto";
import { verifyMessage } from "ethers";
import type { AlephMessage, RecoveryWarning } from "./types.js";

export interface TrustResult {
  trusted: AlephMessage[];
  warnings: RecoveryWarning[];
  /** Messages that name another wallet; skipped silently, never warned about. */
  otherWalletMessages: number;
}

type Bound = AlephMessage["content"];

function untrusted(hash: string, reason: string): RecoveryWarning {
  return { code: "UNTRUSTED_MESSAGE", detail: `${hash}: ${reason}`, messageHash: hash };
}

/**
 * Ported from `apps/agent/src/aleph.ts:62-80` (`boundContent`): the parsed
 * `item_content` is the only content the signature covers, via `item_hash`.
 */
function bindContent(m: AlephMessage): { content: Bound } | { reason: string } {
  if (typeof m.item_content !== "string") return { reason: "no inline content" };
  const digest = createHash("sha256").update(m.item_content, "utf8").digest("hex");
  if (digest !== m.item_hash) return { reason: "content hash mismatch" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(m.item_content);
  } catch {
    return { reason: "content is not an object" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { reason: "content is not an object" };
  }
  return { content: parsed as Bound };
}

/**
 * Ported from `apps/agent/src/crypto.ts:79-93` (`verifyAlephSignature`): the
 * signed string is `[chain, sender, type, item_hash].join("\n")`.
 */
function signatureRecoversSender(m: AlephMessage): boolean {
  try {
    const signed = [m.chain, m.sender, m.type, m.item_hash].join("\n");
    return verifyMessage(signed, m.signature).toLowerCase() === m.sender.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Keep only messages whose content is bound to `item_hash`, whose signature
 * recovers `sender`, and whose bound `content.address` is the wallet. Trusted
 * messages carry the bound content, never the server's `content` field.
 *
 * A message that names another wallet is not ours: the shared Stasho delegate
 * signs every user's records and Query B returns all of them, so those are
 * skipped silently (counted in `otherWalletMessages`), never warned about.
 */
export function filterTrusted(
  messages: readonly AlephMessage[],
  walletAddress: string,
): TrustResult {
  const wallet = walletAddress.toLowerCase();
  const trusted: AlephMessage[] = [];
  const warnings: RecoveryWarning[] = [];
  let otherWalletMessages = 0;
  for (const m of messages) {
    const claimed = m.content?.address;
    if (typeof claimed === "string" && claimed.toLowerCase() !== wallet) {
      otherWalletMessages++;
      continue;
    }
    const bound = bindContent(m);
    if ("reason" in bound) {
      warnings.push(untrusted(m.item_hash, bound.reason));
      continue;
    }
    if (!signatureRecoversSender(m)) {
      warnings.push(untrusted(m.item_hash, "signature does not recover sender"));
      continue;
    }
    if (String(bound.content.address).toLowerCase() !== wallet) {
      otherWalletMessages++;
      continue;
    }
    trusted.push({ ...m, content: bound.content });
  }
  return { trusted, warnings, otherWalletMessages };
}

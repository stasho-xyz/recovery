import type { AlephMessage } from "./types.js";

/**
 * Group deployment POST messages into amend chains keyed by deploymentId.
 *
 * Algorithm:
 *   1. Index all `amend` POSTs by their `content.ref` (which points at a parent hash)
 *   2. For each `aleph-cloud-deployment` creation POST, walk forward along the
 *      newest-time amend at each step until no more children exist
 *   3. The terminal node of the walk is the authoritative state for that deploymentId
 *
 * Mirrors `groupAmendChains` in `apps/backend/src/services/aleph-replay.ts`
 * so that any divergence shows up as a cross-agreement test failure.
 */
export function groupAmendChains(
  posts: AlephMessage[],
): Map<string, AlephMessage> {
  const childrenOf = new Map<string, AlephMessage[]>();

  for (const p of posts) {
    if (p.type !== "POST") continue;
    if (p.content.type === "amend" && p.content.ref) {
      const arr = childrenOf.get(p.content.ref) ?? [];
      arr.push(p);
      childrenOf.set(p.content.ref, arr);
    }
  }

  const leafByDeploymentId = new Map<string, AlephMessage>();

  for (const p of posts) {
    if (p.type !== "POST") continue;
    if (p.content.type !== "aleph-cloud-deployment") continue;
    const deploymentId = (p.content.content as { deploymentId?: string })
      .deploymentId;
    if (!deploymentId) continue;

    let current: AlephMessage = p;
    // Bound the walk by total post count to guard against cycles in malformed data.
    for (let i = 0; i < posts.length + 1; i++) {
      const children = childrenOf.get(current.item_hash) ?? [];
      if (children.length === 0) break;
      children.sort((a, b) => b.content.time - a.content.time);
      const next = children[0];
      if (!next) break;
      current = next;
    }
    leafByDeploymentId.set(deploymentId, current);
  }

  return leafByDeploymentId;
}

import type {
  AlephMessage,
  EncryptedEnvelope,
  RecoveredDeployment,
  RecoveredProject,
  RecoveryStats,
  RecoveryWarning,
} from "./types.js";
import { decryptBlobAsUser } from "./decrypt.js";
import { groupAmendChains } from "./amend-chain.js";
import { fetchStoreMessage } from "./aleph-fetch.js";

export interface ReconstructResult {
  projects: RecoveredProject[];
  warnings: RecoveryWarning[];
  stats: RecoveryStats;
}

interface ProjectAggregateEntry {
  public: {
    framework: string;
    deployTarget: "ipfs" | "instance";
    createdAt: string;
    updatedAt: string;
    deleted?: boolean;
  };
  encrypted: EncryptedEnvelope;
}

interface DeploymentPostInner {
  deploymentId: string;
  projectId: string;
  public: {
    status: string;
    storeRef?: string | null;
    cid?: string | null; // v3 legacy
    url: string | null;
    createdAt: string;
    finishedAt: string | null;
    runId?: number | null;
    runAttempt?: number | null;
  };
  encrypted: EncryptedEnvelope;
}

/**
 * Reconstruct the full project + deployment history from Aleph messages.
 *
 * Replay logic mirrors `apps/backend/src/services/aleph-replay.ts` — any
 * divergence between this function and the backend's replay is a bug.
 * The cross-agreement test (backend backlog, Task 35) will enforce that
 * invariant once shipped.
 */
export async function reconstruct(
  aggregates: AlephMessage[],
  posts: AlephMessage[],
  userPrivKey: Buffer,
  apiUrl: string,
): Promise<ReconstructResult> {
  const warnings: RecoveryWarning[] = [];
  const projectsById = new Map<string, RecoveredProject>();
  let decryptionFailures = 0;

  // Pass 1: replay all `projects` aggregates in time order.
  // Tombstones (public.deleted === true) evict entries from the map.
  const projectAggs = aggregates
    .filter((m) => m.type === "AGGREGATE" && m.content.key === "projects")
    .sort((a, b) => a.content.time - b.content.time);

  for (const m of projectAggs) {
    const entries = m.content.content as Record<string, unknown>;
    for (const [pid, raw] of Object.entries(entries)) {
      const entry = raw as ProjectAggregateEntry;
      if (entry.public?.deleted === true) {
        projectsById.delete(pid);
        continue;
      }
      try {
        const decrypted = decryptBlobAsUser(entry.encrypted, userPrivKey);
        projectsById.set(pid, {
          id: pid,
          name: (decrypted["name"] as string) ?? "",
          source: (decrypted["source"] as string) ?? "",
          repo: (decrypted["repo"] as string | null) ?? null,
          branch: (decrypted["branch"] as string | null) ?? null,
          installationId:
            (decrypted["installationId"] as number | null) ?? null,
          framework: entry.public.framework,
          buildCommand: (decrypted["buildCommand"] as string) ?? "",
          outputDir: (decrypted["outputDir"] as string) ?? "",
          deployTarget: entry.public.deployTarget,
          createdAt: entry.public.createdAt,
          updatedAt: entry.public.updatedAt,
          pendingWorkflowPrUrl:
            (decrypted["pendingWorkflowPrUrl"] as string | null) ?? null,
          pendingWorkflowPrNumber:
            (decrypted["pendingWorkflowPrNumber"] as number | null) ?? null,
          deployments: [],
        });
      } catch (err) {
        decryptionFailures++;
        warnings.push({
          code: "DECRYPT_FAILED",
          detail: `project ${pid}: ${(err as Error).message}`,
          messageHash: m.item_hash,
        });
      }
    }
  }

  // Pass 2: collapse amend chains and attach deployments to their projects.
  const groups = groupAmendChains(posts);
  let amendChainsResolved = 0;
  let deploymentsRecovered = 0;

  for (const leaf of groups.values()) {
    amendChainsResolved++;
    const inner = leaf.content.content as unknown as DeploymentPostInner;

    let decrypted: Record<string, unknown>;
    try {
      decrypted = decryptBlobAsUser(inner.encrypted, userPrivKey);
    } catch (err) {
      decryptionFailures++;
      warnings.push({
        code: "DECRYPT_FAILED",
        detail: `deployment ${inner.deploymentId}: ${(err as Error).message}`,
        messageHash: leaf.item_hash,
      });
      continue;
    }

    // Schema selection: v4 records carry `storeRef` (canonical pointer to
    // the STORE message); pre-v4 records carry `cid` directly in the public
    // block. Read both for backward compat; prefer storeRef when present.
    const storeRef = inner.public.storeRef ?? null;
    const legacyCid = inner.public.cid ?? null;
    let resolvedCid: string | null = null;
    // Only the two "gone" outcomes may tell a user in a disaster their bytes
    // are gone: a 200 + `status: "forgotten"` (someone FORGOT it) and a 200 +
    // `status: "removed"` / HTTP 410 (Aleph's GC reclaimed it). A 404 is the
    // CCN not having the message, which is a different claim.
    let storeStatus: RecoveredDeployment["storeStatus"] = "no-artifact";

    if (storeRef !== null) {
      try {
        const store = await fetchStoreMessage(apiUrl, storeRef);
        if (store.kind === "resolved") {
          resolvedCid = store.itemHash;
          storeStatus = "resolved";
        } else if (store.kind === "forgotten") {
          storeStatus = "forgotten";
          warnings.push({
            code: "STORE_FORGOTTEN",
            detail:
              `Deployment ${inner.deploymentId}: STORE ${storeRef} was ` +
              "FORGOTten on the network (bytes are gone)",
            messageHash: leaf.item_hash,
          });
        } else if (store.kind === "removed") {
          storeStatus = "removed";
          warnings.push({
            code: "STORE_REMOVED",
            detail:
              `Deployment ${inner.deploymentId}: STORE ${storeRef} was ` +
              "REMOVED by the network's garbage collection, not by a FORGET " +
              "(bytes are gone)",
            messageHash: leaf.item_hash,
          });
        } else {
          storeStatus = "absent";
          warnings.push({
            code: "STORE_ABSENT",
            detail:
              `Deployment ${inner.deploymentId}: STORE ${storeRef} could not ` +
              `be resolved (${store.reason}); not treated as forgotten`,
            messageHash: leaf.item_hash,
          });
        }
      } catch (err) {
        storeStatus = "unreachable";
        warnings.push({
          code: "STORE_FETCH_FAILED",
          detail: `Deployment ${inner.deploymentId}: failed to fetch STORE ${storeRef}: ${(err as Error).message}`,
          messageHash: leaf.item_hash,
        });
      }
    } else if (legacyCid !== null) {
      // v3 legacy — cid was inline. No storeRef to record.
      resolvedCid = legacyCid;
      storeStatus = "legacy-inline";
      warnings.push({
        code: "LEGACY_SCHEMA",
        detail: `Deployment ${inner.deploymentId}: pre-v4 record (cid in public block, no storeRef)`,
        messageHash: leaf.item_hash,
      });
    }

    const dep: RecoveredDeployment = {
      id: inner.deploymentId,
      status: inner.public.status,
      storeRef,
      cid: resolvedCid,
      storeStatus,
      url: inner.public.url,
      commit: (decrypted["commit"] as string | null) ?? null,
      commitMessage: (decrypted["commitMessage"] as string | null) ?? null,
      branch: (decrypted["branch"] as string | null) ?? null,
      actionsRunUrl: (decrypted["actionsRunUrl"] as string | null) ?? null,
      error: (decrypted["error"] as string | null) ?? null,
      createdAt: inner.public.createdAt,
      finishedAt: inner.public.finishedAt,
      runId:
        typeof inner.public.runId === "number" ? inner.public.runId : null,
      runAttempt:
        typeof inner.public.runAttempt === "number"
          ? inner.public.runAttempt
          : null,
    };

    const project = projectsById.get(inner.projectId);
    if (project) {
      project.deployments.push(dep);
      deploymentsRecovered++;
    } else {
      warnings.push({
        code: "ORPHANED_DEPLOYMENT",
        detail: `Deployment ${inner.deploymentId} references unknown project ${inner.projectId}`,
      });
    }
  }

  const projects = [...projectsById.values()];
  // Sort each project's deployments by createdAt desc so the output is stable
  // across runs regardless of how the caller received the POST messages.
  for (const p of projects) {
    p.deployments.sort((a, b) =>
      (b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
    );
  }

  return {
    projects,
    warnings,
    stats: {
      aggregateMessagesRead: aggregates.length,
      postMessagesRead: posts.length,
      amendChainsResolved,
      projectsRecovered: projects.length,
      deploymentsRecovered,
      decryptionFailures,
      warnings: warnings.length,
    },
  };
}

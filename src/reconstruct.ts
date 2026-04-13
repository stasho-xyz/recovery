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
    cid: string | null;
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
export function reconstruct(
  aggregates: AlephMessage[],
  posts: AlephMessage[],
  userPrivKey: Buffer,
): ReconstructResult {
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

    const dep: RecoveredDeployment = {
      id: inner.deploymentId,
      status: inner.public.status,
      cid: inner.public.cid,
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

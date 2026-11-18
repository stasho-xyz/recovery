import type {
  AlephMessage,
  DeletedProject,
  RecoveredEncryptionKey,
  RecoveredEnvVar,
  EncryptedEnvelope,
  RecoveredDeployment,
  RecoveredProject,
  RecoveryStats,
  RecoveryWarning,
} from "./types.js";
import { DEFAULT_CHANNEL } from "./types.js";
import { decryptBlobAsUser } from "./decrypt.js";
import { groupAmendChains } from "./amend-chain.js";
import { ccnStoreResolver, cidFromGatewayUrl } from "./aleph-fetch.js";
import type { StoreResolver } from "./aleph-fetch.js";
import { selectServing } from "./serving.js";
import {
  malformedDeploymentReason,
  malformedMessageReason,
  malformedProjectEntryReason,
} from "./guards.js";

export interface ReconstructResult {
  projects: RecoveredProject[];
  deletedProjects: DeletedProject[];
  encryptionKey: RecoveredEncryptionKey | null;
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
    customDomains?: string[];
    defaultSubdomain?: string | null;
    currentDeploymentId?: string | null;
    currentDeploymentSetAt?: string | null;
  };
  encrypted: EncryptedEnvelope;
}

interface DeploymentPostInner {
  deploymentId: string;
  projectId: string;
  public: {
    status: string;
    storeRef?: string | null;
    bundleHash?: string | null;
    cid?: string | null; // v3 legacy
    url: string | null;
    createdAt: string;
    finishedAt: string | null;
    runId?: number | null;
    runAttempt?: number | null;
  };
  encrypted: EncryptedEnvelope;
}

function readEnvVars(raw: unknown): RecoveredEnvVar[] {
  if (!Array.isArray(raw)) return [];
  const out: RecoveredEnvVar[] = [];
  for (const item of raw) {
    const v = item as { key?: unknown; value?: unknown } | null;
    if (typeof v?.key === "string" && typeof v.value === "string") {
      out.push({ key: v.key, value: v.value });
    }
  }
  return out;
}

function toArtifactKind(
  itemType: string | undefined,
): RecoveredDeployment["artifactKind"] {
  return itemType === "ipfs" || itemType === "storage" ? itemType : null;
}

/**
 * The wallet signs its own `security` aggregate, so only aggregates whose
 * sender equals `content.address` are trusted; the newest one carrying a
 * well-formed `encryptionKey` wins.
 */
function readEncryptionKey(
  aggregates: AlephMessage[],
  warnings: RecoveryWarning[],
): RecoveredEncryptionKey | null {
  const security = aggregates
    .filter(
      (m) =>
        m.type === "AGGREGATE" &&
        m.content.key === "security" &&
        m.sender.toLowerCase() === m.content.address.toLowerCase(),
    )
    .sort((a, b) => b.content.time - a.content.time);
  for (const m of security) {
    const key = m.content.content["encryptionKey"] as
      | { pubkey?: unknown; scheme?: unknown }
      | undefined;
    if (typeof key?.pubkey === "string" && typeof key.scheme === "string") {
      return { pubkey: key.pubkey, scheme: key.scheme };
    }
  }
  if (aggregates.some((m) => m.content.key === "security")) {
    warnings.push({
      code: "ENCRYPTION_KEY_MISSING",
      detail:
        "No security aggregate signed by the wallet carries an encryptionKey",
    });
  }
  return null;
}

interface ReplayState {
  projectsById: Map<string, RecoveredProject>;
  deletedById: Map<string, DeletedProject>;
  decryptionFailures: number;
  malformed: number;
}

/** Drops messages that fail the envelope guard, one MALFORMED_RECORD each. */
function keepWellFormed(
  messages: AlephMessage[],
  warnings: RecoveryWarning[],
  counts: { malformed: number },
): AlephMessage[] {
  const kept: AlephMessage[] = [];
  for (const m of messages) {
    const reason = malformedMessageReason(m);
    if (reason === null) {
      kept.push(m);
      continue;
    }
    counts.malformed++;
    const hash = (m as { item_hash?: unknown } | null)?.item_hash;
    warnings.push({
      code: "MALFORMED_RECORD",
      detail: `message ${String(hash)}: ${reason}`,
      ...(typeof hash === "string" ? { messageHash: hash } : {}),
    });
  }
  return kept;
}

function buildProject(
  pid: string,
  entry: ProjectAggregateEntry,
  decrypted: Record<string, unknown>,
): RecoveredProject {
  return {
    id: pid,
    name: (decrypted["name"] as string) ?? "",
    source: (decrypted["source"] as string) ?? "",
    repo: (decrypted["repo"] as string | null) ?? null,
    branch: (decrypted["branch"] as string | null) ?? null,
    installationId: (decrypted["installationId"] as number | null) ?? null,
    framework: entry.public.framework,
    buildCommand: (decrypted["buildCommand"] as string) ?? "",
    outputDir: (decrypted["outputDir"] as string) ?? "",
    rootDir:
      typeof decrypted["rootDir"] === "string" ? decrypted["rootDir"] : "",
    envVars: readEnvVars(decrypted["envVars"]),
    workflowFilename:
      typeof decrypted["workflowFilename"] === "string"
        ? decrypted["workflowFilename"]
        : null,
    deployTarget: entry.public.deployTarget,
    createdAt: entry.public.createdAt,
    updatedAt: entry.public.updatedAt,
    pendingWorkflowPrUrl:
      (decrypted["pendingWorkflowPrUrl"] as string | null) ?? null,
    pendingWorkflowPrNumber:
      (decrypted["pendingWorkflowPrNumber"] as number | null) ?? null,
    customDomains: Array.isArray(entry.public.customDomains)
      ? entry.public.customDomains.filter((d) => typeof d === "string")
      : [],
    defaultSubdomain: entry.public.defaultSubdomain ?? null,
    currentDeploymentId: entry.public.currentDeploymentId ?? null,
    currentDeploymentSetAt: entry.public.currentDeploymentSetAt ?? null,
    serving: { deploymentId: null, reason: "none" },
    deployments: [],
  };
}

/**
 * Pass 1: replay all `projects` aggregates in time order. A tombstone
 * (`public.deleted === true`) moves the project from `projectsById` to
 * `deletedById`; a later re-creation moves it back.
 */
function replayProjects(
  aggregates: AlephMessage[],
  userPrivKey: Buffer,
  warnings: RecoveryWarning[],
): ReplayState {
  const state: ReplayState = {
    projectsById: new Map(),
    deletedById: new Map(),
    decryptionFailures: 0,
    malformed: 0,
  };
  const projectAggs = aggregates
    .filter((m) => m.type === "AGGREGATE" && m.content.key === "projects")
    .sort((a, b) => a.content.time - b.content.time);

  for (const m of projectAggs) {
    for (const [pid, raw] of Object.entries(m.content.content)) {
      const reason = malformedProjectEntryReason(raw);
      if (reason !== null) {
        state.malformed++;
        warnings.push({
          code: "MALFORMED_RECORD",
          detail: `project ${pid} in ${m.item_hash}: ${reason}`,
          messageHash: m.item_hash,
        });
        continue;
      }
      const entry = raw as ProjectAggregateEntry;
      if (entry.public.deleted === true) {
        state.projectsById.delete(pid);
        const updatedAt = entry.public.updatedAt;
        state.deletedById.set(pid, {
          id: pid,
          deletedAt: typeof updatedAt === "string" ? updatedAt : "",
          deployments: [],
        });
        continue;
      }
      try {
        const decrypted = decryptBlobAsUser(entry.encrypted, userPrivKey);
        state.projectsById.set(pid, buildProject(pid, entry, decrypted));
        state.deletedById.delete(pid);
      } catch (err) {
        state.decryptionFailures++;
        warnings.push({
          code: "DECRYPT_FAILED",
          detail: `project ${pid}: ${(err as Error).message}`,
          messageHash: m.item_hash,
        });
      }
    }
  }
  return state;
}

/**
 * A FORGOTten STORE whose CID is in the deployment URL may still be pinned by
 * another processed STORE; when so the CID is recovered as a `content-match`.
 */
async function resolveForgotten(
  inner: DeploymentPostInner,
  forgotten: { storeRef: string; unverified: boolean },
  leafHash: string,
  stores: StoreResolver,
  warnings: RecoveryWarning[],
): Promise<{
  cid: string | null;
  storeStatus: "content-match" | "forgotten";
  artifactKind: RecoveredDeployment["artifactKind"];
}> {
  const { storeRef, unverified } = forgotten;
  const state = unverified
    ? "reads forgotten per an unverified FORGET in the export"
    : "was FORGOTten";
  const cid = cidFromGatewayUrl(inner.public.url);
  const twin = cid === null ? null : await stores.findProcessedByContentHash(cid);
  if (cid !== null && twin !== null) {
    warnings.push({
      code: "STORE_CONTENT_MATCH",
      detail:
        `Deployment ${inner.deploymentId}: STORE ${storeRef} ${state} ` +
        `but STORE ${twin} still pins ${cid}`,
      messageHash: leafHash,
    });
    return { cid, storeStatus: "content-match", artifactKind: "ipfs" };
  }
  warnings.push({
    code: "STORE_FORGOTTEN",
    detail: unverified
      ? `Deployment ${inner.deploymentId}: STORE ${storeRef} ${state} (the bytes may still exist)`
      : `Deployment ${inner.deploymentId}: STORE ${storeRef} was ` +
        "FORGOTten on the network (bytes are gone)",
    messageHash: leafHash,
  });
  return { cid: null, storeStatus: "forgotten", artifactKind: null };
}

/** Resolves the artifact pointer and builds one deployment record. */
async function buildDeployment(
  inner: DeploymentPostInner,
  decrypted: Record<string, unknown>,
  leafHash: string,
  stores: StoreResolver,
  warnings: RecoveryWarning[],
): Promise<RecoveredDeployment> {
  // Schema selection: v4 records carry `storeRef` (canonical pointer to
  // the STORE message); pre-v4 records carry `cid` directly in the public
  // block. Read both for backward compat; prefer storeRef when present.
  const storeRef = inner.public.storeRef ?? null;
  const legacyCid = inner.public.cid ?? null;
  let resolvedCid: string | null = null;
  let artifactKind: RecoveredDeployment["artifactKind"] = null;
  // Only the two "gone" outcomes may tell a user in a disaster their bytes
  // are gone: a 200 + `status: "forgotten"` (someone FORGOT it) and a 200 +
  // `status: "removed"` / HTTP 410 (Aleph's GC reclaimed it). A 404 is the
  // CCN not having the message, which is a different claim.
  let storeStatus: RecoveredDeployment["storeStatus"] = "no-artifact";

  if (storeRef !== null) {
    try {
      const store = await stores.lookup(storeRef);
      if (store.kind === "resolved") {
        resolvedCid = store.itemHash;
        storeStatus = "resolved";
        artifactKind = toArtifactKind(store.itemType);
      } else if (store.kind === "forgotten") {
        const marker = { storeRef, unverified: store.unverified === true };
        const forgotten = await resolveForgotten(inner, marker, leafHash, stores, warnings);
        resolvedCid = forgotten.cid;
        storeStatus = forgotten.storeStatus;
        artifactKind = forgotten.artifactKind;
      } else if (store.kind === "removed") {
        storeStatus = "removed";
        warnings.push({
          code: "STORE_REMOVED",
          detail:
            `Deployment ${inner.deploymentId}: STORE ${storeRef} was ` +
            "REMOVED by the network's garbage collection, not by a FORGET " +
            "(bytes are gone)",
          messageHash: leafHash,
        });
      } else {
        storeStatus = "absent";
        warnings.push({
          code: "STORE_ABSENT",
          detail:
            `Deployment ${inner.deploymentId}: STORE ${storeRef} could not ` +
            `be resolved (${store.reason}); not treated as forgotten`,
          messageHash: leafHash,
        });
      }
    } catch (err) {
      storeStatus = "unreachable";
      warnings.push({
        code: "STORE_FETCH_FAILED",
        detail: `Deployment ${inner.deploymentId}: failed to fetch STORE ${storeRef}: ${(err as Error).message}`,
        messageHash: leafHash,
      });
    }
  } else if (legacyCid !== null) {
    // v3 legacy — cid was inline. No storeRef to record.
    resolvedCid = legacyCid;
    storeStatus = "legacy-inline";
    warnings.push({
      code: "LEGACY_SCHEMA",
      detail: `Deployment ${inner.deploymentId}: pre-v4 record (cid in public block, no storeRef)`,
      messageHash: leafHash,
    });
  }

  const dep: RecoveredDeployment = {
    id: inner.deploymentId,
    status: inner.public.status,
    storeRef,
    cid: resolvedCid,
    bundleHash: inner.public.bundleHash ?? null,
    artifactKind,
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
  return dep;
}

/** Attaches a deployment to its live or deleted project; returns where it landed. */
function attachDeployment(
  dep: RecoveredDeployment,
  inner: DeploymentPostInner,
  state: ReplayState,
  warnings: RecoveryWarning[],
): "project" | "deleted" | "orphan" {
  const project = state.projectsById.get(inner.projectId);
  if (project) {
    project.deployments.push(dep);
    return "project";
  }
  const deleted = state.deletedById.get(inner.projectId);
  if (deleted) {
    deleted.deployments.push(dep);
    return "deleted";
  }
  warnings.push({
    code: "ORPHANED_DEPLOYMENT",
    detail: `Deployment ${inner.deploymentId} references unknown project ${inner.projectId}`,
  });
  return "orphan";
}

const byCreatedAtDesc = (a: RecoveredDeployment, b: RecoveredDeployment): number =>
  (b.createdAt ?? "").localeCompare(a.createdAt ?? "");

/**
 * Reconstruct the full project + deployment history from Aleph messages.
 *
 * Replay logic mirrors `apps/backend/src/services/aleph-replay.ts` — any
 * divergence between this function and the backend's replay is a bug.
 *
 * STOREs resolve through `opts.stores` when given, else through the CCN at
 * `apiUrl` on `channel` (with `opts.fetchImpl`).
 */
export async function reconstruct(
  rawAggregates: AlephMessage[],
  rawPosts: AlephMessage[],
  userPrivKey: Buffer,
  apiUrl: string,
  channel: string = DEFAULT_CHANNEL,
  opts: { fetchImpl?: typeof fetch; stores?: StoreResolver } = {},
): Promise<ReconstructResult> {
  const stores = opts.stores ?? ccnStoreResolver(apiUrl, channel, opts.fetchImpl);
  const warnings: RecoveryWarning[] = [];
  const counts = { malformed: 0 };
  const aggregates = keepWellFormed(rawAggregates, warnings, counts);
  const posts = keepWellFormed(rawPosts, warnings, counts);
  const state = replayProjects(aggregates, userPrivKey, warnings);
  let decryptionFailures = state.decryptionFailures;
  let malformedRecords = counts.malformed + state.malformed;

  // Pass 2: collapse amend chains and attach deployments to their projects.
  const groups = groupAmendChains(posts);
  let deploymentsRecovered = 0;

  for (const leaf of groups.values()) {
    const inner = leaf.content.content;
    const reason = malformedDeploymentReason(inner);
    if (reason !== null) {
      malformedRecords++;
      warnings.push({
        code: "MALFORMED_RECORD",
        detail: `deployment in ${leaf.item_hash}: ${reason}`,
        messageHash: leaf.item_hash,
      });
      continue;
    }
    const post = inner as unknown as DeploymentPostInner;
    let decrypted: Record<string, unknown>;
    try {
      decrypted = decryptBlobAsUser(post.encrypted, userPrivKey);
    } catch (err) {
      decryptionFailures++;
      warnings.push({
        code: "DECRYPT_FAILED",
        detail: `deployment ${post.deploymentId}: ${(err as Error).message}`,
        messageHash: leaf.item_hash,
      });
      continue;
    }
    const dep = await buildDeployment(post, decrypted, leaf.item_hash, stores, warnings);
    if (attachDeployment(dep, post, state, warnings) === "project") {
      deploymentsRecovered++;
    }
  }

  const projects = [...state.projectsById.values()];
  // Sort each project's deployments by createdAt desc so the output is stable
  // across runs regardless of how the caller received the POST messages.
  for (const p of projects) {
    p.deployments.sort(byCreatedAtDesc);
    p.serving = selectServing(p.deployments, p.currentDeploymentId, p.currentDeploymentSetAt);
  }
  const deletedProjects = [...state.deletedById.values()].sort((a, b) =>
    b.deletedAt.localeCompare(a.deletedAt),
  );
  for (const d of deletedProjects) d.deployments.sort(byCreatedAtDesc);

  const encryptionKey = readEncryptionKey(aggregates, warnings);

  return {
    projects,
    deletedProjects,
    encryptionKey,
    warnings,
    stats: {
      aggregateMessagesRead: rawAggregates.length,
      postMessagesRead: rawPosts.length,
      amendChainsResolved: groups.size,
      projectsRecovered: projects.length,
      deploymentsRecovered,
      decryptionFailures,
      malformedRecords,
      untrustedMessages: 0,
      truncatedQueries: 0,
      exportLinesRejected: 0,
      storeFetchFailures: warnings.filter((w) => w.code === "STORE_FETCH_FAILED").length,
      deletedProjects: deletedProjects.length,
      warnings: warnings.length,
    },
  };
}

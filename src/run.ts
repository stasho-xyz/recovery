import { fetchAllMessages } from "./aleph-fetch.js";
import type { StoreResolver } from "./aleph-fetch.js";
import {
  EXPORT_COMPLETENESS_UNPROVEN,
  ExportReadError,
  droppedLineWarnings,
  exportFetcher,
  loadExport,
} from "./export-source.js";
import type { ExportSet } from "./export-source.js";
import { exportStoreResolver } from "./export-stores.js";
import { orchestrate } from "./orchestrate.js";
import type { OrchestrateResult } from "./orchestrate.js";
import { reconstruct } from "./reconstruct.js";
import { writeRecoveryFile } from "./write-output.js";
import type { MessageFetcher, RecoveryOutput, RecoveryWarning } from "./types.js";

/** Warning codes that mean a record was lost or could not be trusted. */
export const FAILURE_CODES: ReadonlySet<string> = new Set([
  "DECRYPT_FAILED",
  "MALFORMED_RECORD",
  "UNTRUSTED_MESSAGE",
  "ALEPH_MESSAGES_TRUNCATED",
  "STORE_FETCH_FAILED",
  "EXPORT_LINE_REJECTED",
]);

export interface RecoverArgs {
  address: string;
  output: string;
  channel: string;
  alephApi: string;
  verbose: boolean;
  /** Read messages from this export file or directory; no network request is made. */
  fromExport?: string;
}

export interface RunDeps {
  fetchImpl: typeof fetch;
  stderr: (line: string) => void;
  now: () => Date;
}

function buildFetcher(args: RecoverArgs, fetchImpl: typeof fetch): MessageFetcher {
  return ({ messageType, addresses }) =>
    fetchAllMessages(args.alephApi, args.channel, addresses, messageType, {
      fetchImpl,
      ...(messageType === "POST"
        ? { contentTypes: ["aleph-cloud-deployment", "amend"] }
        : { aggregateKeys: ["projects", "security"] }),
    });
}

/** Listed only when non-zero, so the live path's line stays as documented. */
function rejectedLines(count: number): string {
  return count > 0 ? `, ${count} rejected export lines` : "";
}

/** The lines printed to stderr after a run. */
export function summarize(output: RecoveryOutput, path: string): string[] {
  const { stats } = output;
  const lines = [
    `[recover] Wrote ${output.projects.length} projects (${output.deletedProjects.length} deleted), ` +
      `${stats.deploymentsRecovered} deployments, ${output.warnings.length} warnings to ${path}`,
  ];
  if (!output.complete) {
    lines.push(
      `[recover] INCOMPLETE: ${stats.decryptionFailures} decrypt failures, ` +
        `${stats.malformedRecords} malformed records, ${stats.untrustedMessages} untrusted messages, ` +
        `${stats.truncatedQueries} truncated queries, ` +
        `${stats.storeFetchFailures} store fetch failures` +
        `${rejectedLines(stats.exportLinesRejected)} (exit 3)`,
    );
  }
  return lines;
}

interface Gathered {
  fetched: OrchestrateResult;
  stores?: StoreResolver;
  /** Before the fetch's warnings. */
  exportWarnings: RecoveryWarning[];
  /** After `reconstruct`'s warnings: the store resolver fills it while `reconstruct` runs. */
  storeWarnings: RecoveryWarning[];
}

async function gatherLive(args: RecoverArgs, deps: RunDeps): Promise<Gathered | null> {
  if (args.verbose) {
    deps.stderr(`[recover] Fetching messages from ${args.alephApi} (channel ${args.channel})...`);
  }
  try {
    const fetcher = buildFetcher(args, deps.fetchImpl);
    const fetched = await orchestrate({ fetcher }, args.address);
    return { fetched, exportWarnings: [], storeWarnings: [] };
  } catch (err) {
    deps.stderr(`error: network API unreachable at ${args.alephApi}: ${(err as Error).message}`);
    return null;
  }
}

/** The export, or null after saying why it cannot serve this channel. */
async function readExport(
  path: string,
  args: RecoverArgs,
  deps: RunDeps,
): Promise<ExportSet | null> {
  if (args.verbose) {
    deps.stderr(`[recover] Reading messages from the export at ${path} (channel ${args.channel})`);
  }
  let set: ExportSet;
  try {
    set = await loadExport(path, args.channel);
  } catch (err) {
    if (!(err instanceof ExportReadError)) throw err;
    deps.stderr(`error: cannot read the export at ${path}: ${err.message}`);
    return null;
  }
  if (args.verbose) {
    deps.stderr(`[recover] Read ${set.linesRead} lines, ${set.unused} on other channels not used`);
  }
  if (!set.messages.some((m) => m.channel === args.channel)) {
    const rejected = set.dropped.filter((d) => d.code === "EXPORT_LINE_REJECTED").length;
    const why = rejected > 0 ? ` that passed its checks (${rejected} lines rejected)` : "";
    deps.stderr(`error: the export at ${path} holds no message on channel ${args.channel}${why}`);
    return null;
  }
  return set;
}

async function gatherExport(
  path: string,
  args: RecoverArgs,
  deps: RunDeps,
): Promise<Gathered | null> {
  const set = await readExport(path, args, deps);
  if (set === null) return null;
  const fetched = await orchestrate({ fetcher: exportFetcher(set, args.channel) }, args.address);
  const stores = exportStoreResolver(set, args.channel, fetched.trustedSenders);
  return {
    fetched,
    stores,
    exportWarnings: [EXPORT_COMPLETENESS_UNPROVEN, ...droppedLineWarnings(set)],
    storeWarnings: stores.warnings,
  };
}

/**
 * Fetch (or read from `--from-export`), reconstruct and write the recovery file; exit 3 when
 * anything was lost, 20 when the network API is unreachable, 21 when the export is unreadable.
 */
export async function runRecover(
  args: RecoverArgs,
  userPrivKey: Buffer,
  deps: RunDeps,
): Promise<{ exitCode: 0 | 3 | 20 | 21; output: RecoveryOutput | null }> {
  const gathered =
    args.fromExport === undefined
      ? await gatherLive(args, deps)
      : await gatherExport(args.fromExport, args, deps);
  if (gathered === null) {
    return { exitCode: args.fromExport === undefined ? 20 : 21, output: null };
  }
  const { fetched } = gathered;
  if (args.verbose) {
    deps.stderr(
      `[recover] Fetched ${fetched.aggregates.length} AGGREGATE + ${fetched.posts.length} POST messages`,
    );
  }
  if (args.verbose && fetched.otherWalletMessages > 0) {
    deps.stderr(
      `[recover] Skipped ${fetched.otherWalletMessages} messages addressed to other wallets`,
    );
  }
  const result = await reconstruct(
    fetched.aggregates,
    fetched.posts,
    userPrivKey,
    args.alephApi,
    args.channel,
    { fetchImpl: deps.fetchImpl, ...(gathered.stores ? { stores: gathered.stores } : {}) },
  );
  const warnings = [
    ...gathered.exportWarnings,
    ...fetched.warnings,
    ...result.warnings,
    ...gathered.storeWarnings,
  ];
  const output: RecoveryOutput = {
    schemaVersion: 4,
    wallet: args.address,
    recoveredAt: deps.now().toISOString(),
    alephApiUrl: args.alephApi,
    channel: args.channel,
    complete: warnings.every((w) => !FAILURE_CODES.has(w.code)),
    encryptionKey: result.encryptionKey,
    stats: {
      ...result.stats,
      warnings: warnings.length,
      untrustedMessages: fetched.untrustedMessages,
      truncatedQueries: fetched.truncatedQueries,
      exportLinesRejected: warnings.filter((w) => w.code === "EXPORT_LINE_REJECTED").length,
    },
    projects: result.projects,
    deletedProjects: result.deletedProjects,
    warnings,
  };
  writeRecoveryFile(args.output, JSON.stringify(output, null, 2) + "\n");
  for (const line of summarize(output, args.output)) deps.stderr(line);
  return { exitCode: output.complete ? 0 : 3, output };
}

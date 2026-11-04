import { fetchAllMessages } from "./aleph-fetch.js";
import { orchestrate } from "./orchestrate.js";
import type { OrchestrateResult } from "./orchestrate.js";
import { reconstruct } from "./reconstruct.js";
import { writeRecoveryFile } from "./write-output.js";
import type { MessageFetcher, RecoveryOutput } from "./types.js";

/** Warning codes that mean a record was lost or could not be trusted. */
export const FAILURE_CODES: ReadonlySet<string> = new Set([
  "DECRYPT_FAILED",
  "MALFORMED_RECORD",
  "UNTRUSTED_MESSAGE",
  "ALEPH_MESSAGES_TRUNCATED",
  "STORE_FETCH_FAILED",
]);

export interface RecoverArgs {
  address: string;
  output: string;
  channel: string;
  alephApi: string;
  verbose: boolean;
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
        `${stats.truncatedQueries} truncated queries, ${stats.storeFetchFailures} store fetch failures (exit 3)`,
    );
  }
  return lines;
}

/** Fetch, reconstruct and write the recovery file; exit 3 when anything was lost. */
export async function runRecover(
  args: RecoverArgs,
  userPrivKey: Buffer,
  deps: RunDeps,
): Promise<{ exitCode: 0 | 3 | 20; output: RecoveryOutput | null }> {
  if (args.verbose) {
    deps.stderr(`[recover] Fetching messages from ${args.alephApi} (channel ${args.channel})...`);
  }
  let fetched: OrchestrateResult;
  try {
    fetched = await orchestrate({ fetcher: buildFetcher(args, deps.fetchImpl) }, args.address);
  } catch (err) {
    deps.stderr(`error: network API unreachable at ${args.alephApi}: ${(err as Error).message}`);
    return { exitCode: 20, output: null };
  }
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
    { fetchImpl: deps.fetchImpl },
  );
  const warnings = [...fetched.warnings, ...result.warnings];
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
    },
    projects: result.projects,
    deletedProjects: result.deletedProjects,
    warnings,
  };
  writeRecoveryFile(args.output, JSON.stringify(output, null, 2) + "\n");
  for (const line of summarize(output, args.output)) deps.stderr(line);
  return { exitCode: output.complete ? 0 : 3, output };
}

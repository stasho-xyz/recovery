import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fetchRawStorage } from "./aleph-fetch.js";
import { decryptBundle, deriveEncryptionKey, encryptionPubkeyOf } from "./decrypt.js";
import type { RunDeps } from "./run.js";
import type { RecoveredDeployment, RecoveryOutput } from "./types.js";
import { writeRecoveryFile } from "./write-output.js";

export interface BundleArgs {
  from: string;
  deployment: string;
  output: string;
  alephApi: string;
  verbose: boolean;
}

type BundleExit = 0 | 20 | 30 | 31 | 32 | 33;

/** The deployment with this id, searching live projects then deleted ones. */
export function findDeployment(
  output: RecoveryOutput,
  deploymentId: string,
): RecoveredDeployment | null {
  for (const project of [...output.projects, ...output.deletedProjects]) {
    const found = project.deployments.find((d) => d.id === deploymentId);
    if (found) return found;
  }
  return null;
}

function readRecoveryFile(path: string): RecoveryOutput | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return `cannot read ${path}: ${(err as Error).message}`;
  }
  const file = parsed as { schemaVersion?: unknown } | null;
  if (typeof file !== "object" || file === null || file.schemaVersion !== 4) {
    return `${path} is not a recovery file (expected schemaVersion 4)`;
  }
  return parsed as RecoveryOutput;
}

/** Rebuild one deployment's bundle: fetch, verify the hash, decrypt, write. */
export async function runBundle(
  args: BundleArgs,
  userPrivKey: Buffer,
  deps: RunDeps,
): Promise<{ exitCode: BundleExit }> {
  const file = readRecoveryFile(args.from);
  if (typeof file === "string") return fail(deps, 32, file);
  const dep = findDeployment(file, args.deployment);
  if (dep === null) {
    return fail(deps, 32, `deployment ${args.deployment} not found in ${args.from}`);
  }
  if (dep.bundleHash === null) {
    return fail(deps, 32, `deployment ${args.deployment} has no bundleHash`);
  }
  if (dep.cid === null) return fail(deps, 32, `deployment ${args.deployment} has no cid`);

  const encryptionKey = await deriveEncryptionKey(userPrivKey);
  const derived = encryptionPubkeyOf(encryptionKey);
  if (file.encryptionKey === null) {
    deps.stderr("warning: the recovery file has no encryption key; cannot check this wallet's key");
  } else if (file.encryptionKey.pubkey.toLowerCase() !== derived.toLowerCase()) {
    return fail(
      deps,
      31,
      `encryption key mismatch: the recovery file records ${file.encryptionKey.pubkey}, ` +
        `this wallet key derives ${derived}`,
    );
  }

  const apiUrl = args.alephApi || file.alephApiUrl;
  if (args.verbose) deps.stderr(`[recover] Fetching ${dep.cid} from ${apiUrl}...`);
  let bytes: Buffer;
  try {
    bytes = await fetchRawStorage(apiUrl, dep.cid, { fetchImpl: deps.fetchImpl });
  } catch (err) {
    return fail(deps, 20, `network API unreachable at ${apiUrl}: ${(err as Error).message}`);
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== dep.bundleHash) {
    return fail(
      deps,
      30,
      `bundle hash mismatch: the recovery file records ${dep.bundleHash}, ` +
        `the fetched bytes hash to ${digest}`,
    );
  }

  let plaintext: Buffer;
  try {
    plaintext = decryptBundle(JSON.parse(bytes.toString("utf8")), encryptionKey);
  } catch (err) {
    return fail(deps, 33, `cannot decrypt the bundle: ${(err as Error).message}`);
  }
  writeRecoveryFile(args.output, plaintext);
  const plainDigest = createHash("sha256").update(plaintext).digest("hex");
  deps.stderr(
    `[recover] Wrote bundle for ${dep.id} ` +
      `(${plaintext.length} bytes, sha256 ${plainDigest}) to ${args.output}`,
  );
  return { exitCode: 0 };
}

function fail<C extends BundleExit>(deps: RunDeps, exitCode: C, message: string): { exitCode: C } {
  deps.stderr(`error: ${message}`);
  return { exitCode };
}

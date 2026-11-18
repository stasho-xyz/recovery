export const DEFAULT_CHANNEL = "STASHO_CHANNEL_V1";

export interface EncryptedEnvelope {
  /**
   * Envelope format version. Current backend writes `v: 3`. Older records on
   * the public ledger may carry `v: 1` / `v: 2`; the recovery script reads
   * envelopes version-agnostically (via `deks.user`), so it accepts all three.
   */
  v: 1 | 2 | 3;
  alg: "aes-256-gcm";
  ct: string;
  iv: string;
  tag: string;
  deks: {
    /** Wallet-pubkey recipient — the recovery script's primary decrypt path. */
    user: string;
    /**
     * Deterministic wallet-derived encryption key (Decision #117). Mandatory
     * since envelope v3. Absent on pre-v3 records.
     */
    encryption?: string;
    /**
     * Backend standing-key recipient. Removed in envelope v3 (Thread 2 step 3,
     * 2026-05-22) — the backend is no longer a standing decrypt recipient.
     * Present only on legacy v1/v2 records; never read by the recovery script.
     */
    backend?: string;
  };
}

export interface AlephMessage {
  type: "AGGREGATE" | "POST";
  channel: string;
  chain: string;
  sender: string;
  signature: string;
  item_hash: string;
  item_content?: string;
  content: {
    address: string;
    key?: string;
    type?: string;
    ref?: string;
    content: Record<string, unknown>;
    time: number;
  };
}

export interface RecoveredProject {
  id: string;
  name: string;
  source: string;
  repo: string | null;
  branch: string | null;
  installationId: number | null;
  framework: string;
  buildCommand: string;
  outputDir: string;
  rootDir: string;
  envVars: RecoveredEnvVar[];
  workflowFilename: string | null;
  deployTarget: "ipfs" | "instance";
  createdAt: string;
  updatedAt: string;
  pendingWorkflowPrUrl: string | null;
  pendingWorkflowPrNumber: number | null;
  customDomains: string[];
  defaultSubdomain: string | null;
  currentDeploymentId: string | null;
  currentDeploymentSetAt: string | null;
  serving: ServingDeployment;
  deployments: RecoveredDeployment[];
}

export interface RecoveredEnvVar {
  key: string;
  value: string;
}

export interface ServingDeployment {
  deploymentId: string | null;
  reason: "pinned" | "newest-live" | "pin-superseded" | "pin-missing" | "none";
}

export interface DeletedProject {
  id: string;
  deletedAt: string;
  deployments: RecoveredDeployment[];
}

export interface RecoveredEncryptionKey {
  pubkey: string;
  scheme: string;
}

export interface RecoveredDeployment {
  id: string;
  status: string;
  /**
   * STORE message item_hash. v4 deployments reference their artifact via
   * this hash; v3 legacy records have null here. Resolves to `cid` via
   * `fetchStoreMessage`.
   */
  storeRef: string | null;
  cid: string | null;
  bundleHash: string | null;
  /** From the STORE message's `item_type`; null when the STORE was not resolved. */
  artifactKind: "ipfs" | "storage" | null;
  /**
   * Outcome of resolving `storeRef`. Distinguishes the ways a CID can fail to
   * come back, because this report is what a user reads in a disaster to learn
   * whether their artifact bytes still exist:
   *
   *   - `"resolved"`    — `cid` is populated; the artifact is retrievable.
   *   - `"content-match"` — the STORE was FORGOTten, but another processed STORE
   *     still pins the same CID, so `cid` is populated and the bytes may be
   *     retrievable.
   *   - `"forgotten"`   — the STORE was definitively FORGOTten on Aleph
   *     (typically because the project was deleted). The deployment metadata
   *     is preserved here for audit, but the bytes are unrecoverable through
   *     Aleph's index.
   *   - `"removed"`     — Aleph's own garbage collection reclaimed the STORE
   *     after its payer ran out of balance or credits. Nobody issued a FORGET.
   *     The bytes are equally unrecoverable through Aleph's index; the cause is
   *     different, and so is the remedy (fund the account before re-uploading).
   *   - `"absent"`      — the CCN has no such message, it isn't a STORE, it
   *     carries no CID, or it is rejected / still pending. NOT a statement that
   *     the bytes were forgotten: a different CCN, or the same one later, may
   *     still have it.
   *   - `"unreachable"` — the lookup itself failed (transport / HTTP error).
   *     Says nothing about the STORE; retry against a healthy CCN.
   *   - `"legacy-inline"` — pre-v4 record whose CID was inline in the public
   *     block, so no STORE lookup was performed.
   *   - `"no-artifact"` — the record references neither a `storeRef` nor an
   *     inline CID (e.g. a deployment that never reached a published
   *     artifact). Nothing to resolve.
   */
  storeStatus:
    | "resolved"
    | "content-match"
    | "forgotten"
    | "removed"
    | "absent"
    | "unreachable"
    | "legacy-inline"
    | "no-artifact";
  url: string | null;
  commit: string | null;
  commitMessage: string | null;
  branch: string | null;
  actionsRunUrl: string | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  runId: number | null;
  runAttempt: number | null;
}

export interface RecoveryWarning {
  code: string;
  detail: string;
  messageHash?: string;
}

export interface RecoveryStats {
  aggregateMessagesRead: number;
  postMessagesRead: number;
  amendChainsResolved: number;
  projectsRecovered: number;
  deploymentsRecovered: number;
  decryptionFailures: number;
  malformedRecords: number;
  untrustedMessages: number;
  truncatedQueries: number;
  /** Lines of a `--from-export` export that failed a check and were dropped; 0 on the live path. */
  exportLinesRejected: number;
  storeFetchFailures: number;
  deletedProjects: number;
  warnings: number;
}

export interface RecoveryOutput {
  schemaVersion: 4;
  wallet: string;
  recoveredAt: string;
  alephApiUrl: string;
  channel: string;
  complete: boolean;
  encryptionKey: RecoveredEncryptionKey | null;
  stats: RecoveryStats;
  projects: RecoveredProject[];
  deletedProjects: DeletedProject[];
  warnings: RecoveryWarning[];
}

/**
 * Abstraction over `fetchAllMessages` so the orchestration layer is testable
 * without globalThis.fetch stubs. Built as a closure in `main.ts` that bakes
 * in `apiUrl` and `channel`; tests pass an in-memory implementation that
 * records calls.
 */
export type MessageFetcher = (args: {
  messageType: "AGGREGATE" | "POST";
  addresses: readonly string[];
}) => Promise<FetchResult>;

export interface FetchOptions {
  contentTypes?: readonly string[];
  aggregateKeys?: readonly string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
}

export interface FetchResult {
  messages: AlephMessage[];
  truncated: { fetched: number; total: number } | null;
}

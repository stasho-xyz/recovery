export interface EncryptedEnvelope {
  v: 2;
  alg: "aes-256-gcm";
  ct: string;
  iv: string;
  tag: string;
  deks: {
    user: string;
    backend: string;
    /** Optional third recipient: deterministic wallet-derived encryption key (Decision #117). */
    encryption?: string;
  };
}

export interface AlephMessage {
  type: "AGGREGATE" | "POST";
  channel: string;
  sender: string;
  signature: string;
  item_hash: string;
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
  deployTarget: "ipfs" | "instance";
  createdAt: string;
  updatedAt: string;
  pendingWorkflowPrUrl: string | null;
  pendingWorkflowPrNumber: number | null;
  deployments: RecoveredDeployment[];
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
  /**
   * True when the STORE referenced by `storeRef` is no longer on Aleph
   * (FORGOTten — typically because the project was deleted). The
   * deployment metadata is preserved here for audit, but the artifact
   * bytes are unrecoverable through Aleph's index.
   */
  storeForgotten: boolean;
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
  warnings: number;
}

export interface RecoveryOutput {
  $schema: string;
  schemaVersion: 3;
  wallet: string;
  recoveredAt: string;
  alephApiUrl: string;
  channel: string;
  stats: RecoveryStats;
  projects: RecoveredProject[];
  warnings: RecoveryWarning[];
}

export interface EncryptedEnvelope {
  v: 1;
  alg: "aes-256-gcm";
  ct: string;
  iv: string;
  tag: string;
  deks: { user: string; backend: string };
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
  deployments: RecoveredDeployment[];
}

export interface RecoveredDeployment {
  id: string;
  status: string;
  cid: string | null;
  url: string | null;
  commit: string | null;
  commitMessage: string | null;
  branch: string | null;
  actionsRunUrl: string | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
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
  schemaVersion: 1;
  wallet: string;
  recoveredAt: string;
  alephApiUrl: string;
  channel: string;
  stats: RecoveryStats;
  projects: RecoveredProject[];
  warnings: RecoveryWarning[];
}

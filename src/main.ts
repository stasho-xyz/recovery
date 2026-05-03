#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { Wallet } from "ethers";
import { fetchAllMessages } from "./aleph-fetch.js";
import { reconstruct } from "./reconstruct.js";
import type { RecoveryOutput } from "./types.js";

interface CliArgs {
  address: string;
  output: string;
  channel: string;
  alephApi: string;
  verbose: boolean;
  stdin: boolean;
}

const DEFAULTS = {
  channel: "ALEPH-CLOUDAPP",
  alephApi: "https://api1.aleph.im",
} as const;

// Exit codes — documented so users can script around them.
const EXIT = {
  OK: 0,
  MISSING_REQUIRED_ARG: 2,
  MISSING_PRIVATE_KEY: 10,
  INVALID_PRIVATE_KEY: 11,
  ADDRESS_MISMATCH: 12,
  ALEPH_API_UNREACHABLE: 20,
  UNEXPECTED: 99,
} as const;

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    address: "",
    output: "",
    channel: DEFAULTS.channel,
    alephApi: DEFAULTS.alephApi,
    verbose: false,
    stdin: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--address") args.address = argv[++i] ?? "";
    else if (a === "--output") args.output = argv[++i] ?? "";
    else if (a === "--channel") args.channel = argv[++i] ?? DEFAULTS.channel;
    else if (a === "--aleph-api")
      args.alephApi = argv[++i] ?? DEFAULTS.alephApi;
    else if (a === "--verbose") args.verbose = true;
    else if (a === "--stdin") args.stdin = true;
    else if (a === "--help" || a === "-h") {
      printUsage();
      process.exit(EXIT.OK);
    }
  }
  if (!args.address || !args.output) {
    printUsage();
    process.exit(EXIT.MISSING_REQUIRED_ARG);
  }
  return args;
}

function printUsage(): void {
  process.stderr.write(
    `Usage: USER_PRIVATE_KEY=0x... npm run recover -- --address 0x... --output ./out.json [options]

Required:
  --address ADDR   Ethereum address whose data to recover
  --output PATH    Path to write the recovery JSON

Options:
  --channel NAME   Aleph channel (default: ${DEFAULTS.channel})
  --aleph-api URL  Aleph HTTP API URL (default: ${DEFAULTS.alephApi})
  --verbose        Print progress to stderr
  --stdin          Read USER_PRIVATE_KEY from stdin instead of env
  --help, -h       Print this help

Environment:
  USER_PRIVATE_KEY  Hex-encoded wallet private key (0x-prefixed or not).
                    Required unless --stdin is set.

Exit codes:
  0   Success
  2   Missing required argument
  10  Private key not provided
  11  Private key is not 32 bytes of hex
  12  Derived address does not match --address
  20  Aleph API unreachable
  99  Unexpected error
`,
  );
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

function logVerbose(verbose: boolean, msg: string): void {
  if (verbose) process.stderr.write(`[recover] ${msg}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let rawKey = process.env["USER_PRIVATE_KEY"];
  if (args.stdin) rawKey = await readStdin();
  if (!rawKey) {
    process.stderr.write(
      "error: USER_PRIVATE_KEY env var is required (or use --stdin)\n",
    );
    process.exit(EXIT.MISSING_PRIVATE_KEY);
  }

  const hex = rawKey.replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    process.stderr.write(
      "error: private key must be 32 bytes of hex (64 hex chars)\n",
    );
    process.exit(EXIT.INVALID_PRIVATE_KEY);
  }
  const userPrivKey = Buffer.from(hex, "hex");

  // Sanity check: private key must derive to the address the user claims
  // they want to recover. Catches the common "I pasted the wrong key" mistake
  // before doing any network I/O.
  const wallet = new Wallet("0x" + hex);
  if (wallet.address.toLowerCase() !== args.address.toLowerCase()) {
    process.stderr.write(
      `error: private key derives to ${wallet.address}, not ${args.address}\n`,
    );
    process.exit(EXIT.ADDRESS_MISMATCH);
  }

  logVerbose(
    args.verbose,
    `Fetching messages from ${args.alephApi} (channel ${args.channel})...`,
  );

  let aggregates, posts;
  try {
    aggregates = await fetchAllMessages(
      args.alephApi,
      args.channel,
      args.address,
      "AGGREGATE",
    );
    posts = await fetchAllMessages(
      args.alephApi,
      args.channel,
      args.address,
      "POST",
    );
  } catch (err) {
    process.stderr.write(
      `error: Aleph API unreachable at ${args.alephApi}: ${(err as Error).message}\n`,
    );
    process.exit(EXIT.ALEPH_API_UNREACHABLE);
  }

  logVerbose(
    args.verbose,
    `Fetched ${aggregates.length} AGGREGATE + ${posts.length} POST messages`,
  );

  const result = await reconstruct(
    aggregates,
    posts,
    userPrivKey,
    args.alephApi,
  );

  const output: RecoveryOutput = {
    $schema: "https://app.stasho.xyz/schemas/recovery-v2.json",
    schemaVersion: 3,
    wallet: args.address,
    recoveredAt: new Date().toISOString(),
    alephApiUrl: args.alephApi,
    channel: args.channel,
    stats: result.stats,
    projects: result.projects,
    warnings: result.warnings,
  };

  writeFileSync(args.output, JSON.stringify(output, null, 2) + "\n");

  process.stderr.write(
    `[recover] Wrote ${result.projects.length} projects, ${result.stats.deploymentsRecovered} deployments, ${result.warnings.length} warnings to ${args.output}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`error: ${(err as Error).message}\n`);
  process.exit(EXIT.UNEXPECTED);
});

#!/usr/bin/env node
import { Wallet } from "ethers";
import { runBundle } from "./bundle.js";
import { runRecover } from "./run.js";
import type { RunDeps } from "./run.js";
import { DEFAULT_CHANNEL } from "./types.js";

interface CliArgs {
  address: string;
  output: string;
  channel: string;
  alephApi: string;
  verbose: boolean;
  stdin: boolean;
}

const DEFAULTS = {
  channel: DEFAULT_CHANNEL,
  alephApi: "https://api.aleph.im",
} as const;

// Exit codes — documented so users can script around them.
const EXIT = {
  OK: 0,
  MISSING_REQUIRED_ARG: 2,
  MISSING_PRIVATE_KEY: 10,
  INVALID_PRIVATE_KEY: 11,
  ADDRESS_MISMATCH: 12,
  INCOMPLETE: 3,
  ALEPH_API_UNREACHABLE: 20,
  BUNDLE_HASH_MISMATCH: 30,
  ENCRYPTION_KEY_MISMATCH: 31,
  BUNDLE_INPUT_INVALID: 32,
  BUNDLE_UNDECRYPTABLE: 33,
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
    `Usage: npm run recover -- [recover] --address 0x... --output ./out.json [options]
       npm run recover -- bundle --from ./out.json --deployment ID --output ./bundle.tar.gz [options]

Read the key so it stays out of your shell history and your later commands:
  ( printf 'Wallet key: '; read -rs USER_PRIVATE_KEY; echo; export USER_PRIVATE_KEY
    npm run recover -- --address 0x... --output ./out.json )

Required:
  --address ADDR   Ethereum address whose data to recover
  --output PATH    Path to write the recovery JSON

Options:
  --channel NAME   Storage channel (default: ${DEFAULTS.channel})
  --aleph-api URL  Network HTTP API URL (default: ${DEFAULTS.alephApi})
  --verbose        Print progress to stderr
  --stdin          Read USER_PRIVATE_KEY from stdin instead of env
  --help, -h       Print this help

bundle options:
  --from PATH        Recovery JSON written by recover
  --deployment ID    Deployment to rebuild
  --output PATH      Path to write the bundle (.tar.gz)
  --aleph-api URL, --verbose, --stdin as above

Environment:
  USER_PRIVATE_KEY  Hex-encoded wallet private key (0x-prefixed or not).
                    Required unless --stdin is set.

Exit codes:
  0   Complete: every record was recovered
  2   Missing required argument
  3   Incomplete: the file is written, but some records were lost
  10  Private key not provided
  11  Private key is not 32 bytes of hex
  12  Derived address does not match --address
  20  Network API unreachable
  30  bundle: fetched bytes do not match the recorded bundleHash
  31  bundle: this key does not derive the recovery file's encryption key
  32  bundle: deployment not found, no bundleHash or cid, or not a recovery file
  33  bundle: not a stasho-bundle envelope, or it cannot be decrypted
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

function runDeps(): RunDeps {
  return {
    fetchImpl: fetch,
    stderr: (line) => process.stderr.write(`${line}\n`),
    now: () => new Date(),
  };
}

async function recover(args: CliArgs, userPrivKey: Buffer): Promise<number> {
  const { exitCode } = await runRecover(args, userPrivKey, runDeps());
  return exitCode;
}

interface BundleCliArgs {
  from: string;
  deployment: string;
  output: string;
  alephApi: string;
  verbose: boolean;
  stdin: boolean;
}

function parseBundleArgs(argv: string[]): BundleCliArgs {
  const args: BundleCliArgs = {
    from: "",
    deployment: "",
    output: "",
    alephApi: "",
    verbose: false,
    stdin: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from") args.from = argv[++i] ?? "";
    else if (a === "--deployment") args.deployment = argv[++i] ?? "";
    else if (a === "--output") args.output = argv[++i] ?? "";
    else if (a === "--aleph-api") args.alephApi = argv[++i] ?? "";
    else if (a === "--verbose") args.verbose = true;
    else if (a === "--stdin") args.stdin = true;
    else if (a === "--help" || a === "-h") {
      printUsage();
      process.exit(EXIT.OK);
    }
  }
  if (!args.from || !args.deployment || !args.output) {
    printUsage();
    process.exit(EXIT.MISSING_REQUIRED_ARG);
  }
  return args;
}

async function readUserPrivKey(stdin: boolean): Promise<Buffer> {
  let rawKey = process.env["USER_PRIVATE_KEY"];
  if (stdin) rawKey = await readStdin();
  if (!rawKey) {
    process.stderr.write("error: USER_PRIVATE_KEY env var is required (or use --stdin)\n");
    process.exit(EXIT.MISSING_PRIVATE_KEY);
  }
  const hex = rawKey.replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    process.stderr.write("error: private key must be 32 bytes of hex (64 hex chars)\n");
    process.exit(EXIT.INVALID_PRIVATE_KEY);
  }
  return Buffer.from(hex, "hex");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "bundle") {
    const args = parseBundleArgs(argv.slice(1));
    const userPrivKey = await readUserPrivKey(args.stdin);
    const { exitCode } = await runBundle(args, userPrivKey, runDeps());
    process.exit(exitCode);
  }
  const args = parseArgs(argv[0] === "recover" ? argv.slice(1) : argv);
  const userPrivKey = await readUserPrivKey(args.stdin);

  // Sanity check: private key must derive to the address the user claims
  // they want to recover. Catches the common "I pasted the wrong key" mistake
  // before doing any network I/O.
  const wallet = new Wallet("0x" + userPrivKey.toString("hex"));
  if (wallet.address.toLowerCase() !== args.address.toLowerCase()) {
    process.stderr.write(
      `error: private key derives to ${wallet.address}, not ${args.address}\n`,
    );
    process.exit(EXIT.ADDRESS_MISMATCH);
  }

  process.exit(await recover(args, userPrivKey));
}

main().catch((err) => {
  process.stderr.write(`error: ${(err as Error).message}\n`);
  process.exit(EXIT.UNEXPECTED);
});

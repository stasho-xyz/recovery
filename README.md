# Stasho recovery script

Rebuilds your Stasho projects and deployment history from the signed records your wallet published
to the public network, and can rebuild an App VM deployment's bundle. Your wallet key stays on your
machine: the script reads it from the environment or standard input and sends it nowhere. It checks
every message against its hash and its signature before it reads it. It talks to a public API node
(`--aleph-api`, `https://api.aleph.im` by default), so the Stasho backend is not involved.

This directory is a repository folder, not an npm package: `package.json` sets `private: true`.
The full walkthrough is at <https://docs.stasho.xyz/guides/recover-your-data>; the record formats
are at <https://docs.stasho.xyz/reference/storage-schema>.

## Requirements

- Node.js 22 or later
- Your wallet's private key (32 bytes of hex) and its address

## Install

```bash
npm ci --ignore-scripts
```

## Run

Read the key so it stays out of your shell history and your later commands:

```bash
( printf 'Wallet key: '; read -rs USER_PRIVATE_KEY; echo; export USER_PRIVATE_KEY
  npm run recover -- --address 0xYOUR_WALLET_ADDRESS --output ./my-recovery.json )
```

Or pipe the key from a password manager with `--stdin`:

```bash
op read "op://Private/My wallet/private key" \
  | npm run recover -- --stdin --address 0xYOUR_WALLET_ADDRESS --output ./my-recovery.json
```

Options: `--channel`, `--aleph-api`, `--verbose`, `--stdin`, `--help`.

## The `bundle` command

Rebuilds one App VM deployment's bundle from a recovery file you already made:

```bash
( printf 'Wallet key: '; read -rs USER_PRIVATE_KEY; echo; export USER_PRIVATE_KEY
  npm run recover -- bundle --from ./my-recovery.json --deployment deploy_XXXXXXXXXXXX \
    --output ./bundle.tar.gz )
```

It checks that the key derives the recovery file's encryption key, that the downloaded bytes match
the deployment's `bundleHash`, and that the envelope decrypts, then writes the decrypted archive.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Complete: every record was recovered |
| `2` | A required argument is missing |
| `3` | The file is written, but some records were lost |
| `10` | No private key |
| `11` | The key is not 32 bytes of hex |
| `12` | The key derives to a different address than `--address` |
| `20` | The network API is unreachable |
| `30` | `bundle`: the bytes do not match the recorded `bundleHash` |
| `31` | `bundle`: the key does not derive the recovery file's encryption key |
| `32` | `bundle`: the deployment is not in the file, has no `bundleHash` or `cid`, or the file is not a recovery file |
| `33` | `bundle`: not a `stasho-bundle` envelope, or it cannot be decrypted |
| `99` | Unexpected error; the message says what |

## Output

The script writes one JSON file with your projects, deployments, `complete`, `stats` and
`warnings`. The field list is in the
[guide](https://docs.stasho.xyz/guides/recover-your-data#_3-inspect-the-output).

## Warning codes

The codes and what to do about each are in the
[guide](https://docs.stasho.xyz/guides/recover-your-data#warning-codes).

## Dependencies

Three runtime packages, pinned exactly in `package.json` and `package-lock.json`:

- `eciesjs`: ECIES-secp256k1 decryption of the key wraps
- `ethers`: wallet and signature verification
- `tsx`: runs the TypeScript entry point (`src/main.ts`) without a build step

`npm audit --omit=dev` reports the `ws` advisory through `ethers` and an `esbuild` advisory
through `tsx`. The script opens no WebSocket, and it does not run esbuild's development server.

## Tests

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
```

These run from a copy of this directory alone: the test fixtures are vendored under
`test/fixtures/messages/`.

## License

MIT, see [LICENSE](LICENSE).

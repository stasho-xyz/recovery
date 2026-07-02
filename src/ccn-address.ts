import { getAddress } from "ethers";

/**
 * Canonicalize a wallet address for a CCN-facing URL or query parameter.
 *
 * CCN endpoints are case-sensitive on addresses: `messages.json?addresses=`
 * silently returns zero results for a lowercase address, because data is
 * stored under the EIP-55-checksummed form the writes used. The recovery
 * orchestrator deliberately lowercases the ever-authorized union for its
 * internal dedup set, so the URL boundary must re-checksum — without this,
 * Query A/B silently miss all messages and recovery reconstructs nothing
 * (Decisions #130, #186, #188).
 *
 * Falls back to the raw input on non-address values so fail-soft read
 * paths keep their "no data" contract instead of throwing.
 */
export function ccnAddress(address: string): string {
  try {
    return getAddress(address);
  } catch {
    return address;
  }
}

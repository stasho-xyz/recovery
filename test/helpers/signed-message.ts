import { createHash } from "node:crypto";
import { Wallet } from "ethers";
import type { AlephMessage } from "../../src/types.js";

export const WALLET = new Wallet(`0x${"11".repeat(32)}`);
export const DELEGATE = new Wallet(`0x${"33".repeat(32)}`);
export const SESSION_KEY = new Wallet(`0x${"44".repeat(32)}`);

/** A signed STORE or FORGET: its content has no `content` of its own. */
export interface SignedRawMessage {
  type: "STORE" | "FORGET";
  channel: string;
  chain: string;
  sender: string;
  signature: string;
  item_hash: string;
  item_content: string;
  content: Record<string, unknown>;
}

export async function signedMessage(
  signer: Wallet,
  msg: { type: "AGGREGATE" | "POST"; channel: string; content: AlephMessage["content"] },
): Promise<AlephMessage>;
export async function signedMessage(
  signer: Wallet,
  msg: { type: "STORE" | "FORGET"; channel: string; content: Record<string, unknown> },
): Promise<SignedRawMessage>;
export async function signedMessage(
  signer: Wallet,
  msg: { type: string; channel: string; content: object },
): Promise<object> {
  const chain = "ETH";
  const item_content = JSON.stringify(msg.content);
  const item_hash = createHash("sha256").update(item_content, "utf8").digest("hex");
  const sender = signer.address;
  const signature = await signer.signMessage(
    [chain, sender, msg.type, item_hash].join("\n"),
  );
  return {
    type: msg.type,
    channel: msg.channel,
    chain,
    sender,
    signature,
    item_hash,
    item_content,
    content: msg.content,
  };
}

/**
 * One export line for `m`, shaped as the CCN's `/api/v0/messages.json` lists it: the message
 * plus `item_type`, `time`, `size` and the confirmation fields.
 */
export function exportLine(m: AlephMessage | SignedRawMessage, time = 1712620000): string {
  return JSON.stringify({
    chain: m.chain,
    channel: m.channel,
    confirmations: [],
    confirmed: false,
    content: m.content,
    item_content: m.item_content,
    item_hash: m.item_hash,
    item_type: "inline",
    sender: m.sender,
    signature: m.signature,
    size: m.item_content?.length ?? 0,
    time,
    type: m.type,
  });
}

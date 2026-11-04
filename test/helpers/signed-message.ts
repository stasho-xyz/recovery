import { createHash } from "node:crypto";
import { Wallet } from "ethers";
import type { AlephMessage } from "../../src/types.js";

export const WALLET = new Wallet(`0x${"11".repeat(32)}`);
export const DELEGATE = new Wallet(`0x${"33".repeat(32)}`);
export const SESSION_KEY = new Wallet(`0x${"44".repeat(32)}`);

export async function signedMessage(
  signer: Wallet,
  msg: {
    type: "AGGREGATE" | "POST";
    channel: string;
    content: AlephMessage["content"];
  },
): Promise<AlephMessage> {
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

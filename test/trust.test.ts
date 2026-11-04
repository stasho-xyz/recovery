import { describe, it, expect } from "vitest";
import { filterTrusted } from "../src/trust.js";
import { DELEGATE, WALLET, signedMessage } from "./helpers/signed-message.js";
import type { AlephMessage } from "../src/types.js";

const content = (address: string): AlephMessage["content"] => ({
  address,
  key: "projects",
  content: { proj_1: { public: {}, encrypted: {} } },
  time: 1712622600,
});

const make = (address = WALLET.address) =>
  signedMessage(DELEGATE, { type: "AGGREGATE", channel: "TEST", content: content(address) });

describe("filterTrusted", () => {
  it("passes a well-formed message and carries the bound content", async () => {
    const msg = await make();
    const forged = { ...msg, content: { ...content(WALLET.address), time: 1 } };
    const { trusted, warnings } = filterTrusted([forged], WALLET.address);
    expect(warnings).toEqual([]);
    expect(trusted).toHaveLength(1);
    expect(trusted[0]?.content).toEqual(JSON.parse(msg.item_content as string));
  });

  it("accepts a lowercase wallet argument", async () => {
    const { trusted } = filterTrusted([await make()], WALLET.address.toLowerCase());
    expect(trusted).toHaveLength(1);
  });

  it("rejects tampered item_content", async () => {
    const msg = await make();
    const tampered = { ...msg, item_content: (msg.item_content as string).replace("1712622600", "1712622601") };
    const { trusted, warnings } = filterTrusted([tampered], WALLET.address);
    expect(trusted).toEqual([]);
    expect(warnings).toEqual([
      {
        code: "UNTRUSTED_MESSAGE",
        detail: `${msg.item_hash}: content hash mismatch`,
        messageHash: msg.item_hash,
      },
    ]);
  });

  it("rejects a message whose signature does not recover the sender", async () => {
    const msg = await make();
    const { trusted, warnings } = filterTrusted(
      [{ ...msg, sender: WALLET.address }],
      WALLET.address,
    );
    expect(trusted).toEqual([]);
    expect(warnings[0]?.detail).toBe(`${msg.item_hash}: signature does not recover sender`);
  });

  it("rejects a message with no item_content", async () => {
    const { item_content: _drop, ...msg } = await make();
    const { trusted, warnings } = filterTrusted([msg], WALLET.address);
    expect(trusted).toEqual([]);
    expect(warnings[0]?.detail).toBe(`${msg.item_hash}: no inline content`);
  });

  it("rejects item_content that is not a JSON object", async () => {
    const msg = await make();
    const item_content = "[1,2]";
    const { createHash } = await import("node:crypto");
    const item_hash = createHash("sha256").update(item_content).digest("hex");
    const { warnings } = filterTrusted([{ ...msg, item_content, item_hash }], WALLET.address);
    expect(warnings[0]?.detail).toBe(`${item_hash}: content is not an object`);
  });

  it("skips a valid message whose content.address is another wallet, silently", async () => {
    const msg = await make("0xDEAD000000000000000000000000000000000000");
    const result = filterTrusted([msg], WALLET.address);
    expect(result.trusted).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.otherWalletMessages).toBe(1);
  });

  it("skips a message the node reports as another wallet's before any integrity check", async () => {
    const msg = await make();
    const tampered = {
      ...msg,
      content: content("0xDEAD000000000000000000000000000000000000"),
      item_content: "garbage",
    };
    const result = filterTrusted([tampered], WALLET.address);
    expect(result.warnings).toEqual([]);
    expect(result.otherWalletMessages).toBe(1);
  });

  it("still warns for a message with no address anywhere and a bad signature", async () => {
    const msg = await signedMessage(DELEGATE, {
      type: "AGGREGATE",
      channel: "TEST",
      content: { key: "projects", content: {}, time: 1 } as AlephMessage["content"],
    });
    const { content: _drop, ...rest } = msg;
    const bad = { ...rest, sender: WALLET.address } as AlephMessage;
    const result = filterTrusted([bad], WALLET.address);
    expect(result.warnings).toEqual([
      {
        code: "UNTRUSTED_MESSAGE",
        detail: `${msg.item_hash}: signature does not recover sender`,
        messageHash: msg.item_hash,
      },
    ]);
    expect(result.otherWalletMessages).toBe(0);
  });
});

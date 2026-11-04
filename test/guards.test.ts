import { describe, it, expect } from "vitest";
import {
  malformedDeploymentReason,
  malformedMessageReason,
  malformedProjectEntryReason,
} from "../src/guards.js";

const envelope = () => ({
  v: 3,
  alg: "aes-256-gcm",
  ct: "ct",
  iv: "iv",
  tag: "tag",
  deks: { user: "u", encryption: "e" },
});

const message = () => ({
  sender: "0xabc",
  item_hash: "hash",
  content: { address: "0xabc", time: 1, content: {} },
});

const projectEntry = () => ({
  public: { framework: "nextjs-static", deleted: false },
  encrypted: envelope(),
});

const deployment = () => ({
  deploymentId: "dep_1",
  projectId: "proj_1",
  public: { status: "live", createdAt: "2026-01-01T00:00:00.000Z" },
  encrypted: envelope(),
});

describe("malformedMessageReason", () => {
  it("accepts a well-formed message", () => {
    expect(malformedMessageReason(message())).toBeNull();
  });

  it.each([
    ["null", null],
    ["a string", "x"],
    ["a missing sender", { ...message(), sender: undefined }],
    ["a missing item_hash", { ...message(), item_hash: 1 }],
    ["a null content", { ...message(), content: null }],
    ["a missing address", { ...message(), content: { time: 1, content: {} } }],
    [
      "a string time",
      { ...message(), content: { address: "0xabc", time: "1", content: {} } },
    ],
    [
      "a non-finite time",
      { ...message(), content: { address: "0xabc", time: Infinity, content: {} } },
    ],
    [
      "a null inner content",
      { ...message(), content: { address: "0xabc", time: 1, content: null } },
    ],
  ])("rejects %s", (_name, value) => {
    expect(malformedMessageReason(value)).toEqual(expect.any(String));
  });
});

describe("malformedProjectEntryReason", () => {
  it("accepts a well-formed entry", () => {
    expect(malformedProjectEntryReason(projectEntry())).toBeNull();
  });

  it("accepts a tombstone with only a public block", () => {
    expect(malformedProjectEntryReason({ public: { deleted: true } })).toBeNull();
  });

  it.each([
    ["null", null],
    ["a non-object", 7],
    ["a missing public", { encrypted: envelope() }],
    ["a missing encrypted", { public: { deleted: false } }],
    ["a non-string ct", { ...projectEntry(), encrypted: { ...envelope(), ct: 1 } }],
    ["a missing deks.user", { ...projectEntry(), encrypted: { ...envelope(), deks: {} } }],
  ])("rejects %s", (_name, value) => {
    expect(malformedProjectEntryReason(value)).toEqual(expect.any(String));
  });
});

describe("malformedDeploymentReason", () => {
  it("accepts a well-formed deployment", () => {
    expect(malformedDeploymentReason(deployment())).toBeNull();
  });

  it.each([
    ["null", null],
    ["a missing public", { ...deployment(), public: undefined }],
    ["a missing status", { ...deployment(), public: { createdAt: "x" } }],
    ["a missing createdAt", { ...deployment(), public: { status: "live" } }],
    ["a missing deploymentId", { ...deployment(), deploymentId: undefined }],
    ["a missing projectId", { ...deployment(), projectId: 3 }],
    ["a missing encrypted", { ...deployment(), encrypted: undefined }],
    ["a non-string tag", { ...deployment(), encrypted: { ...envelope(), tag: null } }],
  ])("rejects %s", (_name, value) => {
    expect(malformedDeploymentReason(value)).toEqual(expect.any(String));
  });
});

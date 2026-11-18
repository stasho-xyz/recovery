import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { bindContent, signatureRecoversSender } from "./trust.js";
import type { AlephMessage, MessageFetcher, RecoveryWarning } from "./types.js";

/**
 * A line of the export that passed every check. `content` is the parsed `item_content`, the
 * only content the signature covers; the line's own `content` field is never copied.
 */
export interface ExportMessage {
  type: string;
  /** Unsigned; `null` for a message on no channel. */
  channel: string | null;
  chain: string;
  sender: string;
  signature: string;
  item_hash: string;
  item_type: string;
  item_content: string;
  content: Record<string, unknown>;
  /** The line's top-level `time`, unsigned: used only to list newest first, as a CCN does. */
  time: number;
}

/**
 * A line left out. `EXPORT_LINE_REJECTED`: it failed a check, so it may have been a record of
 * this wallet's. `EXPORT_LINE_SKIPPED`: this tool cannot check its kind of message at all.
 */
export interface DroppedLine {
  code: "EXPORT_LINE_REJECTED" | "EXPORT_LINE_SKIPPED";
  file: string;
  line: number;
  reason: string;
  itemHash?: string;
}

/** Every verified message of the export, deduplicated by `item_hash`, and every dropped line. */
export interface ExportSet {
  messages: ExportMessage[];
  dropped: DroppedLine[];
  /** Non-blank lines read. */
  linesRead: number;
  /** Lines on another channel, parsed only to learn that: see `usable`. */
  unused: number;
}

/** The export path cannot be read: missing, no `.ndjson` in a directory, or an I/O error. */
export class ExportReadError extends Error {}

/** First in every export-backed run's warnings. */
export const EXPORT_COMPLETENESS_UNPROVEN: RecoveryWarning = {
  code: "EXPORT_COMPLETENESS_UNPROVEN",
  detail:
    "Read from an export. Signatures prove each record is genuine, not that the export holds " +
    "every record: a missing file or line cannot be detected.",
};

const SIGNED_FIELDS = ["sender", "type", "item_hash", "item_content", "signature"] as const;

interface LineFields {
  chain: string;
  item_type: string;
  sender: string;
  type: string;
  item_hash: string;
  item_content: string;
  signature: string;
  channel: string | null;
}

type Verdict = { message: ExportMessage } | { code: DroppedLine["code"]; reason: string };

type Checked =
  | { kind: "kept"; message: ExportMessage }
  | { kind: "unused" }
  | { kind: "dropped"; code: DroppedLine["code"]; reason: string; itemHash?: string };

function reject(reason: string): Verdict {
  return { code: "EXPORT_LINE_REJECTED", reason };
}

function skip(reason: string): Verdict {
  return { code: "EXPORT_LINE_SKIPPED", reason };
}

function parseLine(
  text: string,
  endsWithNewline: boolean,
): { value: unknown } | { reason: string } {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return {
      reason: endsWithNewline
        ? "not valid JSON"
        : "not valid JSON (truncated last line: the file does not end with a newline)",
    };
  }
}

/**
 * Only lines this run can use are verified. A line on another channel is trusted for nothing
 * here, and editing its unsigned `channel` to hide it does no more than deleting it would.
 * FORGETs and STOREs are read on every channel: drop FORGETs and drop STOREs sit on
 * `STASHO_DROPS_V1` and name or back this channel's deployments, and a CCN resolves a STORE by
 * hash whatever its channel.
 */
function usable(record: Record<string, unknown>, channel: string): boolean {
  const type = record["type"];
  return record["channel"] === channel || type === "FORGET" || type === "STORE";
}

/** The fields the checks read, or why the line is dropped before any check can run. */
function readFields(record: Record<string, unknown>): { fields: LineFields } | Verdict {
  const channel = record["channel"] ?? null;
  if (channel !== null && typeof channel !== "string") {
    return reject("field channel is not a string or null");
  }
  for (const name of ["chain", "item_type"] as const) {
    if (typeof record[name] !== "string") return reject(`field ${name} is missing or not a string`);
  }
  if (record["item_type"] !== "inline") {
    return skip(`item_type ${JSON.stringify(record["item_type"])} cannot be checked, only inline`);
  }
  if (record["chain"] !== "ETH") {
    return skip(`chain ${JSON.stringify(record["chain"])} cannot be checked, only ETH`);
  }
  for (const name of SIGNED_FIELDS) {
    if (typeof record[name] !== "string") return reject(`field ${name} is missing or not a string`);
  }
  return { fields: { ...(record as unknown as LineFields), channel } };
}

function verifyFields(f: LineFields, time: unknown): Verdict {
  const bound = bindContent(f);
  if ("reason" in bound) return reject(bound.reason);
  if (!signatureRecoversSender(f)) return reject("signature does not recover sender");
  return {
    message: {
      type: f.type,
      channel: f.channel,
      chain: f.chain,
      sender: f.sender,
      signature: f.signature,
      item_hash: f.item_hash,
      item_type: f.item_type,
      item_content: f.item_content,
      content: bound.content as unknown as Record<string, unknown>,
      time: typeof time === "number" ? time : 0,
    },
  };
}

function checkLine(text: string, endsWithNewline: boolean, channel: string): Checked {
  const parsed = parseLine(text, endsWithNewline);
  if ("reason" in parsed) return { kind: "dropped", code: "EXPORT_LINE_REJECTED", ...parsed };
  const value = parsed.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { kind: "dropped", code: "EXPORT_LINE_REJECTED", reason: "not a JSON object" };
  }
  const record = value as Record<string, unknown>;
  if (!usable(record, channel)) return { kind: "unused" };
  const read = readFields(record);
  const verdict = "fields" in read ? verifyFields(read.fields, record["time"]) : read;
  if ("message" in verdict) return { kind: "kept", message: verdict.message };
  const hash = record["item_hash"];
  return { kind: "dropped", ...verdict, ...(typeof hash === "string" ? { itemHash: hash } : {}) };
}

async function* readLines(
  path: string,
): AsyncGenerator<{ text: string; endsWithNewline: boolean }> {
  let pending = "";
  let first = true;
  for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
    let text = chunk as string;
    if (first && text.startsWith("\uFEFF")) text = text.slice(1);
    first = false;
    const parts = (pending + text).split("\n");
    pending = parts.pop() ?? "";
    for (const line of parts) yield { text: line, endsWithNewline: true };
  }
  if (pending !== "") yield { text: pending, endsWithNewline: false };
}

async function loadFile(
  path: string,
  channel: string,
  set: ExportSet,
  seen: Set<string>,
): Promise<void> {
  const file = basename(path);
  let line = 0;
  for await (const { text, endsWithNewline } of readLines(path)) {
    line++;
    if (text.trim() === "") continue;
    set.linesRead++;
    const checked = checkLine(text, endsWithNewline, channel);
    if (checked.kind === "unused") {
      set.unused++;
    } else if (checked.kind === "dropped") {
      const { kind: _kind, ...dropped } = checked;
      set.dropped.push({ file, line, ...dropped });
    } else if (!seen.has(checked.message.item_hash)) {
      seen.add(checked.message.item_hash);
      set.messages.push(checked.message);
    }
  }
}

async function listExportFiles(path: string): Promise<string[]> {
  try {
    if (!(await stat(path)).isDirectory()) return [path];
    const names = (await readdir(path)).filter((n) => n.endsWith(".ndjson")).sort();
    if (names.length === 0) throw new ExportReadError("the directory holds no .ndjson file");
    return names.map((n) => join(path, n));
  } catch (err) {
    if (err instanceof ExportReadError) throw err;
    throw new ExportReadError((err as Error).message);
  }
}

/**
 * Read an export for `channel`: one `.ndjson` file, or every `*.ndjson` directly inside a
 * directory, in name order. Usable lines are checked and a line that fails is dropped into
 * `dropped`; blank lines are skipped. Throws `ExportReadError` when the path cannot be read.
 */
export async function loadExport(path: string, channel: string): Promise<ExportSet> {
  const set: ExportSet = { messages: [], dropped: [], linesRead: 0, unused: 0 };
  const seen = new Set<string>();
  for (const file of await listExportFiles(path)) {
    try {
      await loadFile(file, channel, set, seen);
    } catch (err) {
      throw new ExportReadError(`${file}: ${(err as Error).message}`);
    }
  }
  return set;
}

/** One warning per dropped line, in file and line order. */
export function droppedLineWarnings(set: ExportSet): RecoveryWarning[] {
  return set.dropped.map((d) => ({
    code: d.code,
    detail: `${d.file}:${d.line}: ${d.reason}`,
    ...(d.itemHash === undefined ? {} : { messageHash: d.itemHash }),
  }));
}

/** The CCN lists by message `time`, newest first; ties keep the export's order. */
export function newestFirst(messages: readonly ExportMessage[]): ExportMessage[] {
  return [...messages].sort((a, b) => b.time - a.time);
}

/** Every verified FORGET naming each hash, whoever signed it, each FORGET once per hash. */
export function forgetsByTarget(messages: readonly ExportMessage[]): Map<string, ExportMessage[]> {
  const byTarget = new Map<string, ExportMessage[]>();
  for (const m of messages) {
    const listed = m.type === "FORGET" ? m.content["hashes"] : undefined;
    if (!Array.isArray(listed)) continue;
    for (const h of new Set(listed)) {
      if (typeof h !== "string") continue;
      const naming = byTarget.get(h);
      if (naming === undefined) byTarget.set(h, [m]);
      else naming.push(m);
    }
  }
  return byTarget;
}

const POST_CONTENT_TYPES: ReadonlySet<string> = new Set(["aleph-cloud-deployment", "amend"]);

function wantedPost(m: ExportMessage): boolean {
  const type = m.content["type"];
  return typeof type === "string" && POST_CONTENT_TYPES.has(type);
}

/**
 * Whether a FORGET in the export hides `m`: only one signed by `m`'s sender, its owner
 * (`content.address`), or a sender this query asks for (in Query B the wallet's authorized
 * senders, so a newer delegate may forget an older one's message). A stranger's FORGET, which
 * the network would refuse, hides nothing.
 */
function hiddenByForget(
  m: ExportMessage,
  forgets: ReadonlyMap<string, ExportMessage[]>,
  queried: ReadonlySet<string>,
): boolean {
  const naming = forgets.get(m.item_hash);
  if (naming === undefined) return false;
  const owner = m.content["address"];
  const allowed = new Set([...queried, m.sender.toLowerCase()]);
  if (typeof owner === "string") allowed.add(owner.toLowerCase());
  return naming.some((f) => allowed.has(f.sender.toLowerCase()));
}

/**
 * The messages the live fetcher (`buildFetcher` in `run.ts`) would get from a CCN holding exactly
 * this export. AGGREGATEs are not filtered by key: the CCN ignores `aggregateKeys`.
 */
export function exportFetcher(set: ExportSet, channel: string): MessageFetcher {
  const forgets = forgetsByTarget(set.messages);
  const listed = newestFirst(set.messages);
  return ({ messageType, addresses }) => {
    const senders = new Set(addresses.map((a) => a.toLowerCase()));
    const messages = listed.filter(
      (m) =>
        // `channel` is unsigned: the same trust the live path places in the CCN's channel filter.
        m.channel === channel &&
        m.type === messageType &&
        senders.has(m.sender.toLowerCase()) &&
        (messageType !== "POST" || wantedPost(m)) &&
        !hiddenByForget(m, forgets, senders),
    );
    return Promise.resolve({ messages: messages as unknown as AlephMessage[], truncated: null });
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function malformedEnvelopeReason(value: unknown, path: string): string | null {
  if (!isObject(value)) return `${path} is not an object`;
  for (const field of ["ct", "iv", "tag"]) {
    if (!isString(value[field])) return `${path}.${field} is not a string`;
  }
  const deks = value["deks"];
  if (!isObject(deks)) return `${path}.deks is not an object`;
  if (!isString(deks["user"])) return `${path}.deks.user is not a string`;
  return null;
}

/**
 * Port of `malformedEnvelopeReason` in `apps/backend/src/services/aleph-replay.ts`:
 * the checks that keep one hostile or damaged message from crashing a replay.
 */
export function malformedMessageReason(value: unknown): string | null {
  if (!isObject(value)) return "message is not an object";
  if (!isString(value["sender"])) return "sender is not a string";
  if (!isString(value["item_hash"])) return "item_hash is not a string";
  const content = value["content"];
  if (!isObject(content)) return "content is not an object";
  if (!isString(content["address"])) return "content.address is not a string";
  const time = content["time"];
  if (typeof time !== "number" || !Number.isFinite(time)) {
    return "content.time is not a finite number";
  }
  if (!isObject(content["content"])) return "content.content is not an object";
  return null;
}

/** A tombstone (`public.deleted === true`) needs only its `public` block. */
export function malformedProjectEntryReason(value: unknown): string | null {
  if (!isObject(value)) return "entry is not an object";
  const pub = value["public"];
  if (!isObject(pub)) return "public is not an object";
  if (pub["deleted"] === true) return null;
  return malformedEnvelopeReason(value["encrypted"], "encrypted");
}

export function malformedDeploymentReason(value: unknown): string | null {
  if (!isObject(value)) return "deployment is not an object";
  if (!isString(value["deploymentId"])) return "deploymentId is not a string";
  if (!isString(value["projectId"])) return "projectId is not a string";
  const pub = value["public"];
  if (!isObject(pub)) return "public is not an object";
  if (!isString(pub["status"])) return "public.status is not a string";
  if (!isString(pub["createdAt"])) return "public.createdAt is not a string";
  return malformedEnvelopeReason(value["encrypted"], "encrypted");
}

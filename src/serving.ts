import type { RecoveredDeployment, ServingDeployment } from "./types.js";

/**
 * Which deployment a project serves, per the rollback pin rule (Decision #520).
 *
 * Port of `selectServingDeployment` in `apps/backend/src/services/aleph-storage.ts`
 * (the backend's rule, not imported). "Newest" is the `live` deployment with the
 * greatest `createdAt`. A pin (`currentDeploymentId`) serves only when it is
 * `live` and has a `storeRef`, and it is not superseded: a live build created
 * strictly after `currentDeploymentSetAt` replaces it. A pin naming no listed
 * deployment serves nothing (`pin-missing`), as the backend does.
 */
export function selectServing(
  deployments: readonly RecoveredDeployment[],
  currentDeploymentId: string | null,
  currentDeploymentSetAt: string | null,
): ServingDeployment {
  const newest = newestLive(deployments);
  if (newest === null) return { deploymentId: null, reason: "none" };
  if (currentDeploymentId === null) {
    return { deploymentId: newest.id, reason: "newest-live" };
  }
  if (isPinSuperseded(newest, currentDeploymentSetAt)) {
    return { deploymentId: newest.id, reason: "pin-superseded" };
  }
  const pinned = deployments.find((d) => d.id === currentDeploymentId);
  if (pinned === undefined) return { deploymentId: null, reason: "pin-missing" };
  if (pinned.status === "live" && pinned.storeRef !== null) {
    return { deploymentId: pinned.id, reason: "pinned" };
  }
  return { deploymentId: newest.id, reason: "newest-live" };
}

function newestLive(
  deployments: readonly RecoveredDeployment[],
): RecoveredDeployment | null {
  let newest: RecoveredDeployment | null = null;
  for (const dep of deployments) {
    if (dep.status !== "live") continue;
    if (newest === null || Date.parse(dep.createdAt) > Date.parse(newest.createdAt)) {
      newest = dep;
    }
  }
  return newest;
}

/**
 * A pin is superseded when the newest live build was created strictly after the
 * pin was set. A null or unparseable set time never supersedes.
 */
function isPinSuperseded(
  newest: RecoveredDeployment,
  setAt: string | null,
): boolean {
  if (setAt === null) return false;
  const setMs = Date.parse(setAt);
  return !Number.isNaN(setMs) && Date.parse(newest.createdAt) > setMs;
}

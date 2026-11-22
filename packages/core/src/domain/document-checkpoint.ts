import type { QueueIsolationTarget } from "./queue-model";

export interface DocumentBlocker {
  jobId: string;
  requestId: string;
  originalHash: string;
  catalogDigest: string;
  barrierRef: string;
}
/** Server-authored queue marker, never accepted from a public request payload. */
export interface DocumentInspection {
  version: 1;
  target: QueueIsolationTarget;
  generation: string;
  blockersDigest: string;
  priorCheckpointId: string | null;
}
export interface DocumentObservation {
  version: 1;
  id: string;
  requestId: string;
  actorClientId: string;
  target: QueueIsolationTarget;
  generation: string;
  scope: "parameters";
  stateDigest: string;
  readback: { reference: string; sha256: string; probeRequestId: string };
  blockers: DocumentBlocker[];
  priorCheckpointId: string | null;
  createdAt: number;
}
export interface DocumentAcceptance {
  version: 1;
  id: string;
  requestId: string;
  actorClientId: string;
  observationId: string;
  observationDigest: string;
  targetKey: string;
  priorCheckpointId: string | null;
  acceptedAt: number;
}
export interface DocumentCheckpoints {
  observations: Record<string, DocumentObservation>;
  acceptances: Record<string, DocumentAcceptance>;
  heads: Record<string, string>;
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === "string" && !!value.trim() && value.length <= 256;
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const time = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const fields = (value: Record<string, unknown>, names: string) =>
  Object.keys(value).sort().join(",") === names.split(",").sort().join(",");

export function validDocumentObservation(
  value: unknown,
): value is DocumentObservation {
  if (
    !object(value) ||
    !fields(
      value,
      "version,id,requestId,actorClientId,target,generation,scope,stateDigest,readback,blockers,priorCheckpointId,createdAt",
    ) ||
    value["version"] !== 1 ||
    value["scope"] !== "parameters" ||
    !["id", "requestId", "actorClientId", "generation"].every((key) =>
      text(value[key]),
    ) ||
    !digest(value["stateDigest"]) ||
    !time(value["createdAt"]) ||
    !(
      value["priorCheckpointId"] === null || text(value["priorCheckpointId"])
    ) ||
    !object(value["target"]) ||
    !text(value["target"]["creationId"]) ||
    !object(value["readback"]) ||
    !fields(value["readback"], "reference,sha256,probeRequestId") ||
    !text(value["readback"]["reference"]) ||
    !digest(value["readback"]["sha256"]) ||
    !text(value["readback"]["probeRequestId"]) ||
    !Array.isArray(value["blockers"])
  )
    return false;
  try {
    documentTargetKey(value["target"]);
  } catch {
    return false;
  }
  const ids: string[] = [];
  for (const entry of value["blockers"]) {
    if (
      !object(entry) ||
      !fields(entry, "jobId,requestId,originalHash,catalogDigest,barrierRef") ||
      !text(entry["jobId"]) ||
      !text(entry["requestId"]) ||
      !text(entry["barrierRef"]) ||
      !digest(entry["originalHash"]) ||
      !digest(entry["catalogDigest"])
    )
      return false;
    ids.push(entry["jobId"]);
  }
  return (
    new Set(ids).size === ids.length &&
    ids.every((id, index) => index === 0 || ids[index - 1]! < id)
  );
}

/** Persisted acceptance is useful only with its complete immutable ancestry.
 * Adapter restoration separately verifies the referenced readback bytes. */
export function validDocumentCheckpoints(
  value: unknown,
  hashCanonical: (input: unknown) => string,
): value is DocumentCheckpoints {
  if (
    !object(value) ||
    !fields(value, "observations,acceptances,heads") ||
    !object(value["observations"]) ||
    !object(value["acceptances"]) ||
    !object(value["heads"])
  )
    return false;
  const observations = value["observations"];
  const acceptances = value["acceptances"];
  const heads = value["heads"];
  const observationRequests = new Set<string>();
  for (const [id, observation] of Object.entries(observations)) {
    if (!validDocumentObservation(observation) || observation.id !== id)
      return false;
    const request = JSON.stringify([
      observation.actorClientId,
      observation.requestId,
    ]);
    if (observationRequests.has(request)) return false;
    observationRequests.add(request);
  }
  const acceptanceRequests = new Set<string>();
  for (const [id, entry] of Object.entries(acceptances)) {
    if (
      !object(entry) ||
      !fields(
        entry,
        "version,id,requestId,actorClientId,observationId,observationDigest,targetKey,priorCheckpointId,acceptedAt",
      ) ||
      entry["version"] !== 1 ||
      entry["id"] !== id ||
      !["id", "requestId", "actorClientId", "observationId"].every((key) =>
        text(entry[key]),
      ) ||
      !digest(entry["observationDigest"]) ||
      !time(entry["acceptedAt"]) ||
      !(entry["priorCheckpointId"] === null || text(entry["priorCheckpointId"]))
    )
      return false;
    const observation = observations[String(entry["observationId"])];
    if (
      !validDocumentObservation(observation) ||
      entry["actorClientId"] !== observation.actorClientId ||
      entry["targetKey"] !== documentTargetKey(observation.target) ||
      entry["priorCheckpointId"] !== observation.priorCheckpointId ||
      entry["observationDigest"] !== hashCanonical(observation) ||
      entry["acceptedAt"] < observation.createdAt
    )
      return false;
    const request = JSON.stringify([
      entry["actorClientId"],
      entry["requestId"],
    ]);
    if (acceptanceRequests.has(request) || observationRequests.has(request))
      return false;
    acceptanceRequests.add(request);
  }
  for (const observation of Object.values(observations)) {
    if (!validDocumentObservation(observation)) return false;
    if (observation.priorCheckpointId !== null) {
      const prior = acceptances[observation.priorCheckpointId];
      if (
        !object(prior) ||
        prior["targetKey"] !== documentTargetKey(observation.target)
      )
        return false;
    }
  }
  const visited = new Set<string>();
  for (const [target, head] of Object.entries(heads)) {
    if (!text(head)) return false;
    let current: string | null = head;
    const chain = new Set<string>();
    while (current !== null) {
      const entry = acceptances[current];
      if (!object(entry) || entry["targetKey"] !== target || chain.has(current))
        return false;
      chain.add(current);
      visited.add(current);
      current = entry["priorCheckpointId"] as string | null;
    }
  }
  return visited.size === Object.keys(acceptances).length;
}
export function documentTargetKey(target: QueueIsolationTarget): string {
  if (
    (!target.creationId && !target.fileId) ||
    Object.keys(target).some(
      (key) => !["creationId", "fileId"].includes(key),
    ) ||
    Object.values(target).some(
      (value) => typeof value !== "string" || !value.trim(),
    )
  )
    throw Object.assign(new Error("An exact document identity is required"), {
      code: "INVALID_DOCUMENT_TARGET",
    });
  return JSON.stringify({
    ...(target.creationId
      ? { creationId: target.creationId }
      : { fileId: target.fileId }),
  });
}

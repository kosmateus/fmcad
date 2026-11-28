import type { QueueIsolationTarget } from "./queue-model";

/** Broker-authored binding for one guarded write, never a public request flag. */
export interface DocumentContinuation {
  version: 1;
  actorClientId: string;
  requestHash: string;
  target: QueueIsolationTarget;
  generation: string;
  observationId: string;
  acceptanceId: string;
  stateDigest: string;
  blockersDigest: string;
  /** Exact independently compiled param.apply WITH the private checkpoint guard. */
  sourceHash: string;
}
export interface DocumentContinuationAuthority {
  readonly __documentContinuationAuthority: "private-document-continuation";
}
const authorities = new WeakMap<
  DocumentContinuationAuthority,
  { domain: object; verify: () => DocumentContinuation }
>();
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown) =>
  typeof value === "string" && !!value.trim() && value.length <= 256;
const digest = (value: unknown) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function validDocumentContinuation(
  value: unknown,
): value is DocumentContinuation {
  if (
    !object(value) ||
    Object.keys(value).sort().join(",") !==
      "acceptanceId,actorClientId,blockersDigest,generation,observationId,requestHash,sourceHash,stateDigest,target,version" ||
    value["version"] !== 1 ||
    !["actorClientId", "generation", "observationId", "acceptanceId"].every(
      (key) => text(value[key]),
    ) ||
    !["requestHash", "stateDigest", "blockersDigest", "sourceHash"].every(
      (key) => digest(value[key]),
    ) ||
    !object(value["target"]) ||
    !text(value["target"]["creationId"]) ||
    (value["target"]["fileId"] !== undefined &&
      !text(value["target"]["fileId"])) ||
    Object.keys(value["target"]).some(
      (key) => key !== "creationId" && key !== "fileId",
    )
  )
    return false;
  return true;
}
function refused(): never {
  throw Object.assign(
    new Error(
      "A fresh private verified checkpoint and guarded program are required",
    ),
    { code: "DOCUMENT_CONTINUATION_UNPROVEN" },
  );
}

/** Trusted composition mints this only after awaited source/native verification
 * and current modeling-rights checks. The callback rechecks live ownership,
 * generation and the exact immutable prepared guard/program at every use.
 * Serialized markers and old acceptance receipts cannot recreate authority. */
export function createDocumentContinuationAuthority(
  domain: object,
  verify: () => DocumentContinuation,
): DocumentContinuationAuthority {
  if (typeof verify !== "function") refused();
  const capability = Object.freeze({}) as DocumentContinuationAuthority;
  authorities.set(capability, { domain, verify });
  return capability;
}
export function verifiedDocumentContinuation(
  authority: DocumentContinuationAuthority | undefined,
  domain: object,
): DocumentContinuation {
  const entry = authority && authorities.get(authority);
  if (!entry || entry.domain !== domain) refused();
  const value = entry.verify();
  if (!validDocumentContinuation(value)) {
    void Promise.resolve(value).catch(() => {});
    refused();
  }
  return JSON.parse(JSON.stringify(value)) as DocumentContinuation;
}
export function isDocumentContinuationAuthority(
  authority: DocumentContinuationAuthority | undefined,
  domain: object,
): boolean {
  return !!authority && authorities.get(authority)?.domain === domain;
}

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const load = createRequire(__filename);
const { hash } = load("./queue-instance") as {
  hash(value: string | Uint8Array): string;
};
const { readBytes } = load(
  "./dist/node-adapters/persistence/records",
) as typeof import("../packages/node-adapters/src/persistence/records");
const { fileHash, directory } = load("./queue-atomic-migration-files") as {
  fileHash(file: string): { sha256: string };
  directory(dir: string): unknown;
};
const { hash: digest } = load(
  "./dist/core/application/cad/json",
) as typeof import("../packages/core/src/application/cad/json");
function fail(message: string): never {
  throw Object.assign(new Error(message), { code: "EPOCH_LINEAGE_INVALID" });
}
const limit = 256 * 1024 * 1024;
export interface Reference {
  path: string;
  sha256: string;
}
export interface EpochPointer {
  root: string;
  epochId: string;
  ownerClientId: string;
  ownerTokenHash: string;
  historicalSnapshotHash: string;
  historicalIdentityHash: string;
  document: { fileId: unknown };
  currentInstance: { pid: number; birth: string };
  qualificationReceipt: Reference;
  qualificationEvidence: Reference[];
  succession?: Reference;
  [key: string]: unknown;
}
interface Predecessor {
  pointer: Reference;
  epochId: string;
  state: Reference;
  identity: Reference;
  rootState: Reference;
  rootIdentity: Reference;
  grants: Reference[];
  qualification: Reference[];
}
export interface SuccessionAuthority {
  version: number;
  kind: string;
  requestId: string;
  clientId: string;
  ownerTokenHash: string;
  sourceCommit: string;
  buildHash: string;
  previousBuildHash: string;
  previousBrokerTerminated: boolean;
  previousProcessTerminated: boolean;
  permission: string;
  historicalOutcome: string;
  predecessor: Predecessor;
  qualification: Reference;
  closedEpochProof?: Reference;
  expectedProcess?: { pid: number; birth: string };
  [key: string]: unknown;
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!object(value)) fail("Epoch evidence must be a JSON object");
  return value;
}
function referenceValue(value: unknown): value is Reference {
  return (
    object(value) &&
    typeof value["path"] === "string" &&
    typeof value["sha256"] === "string"
  );
}
function references(value: unknown): value is Reference[] {
  return Array.isArray(value) && value.every(referenceValue);
}
function processIdentity(
  value: unknown,
): value is { pid: number; birth: string } {
  return (
    object(value) &&
    typeof value["pid"] === "number" &&
    typeof value["birth"] === "string"
  );
}
function isPointer(value: unknown): value is EpochPointer {
  return (
    object(value) &&
    typeof value["root"] === "string" &&
    typeof value["epochId"] === "string" &&
    typeof value["ownerClientId"] === "string" &&
    typeof value["ownerTokenHash"] === "string" &&
    typeof value["historicalSnapshotHash"] === "string" &&
    typeof value["historicalIdentityHash"] === "string" &&
    object(value["document"]) &&
    "fileId" in value["document"] &&
    processIdentity(value["currentInstance"]) &&
    referenceValue(value["qualificationReceipt"]) &&
    references(value["qualificationEvidence"]) &&
    (value["succession"] === undefined || referenceValue(value["succession"]))
  );
}
function pointerRecord(value: unknown): EpochPointer {
  if (!isPointer(value)) fail("Invalid epoch pointer evidence");
  return value;
}
function predecessor(value: unknown): value is Predecessor {
  return (
    object(value) &&
    typeof value["epochId"] === "string" &&
    referenceValue(value["pointer"]) &&
    referenceValue(value["state"]) &&
    referenceValue(value["identity"]) &&
    referenceValue(value["rootState"]) &&
    referenceValue(value["rootIdentity"]) &&
    references(value["grants"]) &&
    references(value["qualification"])
  );
}
function isAuthority(value: unknown): value is SuccessionAuthority {
  return (
    object(value) &&
    typeof value["version"] === "number" &&
    typeof value["kind"] === "string" &&
    typeof value["requestId"] === "string" &&
    typeof value["clientId"] === "string" &&
    typeof value["ownerTokenHash"] === "string" &&
    typeof value["sourceCommit"] === "string" &&
    typeof value["buildHash"] === "string" &&
    typeof value["previousBuildHash"] === "string" &&
    typeof value["previousBrokerTerminated"] === "boolean" &&
    typeof value["previousProcessTerminated"] === "boolean" &&
    typeof value["permission"] === "string" &&
    typeof value["historicalOutcome"] === "string" &&
    predecessor(value["predecessor"]) &&
    referenceValue(value["qualification"]) &&
    (value["closedEpochProof"] === undefined ||
      referenceValue(value["closedEpochProof"])) &&
    (value["expectedProcess"] === undefined ||
      processIdentity(value["expectedProcess"]))
  );
}
function authorityRecord(value: unknown): SuccessionAuthority {
  if (!isAuthority(value))
    fail("Invalid owner-bound succession authority evidence");
  return value;
}
export const reference = (file: string): Reference => ({
  path: file,
  sha256: fileHash(file).sha256,
});

function verified(entry: Reference | undefined, expectedPath: string): unknown {
  if (
    !entry ||
    entry.path !== expectedPath ||
    !/^[a-f0-9]{64}$/.test(entry.sha256 || "") ||
    !path.isAbsolute(entry.path) ||
    fs.realpathSync(entry.path) !== entry.path
  )
    fail("Retired epoch evidence changed or escaped its namespace");
  directory(path.dirname(entry.path));
  // Hash and decode the SAME opened bytes. Reopening after fileHash admitted a
  // different record during a filesystem race. The existing descriptor-path
  // evidence also fences a parent-directory substitution on the Linux broker.
  const bytes = readBytes(entry.path, limit, fs, expectedPath);
  if (hash(bytes) !== entry.sha256)
    fail("Retired epoch evidence changed or escaped its namespace");
  return JSON.parse(bytes.toString("utf8")) as unknown;
}
function grantReferences(root: string): Reference[] {
  return fs
    .readdirSync(root)
    .filter((name) => /^access-[a-f0-9]{64}\.json$/.test(name))
    .sort()
    .map((name) => reference(path.join(root, name)));
}
// Publish only into a new authenticated owner transaction; retired stores stay
// untouched, including running/unknown work and their original result bytes.
export function predecessorSnapshot(
  root: string,
  audit: string,
  publish = false,
): Predecessor {
  const pointerFile = path.join(root, "isolated-admission-epoch.json");
  const bytes = fs.readFileSync(pointerFile),
    pointer = pointerRecord(JSON.parse(bytes.toString("utf8")) as unknown);
  if (
    pointer.root !== path.join(root, "admission-epochs", pointer.epochId || "")
  )
    fail("Invalid predecessor namespace");
  const archived = path.join(audit, "predecessor-pointer.json");
  if (publish) {
    directory(audit);
    if (!fs.existsSync(archived)) {
      fs.copyFileSync(pointerFile, archived, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(archived, 0o600);
      const fd = fs.openSync(archived, "r");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      const dir = fs.openSync(audit, "r");
      try {
        fs.fsyncSync(dir);
      } finally {
        fs.closeSync(dir);
      }
    }
    if (fileHash(archived).sha256 !== hash(bytes))
      fail("The original pointer archive differs");
  }
  return {
    pointer: { path: archived, sha256: hash(bytes) },
    epochId: pointer.epochId,
    state: reference(path.join(pointer.root, "queue-state.json")),
    identity: reference(path.join(pointer.root, "instance.json")),
    grants: grantReferences(pointer.root),
    rootState: reference(path.join(root, "queue-state.json")),
    rootIdentity: reference(path.join(root, "instance.json")),
    qualification: [
      pointer.qualificationReceipt,
      ...pointer.qualificationEvidence,
    ],
  };
}
export function successionAuthority(root: string, entry: Reference) {
  if (!entry || !path.isAbsolute(entry.path || ""))
    fail("Missing credential-bound succession authority");
  if (
    path.dirname(path.dirname(entry.path)) !==
      path.join(root, "epoch-successions") ||
    !/^[a-f0-9]{64}$/.test(path.basename(path.dirname(entry.path))) ||
    path.basename(entry.path) !== "authority.json" ||
    fs.realpathSync(entry.path) !== entry.path
  )
    fail("Succession authority escaped its owner journal");
  // Derive the owner journal from the authenticated record, not an earlier,
  // unverified read which can name a different request during replacement.
  const authority = authorityRecord(verified(entry, entry.path));
  const audit = path.join(
    root,
    "epoch-successions",
    hash(authority.requestId || ""),
  );
  if (entry.path !== path.join(audit, "authority.json"))
    fail("Succession authority escaped its owner journal");
  const closedSuccessor =
    authority.kind === "owner-authenticated-closed-epoch-successor";
  if (
    authority.version !== 1 ||
    (!closedSuccessor &&
      authority.kind !== "owner-authenticated-dead-epoch-successor") ||
    !authority.clientId ||
    !/^[a-f0-9]{64}$/.test(authority.ownerTokenHash || "") ||
    !/^[a-f0-9]{40}$/.test(authority.sourceCommit || "") ||
    !/^[a-f0-9]{64}$/.test(authority.buildHash || "") ||
    authority.previousBrokerTerminated !== !closedSuccessor ||
    authority.previousProcessTerminated !== !closedSuccessor ||
    authority.permission !== "one-proven-new-document-only" ||
    authority.historicalOutcome !== "unknown"
  )
    fail("Invalid owner-bound dead-process authority");
  const snapshot = authority.predecessor;
  if (!snapshot || !/^[a-f0-9-]{36}$/.test(snapshot.epochId || ""))
    fail("Missing exact predecessor");
  const pointer = pointerRecord(
    verified(snapshot.pointer, path.join(audit, "predecessor-pointer.json")),
  );
  const epochRoot = path.join(root, "admission-epochs", snapshot.epochId);
  const identity = record(
    verified(snapshot.identity, path.join(epochRoot, "instance.json")),
  );
  if (
    pointer.root !== epochRoot ||
    pointer.epochId !== snapshot.epochId ||
    pointer.ownerClientId !== authority.clientId ||
    pointer.ownerTokenHash !== authority.ownerTokenHash ||
    pointer.document.fileId !== null ||
    authority.previousBuildHash !== identity["buildHash"]
  )
    fail("Succession authority differs from the original owner or epoch");
  const state = verified(
    snapshot.state,
    path.join(epochRoot, "queue-state.json"),
  );
  verified(snapshot.rootState, path.join(root, "queue-state.json"));
  verified(snapshot.rootIdentity, path.join(root, "instance.json"));
  if (
    snapshot.rootState.sha256 !== pointer.historicalSnapshotHash ||
    snapshot.rootIdentity.sha256 !== pointer.historicalIdentityHash ||
    digest(snapshot.grants) !== digest(grantReferences(epochRoot)) ||
    digest(snapshot.qualification) !==
      digest([pointer.qualificationReceipt, ...pointer.qualificationEvidence])
  )
    fail("Predecessor history, grants or qualification changed");
  for (const proof of snapshot.qualification) verified(proof, proof.path);
  if (closedSuccessor) {
    (
      load("./queue-closed-epoch-proof") as {
        closedEpochProof(
          root: string,
          pointer: EpochPointer,
          entry?: Reference,
        ): unknown;
      }
    ).closedEpochProof(root, pointer, authority.closedEpochProof);
    if (
      authority.expectedProcess?.pid !== pointer.currentInstance.pid ||
      authority.expectedProcess?.birth !== pointer.currentInstance.birth
    )
      fail(
        "A closed-epoch successor must retain the exact living Fusion process",
      );
  }
  const qualified = record(
    verified(
      authority.qualification,
      path.join(audit, "installed-qualification.json"),
    ),
  );
  if (
    qualified["passed"] !== true ||
    qualified["productionAdmission"] !== true ||
    qualified["liveSdkRequestsSent"] !== 0 ||
    qualified["sourceCommit"] !== authority.sourceCommit ||
    qualified["buildHash"] !== authority.buildHash ||
    qualified["deadEpochSuccessorReadQualified"] !== true ||
    qualified["deadEpochSuccessorRestoreQualified"] !== true ||
    (closedSuccessor && qualified["closedEpochSuccessorQualified"] !== true)
  )
    fail(
      "Successor runtime has no pinned installed production-checker qualification",
    );
  return { authority, audit, pointer, state, identity };
}
export function epochLineage(root: string, pointer: EpochPointer) {
  const result: ReturnType<typeof successionAuthority>[] = [],
    seen = new Set([pointer.epochId]);
  let current = pointer;
  while (current.succession !== undefined) {
    if (result.length >= 32) fail("Epoch lineage bound exceeded");
    const previous = successionAuthority(root, current.succession);
    if (
      seen.has(previous.pointer.epochId) ||
      current.ownerClientId !== previous.authority.clientId ||
      current.ownerTokenHash !== previous.authority.ownerTokenHash ||
      current.historicalSnapshotHash !==
        previous.pointer.historicalSnapshotHash ||
      current.historicalIdentityHash !==
        previous.pointer.historicalIdentityHash ||
      current.qualificationReceipt?.path !==
        path.join(
          previous.audit,
          "isolated-scratch-qualification",
          "result.json",
        )
    )
      fail("Epoch lineage is cyclic or does not bind the new qualification");
    seen.add(previous.pointer.epochId);
    result.push(previous);
    current = previous.pointer;
  }
  if (
    current.qualificationReceipt?.path !==
    path.join(root, "isolated-scratch-qualification", "result.json")
  )
    fail("Epoch lineage has no original qualified genesis");
  return result;
}
export function epochControlDirectory(
  root: string,
  pointer?: { succession?: Reference } | null,
): string {
  if (!pointer?.succession) return root;
  return successionAuthority(root, pointer.succession).audit;
}

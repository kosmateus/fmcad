import * as fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual as same } from "node:util";
import { createRequire } from "node:module";
const runtimeRequire = createRequire(__filename);
interface Reference {
  path: string;
  sha256: string;
}
interface DocumentIdentity {
  name: string;
  creationId: string;
  fileId: string | null;
}
interface ProcessIdentity {
  pid: number;
  birth: string;
  version: string;
}
interface Pointer {
  root: string;
  epochId: string;
  document: DocumentIdentity;
  ownerClientId: string;
  ownerTokenHash: string;
  currentInstance: ProcessIdentity;
  qualificationReceipt: Reference;
  succession?: unknown;
  restoreActiveCreationId?: string | null;
}
interface Binding extends Record<string, unknown> {
  purpose: string;
  epochId: string;
  clientId: string;
  ownerTokenHash: string;
  document: DocumentIdentity;
  currentInstance: ProcessIdentity;
  sdkProofPath: string;
  publication?: unknown;
  savedDocument?: unknown;
  firstSaveJobId?: unknown;
  sourceCommit?: unknown;
  buildHash?: unknown;
  restoreActiveCreationId?: unknown;
}
interface CloseRecord {
  epochId: string;
  document: DocumentIdentity;
  historicalOutcome: string;
  qualificationEvidence: Reference[];
  disposition?: string;
  retentionRequestId?: string;
  admissionMode?: string;
  receipt: Reference;
  publication?: unknown;
  savedDocument?: unknown;
}
interface Intent {
  binding: Binding;
  sourceArtifactHash: string;
}
interface Start {
  binding: Record<string, unknown> & { rpcId: string };
  receipt: string;
  pythonCheck?: { status: string };
}
interface Result {
  kind: string;
  status: string;
  sdkRequestsSent: number;
  endpointVerified: boolean;
  clientId: string;
  summary: unknown;
  requestId?: string;
}
const { readJson, sameInstance } = runtimeRequire("./queue-instance") as {
  readJson(file: string, limit: number): unknown;
  sameInstance(a: unknown, b: unknown): boolean;
};
const { savedAuditKind } = runtimeRequire("./queue-saved-audit-path") as {
  savedAuditKind(prefix: string, requestId: string): string;
};
const { fileHash } = runtimeRequire("./queue-atomic-migration-files") as {
  fileHash(file: string): { sha256: string };
};
const digest = (value: unknown): string =>
  (
    runtimeRequire("./dist/core/application/cad/json") as {
      hash(value: unknown): string;
    }
  ).hash(value);
const fail = (message: string): never => {
  throw Object.assign(new Error(message), { code: "EPOCH_CLOSE_UNPROVEN" });
};

// Existing fixed scratch cleanup publishes both an SDK proof and an independent
// physical receipt. Read those exact artifacts; a closed.json label alone is
// not permission to adopt/create anything.
function closedEpochProof(
  root: string,
  pointer: Pointer,
  reference: Reference,
) {
  function read(ref: Reference | undefined, expected: string): unknown {
    if (
      !ref ||
      ref.path !== expected ||
      !path.isAbsolute(expected) ||
      fs.realpathSync(expected) !== expected ||
      fileHash(expected).sha256 !== ref.sha256
    )
      fail("Cleanup evidence changed or escaped the original namespace");
    return readJson(expected, 32 * 1024 * 1024);
  }
  const closedFile = path.join(pointer.root, "closed.json");
  const closed = read(reference, closedFile) as CloseRecord;
  if (
    pointer.root !== path.join(root, "admission-epochs", pointer.epochId) ||
    closed.epochId !== pointer.epochId ||
    !same(closed.document, pointer.document) ||
    closed.historicalOutcome !== "unknown" ||
    !Array.isArray(closed.qualificationEvidence)
  )
    fail("The exact owned epoch/document needs a completed cleanup proof");
  const controlRoot = pointer.succession
    ? path.dirname(path.dirname(pointer.qualificationReceipt.path))
    : root;
  const retained = closed.disposition === "retained-new-saved-file";
  if (closed.disposition !== undefined && !retained)
    fail("Unknown owned-document disposition");
  if (
    retained &&
    (typeof closed.retentionRequestId !== "string" ||
      !closed.retentionRequestId.trim() ||
      closed.retentionRequestId.length > 180)
  )
    fail("Exact saved retention request required");
  const kind = retained
    ? savedAuditKind("sr-", closed.retentionRequestId!)
    : "isolated-scratch-close";
  const dir = path.join(controlRoot, kind);
  const resultFile = path.join(dir, "result.json");
  const result = read(closed.receipt, resultFile) as Result;
  const refs = new Map(
    closed.qualificationEvidence.map((ref) => [ref.path, ref]),
  );
  if (refs.size !== closed.qualificationEvidence.length)
    fail("Duplicate cleanup evidence is not a complete proof");
  const intent = read(
    refs.get(path.join(dir, "intent.json")),
    path.join(dir, "intent.json"),
  ) as Intent;
  const start = read(
    refs.get(path.join(dir, "start.json")),
    path.join(dir, "start.json"),
  ) as Start;
  read(refs.get(path.join(dir, "wire.json")), path.join(dir, "wire.json"));
  const proofFile = path.join(
    dir,
    retained ? "sdk-retained.json" : "sdk-closed.json",
  );
  const proof = read(refs.get(proofFile), proofFile),
    binding = intent.binding;
  (
    runtimeRequire("./dist/node-adapters/broker-ipc/normal-admission") as {
      verifyCloseMode(
        closed: CloseRecord,
        binding: unknown,
        restored: boolean,
        retained: boolean,
      ): void;
    }
  ).verifyCloseMode(
    closed,
    binding,
    Object.hasOwn(pointer, "restoreActiveCreationId"),
    retained,
  );
  if (
    result.kind !== kind ||
    result.status !== "complete" ||
    result.sdkRequestsSent !== 1 ||
    result.endpointVerified !== true ||
    result.clientId !== pointer.ownerClientId ||
    !same(proof, result.summary) ||
    binding?.purpose !==
      (retained ? "saved-fixture-retain-v1" : "isolated-scratch-close-v1") ||
    binding.epochId !== pointer.epochId ||
    binding.clientId !== pointer.ownerClientId ||
    binding.ownerTokenHash !== pointer.ownerTokenHash ||
    !same(binding.document, pointer.document) ||
    !sameInstance(binding.currentInstance, pointer.currentInstance) ||
    binding.sdkProofPath !== proofFile ||
    !start.binding ||
    !/^[a-f0-9]{64}$/.test(intent.sourceArtifactHash || "") ||
    start.binding["auditBindingHash"] !== digest(binding) ||
    start.binding["pythonOriginHash"] !== intent.sourceArtifactHash ||
    start.binding["purpose"] !== binding.purpose ||
    !sameInstance(
      start.binding["auditExpectedInstance"],
      pointer.currentInstance,
    ) ||
    !/^[a-f0-9-]{36}$/.test(start.binding.rpcId || "") ||
    start.receipt !==
      path.join(dir, "remote-" + start.binding.rpcId + ".json") ||
    start.pythonCheck?.status !== "passed"
  )
    fail(
      "Cleanup must retain exact checked source, SDK proof and original owner binding",
    );
  const remote = read(refs.get(start.receipt), start.receipt) as Record<
    string,
    unknown
  >;
  if (
    remote["terminal"] !== true ||
    remote["outcome"] !== "succeeded" ||
    !sameInstance(remote["instance"], pointer.currentInstance) ||
    Object.keys(start.binding).some(
      (key) => !same(remote[key], start.binding[key]),
    )
  )
    fail("Cleanup physical outcome is not known successful");
  if (retained) {
    const publication = (
      runtimeRequire("./queue-saved-first-save-evidence") as {
        readSavedPublication(
          root: string,
          pointer: Pointer,
        ): {
          reference: Reference;
          value: {
            publication: { document: unknown };
            firstSaveJobId: string;
            sourceCommit: string;
            buildHash: string;
          };
        };
      }
    ).readSavedPublication(root, pointer);
    if (
      !same(closed.publication, publication.reference) ||
      !same(binding.publication, publication.reference) ||
      !same(closed.savedDocument, publication.value.publication.document) ||
      !same(binding.savedDocument, closed.savedDocument) ||
      binding.firstSaveJobId !== publication.value.firstSaveJobId ||
      binding.sourceCommit !== publication.value.sourceCommit ||
      binding.buildHash !== publication.value.buildHash ||
      result.requestId !== closed.retentionRequestId
    )
      fail(
        "Retain must preserve the exact independently observed new file publication",
      );
    (
      runtimeRequire("./queue-saved-fixture-reader") as {
        parseSavedFixtureReader(
          reply: unknown,
          document: DocumentIdentity,
          binding: Binding,
        ): unknown;
      }
    ).parseSavedFixtureReader(
      {
        result: {
          content: [
            { type: "text", text: "FMCAD_RESULT " + JSON.stringify(proof) },
          ],
        },
      },
      pointer.document,
      binding,
    );
  } else
    (
      runtimeRequire("./queue-scratch-qualification") as {
        parseScratchClose(
          reply: unknown,
          document: DocumentIdentity,
          binding: Binding,
        ): unknown;
      }
    ).parseScratchClose(
      {
        result: {
          content: [
            { type: "text", text: "FMCAD_RESULT " + JSON.stringify(proof) },
          ],
        },
      },
      pointer.document,
      binding,
    );
  if (
    Object.hasOwn(pointer, "restoreActiveCreationId") &&
    (!Object.hasOwn(binding, "restoreActiveCreationId") ||
      binding.restoreActiveCreationId !== pointer.restoreActiveCreationId)
  )
    fail(
      "Cleanup did not preserve the original active-document restore requirement",
    );
  if (refs.size !== 5)
    fail(
      "Cleanup evidence set is not the exact original intent/start/wire/SDK/remote set",
    );
  return { closed, result, intent, start, proof };
}

export { closedEpochProof };

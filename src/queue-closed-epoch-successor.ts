import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual as same } from "node:util";
import { createRequire } from "node:module";
import type { SavedEpoch } from "../packages/core/src/application/cad/saved-fixture-contracts";
import type { Reference } from "./queue-epoch-lineage";
const load = createRequire(__filename);
const { hash, readJson, durable, priorProcessAlive } = load(
  "./queue-instance",
) as {
  hash(value: string): string;
  readJson(file: string, limit: number): unknown;
  durable(file: string, value: unknown, exclusive?: boolean): void;
  priorProcessAlive(value: unknown): boolean | null;
};
const { fileHash, directory, exclusive } = load(
  "./queue-atomic-migration-files",
) as typeof import("./queue-atomic-migration-files");
const { predecessorSnapshot, reference } = load(
  "./queue-epoch-lineage",
) as typeof import("./queue-epoch-lineage");
const { closedEpochProof } = load(
  "./queue-closed-epoch-proof",
) as typeof import("./queue-closed-epoch-proof");
function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function fields(value: unknown): Record<string, unknown> {
  return record(value) ? value : {};
}
function read(file: string): Record<string, unknown> {
  const value = readJson(file, 32 * 1024 * 1024);
  if (!record(value))
    fail("INVALID_REQUEST", "Object-shaped closed-epoch evidence required");
  return value;
}
interface Epoch extends SavedEpoch {
  succession?: Reference;
}
interface SuccessorPorts {
  dir: string;
  buildHash: string;
  runtime: string;
  marker: { pid: number; birth: string; nonce: string };
  state: {
    epoch: Epoch | null;
    data: {
      jobs: Record<string, { state: string }>;
      active?: unknown;
      blocked?: unknown;
      lease?: unknown;
      localUnknown?: unknown;
      controlBlocked?: unknown;
    };
  };
  clients(): Record<string, string>;
  fence(): void;
  assertControl(value: unknown): void;
}
interface Client {
  call(
    action: "queue-summary",
  ): Promise<{
    control?: {
      buildHash: string;
      instanceId: string;
      generation: number;
      contextEpoch: number;
    };
  }>;
  call(action: "authorize-closed-successor", input: unknown): Promise<unknown>;
}
function publishActive(
  p: SuccessorPorts,
  epoch: Epoch,
  audit: string,
  entry: Reference,
) {
  const file = path.join(p.dir, "active-epoch-succession.json");
  const prior = fs.existsSync(file) ? read(file) : null;
  if (same(prior, { version: 1, authority: entry })) return;
  if (prior && !same(prior["authority"], epoch.succession))
    fail(
      "EPOCH_SUCCESSOR_PENDING",
      "A different unconsumed successor authority remains fenced",
    );
  if (prior)
    exclusive(path.join(audit, "previous-active-succession.json"), prior);
  p.fence();
  if (!same(read(path.join(p.dir, "isolated-admission-epoch.json")), epoch))
    fail(
      "EPOCH_SUCCESSOR_FENCE_CHANGED",
      "The closed predecessor pointer changed before active authority publication",
    );
  durable(file, { version: 1, authority: entry }, !prior);
}

// Broker-private synchronous metadata composition: no transport, process launch,
// grant creation, direct SDK access or caller-provided source execution.
export function authorizeClosedSuccessor(
  p: SuccessorPorts,
  input: unknown,
  clientId: string,
) {
  if (!record(input))
    fail(
      "INVALID_REQUEST",
      "Only an exact closed-successor approval reference is accepted",
    );
  const message = input;
  if (
    Object.keys(message).some(
      (key) => !["action", "auth", "control", "approval"].includes(key),
    ) ||
    message["action"] !== "authorize-closed-successor"
  )
    fail(
      "INVALID_REQUEST",
      "Only an exact closed-successor approval reference is accepted",
    );
  const ref = fields(message["approval"]);
  if (
    !ref ||
    typeof ref["path"] !== "string" ||
    !path.isAbsolute(ref["path"]) ||
    fs.realpathSync(ref["path"]) !== ref["path"] ||
    fileHash(ref["path"]).sha256 !== ref["sha256"]
  )
    fail("INVALID_REQUEST", "Pinned canonical owner approval required");
  const approval = read(ref["path"]),
    epoch = p.state.epoch;
  if (
    !epoch ||
    clientId !== epoch.ownerClientId ||
    p.clients()[clientId] !== epoch.ownerTokenHash ||
    approval["clientId"] !== clientId
  )
    fail(
      "NOT_OWNER",
      "Only the original credential-bound owner may authorize the next scratch",
    );
  if (
    approval["version"] !== 1 ||
    approval["purpose"] !== "closed-isolated-epoch-successor-v1" ||
    typeof approval["requestId"] !== "string" ||
    !approval["requestId"].trim() ||
    approval["requestId"].length > 160
  )
    fail(
      "INVALID_REQUEST",
      "A distinct closed-epoch purpose and stable request ID are required",
    );
  const audit = path.join(
    p.dir,
    "epoch-successions",
    hash(approval["requestId"]),
  );
  const authorityFile = path.join(audit, 'authority["json"]');
  if (fs.existsSync(authorityFile)) {
    const authority = read(authorityFile),
      entry = reference(authorityFile);
    if (
      authority["kind"] !== "owner-authenticated-closed-epoch-successor" ||
      !same(authority["approval"], ref) ||
      authority["clientId"] !== clientId ||
      authority["ownerTokenHash"] !== epoch.ownerTokenHash
    )
      fail(
        "REQUEST_CONFLICT",
        "The original owner/approval already owns this successor request",
      );
    (
      load(
        "./queue-epoch-successor",
      ) as typeof import("./composition/queue-epoch-successor")
    ).assertCurrentPredecessor(p.dir, entry, { allowPublished: true });
    if (!same(epoch.succession, entry)) publishActive(p, epoch, audit, entry);
    return {
      version: 1,
      kind: "closed-epoch-successor-authorized",
      requestId: approval["requestId"],
      authority: entry,
      sdkRequestsSent: 0,
    };
  }
  p.assertControl(message["control"]);
  p.fence();
  const state = p.state.data;
  if (
    state.active ||
    state.blocked ||
    state.lease ||
    state.localUnknown ||
    state.controlBlocked ||
    Object.values(state.jobs).some(
      (job) =>
        !["succeeded", "failed", "expired", "cancelled"].includes(job.state),
    )
  )
    fail(
      "EPOCH_BUSY",
      "No unknown, active, leased or unfinished work may be left behind",
    );
  const snapshot = predecessorSnapshot(p.dir, audit);
  const closed = reference(path.join(epoch.root, "closed.json"));
  closedEpochProof(p.dir, epoch, closed);
  const identity = read(path.join(epoch.root, "instance.json"));
  if (
    approval["epochId"] !== epoch.epochId ||
    approval["pointerHash"] !== snapshot.pointer.sha256 ||
    approval["stateHash"] !== snapshot.state.sha256 ||
    approval["closedProofHash"] !== closed.sha256 ||
    approval["sourceCommit"] !== identity["sourceCommit"] ||
    approval["buildHash"] !== p.buildHash ||
    identity["buildHash"] !== p.buildHash ||
    typeof approval["sourceCommit"] !== "string" ||
    !/^[a-f0-9]{40}$/.test(approval["sourceCommit"]) ||
    priorProcessAlive(epoch.currentInstance) !== true ||
    priorProcessAlive(epoch.originalInstance) !== false ||
    !same(read(path.join(p.dir, "broker.lock")), p.marker) ||
    priorProcessAlive(p.marker) !== true
  )
    fail(
      "EPOCH_SUCCESSOR_FENCE_CHANGED",
      "Exact closed epoch, live owner/process and qualified current build required",
    );
  const q = fields(approval["qualification"]);
  if (
    !q ||
    typeof q["path"] !== "string" ||
    !path.isAbsolute(q["path"]) ||
    fs.realpathSync(q["path"]) !== q["path"] ||
    fileHash(q["path"]).sha256 !== q["sha256"]
  )
    fail(
      "EPOCH_SUCCESSOR_UNQUALIFIED",
      "Pinned installed qualification is required",
    );
  const qualification = read(q["path"]);
  if (
    qualification["passed"] !== true ||
    qualification["productionAdmission"] !== true ||
    qualification["liveSdkRequestsSent"] !== 0 ||
    qualification["sourceCommit"] !== approval["sourceCommit"] ||
    qualification["buildHash"] !== p.buildHash ||
    qualification["deadEpochSuccessorReadQualified"] !== true ||
    qualification["deadEpochSuccessorRestoreQualified"] !== true ||
    qualification["closedEpochSuccessorQualified"] !== true
  )
    fail(
      "EPOCH_SUCCESSOR_UNQUALIFIED",
      "The installed runtime must qualify closed-scratch succession and fixed sources",
    );
  const activeFile = path.join(p.dir, "active-epoch-succession.json");
  const active = fs.existsSync(activeFile) ? read(activeFile) : null;
  if (active && !same(active["authority"], epoch.succession))
    fail(
      "EPOCH_SUCCESSOR_PENDING",
      "A different unconsumed successor authority remains fenced",
    );
  fs.mkdirSync(audit, { recursive: true, mode: 0o700 });
  directory(audit);
  if (fs.realpathSync(audit) !== audit)
    fail("UNSAFE_PATH", "Canonical successor audit required");
  const frozen = predecessorSnapshot(p.dir, audit, true);
  if (!same(snapshot, frozen))
    fail(
      "EPOCH_SUCCESSOR_FENCE_CHANGED",
      "The predecessor changed before authority publication",
    );
  const qualifiedFile = path.join(audit, 'installed-qualification["json"]');
  // Store the original qualification bytes, not a reserialized equivalent.
  if (!fs.existsSync(qualifiedFile)) {
    fs.copyFileSync(q["path"], qualifiedFile, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(qualifiedFile, 0o600);
    const fd = fs.openSync(qualifiedFile, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const parent = fs.openSync(audit, "r");
    try {
      fs.fsyncSync(parent);
    } finally {
      fs.closeSync(parent);
    }
  }
  if (fileHash(qualifiedFile).sha256 !== q["sha256"]) {
    fail(
      "EPOCH_SUCCESSOR_UNQUALIFIED",
      "Qualification bytes must be preserved exactly",
    );
  }
  const authority = {
    version: 1,
    kind: "owner-authenticated-closed-epoch-successor",
    requestId: approval["requestId"],
    clientId,
    ownerTokenHash: epoch.ownerTokenHash,
    predecessor: frozen,
    previousOwner: p.marker,
    previousBuildHash: identity["buildHash"],
    previousBrokerTerminated: false,
    previousProcessTerminated: false,
    expectedProcess: {
      pid: epoch.currentInstance.pid,
      birth: epoch.currentInstance.birth,
    },
    candidateRoot: p.runtime,
    sourceCommit: approval["sourceCommit"],
    buildHash: p.buildHash,
    qualification: reference(qualifiedFile),
    closedEpochProof: closed,
    approval: ref,
    permission: "one-proven-new-document-only",
    historicalOutcome: "unknown",
  };
  exclusive(authorityFile, authority);
  const entry = reference(authorityFile);
  publishActive(p, epoch, audit, entry);
  return {
    version: 1,
    kind: "closed-epoch-successor-authorized",
    requestId: approval["requestId"],
    authority: entry,
    sdkRequestsSent: 0,
  };
}

export async function prepareClosedSuccessor(
  client: Client,
  options: { approval: string; requestId: string },
  codeHash: string,
) {
  const file = fs.realpathSync(options.approval),
    approval = read(file);
  if (approval["requestId"] !== options.requestId)
    fail("INVALID_REQUEST", "Use the exact stable owner approval request ID");
  const status = await client.call("queue-summary");
  if (status.control?.buildHash !== codeHash)
    fail("BUILD_CHANGED", "CLI and broker must use the same qualified runtime");
  const { instanceId, generation, contextEpoch } = status.control;
  return client.call("authorize-closed-successor", {
    approval: reference(file),
    control: { instanceId, generation, contextEpoch, buildHash: codeHash },
  });
}

import fs from "node:fs";
import path from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import { isDeepStrictEqual as same } from "node:util";
import type {
  Client,
  Process,
  Owner,
  Reference,
  Approval,
  Pointer,
  Checked,
  Sdk1MetadataWorkerProcess,
  Sdk1MetadataWorkerProcessResult,
} from "./queue-epoch-successor-types";
import type {
  AuditBinding,
  AuditReader,
} from "../../packages/node-adapters/src/execution/recovery-audit";

const load = createRequire(
  path.join(__dirname, "../../queue-epoch-successor.js"),
);
type Data = Record<string, unknown>;
const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const absentError =
  "NoProcessFoundForGivenId,Microsoft.PowerShell.Commands.GetProcessCommand";
/** Retained legacy target binding. New targets explicitly pin their predecessor
 * source and runtime; neither form can change after owner authorization. */
export const normalColdProfile = Object.freeze({
  kind: "normal-currentstore-v1" as const,
  sourceCommit: "4bae34f9970b1a3179528a1dd06e2d0e5a3f702d",
  buildHash: "6b0c57e05541950a885527f09cde9b36ae0219c658a2cf2911af81728e26458a",
});
export interface NormalCurrentStoreTarget {
  kind: "normal-currentstore-target-v1";
  requestKind?: "raw-rpc";
  predecessorSource?: Reference;
  sourceCommit?: string;
  buildHash?: string;
  epochId: string;
  epochClientId: string;
  jobId: string;
  jobClientId: string;
  jobRequestId: string;
  rpcId: string;
  creationId: string;
  documentName: string;
  requestHash: string;
  jobHash: string;
  sourceHash: string;
  sdk: Process;
  metadata: Process;
  configHash: string;
}
type Profile = Omit<typeof normalColdProfile, "kind"> &
  NormalCurrentStoreTarget;
export interface NormalCurrentStoreApproval {
  kind: "normal-currentstore-v1";
  jobAuthorization: Reference;
  deathProof: Reference;
  producerRetirement: Reference;
}
export interface NormalCurrentFactsRetryEvidence {
  previousRequestId: string;
  previousAuthority: Reference;
  physicalResult: Reference;
  validationFailure: Reference;
  queueSummary: unknown;
}
export interface NormalCurrentFactsRetryCandidate {
  requestId: string;
  candidateRoot: string;
  sourceCommit: string;
  buildHash: string;
  qualification: Reference;
  expectedProcess: Process;
}
export interface NormalCurrentFactsRetryCandidateBinding {
  requestId: string;
  sourceCommit: string;
  buildHash: string;
  qualification: Reference;
  expectedProcess: Process;
}
export interface NormalCurrentFactsRetryInspection {
  previousAuthority: Reference;
  baseRequestId: string;
  originalNormalStore: NormalCurrentStoreApproval;
  currentOwner: Owner;
  candidateRoot: string;
  candidate: NormalCurrentFactsRetryCandidateBinding;
  expectedProcess: Process;
}
interface Snapshot {
  files: Reference[];
  // request.json is credential-bearing: preserve its sealed filesystem identity,
  // never read, hash, back up, parse, or include its contents in a journal.
  sealedRequests: {
    path: string;
    dev: number;
    ino: number;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
  }[];
  producers: Process[];
  epochOwnerTokenHash: string;
  jobOwnerTokenHash: string;
}
interface Authorization {
  version: 1;
  kind: "normal-currentstore-job-owner-authorization";
  requestId: string;
  target: Reference;
  profile: Profile;
  snapshot: Snapshot;
}
interface NormalCurrentFactsRetryGrant extends NormalCurrentFactsRetryInspection {
  version: 1;
  kind: "normal-currentfacts-retry-authorization";
  physicalResult: Reference;
  validationFailure: Reference;
  failedReadFiles: Reference[];
  queueSummary: Data;
  allowNewUnsavedDefault: boolean;
}
export interface NormalColdPorts {
  sdkProcess(process: Process): {
    state: "absent" | "present";
    pid: number;
    birth?: string;
    observedAtUtc: string;
    errorId?: string;
  };
  producerAbsent(process: Process): boolean;
}
export interface NormalMetadataRetirementPorts extends NormalColdPorts {
  buildHash(runtime: string): string;
  process(
    owner: Sdk1MetadataWorkerProcess,
    runtime: string,
    refs: Reference[],
    apply: boolean,
    root: string,
  ): Sdk1MetadataWorkerProcessResult;
}
const defaultPorts: NormalColdPorts = {
  sdkProcess(process) {
    return (
      load(
        "./dist/composition/queue-epoch-successor-retirement",
      ) as typeof import("./queue-epoch-successor-retirement")
    ).querySdkProcess(process);
  },
  producerAbsent(process) {
    // All producers in this fixed profile are Linux workers. A reused PID is
    // not absence, even if its birth differs from the old worker's birth.
    if (!process.birth.includes(":") || !fs.existsSync("/proc/self"))
      return false;
    try {
      fs.lstatSync(`/proc/${process.pid}`);
      return false;
    } catch (error) {
      return (
        !!error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      );
    }
  },
};
const defaultRetirementPorts: NormalMetadataRetirementPorts = {
  ...defaultPorts,
  buildHash: (runtime) =>
    (load("./queue-instance") as { buildHash(root: string): string }).buildHash(
      runtime,
    ),
  process: (owner, runtime, refs, apply, root) =>
    (
      load(
        "./dist/composition/queue-epoch-successor-retirement",
      ) as typeof import("./queue-epoch-successor-retirement")
    ).inspectMetadataWorkerProcess(
      owner,
      runtime,
      refs,
      apply,
      root,
      [],
      "inspect",
      "normal-serve",
    ),
};
function fail(message: string): never {
  throw Object.assign(new Error(message), {
    code: "NORMAL_SUCCESSOR_UNPROVEN",
  });
}
function object(value: unknown): Data {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("Object-shaped normal successor evidence required");
  return value as Data;
}
function canonical(file: string, directory = false): string {
  if (
    !path.isAbsolute(file) ||
    fs.realpathSync(file) !== file ||
    (directory
      ? !fs.lstatSync(file).isDirectory()
      : !fs.lstatSync(file).isFile())
  )
    fail("Canonical normal-currentstore path required; symlinks are refused");
  return file;
}
function bytes(file: string): Buffer {
  if (path.basename(file) === "request.json")
    fail(
      "Credential-bearing job requests are sealed metadata only; never open or hash them",
    );
  canonical(file);
  // Match the existing successor/lineage snapshot bound without widening the
  // smaller limit for ordinary output evidence or opening sealed requests.
  const maxBytes =
    path.basename(file) === "queue-state.json"
      ? 256 * 1024 * 1024
      : 16 * 1024 * 1024;
  return (
    load(
      "./dist/node-adapters/persistence/records",
    ) as typeof import("../../packages/node-adapters/src/persistence/records")
  ).readBytes(file, maxBytes, fs, file);
}
function read(file: string): Data {
  return object(JSON.parse(bytes(file).toString("utf8")) as unknown);
}
function reference(file: string): Reference {
  return { path: file, sha256: digest(bytes(file)) };
}
function checked(entry: Reference, expected?: string): Data {
  if (!entry || (expected !== undefined && entry.path !== expected))
    fail("Normal-currentstore evidence changed or was retargeted");
  const content = bytes(entry.path);
  if (digest(content) !== entry.sha256)
    fail("Normal-currentstore evidence changed or was retargeted");
  return object(JSON.parse(content.toString("utf8")) as unknown);
}
function process(value: unknown): Process {
  const p = object(value);
  if (
    !Number.isSafeInteger(p["pid"]) ||
    Number(p["pid"]) <= 0 ||
    typeof p["birth"] !== "string" ||
    !p["birth"]
  )
    fail("Exact producer birth required");
  return { pid: Number(p["pid"]), birth: p["birth"] };
}
function journal(root: string, requestId: string): string {
  canonical(root, true);
  if (!requestId || requestId.length > 140)
    fail("A fresh normal-successor request ID is required");
  return path.join(root, "normal-cold-successions", digest(requestId));
}
function authenticateOwner(client: Client, expectedClient: string): string {
  if (
    client.auth.clientId !== expectedClient ||
    typeof client.auth.clientToken !== "string" ||
    !client.auth.clientToken
  )
    fail("The exact existing sealed owner client is required");
  const registered = read(path.join(client.dir, "clients.json"))[
    expectedClient
  ];
  const actual = digest(client.auth.clientToken);
  if (
    typeof registered !== "string" ||
    !/^[a-f0-9]{64}$/.test(registered) ||
    !timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(registered, "hex"))
  )
    fail("The original registered owner credential is required");
  return actual;
}
function profile(entry: Reference): Profile {
  const target = checked(entry);
  const keys = [
    "kind",
    "epochId",
    "epochClientId",
    "jobId",
    "jobClientId",
    "jobRequestId",
    "rpcId",
    "creationId",
    "documentName",
    "requestHash",
    "jobHash",
    "sourceHash",
    "sdk",
    "metadata",
    "configHash",
  ];
  if (Object.hasOwn(target, "requestKind")) {
    keys.push("requestKind", "predecessorSource");
    if (
      target["requestKind"] !== "raw-rpc" ||
      !Object.hasOwn(target, "sourceCommit") ||
      !Object.hasOwn(target, "buildHash")
    )
      fail(
        "Raw RPC requires its explicit discriminator and predecessor runtime",
      );
  }
  if (
    Object.hasOwn(target, "sourceCommit") ||
    Object.hasOwn(target, "buildHash")
  ) {
    keys.push("sourceCommit", "buildHash");
    if (
      typeof target["sourceCommit"] !== "string" ||
      !/^[a-f0-9]{40}$/.test(target["sourceCommit"]) ||
      typeof target["buildHash"] !== "string" ||
      !/^[a-f0-9]{64}$/.test(target["buildHash"])
    )
      fail(
        "Exact predecessor source commit and runtime hash required together",
      );
  }
  if (
    Object.keys(target).sort().join() !== keys.sort().join() ||
    target["kind"] !== "normal-currentstore-target-v1" ||
    keys
      .filter(
        (key) =>
          !["kind", "sdk", "metadata", "predecessorSource"].includes(key),
      )
      .some((key) => typeof target[key] !== "string" || !target[key]) ||
    ["epochId", "jobId", "rpcId", "creationId"].some(
      (key) => !/^[a-f0-9-]{36}$/.test(String(target[key])),
    ) ||
    ["requestHash", "jobHash", "sourceHash"].some(
      (key) => !/^[a-f0-9]{64}$/.test(String(target[key])),
    ) ||
    target["epochClientId"] === target["jobClientId"] ||
    !/^\d{17,18}$/.test(process(target["sdk"]).birth) ||
    !process(target["metadata"]).birth.includes(":")
  )
    fail(
      "Explicit exact normal target schema, distinct owners and OS process pins required",
    );
  if (
    Object.keys(object(target["sdk"])).sort().join() !== "birth,pid,version" ||
    typeof object(target["sdk"])["version"] !== "string" ||
    Object.keys(object(target["metadata"])).sort().join() !== "birth,pid"
  )
    fail("Exact SDK version and metadata process tuple required");
  if (!/^[a-f0-9]{64}$/.test(String(target["configHash"])))
    fail("Exact predecessor configuration hash required");
  return { ...normalColdProfile, ...target } as unknown as Profile;
}
function rawDocumentInventory(root: string, p: Profile, rpc: Data): unknown[] {
  const original = object(rpc["instance"])["documents"];
  if (Array.isArray(original)) return original;
  // New metadata-only successors may retain a compact product instance. Their
  // existing, completed preflight is separate document evidence, never evidence
  // that the product ran, failed, or can be replayed.
  const dir = path.join(root, "jobs", p.jobId);
  if (!["preflight-start.json", "preflight.json", "preflight-result.json"].every(name => fs.existsSync(path.join(dir, name))))
    fail("The compact product instance has no complete original preflight document observation");
  const start = read(path.join(dir, "preflight-start.json"));
  const complete = read(path.join(dir, "preflight.json"));
  const result = read(path.join(dir, "preflight-result.json"));
  const binding = object(start["binding"]);
  const rpcId = binding["rpcId"];
  if (typeof rpcId !== "string" || !/^[a-f0-9-]{36}$/.test(rpcId))
    fail("An exact original preflight RPC is required for document evidence");
  const receiptPath = path.join(dir, `preflight-${rpcId}.receipt.json`);
  if (!fs.existsSync(receiptPath)) fail("Original preflight has no bound terminal receipt");
  const physical = read(receiptPath);
  const observedAt = typeof result["at"] === "string" ? Date.parse(result["at"]) : NaN;
  const rows = typeof result["text"] === "string"
    ? result["text"].split(/\r?\n/).filter(line => line.startsWith("FMCAD_QUEUE_INSTANCE ")) : [];
  let observed: Data = {};
  if (rows.length === 1) {
    try { observed = object(JSON.parse(rows[0]!.slice("FMCAD_QUEUE_INSTANCE ".length))); }
    catch { fail("Preflight document observation is malformed"); }
  }
  if (start["version"] !== 2 || complete["version"] !== 2 ||
      start["jobId"] !== p.jobId || complete["jobId"] !== p.jobId ||
      start["buildHash"] !== p.buildHash || complete["buildHash"] !== p.buildHash ||
      binding["jobId"] !== p.jobId || binding["buildHash"] !== p.buildHash ||
      binding["requestHash"] !== digest(`preflight:${p.jobId}:${rpcId}`) ||
      Object.keys(binding).sort().join() !== "buildHash,jobId,requestHash,rpcId" ||
      start["receipt"] !== receiptPath || complete["completed"] !== true ||
      complete["idle"] !== true || complete["requiresIdle"] !== true ||
      result["stage"] !== "instance_probe" || result["failed"] !== false || rows.length !== 1 ||
      typeof start["at"] !== "number" || !Number.isFinite(observedAt) ||
      start["at"] <= 0 || observedAt < start["at"] || observedAt > Date.now() ||
      !same(observed, complete["instance"]) ||
      ![start["instance"], complete["instance"], physical["instance"]].every(value =>
        same(process(value), process(p.sdk)) && object(value)["version"] === p.sdk.version) ||
      physical["terminal"] !== true || physical["outcome"] !== "succeeded" ||
      Object.entries(binding).some(([key, value]) => !same(physical[key], value)) ||
      !Array.isArray(observed["documents"]))
    fail("Document fallback requires the original job's exact successful idle preflight, not a product completion");
  const documents = observed["documents"] as unknown[];
  const identities = new Set<string>();
  for (const value of documents) {
    const doc = object(value);
    if (Object.keys(doc).sort().join() !== "fileId,id,isModified,isSaved" ||
        typeof doc["id"] !== "string" || !doc["id"] || identities.has(doc["id"]) ||
        !(doc["fileId"] === null || typeof doc["fileId"] === "string") ||
        typeof doc["isSaved"] !== "boolean" || typeof doc["isModified"] !== "boolean")
      fail("Preflight inventory needs unique complete document identities");
    identities.add(doc["id"]);
  }
  return documents;
}

function snapshot(
  root: string,
  p: Profile,
  predecessor?: { pointer: Pointer; owner: Owner },
): Snapshot {
  const epoch = path.join(root, "admission-epochs", p.epochId);
  canonical(epoch, true);
  const pointer = predecessor
    ? (predecessor.pointer as unknown as Data)
    : read(path.join(root, "isolated-admission-epoch.json"));
  const identity = read(path.join(epoch, "instance.json"));
  const closed = read(path.join(epoch, "closed.json"));
  if (
    closed["epochId"] !== p.epochId ||
    closed["admissionMode"] !== "normal-multidocument" ||
    closed["historicalOutcome"] !== "unknown" ||
    !same(closed["document"], pointer["document"])
  )
    fail(
      "Normal currentstore requires its unchanged normal-admission close proof, never an atomic isolated scope",
    );
  const state = read(path.join(epoch, "queue-state.json"));
  const jobs = object(state["jobs"]),
    job = object(jobs[p.jobId]),
    request = object(job["request"]);
  const clients = read(path.join(root, "clients.json"));
  const owner = predecessor
    ? (predecessor.owner as unknown as Data)
    : read(path.join(root, "broker.lock"));
  const args = request["argv"];
  const rawRpc = p.requestKind === "raw-rpc";
  // Ordinary broker reopen writes only instance/build/config, not a Git SHA.
  // Raw targets must retain the separately recorded physical-ready provenance;
  // never invent or rewrite the predecessor's instance identity.
  if (rawRpc) {
    if (!p.predecessorSource) fail("Raw predecessor source evidence required");
    const source = checked(p.predecessorSource);
    if (source["physicalREADY"] === true) {
      if (source["sourceCommit"] !== p.sourceCommit || source["buildHash"] !== p.buildHash ||
          !same(process(source["sdk"]), process(p.sdk)))
        fail("Raw predecessor source/build/process provenance does not match");
    } else {
      // A published epoch already carries authenticated runtime provenance. Do
      // not manufacture physicalREADY for a later unresolved public request.
      if (!same(pointer["succession"], p.predecessorSource))
        fail("Raw source authority must be the published predecessor's exact succession");
      const lineage = load("./queue-epoch-lineage") as typeof import("../queue-epoch-lineage");
      const proven = lineage.successionAuthority(root, p.predecessorSource);
      lineage.epochLineage(root, pointer as unknown as Pointer);
      if (proven.authority.sourceCommit !== p.sourceCommit || proven.authority.buildHash !== p.buildHash ||
          proven.authority.clientId !== p.epochClientId ||
          !same(process(proven.authority.expectedProcess), process(p.sdk)))
        fail("Published runtime source/build/process provenance does not match the unknown job");
    }
  }
  const payload = rawRpc ? object(request["payload"]) : {};
  const params = rawRpc ? object(payload["params"]) : {};
  const scriptArgs = rawRpc ? object(params["arguments"]) : {};
  const rawRequestMatches =
    request["kind"] === "rpc" &&
    request["phased"] === undefined &&
    args === undefined &&
    (request["buildHash"] === undefined ||
      request["buildHash"] === p.buildHash) &&
    payload["method"] === "tools/call" &&
    params["name"] === "execute_python" &&
    typeof scriptArgs["code"] === "string" &&
    scriptArgs["persistent"] === false &&
    scriptArgs["session_id"] === undefined &&
    // The canonical job hash below binds the payload. Its persisted property
    // order need not match the original transport-byte requestHash journal.
    digest(String(scriptArgs["code"])) === p.sourceHash;
  const commandMatches =
    request["kind"] === "command" &&
    request["phased"] === true &&
    request["buildHash"] === p.buildHash &&
    Array.isArray(args) &&
    !args.some((arg) => typeof arg !== "string") &&
    args[0] === "run" &&
    args.length === 8 &&
    ["--doc", "--doc-id", "--helpers"].every(
      (flag) => args.filter((arg) => arg === flag).length === 1,
    ) &&
    args[args.indexOf("--doc-id") + 1] === p.creationId &&
    args[args.indexOf("--doc") + 1] === p.documentName &&
    args[args.indexOf("--helpers") + 1] === "cad-v1";
  const immutableRequest = { ...request };
  delete immutableRequest["description"];
  const canonicalRequest = (
    load(
      "./dist/core/domain/queue",
    ) as typeof import("../../packages/core/src/domain/queue")
  ).canonical(immutableRequest);
  if (
    pointer["epochId"] !== p.epochId ||
    pointer["root"] !== epoch ||
    pointer["ownerClientId"] !== p.epochClientId ||
    !same(process(pointer["currentInstance"]), process(p.sdk)) ||
    (identity["sourceCommit"] !== p.sourceCommit &&
      !(rawRpc && identity["sourceCommit"] === undefined)) ||
    identity["buildHash"] !== p.buildHash ||
    identity["configHash"] !== p.configHash ||
    !same(process(identity["instance"]), process(p.sdk)) ||
    object(identity["instance"])["version"] !== p.sdk.version ||
    !same(process(owner), p.metadata) ||
    job["id"] !== p.jobId ||
    job["clientId"] !== p.jobClientId ||
    job["requestId"] !== p.jobRequestId ||
    job["state"] !== "needs_reconciliation" ||
    job["hash"] !== p.jobHash ||
    digest(canonicalRequest) !== p.jobHash ||
    !(rawRpc ? rawRequestMatches : commandMatches) ||
    request["clientId"] !== p.jobClientId ||
    request["requestId"] !== p.jobRequestId ||
    request["backend"] !== "mcp" ||
    typeof request["ownerToken"] !== "string" ||
    request["ownerToken"] !== clients[p.jobClientId] ||
    pointer["ownerTokenHash"] !== clients[p.epochClientId] ||
    p.jobClientId === String(pointer["ownerClientId"])
  )
    fail(
      "Unsupported source, document, owner, process, backend or current job profile",
    );
  if (
    ![clients[p.epochClientId], clients[p.jobClientId]].every(
      (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
    )
  )
    fail("Both existing registered owner bindings are required");
  const lifecycle = read(
    path.join(root, `broker-lifecycle-${String(owner["nonce"])}.json`),
  );
  if (
    !same(lifecycle["owner"], owner) ||
    lifecycle["buildHash"] !== p.buildHash ||
    lifecycle["configHash"] !== p.configHash
  )
    fail("Normal predecessor lifecycle does not match the exact owner/runtime");
  if (
    Object.values(jobs).some((value) => {
      const j = object(value);
      return (
        !["succeeded", "failed", "cancelled", "expired"].includes(
          String(j["state"]),
        ) && j["id"] !== p.jobId
      );
    })
  )
    fail("Another unresolved producer/job is outside the fixed profile");
  // The pointer and broker lock are already archived/guarded by the existing
  // successor transaction; their live names intentionally change at handoff.
  const files = [
    "queue-state.json",
    "instance.json",
    `broker-lifecycle-${String(owner["nonce"])}.json`,
  ].map((name) => reference(path.join(root, name)));
  files.push(
    reference(path.join(epoch, "queue-state.json")),
    reference(path.join(epoch, "instance.json")),
  );
  files.push(reference(path.join(epoch, "closed.json")));
  if (rawRpc) files.push(reference(p.predecessorSource!.path));
  const closeReceipt = object(closed["receipt"]);
  const closePath = closeReceipt["path"];
  if (
    typeof closePath !== "string" ||
    !closePath.startsWith(root + path.sep) ||
    path.basename(closePath) !== "result.json" ||
    path.basename(path.dirname(closePath)) !== "isolated-scratch-close" ||
    !Array.isArray(closed["qualificationEvidence"]) ||
    closed["qualificationEvidence"].length !== 5
  )
    fail("Exact normal-admission cleanup output references required");
  const closeDirectory = path.dirname(closePath);
  const closeFiles = [
    closeReceipt,
    ...closed["qualificationEvidence"].map(object),
  ];
  const names = closeFiles.map((entry) =>
    typeof entry["path"] === "string" ? path.basename(entry["path"]) : "",
  );
  if (
    new Set(names).size !== 6 ||
    ![
      "result.json",
      "intent.json",
      "start.json",
      "wire.json",
      "sdk-closed.json",
    ].every((name) => names.includes(name)) ||
    !names.some((name) => /^remote-[a-f0-9-]{36}\.json$/.test(name))
  )
    fail("Complete immutable normal-admission cleanup proof required");
  for (const entry of closeFiles) {
    if (
      typeof entry["path"] !== "string" ||
      path.dirname(entry["path"]) !== closeDirectory ||
      typeof entry["sha256"] !== "string"
    )
      fail("Normal-admission proof escaped its output-only namespace");
    const ref = { path: entry["path"], sha256: entry["sha256"] };
    checked(ref);
    files.push(ref);
  }
  const producers: Process[] = [process(owner)];
  const sealedRequests: Snapshot["sealedRequests"] = [];
  for (const id of Object.keys(jobs).sort()) {
    if (!/^[a-f0-9-]{36}$/.test(id)) fail("Noncanonical job namespace");
    const candidate = object(jobs[id]);
    // A raw RPC cancelled/expired before starting has no worker or output dir.
    // Retain its ledger entry; never infer absence for any started producer.
    if (
      rawRpc &&
      ["cancelled", "expired"].includes(String(candidate["state"])) &&
      candidate["startedAt"] == null &&
      candidate["dispatch"] == null &&
      !fs.existsSync(path.join(root, "jobs", id))
    )
      continue;
    const dir = canonical(path.join(root, "jobs", id), true);
    if (
      ((!rawRpc && id === p.jobId) ||
        fs.existsSync(path.join(dir, "worker-start.json"))) &&
      !fs.existsSync(path.join(dir, "worker-identity.json"))
    )
      fail(
        "A dispatched producer has no immutable worker identity; absence cannot be inferred",
      );
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      if (name === "request.json") {
        canonical(file);
        const s = fs.lstatSync(file);
        sealedRequests.push({
          path: file,
          dev: s.dev,
          ino: s.ino,
          size: s.size,
          mtimeMs: s.mtimeMs,
          ctimeMs: s.ctimeMs,
        });
      } else {
        if (
          rawRpc &&
          name === "stages" &&
          id !== p.jobId &&
          ["succeeded", "failed", "cancelled", "expired"].includes(
            String(candidate["state"]),
          )
        ) {
          canonical(file, true);
          const entries = fs.readdirSync(file).sort();
          if (
            entries.length > 10_000 ||
            entries.some(
              (entry, index) =>
                entry !== String(index).padStart(8, "0") + ".json",
            )
          )
            fail("Unsupported retained stage journal namespace");
          for (const entry of entries)
            files.push(reference(path.join(file, entry)));
          continue;
        }
        // Known output-only records; reject unknown namespaces instead of
        // walking or copying arbitrary credential/user files.
        if (
          !/^(?:(?:rpc|remote|received-response)-[a-f0-9-]{36}|(?:preflight|postflight)(?:-[a-f0-9-]{36}\.receipt|-result|-start)?|dispatch-failure-[a-f0-9-]{36}|worker-(?:identity|start|result)|outcome|rpc-result)\.json$/.test(
            name,
          )
        )
          fail("Unsupported retained file in normal currentstore");
        files.push(reference(file));
        if (name === "worker-identity.json")
          producers.push(process(read(file)));
      }
    }
  }
  const rpcFile = path.join(root, "jobs", p.jobId, `rpc-${p.rpcId}.json`);
  const rpc = read(rpcFile),
    binding = object(rpc["binding"]);
  if (rawRpc) {
    if (
      fs.existsSync(path.join(root, "jobs", p.jobId, "worker-start.json")) ||
      fs.existsSync(path.join(root, "jobs", p.jobId, "worker-identity.json")) ||
      rpc["method"] !== "tools/call" ||
      object(rpc["request"])["id"] !== payload["id"] ||
      object(rpc["request"])["method"] !== payload["method"] ||
      object(rpc["wireRequest"])["id"] !== "fmcad:" + p.rpcId ||
      object(rpc["wireRequest"])["method"] !== payload["method"] ||
      !rawDocumentInventory(root, p, rpc).some(
        (doc) => object(doc)["id"] === p.creationId,
      )
    )
      fail(
        "Raw RPC must retain its actual broker-only producer and observed document binding",
      );
  }
  if (
    rpc["terminal"] !== false ||
    binding["jobId"] !== p.jobId ||
    binding["rpcId"] !== p.rpcId ||
    binding["requestHash"] !== p.requestHash ||
    binding["sourceHash"] !== p.sourceHash ||
    binding["buildHash"] !== p.buildHash ||
    !same(process(rpc["instance"]), process(p.sdk))
  )
    fail("Original unknown RPC binding changed");
  return {
    files,
    sealedRequests,
    producers,
    epochOwnerTokenHash: String(clients[p.epochClientId]),
    jobOwnerTokenHash: String(request["ownerToken"]),
  };
}
function publish(file: string, value: unknown): Reference {
  const directory = path.dirname(file);
  let ancestor = directory;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  canonical(ancestor, true);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  canonical(directory, true);
  (
    load(
      "./queue-atomic-migration-files",
    ) as typeof import("../../packages/node-adapters/src/persistence/migration-files")
  ).exclusive(file, value);
  return reference(file);
}
/** SDK0 public owner authorizer. The caller supplies its already sealed client
 * credentials in memory through the existing Client API. No credential file is
 * read/copied and no raw token is journalled or returned. */
export function authorizeNormalCurrentStore(
  client: Client,
  requestId: string,
  target: Reference,
): Reference {
  const p = profile(target);
  const ownerHash = authenticateOwner(client, p.jobClientId);
  const scope = snapshot(client.dir, p);
  if (
    requestId === p.jobRequestId ||
    client.auth.clientId !== p.jobClientId ||
    ownerHash !== scope.jobOwnerTokenHash
  )
    fail(
      "Only the authentic original job client and a new request may authorize normal cold succession",
    );
  const file = path.join(
    journal(client.dir, requestId),
    "job-owner-authorization.json",
  );
  const value: Authorization = {
    version: 1,
    kind: "normal-currentstore-job-owner-authorization",
    requestId,
    target,
    profile: p,
    snapshot: scope,
  };
  if (fs.existsSync(file)) {
    if (!same(read(file), value))
      fail(
        "Existing normal authorization changed; do not retarget or replace it",
      );
    return reference(file);
  }
  return publish(file, value);
}
function authorization(
  root: string,
  requestId: string,
  entry: Reference,
  predecessor?: { pointer: Pointer; owner: Owner },
): Authorization {
  const value = checked(
    entry,
    path.join(journal(root, requestId), "job-owner-authorization.json"),
  ) as unknown as Authorization;
  if (
    value.version !== 1 ||
    value.kind !== "normal-currentstore-job-owner-authorization" ||
    value.requestId !== requestId ||
    !same(value.profile, profile(value.target)) ||
    !same(value.snapshot, snapshot(root, value.profile, predecessor))
  )
    fail("Owner authorization or preserved currentstore changed");
  return value;
}
function deathBindings(root: string, value: Authorization, entry: Reference) {
  const p = value.profile;
  return {
    jobAuthorization: entry,
    originalRpc: reference(
      path.join(root, "jobs", p.jobId, `rpc-${p.rpcId}.json`),
    ),
    predecessorState: reference(
      path.join(root, "admission-epochs", p.epochId, "queue-state.json"),
    ),
  };
}
function metadataClaimFile(root: string, producer: Process): string {
  return path.join(
    root,
    "normal-metadata-retirements",
    digest(JSON.stringify(process(producer))) + ".json",
  );
}
function metadataClaim(
  root: string,
  requestId: string,
  entry: Reference,
  producer: Process,
): Reference | null {
  const file = metadataClaimFile(root, producer);
  if (!fs.existsSync(file)) return null;
  const value = read(file),
    binding = object(value["binding"]);
  if (value["kind"] !== "normal-metadata-producer-effect-authority")
    fail("Invalid normal metadata producer authority");
  if (
    binding["requestId"] !== requestId ||
    !same(binding["jobAuthorization"], entry)
  )
    fail(
      "The original normal request owns this producer; never retarget or replay an uncertain signal",
    );
  return reference(file);
}
/** Narrow normal-owner composition over the existing qualified pidfd kernel.
 * Preview performs OS reads only. An apply intent is exclusive: uncertain
 * effects are never retried, even if the caller loses the reply. */
export function retireNormalMetadataProducer(
  client: Client,
  requestId: string,
  jobAuthorization: Reference,
  sdkDeathProof: Reference,
  runtime: string,
  apply = false,
  ports: NormalMetadataRetirementPorts = defaultRetirementPorts,
): Reference | { pending: true; noSignalReplay: true; sdkRequestsSent: 0 } {
  const sealed = checked(
    jobAuthorization,
    path.join(journal(client.dir, requestId), "job-owner-authorization.json"),
  ) as unknown as Authorization;
  authenticateOwner(client, profile(sealed.target).epochClientId);
  const value = authorization(client.dir, requestId, jobAuthorization),
    p = value.profile;
  canonical(runtime, true);
  if (ports.buildHash(runtime) !== p.buildHash)
    fail(
      "Only the exact qualified predecessor runtime may retire its normal metadata owner",
    );
  checked(sdkDeathProof);
  (
    load("./queue-epoch-successor") as typeof import("./queue-epoch-successor")
  ).verifySdkProcessDeathProof(
    sdkDeathProof.path,
    p.sdk,
    deathBindings(client.dir, value, jobAuthorization),
  );
  if (object(read(sdkDeathProof.path)["before"])["version"] !== p.sdk.version)
    fail("Original SDK death proof version changed");
  const sdk = ports.sdkProcess(p.sdk),
    at = Date.parse(sdk.observedAtUtc);
  if (
    sdk.state !== "absent" ||
    sdk.pid !== p.sdk.pid ||
    sdk.errorId !== absentError ||
    !Number.isFinite(at) ||
    at > Date.now() ||
    Date.now() - at > 30000 ||
    value.snapshot.producers
      .filter((producer) => !same(producer, p.metadata))
      .some((producer) => !ports.producerAbsent(producer))
  )
    fail(
      "Authentic old SDK death and all other producers' absence are required before metadata retirement",
    );
  const owner = read(path.join(client.dir, "broker.lock")) as unknown as Owner;
  const directory = journal(client.dir, requestId),
    previewFile = path.join(directory, "metadata-retirement-preview.json"),
    effectFile = path.join(directory, "metadata-retirement-effect-start.json"),
    resultFile = path.join(directory, "metadata-retired.json");
  const binding = {
    requestId,
    jobAuthorization,
    sdkDeathProof,
    runtime,
    owner,
  };
  const priorClaim = metadataClaim(
    client.dir,
    requestId,
    jobAuthorization,
    p.metadata,
  );
  if (priorClaim && !same(checked(priorClaim)["binding"], binding))
    fail("Original producer runtime/death proof must not be retargeted");
  const refs = [
    ...value.snapshot.files,
    value.target,
    jobAuthorization,
    sdkDeathProof,
  ];
  if (fs.existsSync(effectFile)) {
    const effect = read(effectFile);
    if (
      !priorClaim ||
      !same(effect["claim"], priorClaim) ||
      !same(effect["binding"], binding)
    )
      fail(
        "Original normal metadata retirement intent changed; no signal replay",
      );
    if (fs.existsSync(resultFile)) {
      const result = read(resultFile);
      if (!same(result["binding"], binding) || result["retired"] !== true)
        fail("Original normal metadata retirement result changed");
      return reference(resultFile);
    }
    return { pending: true, noSignalReplay: true, sdkRequestsSent: 0 };
  }
  if (!apply) {
    if (fs.existsSync(previewFile)) {
      if (!same(read(previewFile)["binding"], binding))
        fail("Original metadata preview cannot be retargeted");
      return reference(previewFile);
    }
    const preview = ports.process(owner, runtime, refs, false, client.dir);
    if (
      preview.retired ||
      !same(process(preview.process), p.metadata) ||
      !preview.interpreter
    )
      fail("Exact non-mutating metadata process/interpreter preview required");
    return publish(previewFile, {
      kind: "normal-metadata-retirement-preview",
      binding,
      preview,
      sdkRequestsSent: 0,
    });
  }
  const previewReference = reference(previewFile);
  const preview = checked(previewReference);
  if (
    !same(preview["binding"], binding) ||
    preview["kind"] !== "normal-metadata-retirement-preview"
  )
    fail("Original normal metadata process preview required");
  const proof = preview["preview"] as Sdk1MetadataWorkerProcessResult;
  if (
    !proof.process ||
    !proof.interpreter ||
    !same(process(proof.process), p.metadata)
  )
    fail("Exact kernel process proof and pinned interpreter required");
  if (!priorClaim) {
    try {
      publish(metadataClaimFile(client.dir, p.metadata), {
        kind: "normal-metadata-producer-effect-authority",
        binding,
      });
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "EEXIST"
      )
        throw error;
    }
  }
  const claim = metadataClaim(
    client.dir,
    requestId,
    jobAuthorization,
    p.metadata,
  );
  if (!claim || !same(checked(claim)["binding"], binding))
    fail("A concurrent different request owns normal metadata retirement");
  const effect = publish(effectFile, {
    kind: "normal-metadata-retirement-effect-start",
    binding,
    preview: previewReference,
    claim,
    sdkRequestsSent: 0,
  });
  try {
    const result = ports.process(
      {
        ...owner,
        processProof: proof.process,
        interpreterProof: proof.interpreter,
      },
      runtime,
      [...refs, previewReference, claim, effect],
      true,
      client.dir,
    );
    if (
      !result.retired ||
      !same(result.process, proof.process) ||
      !ports.producerAbsent(p.metadata)
    )
      fail("Metadata retirement is not kernel-proven; never repeat the signal");
    return publish(resultFile, {
      kind: "normal-metadata-producer-retired",
      binding,
      retired: true,
      process: result.process,
      sdkRequestsSent: 0,
      originalExecutionOutcome: "unknown",
    });
  } catch {
    return { pending: true, noSignalReplay: true, sdkRequestsSent: 0 };
  }
}
/** A read-only OS receipt recorded AFTER all old producers are absent and
 * BEFORE the selected successor SDK starts. This function never signals them. */
export function recordNormalProducerRetirement(
  client: Client,
  requestId: string,
  entry: Reference,
  ports: NormalColdPorts = defaultPorts,
): Reference {
  const sealed = checked(
    entry,
    path.join(journal(client.dir, requestId), "job-owner-authorization.json"),
  ) as unknown as Authorization;
  const expected = profile(sealed.target);
  const ownerHash = authenticateOwner(client, expected.epochClientId);
  const value = authorization(client.dir, requestId, entry),
    p = value.profile;
  if (
    client.auth.clientId !== p.epochClientId ||
    ownerHash !== value.snapshot.epochOwnerTokenHash
  )
    fail("Original epoch owner authorization required");
  const sdk = ports.sdkProcess(p.sdk);
  const sdkAt = Date.parse(sdk.observedAtUtc);
  if (
    sdk.state !== "absent" ||
    sdk.pid !== p.sdk.pid ||
    sdk.errorId !== absentError ||
    !Number.isFinite(sdkAt) ||
    sdkAt > Date.now() ||
    Date.now() - sdkAt > 30000 ||
    value.snapshot.producers.some((producer) => !ports.producerAbsent(producer))
  )
    fail(
      "Old SDK or an old producer is not proven absent; PID reuse and uncertain OS queries refuse succession",
    );
  return publish(
    path.join(journal(client.dir, requestId), "producers-retired.json"),
    {
      version: 1,
      kind: "normal-currentstore-producers-retired",
      requestId,
      authorization: entry,
      producers: value.snapshot.producers,
      observedAtUtc: new Date().toISOString(),
      sdkAbsent: sdk,
      metadataRetirement: metadataClaim(
        client.dir,
        requestId,
        entry,
        p.metadata,
      ),
    },
  );
}
export function inspectNormalCurrentStore(
  root: string,
  approval: Approval,
  pointer: Pointer,
  ports: NormalColdPorts = defaultPorts,
  predecessorOwner?: Owner,
): Authorization {
  const normal = approval.normalCurrentStore;
  if (!normal || normal.kind !== "normal-currentstore-v1")
    fail("A discriminated normal-currentstore approval is required");
  const retry = approval.priorNormalCurrentFactsRetry
    ? inspectNormalCurrentFactsRetry(
        root,
        approval.priorNormalCurrentFactsRetry,
        {
          requestId: approval.requestId,
          sourceCommit: approval.sourceCommit,
          buildHash: approval.buildHash,
          qualification: approval.qualification,
          expectedProcess: approval.expectedProcess,
        },
        ports,
      )
    : null;
  if (
    retry &&
    (!same(normal, retry.originalNormalStore) ||
      approval.candidateRoot !== retry.candidateRoot)
  )
    fail(
      "Normal retry approval must retain its original store and exact candidate root",
    );
  const requestId = retry?.baseRequestId ?? approval.requestId,
    originalOwner = retry
      ? normalRetryOwner(
          previousNormalRetryAuthority(
            root,
            retry.baseRequestId,
            retry.previousAuthority,
          ).authority["previousOwner"],
        )
      : predecessorOwner,
    predecessor = originalOwner ? { pointer, owner: originalOwner } : undefined;
  const value = authorization(
      root,
      requestId,
      normal.jobAuthorization,
      predecessor,
    ),
    p = value.profile;
  if (
    pointer.epochId !== p.epochId ||
    approval.clientId !== p.epochClientId ||
    approval.previousBuildHash !== p.buildHash
  )
    fail("Normal approval cannot be mixed with a historical atomic successor");
  const retirement = checked(
    normal.producerRetirement,
    path.join(journal(root, requestId), "producers-retired.json"),
  );
  const claim = metadataClaim(
    root,
    requestId,
    normal.jobAuthorization,
    p.metadata,
  );
  if (
    !same(retirement["metadataRetirement"] ?? null, claim) ||
    (claim &&
      !same(
        object(checked(claim)["binding"])["sdkDeathProof"],
        normal.deathProof,
      ))
  )
    fail(
      "Normal producer receipt must preserve its original metadata effect authority",
    );
  const retiredAt = Date.parse(String(retirement["observedAtUtc"]));
  const retiredSdk = object(retirement["sdkAbsent"]);
  const absentAt = Date.parse(String(retiredSdk["observedAtUtc"]));
  if (!/^\d{17,18}$/.test(approval.expectedProcess.birth))
    fail(
      "Selected SDK requires a Windows FILETIME birth, not a Linux PID observation",
    );
  const newBirthMs = Number(
    (BigInt(approval.expectedProcess.birth) - 116444736000000000n) / 10000n,
  );
  if (
    retirement["version"] !== 1 ||
    retirement["kind"] !== "normal-currentstore-producers-retired" ||
    retirement["requestId"] !== requestId ||
    !same(retirement["authorization"], normal.jobAuthorization) ||
    !same(retirement["producers"], value.snapshot.producers) ||
    !Number.isFinite(retiredAt) ||
    retiredSdk["state"] !== "absent" ||
    retiredSdk["pid"] !== p.sdk.pid ||
    retiredSdk["errorId"] !== absentError ||
    !Number.isFinite(absentAt) ||
    absentAt > retiredAt ||
    retiredAt - absentAt > 30000 ||
    retiredAt > Date.now() ||
    newBirthMs <= retiredAt ||
    approval.expectedProcess.pid === p.sdk.pid ||
    value.snapshot.producers.some((producer) => !ports.producerAbsent(producer))
  )
    fail(
      "The selected new SDK must start only after all exact old producers retired",
    );
  const bindings = deathBindings(root, value, normal.jobAuthorization);
  checked(normal.deathProof);
  (
    load("./queue-epoch-successor") as typeof import("./queue-epoch-successor")
  ).verifySdkProcessDeathProof(normal.deathProof.path, p.sdk, bindings);
  const death = read(normal.deathProof.path);
  if (object(death["before"])["version"] !== p.sdk.version)
    fail("SDK death proof version differs from the sealed original instance");
  if (Date.parse(String(object(death["after"])["observedAtUtc"])) > retiredAt)
    fail("SDK death must precede producer retirement and new SDK startup");
  const old = ports.sdkProcess(p.sdk),
    selected = ports.sdkProcess(approval.expectedProcess);
  if (
    old.state !== "absent" ||
    old.pid !== p.sdk.pid ||
    old.errorId !== absentError ||
    selected.state !== "present" ||
    selected.pid !== approval.expectedProcess.pid ||
    selected.birth !== approval.expectedProcess.birth ||
    [old, selected].some(
      (o) =>
        !Number.isFinite(Date.parse(o.observedAtUtc)) ||
        Date.parse(o.observedAtUtc) > Date.now() ||
        Date.now() - Date.parse(o.observedAtUtc) > 30000,
    )
  )
    fail("Fresh exact old-PID absence and selected new-SDK birth are required");
  return value;
}
/** Revalidate the sealed currentstore on claim, observation, and publication.
 * The existing authority has already verified the archived pointer/owner. */
export function assertNormalCurrentPredecessor(
  root: string,
  checkedPredecessor: Checked,
  ports: NormalColdPorts = defaultPorts,
): void {
  const a = checkedPredecessor.authority;
  const normal = a["normalCurrentStore"] as
    NormalCurrentStoreApproval | undefined;
  if (!normal) return;
  if (normal.kind !== "normal-currentstore-v1")
    fail("Invalid normal successor authority discriminator");
  inspectNormalCurrentStore(
    root,
    {
      purpose: "dead-normal-currentstore-successor-v1",
      requestId: a.requestId,
      clientId: a.clientId,
      previousBuildHash: a.previousBuildHash,
      expectedProcess: a.expectedProcess,
      sourceCommit: a.sourceCommit,
      buildHash: a.buildHash,
      candidateRoot: a.candidateRoot,
      qualification: a.qualification,
      normalCurrentStore: normal,
      priorNormalCurrentFactsRetry: a["priorNormalCurrentFactsRetry"],
    } as Approval,
    checkedPredecessor.pointer,
    ports,
    a.previousOwner,
  );
}
function coldDefaultScope(binding: AuditBinding) {
  if (!binding["normalCurrentStore"]) return null;
  const normal = binding["normalCurrentStore"] as NormalCurrentStoreApproval;
  const target = normalCurrentTarget(normal);
  if (target.requestKind !== "raw-rpc" || !["Bez nazwy", "Untitled"].includes(target.documentName)) return null;
  const root = path.dirname(path.dirname(path.dirname(normal.jobAuthorization.path)));
  const active = object(read(path.join(root, "active-epoch-succession.json")));
  const entry = exactReference(active["authority"]);
  if (entry.sha256 !== binding["successorAuthorityHash"])
    fail("Cold default identity requires the exact active normal authority");
  const lineage = load("./queue-epoch-lineage") as typeof import("../queue-epoch-lineage");
  const proven = lineage.successionAuthority(root, entry);
  const a = proven.authority;
  if (!same(a["normalCurrentStore"], normal) || a["priorNormalCurrentFactsRetry"] !== undefined ||
      a.clientId !== binding["clientId"] || !same(process(a.expectedProcess), process(binding["expectedProcess"])) ||
      typeof a["candidateRoot"] !== "string" || typeof a["configHash"] !== "string" || typeof a["nonce"] !== "string")
    fail("Cold default identity is not transferable to another owner, process or normal scope");
  normalRetryOwner(a["previousOwner"]);
  // This retains both authentic old SDK death and all-producers-retired/new-birth
  // fences. A live SDK or a new document alone is never quarantine authority.
  // The public lineage type omits the private broker fields validated above.
  assertNormalCurrentPredecessor(root, proven as unknown as Checked);
  return { root, baseRequestId: a.requestId, originalNormalStore: normal, candidateRoot: a["candidateRoot"] };
}

export function prepareNormalCurrentFacts(
  installation: string,
  identity: unknown,
  binding: AuditBinding,
): AuditReader {
  const i = object(identity),
    document = object(i["resolvedIdentity"]);
  if (
    i["kind"] !== "normal-currentstore-v1" ||
    typeof document["creationId"] !== "string" ||
    typeof document["name"] !== "string" ||
    binding["purpose"] !== "normal-currentstore-current-facts-v1"
  )
    fail(
      "Normal current-facts reader cannot adopt an atomic or foreign identity",
    );
  const retry = normalCurrentFactsRetryBinding(binding);
  const sourceFile = path.join(
    installation,
    "runtime/python/recovery/normal_currentstore.py",
  );
  canonical(sourceFile);
  const source = fs.readFileSync(sourceFile, "utf8");
  // Frozen two-argument predecessor readers must be reproduced byte-for-byte.
  const cold = !retry && source.includes("allow_new_unsaved_default") ? coldDefaultScope(binding) : null;
  const identityScope = retry || cold;
  const allowNewUnsavedDefault = identityScope
    ? allowsNewUnsavedDefault(
        retry ? normalCurrentFactsRetryRoot(binding) : cold!.root,
        identityScope.baseRequestId,
        identityScope.originalNormalStore,
        document["creationId"],
        document["name"],
      )
    : false;
  if (identityScope && identityScope.candidateRoot !== installation)
    fail("The normal identity candidate must use its exact qualified runtime root");
  const artifact = (
    load(
      "./dist/python/artifact",
    ) as typeof import("../../packages/node-adapters/src/python/artifact")
  ).preparePythonArtifact(
    [
      {
        id: "normal-currentstore-current-facts",
        filename: "runtime/python/recovery/normal_currentstore.py",
        role: "runtime",
        source,
      },
      {
        id: "wrapper",
        filename: "<fmcad-normal-currentstore>",
        role: "wrapper",
        source: `def run(_context: str) -> None:\n    print('FMCAD_RESULT ' + _nc_json.dumps(normal_currentstore_facts(${JSON.stringify(document["creationId"])}, ${JSON.stringify(document["name"])}${allowNewUnsavedDefault ? ", True" : ""}), allow_nan=False))\n`,
      },
    ],
    {
      request: { identity },
      context: { kind: "normal-currentstore-current-facts-v1", ...binding },
    },
  );
  return { artifact, sourceFile, sourceSha256: digest(source) };
}
export function parseNormalCurrentFacts(
  reply: unknown,
  identity: unknown,
  binding?: AuditBinding,
): Data {
  const text = (
    load(
      "./dist/core/application/cad/recovery-audit",
    ) as typeof import("../../packages/core/src/application/cad/recovery-audit")
  ).auditOutputText(reply);
  const rows = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("FMCAD_RESULT "));
  const value = object(
    JSON.parse(rows[0]!.slice("FMCAD_RESULT ".length)) as unknown,
  );
  return validateNormalCurrentFacts(value, identity, binding);
}
export function validateNormalCurrentFacts(
  input: unknown,
  identity: unknown,
  binding?: AuditBinding,
): Data {
  const value = object(input);
  const doc = object(object(identity)["resolvedIdentity"]),
    retry = binding ? normalCurrentFactsRetryBinding(binding) : null,
    cold = !retry && binding && value["identityPolicy"] === "new-unsaved-default-v1" ? coldDefaultScope(binding) : null,
    identityScope = retry || cold,
    allowNewUnsavedDefault = identityScope
      ? allowsNewUnsavedDefault(
          retry ? normalCurrentFactsRetryRoot(binding) : cold!.root,
          identityScope.baseRequestId,
          identityScope.originalNormalStore,
          doc["creationId"],
          doc["name"],
        )
      : false;
  if (
    value["kind"] !== "normal-currentstore-current-facts-v1" ||
    value["originalDocumentCreationId"] !== doc["creationId"] ||
    value["originalDocumentName"] !== doc["name"] ||
    value["originalDocumentPresent"] !== false ||
    value["identityPolicy"] !==
      (allowNewUnsavedDefault
        ? "new-unsaved-default-v1"
        : "creation-or-name-v1") ||
    value["activeCommand"] !== "SelectCommand" ||
    value["historicalOutcome"] !== "unknown" ||
    value["modelValidation"] !== "not_performed" ||
    !Array.isArray(value["documents"]) ||
    value["documents"].some((entry: unknown) => {
      const row = object(entry);
      return (
        typeof row["creationId"] !== "string" ||
        typeof row["name"] !== "string" ||
        row["creationId"] === doc["creationId"] ||
        (row["name"] === doc["name"] &&
          !(
            allowNewUnsavedDefault &&
            row["creationId"] !== doc["creationId"] &&
            row["fileId"] === null &&
            row["isSaved"] === false &&
            row["isModified"] === false
          ))
      );
    })
  )
    fail(
      "Selected normal successor must be idle with the original fixture absent, not adopted or mutated",
    );
  return value;
}
export function normalCurrentTarget(
  normal: NormalCurrentStoreApproval,
): Profile {
  const value = checked(normal.jobAuthorization) as unknown as Authorization;
  if (!same(value.profile, profile(value.target)))
    fail("Sealed normal successor target changed");
  return value.profile;
}

function exactReference(value: unknown): Reference {
  const entry = object(value);
  if (
    Object.keys(entry).sort().join() !== "path,sha256" ||
    typeof entry["path"] !== "string" ||
    typeof entry["sha256"] !== "string" ||
    !/^[a-f0-9]{64}$/.test(entry["sha256"])
  )
    fail("Exact sealed normal-current-facts reference required");
  return { path: entry["path"], sha256: entry["sha256"] };
}

function normalRetryOwner(value: unknown): Owner {
  const entry = object(value),
    p = process(entry);
  if (
    Object.keys(entry).sort().join() !== "birth,nonce,pid,protocol" ||
    typeof entry["nonce"] !== "string" ||
    !entry["nonce"] ||
    entry["protocol"] !== 2
  )
    fail("Exact current normal metadata owner required");
  return { ...p, nonce: entry["nonce"], protocol: 2 };
}

function retryCandidate(
  value: unknown,
  includeRoot: boolean,
): NormalCurrentFactsRetryCandidateBinding & { candidateRoot?: string } {
  const entry = object(value),
    keys = [
      "requestId",
      ...(includeRoot ? ["candidateRoot"] : []),
      "sourceCommit",
      "buildHash",
      "qualification",
      "expectedProcess",
    ];
  if (
    Object.keys(entry).sort().join() !== keys.sort().join() ||
    typeof entry["requestId"] !== "string" ||
    !entry["requestId"] ||
    entry["requestId"].length > 140 ||
    typeof entry["sourceCommit"] !== "string" ||
    !/^[a-f0-9]{40}$/.test(entry["sourceCommit"]) ||
    typeof entry["buildHash"] !== "string" ||
    !/^[a-f0-9]{64}$/.test(entry["buildHash"])
  )
    fail("Exact fresh normal read candidate is required");
  const expected = object(entry["expectedProcess"]),
    selected = process(expected),
    qualification = exactReference(entry["qualification"]),
    q = checked(qualification);
  if (
    Object.keys(expected).sort().join() !== "birth,pid" ||
    !/^\d{17,18}$/.test(selected.birth) ||
    (includeRoot && typeof entry["candidateRoot"] !== "string") ||
    q["passed"] !== true ||
    q["productionAdmission"] !== true ||
    q["liveSdkRequestsSent"] !== 0 ||
    q["sourceCommit"] !== entry["sourceCommit"] ||
    q["buildHash"] !== entry["buildHash"] ||
    q["publicDirectAccessRefused"] !== true ||
    q["deadEpochSuccessorReadQualified"] !== true ||
    q["deadEpochSuccessorRestoreQualified"] !== true ||
    q["normalCurrentFactsRetryQualified"] !== true ||
    q["normalCurrentStoreSuccessorQualified"] !== true
  )
    fail("Fresh normal read candidate lacks its exact passing qualification");
  const candidateRoot = includeRoot
    ? canonical(String(entry["candidateRoot"]), true)
    : undefined;
  return {
    requestId: entry["requestId"],
    sourceCommit: entry["sourceCommit"],
    buildHash: entry["buildHash"],
    qualification,
    expectedProcess: selected,
    ...(candidateRoot ? { candidateRoot } : {}),
  };
}

function retryPath(root: string, previousAuthority: Reference): string {
  return path.join(
    root,
    "normal-currentfacts-retries",
    previousAuthority.sha256,
    "authorization.json",
  );
}

function retryRoot(entry: Reference): string {
  const parent = path.dirname(entry.path),
    collection = path.dirname(parent),
    root = path.dirname(collection);
  if (
    path.basename(collection) !== "normal-currentfacts-retries" ||
    path.basename(entry.path) !== "authorization.json"
  )
    fail("Normal read retry reference escaped its sealed journal namespace");
  canonical(root, true);
  return root;
}

function previousNormalRetryAuthority(
  root: string,
  baseRequestId: string,
  entry: Reference,
) {
  const expected = path.join(
      root,
      "epoch-successions",
      digest(baseRequestId),
      "authority.json",
    ),
    authority = checked(entry, expected);
  const normal = object(authority["normalCurrentStore"]);
  if (
    authority["kind"] !== "owner-authenticated-dead-epoch-successor" ||
    authority["requestId"] !== baseRequestId ||
    typeof authority["clientId"] !== "string" ||
    typeof authority["ownerTokenHash"] !== "string" ||
    !/^[a-f0-9]{64}$/.test(authority["ownerTokenHash"]) ||
    typeof authority["sourceCommit"] !== "string" ||
    !/^[a-f0-9]{40}$/.test(authority["sourceCommit"]) ||
    typeof authority["buildHash"] !== "string" ||
    !/^[a-f0-9]{64}$/.test(authority["buildHash"]) ||
    typeof authority["candidateRoot"] !== "string" ||
    Object.hasOwn(authority, "priorNormalCurrentFactsRetry") ||
    normal["kind"] !== "normal-currentstore-v1"
  )
    fail(
      "Only one initial normal-currentstore successor authority is retryable",
    );
  canonical(String(authority["candidateRoot"]), true);
  process(authority["expectedProcess"]);
  normalRetryOwner(authority["previousOwner"]);
  return { authority, normal: normal as unknown as NormalCurrentStoreApproval };
}

function retryOriginalNormalStore(
  root: string,
  baseRequestId: string,
  normal: NormalCurrentStoreApproval,
) {
  if (normal.kind !== "normal-currentstore-v1")
    fail("Original normal-currentstore authority is required");
  const authorizationFile = path.join(
      journal(root, baseRequestId),
      "job-owner-authorization.json",
    ),
    authorizationValue = checked(
      normal.jobAuthorization,
      authorizationFile,
    ) as unknown as Authorization,
    p = profile(authorizationValue.target);
  if (
    authorizationValue.kind !== "normal-currentstore-job-owner-authorization" ||
    authorizationValue.requestId !== baseRequestId ||
    !same(authorizationValue.profile, p) ||
    !Array.isArray(authorizationValue.snapshot.files)
  )
    fail("Original normal job authorization changed");
  const rawRpcFile = path.join(root, "jobs", p.jobId, `rpc-${p.rpcId}.json`),
    rawRpcReference = authorizationValue.snapshot.files.find(
      (entry) => entry.path === rawRpcFile,
    );
  if (!rawRpcReference)
    fail("Original normal RPC document identity is not sealed");
  const rawRpc = checked(rawRpcReference, rawRpcFile);
  return { authorizationValue, profile: p, rawRpc };
}

function retryIdentity(p: Profile) {
  return {
    kind: normalColdProfile.kind,
    resolvedIdentity: { creationId: p.creationId, name: p.documentName },
  };
}

function allowsNewUnsavedDefault(
  root: string,
  baseRequestId: string,
  normal: NormalCurrentStoreApproval,
  creationId: unknown,
  documentName: unknown,
): boolean {
  const p = normalCurrentTarget(normal);
  if (
    creationId !== p.creationId ||
    documentName !== p.documentName ||
    p.requestKind !== "raw-rpc" ||
    !["Bez nazwy", "Untitled"].includes(p.documentName)
  )
    return false;
  const { rawRpc } = retryOriginalNormalStore(root, baseRequestId, normal),
    documents = rawDocumentInventory(root, p, rawRpc);
  if (!Array.isArray(documents))
    fail("The original raw RPC has no pinned document identity row");
  const matches = documents.filter(
    (entry) => object(entry)["id"] === p.creationId,
  );
  if (
    matches.length !== 1 ||
    object(matches[0])["fileId"] !== null ||
    object(matches[0])["isSaved"] !== false ||
    object(matches[0])["isModified"] !== false
  )
    fail(
      "Only the exact original clean unsaved default document may be excluded by name",
    );
  return true;
}

function validateFailedNormalRead(
  root: string,
  baseRequestId: string,
  previousAuthority: Reference,
  normal: NormalCurrentStoreApproval,
  physicalResult: Reference,
  validationFailure: Reference,
) {
  const { authority } = previousNormalRetryAuthority(
      root,
      baseRequestId,
      previousAuthority,
    ),
    { authorizationValue, profile: p } = retryOriginalNormalStore(
      root,
      baseRequestId,
      normal,
    ),
    directory = path.join(
      root,
      "epoch-successions",
      digest(baseRequestId),
      "dead-epoch-current-observation",
    ),
    intentFile = path.join(directory, "intent.json"),
    startFile = path.join(directory, "start.json"),
    wireFile = path.join(directory, "wire.json"),
    receivedFile = path.join(directory, "received-response.json"),
    resultFile = path.join(directory, "result.json"),
    intent = read(intentFile),
    start = read(startFile),
    wire = read(wireFile),
    received = read(receivedFile),
    result = checked(validationFailure, resultFile),
    physicalBinding = object(start["binding"]),
    physicalPath = start["receipt"],
    physical = checked(physicalResult, String(physicalPath)),
    binding = object(intent["binding"]),
    canonicalBindingHash = (
      load("./dist/core/application/cad/json") as {
        hash(value: unknown): string;
      }
    ).hash(binding),
    identity = retryIdentity(p),
    key = object(intent["key"]),
    outgoing = object(wire["outgoing"]),
    artifact = object(wire["artifact"]),
    pythonCheck = object(start["pythonCheck"]);
  if (
    result["kind"] !== "dead-epoch-current-observation" ||
    result["status"] !== "failed" ||
    result["code"] !== "NORMAL_SUCCESSOR_UNPROVEN" ||
    result["sdkRequestsSent"] !== 1 ||
    result["nativeOutcome"] !== "unknown" ||
    result["modelValidation"] !== "not_performed" ||
    result["rollbackVerification"] !== "not_performed" ||
    result["jobId"] !== p.jobId ||
    result["observationJobId"] !== p.rpcId ||
    result["requestId"] !== baseRequestId + ":observe" ||
    result["clientId"] !== authority["clientId"] ||
    intent["version"] !== 1 ||
    intent["sourceArtifactHash"] !== start["originArtifactHash"] ||
    !same(intent["identity"], identity) ||
    key["jobId"] !== p.jobId ||
    key["observationJobId"] !== p.rpcId ||
    key["requestId"] !== baseRequestId + ":observe" ||
    key["clientId"] !== authority["clientId"] ||
    binding["purpose"] !== "normal-currentstore-current-facts-v1" ||
    binding["clientId"] !== authority["clientId"] ||
    !same(
      process(binding["expectedProcess"]),
      process(authority["expectedProcess"]),
    ) ||
    binding["successorAuthorityHash"] !== previousAuthority.sha256 ||
    !same(binding["normalCurrentStore"], normal) ||
    Object.hasOwn(binding, "priorNormalCurrentFactsRetry") ||
    Object.hasOwn(binding, "normalCurrentFactsRetryCandidate") ||
    !same(start["instance"], binding["expectedProcess"]) ||
    start["receipt"] !== physicalResult.path ||
    physicalBinding["buildHash"] !== authority["buildHash"] ||
    physicalBinding["jobId"] !== p.jobId ||
    physicalBinding["purpose"] !== binding["purpose"] ||
    physicalBinding["auditBindingHash"] !== canonicalBindingHash ||
    !same(
      process(physicalBinding["auditExpectedProcess"]),
      process(binding["expectedProcess"]),
    ) ||
    physicalBinding["pythonOriginHash"] !== intent["sourceArtifactHash"] ||
    pythonCheck["status"] !== "passed" ||
    received["version"] !== 1 ||
    received["status"] !== 200 ||
    received["wireId"] !== outgoing["id"] ||
    typeof received["raw"] !== "string" ||
    received["callerId"] === undefined ||
    outgoing["id"] !== "fmcad:" + String(object(start["binding"])["rpcId"]) ||
    outgoing["jsonrpc"] !== "2.0" ||
    outgoing["method"] !== "tools/call" ||
    physical["terminal"] !== true ||
    physical["outcome"] !== "succeeded" ||
    typeof object(physical["instance"])["version"] !== "string" ||
    !object(physical["instance"])["version"] ||
    object(physical["instance"])["pid"] !==
      process(binding["expectedProcess"]).pid ||
    object(physical["instance"])["birth"] !==
      process(binding["expectedProcess"]).birth ||
    Object.entries(physicalBinding).some(
      ([key, value]) => !same(physical[key], value),
    ) ||
    fs.existsSync(path.join(directory, "response.json")) ||
    fs.existsSync(path.join(path.dirname(directory), "observed-current.json"))
  )
    fail(
      "The previous normal read is not an exact terminal validation failure",
    );

  const params = object(outgoing["params"]),
    argumentsValue = object(params["arguments"]),
    nativeObject = object(argumentsValue["object"]),
    classification = (
      load("./dist/python/admission") as {
        classifyPythonRpc(value: unknown): {
          kind: string;
          official: boolean;
          source: string;
        };
      }
    ).classifyPythonRpc(outgoing),
    context = object(artifact["context"]),
    origin = object(context["origin"]),
    provenance = object(pythonCheck["provenance"]);
  if (
    params["name"] !== "fusion_mcp_execute" ||
    argumentsValue["featureType"] !== "script" ||
    nativeObject["readOnly"] !== true ||
    classification.kind !== "python" ||
    classification.official !== true ||
    classification.source.length === 0 ||
    artifact["artifactHash"] !== provenance["artifactHash"] ||
    artifact["sha256"] !== provenance["wireHash"] ||
    !same(artifact["request"], start["binding"]) ||
    origin["artifactHash"] !== intent["sourceArtifactHash"] ||
    physical["pythonOriginHash"] !== intent["sourceArtifactHash"]
  )
    fail(
      "The previous normal read was not a production-checked read-only SDK call",
    );
  (
    load("./dist/python/context-binding") as {
      bindPythonArtifactManifest(source: string, manifest: unknown): void;
    }
  ).bindPythonArtifactManifest(classification.source, artifact);
  const reader = prepareNormalCurrentFacts(
    String(authority["candidateRoot"]),
    identity,
    binding as AuditBinding,
  );
  if (
    reader.sourceSha256 !== intent["sourceSha256"] ||
    reader.artifact.artifactHash !== intent["sourceArtifactHash"]
  )
    fail("The failed read artifact no longer matches its sealed candidate");

  const reply = object(JSON.parse(received["raw"] as string) as unknown);
  if (
    reply["jsonrpc"] !== "2.0" ||
    reply["id"] !== outgoing["id"] ||
    Object.hasOwn(reply, "error") ||
    !object(reply["result"]) ||
    object(reply["result"])["isError"] === true
  )
    fail("The original transport response was not a successful RPC reply");
  const text = (
      load(
        "./dist/core/application/cad/recovery-audit",
      ) as typeof import("../../packages/core/src/application/cad/recovery-audit")
    ).auditOutputText(reply),
    rows = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("FMCAD_RESULT "));
  if (rows.length !== 1)
    fail("The previous normal read did not return exactly one facts result");
  const facts = object(
      JSON.parse(rows[0]!.slice("FMCAD_RESULT ".length)) as unknown,
    ),
    documents = facts["documents"];
  if (
    Object.keys(facts).sort().join() !==
      "activeCommand,documents,historicalOutcome,kind,modelValidation,originalDocumentCreationId,originalDocumentName,originalDocumentPresent" ||
    facts["kind"] !== "normal-currentstore-current-facts-v1" ||
    facts["originalDocumentCreationId"] !== p.creationId ||
    facts["originalDocumentName"] !== p.documentName ||
    facts["originalDocumentPresent"] !== true ||
    facts["activeCommand"] !== "SelectCommand" ||
    facts["historicalOutcome"] !== "unknown" ||
    facts["modelValidation"] !== "not_performed" ||
    !Array.isArray(documents) ||
    documents.some((entry: unknown) => {
      const row = object(entry);
      return (
        Object.keys(row).sort().join() !== "creationId,name" ||
        typeof row["creationId"] !== "string" ||
        typeof row["name"] !== "string"
      );
    })
  )
    fail(
      "The previous reply does not match the sealed legacy normal-facts refusal",
    );
  return {
    authority,
    authorizationValue,
    profile: p,
    physical,
    result,
    files: [
      reference(intentFile),
      reference(startFile),
      reference(wireFile),
      reference(receivedFile),
    ],
  };
}

function assertRetryQueueSummary(
  input: unknown,
  authority: Data,
  baseRequestId: string,
  currentOwner: Owner,
): Data {
  const summary = object(input),
    control = object(summary["control"]),
    successor = object(summary["deadEpochSuccessor"]),
    expected = process(authority["expectedProcess"]);
  if (
    summary["sourceCommit"] !== authority["sourceCommit"] ||
    summary["buildHash"] !== authority["buildHash"] ||
    summary["stopping"] !== false ||
    summary["paused"] !== false ||
    summary["historicalOutcome"] !== "unknown" ||
    summary["historicalModelValidation"] !== "not_performed" ||
    control["instanceId"] !== currentOwner.nonce ||
    control["buildHash"] !== authority["buildHash"] ||
    control["activeOperations"] !== 0 ||
    !same(control["activeIds"], []) ||
    control["phase"] !== "RECOVERY_BLOCKED" ||
    control["unresolved"] !== true ||
    successor["requestId"] !== baseRequestId ||
    successor["currentFactsAvailable"] !== false ||
    successor["observationRequestId"] !== baseRequestId + ":observe" ||
    successor["historicalOutcome"] !== "unknown" ||
    !same(process(successor["expectedProcess"]), expected)
  )
    fail(
      "A fresh idle queue summary for the exact failed normal observation is required",
    );
  return summary;
}

function retryGrant(
  root: string,
  entry: Reference,
): NormalCurrentFactsRetryGrant {
  const value = checked(entry) as unknown as NormalCurrentFactsRetryGrant,
    previousAuthority = exactReference(value.previousAuthority),
    baseRequestId = value.baseRequestId;
  if (
    typeof baseRequestId !== "string" ||
    !baseRequestId ||
    entry.path !== retryPath(root, previousAuthority)
  )
    fail("Normal read retry authorization was changed or retargeted");
  const { authority, normal } = previousNormalRetryAuthority(
      root,
      baseRequestId,
      previousAuthority,
    ),
    currentOwner = normalRetryOwner(value.currentOwner),
    candidate = retryCandidate(
      {
        ...object(value.candidate),
        candidateRoot: value.candidateRoot,
      },
      true,
    );
  const physicalResult = exactReference(value.physicalResult),
    validationFailure = exactReference(value.validationFailure);
  if (
    value.version !== 1 ||
    value.kind !== "normal-currentfacts-retry-authorization" ||
    !same(value.originalNormalStore, normal) ||
    !same(candidate, {
      ...object(value.candidate),
      candidateRoot: value.candidateRoot,
    }) ||
    !same(process(value.expectedProcess), candidate.expectedProcess) ||
    !same(candidate.expectedProcess, process(authority["expectedProcess"])) ||
    candidate.requestId === baseRequestId ||
    (currentOwner.pid === normalRetryOwner(authority["previousOwner"]).pid &&
      currentOwner.birth ===
        normalRetryOwner(authority["previousOwner"]).birth) ||
    typeof value.allowNewUnsavedDefault !== "boolean"
  )
    fail(
      "Normal read retry authorization does not match its original authority",
    );
  const failed = validateFailedNormalRead(
    root,
    baseRequestId,
    previousAuthority,
    normal,
    physicalResult,
    validationFailure,
  );
  if (
    !Array.isArray(value.failedReadFiles) ||
    !same(value.failedReadFiles, failed.files)
  )
    fail("A prior failed-read artifact changed after authorization");
  const original = retryOriginalNormalStore(root, baseRequestId, normal),
    allowNewUnsavedDefault = allowsNewUnsavedDefault(
      root,
      baseRequestId,
      normal,
      original.profile.creationId,
      original.profile.documentName,
    );
  if (value.allowNewUnsavedDefault !== allowNewUnsavedDefault)
    fail("The original default-document identity proof changed");
  assertRetryQueueSummary(
    value.queueSummary,
    authority,
    baseRequestId,
    currentOwner,
  );
  return value;
}

export function authorizeNormalCurrentFactsRetry(
  epochOwner: Client,
  evidence: NormalCurrentFactsRetryEvidence,
  candidateInput: NormalCurrentFactsRetryCandidate,
): Reference {
  const root = canonical(epochOwner.dir, true),
    input = object(evidence),
    baseRequestId = input["previousRequestId"],
    previousAuthority = exactReference(input["previousAuthority"]),
    physicalResult = exactReference(input["physicalResult"]),
    validationFailure = exactReference(input["validationFailure"]);
  if (
    Object.keys(input).sort().join() !==
      "physicalResult,previousAuthority,previousRequestId,queueSummary,validationFailure" ||
    typeof baseRequestId !== "string" ||
    !baseRequestId ||
    baseRequestId.length > 140
  )
    fail("Exact immutable prior normal read evidence is required");
  const { authority, normal } = previousNormalRetryAuthority(
      root,
      baseRequestId,
      previousAuthority,
    ),
    ownerHash = authenticateOwner(epochOwner, String(authority["clientId"])),
    active = read(path.join(root, "active-epoch-succession.json")),
    currentOwner = normalRetryOwner(read(path.join(root, "broker.lock"))),
    candidate = retryCandidate(candidateInput, true),
    authorizationValue = retryOriginalNormalStore(root, baseRequestId, normal),
    activeReference = exactReference(active["authority"]);
  if (
    Object.keys(object(candidateInput)).sort().join() !==
      "buildHash,candidateRoot,expectedProcess,qualification,requestId,sourceCommit" ||
    active["version"] !== 1 ||
    !same(activeReference, previousAuthority) ||
    epochOwner.auth.clientId !== authority["clientId"] ||
    ownerHash !== authority["ownerTokenHash"] ||
    authorizationValue.profile.epochClientId !== epochOwner.auth.clientId ||
    Object.hasOwn(authority, "priorNormalCurrentFactsRetry") ||
    !same(normal, authority["normalCurrentStore"]) ||
    candidate.requestId === baseRequestId ||
    candidate.requestId === baseRequestId + ":observe" ||
    candidate.requestId === baseRequestId + ":create" ||
    !same(candidate.expectedProcess, process(authority["expectedProcess"])) ||
    (currentOwner.pid === normalRetryOwner(authority["previousOwner"]).pid &&
      currentOwner.birth === normalRetryOwner(authority["previousOwner"]).birth)
  )
    fail(
      "Fresh retry must retain the authentic active normal owner and select a distinct candidate",
    );
  assertRetryQueueSummary(
    input["queueSummary"],
    authority,
    baseRequestId,
    currentOwner,
  );
  const failed = validateFailedNormalRead(
    root,
    baseRequestId,
    previousAuthority,
    normal,
    physicalResult,
    validationFailure,
  );
  if (failed.profile.epochClientId !== epochOwner.auth.clientId)
    fail("The previous normal read belongs to another epoch owner");
  const allowNewUnsavedDefault = allowsNewUnsavedDefault(
    root,
    baseRequestId,
    normal,
    failed.profile.creationId,
    failed.profile.documentName,
  );
  const candidateBinding: NormalCurrentFactsRetryCandidateBinding = {
    requestId: candidate.requestId,
    sourceCommit: candidate.sourceCommit,
    buildHash: candidate.buildHash,
    qualification: candidate.qualification,
    expectedProcess: candidate.expectedProcess,
  };
  const value: NormalCurrentFactsRetryGrant = {
    version: 1,
    kind: "normal-currentfacts-retry-authorization",
    previousAuthority,
    baseRequestId,
    physicalResult,
    validationFailure,
    failedReadFiles: failed.files,
    originalNormalStore: normal,
    currentOwner,
    candidateRoot: candidate.candidateRoot!,
    candidate: candidateBinding,
    expectedProcess: candidate.expectedProcess,
    queueSummary: object(input["queueSummary"]),
    allowNewUnsavedDefault,
  };
  const file = retryPath(root, previousAuthority);
  if (fs.existsSync(file)) {
    const prior = retryGrant(root, reference(file));
    if (
      !same(
        {
          ...prior,
          queueSummary: undefined,
        },
        {
          ...value,
          queueSummary: undefined,
        },
      )
    )
      fail("The previous authority already consumed its one normal read retry");
    return reference(file);
  }
  return publish(file, value);
}

function retryRetirementBinding(
  grantReference: Reference,
  grant: NormalCurrentFactsRetryGrant,
  previousAuthority: Data,
) {
  return {
    requestId: grant.candidate.requestId,
    retryAuthorization: grantReference,
    previousAuthority: grant.previousAuthority,
    currentOwner: grant.currentOwner,
    runtime: previousAuthority["candidateRoot"],
    buildHash: previousAuthority["buildHash"],
  };
}

function retryRetirementFile(entry: Reference, name: string): string {
  return path.join(path.dirname(entry.path), name);
}

function assertRetrySuccessorState(
  root: string,
  authorityEntry: Reference,
  authority: Data,
  grant: NormalCurrentFactsRetryGrant,
  currentOwner: Owner,
  rootOwner: Owner | null,
): void {
  const audit = path.dirname(authorityEntry.path),
    requestId = grant.candidate.requestId,
    nonce = authority["nonce"],
    clientId = authority["clientId"],
    ownerTokenHash = authority["ownerTokenHash"],
    intentFile = path.join(audit, "intent.json"),
    recoveryFile = path.join(root, "recovery.lock"),
    atomicFile = path.join(root, "atomic-migration.lock"),
    retiredFile = path.join(audit, "retired-owner.json"),
    launchFile = path.join(audit, "launch-intent.json"),
    completeFile = path.join(audit, "complete.json"),
    hasRecovery = fs.existsSync(recoveryFile),
    hasAtomic = fs.existsSync(atomicFile),
    guard = { kind: "dead-epoch-successor", nonce, audit, clientId };
  if (
    typeof nonce !== "string" ||
    !nonce ||
    typeof clientId !== "string" ||
    typeof ownerTokenHash !== "string" ||
    hasRecovery !== hasAtomic
  )
    fail("The retry successor has no exact startup or completion phase");

  const retired = fs.existsSync(retiredFile) ? read(retiredFile) : null,
    launch = fs.existsSync(launchFile) ? read(launchFile) : null;
  if (retired && !same(retired, currentOwner))
    fail("The retry successor retired a different prior broker owner");
  if (launch && !same(launch, { nonce, authority: authorityEntry }))
    fail("The retry successor launch intent was retargeted");

  if (hasRecovery) {
    if (!same(read(recoveryFile), guard) || !same(read(atomicFile), guard))
      fail("The retry successor startup guards do not match its authority");
    const intent = read(intentFile),
      approvalRef = exactReference(intent["approval"]),
      approval = checked(approvalRef);
    if (
      intent["version"] !== 1 ||
      intent["requestId"] !== requestId ||
      intent["clientId"] !== clientId ||
      intent["ownerTokenHash"] !== ownerTokenHash ||
      intent["nonce"] !== nonce ||
      !same(intent["previousOwner"], currentOwner) ||
      approval["purpose"] !== "dead-normal-currentstore-successor-v1" ||
      approval["requestId"] !== requestId ||
      approval["clientId"] !== clientId ||
      approval["candidateRoot"] !== grant.candidateRoot ||
      approval["sourceCommit"] !== grant.candidate.sourceCommit ||
      approval["buildHash"] !== grant.candidate.buildHash ||
      !same(process(approval["expectedProcess"]), grant.expectedProcess) ||
      !same(
        exactReference(approval["qualification"]),
        grant.candidate.qualification,
      ) ||
      !same(approval["previousOwner"], currentOwner) ||
      !same(approval["normalCurrentStore"], grant.originalNormalStore) ||
      !same(
        approval["priorNormalCurrentFactsRetry"],
        reference(retryPath(root, grant.previousAuthority)),
      )
    )
      fail(
        "The retry successor intent or approval does not consume this exact grant",
      );
  } else if (rootOwner && same(rootOwner, currentOwner)) {
    fail("The original retry owner remains active without its startup guards");
  }

  if (!rootOwner) {
    if (!hasRecovery || !retired || !launch)
      fail(
        "A pre-claim retry successor requires matching guards and retirement evidence",
      );
    return;
  }
  if (same(rootOwner, currentOwner)) {
    if (!hasRecovery)
      fail(
        "The original retry owner cannot remain after successor guard release",
      );
    return;
  }
  if (hasRecovery && (!retired || !launch))
    fail(
      "A claimed retry successor must retain its retirement and launch receipts",
    );
  if (!hasRecovery) {
    const complete = read(completeFile);
    if (
      complete["kind"] !== "dead-epoch-successor-metadata-ready" ||
      complete["requestId"] !== requestId ||
      !same(exactReference(complete["authority"]), authorityEntry) ||
      !same(complete["owner"], rootOwner) ||
      complete["buildHash"] !== grant.candidate.buildHash ||
      complete["sourceCommit"] !== grant.candidate.sourceCommit ||
      complete["sdkRequestsSent"] !== 0 ||
      complete["historicalOutcome"] !== "unknown"
    )
      fail(
        "A claimed retry successor without startup guards needs its exact ready receipt",
      );
  }
}

function retryRetirementClaimFile(root: string, owner: Owner): string {
  return path.join(
    root,
    "normal-currentfacts-retry-producer-claims",
    digest(JSON.stringify(process(owner))) + ".json",
  );
}

export function retireNormalCurrentFactsRetryProducer(
  epochOwner: Client,
  grantReference: Reference,
  apply = false,
  ports: NormalMetadataRetirementPorts = defaultRetirementPorts,
): Reference | { pending: true; noSignalReplay: true; sdkRequestsSent: 0 } {
  const root = retryRoot(grantReference),
    grant = retryGrant(root, grantReference),
    { authority } = previousNormalRetryAuthority(
      root,
      grant.baseRequestId,
      grant.previousAuthority,
    );
  authenticateOwner(epochOwner, String(authority["clientId"]));
  if (epochOwner.auth.clientId !== authority["clientId"])
    fail(
      "The sealed original epoch owner is required for retry-producer retirement",
    );
  const active = read(path.join(root, "active-epoch-succession.json")),
    currentOwner = normalRetryOwner(read(path.join(root, "broker.lock"))),
    runtime = canonical(String(authority["candidateRoot"]), true),
    previewFile = retryRetirementFile(
      grantReference,
      "producer-retirement-preview.json",
    ),
    effectFile = retryRetirementFile(
      grantReference,
      "producer-retirement-effect-start.json",
    ),
    resultFile = retryRetirementFile(grantReference, "producer-retired.json"),
    binding = retryRetirementBinding(grantReference, grant, authority),
    expectedClaim = {
      kind: "normal-currentfacts-retry-producer-claim",
      binding,
    };
  if (
    active["version"] !== 1 ||
    !same(exactReference(active["authority"]), grant.previousAuthority) ||
    !same(currentOwner, grant.currentOwner) ||
    ports.buildHash(runtime) !== authority["buildHash"]
  )
    fail(
      "Only the exact active normal metadata owner and runtime may be retired",
    );

  if (fs.existsSync(effectFile)) {
    const effect = read(effectFile),
      claimFile = retryRetirementClaimFile(root, grant.currentOwner),
      claim = fs.existsSync(claimFile) ? read(claimFile) : null;
    if (!same(effect["binding"], binding) || !same(claim, expectedClaim))
      fail(
        "An uncertain retry-producer retirement cannot be retargeted or replayed",
      );
    if (fs.existsSync(resultFile)) {
      const result = read(resultFile);
      if (
        result["kind"] !== "normal-currentfacts-retry-producer-retired" ||
        result["retired"] !== true ||
        !same(result["binding"], binding)
      )
        fail("The retry-producer retirement receipt changed");
      return reference(resultFile);
    }
    return { pending: true, noSignalReplay: true, sdkRequestsSent: 0 };
  }
  const refs = [
    grantReference,
    grant.previousAuthority,
    ...grant.failedReadFiles,
    grant.physicalResult,
    grant.validationFailure,
    grant.originalNormalStore.jobAuthorization,
    grant.originalNormalStore.deathProof,
    grant.originalNormalStore.producerRetirement,
    grant.candidate.qualification,
  ];
  if (!apply) {
    if (fs.existsSync(previewFile)) {
      const prior = read(previewFile);
      if (
        prior["kind"] !== "normal-currentfacts-retry-producer-preview" ||
        !same(prior["binding"], binding)
      )
        fail("The original retry-producer preview cannot be retargeted");
      return reference(previewFile);
    }
    const preview = ports.process(
      grant.currentOwner,
      runtime,
      refs,
      false,
      root,
    );
    if (
      preview.retired ||
      !same(process(preview.process), process(grant.currentOwner)) ||
      !preview.interpreter
    )
      fail("Exact non-mutating retry-producer process proof required");
    return publish(previewFile, {
      kind: "normal-currentfacts-retry-producer-preview",
      binding,
      preview,
      sdkRequestsSent: 0,
    });
  }

  const previewReference = reference(previewFile),
    preview = checked(previewReference),
    proof = object(preview["preview"]);
  if (
    preview["kind"] !== "normal-currentfacts-retry-producer-preview" ||
    !same(preview["binding"], binding) ||
    !same(process(proof["process"]), process(grant.currentOwner)) ||
    !proof["interpreter"]
  )
    fail(
      "The exact sealed retry-producer preview is required before retirement",
    );
  const claimFile = retryRetirementClaimFile(root, grant.currentOwner);
  if (!fs.existsSync(claimFile)) {
    try {
      publish(claimFile, expectedClaim);
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "EEXIST"
      )
        throw error;
    }
  }
  if (!same(read(claimFile), expectedClaim))
    fail("Another retry attempt already owns this metadata producer");
  const effect = publish(effectFile, {
    kind: "normal-currentfacts-retry-producer-effect-start",
    binding,
    preview: previewReference,
    claim: reference(claimFile),
    sdkRequestsSent: 0,
  });
  try {
    const result = ports.process(
      {
        ...grant.currentOwner,
        processProof: proof["process"] as NonNullable<
          Sdk1MetadataWorkerProcess["processProof"]
        >,
        interpreterProof: proof["interpreter"] as NonNullable<
          Sdk1MetadataWorkerProcess["interpreterProof"]
        >,
      },
      runtime,
      [...refs, previewReference, reference(claimFile), effect],
      true,
      root,
    );
    if (
      !result.retired ||
      !same(process(result.process), process(grant.currentOwner)) ||
      !ports.producerAbsent(grant.currentOwner)
    )
      fail(
        "Retry-producer retirement is not kernel-proven; never repeat its signal",
      );
    return publish(resultFile, {
      version: 1,
      kind: "normal-currentfacts-retry-producer-retired",
      binding,
      retired: true,
      process: result.process,
      interpreter: result.interpreter,
      observedAtUtc: new Date().toISOString(),
      sdkRequestsSent: 0,
      historicalOutcome: "unknown",
    });
  } catch {
    return { pending: true, noSignalReplay: true, sdkRequestsSent: 0 };
  }
}

export function inspectNormalCurrentFactsRetry(
  rootInput: string,
  entryInput: Reference,
  candidateInput: NormalCurrentFactsRetryCandidateBinding,
  ports: NormalColdPorts = defaultPorts,
): NormalCurrentFactsRetryInspection {
  const root = canonical(rootInput, true),
    entry = exactReference(entryInput),
    grant = retryGrant(root, entry),
    candidate = retryCandidate(candidateInput, false),
    { authority: previousAuthorityValue } = previousNormalRetryAuthority(
      root,
      grant.baseRequestId,
      grant.previousAuthority,
    );
  const installedQualification = path.join(
    root,
    "epoch-successions",
    digest(candidate.requestId),
    "installed-qualification.json",
  );
  if (
    !same(
      { ...candidate, qualification: grant.candidate.qualification },
      grant.candidate,
    ) ||
    candidate.qualification.sha256 !== grant.candidate.qualification.sha256 ||
    (candidate.qualification.path !== grant.candidate.qualification.path &&
      candidate.qualification.path !== installedQualification) ||
    !same(process(grant.expectedProcess), candidate.expectedProcess) ||
    !same(
      candidate.expectedProcess,
      process(previousAuthorityValue["expectedProcess"]),
    )
  )
    fail("The retry candidate request/build/qualification/process changed");

  const resultFile = retryRetirementFile(entry, "producer-retired.json"),
    result = checked(reference(resultFile), resultFile),
    binding = retryRetirementBinding(entry, grant, previousAuthorityValue),
    retiredAt = Date.parse(String(result["observedAtUtc"])),
    currentOwner = normalRetryOwner(grant.currentOwner),
    active = read(path.join(root, "active-epoch-succession.json")),
    activeAuthority = exactReference(active["authority"]),
    brokerFile = path.join(root, "broker.lock"),
    rootOwner = fs.existsSync(brokerFile)
      ? normalRetryOwner(read(brokerFile))
      : null;
  if (
    result["version"] !== 1 ||
    result["kind"] !== "normal-currentfacts-retry-producer-retired" ||
    result["retired"] !== true ||
    result["sdkRequestsSent"] !== 0 ||
    result["historicalOutcome"] !== "unknown" ||
    !same(result["binding"], binding) ||
    !same(process(result["process"]), process(currentOwner)) ||
    !Number.isFinite(retiredAt) ||
    retiredAt > Date.now() ||
    !ports.producerAbsent(currentOwner)
  )
    fail(
      "The original retry metadata owner has no completed exact retirement proof",
    );

  if (same(activeAuthority, grant.previousAuthority)) {
    if (!rootOwner || !same(rootOwner, currentOwner))
      fail(
        "The pre-bootstrap root owner changed before the retry was consumed",
      );
  } else {
    const expectedAuthorityFile = path.join(
      root,
      "epoch-successions",
      digest(candidate.requestId),
      "authority.json",
    );
    if (activeAuthority.path !== expectedAuthorityFile)
      fail("The retry was consumed by a retargeted active authority");
    const nextAuthority = checked(activeAuthority);
    if (
      nextAuthority["kind"] !== "owner-authenticated-dead-epoch-successor" ||
      nextAuthority["requestId"] !== candidate.requestId ||
      nextAuthority["sourceCommit"] !== candidate.sourceCommit ||
      nextAuthority["buildHash"] !== candidate.buildHash ||
      nextAuthority["candidateRoot"] !== grant.candidateRoot ||
      !same(nextAuthority["previousOwner"], currentOwner) ||
      !same(nextAuthority["normalCurrentStore"], grant.originalNormalStore) ||
      !same(nextAuthority["priorNormalCurrentFactsRetry"], entry) ||
      !same(
        process(nextAuthority["expectedProcess"]),
        candidate.expectedProcess,
      ) ||
      exactReference(nextAuthority["qualification"]).path !==
        installedQualification ||
      exactReference(nextAuthority["qualification"]).sha256 !==
        grant.candidate.qualification.sha256 ||
      (rootOwner !== null &&
        same(rootOwner, currentOwner) &&
        !ports.producerAbsent(currentOwner))
    )
      fail(
        "The bootstrapped authority does not consume this exact normal retry",
      );
    assertRetrySuccessorState(
      root,
      activeAuthority,
      nextAuthority,
      grant,
      currentOwner,
      rootOwner,
    );
  }
  return {
    previousAuthority: grant.previousAuthority,
    baseRequestId: grant.baseRequestId,
    originalNormalStore: grant.originalNormalStore,
    currentOwner,
    candidateRoot: grant.candidateRoot,
    candidate: grant.candidate,
    expectedProcess: candidate.expectedProcess,
  };
}

function normalCurrentFactsRetryBinding(
  binding: AuditBinding,
): NormalCurrentFactsRetryInspection | null {
  const link = binding["priorNormalCurrentFactsRetry"],
    candidate = binding["normalCurrentFactsRetryCandidate"];
  if (link === undefined && candidate === undefined) return null;
  if (link === undefined || candidate === undefined)
    fail(
      "Incomplete retry evidence cannot downgrade to the legacy default reader",
    );
  const entry = exactReference(link),
    root = retryRoot(entry),
    inspection = inspectNormalCurrentFactsRetry(
      root,
      entry,
      candidate as NormalCurrentFactsRetryCandidateBinding,
    ),
    active = read(path.join(root, "active-epoch-succession.json")),
    authority = exactReference(active["authority"]);
  if (
    binding["purpose"] !== "normal-currentstore-current-facts-v1" ||
    binding["successorAuthorityHash"] !== authority.sha256 ||
    !same(binding["normalCurrentStore"], inspection.originalNormalStore) ||
    !same(process(binding["expectedProcess"]), inspection.expectedProcess)
  )
    fail(
      "The retry reader is not bound to its current normal successor authority",
    );
  return inspection;
}

function normalCurrentFactsRetryRoot(
  binding: AuditBinding | undefined,
): string {
  if (!binding) fail("The normal read retry binding is missing");
  return retryRoot(exactReference(binding["priorNormalCurrentFactsRetry"]));
}

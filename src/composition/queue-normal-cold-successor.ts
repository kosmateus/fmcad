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
/** The qualified source ABI is fixed; incident identities are explicit sealed
 * operator input, never constants in the reusable recovery adapter. */
export const normalColdProfile = Object.freeze({
  kind: "normal-currentstore-v1" as const,
  sourceCommit: "4bae34f9970b1a3179528a1dd06e2d0e5a3f702d",
  buildHash: "6b0c57e05541950a885527f09cde9b36ae0219c658a2cf2911af81728e26458a",
});
export interface NormalCurrentStoreTarget {
  kind: "normal-currentstore-target-v1";
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
function read(file: string): Data {
  canonical(file);
  if (fs.statSync(file).size > 16 * 1024 * 1024)
    fail("Normal-currentstore evidence exceeds its bound");
  return object(JSON.parse(fs.readFileSync(file, "utf8")) as unknown);
}
function reference(file: string): Reference {
  canonical(file);
  return { path: file, sha256: digest(fs.readFileSync(file)) };
}
function checked(entry: Reference, expected?: string): Data {
  if (
    !entry ||
    (expected !== undefined && entry.path !== expected) ||
    !same(reference(entry.path), entry)
  )
    fail("Normal-currentstore evidence changed or was retargeted");
  return read(entry.path);
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
  if (
    Object.keys(target).sort().join() !== keys.sort().join() ||
    target["kind"] !== "normal-currentstore-target-v1" ||
    keys
      .filter((key) => !["kind", "sdk", "metadata"].includes(key))
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
    identity["sourceCommit"] !== p.sourceCommit ||
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
    request["kind"] !== "command" ||
    request["clientId"] !== p.jobClientId ||
    request["requestId"] !== p.jobRequestId ||
    request["phased"] !== true ||
    request["backend"] !== "mcp" ||
    request["buildHash"] !== p.buildHash ||
    !Array.isArray(args) ||
    args.some((arg) => typeof arg !== "string") ||
    args[0] !== "run" ||
    args.length !== 8 ||
    ["--doc", "--doc-id", "--helpers"].some(
      (flag) => args.filter((arg) => arg === flag).length !== 1,
    ) ||
    args[args.indexOf("--doc-id") + 1] !== p.creationId ||
    args[args.indexOf("--doc") + 1] !== p.documentName ||
    args[args.indexOf("--helpers") + 1] !== "cad-v1" ||
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
  const producers: Process[] = [process(owner)];
  const sealedRequests: Snapshot["sealedRequests"] = [];
  for (const id of Object.keys(jobs).sort()) {
    if (!/^[a-f0-9-]{36}$/.test(id)) fail("Noncanonical job namespace");
    const dir = canonical(path.join(root, "jobs", id), true);
    if (
      (id === p.jobId || fs.existsSync(path.join(dir, "worker-start.json"))) &&
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
  const value = authorization(
      root,
      approval.requestId,
      normal.jobAuthorization,
      predecessorOwner ? { pointer, owner: predecessorOwner } : undefined,
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
    path.join(journal(root, approval.requestId), "producers-retired.json"),
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
    retirement["requestId"] !== approval.requestId ||
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
  const bindings = {
    jobAuthorization: normal.jobAuthorization,
    producerRetirement: normal.producerRetirement,
    originalRpc: reference(
      path.join(root, "jobs", p.jobId, `rpc-${p.rpcId}.json`),
    ),
  };
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
      requestId: a.requestId,
      clientId: a.clientId,
      previousBuildHash: a.previousBuildHash,
      expectedProcess: a.expectedProcess,
      normalCurrentStore: normal,
    } as Approval,
    checkedPredecessor.pointer,
    defaultPorts,
    a.previousOwner,
  );
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
  const sourceFile = path.join(
    installation,
    "runtime/python/recovery/normal_currentstore.py",
  );
  canonical(sourceFile);
  const source = fs.readFileSync(sourceFile, "utf8");
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
        source: `def run(_context: str) -> None:\n    print('FMCAD_RESULT ' + _nc_json.dumps(normal_currentstore_facts(${JSON.stringify(document["creationId"])}, ${JSON.stringify(document["name"])}), allow_nan=False))\n`,
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
  return validateNormalCurrentFacts(value, identity);
}
export function validateNormalCurrentFacts(
  input: unknown,
  identity: unknown,
): Data {
  const value = object(input);
  const doc = object(object(identity)["resolvedIdentity"]);
  if (
    value["kind"] !== "normal-currentstore-current-facts-v1" ||
    value["originalDocumentCreationId"] !== doc["creationId"] ||
    value["originalDocumentName"] !== doc["name"] ||
    value["originalDocumentPresent"] !== false ||
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
        row["name"] === doc["name"]
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

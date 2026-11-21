import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { isDeepStrictEqual as same } from "node:util";

export type InlineObserverProofRef = Readonly<{ path: string; sha256: string }>;
type Data = Record<string, unknown>;
type Process = { pid: number; birth: string };

// This is the one archived route reviewed by Astra, not a generic exception
// for missing worker identities. New history requires a separate policy review.
export const inlineObserverPolicy = Object.freeze({
  proofHash: "e10e39989e2e0e8ff08db76bd00d0882e40b63857f1e31974671142a478360db",
  jobId: "3627db2e-0b9d-4e4f-927f-20cb45deae74",
  requestId: "measured-fasteners-atomic-status-20261030-posthandoff-v1",
  jobHash: "dc86c728f05be07eba957ad8fe163b34b77e64128dea1665b7ed8a612ae53e47",
  clientId: "cli:PC:kamil",
  targetId: "5fbcd38b-8e8a-4cd7-8eab-353e8b025b9a",
  targetHash:
    "329fa0adf44d1e5c1830e3be30156390a199cd3e2bc92b656e72e22e73ed7da3",
  targetRequestId: "measured-fasteners-fixture-setup-20261027-1905z",
  observerBuild:
    "2e1b3b7b1bb07c870d2aeb5a4e6afb552f41b4f78d8db408e8d2f2854b1b3fa7",
  targetBuild:
    "1ef9b72ee009aafca52ea67a1a9050db10e0120b28467fe285290b88c224ae87",
  rpcId: "0b6a469c-4b47-435f-b852-4596d09a14c5",
  rpcRequestHash:
    "78fb20f7e92617caca9036d4499562b9125a1a042d281b87153674bdcd95df5d",
  sourceHash:
    "aadbf3810f54ae5204800358f5d4bf40f6ba7d3c5f27809fe98ed104ffe92836",
  identityHash:
    "8c8f6754d5bb044859cfbeed9c4bfc3f2d9721707e5958a4bd43b8f11b8844b0",
  abiHash: "bcd057ceef8756a2baebc0d449c4dc9773c7117d9157e1b9de2361737b133dba",
  originHash:
    "18aaf46d2c67d20301a702e00fc99a6061a3c167794b758a0ed705d1bc8ef051",
  rootHash: "7130410aee63aa2e02f74614b563e7fa82147335007c97bf88cc8cc841b817fd",
  sdkDeathHash:
    "4d204c711ab7a2e7dba5983a419c57a3a7a1c60bfe28f23015f23f97efe4f25d",
  commandId: "fmcad_atomic_d1e7d293bcf73543563ead63f4df62c7",
  sessionNonce: "a87b938ad05f67893a0af5889b7b36c3",
  docId: "f9f27526-55d2-47bb-a4d8-312246f2de08",
  projectDirectory: "/tmp/opencode/fmcad-backlog/measured-fasteners",
  reportPath: "/tmp/opencode/measured-fasteners-native/batch-v1",
  reportFingerprint:
    "fa130e147b4f0e405cca2873159ceac7edb5fc3e212fed20d4a207cacbb13891",
});
const p = inlineObserverPolicy;
const broker = Object.freeze({
  pid: 1470648,
  birth: "54299d3b-5d9a-4589-90e1-a53287c516c9:64702243",
  nonce: "e8956024-9420-4616-8724-e02ada9dd476",
  protocol: 2,
});
const sdk = Object.freeze({
  pid: 50352,
  birth: "134375220106992528",
  version: "2706.1.14",
});
const sources = Object.freeze({
  "src/queue-broker.js":
    "a8b1e8ea109f4af37dce0cc04bc9a53f25792f2c61a6137642ade713c7a7d31a",
  "src/dist/fusion-transport/broker.js":
    "80890f48b3bf6d67086364acfea3eb65131f080de6fff7af604b9f5b389ca963",
  "src/dist/fusion-transport/addin.js":
    "5c6a3d7a195ece31accff30fabc73bf2456796091e4ae5a71d124aaf1c3c3f25",
  "src/dist/fusion-transport/mcp.js":
    "f2214fd9870d9fcde15955bd6304d9143ffba224d29863921e7a9bd29977fe9f",
  "src/dist/fusion-transport/curl.js":
    "4269a77ea08d72dc38557c1eccad5e0c85f1b3d845a29f0623a1d4b5536fd7a2",
  "src/dist/core/application/execution.js":
    "11fee1d889f7d9e04ecff4ef5539a3a64ce36cea1d83d18f3199b6d9f309f988",
});
const artifacts = Object.freeze({
  [`jobs/${p.jobId}/atomic-observation-${p.rpcId}.receipt.json`]:
    "174cc2d1a1c238e5c47c4c2d7c241c3c7ed2b2820bf5ae018a12ec9680960035",
  [`jobs/${p.jobId}/atomic-observation-proof.json`]:
    "3ca48558b2e00532eb7fe26361ff15c1f26edfed8db1785098d28b2b4f3828c2",
  [`jobs/${p.jobId}/atomic-observation-start.json`]:
    "a28f9f6c44633c67e0b15da4670c573101a8df736dda73baa193178dfc94a14d",
  [`jobs/${p.jobId}/rpc-${p.rpcId}.json`]:
    "52f3e326f18270b5f72dcfcd15886e7e580b0863515b0540b2774e63192fbc7e",
  [`broker-lifecycle-${broker.nonce}.json`]:
    "aee15300206118541fec5d4d4a2bc4e29c466ce9c3f47fb8a43403c580f49ee6",
});
const runtimeHash =
  "0521c451898e4f1139676bd78a531a650f3140929818584cacf17854c2f397f7";
const load = createRequire(
  path.join(__dirname, "../../queue-epoch-successor.js"),
);
function api(): {
  buildHash(root: string): string;
  priorProcessAlive(identity: Process): boolean | null;
} {
  return load("./queue-instance") as ReturnType<typeof api>;
}
function fail(): never {
  throw Object.assign(
    new Error("Exact pinned inline observer expiry evidence required"),
    {
      code: "FROZEN_METADATA_FENCE_CHANGED",
    },
  );
}
function object(value: unknown): Data {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Data;
}
function equal(a: unknown, b: unknown): void {
  if (!same(a, b)) fail();
}
function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function bytes(file: string): Buffer {
  const stat = fs.lstatSync(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    fs.realpathSync(file) !== path.resolve(file)
  )
    fail();
  return fs.readFileSync(file);
}
function json(file: string): Data {
  return object(JSON.parse(bytes(file).toString("utf8")));
}
export function isInlineObserverProofRef(
  value: unknown,
): value is InlineObserverProofRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Data;
  return (
    Object.keys(entry).sort().join() === "path,sha256" &&
    typeof entry["path"] === "string" &&
    path.isAbsolute(entry["path"]) &&
    typeof entry["sha256"] === "string" &&
    /^[a-f0-9]{64}$/.test(entry["sha256"])
  );
}

/** Internal domain checks, not an authority-producing bypass of file validation. */
export function checkInlineObserverBindings(
  jobValue: unknown,
  records: {
    start: unknown;
    proof: unknown;
    rpc: unknown;
    receipt: unknown;
    lifecycle: unknown;
    sdkDeath: unknown;
  },
): Process {
  const job = object(jobValue),
    request = object(job["request"]),
    dispatch = object(job["dispatch"]);
  const marker = object(job["workflowObservation"]);
  const start = object(records.start),
    proof = object(records.proof),
    rpc = object(records.rpc);
  const receipt = object(records.receipt),
    lifecycle = object(records.lifecycle),
    death = object(records.sdkDeath);
  equal(
    [
      job["id"],
      job["requestId"],
      job["hash"],
      job["clientId"],
      job["kind"],
      job["state"],
    ],
    [
      p.jobId,
      p.requestId,
      p.jobHash,
      p.clientId,
      "command",
      "needs_reconciliation",
    ],
  );
  equal(
    [request["buildHash"], request["kind"], request["backend"]],
    [p.observerBuild, "command", "addin"],
  );
  equal(marker, {
    version: 1,
    kind: "atomic-holder-status",
    observerJobHash: p.jobHash,
    observerBuildHash: p.observerBuild,
    targetJobId: p.targetId,
    targetJobHash: p.targetHash,
    targetBuildHash: p.targetBuild,
    targetRequestId: p.targetRequestId,
    targetClientId: p.clientId,
    projectDirectory: p.projectDirectory,
    paused: true,
    controlGeneration: 25,
    contextEpoch: 12,
    reportPath: p.reportPath,
    reportFingerprint: p.reportFingerprint,
    commandId: p.commandId,
    sessionNonce: p.sessionNonce,
    docId: p.docId,
  });
  equal(
    [
      dispatch["rpcState"],
      dispatch["dispatchCount"],
      dispatch["rpcCount"],
      dispatch["completedCount"],
    ],
    ["terminal", 2, 1, 1],
  );
  equal(object(dispatch["details"])["rpcId"], p.rpcId);
  const invocation = object(object(request["payload"])["invocation"]);
  equal(
    [invocation["kind"], invocation["operation"], invocation["preview"]],
    ["cad", "batch.reconcile", false],
  );
  const data = object(invocation["data"]);
  equal([data["blockedJobId"], data["operations"]], [p.targetId, []]);
  equal(
    [data["commandId"], data["sessionNonce"], invocation["docId"]],
    [marker["commandId"], marker["sessionNonce"], marker["docId"]],
  );
  for (const record of [start, proof]) {
    equal(
      [
        record["version"],
        record["kind"],
        record["observerJobId"],
        record["observerRequestId"],
        record["targetJobId"],
        record["targetRequestId"],
        record["clientId"],
        record["observerBuildHash"],
        record["originalBuildHash"],
      ],
      [
        1,
        "atomic_holder_status",
        p.jobId,
        p.requestId,
        p.targetId,
        p.targetRequestId,
        p.clientId,
        p.observerBuild,
        p.targetBuild,
      ],
    );
    for (const key of ["projectDirectory", "reportPath", "reportFingerprint"])
      equal(record[key], marker[key]);
  }
  equal(start["owner"], broker);
  equal(lifecycle["owner"], broker);
  equal(
    [lifecycle["buildHash"], lifecycle["stage"]],
    [p.observerBuild, "ready"],
  );
  equal(lifecycle["binding"], {
    brokerNonce: broker.nonce,
    ownerPid: broker.pid,
    ownerBirth: broker.birth,
    buildHash: p.observerBuild,
    stage: "startup",
  });
  const binding = {
    jobId: p.jobId,
    rpcId: p.rpcId,
    requestHash: p.rpcRequestHash,
    buildHash: p.observerBuild,
    sourceHash: p.sourceHash,
    observationKind: "atomic_holder_status",
    observationTargetJobId: p.targetId,
    observationIdentityHash: p.identityHash,
    atomicRuntimeAbiHash: p.abiHash,
    pythonOriginHash: p.originHash,
  };
  for (const record of [start, proof, rpc]) equal(record["binding"], binding);
  for (const [key, value] of Object.entries(binding))
    equal(receipt[key], value);
  equal(rpc["remoteReceipt"], receipt);
  equal(
    [
      rpc["terminal"],
      receipt["terminal"],
      proof["rpcId"],
      proof["readOnlyOperation"],
    ],
    [true, true, p.rpcId, "atomic_status"],
  );
  equal(
    [receipt["outcome"], proof["remoteOutcome"], proof["toolFailed"]],
    ["succeeded", "succeeded", false],
  );
  equal(
    [
      rpc["method"],
      object(rpc["request"])["id"],
      object(rpc["wireRequest"])["id"],
    ],
    ["tools/call", 2, `fmcad:${p.rpcId}`],
  );
  for (const instance of [
    start["instance"],
    proof["observerInstance"],
    rpc["instance"],
    receipt["instance"],
  ]) {
    const observed = object(instance);
    equal(
      [observed["pid"], observed["birth"], observed["version"]],
      [sdk.pid, sdk.birth, sdk.version],
    );
  }
  equal(
    [
      death["oldSdkPid"],
      death["expectedBirth"],
      death["present"],
      death["actualBirth"],
    ],
    [sdk.pid, sdk.birth, false, null],
  );
  const artifact = object(rpc["pythonArtifact"]);
  equal(artifact["request"], binding);
  equal(
    object(object(artifact["context"])["origin"])["artifactHash"],
    p.originHash,
  );
  equal(
    object(object(object(artifact["context"])["origin"])["request"])[
      "operation"
    ],
    "atomic_status",
  );
  equal(object(rpc["pythonCheck"])["status"], "passed");
  equal(object(proof["summary"])["outcome"], "unknown");
  const before = api();
  if (
    before.priorProcessAlive(broker) !== false ||
    before.priorProcessAlive(sdk) !== false
  )
    fail();
  // Return the actual inline producer identity. Never manufacture worker files
  // or translate terminal transport evidence into settlement of this job.
  return { pid: broker.pid, birth: broker.birth };
}

/** Re-read and fence every byte on each invocation, including under claim lock.
 * Never import/execute archived code or credentials; all I/O is read-only. */
export function verifyFrozenInlineObserver(
  root: string,
  job: unknown,
  ref: InlineObserverProofRef,
): Process {
  try {
    if (!isInlineObserverProofRef(ref) || ref.sha256 !== p.proofHash) fail();
    const proofBytes = bytes(ref.path);
    equal(digest(proofBytes), ref.sha256);
    const manifest = object(JSON.parse(proofBytes.toString("utf8")));
    equal(
      [
        manifest["version"],
        manifest["kind"],
        manifest["jobId"],
        manifest["requestId"],
        manifest["observerBuildHash"],
        manifest["rootSnapshotHash"],
      ],
      [
        1,
        "read-only-inline-observer-expiry-evidence-not-authority",
        p.jobId,
        p.requestId,
        p.observerBuild,
        p.rootHash,
      ],
    );
    const archive = object(manifest["archiveFingerprint"])["archive"];
    if (typeof archive !== "string" || !path.isAbsolute(archive)) fail();
    const refs = manifest["sourceRefs"];
    if (!Array.isArray(refs) || refs.length !== 6) fail();
    for (const [name, sha256] of Object.entries(sources)) {
      const file = path.join(archive, name);
      if (
        refs.filter(
          (value) =>
            object(value)["path"] === file &&
            object(value)["sha256"] === sha256,
        ).length !== 1
      )
        fail();
      equal(digest(bytes(file)), sha256);
    }
    // Recompute the whole archival runtime, not just the six code witnesses.
    equal(api().buildHash(archive), p.observerBuild);
    equal(digest(bytes(path.join(root, "queue-state.json"))), p.rootHash);
    const sealedJob = object(
      object(json(path.join(root, "queue-state.json"))["jobs"])[p.jobId],
    );
    equal(job, sealedJob);
    const evidence = manifest["evidenceRefs"];
    if (!Array.isArray(evidence) || evidence.length !== 6) fail();
    const pinned = {
      ...Object.fromEntries(
        Object.entries(artifacts).map(([name, sha]) => [
          path.join(root, name),
          sha,
        ]),
      ),
      [path.join(archive, "runtime-build.json")]: runtimeHash,
    };
    for (const [file, sha256] of Object.entries(pinned)) {
      if (
        evidence.filter(
          (value) =>
            object(value)["path"] === file &&
            object(value)["sha256"] === sha256,
        ).length !== 1
      )
        fail();
      equal(digest(bytes(file)), sha256);
    }
    const deathRef = object(manifest["oldSdkObservation"]);
    const deathFile = path.join(path.dirname(ref.path), "old-sdk-process.json");
    equal([deathRef["path"], deathRef["sha256"]], [deathFile, p.sdkDeathHash]);
    equal(digest(bytes(deathFile)), p.sdkDeathHash);
    const directory = path.join(root, "jobs", p.jobId);
    const expected = [
      "atomic-observation-start.json",
      "atomic-observation-proof.json",
      `atomic-observation-${p.rpcId}.receipt.json`,
      `rpc-${p.rpcId}.json`,
    ].sort();
    function fenceFiles() {
      if (
        !fs.lstatSync(directory).isDirectory() ||
        fs.lstatSync(directory).isSymbolicLink()
      )
        fail();
      equal(fs.readdirSync(directory).sort(), expected);
      for (const [file, hash] of Object.entries(pinned))
        equal(digest(bytes(file)), hash);
      equal(digest(bytes(ref.path)), ref.sha256);
      equal(digest(bytes(path.join(root, "queue-state.json"))), p.rootHash);
    }
    fenceFiles();
    const start = json(path.join(directory, "atomic-observation-start.json"));
    const proof = json(path.join(directory, "atomic-observation-proof.json"));
    const rpc = json(path.join(directory, `rpc-${p.rpcId}.json`));
    const receipt = json(
      path.join(directory, `atomic-observation-${p.rpcId}.receipt.json`),
    );
    const receiptPath = path.join(
      directory,
      `atomic-observation-${p.rpcId}.receipt.json`,
    );
    for (const record of [start, proof, rpc])
      equal(record["receipt"], receiptPath);
    const producer = checkInlineObserverBindings(sealedJob, {
      start,
      proof,
      rpc,
      receipt,
      lifecycle: json(path.join(root, `broker-lifecycle-${broker.nonce}.json`)),
      sdkDeath: json(deathFile),
    });
    fenceFiles();
    return producer;
  } catch {
    return fail();
  }
}

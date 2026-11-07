import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runtimeRequire, runtimeRoot, isRecord } from "./runtime.js";

interface QueueInstanceModule {
  durable(file: string, value: unknown, exclusive?: boolean): void;
  readJson(file: string): unknown;
  processBirth(pid?: number): string;
  priorProcessAlive(identity: unknown): boolean | null;
  buildHash(root?: string): string;
  sameInstance(left: unknown, right: unknown): boolean;
  hash(value: string | Buffer): string;
}

interface QueueState {
  resolve(jobId: string, details: Record<string, unknown>): unknown;
  status(): unknown;
}

interface QueueStateModule {
  QueueState: new (directory: string) => QueueState;
}

interface QueueClient {
  register(): Promise<unknown>;
  call(action: string, values?: Record<string, unknown>): Promise<unknown>;
}

interface QueueClientModule {
  QueueClient: new (clientId: string) => QueueClient;
}

interface QueueConnectionModule {
  queueDirectory(): string;
}

interface InstallerModule {
  archiveFiles(file: string): Map<string, Buffer>;
}

interface RecoveryExpected {
  jobId: string;
  requestId: string;
  clientId: string;
  sequenceId: string;
  buildHash: string;
  brokerNonce: string;
}

interface InspectOptions {
  dir: string;
  root: string;
  archive: string;
  status: Record<string, unknown>;
  control: Record<string, unknown>;
  expected?: RecoveryExpected;
  alive?: (identity: unknown) => boolean | null;
  command?: (pid: number) => string[];
  hash?: (value: string | Buffer) => string;
  sameInstance?: (left: unknown, right: unknown) => boolean;
  currentBuildHash?: (root: string) => string;
}

interface RunOptions {
  archive: string;
  apply?: boolean;
}

const q = runtimeRequire("../../src/queue-instance.js") as QueueInstanceModule;
const { QueueState } = runtimeRequire(
  "../../src/queue-state.js",
) as QueueStateModule;
const { QueueClient } = runtimeRequire(
  "../../src/queue-client.js",
) as QueueClientModule;
const { queueDirectory } = runtimeRequire(
  "../../src/queue-connection.js",
) as QueueConnectionModule;
const { archiveFiles } = runtimeRequire(
  "./install-queue-phases.js",
) as InstallerModule;

export const EXPECTED: RecoveryExpected = Object.freeze({
  jobId: "670c2580-4946-48cf-be43-059032db4f01",
  requestId: "ef3769e2-f8ae-4667-a3a7-db0dc5cbab67",
  clientId: "opencode:8b8255ee3bf479f1fccacb448e5a8124d5d47613",
  sequenceId: "fc102131-47ad-456d-a8db-1697d79342fa",
  buildHash: "caa2ee30599ec1ae1cacb72b713e97c5c15f985ab28257bef36cc2fbda1dc7fe",
  brokerNonce: "9aaf4de8-be31-4a0d-8307-ed6e3d2291ba",
});

export const CORE = [
  "src/queue-broker.js",
  "src/queue-instance.js",
  "src/queue-worker.js",
  "src/client.js",
  "src/addin-client.js",
  "src/curl-transport.js",
];

const terminal = (value: unknown): boolean =>
  ["succeeded", "failed", "expired", "cancelled"].includes(String(value));

export function inspect(options: InspectOptions): Record<string, unknown> {
  const expected = options.expected ?? EXPECTED;
  const digest = options.hash ?? q.hash;
  const alive = options.alive ?? ((identity) => q.priorProcessAlive(identity));
  const command =
    options.command ??
    ((pid) => fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0"));
  const sameInstance = options.sameInstance ?? q.sameInstance;
  const currentBuildHash = options.currentBuildHash ?? q.buildHash;
  const hashes: Record<string, string> = {};
  const read = (file: string): Record<string, unknown> => {
    const bytes = fs.readFileSync(file);
    hashes[file] = digest(bytes);
    return asRecord(JSON.parse(bytes.toString("utf8")) as unknown);
  };
  const marker = read(path.join(options.dir, "broker.lock"));
  const identity = read(path.join(options.dir, "instance.json"));
  const state = read(path.join(options.dir, "queue-state.json"));
  const jobs = asRecord(state.jobs);
  const job = asRecord(jobs[expected.jobId]);
  const directory = path.join(options.dir, "jobs", expected.jobId);
  const markerPid = numberValue(marker.pid);
  assert.equal(marker.nonce, expected.brokerNonce);
  assert.equal(alive(marker), true, "Original broker PID/birth must be alive");
  assert(
    command(markerPid).includes(
      path.join(options.root, "src/queue-autostart-worker.js"),
    ),
    "Not the known local Node supervisor",
  );
  const instance = asRecord(identity.instance);
  assert.notEqual(markerPid, instance.pid, "Never signal the Fusion process");
  assert.equal(identity.buildHash, expected.buildHash);
  assert.equal(options.status.buildHash, expected.buildHash);
  assert.equal(options.status.held, "BUILD_CHANGED");
  assert.equal(options.status.active, expected.jobId);
  assert.equal(options.status.stopping, false);
  assert.equal(options.control.instanceId, marker.nonce);
  assert.equal(
    options.control.activeOperations,
    0,
    "An SDK/transport call is still admitted",
  );
  assert.equal(state.active, expected.jobId);
  assert.equal(asRecord(state.blocked).id, expected.jobId);
  assert.equal(asRecord(state.blocked).reason, "BUILD_CHANGED");
  assert.equal(job.id, expected.jobId);
  assert.equal(job.requestId, expected.requestId);
  assert.equal(job.state, "needs_reconciliation");
  assert.equal(job.clientId, expected.clientId);
  assert.equal(job.sequenceId, expected.sequenceId);
  assert.equal(job.kind, "command");
  const request = asRecord(job.request);
  assert.equal(asArray(request.argv)[0], "run");
  assert.equal(request.buildHash, expected.buildHash);
  assert.equal(asRecord(job.details).reason, "BUILD_CHANGED");
  const lease = asRecord(state.lease);
  assert.equal(lease.id, expected.sequenceId);
  assert.equal(lease.clientId, expected.clientId);
  assert.equal(asRecord(options.status.lease).id, expected.sequenceId);
  assert(
    Object.values(jobs).every((value) => {
      const candidate = asRecord(value);
      return candidate.id === job.id || terminal(candidate.state);
    }),
    "Other unfinished work exists",
  );
  const dispatch = isRecord(job.dispatch) ? job.dispatch : null;
  assert(
    !dispatch ||
      ["dispatchCount", "rpcCount", "completedCount"].every(
        (key) => (dispatch[key] ?? 0) === 0,
      ),
    "Dispatch evidence exists",
  );
  assert.deepEqual(
    fs.readdirSync(directory).sort(),
    ["preflight-start.json"],
    "Unexpected receipt, worker, probe outcome, or dispatch evidence",
  );
  const preflight = read(path.join(directory, "preflight-start.json"));
  assert.equal(preflight.version, 2);
  assert.equal(preflight.jobId, job.id);
  assert.equal(preflight.buildHash, expected.buildHash);
  const binding = asRecord(preflight.binding);
  assert.equal(binding.jobId, job.id);
  assert.equal(binding.buildHash, expected.buildHash);
  assert.match(stringValue(binding.rpcId), /^[a-f0-9-]{36}$/);
  assert.equal(
    binding.requestHash,
    digest(`preflight:${String(job.id)}:${String(binding.rpcId)}`),
  );
  assert.equal(
    preflight.receipt,
    path.join(directory, `preflight-${String(binding.rpcId)}.receipt.json`),
  );
  assert(sameInstance(preflight.instance, identity.instance));
  const baseline = archiveFiles(options.archive);
  const core: Array<{ path: string; sha256: string }> = [];
  for (const file of CORE) {
    const bytes = fs.readFileSync(path.join(options.root, file));
    const original = baseline.get(file);
    assert(original, `Missing baseline source: ${file}`);
    assert.equal(
      digest(bytes),
      digest(original),
      `Legacy execution-boundary source changed: ${file}`,
    );
    core.push({ path: file, sha256: digest(bytes) });
  }
  const source = baseline.get("src/queue-broker.js")?.toString("utf8") ?? "";
  const guard = source.indexOf(
    "if (buildHash() !== codeHash) fail('BUILD_CHANGED', 'Pinned executable build changed')",
  );
  const probe = source.indexOf("const actual = await probe(client", guard);
  assert(
    guard > 0 && probe > guard,
    "Unknown producer: local guard is not before probe submission",
  );
  assert(
    source.includes(
      "if (job) hold(job, error.code || 'BROKER_EXECUTION_FAILED')",
    ),
    "Unknown legacy rejection path",
  );
  assert.notEqual(
    currentBuildHash(options.root),
    expected.buildHash,
    "The local build-mismatch predicate is no longer true",
  );
  return {
    jobId: job.id,
    requestId: job.requestId,
    previousClientId: job.clientId,
    sequenceId: job.sequenceId,
    broker: marker,
    previousBuildHash: expected.buildHash,
    currentBuildHash: currentBuildHash(options.root),
    instance: {
      pid: instance.pid,
      birth: instance.birth,
      version: instance.version,
    },
    paused: state.paused,
    controlRequestIds: Object.keys(
      isRecord(state.controlRequests) ? state.controlRequests : {},
    ),
    hashes,
    reviewedCore: core,
    classification: "not_started",
    source:
      "derived-local-control-flow-evidence; not a native SDK completion receipt",
    reasoning:
      "Exact legacy producer rejects its build before calling probe. The live hold is BUILD_CHANGED, no worker was started, no physical dispatch occurred, and no other work is outstanding.",
    authority:
      "User explicitly instructed: Ok, wrzuc te poprawki i rozwiaz ten problem z blockerem",
    scope:
      "One legacy local rejection and local broker lifecycle only; no MAIN/source ownership transfer, model edit, Fusion restart or replay",
    fusionCalls: 0,
    scriptReplay: false,
  };
}

export async function run(
  options: RunOptions,
): Promise<Record<string, unknown>> {
  const root = runtimeRoot;
  const dir = queueDirectory();
  const client = new QueueClient("fmcad-recovery-isolation-20261020");
  await client.register();
  const observe = async (): Promise<Record<string, unknown>> =>
    inspect({
      dir,
      root,
      archive: options.archive,
      status: asRecord(await client.call("status")),
      control: asRecord(await client.call("control-status")),
    });
  const before = await observe();
  if (!options.apply) return { inspected: true, apply: false, proof: before };
  const pauseId = randomUUID();
  const ctrl = asRecord(await client.call("control-status"));
  await client.call("pause", {
    control: {
      requestId: pauseId,
      instanceId: ctrl.instanceId,
      expectedGeneration: ctrl.generation,
    },
  });
  const proof = await observe();
  assert.equal(proof.paused, true);
  proof.originallyPaused = before.paused;
  proof.operatorPauseId = pauseId;
  proof.originalControlRequestIds = before.controlRequestIds;
  const fence = {
    nonce: randomUUID(),
    pid: process.pid,
    birth: q.processBirth(),
    purpose: "explicit-user-local-preflight-recovery",
  };
  const startup = path.join(dir, "autostart.lock");
  const recovery = path.join(dir, "recovery.lock");
  q.durable(startup, fence, true);
  let recoveryOwned = false;
  let stopped = false;
  let settled = false;
  try {
    q.durable(recovery, fence, true);
    recoveryOwned = true;
    const checkHashes = (): void => {
      const proven = asRecord(proof.hashes);
      for (const [file, digest] of Object.entries(proven))
        assert.equal(
          q.hash(fs.readFileSync(file)),
          digest,
          `Evidence changed: ${file}`,
        );
    };
    const broker = asRecord(proof.broker);
    assert.equal(q.processBirth(numberValue(broker.pid)), broker.birth);
    process.kill(numberValue(broker.pid), "SIGSTOP");
    stopped = true;
    checkHashes();
    assert.deepEqual(
      fs.readdirSync(path.join(dir, "jobs", stringValue(proof.jobId))).sort(),
      ["preflight-start.json"],
    );
    const evidenceFile = path.join(
      dir,
      `operator-local-preflight-${fence.nonce}.json`,
    );
    q.durable(
      evidenceFile,
      { ...proof, at: new Date().toISOString(), operator: fence },
      true,
    );
    assert.equal(q.processBirth(numberValue(broker.pid)), broker.birth);
    process.kill(numberValue(broker.pid), "SIGKILL");
    stopped = false;
    for (
      let index = 0;
      index < 100 && q.priorProcessAlive(broker) !== false;
      index++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(
      q.priorProcessAlive(broker),
      false,
      "Old local supervisor termination unproven",
    );
    checkHashes();
    const queue = new QueueState(dir);
    const details = {
      state: "failed",
      code: "OPERATOR_LOCAL_PREFLIGHT_NOT_STARTED",
      evidenceFile,
      executionOutcome: "not_started",
      userScriptSubmitted: false,
      mayHaveMutated: false,
      limitations:
        "Derived evidence for this exact legacy local guard, not a synthetic SDK receipt. No prior HEAD changes are rolled back or validated.",
    };
    q.durable(
      path.join(dir, "jobs", stringValue(proof.jobId), "outcome.json"),
      details,
    );
    const result = queue.resolve(stringValue(proof.jobId), details);
    assert.equal(asRecord(queue.status()).paused, true);
    q.durable(
      path.join(dir, `reclaimed-${fence.nonce}.json`),
      { ...broker, evidenceFile, source: details.code },
      true,
    );
    assert.deepEqual(q.readJson(path.join(dir, "broker.lock")), broker);
    fs.unlinkSync(path.join(dir, "broker.lock"));
    const handoff = {
      at: new Date().toISOString(),
      evidenceFile,
      result,
      originalClientId: proof.previousClientId,
      nextOperator: fence,
      scope: proof.scope,
      pendingRemoteRequests: 0,
      originallyPaused: before.paused,
      operatorPauseId: pauseId,
      originalControlRequestIds: before.controlRequestIds,
      brokerStopped: true,
      fusionRestarted: false,
    };
    const handoffFile = path.join(
      dir,
      `operator-local-handoff-${fence.nonce}.json`,
    );
    q.durable(handoffFile, handoff, true);
    settled = true;
    return {
      reconciled: true,
      evidenceFile,
      handoffFile,
      job: result,
      paused: true,
      brokerStopped: true,
      fusionCalls: 0,
    };
  } finally {
    const broker = asRecord(proof.broker);
    if (stopped && q.priorProcessAlive(broker) === true)
      process.kill(numberValue(broker.pid), "SIGCONT");
    if (settled || q.priorProcessAlive(broker) === true) {
      if (recoveryOwned && asRecord(q.readJson(recovery)).nonce === fence.nonce)
        fs.unlinkSync(recovery);
      if (asRecord(q.readJson(startup)).nonce === fence.nonce)
        fs.unlinkSync(startup);
    }
  }
}

export function main(args: string[]): Promise<void> {
  const index = args.indexOf("--archive");
  const archive = index >= 0 ? args[index + 1] : undefined;
  if (
    index < 0 ||
    !archive ||
    args.some(
      (arg, position) =>
        position !== index && position !== index + 1 && arg !== "--apply",
    )
  ) {
    throw new Error("Use --archive FROZEN_BASELINE_TGZ [--apply]");
  }
  return run({
    archive: path.resolve(archive),
    apply: args.includes("--apply"),
  })
    .then((value) => console.log(JSON.stringify(value, null, 2)))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value), "Expected an object record");
  return value;
}

function asArray(value: unknown): unknown[] {
  assert.ok(Array.isArray(value), "Expected an array");
  return value;
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Expected a string");
  return value;
}

function numberValue(value: unknown): number {
  if (typeof value !== "number") throw new TypeError("Expected a number");
  assert(Number.isSafeInteger(value));
  return value;
}

export { runtimeRoot };

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { TestContext } from "node:test";
import os from "node:os";
import type { DeadEpochFixture } from "./fixtures/epoch-fixture-types";

const repo = process.cwd();
const load = createRequire(
  path.join(repo, "tests/sdk1-metadata-worker-retirement.test.ts"),
);
const { retireSdk1MetadataWorker } = load(
  "../dist/src/dist/composition/queue-epoch-successor-retirement.js",
) as typeof import("../src/composition/queue-epoch-successor-retirement");
const api = load("../src/queue-instance") as {
  hash(value: string | Uint8Array): string;
  durable(file: string, value: unknown, exclusive?: boolean): void;
  processBirth(pid?: number): string;
  priorProcessAlive(value: unknown): boolean | null;
};
const lineage = load("../src/queue-epoch-lineage") as {
  reference(file: string): { path: string; sha256: string };
};
const { preparePythonArtifact } = load("../src/dist/python/artifact") as {
  preparePythonArtifact(
    units: Array<{
      id: string;
      filename: string;
      source: string;
      role: "runtime" | "wrapper" | "user";
    }>,
    metadata: { context: unknown; request: unknown },
  ): { script: string; sha256: string; artifactHash: string };
};
const { pythonArtifactManifest } = load(
  "../src/dist/python/context-binding",
) as {
  pythonArtifactManifest(artifact: unknown): Record<string, unknown>;
};
const reference = (file: string) => lineage.reference(file);

async function fixture(t: TestContext) {
  const base = fs.mkdtempSync(
    path.join(os.tmpdir(), "sdk1-worker-retirement-"),
  );
  const f = (
    load("./fixtures/dead-epoch-successor.cjs") as (
      base: string,
      repo: string,
    ) => DeadEpochFixture
  )(base, repo);
  fs.rmSync(path.join(f.audit, "isolated-scratch-qualification"), {
    recursive: true,
  });

  const expectedProcess = {
      pid: 2147483646,
      birth: "134391194634692184",
    },
    authorityFile = path.join(f.audit, "authority.json"),
    authority = { ...f.authority, expectedProcess };
  api.durable(authorityFile, authority);
  f.authority = authority;
  f.authorityEntry = reference(authorityFile);
  f.pointer.succession = f.authorityEntry;
  f.pointer.currentInstance = { ...expectedProcess, version: "synthetic" };
  api.durable(path.join(f.dir, "isolated-admission-epoch.json"), f.pointer);

  const approvalFile = path.join(base, "approval.json"),
    approval = { ...f.approval, expectedProcess };
  api.durable(approvalFile, approval, true);
  f.approval = approval;
  const approvalRef = reference(approvalFile);
  const guard = {
    kind: "dead-epoch-successor",
    nonce: f.nonce,
    audit: f.audit,
    clientId: f.clientId,
  };
  api.durable(path.join(f.audit, "intent.json"), {
    version: 1,
    requestId: f.requestId,
    clientId: f.clientId,
    ownerTokenHash: api.hash(f.token),
    nonce: f.nonce,
    approval: approvalRef,
    previousOwner: f.previousOwner,
  });
  api.durable(path.join(f.audit, "launch-intent.json"), {
    nonce: f.nonce,
    authority: f.authorityEntry,
  });
  api.durable(path.join(f.audit, "retired-owner.json"), f.previousOwner);
  api.durable(path.join(f.audit, "released-recovery.lock.json"), guard);
  api.durable(path.join(f.audit, "released-atomic-migration.lock.json"), guard);
  api.durable(path.join(f.dir, "active-epoch-succession.json"), {
    version: 1,
    authority: f.authorityEntry,
  });

  const runtime = f.approval.candidateRoot,
    workerPath = path.join(runtime, "src/queue-epoch-successor-worker.js");
  const worker = spawn(process.execPath, [workerPath], {
    cwd: base,
    stdio: ["pipe", "ignore", "ignore"],
  });
  await once(worker, "spawn");
  assert.ok(worker.pid);
  const owner = {
    pid: worker.pid,
    birth: api.processBirth(worker.pid),
    nonce: randomUUID(),
    protocol: 2,
  };
  assert.equal(api.priorProcessAlive(owner), true);
  assert.notEqual(owner.pid, expectedProcess.pid);
  assert.notEqual(owner.birth, expectedProcess.birth);

  api.durable(path.join(f.audit, "worker-claim.json"), {
    pid: owner.pid,
    birth: owner.birth,
    nonce: f.nonce,
  });
  api.durable(path.join(f.audit, "worker-ready.json"), {
    nonce: f.nonce,
    owner,
    buildHash: f.authority.buildHash,
    sdkRequestsSent: 0,
  });
  api.durable(path.join(f.audit, "complete.json"), {
    version: 1,
    kind: "dead-epoch-successor-metadata-ready",
    requestId: f.requestId,
    authority: f.authorityEntry,
    owner,
    buildHash: f.authority.buildHash,
    sourceCommit: f.authority.sourceCommit,
    sdkRequestsSent: 0,
    modelingAdmission: "blocked-until-current-facts-and-proven-new-scratch",
    historicalOutcome: "unknown",
  });
  api.durable(path.join(f.dir, "broker.lock"), owner);
  api.durable(path.join(f.dir, `broker-lifecycle-${owner.nonce}.json`), {
    owner,
    stage: "ready",
    buildHash: f.authority.buildHash,
    configHash: f.authority.configHash,
  });

  const observation = path.join(f.audit, "dead-epoch-current-observation");
  fs.mkdirSync(observation);
  const oldPointer = JSON.parse(
    fs.readFileSync(f.authority.predecessor.pointer.path, "utf8"),
  ) as { quarantinedJobIds: [string, string, ...string[]] };
  const key = {
      jobId: oldPointer.quarantinedJobIds[0],
      observationJobId: oldPointer.quarantinedJobIds[1],
      requestId: f.requestId + ":observe",
      clientId: f.clientId,
    },
    observationIntent = {
      version: 1,
      key,
      binding: {
        purpose: "atomic-recovery-audit-v1",
        clientId: f.clientId,
        expectedProcess,
        successorAuthorityHash: f.authorityEntry.sha256,
      },
      identity: f.auditIdentity,
      sourceSha256: "1".repeat(64),
      sourceArtifactHash: "2".repeat(64),
    },
    observationIntentFile = path.join(observation, "intent.json"),
    observationStartFile = path.join(observation, "start.json"),
    observationWireFile = path.join(observation, "wire.json"),
    observationResultFile = path.join(observation, "result.json"),
    rpcId = randomUUID();
  api.durable(observationIntentFile, observationIntent);
  const binding = {
      jobId: key.jobId,
      rpcId,
      requestHash: "5".repeat(64),
      buildHash: f.authority.buildHash,
      sourceHash: "6".repeat(64),
      purpose: "atomic-recovery-audit-v1",
      auditBindingHash: "7".repeat(64),
      pythonOriginHash: observationIntent.sourceArtifactHash,
      auditExpectedProcess: expectedProcess,
    },
    code = "print('synthetic read-only observation')",
    prepared = preparePythonArtifact(
      [
        {
          id: "wire",
          filename: "<fmcad-wire>",
          source: code,
          role: "wrapper",
        },
      ],
      {
        context: {
          entrypoints: [],
          origin: {
            artifactHash: observationIntent.sourceArtifactHash,
            sha256: binding.sourceHash,
            context: {
              kind: "atomic-recovery-audit-v1",
              purpose: "atomic-recovery-audit-v1",
              clientId: f.clientId,
              expectedProcess,
              successorAuthorityHash: f.authorityEntry.sha256,
            },
            request: { identity: f.auditIdentity },
            sourceMap: [],
            segments: [],
            units: [],
          },
        },
        request: binding,
      },
    ),
    artifact = pythonArtifactManifest(prepared),
    start = {
      binding,
      instance: expectedProcess,
      receipt: path.join(observation, `remote-${rpcId}.json`),
      pythonCheck: {
        status: "passed",
        provenance: {
          artifactHash: prepared.artifactHash,
          wireHash: prepared.sha256,
        },
      },
      originArtifactHash: observationIntent.sourceArtifactHash,
    };
  api.durable(observationStartFile, start);
  const wire = {
    outgoing: {
      jsonrpc: "2.0",
      id: "fmcad:" + rpcId,
      method: "tools/call",
      params: {
        name: "execute_python",
        arguments: { code, persistent: false },
      },
    },
    artifact,
  };
  api.durable(observationWireFile, wire);
  api.durable(observationResultFile, {
    kind: "dead-epoch-current-observation",
    ...key,
    status: "failed",
    code: "ENOENT",
    sdkRequestsSent: 1,
    nativeOutcome: "unknown",
    modelValidation: "not_performed",
    rollbackVerification: "not_performed",
  });

  const bindings = {
      authority: f.authorityEntry,
      observationIntent: reference(observationIntentFile),
      observationStart: reference(observationStartFile),
      observationWire: reference(observationWireFile),
      observationResult: reference(observationResultFile),
    },
    now = Date.now(),
    deathProofFile = path.join(base, "sdk-process-death-proof.json");
  api.durable(deathProofFile, {
    version: 1,
    kind: "sdk-process-death-proof-v1",
    expectedProcess,
    before: {
      state: "present",
      ...expectedProcess,
      version: "synthetic-fusion-version",
      exe: "C:\\Autodesk\\Fusion360.exe",
      windowHandle: "12345",
      observedAtUtc: new Date(now - 5000).toISOString(),
    },
    handleBoundExit: {
      ...expectedProcess,
      hasExited: true,
      observedAtUtc: new Date(now - 3000).toISOString(),
    },
    after: {
      state: "absent",
      pid: expectedProcess.pid,
      observedAtUtc: new Date(now - 2000).toISOString(),
      errorId:
        "NoProcessFoundForGivenId,Microsoft.PowerShell.Commands.GetProcessCommand",
    },
    bindings,
  });

  const status = {
    buildHash: f.authority.buildHash,
    sourceCommit: f.authority.sourceCommit,
    held: "Qualified isolated scratch process is unavailable; metadata only, no SDK or replacement authority",
    stopping: false,
    deadEpochSuccessor: {
      requestId: f.requestId,
      currentFactsAvailable: false,
      expectedProcess,
    },
    features: {
      auditFactsCapture: false,
      atomicRecoveryProcessLossAudit: false,
    },
    control: {
      instanceId: owner.nonce,
      buildHash: f.authority.buildHash,
      activeOperations: 0,
      activeIds: [],
      unresolved: true,
      phase: "RECOVERY_BLOCKED",
    },
  };
  const client = {
    dir: f.dir,
    auth: { clientId: f.clientId, clientToken: f.token },
    async call(action: string) {
      assert.equal(action, "queue-summary");
      return structuredClone(status);
    },
  };
  t.after(async () => {
    worker.stdin?.end();
    if (worker.exitCode === null && worker.signalCode === null) {
      const exited = once(worker, "exit");
      await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
    }
    if (worker.exitCode === null && worker.signalCode === null)
      worker.kill("SIGTERM");
    fs.rmSync(base, { recursive: true, force: true });
  });
  return {
    ...f,
    base,
    approvalFile,
    client,
    owner,
    worker,
    status,
    deathProofFile,
    observationFiles: [
      observationIntentFile,
      observationStartFile,
      observationWireFile,
      observationResultFile,
    ],
  };
}

function absentSdkPorts() {
  return {
    certify() {},
    deathQuery(expected: { pid: number }) {
      return {
        state: "absent" as const,
        pid: expected.pid,
        errorId:
          "NoProcessFoundForGivenId,Microsoft.PowerShell.Commands.GetProcessCommand",
        observedAtUtc: new Date().toISOString(),
      };
    },
  };
}

test("SDK1 retirement is append-only and targets only its exact quiescent metadata worker", async (t) => {
  const f = await fixture(t);
  const preserved = [
      f.approvalFile,
      path.join(f.audit, "authority.json"),
      ...f.observationFiles,
      f.deathProofFile,
      path.join(f.dir, "broker.lock"),
    ],
    before = preserved.map((file) => fs.readFileSync(file)),
    exit = once(f.worker, "exit");
  const result = await retireSdk1MetadataWorker(
    f.client,
    f.approvalFile,
    f.deathProofFile,
    true,
    absentSdkPorts(),
  );
  const [code, signal] = await exit;
  assert.equal(code, null);
  assert.equal(signal, "SIGKILL");
  assert.ok("kind" in result);
  assert.equal(result.kind, "sdk1-metadata-worker-retirement-complete");
  assert.equal(result.status, "retired");
  assert.equal(result.owner.pid, f.owner.pid);
  assert.equal(result.owner.birth, f.owner.birth);
  assert.equal(result.sdkRequestsSent, 1);
  assert.equal(result.nativeOutcome, "unknown");
  assert.equal(result.historicalOutcome, "unknown");
  assert.equal(result.protectedBytesUnchanged, true);
  assert.deepEqual(result.processDeathProof, reference(f.deathProofFile));
  const retirementDir = path.join(f.audit, "sdk1-worker-retirement"),
    beforeProof = JSON.parse(
      fs.readFileSync(path.join(retirementDir, "before.json"), "utf8"),
    ) as Record<string, unknown>,
    startProof = JSON.parse(
      fs.readFileSync(path.join(retirementDir, "effect-start.json"), "utf8"),
    ) as Record<string, unknown>;
  assert.equal(beforeProof["kind"], "sdk1-metadata-worker-retirement-before");
  assert.equal(
    startProof["kind"],
    "sdk1-metadata-worker-retirement-effect-start",
  );
  assert.deepEqual(
    result.before,
    reference(path.join(retirementDir, "before.json")),
  );
  assert.deepEqual(
    result.effectStart,
    reference(path.join(retirementDir, "effect-start.json")),
  );
  for (const [index, file] of preserved.entries())
    assert.deepEqual(fs.readFileSync(file), before[index]);
  assert.deepEqual(
    fs.readFileSync(path.join(f.dir, "broker.lock")),
    before.at(-1),
  );
});

test("SDK1 retirement refuses a live or reused old SDK PID", async (t) => {
  const f = await fixture(t);
  let processChecks = 0;
  const ports = {
    certify() {},
    deathQuery(expected: { pid: number }) {
      processChecks++;
      return {
        state: "present" as const,
        pid: expected.pid,
        birth: "different-reused-birth",
        observedAtUtc: new Date().toISOString(),
      };
    },
  };
  await assert.rejects(
    retireSdk1MetadataWorker(
      f.client,
      f.approvalFile,
      f.deathProofFile,
      true,
      ports,
    ),
    /Fresh exact-PID OS absence/,
  );
  assert.equal(processChecks, 1);
  assert.equal(api.priorProcessAlive(f.owner), true);
  assert.equal(
    fs.existsSync(path.join(f.audit, "sdk1-worker-retirement")),
    false,
  );
});

test("SDK1 retirement refuses a failed or ambiguous old-SDK OS query", async (t) => {
  const f = await fixture(t);
  const ports = {
    certify() {},
    deathQuery(expected: { pid: number }) {
      return {
        state: "absent" as const,
        pid: expected.pid,
        errorId: "AccessDenied,Microsoft.PowerShell.Commands.GetProcessCommand",
        observedAtUtc: new Date().toISOString(),
      };
    },
  };
  await assert.rejects(
    retireSdk1MetadataWorker(
      f.client,
      f.approvalFile,
      f.deathProofFile,
      true,
      ports,
    ),
    /Fresh exact-PID OS absence/,
  );
  assert.equal(api.priorProcessAlive(f.owner), true);
});

test("SDK1 retirement refuses a foreign metadata-worker owner", async (t) => {
  const f = await fixture(t);
  api.durable(path.join(f.dir, "broker.lock"), {
    ...f.owner,
    pid: f.owner.pid + 1,
  });
  await assert.rejects(
    retireSdk1MetadataWorker(
      f.client,
      f.approvalFile,
      f.deathProofFile,
      true,
      absentSdkPorts(),
    ),
    /Exact live metadata worker/,
  );
  assert.equal(api.priorProcessAlive(f.owner), true);
});

test("SDK1 retirement refuses changed historical wire and missing death proof", async (t) => {
  const f = await fixture(t);
  const wireFile = path.join(
      f.audit,
      "dead-epoch-current-observation",
      "wire.json",
    ),
    wire = JSON.parse(fs.readFileSync(wireFile, "utf8")) as {
      outgoing: { params: { arguments: { code: string } } };
      artifact: Record<string, unknown>;
    };
  wire.outgoing.params.arguments.code += "\n# changed bytes";
  api.durable(wireFile, wire);
  await assert.rejects(
    retireSdk1MetadataWorker(
      f.client,
      f.approvalFile,
      f.deathProofFile,
      true,
      absentSdkPorts(),
    ),
  );
  assert.equal(api.priorProcessAlive(f.owner), true);

  const fresh = await fixture(t);
  await assert.rejects(
    retireSdk1MetadataWorker(
      fresh.client,
      fresh.approvalFile,
      path.join(fresh.base, "missing-death-proof.json"),
      true,
      absentSdkPorts(),
    ),
  );
  assert.equal(api.priorProcessAlive(fresh.owner), true);
});

test("SDK1 retirement refuses a worker with active dispatch", async (t) => {
  const f = await fixture(t);
  f.status.control.activeOperations = 1;
  await assert.rejects(
    retireSdk1MetadataWorker(
      f.client,
      f.approvalFile,
      f.deathProofFile,
      true,
      absentSdkPorts(),
    ),
    /not quiescent/,
  );
  assert.equal(api.priorProcessAlive(f.owner), true);
});

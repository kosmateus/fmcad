import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { TestContext } from "node:test";
import type { AuditFiles } from "../packages/node-adapters/src/execution/epoch-prerequisite";
interface MutatedEvidence {
  status?: string;
  endpointVerified?: boolean;
  sdkRequestsSent?: number;
  nativeOutcome?: string;
  rollbackVerification?: string;
  clientId?: string;
  outcome?: string;
  terminal?: boolean;
  sourceHash?: string;
  currentModelingAdmission?: string;
  summary: {
    modulePresent?: boolean;
    commandDefinition?: unknown;
    ui?: unknown;
  };
  currentInstance: { birth: string };
  currentAuditInstance: { birth: string };
  pythonCheck: { status: string };
  outgoing: { params: { arguments: { code: string } } };
}

const repository = process.cwd();
const load = createRequire(
  path.join(repository, "tests", "epoch-prerequisite.test.js"),
);

// Only these synthetic physical/checker fixtures emulate WSL path spelling.
test.beforeEach((t) =>
  (t as TestContext).after(
    (load("./fixtures/fake-wsl-platform.cjs") as () => () => void)(),
  ),
);

const {
  epochAuditPrerequisite,
  epochPrerequisiteStillCurrent,
  inheritedEpochPause,
} = load(
  "../src/queue-epoch-prerequisite",
) as typeof import("../src/queue-epoch-prerequisite");
const { durable, processBirth, hash } = load(
  "../src/queue-instance",
) as ReturnType<
  typeof import("../packages/node-adapters/src/execution/queue-instance").createQueueInstance
>;
const { fileHash } = load(
  "../src/queue-atomic-migration-files",
) as typeof import("../packages/node-adapters/src/persistence/migration-files");
function fixture(t: TestContext) {
  const root = fs.mkdtempSync("/tmp/opencode/epoch-prerequisite-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scope = {
    jobId: "holder",
    observationJobId: "3627db2e-0b9d-4e4f-927f-20cb45deae74",
  };
  const current = { pid: process.pid, birth: processBirth(), version: "2706" };
  const original = {
    pid: 2147483646,
    birth: "terminated:fixture",
    version: "2706",
  };
  const identity = {
    commandId: "fmcad_atomic_" + "a".repeat(32),
    sessionNonce: "b".repeat(32),
    resolvedIdentity: {
      name: "Historical",
      creationId: "historical-id",
      fileId: null,
    },
  };
  const f = (
    load("./fixtures/epoch-audit.cjs") as (...args: unknown[]) => {
      files: AuditFiles;
    }
  )(root, scope, identity, current, original, { nonce: "departing-broker" });
  return {
    ...f,
    root,
    scope,
    approved: { currentInstance: current },
    read: () =>
      epochAuditPrerequisite(
        f.files,
        root,
        { currentInstance: current },
        scope,
      ),
    replace(name: keyof AuditFiles, value: unknown) {
      durable(f.files[name].path, value);
      f.files[name].sha256 = fileHash(f.files[name].path).sha256;
    },
  };
}
test("only complete bound process-loss migration plus actual durable current audit qualifies", (t) => {
  const f = fixture(t),
    proof = f.read();
  assert.equal(proof.clientId, "original-owner");
  assert.equal(proof.historicalOutcome, "unknown");
  assert.equal(epochPrerequisiteStillCurrent(proof), true);
  durable(f.files.auditResult.path, { merelyPublicStatus: "ready" });
  assert.equal(epochPrerequisiteStillCurrent(proof), false);
  assert.throws(f.read);
});
for (const [name, record, mutate] of [
  [
    "failed audit",
    "auditResult",
    (x) => {
      x.status = "failed";
    },
  ],
  [
    "unverified endpoint",
    "auditResult",
    (x) => {
      x.endpointVerified = false;
    },
  ],
  [
    "zero physical turns",
    "auditResult",
    (x) => {
      x.sdkRequestsSent = 0;
    },
  ],
  [
    "terminal historical claim",
    "auditResult",
    (x) => {
      x.nativeOutcome = "aborted";
    },
  ],
  [
    "rollback fabrication",
    "auditResult",
    (x) => {
      x.rollbackVerification = "passed";
    },
  ],
  [
    "foreign client",
    "auditResult",
    (x) => {
      x.clientId = "foreign";
    },
  ],
  [
    "surviving native holder",
    "auditResult",
    (x) => {
      x.summary.modulePresent = true;
    },
  ],
  [
    "surviving definition",
    "auditResult",
    (x) => {
      x.summary.commandDefinition = {
        status: "foreign_or_invalid",
        idMatches: false,
        isNative: true,
        isValid: true,
      };
    },
  ],
  [
    "busy current instance",
    "auditResult",
    (x) => {
      x.summary.ui = { activeCommand: "ExtrudeCommand", idle: false };
    },
  ],
  [
    "old selected process",
    "auditResult",
    (x) => {
      x.currentInstance.birth = "other";
    },
  ],
  [
    "unsuccessful physical receipt",
    "remoteReceipt",
    (x) => {
      x.outcome = "failed";
    },
  ],
  [
    "uncertain physical receipt",
    "remoteReceipt",
    (x) => {
      x.terminal = false;
    },
  ],
  [
    "substituted source receipt",
    "remoteReceipt",
    (x) => {
      x.sourceHash = "foreign-source";
    },
  ],
  [
    "checker not passed",
    "auditStart",
    (x) => {
      x.pythonCheck.status = "incomplete";
    },
  ],
  [
    "forged final bytes",
    "auditWire",
    (x) => {
      x.outgoing.params.arguments.code += "\n# changed";
    },
  ],
  [
    "wrong process migration",
    "migrationComplete",
    (x) => {
      x.currentAuditInstance.birth = "other";
    },
  ],
  [
    "modeling falsely released",
    "migrationComplete",
    (x) => {
      x.currentModelingAdmission = "open";
    },
  ],
] satisfies ReadonlyArray<
  readonly [string, keyof AuditFiles, (x: MutatedEvidence) => void]
>)
  test("even rehashed evidence rejects " + name, (t) => {
    const f = fixture(t),
      entry = f.files[record],
      value = JSON.parse(
        fs.readFileSync(entry.path, "utf8"),
      ) as MutatedEvidence;
    mutate(value);
    f.replace(record, value);
    assert.throws(f.read);
  });

test("public health alone, a substituted path or an extra proof field cannot authorize document creation", (t) => {
  const f = fixture(t);
  assert.throws(() =>
    epochAuditPrerequisite({ ready: true }, f.root, f.approved, f.scope),
  );
  assert.throws(() =>
    epochAuditPrerequisite(
      { ...f.files, extra: f.files.auditResult },
      f.root,
      f.approved,
      f.scope,
    ),
  );
  const copy = path.join(
    path.dirname(f.files.auditResult.path),
    "unbound-result.json",
  );
  fs.copyFileSync(f.files.auditResult.path, copy);
  assert.throws(() =>
    epochAuditPrerequisite(
      {
        ...f.files,
        auditResult: { path: copy, sha256: fileHash(copy).sha256 },
      },
      f.root,
      f.approved,
      f.scope,
    ),
  );
});

function inherited(t: TestContext) {
  const f = fixture(t),
    proof = f.read(),
    preceding = path.join(f.root, "first-complete.json");
  const pauseId = "first-migration:pause";
  durable(
    preceding,
    {
      requestId: "first-migration",
      previousOwner: { nonce: "first-departed-broker" },
      originalBuildHash: "original-build",
    },
    true,
  );
  const lifecycle = path.join(
    f.root,
    "lifecycle-control-" + hash(pauseId) + ".json",
  );
  const pause = {
    status: "completed",
    binding: {
      action: "pause",
      clientId: "original-owner",
      requestId: pauseId,
      instanceId: "first-departed-broker",
      buildHash: "original-build",
      expectedGeneration: 24,
    },
    result: {
      requestId: pauseId,
      instanceId: "first-departed-broker",
      buildHash: "original-build",
      generation: 25,
      contextEpoch: 12,
      gateClosed: true,
      activeOperations: 0,
      activeIds: [],
    },
  };
  durable(lifecycle, pause, true);
  const snapshot = {
    owner: { nonce: "departing-broker" },
    identity: { buildHash: "original-build" },
    state: {
      paused: true,
      controlGeneration: 25,
      contextEpoch: 12,
      controlRequests: { [pauseId]: { paused: true, generation: 25 } },
    } as {
      paused: boolean;
      controlGeneration: number;
      contextEpoch: number;
      controlRequests: Record<string, { paused: boolean; generation: number }>;
      extra?: boolean;
    },
    status: {
      paused: true,
      control: {
        instanceId: "departing-broker",
        generation: 25,
        contextEpoch: 12,
        gateClosed: true,
        activeOperations: 0,
        activeIds: [],
      },
    },
  };
  return {
    f,
    pause,
    lifecycle,
    args: {
      initial: structuredClone(snapshot),
      current: structuredClone(snapshot),
      intent: {
        nonce: "next-epoch-migration",
        binding: { clientId: "original-owner", requestId: "epoch-upgrade" },
      },
      upgrade: {
        epochPrerequisite: proof,
        previousComplete: { path: preceding },
      },
      clientId: "original-owner",
      dir: f.root,
    },
  };
}
test("epoch upgrade truthfully adopts the authenticated inherited closed pause without a public pause RPC", (t) => {
  const f = inherited(t),
    adoption = inheritedEpochPause(f.args);
  assert.equal(adoption.publicPauseSent, false);
  assert.equal(adoption.sdkRequestsSent, 0);
  assert.equal(adoption.migrationNonce, "next-epoch-migration");
});
for (const [name, change] of [
  [
    "foreign owner",
    (f) => {
      f.args.clientId = "foreign";
    },
  ],
  [
    "changed history",
    (f) => {
      f.args.current.state.extra = true;
    },
  ],
  [
    "stale generation",
    (f) => {
      f.args.current.status.control.generation++;
    },
  ],
  [
    "active SDK",
    (f) => {
      f.args.current.status.control.activeOperations = 1;
    },
  ],
  [
    "wrong pause lineage",
    (f) => {
      f.pause.binding.instanceId = "foreign-broker";
      durable(f.lifecycle, f.pause);
    },
  ],
  [
    "incomplete pause",
    (f) => {
      f.pause.status = "pending";
      durable(f.lifecycle, f.pause);
    },
  ],
  [
    "changed durable audit",
    (f) => {
      durable(f.f.files.auditResult.path, { forged: true });
    },
  ],
] satisfies ReadonlyArray<
  readonly [string, (f: ReturnType<typeof inherited>) => void]
>)
  test("inherited epoch pause rejects " + name, (t) => {
    const f = inherited(t);
    change(f);
    assert.throws(() => inheritedEpochPause(f.args));
  });

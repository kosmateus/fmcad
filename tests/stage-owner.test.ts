import type { StageOwnerPorts } from "../packages/node-adapters/src/persistence/stage-owner";
import type { WorkerNodePorts } from "../packages/node-adapters/src/execution/worker";
import type { QueueJob, FmcadConfiguration } from "@fmcad/core";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { TestContext } from "node:test";
import {
  object,
  field,
  rows,
  string,
  number,
  present,
} from "./modeling-unit-test-support";
const sourceDirectory = path.join(process.cwd(), "tests");
const sourceFile = path.join(sourceDirectory, "stage-owner.test.ts");
const loadModule = createRequire(sourceFile);

const { QueueState } = loadModule(
  "../src/queue-state",
) as typeof import("../src/queue-state");
const { retainAdmission } = loadModule(
  "../src/dist/node-adapters/persistence/accepted-inputs",
) as typeof import("../packages/node-adapters/src/persistence/accepted-inputs");
const { durable, readJson } = loadModule(
  "../src/dist/node-adapters/persistence/records",
) as typeof import("../packages/node-adapters/src/persistence/records");
const { createAuthenticatedStageOwner } = loadModule(
  "../src/dist/node-adapters/persistence/stage-owner",
) as typeof import("../packages/node-adapters/src/persistence/stage-owner");
const { createAuthenticatedStageDependencies } = loadModule(
  "../src/composition/stage-dependencies",
) as typeof import("../src/composition/stage-dependencies");
const documentPublication = loadModule(
  "../src/document-publication",
) as typeof import("../src/composition/document-publication");
const { runWorker } = loadModule(
  "../src/dist/node-adapters/execution/worker",
) as typeof import("../packages/node-adapters/src/execution/worker");
const core = loadModule(
  "../src/dist/core/application/stage-journal",
) as typeof import("../packages/core/src/application/stage-journal");
const { canonical } = loadModule(
  "../src/dist/core/application/cad/json",
) as typeof import("../packages/core/src/application/cad/json");
const instance = loadModule("../src/queue-instance") as ReturnType<
  typeof import("../packages/node-adapters/src/execution/queue-instance").createQueueInstance
>;

const sha = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const nativeIdentity = {
  commandId: "fmcad_atomic_" + "a".repeat(32),
  runId: "run-stage-owner",
  requestHash: "b".repeat(64),
  sessionNonce: "c".repeat(32),
  resolvedIdentity: { creationId: "creation-1" },
};
const document = {
  creationId: "creation-1",
  fileId: "file-1",
  projectId: "project-1",
  name: "Part",
  version: 8,
};

test("stage owner uses the trusted admission snapshot while retaining broker-root accepted bytes and job receipts", (t) => {
  const f = fixture(t, { seedStage: false });
  const admission = path.join(f.broker, "admission-epochs", "synthetic-epoch");
  fs.mkdirSync(admission, { recursive: true });
  for (const name of ["queue-state.json", "instance.json"]) {
    fs.copyFileSync(path.join(f.broker, name), path.join(admission, name));
  }
  durable(path.join(f.broker, "queue-state.json"), { version: 1, jobs: {} });
  durable(path.join(f.broker, "instance.json"), {
    buildHash: "historical-build",
    instance: {},
  });
  let selected = admission;
  const owner = createAuthenticatedStageOwner({
    ...f.ports,
    admissionDirectory: () => selected,
  });
  assert.equal(owner.job.id, f.job.id);
  assert.equal(owner.operationDirectory, f.directory);
  assert.equal(owner.owner.scope.build, f.build);
  selected = f.broker;
  const readiness = present(owner.evidence.ownerReady)(owner.owner.scope);
  assert.equal(readiness.ready, false);
  assert.match(present(readiness.reason), /admission epoch changed/);
});

test("stage owner refuses a pending admission snapshot even when root history is clean", (t) => {
  const f = fixture(t, { seedStage: false });
  const admission = path.join(f.broker, "admission-epochs", "synthetic-epoch");
  fs.mkdirSync(admission, { recursive: true });
  fs.copyFileSync(
    path.join(f.broker, "queue-state.json"),
    path.join(admission, "queue-state.json"),
  );
  durable(path.join(admission, "queue-state.pending.json"), {});
  assert.throws(
    () =>
      createAuthenticatedStageOwner({
        ...f.ports,
        admissionDirectory: () => admission,
      }),
    /durability marker/,
  );
});

test("helper stages bind an unsaved document only with a complete matching physical preflight", async (t) => {
  const source = fs.mkdtempSync("/tmp/opencode/unsaved-stage-source-");
  t.after(() => fs.rmSync(source, { recursive: true, force: true }));
  const file = path.join(source, "fixture.py");
  fs.writeFileSync(
    file,
    "ARGS = {}\nDOC_NAME = None\ndef run(_context):\n    return None\n",
  );
  const payload = {
    version: 1,
    kind: "run",
    request: {
      name: file,
      args: {},
      hasArgs: true,
      doc: document.name,
      identity: { docId: document.creationId },
      helperVersion: "cad-v1",
      readOnlyOperations: [],
    },
  };
  const f = fixture(t, { seedStage: false, payload, extraInputs: [file] });
  const preflightFile = path.join(f.directory, "preflight.json");
  const preflight = readJson(preflightFile);
  object(field(preflight, "instance", "documents", 0))["fileId"] = null;
  object(field(preflight, "instance", "documents", 0))["isSaved"] = false;
  Object.assign(
    object(field(preflight, "instance", "documentState", "state", "identity")),
    { fileId: null, version: null, isSaved: false },
  );
  durable(preflightFile, preflight);
  const deps = await createAuthenticatedStageDependencies({
    brokerDirectory: f.broker,
    jobId: f.job.id,
    clientId: f.job.clientId,
    projectDirectory: f.project,
    buildHash: f.build,
  });
  assert.equal(present(deps).owner.owner.pinnedDocument.fileId, null);
  assert.equal(
    present(deps).owner.owner.pinnedDocument.creationId,
    document.creationId,
  );
  await present(present(deps).helper).plan();
  assert.equal(
    present(present(deps).helper).context().stage.id,
    "python.helpers.run",
  );
  object(field(preflight, "instance", "documentState", "state", "identity"))[
    "isSaved"
  ] = true;
  durable(preflightFile, preflight);
  await assert.rejects(
    createAuthenticatedStageDependencies({
      brokerDirectory: f.broker,
      jobId: f.job.id,
    }),
    /incomplete document pin/,
  );
});

test("physical stage-owner consumers retain preflight-first ordering; ordinary typed CAD stays phaseable", () => {
  const { requiresPhysicalStageOwner: needs } = loadModule(
    "../src/composition/stage-dependencies",
  ) as typeof import("../src/composition/stage-dependencies");
  assert.equal(
    needs({ kind: "run", request: { helperVersion: "cad-v1" } }),
    true,
  );
  for (const operation of [
    "document.save.once",
    "batch.run",
    "definition.instantiate",
  ]) {
    assert.equal(needs({ kind: "cad", operation }), true);
    assert.equal(
      needs({ kind: "cad-command", invocation: { operation } }),
      true,
    );
  }
  for (const operation of ["document.status", "shape.box", "measure.volume"])
    assert.equal(needs({ kind: "cad", operation }), false);
  assert.equal(needs({ kind: "run", request: {} }), false);
});

test(
  "production checker accepts containment with the actual authenticated unsaved helper stage context",
  {},
  async (t) => {
    t.after(
      (loadModule("./fixtures/fake-wsl-platform.cjs") as () => () => void)(),
    );
    const file = path.resolve(
      sourceDirectory,
      "../assets/native-qualification/containment.py",
    );
    const args = {
      approved: true,
      creationId: document.creationId,
      expectedFusionVersion: "Fusion-test",
      fixturePrefix: "NQSTAGECONTAINMENT",
    };
    const payload = {
      version: 1,
      kind: "run",
      request: {
        name: file,
        args,
        hasArgs: true,
        doc: document.name,
        identity: { docId: document.creationId },
        helperVersion: "cad-v1",
        readOnlyOperations: [],
      },
    };
    const f = fixture(t, { seedStage: false, payload, extraInputs: [file] });
    const preflightFile = path.join(f.directory, "preflight.json"),
      preflight = readJson(preflightFile);
    Object.assign(object(field(preflight, "instance", "documents", 0)), {
      fileId: null,
      isSaved: false,
    });
    Object.assign(
      object(
        field(preflight, "instance", "documentState", "state", "identity"),
      ),
      { fileId: null, version: null, isSaved: false },
    );
    durable(preflightFile, preflight);
    const deps = await createAuthenticatedStageDependencies({
      brokerDirectory: f.broker,
      jobId: f.job.id,
      clientId: f.job.clientId,
      projectDirectory: f.project,
      buildHash: f.build,
    });
    await present(present(deps).helper).plan();
    const artifact = (
      loadModule("../src/run") as typeof import("../src/composition/run")
    ).prepareRunScript(
      file,
      args,
      true,
      document.name,
      { docId: document.creationId },
      "cad-v1",
      [],
      { trustedStageContext: present(present(deps).helper).context() },
    );
    const expectedDocument = {
      name: document.name,
      creationId: document.creationId,
      fileId: null,
    };
    const prepared = (
      loadModule(
        "../src/queue-atomic-recovery-audit",
      ) as typeof import("../src/queue-atomic-recovery-audit")
    ).prepareRecoveryAuditWire({
      reader: {
        artifact,
        sourceFile: "<retained-generated-checker-fixture>",
        sourceSha256: (
          loadModule("node:crypto") as typeof import("node:crypto")
        )
          .createHash("sha256")
          .update(artifact.script)
          .digest("hex"),
      },
      receipt: path.join(f.broker, "never-sent.json"),
      instance: f.physical,
      buildHash: f.build,
      jobId: f.job.id,
      auditBinding: {
        purpose: "fixed-native-fixture-v1",
        currentInstance: f.physical,
        expectedDocument,
      },
      payload: {
        jsonrpc: "2.0",
        id: "offline",
        method: "tools/call",
        params: {
          name: "execute_python",
          arguments: {
            code: artifact.script + '\n\nrun("")\n',
            persistent: false,
          },
        },
      },
    });
    const runtime = (
      loadModule(
        "../src/dist/config-platform",
      ) as typeof import("../packages/node-adapters/src/config-platform")
    ).resolveRuntimePaths({ anchor: sourceFile }).runtime;
    const checked = await (
      loadModule(
        "../src/queue-admission",
      ) as typeof import("../src/queue-admission")
    )
      .createProductionQueueAdmission(runtime)
      .admission.check(prepared.outgoing, prepared.artifact);
    assert.equal(present(checked.report).status, "passed");
    checked.fence(prepared.outgoing);
    assert.equal(fs.existsSync(path.join(f.broker, "never-sent.json")), false);
  },
);

function fixture(
  t: TestContext,
  {
    seedStage = true,
    payload: overridePayload,
    argv,
    extraInputs = [],
    clientId = "client-owner",
  }: {
    seedStage?: boolean;
    payload?: Record<string, unknown>;
    argv?: string[];
    extraInputs?: string[];
    clientId?: string;
  } = {},
) {
  const broker = fs.mkdtempSync("/tmp/opencode/stage-owner-");
  t.after(() => fs.rmSync(broker, { recursive: true, force: true }));
  const project = path.join(broker, "project");
  fs.mkdirSync(path.join(project, ".cad"), { recursive: true });
  const inputFile = path.join(project, "accepted.json");
  fs.writeFileSync(inputFile, JSON.stringify({ target: document }));
  const inputBytes = fs.readFileSync(inputFile);
  const request = {
    requestId: "request-owner",
    clientId,
    kind: "command",
    timeoutMs: 60000,
    cwd: project,
    argv: argv ?? ["fmcad", "document", "save", "--file-id", document.fileId],
    payload: overridePayload ?? {
      version: 1,
      kind: "cad",
      operation: "document.save.once",
      data: {
        requestId: "save-request",
        operationId: "save-op",
        projectId: document.projectId,
        fileId: document.fileId,
        creationId: document.creationId,
        expectedVersion: document.version,
        reportPath: path.join(project, ".cad", "save-receipts"),
        confirm: true,
      },
      doc: "Part",
      docId: document.creationId,
      docFileId: document.fileId,
      projectId: document.projectId,
    },
    inputFiles: [
      { path: inputFile, sha256: sha(inputBytes) },
      ...extraInputs.map((file) => ({
        path: file,
        sha256: sha(fs.readFileSync(file)),
      })),
    ],
    sequence: { action: "begin" },
  };
  retainAdmission(broker, request);
  let now = 100;
  const state = new QueueState(broker, { now: () => now++ });
  const submitted = state.submit(request);
  const job = state.next();
  assert.ok(job);
  assert.equal(job.id, submitted["id"]);
  const directory = path.join(broker, "jobs", job.id);
  fs.mkdirSync(directory, { recursive: true });
  const build = instance.buildHash();
  const physical = {
    pid: 123,
    birth: "boot:88",
    version: "Fusion-test",
    activeCommand: "",
  };
  durable(path.join(broker, "instance.json"), {
    buildHash: build,
    instance: physical,
  });
  durable(path.join(directory, "request.json"), {
    id: job.id,
    request: job.request,
    buildHash: build,
  });
  writeObservation(broker, job, build, physical, "preflight");
  const ports = ownerPorts(broker, job.id, build);
  const owner = createAuthenticatedStageOwner(ports);
  const binding = {
    operation: "document.save.once",
    requestId: "save-request",
    operationId: "save-op",
    requestHash: sha(
      canonical({
        requestId: "save-request",
        operationId: "save-op",
        target: document,
      }),
    ),
    target: document,
  };
  const definition = {
    id: "document.save.once",
    requestHash: binding.requestHash,
    mutates: true,
  };
  const reference = sha(Buffer.from(canonical(binding)));
  if (seedStage) {
    owner.stages.plan([definition]);
    owner.stages.started(definition.id, reference);
  }
  return {
    broker,
    project,
    job,
    state,
    directory,
    build,
    physical,
    ports,
    owner,
    binding,
    definition,
    reference,
  };
}

function ownerPorts(
  brokerDirectory: string,
  jobId: string,
  build: string,
  overrides: Partial<StageOwnerPorts> = {},
): StageOwnerPorts {
  return {
    brokerDirectory,
    jobId,
    buildHash: () => build,
    core: {
      canonical,
      createStageApi: core.createStageApi,
      validateStageJournal: core.validateStageJournal,
      inspectStageJournal: core.inspectStageJournal,
      resumeStagePlan: core.resumeStagePlan,
      revalidateStagePlan: core.revalidateStagePlan,
    },
    sameInstance: instance.sameInstance,
    nativeWorkflowIdentity: instance.nativeWorkflowIdentity,
    resolvePinnedDocument({ accepted, preflight }) {
      const source = present(
        accepted.find((item) => item.reference.kind === "source"),
      );
      const payload: unknown = JSON.parse(source.bytes.toString("utf8"));
      const target = object(field(payload, "target"));
      assert.equal(
        rows(field(preflight, "instance", "documents")).some(
          (row) =>
            row["id"] === target["creationId"] &&
            row["fileId"] === target["fileId"],
        ),
        true,
      );
      return {
        creationId: string(target["creationId"]),
        fileId: target["fileId"] === null ? null : string(target["fileId"]),
        projectId: string(target["projectId"]),
        version: number(target["version"]),
      };
    },
    readOriginalReceipt({ stage, reference, lifecycle }) {
      assert.equal(
        stage.requestHash,
        field(
          readJson(
            path.join(brokerDirectory, "jobs", jobId, "operation-receipt.json"),
          ),
          "binding",
          "requestHash",
        ),
      );
      assert.ok(lifecycle.preflightEvidenceSha256);
      assert.ok(lifecycle.postflightEvidenceSha256);
      assert.ok(lifecycle.rpcReceipts.some((item) => item.nativeSha256));
      const bytes = fs.readFileSync(
        path.join(brokerDirectory, "jobs", jobId, "operation-receipt.json"),
      );
      const record = object(JSON.parse(bytes.toString("utf8")));
      if (
        !record["terminal"] ||
        (record["result"] === undefined
          ? undefined
          : field(record, "result", "status")) !== "complete" ||
        record["reference"] !== reference
      )
        return { status: "unknown" };
      return {
        status: "completed",
        sha256: sha(bytes),
        ownerTerminalSha256: sha(bytes),
        nativeTerminalSha256: present(
          present(lifecycle.rpcReceipts.find((item) => item.nativeSha256))
            .nativeSha256,
        ),
        postflightSha256: lifecycle.postflightEvidenceSha256,
      };
    },
    ...overrides,
  };
}

function writeObservation(
  broker: string,
  job: Pick<QueueJob, "id">,
  build: string,
  physical: {
    pid: number;
    birth: string;
    version: string;
    activeCommand: string;
  },
  label: string,
  version = document.version,
) {
  const directory = path.join(broker, "jobs", job.id);
  const rpcId = `${label === "preflight" ? "11111111" : "22222222"}-1111-4111-8111-111111111111`;
  const binding = {
    jobId: job.id,
    rpcId,
    requestHash: sha(`${label}:${job.id}:${rpcId}`),
    buildHash: build,
  };
  const receipt = path.join(directory, `${label}-${rpcId}.receipt.json`);
  durable(
    path.join(directory, `${label}-start.json`),
    {
      version: 2,
      jobId: job.id,
      buildHash: build,
      instance: physical,
      binding,
      receipt,
    },
    true,
  );
  durable(
    receipt,
    { ...binding, terminal: true, outcome: "succeeded", instance: physical },
    true,
  );
  const actual = {
    ...physical,
    documents: [
      {
        id: document.creationId,
        fileId: document.fileId,
        isSaved: true,
        isModified: false,
      },
    ],
    documentState: {
      status: "complete",
      fingerprint: sha(label),
      state: {
        identity: {
          creationId: document.creationId,
          name: document.name,
          fileId: document.fileId,
          version,
        },
      },
    },
  };
  durable(
    path.join(directory, `${label}.json`),
    {
      version: 2,
      jobId: job.id,
      buildHash: build,
      completed: true,
      instance: actual,
      idle: true,
      requiresIdle: true,
    },
    true,
  );
}

function finishLifecycle(
  f: {
    broker: string;
    project: string;
    job: QueueJob;
    directory: string;
    build: string;
    physical: {
      pid: number;
      birth: string;
      version: string;
      activeCommand: string;
    };
    state: InstanceType<typeof QueueState>;
    binding: unknown;
    reference: string;
  },
  {
    workerCode = 0,
    terminal = "succeeded",
    response = true,
    postflightVersion = document.version,
    sourceHash = sha("prepared-original-script"),
  }: {
    workerCode?: number;
    terminal?: string;
    response?: boolean;
    postflightVersion?: number;
    sourceHash?: string;
    workflowOutcome?: unknown;
  } = {},
) {
  const { job, directory, build, physical, state } = f;
  writeObservation(
    f.broker,
    job,
    build,
    physical,
    "postflight",
    postflightVersion,
  );
  const rpcId = "33333333-3333-4333-8333-333333333333";
  const binding = {
    jobId: job.id,
    rpcId,
    requestHash: sha("original-sdk-request"),
    buildHash: build,
    sourceHash,
  };
  const receipt = path.join(directory, `remote-${rpcId}.json`);
  const idleInstance = { ...physical, activeCommand: "" };
  durable(
    receipt,
    {
      ...binding,
      terminal: true,
      outcome: "succeeded",
      instance: idleInstance,
    },
    true,
  );
  durable(
    receipt + ".native-start.json",
    {
      ...binding,
      terminal: false,
      stage: "native-start",
      instance: idleInstance,
      native: { kind: "atomic-batch", identity: nativeIdentity },
    },
    true,
  );
  durable(
    receipt + ".native-end.json",
    {
      ...binding,
      terminal: true,
      stage: "native-completion",
      outcome: "succeeded",
      instance: idleInstance,
      native: {
        kind: "atomic-batch",
        identity: nativeIdentity,
        state: { destroyed: true, completed: true },
      },
    },
    true,
  );
  durable(
    path.join(directory, `rpc-${rpcId}.json`),
    {
      binding,
      receipt,
      instance: idleInstance,
      method: "tools/call",
      terminal: true,
      failed: false,
      nonterminal: false,
      ...(response
        ? {
            response: {
              status: 200,
              raw: JSON.stringify({
                jsonrpc: "2.0",
                id: `fmcad:${rpcId}`,
                result: { content: [] },
              }),
            },
          }
        : {}),
    },
    true,
  );
  state.markDispatch(job.id, {
    rpcCount: 1,
    completedCount: 1,
    rpcId,
    rpcState: "terminal",
  });
  durable(
    path.join(directory, "worker-result.json"),
    {
      jobId: job.id,
      code: workerCode,
      terminal: true,
      nonterminal: false,
      workflowOutcome: { operation: "document.save.once", status: "complete" },
    },
    true,
  );
  durable(
    path.join(directory, "outcome.json"),
    { state: terminal, sdkSettled: true },
    true,
  );
  state.finish(job.id, { state: terminal, code: "EXECUTION_COMPLETE" });
  durable(
    path.join(directory, "operation-receipt.json"),
    {
      binding: f.binding,
      reference: f.reference,
      terminal: true,
      result: { status: "complete" },
    },
    true,
  );
}

test("authenticated job binding and original stage receipt inspect completed lifecycle after process restart", (t) => {
  const f = fixture(t);
  finishLifecycle(f);
  const script = `
    const p=require(${JSON.stringify(loadModule.resolve("../src/dist/node-adapters/persistence/stage-owner"))});
    const c=require(${JSON.stringify(loadModule.resolve("../src/dist/core/application/stage-journal"))});
    const j=require(${JSON.stringify(loadModule.resolve("../src/dist/core/application/cad/json"))});
    const i=require(${JSON.stringify(loadModule.resolve("../src/queue-instance"))});
    const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
    const broker=${JSON.stringify(f.broker)}, jobId=${JSON.stringify(f.job.id)}, build=${JSON.stringify(f.build)}, binding=${JSON.stringify(f.binding)};
    const owner=p.createAuthenticatedStageOwner({brokerDirectory:broker,jobId,buildHash:()=>build,core:{canonical:j.canonical,createStageApi:c.createStageApi,validateStageJournal:c.validateStageJournal,inspectStageJournal:c.inspectStageJournal,resumeStagePlan:c.resumeStagePlan,revalidateStagePlan:c.revalidateStagePlan},sameInstance:i.sameInstance,nativeWorkflowIdentity:i.nativeWorkflowIdentity,
       resolvePinnedDocument({accepted,preflight}){ const x=JSON.parse(accepted.find(a=>a.reference.kind==='source').bytes.toString('utf8')); return Object.fromEntries(['creationId','fileId','projectId','version'].map(k=>[k,x.target[k]])); },
       readOriginalReceipt({stage,reference,lifecycle}){ const file=path.join(broker,'jobs',jobId,'operation-receipt.json'),bytes=fs.readFileSync(file),r=JSON.parse(bytes),sha256=crypto.createHash('sha256').update(bytes).digest('hex'); return stage.requestHash===r.binding.requestHash&&r.reference===reference&&r.terminal&&r.result.status==='complete'?{status:'completed',sha256,ownerTerminalSha256:sha256,nativeTerminalSha256:lifecycle.rpcReceipts.find(x=>x.nativeSha256).nativeSha256,postflightSha256:lifecycle.postflightEvidenceSha256}:{status:'unknown'}; }
    });
    console.log(JSON.stringify(owner.resumePlan()));
  `;
  const child = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);
  const plan: unknown = JSON.parse(child.stdout.trim());
  assert.equal(field(plan, "status"), "valid");
  assert.deepEqual(field(plan, "stages"), [
    { id: "document.save.once", status: "completed" },
  ]);
  assert.equal(field(plan, "nextStage"), null);
  assert.equal(field(plan, "replayAllowed"), false);
  assert.equal(field(plan, "automaticResume"), false);
  assert.equal(
    field(Reflect.apply(f.owner.revalidate, f.owner, [plan]), "valid"),
    true,
  );
  const postflightFile = path.join(f.directory, "postflight.json");
  const postflight = readJson(postflightFile);
  durable(postflightFile, {
    ...object(postflight),
    instance: {
      ...object(field(postflight, "instance")),
      documentState: {
        ...object(field(postflight, "instance", "documentState")),
        fingerprint: "changed",
      },
    },
  });
  assert.equal(
    field(Reflect.apply(f.owner.revalidate, f.owner, [plan]), "valid"),
    false,
  );
  durable(postflightFile, postflight);
  fs.appendFileSync(path.join(f.directory, "operation-receipt.json"), " ");
  assert.equal(
    field(Reflect.apply(f.owner.revalidate, f.owner, [plan]), "valid"),
    false,
  );
});

test("real document-publication stage preserves accepted bytes and survives an acknowledgement loss across processes", async (t) => {
  const f = fixture(t, { seedStage: false });
  const deps = await createAuthenticatedStageDependencies({
    brokerDirectory: f.broker,
    jobId: f.job.id,
    clientId: f.job.clientId,
    projectDirectory: f.project,
  });
  assert.ok(deps);
  assert.ok(deps.document);
  const request = object(field(f.job.request, "payload", "data"));
  const context = {
    doc: document.name,
    docId: document.creationId,
    docFileId: document.fileId,
    projectId: document.projectId,
  };
  let statusReads = 0;
  let saveCalls = 0;
  const executeCad = async (_client: unknown, operation: string) => {
    if (operation === "document.status") {
      statusReads++;
      return {
        success: true,
        result: {
          name: document.name,
          creationId: document.creationId,
          fileId: document.fileId,
          projectId: document.projectId,
          version: statusReads === 1 ? document.version : document.version + 1,
          saved: true,
          modified: statusReads === 1,
          isComplete: true,
          isReadOnly: false,
        },
      };
    }
    if (operation === "document.save_native") {
      saveCalls++;
      throw new Error("ack lost after native save was accepted");
    }
    assert.fail(`unexpected document operation ${operation}`);
  };
  const result = await documentPublication.execute(
    null,
    "document.save.once",
    request,
    context,
    executeCad,
    {
      stages: deps.document.stages,
    },
  );
  assert.equal(field(result, "status"), "unknown");
  assert.equal(saveCalls, 1);
  const observeRequest = { ...request };
  delete observeRequest["confirm"];
  const observed = await documentPublication.execute(
    null,
    "document.save.observe",
    observeRequest,
    context,
    executeCad,
  );
  assert.equal(observed.status, "complete");
  const source = path.join(f.project, "accepted.json");
  fs.writeFileSync(source, "changed after admission");
  finishLifecycle(f, {
    workerCode: 1,
    terminal: "needs_reconciliation",
    response: false,
    postflightVersion: document.version + 1,
  });
  assert.doesNotThrow(() => present(deps).owner.lifecycle());
  const pending = deps.document.resumePlan(
    string(field(result, "stageJournalHead")),
  );
  assert.equal(
    present(pending.stages[0]).status,
    "completed",
    JSON.stringify(pending),
  );
  assert.equal(pending.status, "reconciliationRequired");
  assert.equal(pending.nextStage, null);

  const childScript = `
    (async () => {
      const d = await require(${JSON.stringify(loadModule.resolve("../src/composition/stage-dependencies"))})
        .createAuthenticatedStageDependencies({ brokerDirectory: ${JSON.stringify(f.broker)}, jobId: ${JSON.stringify(f.job.id)}, clientId: ${JSON.stringify(f.job.clientId)}, projectDirectory: ${JSON.stringify(f.project)} });
      process.stdout.write(JSON.stringify(d.document.resumePlan(${JSON.stringify(field(result, "stageJournalHead"))})));
    })().catch(error => { process.stderr.write(error.stack); process.exitCode = 1; });
  `;
  const child = spawnSync(process.execPath, ["-e", childScript], {
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);
  const plan: unknown = JSON.parse(child.stdout);
  assert.equal(field(plan, "status"), "reconciliationRequired");
  assert.equal(field(plan, "stages", 0, "status"), "completed");
  assert.equal(field(plan, "nextStage"), null);
  assert.equal(field(plan, "replayAllowed"), false);
  assert.equal(field(plan, "automaticResume"), false);
  assert.equal(field(plan, "receipts", 0, "sha256", "length"), 64);
  const originalBinding: unknown = Reflect.apply(
    (
      loadModule(
        "../src/dist/core/application/documents/save",
      ) as typeof import("../packages/core/src/application/documents/save")
    ).bindingFor,
    undefined,
    [request],
  );
  const originalStageRef = (
    loadModule(
      "../src/dist/node-adapters/persistence/stage-journal",
    ) as typeof import("../packages/node-adapters/src/persistence/stage-journal")
  ).stageReceiptReference(Buffer.from(canonical(originalBinding), "utf8"));
  const startedEntry = readJson(
    path.join(f.directory, "stages", "00000001.json"),
  );
  assert.equal(field(startedEntry, "event", "receipt"), originalStageRef);
  assert.equal(field(plan, "head"), field(startedEntry, "sha256"));
  const admission = (
    loadModule(
      "../src/dist/node-adapters/persistence/accepted-inputs",
    ) as typeof import("../packages/node-adapters/src/persistence/accepted-inputs")
  ).readAdmission(f.broker, f.job);
  assert.equal(admission.status, "available");
  const originalSource = present(
    admission.inputs.find((input) => input.kind === "source"),
  );
  const restored = (
    loadModule(
      "../src/dist/node-adapters/persistence/accepted-inputs",
    ) as typeof import("../packages/node-adapters/src/persistence/accepted-inputs")
  ).readAcceptedInput(f.broker, originalSource);
  assert.equal(restored.status, "available");
  assert.equal(
    restored.bytes.toString("utf8"),
    JSON.stringify({ target: document }),
  );
  assert.equal(saveCalls, 1);
});

test("real non-atomic batch service journals a step intent and inspects its numbered owner receipt after restart", async (t) => {
  const root = fs.mkdtempSync("/tmp/opencode/stage-batch-owner-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  fs.mkdirSync(path.join(project, ".cad"), { recursive: true });
  const targetFile = path.join(project, "accepted.json");
  fs.writeFileSync(targetFile, JSON.stringify({ target: document }));
  const reportPath = path.join(project, ".cad", "batch-receipts");
  const batchData = {
    runId: "batch-owner-run",
    reportPath,
    atomic: false,
    operations: [
      {
        id: "create-sketch",
        operation: "sketch.create",
        data: { name: "Owner sketch", plane: "XY" },
      },
    ],
  };
  const batchPayload = {
    version: 1 as const,
    kind: "cad" as const,
    operation: "batch.run",
    data: batchData,
    doc: document.name,
    docId: document.creationId,
    docFileId: document.fileId,
    projectId: document.projectId,
  };
  const request = {
    requestId: "request-batch-owner",
    clientId: "client-owner",
    kind: "command",
    timeoutMs: 60000,
    cwd: project,
    argv: (
      loadModule(
        "../src/catalog",
      ) as typeof import("../src/composition/library-catalog-registry")
    ).catalogPolicyArguments(batchPayload),
    inputFiles: [
      { path: targetFile, sha256: sha(fs.readFileSync(targetFile)) },
    ],
    sequence: { action: "begin" },
    payload: batchPayload,
  };
  retainAdmission(root, request);
  let now = 100;
  const state = new QueueState(root, { now: () => now++ });
  const submitted = state.submit(request);
  const job = present(state.next());
  assert.equal(job.id, submitted["id"]);
  const directory = path.join(root, "jobs", job.id);
  fs.mkdirSync(directory, { recursive: true });
  const build = instance.buildHash();
  const physical = {
    pid: 123,
    birth: "boot:88",
    version: "Fusion-test",
    activeCommand: "",
  };
  durable(path.join(root, "instance.json"), {
    buildHash: build,
    instance: physical,
  });
  durable(path.join(directory, "request.json"), {
    id: job.id,
    request: present(state.data.jobs[job.id]).request,
    buildHash: build,
  });
  writeObservation(
    root,
    present(state.data.jobs[job.id]),
    build,
    physical,
    "preflight",
  );
  const deps = await createAuthenticatedStageDependencies({
    brokerDirectory: root,
    jobId: job.id,
    projectDirectory: project,
  });
  assert.ok(deps);
  assert.ok(deps.batch);
  const catalog = (
    loadModule(
      "../src/catalog",
    ) as typeof import("../src/composition/library-catalog-registry")
  ).catalog;
  const batch = loadModule(
    "../src/batch",
  ) as typeof import("../src/composition/batch");
  let physicalCalls = 0;
  const result = await batch.runBatchEntry(
    null,
    batchData,
    {
      doc: document.name,
      docId: document.creationId,
      docFileId: document.fileId,
      projectId: document.projectId,
      preview: false,
    },
    async (_client, operation, data) => {
      physicalCalls++;
      return {
        success: true,
        operation,
        result: { created: data["name"] },
        created: [{ name: data["name"] }],
      };
    },
    catalog,
    deps.batch,
  );
  assert.equal(field(result, "status"), "success");
  finishLifecycle(
    {
      broker: root,
      project,
      job: present(state.data.jobs[job.id]),
      state,
      directory,
      build,
      physical,
      binding: { requestHash: field(result, "requestHash") },
      reference: "unused",
    },
    { workerCode: 1, terminal: "needs_reconciliation", response: false },
  );
  const plan = deps.resumePlan();
  assert.equal(field(plan, "status"), "reconciliationRequired");
  assert.equal(field(plan, "stages", 0, "status"), "completed");
  assert.equal(field(plan, "nextStage"), null);
  const batchRequest: Record<string, unknown> = { ...batchData };
  delete batchRequest["reportPath"];
  const batchContext = {
    doc: document.name,
    docId: document.creationId,
    docFileId: document.fileId,
    projectId: document.projectId,
    preview: false,
  };
  const reportRequestHash = (
    loadModule(
      "../src/dist/core/application/cad/json",
    ) as typeof import("../packages/core/src/application/cad/json")
  ).hash({ request: batchRequest, context: batchContext });
  const batchStageHash = (
    loadModule(
      "../src/dist/core/application/cad/json",
    ) as typeof import("../packages/core/src/application/cad/json")
  ).hash({
    jobRequestHash: present(state.data.jobs[job.id]).hash,
    reportRequestHash,
  });
  const batchReference = (
    loadModule(
      "../src/dist/node-adapters/persistence/stage-journal",
    ) as typeof import("../packages/node-adapters/src/persistence/stage-journal")
  ).stageReceiptReference(
    Buffer.from(
      canonical({ operation: "batch.run", requestHash: batchStageHash }),
      "utf8",
    ),
  );
  const batchStarted = readJson(
    path.join(directory, "stages", "00000001.json"),
  );
  assert.equal(field(batchStarted, "event", "receipt"), batchReference);
  assert.equal(field(batchStarted, "event", "stage"), "batch.run");
  assert.equal(field(plan, "head"), field(batchStarted, "sha256"));
  const childScript = `
    (async () => {
      const d = await require(${JSON.stringify(loadModule.resolve("../src/composition/stage-dependencies"))})
        .createAuthenticatedStageDependencies({ brokerDirectory: ${JSON.stringify(root)}, jobId: ${JSON.stringify(job.id)}, clientId: "client-owner", projectDirectory: ${JSON.stringify(project)} });
      process.stdout.write(JSON.stringify(d.resumePlan()));
    })().catch(error => { process.stderr.write(error.stack); process.exitCode = 1; });
  `;
  const child = spawnSync(process.execPath, ["-e", childScript], {
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);
  const resumed: unknown = JSON.parse(child.stdout);
  assert.equal(field(resumed, "stages", 0, "status"), "completed");
  assert.equal(field(resumed, "replayAllowed"), false);
  assert.equal(field(resumed, "automaticResume"), false);
  // A stored flag cannot turn an undeclared negative outcome into completion.
  // Inspection must only re-read evidence; it must never execute the batch again.
  const terminalFile = path.join(
    reportPath,
    present(
      fs
        .readdirSync(reportPath)
        .filter((name) => /^\d{8}\.json$/.test(name))
        .sort()
        .at(-1),
    ),
  );
  const terminalBytes = fs.readFileSync(terminalFile);
  const contradictory: unknown = JSON.parse(terminalBytes.toString("utf8"));
  object(field(contradictory, "steps", 0))["expectFail"] = true;
  object(field(contradictory, "steps", 0))["output"] = {
    success: false,
    status: "blocked",
  };
  try {
    fs.writeFileSync(terminalFile, JSON.stringify(contradictory));
    const refused = deps.journalInspect();
    assert.equal(present(refused.stages[0]).status, "unknown");
    assert.equal(refused.replayAllowed, false);
    assert.equal(physicalCalls, 1);
  } finally {
    fs.writeFileSync(terminalFile, terminalBytes);
  }
  assert.equal(present(deps.journalInspect().stages[0]).status, "completed");
  assert.equal(physicalCalls, 1);
});

test("atomic batch stage accepts only the existing finalized native receipt history", async (t) => {
  const root = fs.mkdtempSync("/tmp/opencode/stage-atomic-owner-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  fs.mkdirSync(path.join(project, ".cad"), { recursive: true });
  const acceptedFile = path.join(project, "accepted.json");
  fs.writeFileSync(acceptedFile, JSON.stringify({ target: document }));
  const reportPath = path.join(project, ".cad", "atomic-receipts");
  const data = {
    runId: "atomic-owner-run",
    reportPath,
    atomic: true,
    operations: [
      {
        id: "create-sketch",
        operation: "sketch.create",
        data: { name: "Owner sketch", plane: "XY" },
      },
    ],
  };
  const payload = {
    version: 1 as const,
    kind: "cad" as const,
    operation: "batch.run",
    data,
    doc: document.name,
    docId: document.creationId,
    docFileId: document.fileId,
    projectId: document.projectId,
  };
  const request = {
    requestId: "request-atomic-owner",
    clientId: "client-owner",
    kind: "command",
    timeoutMs: 60000,
    cwd: project,
    argv: (
      loadModule(
        "../src/catalog",
      ) as typeof import("../src/composition/library-catalog-registry")
    ).catalogPolicyArguments(payload),
    payload,
    inputFiles: [
      { path: acceptedFile, sha256: sha(fs.readFileSync(acceptedFile)) },
    ],
    sequence: { action: "begin" },
  };
  retainAdmission(root, request);
  let now = 100;
  const state = new QueueState(root, { now: () => now++ });
  const submitted = state.submit(request);
  const job = state.next();
  assert.ok(job);
  assert.equal(job.id, submitted["id"]);
  const directory = path.join(root, "jobs", job.id);
  fs.mkdirSync(directory, { recursive: true });
  const build = instance.buildHash();
  const physical = {
    pid: 123,
    birth: "boot:88",
    version: "Fusion-test",
    activeCommand: "",
  };
  durable(path.join(root, "instance.json"), {
    buildHash: build,
    instance: physical,
  });
  durable(path.join(directory, "request.json"), {
    id: job.id,
    request: job.request,
    buildHash: build,
  });
  writeObservation(root, job, build, physical, "preflight");
  const deps = present(
    await createAuthenticatedStageDependencies({
      brokerDirectory: root,
      jobId: job.id,
    }),
  );
  const batchRequest: Record<string, unknown> = { ...data };
  const batchBinding = {
    request: batchRequest,
    context: {
      doc: document.name,
      docId: document.creationId,
      docFileId: document.fileId,
      projectId: document.projectId,
      preview: false,
    },
  };
  delete batchBinding.request["reportPath"];
  const requestHash = (
    loadModule(
      "../src/dist/core/application/cad/json",
    ) as typeof import("../packages/core/src/application/cad/json")
  ).hash(batchBinding);
  await Reflect.apply(present(deps.batch).beforeRun, deps.batch, [
    { requestHash, atomic: true },
  ]);
  fs.mkdirSync(reportPath, { recursive: true });
  const commandId = "fmcad_atomic_" + "a".repeat(32);
  const resolvedIdentity = {
    creationId: document.creationId,
    fileId: document.fileId,
  };
  const first = {
    version: 2,
    success: false,
    operation: "batch.run",
    runId: data.runId,
    requestHash,
    request: batchBinding.request,
    context: batchBinding.context,
    status: "running",
    reportPath,
    sequence: 0,
    commandId,
    sessionNonce: "c".repeat(32),
    outcome: "pending",
    documentIdentity: {
      expected: resolvedIdentity,
      resolved: resolvedIdentity,
      assertionsOnly: true,
    },
    atomic: { effective: true, supported: true, backend: "addin" },
    steps: [
      { id: "create-sketch", operation: "sketch.create", status: "running" },
    ],
  };
  const final = {
    ...first,
    success: true,
    status: "success",
    outcome: "committed",
    cleanupCompleted: true,
    nativeOutcome: "committed",
    sequence: 1,
    journal: { event: "finalized", nativeOutcome: "committed" },
    steps: [
      {
        id: "create-sketch",
        operation: "sketch.create",
        status: "success",
        output: { success: true },
      },
    ],
  };
  durable(path.join(reportPath, "00000000.json"), first, true);
  durable(path.join(reportPath, "00000001.json"), final, true);
  finishLifecycle(
    {
      broker: root,
      project,
      job,
      state,
      directory,
      build,
      physical,
      binding: { requestHash },
      reference: "unused",
    },
    { workerCode: 1, terminal: "needs_reconciliation", response: false },
  );
  const result = deps.resumePlan();
  assert.equal(field(result, "status"), "reconciliationRequired");
  assert.deepEqual(field(result, "stages"), [
    { id: "batch.atomic", status: "completed" },
  ]);
  assert.equal(field(result, "nextStage"), null);
  assert.equal(field(result, "replayAllowed"), false);
});

test("verified helper service injects own stage APIs and consumes the original terminal helper receipt", async (t) => {
  const sourceDirectory = fs.mkdtempSync("/tmp/opencode/stage-helper-source-");
  t.after(() => fs.rmSync(sourceDirectory, { recursive: true, force: true }));
  const helperFile = path.join(sourceDirectory, "trusted_helper.py");
  fs.writeFileSync(
    helperFile,
    `DOC_NAME = ${JSON.stringify(document.name)}\ndef run(_context):\n    FMCAD.stage()\n    FMCAD.journalInspect()\n    FMCAD.resumePlan()\n    FMCAD.call('sketch.create', {'name': 'Owner sketch', 'plane': 'XY'})\n`,
  );
  const payload = {
    version: 1 as const,
    kind: "run" as const,
    request: {
      name: helperFile,
      args: null,
      hasArgs: false,
      doc: document.name,
      identity: {
        docId: document.creationId,
        docFileId: document.fileId,
        readOnly: false,
      },
      helperVersion: "cad-v1",
      readOnlyOperations: [],
    },
  };
  const argv = (
    loadModule(
      "../src/dist/core/application/cad/worker-command",
    ) as typeof import("../packages/core/src/application/cad/worker-command")
  ).cadWorkerPolicyArguments(payload);
  const f = fixture(t, {
    seedStage: false,
    payload,
    argv,
    extraInputs: [helperFile],
  });
  const deps = await createAuthenticatedStageDependencies({
    brokerDirectory: f.broker,
    jobId: f.job.id,
  });
  assert.ok(deps);
  assert.ok(deps.helper);
  const marker =
    "FMCAD_RESULT " +
    JSON.stringify({
      success: true,
      helperCallsOnly: [
        {
          operation: "sketch.create",
          status: "completed",
          effects: "observed",
        },
      ],
    });
  const captured: string[] = [];
  const errors: string[] = [];
  let prepared = "";
  const backend = {
    server: { backend: "addin" },
    capabilities: { backend: "addin" },
    async callTool(request: unknown) {
      prepared = string(field(request, "object", "script"));
      return { failed: false, text: marker };
    },
  };
  const service = loadModule(
    "../src/cad-service",
  ) as typeof import("../src/composition/cad-service");
  // Exercise the original authenticated composition object intact. This
  // integration boundary accepts runtime values before service validation.
  const code: unknown = await Reflect.apply(service.execute, service, [
    { payload, argv },
    backend,
    () => {},
    {
      stdout: { write: (text: string) => captured.push(text) },
      stderr: { write: (text: string) => errors.push(text) },
    },
    { stageDependencies: deps },
  ]);
  assert.equal(code, 0, `${captured.join("")}\n${errors.join("")}`);
  assert.match(prepared, /python\.helpers\.run/);
  assert.match(prepared, /journalInspect/);
  assert.match(prepared, /automaticResume/);
  assert.match(prepared, /replayAllowed/);
  const resultDirectory = path.join(f.project, ".cad", "results", f.job.id);
  fs.mkdirSync(resultDirectory, { recursive: true });
  fs.writeFileSync(path.join(resultDirectory, "stdout.txt"), captured.join(""));
  finishLifecycle(f, {
    workerCode: 1,
    terminal: "needs_reconciliation",
    response: false,
    sourceHash: sha(prepared),
    workflowOutcome: { operation: "run", status: "unknown" },
  });
  const plan = deps.resumePlan();
  assert.equal(field(plan, "status"), "reconciliationRequired");
  assert.deepEqual(field(plan, "stages"), [
    { id: "python.helpers.run", status: "completed" },
  ]);
  assert.equal(field(plan, "replayAllowed"), false);
  assert.equal(field(plan, "automaticResume"), false);
});

test("worker adapter passes stage owner inputs only after its existing capability/build/input verification", async (t) => {
  const f = fixture(t, { seedStage: false });
  const priorDirectory = process.env["FMCAD_QUEUE_DIR"];
  process.env["FMCAD_QUEUE_DIR"] = f.broker;
  t.after(() => {
    if (priorDirectory === undefined) delete process.env["FMCAD_QUEUE_DIR"];
    else process.env["FMCAD_QUEUE_DIR"] = priorDirectory;
  });
  const envelope = {
    id: f.job.id,
    request: {
      ...f.job.request,
      cwd: string(f.job.request.cwd),
      argv: present(f.job.request.argv),
      payload: present(f.job.request.payload),
    },
    buildHash: f.build,
    deadline: Date.now() + 60000,
  };
  let reachedExecute = false;
  let stageReady = false;
  const ports: WorkerNodePorts = {
    jobId: f.job.id,
    token: "verified-by-worker-test",
    buildHash: () => f.build,
    configuration: { timeoutMs: 1000, backend: "addin" },
    request: async () => assert.fail("stage composition has no SDK RPC"),
    async execute(_request, _backend, _outcome, verified) {
      reachedExecute = true;
      assert.equal(verified.jobId, f.job.id);
      assert.equal(verified.brokerDirectory, f.broker);
      assert.equal(verified.buildHash, f.build);
      const dependencies = await createAuthenticatedStageDependencies(verified);
      stageReady = !!dependencies?.document;
      return 0;
    },
    nonterminal: () => false,
    persist() {},
  };
  assert.equal(await runWorker(envelope, ports), 0);
  assert.equal(reachedExecute, true);
  assert.equal(stageReady, true);

  reachedExecute = false;
  await assert.rejects(
    runWorker(envelope, { ...ports, jobId: "foreign-worker" }),
    /job-bound worker capability/,
  );
  assert.equal(reachedExecute, false);
  await assert.rejects(
    runWorker({ ...envelope, buildHash: "different-build" }, ports),
    /build changed/,
  );
  assert.equal(reachedExecute, false);
});

test("Public Fmcad stage/journalInspect/resumePlan bind only the authenticated client's job", async (t) => {
  const f = fixture(t, { clientId: "library-test", seedStage: false });
  const dependencies = await createAuthenticatedStageDependencies({
    brokerDirectory: f.broker,
    jobId: f.job.id,
  });
  let statusReads = 0;
  const executeCad = async (_client: unknown, operation: string) => {
    if (operation === "document.status") {
      statusReads++;
      return {
        success: true,
        result: {
          name: document.name,
          creationId: document.creationId,
          fileId: document.fileId,
          projectId: document.projectId,
          version: statusReads === 1 ? document.version : document.version + 1,
          saved: true,
          modified: statusReads === 1,
          isComplete: true,
          isReadOnly: false,
        },
      };
    }
    if (operation === "document.save_native")
      return { success: true, result: { status: "accepted", accepted: true } };
    assert.fail(`unexpected document operation ${operation}`);
  };
  const saveInput = object(field(f.job.request, "payload", "data"));
  const saveContext = {
    doc: document.name,
    docId: document.creationId,
    docFileId: document.fileId,
    projectId: document.projectId,
  };
  await documentPublication.execute(
    null,
    "document.save.once",
    saveInput,
    saveContext,
    executeCad,
    { stages: present(present(dependencies).document).stages },
  );
  const observeInput = { ...saveInput };
  delete observeInput["confirm"];
  await documentPublication.execute(
    null,
    "document.save.observe",
    observeInput,
    saveContext,
    executeCad,
  );
  finishLifecycle(f);
  const configInput: FmcadConfiguration = {
    backend: "addin",
    url: "http://localhost:1/mcp",
    headers: {},
    timeoutMs: 1000,
    tool: "execute_python",
    transport: "node",
    protocolVersion: "2025-06-18",
    routing: "queue",
    queue: { autoStart: true },
    controlCenter: { port: 4748 },
  };
  const resolved = (
    loadModule(
      "../src/dist/core",
    ) as typeof import("../packages/core/src/index")
  ).resolveFmcadConfiguration({
    adapter: { ...configInput },
    environment: {},
    file: {},
    platformDefaults: {},
    acceptedService: null,
  });
  const configHash = instance.brokerConfigHash(resolved);
  const instanceFile = path.join(f.broker, "instance.json");
  durable(instanceFile, {
    ...object(readJson(instanceFile)),
    configHash,
  });
  durable(path.join(f.broker, "broker.lock"), {
    protocol: 2,
    pid: process.pid,
    birth: "test",
  });
  const Module = loadModule("node:module") as {
    _load(
      name: string,
      parent: NodeModule | undefined,
      isMain?: boolean,
    ): unknown;
  };
  const load = Module._load;
  Module._load = function (name, parent, ...args) {
    if (name.endsWith("/queue-connection"))
      return { queueDirectory: () => f.broker };
    if (/\/queue-instance(?:\.js)?$/.test(name))
      return {
        buildHash: () => f.build,
        brokerConfigHash: () => configHash,
        sameInstance: instance.sameInstance,
        nativeWorkflowIdentity: instance.nativeWorkflowIdentity,
      };
    if (name.endsWith("/queue-client"))
      return {
        QueueClient: class {
          async register() {}
          async call(action: string, value: unknown) {
            if (action === "status" || action === "control-status")
              return { buildHash: f.build };
            if (action === "result" && field(value, "jobId") === f.job.id)
              return { job: f.state.status(f.job.id) };
            throw Object.assign(new Error("Foreign job denied"), {
              code: "NOT_OWNER",
            });
          }
          dispose() {}
        },
      };
    return load.call(this, name, parent, ...args);
  };
  try {
    const api = (
      loadModule("fmcad/api") as typeof import("../src/api")
    ).createFmcad({
      version: 1,
      config: configInput,
      context: {
        clientId: "library-test",
        instanceId: "library-instance",
        source: "system",
        projectDirectory: f.project,
      },
    });
    await api.start();
    const stage = await api.stage(f.job.id);
    const inspected = stage.journalInspect();
    assert.equal(
      present(inspected.stages[0]).status,
      "completed",
      JSON.stringify(inspected),
    );
    assert.equal((await api.journalInspect(f.job.id)).head, inspected.head);
    assert.equal((await api.resumePlan(f.job.id)).replayAllowed, false);
    await assert.rejects(
      api.stage("00000000-0000-4000-8000-000000000000"),
      /Foreign job denied/,
    );
    await api.dispose();
  } finally {
    Module._load = load;
  }
});

test("lost transport response is not completion evidence; matching native and owner receipts support completed inspection", (t) => {
  const f = fixture(t);
  finishLifecycle(f, {
    workerCode: 1,
    terminal: "needs_reconciliation",
    response: false,
  });
  const plan = f.owner.resumePlan();
  assert.equal(field(plan, "status"), "reconciliationRequired");
  assert.equal(field(plan, "stages", 0, "status"), "completed");
  assert.equal(field(plan, "replayAllowed"), false);
  assert.equal(field(plan, "nextStage"), null);
});

test("transport ACK and successful worker result alone cannot complete a stage", (t) => {
  const f = fixture(t);
  finishLifecycle(f);
  f.ports.readOriginalReceipt = () => ({ status: "unknown" });
  const owner = createAuthenticatedStageOwner(f.ports);
  const plan = owner.resumePlan();
  assert.equal(field(plan, "stages", 0, "status"), "unknown");
  assert.equal(field(plan, "nextStage"), null);
  assert.equal(field(plan, "replayAllowed"), false);
});

test("lost reply and crash with unfinished job/native/postflight evidence remains unknown", (t) => {
  const f = fixture(t);
  const inProcess = f.owner.resumePlan();
  assert.equal(present(inProcess.stages[0]).status, "unknown");
  assert.equal(inProcess.nextStage, null);
  assert.equal(inProcess.replayAllowed, false);
  const journal = (
    loadModule(
      "../src/dist/node-adapters/persistence/stage-journal",
    ) as typeof import("../packages/node-adapters/src/persistence/stage-journal")
  )
    .openStageJournal(
      f.directory,
      f.owner.owner.scope,
      core.validateStageJournal,
    )
    .read();
  assert.equal(journal.length, 2);
  assert.equal(
    field(
      readJson(path.join(f.directory, "stages/00000001.json")),
      "event",
      "stage",
    ),
    "document.save.once",
  );
});

test("changed build, incomplete/corrupt terminal receipts and foreign jobs cannot complete the stage", (t) => {
  const f = fixture(t);
  finishLifecycle(f);
  f.ports.buildHash = () => sha("different-build");
  assert.equal(f.owner.resumePlan().status, "reconciliationRequired");
  const receipt = path.join(
    f.directory,
    "remote-33333333-3333-4333-8333-333333333333.json",
  );
  const saved = fs.readFileSync(receipt);
  fs.writeFileSync(
    receipt,
    JSON.stringify({
      ...object(JSON.parse(saved.toString("utf8"))),
      jobId: "foreign-job",
    }),
  );
  const owner = createAuthenticatedStageOwner(f.ports);
  assert.equal(present(owner.resumePlan().stages[0]).status, "unknown");
  fs.writeFileSync(receipt, saved);
  assert.throws(
    () =>
      createAuthenticatedStageOwner(
        ownerPorts(f.broker, "foreign-job", f.build),
      ),
    /capability|owning job/i,
  );
});

test("corrupt accepted bytes or queue snapshot durability marker fail closed", (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    path.join(f.project, "accepted.json"),
    "edited mutable source",
  );
  assert.equal(f.owner.evidence.accepted(f.owner.owner.scope), "available");
  // The accepted path is intentionally not reread; damage the content-addressed original instead.
  const admission = (
    loadModule(
      "../src/dist/node-adapters/persistence/accepted-inputs",
    ) as typeof import("../packages/node-adapters/src/persistence/accepted-inputs")
  ).readAdmission(f.broker, f.job);
  assert.equal(admission.status, "available");
  const artifact = path.join(
    f.broker,
    "accepted",
    present(admission.inputs[0]).sha256,
  );
  fs.writeFileSync(artifact, "tampered immutable bytes");
  assert.equal(f.owner.evidence.accepted(f.owner.owner.scope), "missing");
  durable(
    path.join(f.broker, "queue-state.pending.json"),
    { recoveryRequired: true },
    true,
  );
  assert.throws(
    () => createAuthenticatedStageOwner(f.ports),
    /durability marker/,
  );
});

test("a workflow pin not present in the owning job's physical preflight is rejected", (t) => {
  const f = fixture(t);
  const ports = ownerPorts(f.broker, f.job.id, f.build, {
    resolvePinnedDocument: () => ({ ...document, fileId: "foreign-file" }),
  });
  assert.throws(() => createAuthenticatedStageOwner(ports), /preflight/i);
});

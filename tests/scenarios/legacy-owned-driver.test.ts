import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { currentProcessIdentity } from "./fixture-provenance";
import { marker } from "./programs";

function fixture(t: TestContext, userActive = false, creationReadback = false) {
  const root = path.resolve(__dirname, "../../.."),
    parent = path.join(root, ".test-artifacts/scenario-unit");
  fs.mkdirSync(parent, { recursive: true });
  const campaign = fs.mkdtempSync(path.join(parent, "legacy-baseline-")),
    runId = randomUUID(),
    scenarioId = "native-legacy-0",
    owner = { runId, scenarioId, clientId: `scenario:${runId}:${scenarioId}` },
    directory = path.join(campaign, runId, scenarioId),
    own = { creationId: randomUUID(), name: "Owned legacy fixture" },
    user = {
      creationId: "user-id",
      name: "Original user",
      saved: false,
      modified: false,
      fileId: null,
    },
    peer = {
      creationId: "peer-id",
      name: "Exact peer",
      saved: false,
      modified: false,
      fileId: null,
    },
    peerRun = randomUUID(),
    peerScenario = "peer",
    peerOwner = {
      runId: peerRun,
      scenarioId: peerScenario,
      clientId: `scenario:${peerRun}:${peerScenario}`,
    },
    peerDirectory = path.join(campaign, peerRun, peerScenario),
    peerIdentity = {
      creationId: peer.creationId,
      name: peer.name,
      activeCreationId: peer.creationId,
      clientId: peerOwner.clientId,
      requestId: peerOwner.clientId + ":0",
    },
    coordinatorId = `scenario:${runId}:coordinator`,
    beforeRequest = coordinatorId + ":before",
    backend = {
      mode: "fusion",
      protocol: "addin",
      qualification: "broker",
      backendIdentity: "fusion:addin:legacy-baseline-test",
    },
    snapshot = {
      active: userActive ? user.creationId : peer.creationId,
      documents: [user, peer],
    },
    receipt = {
      requestId: beforeRequest,
      clientId: coordinatorId,
      jobId: randomUUID(),
      state: "succeeded",
    },
    result = {
      requestId: beforeRequest,
      state: "succeeded",
      sdkSettled: true,
      mayHaveMutated: false,
      stdout: marker + JSON.stringify(snapshot) + "\n",
      exitCode: 0,
      brokerReceipt: receipt,
    },
    index = {
      runId,
      ...backend,
      status: "running",
      processIdentity: currentProcessIdentity(),
      scenarioIds: [scenarioId],
      before: { active: snapshot.active, documents: [user] },
    },
    peerReport = {
      owner: peerOwner,
      directory: peerDirectory,
      ...backend,
      status: "running",
      cleanup: "pending",
      document: { creationId: peer.creationId, name: peer.name },
      requests: [
        {
          phase: "create",
          requestId: peerIdentity.requestId,
          intent: { kind: "script" },
          result: {
            ...result,
            requestId: peerIdentity.requestId,
            stdout: marker + JSON.stringify(peerIdentity) + "\n",
            brokerReceipt: {
              ...receipt,
              requestId: peerIdentity.requestId,
              clientId: peerOwner.clientId,
              jobId: randomUUID(),
            },
          },
        },
      ],
    };
  const write = (filename: string, value: unknown) =>
    fs.writeFileSync(filename, JSON.stringify(value));
  fs.mkdirSync(path.join(directory, "legacy/intents"), { recursive: true });
  fs.mkdirSync(path.join(campaign, runId, "_coordinator"));
  fs.mkdirSync(peerDirectory, { recursive: true });
  write(path.join(directory, "creation.json"), {
    ...own,
    clientId: owner.clientId,
    requestId: owner.clientId + ":0",
  });
  write(path.join(directory, "report.json"), {
    requests: [
      {
        phase: "create",
        requestId: owner.clientId + ":0",
        result: {
          exitCode: 0,
          sdkSettled: true,
          brokerReceipt: {
            requestId: owner.clientId + ":0",
            clientId: owner.clientId,
            state: "succeeded",
          },
        },
      },
    ],
  });
  const scope = path.join(directory, "legacy/lease.json");
  write(scope, {
    version: 1,
    owner,
    document: own,
    directory,
    source: "tests/scenarios/legacy-owned-driver.ts",
    testCase: "native-legacy-cli",
    protocol: "addin",
    mode: "owned-unsaved-script",
  });
  write(path.join(campaign, runId, "index.json"), index);
  const resultFile = path.join(
    campaign,
    runId,
    "_coordinator/before.result.json",
  );
  write(resultFile, result);
  write(path.join(campaign, runId, "_coordinator/before.intent.json"), {
    requestId: beforeRequest,
    phase: "before",
  });
  write(path.join(peerDirectory, "creation.json"), peerIdentity);
  Reflect.set(peerReport, "scope", "owned-document");
  peerReport.requests[0]!.result.mayHaveMutated = true;
  write(path.join(peerDirectory, "report.json"), peerReport);
  write(path.join(campaign, peerRun, "index.json"), {
    runId: peerRun,
    ...backend,
    processIdentity: currentProcessIdentity(),
    status: "running",
    before: { documents: [] },
    scenarioIds: [peerScenario],
  });
  const called = path.join(campaign, "cli-called.json"),
    preload = path.join(campaign, "preload.cjs");
  // Stop at the child CLI boundary: these tests exercise startup authority,
  // never submit a command or claim that the retained operations ran.
  const terminal = {
    id: randomUUID(),
    requestId: owner.clientId + ":legacy:" + randomUUID(),
    clientId: owner.clientId,
    state: "succeeded",
    executionOutcome: "succeeded",
    operationResult: { executionOutcome: "succeeded" },
  };
  const state = {
    documents: [
      ...snapshot.documents,
      { ...own, saved: false, modified: false, fileId: null },
    ].map((row) => ({ ...row, active: row.creationId === own.creationId })),
    active: own.name,
    timelineCount: 0,
    marker: 0,
    bodies: 0,
    units: "mm",
    parameters: [],
    planes: [],
  };
  fs.writeFileSync(
    preload,
    `const Module=require('node:module'),fs=require('node:fs');const load=Module._load;let snapshots=0;Module._load=function(name,...args){if(name.endsWith('/tests/helpers/live-broker'))return {fixture(){},spawnSync(_command,argv){fs.writeFileSync(${JSON.stringify(called)},JSON.stringify(argv));let stdout='TEST_CLI_BOUNDARY';if(${creationReadback}){if(argv[1]==='call'){if(++snapshots>1)throw new Error('TEST_STOP_AFTER_CREATION');stdout=${JSON.stringify("LIVE_STATE " + JSON.stringify(state))};}else stdout=${JSON.stringify(own.name)};}return {status:0,stdout,stderr:${JSON.stringify("FMCAD_QUEUE_RESULT " + JSON.stringify(terminal))}};}};return load.call(this,name,...args);};`,
  );
  t.after(() => fs.rmSync(campaign, { recursive: true, force: true }));
  return {
    root,
    campaign,
    directory,
    peerDirectory,
    own,
    user,
    peer,
    snapshot,
    result,
    resultFile,
    index,
    peerReport,
    write,
    run() {
      const execution = spawnSync(
        process.execPath,
        [
          path.join(root, "dist/tests/scenarios/legacy-owned-driver.js"),
          "--run",
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            NODE_OPTIONS: "--require=" + preload,
            FMCAD_LIVE_OWNED_SCOPE: scope,
            FMCAD_LIVE_CLIENT: owner.clientId,
            FMCAD_TEST_DOC: own.name,
          },
        },
      );
      return {
        ...execution,
        reachedCli: fs.existsSync(called),
        cliArgs: fs.existsSync(called)
          ? (JSON.parse(fs.readFileSync(called, "utf8")) as string[])
          : [],
        readback: fs.existsSync(path.join(directory, "legacy/readback.json"))
          ? (JSON.parse(
              fs.readFileSync(
                path.join(directory, "legacy/readback.json"),
                "utf8",
              ),
            ) as unknown)
          : undefined,
      };
    },
  };
}

test("legacy child resolves an exact active peer from its original coordinator receipt, not filtered baseline names", (t) => {
  const f = fixture(t),
    result = f.run();
  assert.equal(result.reachedCli, true, result.stderr);
  assert.deepEqual((result.readback as { before: unknown }).before, {
    documents: [
      {
        creationId: f.user.creationId,
        fileId: null,
        name: f.user.name,
        saved: false,
        modified: false,
        active: false,
      },
    ],
    active: f.peer.name,
    timelineCount: 0,
    marker: 0,
    bodies: 0,
    units: "",
    parameters: [],
    planes: [],
  });
});

test("legacy child preserves the real original user active document", (t) => {
  const f = fixture(t, true),
    result = f.run();
  assert.equal(result.reachedCli, true, result.stderr);
  assert.equal(
    (result.readback as { before: { active: string } }).before.active,
    f.user.name,
  );
});

test("legacy creation compares protected rows and exact peer receipts instead of a filtered document count", (t) => {
  const f = fixture(t, false, true),
    result = f.run();
  const report = result.readback as {
    tests: { name: string; status: string; error?: string }[];
  };
  const created = report.tests.find(
    (row) => row.name === "doc new and ownership",
  );
  assert.equal(created?.status, "passed", JSON.stringify(created));
});

test("the complete legacy snapshot captured at the public child CLI boundary passes production admission", async (t) => {
  const f = fixture(t, false, true),
    result = f.run(),
    load = createRequire(path.join(f.root, "package.json")),
    { prepareRunScript } = load(
      "./src/run",
    ) as typeof import("../../src/composition/run"),
    { preparePythonArtifact } = load(
      "./packages/node-adapters/dist/python/artifact",
    ) as typeof import("../../packages/node-adapters/src/python/artifact"),
    { createPythonChecker } = load(
      "./packages/node-adapters/dist/python/checker",
    ) as typeof import("../../packages/node-adapters/src/python/checker");
  assert.equal(result.cliArgs[1], "call");
  const invocation = JSON.parse(result.cliArgs[3]!) as {
      object: { script: string };
    },
    file = path.join(f.directory, "snapshot.py");
  fs.writeFileSync(file, invocation.object.script);
  const prepared = prepareRunScript(file, undefined, false),
    artifact = preparePythonArtifact([
      {
        id: "legacy-snapshot",
        filename: "snapshot.py",
        role: "user",
        source: prepared.script + '\nrun("")\n',
      },
    ]),
    typingRoot = path.join(f.root, "dist/runtime/python/typing"),
    checker = createPythonChecker({
      typingRoot,
      definitionsRoot: typingRoot,
      pythonPlatform: "Windows",
    }),
    checked = await checker.check({ artifact, context: { kind: "run" } });
  assert.equal(checked.status, "passed", JSON.stringify(checked));
  assert.equal(checked.provenance.checkerVersion, "1.40.2");
  assert.equal(
    checked.provenance.definitionsHash,
    "83dc3697aa61a47ada93c323e2f719c7be3d72091938415f666089a96b159179",
  );
});

const invalid: { name: string; change(f: ReturnType<typeof fixture>): void }[] =
  [
    {
      name: "missing original coordinator result",
      change: (f) => fs.unlinkSync(f.resultFile),
    },
    {
      name: "unknown coordinator execution",
      change(f) {
        f.result.state = "unknown";
        f.result.sdkSettled = false;
        f.write(f.resultFile, f.result);
      },
    },
    {
      name: "foreign coordinator client",
      change(f) {
        f.result.brokerReceipt.clientId = "foreign-client";
        f.write(f.resultFile, f.result);
      },
    },
    {
      name: "foreign coordinator request",
      change(f) {
        f.result.brokerReceipt.requestId += ":foreign";
        f.write(f.resultFile, f.result);
      },
    },
    {
      name: "missing coordinator job",
      change(f) {
        Reflect.set(f.result.brokerReceipt, "jobId", "");
        f.write(f.resultFile, f.result);
      },
    },
    {
      name: "tampered original active identity",
      change(f) {
        f.snapshot.active = "foreign-id";
        f.result.stdout = marker + JSON.stringify(f.snapshot);
        f.write(f.resultFile, f.result);
      },
    },
    {
      name: "same-name foreign active document",
      change(f) {
        f.snapshot.documents[1] = { ...f.peer, creationId: "foreign-id" };
        f.result.stdout = marker + JSON.stringify(f.snapshot);
        f.write(f.resultFile, f.result);
      },
    },
    {
      name: "tampered peer name",
      change(f) {
        f.snapshot.documents[1] = { ...f.peer, name: "Tampered peer" };
        f.result.stdout = marker + JSON.stringify(f.snapshot);
        f.write(f.resultFile, f.result);
      },
    },
    {
      name: "missing peer proof",
      change: (f) => fs.unlinkSync(path.join(f.peerDirectory, "creation.json")),
    },
    {
      name: "unknown peer creation",
      change(f) {
        f.peerReport.requests[0]!.result.state = "unknown";
        f.peerReport.requests[0]!.result.sdkSettled = false;
        f.write(path.join(f.peerDirectory, "report.json"), f.peerReport);
      },
    },
    {
      name: "foreign peer receipt",
      change(f) {
        f.peerReport.requests[0]!.result.brokerReceipt.clientId =
          "foreign-client";
        f.write(path.join(f.peerDirectory, "report.json"), f.peerReport);
      },
    },
    {
      name: "changed user baseline",
      change(f) {
        f.snapshot.documents[0] = { ...f.user, modified: true };
        f.result.stdout = marker + JSON.stringify(f.snapshot);
        f.write(f.resultFile, f.result);
      },
    },
  ];
for (const fault of invalid)
  test(`legacy child rejects ${fault.name} before its first CLI command`, (t) => {
    const f = fixture(t);
    fault.change(f);
    const result = f.run();
    assert.equal(result.reachedCli, false, result.stderr);
    assert.notEqual(result.status, 0);
  });

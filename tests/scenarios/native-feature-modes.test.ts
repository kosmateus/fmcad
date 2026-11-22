import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { program } from "./programs";
import {
  featureModeLineProbe,
  featureModePropertiesProbe,
  featureModeHoleInputProbe,
  featureModeProbeSource,
  guardedFeatureModeProbeSource,
  nativeFeatureModesScenarios,
  nativeFeatureModesCapability,
  assertFeatureProbeReadmission,
} from "./native-feature-modes-cases";
import { fixture } from "./test-support";
import { runScenarios } from "./runner";
import type { Execution } from "./contracts";
import { assertReceiptBoundDocumentInventory } from "./fixture-provenance";

const root = path.resolve(__dirname, "../../..");
const load = createRequire(path.join(root, "package.json"));
const { prepareRunScript } = load(
  "./src/run",
) as typeof import("../../src/composition/run");
const { prepareCadScript } = load(
  "./src/cad",
) as typeof import("../../src/composition/cad");
const {
  createPythonChecker,
  createPythonRpcAdmission,
  retainPythonOrigin,
  pythonArtifactManifest,
} = load(
  "./src/python",
) as typeof import("../../packages/node-adapters/src/python/checker") &
  typeof import("../../packages/node-adapters/src/python/admission") &
  typeof import("../../packages/node-adapters/src/python/context-binding");
const { prepareReceiptScript } = load("./src/queue-instance") as ReturnType<
  typeof import("../../packages/node-adapters/src/execution/queue-instance").createQueueInstance
>;
const runtime = path.join(root, "dist/runtime/python");
const checker = createPythonChecker({
  typingRoot: path.join(runtime, "typing"),
  definitionsRoot: path.join(runtime, "typing"),
  pythonPlatform: "Windows",
});
const reference = {
  kind: "sketchCurve",
  token: "owned-entity-token",
  component: { kind: "component", name: "OwnedComponent" },
};

test("feature readmission requires the exact settled no-body receipt", () => {
  const admission = {
    status: "inventory-changed",
    requestId: "original",
    mutationStarted: false,
    bodyCalls: 0,
  };
  const result = { creationId: "owned", admission };
  const execution = {
    requestId: "original",
    state: "succeeded" as const,
    sdkSettled: true,
  };
  assertFeatureProbeReadmission(result, "original", "owned", execution);
  for (const changed of [
    { ...admission, requestId: "foreign" },
    { ...admission, mutationStarted: true },
    { ...admission, bodyCalls: 1 },
    { ...admission, status: "unknown" },
  ])
    assert.throws(() =>
      assertFeatureProbeReadmission(
        { ...result, admission: changed },
        "original",
        "owned",
        execution,
      ),
    );
  assert.throws(() =>
    assertFeatureProbeReadmission(result, "original", "foreign", execution),
  );
  assert.throws(() =>
    assertFeatureProbeReadmission(result, "original", "owned", undefined),
  );
  assert.throws(() =>
    assertFeatureProbeReadmission(result, "original", "owned", {
      ...execution,
      requestId: "foreign",
    }),
  );
  assert.throws(() =>
    assertFeatureProbeReadmission(result, "original", "owned", {
      ...execution,
      sdkSettled: false,
    }),
  );
  assert.throws(() =>
    assertFeatureProbeReadmission(result, "original", "owned", {
      ...execution,
      state: "failed",
    }),
  );
});

test("feature probe admits receipt-bound peer transitions and rejects unproven changes", async () => {
  const identity = { name: "Owned", creationId: "own" };
  const closed = {
    name: "ClosedPeer",
    creationId: "closed",
    saved: false,
    modified: false,
    fileId: null,
  };
  const opened = {
    name: "NewPeer",
    creationId: "new",
    saved: false,
    modified: true,
    fileId: null,
  };
  const current = {
    documents: [
      opened,
      { ...identity, saved: false, modified: true, fileId: null },
    ],
  };
  const guard = async () => {
    assertReceiptBoundDocumentInventory(
      [closed],
      [opened],
      new Map([
        [closed.creationId, { document: closed, state: "closed" }],
        [opened.creationId, { document: opened, state: "open" }],
      ]),
      "Unproven peer transition",
    );
    return current;
  };
  const execute = (
    source: string,
    foreign: unknown[],
    activeCreationId = identity.creationId,
    ownedIdentity = identity,
  ) =>
    spawnSync(
      "python3",
      [
        "-c",
        `
import sys, types, json
adsk = types.ModuleType('adsk')
core = types.ModuleType('adsk.core')
fusion = types.ModuleType('adsk.fusion')
adsk.core, adsk.fusion = core, fusion
sys.modules.update({'adsk': adsk, 'adsk.core': core, 'adsk.fusion': fusion})
own = types.SimpleNamespace(name=${JSON.stringify(ownedIdentity.name)}, creationId=${JSON.stringify(ownedIdentity.creationId)}, isSaved=False, isModified=True, dataFile=None)
rows = json.loads(${JSON.stringify(JSON.stringify(foreign))})
docs = [types.SimpleNamespace(name=d['name'], creationId=d['creationId'], isSaved=d['saved'], isModified=d['modified'], dataFile=None) for d in rows]
app = types.SimpleNamespace(documents=[own] + docs, activeDocument=None)
all_docs = app.documents
for document in all_docs:
    document.activate = lambda document=document: (setattr(app, 'activeDocument', document) is None)
app.activeDocument = next((d for d in all_docs if d.creationId == ${JSON.stringify(activeCreationId)}), None)
core.Application = types.SimpleNamespace(get=lambda: app)
exec(${JSON.stringify(source)})
run('')
`,
      ],
      { encoding: "utf8" },
    );
  const stale = execute(
    featureModeProbeSource(identity, [closed], 'print("BODY_EXECUTED")'),
    [opened],
  );
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /Other document state changed/u);
  const source = await guardedFeatureModeProbeSource(
    identity,
    guard,
    'print("BODY_EXECUTED")',
  );
  const accepted = execute(source, [opened]);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /BODY_EXECUTED/u);
  for (const later of [
    [],
    [{ ...opened, modified: false }],
    [opened, closed],
  ]) {
    const nextTurn = execute(source, later);
    assert.notEqual(nextTurn.status, 0);
    assert.match(nextTurn.stderr, /Other document state changed/u);
  }
  await assert.rejects(
    guardedFeatureModeProbeSource(
      identity,
      async () => {
        assertReceiptBoundDocumentInventory(
          [closed],
          [opened],
          new Map(),
          "Unproven peer transition",
        );
        return current;
      },
      "pass",
    ),
  );
  await assert.rejects(
    guardedFeatureModeProbeSource(identity, async () => undefined, "pass"),
    /verified current inventory/,
  );
  const nextTurn = await guardedFeatureModeProbeSource(
    identity,
    guard,
    'print("BODY_EXECUTED"); print("TARGET=" + app.activeDocument.creationId)',
    {
      requestId: "next-probe",
      peers: [{ creationId: opened.creationId, name: opened.name }],
    },
  );
  const peerTransition = execute(nextTurn, [opened]);
  assert.equal(peerTransition.status, 0, peerTransition.stderr);
  assert.match(peerTransition.stdout, /BODY_EXECUTED/u);
  assert.match(peerTransition.stdout, /TARGET=own/u);
  const peerActivation = execute(nextTurn, [opened], opened.creationId);
  assert.equal(peerActivation.status, 0, peerActivation.stderr);
  assert.match(peerActivation.stdout, /TARGET=own/u);
  const wrongTarget = execute(nextTurn, [opened], opened.creationId, {
    ...identity,
    creationId: "foreign-target",
  });
  assert.notEqual(wrongTarget.status, 0);
  assert.match(
    wrongTarget.stderr,
    /Owned active unsaved document guard failed/u,
  );
  assert.doesNotMatch(wrongTarget.stdout, /BODY_EXECUTED/u);
  const inTurnForeignMutation = execute(
    await guardedFeatureModeProbeSource(
      identity,
      async () => current,
      "app.documents[1].isModified = False",
    ),
    [opened],
  );
  assert.notEqual(inTurnForeignMutation.status, 0);
  assert.match(
    inTurnForeignMutation.stderr,
    /Other document state changed during feature probe/u,
  );
  const admission = {
    requestId: "original-probe",
    peers: [{ creationId: opened.creationId, name: opened.name }],
  };
  const peerAware = featureModeProbeSource(
    identity,
    [opened],
    'print("BODY_EXECUTED")',
    admission,
  );
  const changedPeer = execute(peerAware, [{ ...opened, modified: false }]);
  assert.equal(changedPeer.status, 0, changedPeer.stderr);
  assert.equal(changedPeer.stdout.trim(), "BODY_EXECUTED");
  const newlyProvenPeer = execute(
    featureModeProbeSource(identity, [], 'print("BODY_EXECUTED")', admission),
    [opened],
  );
  assert.equal(newlyProvenPeer.status, 0, newlyProvenPeer.stderr);
  for (const unproven of [
    [],
    [opened, closed],
    [{ ...opened, name: "Renamed" }],
    [{ ...opened, saved: true }],
  ]) {
    const declined = execute(peerAware, unproven);
    assert.equal(declined.status, 0, declined.stderr);
    assert.doesNotMatch(declined.stdout, /BODY_EXECUTED/u);
    const output = JSON.parse(
      declined.stdout.trim().slice("FMCAD_SCENARIO ".length),
    );
    assert.deepEqual(output, {
      creationId: identity.creationId,
      admission: {
        status: "inventory-changed",
        requestId: admission.requestId,
        mutationStarted: false,
        bodyCalls: 0,
      },
    });
  }
  const foreignMutation = execute(
    featureModeProbeSource(
      identity,
      [opened],
      "app.documents[1].isModified = False",
      admission,
    ),
    [opened],
  );
  assert.notEqual(foreignMutation.status, 0);
  assert.match(
    foreignMutation.stderr,
    /Other document state changed during feature probe/u,
  );
  await assert.rejects(
    guardedFeatureModeProbeSource(
      identity,
      async () => {
        assertReceiptBoundDocumentInventory(
          [closed],
          [opened],
          new Map([
            [closed.creationId, { document: closed, state: "unsettled" }],
            [opened.creationId, { document: opened, state: "open" }],
          ]),
          "Unknown close outcome",
        );
        return current;
      },
      "pass",
    ),
  );
});

test("feature-mode scenario submits CAD through the existing command pipeline", async (t) => {
  const { backend, directory } = await fixture(t, "addin");
  const commands: string[] = [];
  const helperSources: string[] = [];
  const rejected = new Map<string, Execution>();
  const lookup = backend.lookup;
  assert.ok(lookup);
  const reports = await runScenarios(
    {
      ...backend,
      capabilities: new Set([
        ...backend.capabilities,
        nativeFeatureModesCapability,
      ]),
      async execute(request) {
        if (!request.command && request.helpers !== "cad-v1") {
          assert.doesNotMatch(
            request.source,
            /_modeling_compat_source|_fmcad_compat_file/,
          );
          return backend.execute(request);
        }
        if (request.command) commands.push(request.command.operation);
        else helperSources.push(request.source);
        const result: Execution = {
          requestId: request.requestId,
          state: "failed",
          sdkSettled: true,
          mayHaveMutated: false,
          stdout: "",
          error: "Deliberate offline rejection after command preparation",
        };
        rejected.set(request.requestId, result);
        return result;
      },
      lookup: (owner, requestId) =>
        Promise.resolve(rejected.get(requestId) ?? lookup(owner, requestId)),
    },
    nativeFeatureModesScenarios(1),
    directory,
    1,
  );
  assert.equal(reports[0]?.status, "failed");
  assert.ok(
    helperSources.some((source) => source.includes('"component.create"')),
    JSON.stringify(reports),
  );
  assert.equal(
    commands.length,
    0,
    "The initial mutating CAD call must retain its in-turn fence",
  );
});

for (const [name, body] of [
  ["line", featureModeLineProbe(reference)],
  ...(["extrude", "hole", "sweep", "sweepRail", "loft"] as const).map(
    (mode) =>
      [
        `feature-properties-${mode}`,
        featureModePropertiesProbe(reference, mode),
      ] as const,
  ),
  ["hole-input", featureModeHoleInputProbe(reference, "OwnedComponent")],
] as const) {
  test(`feature-mode ${name} uses the public helper and passes final receipt admission`, async (t) => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "feature-mode-admission-"),
    );
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, "probe.py");
    fs.writeFileSync(
      file,
      featureModeProbeSource(
        { name: "OwnedFixture", creationId: "owned-creation" },
        [],
        body,
        { requestId: "feature-" + name, peers: [] },
      ),
    );
    const original = prepareRunScript(
      file,
      [],
      false,
      "OwnedFixture",
      { docId: "owned-creation" },
      "cad-v1",
      [],
    );
    const receipt = prepareReceiptScript(
      original.script,
      true,
      "/offline/feature-mode.json",
      { jobId: name },
      { mapPath: (value) => value },
    );
    const artifact = retainPythonOrigin(
      receipt,
      pythonArtifactManifest(original),
    );
    const request = {
      jsonrpc: "2.0",
      id: name,
      method: "tools/call",
      params: {
        name: "fusion_mcp_execute",
        arguments: {
          featureType: "script",
          object: { script: artifact.script },
        },
      },
    };
    const admission = createPythonRpcAdmission({ runtime, checker });
    const certificate = await admission
      .check(request, artifact)
      .catch((error: unknown) => {
        assert.fail(JSON.stringify(error));
      });
    assert.equal(certificate.report?.status, "passed");
    certificate.fence(request);
    const changed = structuredClone(request);
    changed.params.arguments.object.script += "\nraise RuntimeError('changed')";
    assert.throws(() => certificate.fence(changed));
  });
}

test("feature-mode component creation uses canonical public preparation", async () => {
  const artifact = prepareCadScript(
    "component.create",
    { name: "OwnedComponent" },
    { doc: "OwnedFixture", docId: "owned-creation" },
  );
  const result = await checker.check({ artifact, context: { kind: "bundle" } });
  assert.equal(result.status, "passed", JSON.stringify(result));
  assert.ok(artifact.units.some((unit) => unit.role === "runtime"));
});

test("public helper admission still rejects dynamic execution", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "feature-mode-negative-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "dynamic.py");
  fs.writeFileSync(file, program("exec(input())"));
  const artifact = prepareRunScript(
    file,
    [],
    false,
    "OwnedFixture",
    { docId: "owned-creation" },
    "cad-v1",
    [],
  );
  const report = await checker.check({ artifact, context: { kind: "bundle" } });
  assert.notEqual(report.status, "passed");
  assert.match(JSON.stringify(report.reasons), /unresolved dynamic exec/);
});

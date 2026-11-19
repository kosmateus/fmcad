import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { ScenarioSession, type ScenarioReport } from "./runner";
import type { ScenarioBackend } from "./contracts";
import { currentProcessIdentity } from "./fixture-provenance";
import { nativeLegacyScenarios } from "./native-legacy-cases";
import { marker } from "./programs";

function fixture(t: TestContext) {
  const parent = path.join(process.cwd(), ".test-artifacts/scenario-unit");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "legacy-final-")),
    runId = randomUUID(),
    scenarioId = "native-legacy-0",
    directory = path.join(root, runId, scenarioId),
    owner = { runId, scenarioId, clientId: `scenario:${runId}:${scenarioId}` },
    user = {
      creationId: "user",
      name: "Original user",
      saved: false,
      modified: false,
      fileId: null,
    },
    peer = {
      creationId: "peer",
      name: "Proven peer",
      saved: false,
      modified: true,
      fileId: null,
    },
    own = { creationId: "owned", name: "Own legacy" },
    peerRun = randomUUID(),
    peerId = "peer-owner",
    peerDirectory = path.join(root, peerRun, peerId),
    peerClient = `scenario:${peerRun}:${peerId}`,
    peerIdentity = {
      creationId: peer.creationId,
      name: peer.name,
      activeCreationId: peer.creationId,
      clientId: peerClient,
      requestId: peerClient + ":0",
    };
  const backend: ScenarioBackend = {
    mode: "fusion",
    protocol: "addin",
    qualification: "broker",
    identity: "legacy-final-proof",
    capabilities: new Set(),
    fusionPath: (file) => file,
    async execute() {
      throw new Error("No SDK dispatch is allowed in this boundary test");
    },
  };
  const profile = {
      mode: backend.mode,
      protocol: backend.protocol,
      qualification: backend.qualification,
      backendIdentity: backend.identity,
    },
    peerReport = {
      owner: { runId: peerRun, scenarioId: peerId, clientId: peerClient },
      directory: peerDirectory,
      ...profile,
      scope: "owned-document",
      status: "running",
      cleanup: "pending",
      document: { creationId: peer.creationId, name: peer.name },
      requests: [
        {
          phase: "create",
          requestId: peerIdentity.requestId,
          intent: { kind: "script" },
          result: {
            requestId: peerIdentity.requestId,
            state: "succeeded",
            sdkSettled: true,
            mayHaveMutated: true,
            exitCode: 0,
            stdout: marker + JSON.stringify(peerIdentity),
            brokerReceipt: {
              requestId: peerIdentity.requestId,
              clientId: peerClient,
              jobId: randomUUID(),
              state: "succeeded",
            },
          },
        },
      ],
    },
    after = {
      creationId: own.creationId,
      documents: [
        { ...user, active: true },
        { ...peer, active: false },
      ],
      active: user.name,
      activeCreationId: user.creationId,
    };
  const write = (file: string, value: unknown) =>
    fs.writeFileSync(file, JSON.stringify(value));
  fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(peerDirectory, { recursive: true });
  fs.mkdirSync(path.join(root, runId, "_coordinator"));
  write(path.join(root, runId, "index.json"), {
    runId,
    ...profile,
    before: { documents: [user], active: user.creationId },
  });
  const coordinator = `scenario:${runId}:coordinator`;
  write(path.join(root, runId, "_coordinator/before.result.json"), {
    requestId: coordinator + ":before",
    state: "succeeded",
    sdkSettled: true,
    stdout:
      marker +
      JSON.stringify({ documents: [user, peer], active: user.creationId }),
    brokerReceipt: {
      requestId: coordinator + ":before",
      clientId: coordinator,
      jobId: randomUUID(),
      state: "succeeded",
    },
  });
  write(path.join(root, peerRun, "index.json"), {
    runId: peerRun,
    ...profile,
    before: { documents: [] },
    scenarioIds: [peerId],
    status: "running",
    processIdentity: currentProcessIdentity(),
  });
  write(path.join(peerDirectory, "creation.json"), peerIdentity);
  write(path.join(peerDirectory, "report.json"), peerReport);
  const report: ScenarioReport = {
      owner,
      directory,
      ...profile,
      scope: "exclusive-instance",
      status: "running",
      cleanup: "pending",
      document: own,
      requests: [],
    },
    session = new ScenarioSession(
      backend,
      owner,
      directory,
      undefined,
      undefined,
      report,
    );
  let cleanupCalls = 0;
  session.legacyScript = async () => {};
  session.cleanup = async () => {
    cleanupCalls++;
    session.report.cleanup = "complete";
  };
  let observedSource = "";
  session.observe = async (_phase, source) => {
    observedSource = source;
    return after;
  };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    user,
    peer,
    after,
    peerReport,
    peerDirectory,
    write,
    session,
    run: () => nativeLegacyScenarios(1)[0]!.run(session),
    cleanupCalls: () => cleanupCalls,
    observedSource: () => observedSource,
  };
}

test("legacy final inventory accepts exact proven peers without changing user rows or active identity", async (t) => {
  const f = fixture(t);
  await f.run();
  assert.equal(f.cleanupCalls(), 1);
});

test("legacy final read-only inventory accepts an exact visible peer after its producer ends", async (t) => {
  const f = fixture(t),
    file = path.join(f.peerDirectory, "..", "index.json"),
    index = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
      string,
      unknown
    >;
  index["status"] = "completed";
  f.write(file, index);
  await f.run();
  assert.equal(f.cleanupCalls(), 1);
});

test("the final legacy cleanup observation passes the complete production checker", async (t) => {
  const f = fixture(t);
  await f.run();
  const root = path.resolve(__dirname, "../../.."),
    load = createRequire(path.join(root, "package.json")),
    { prepareRunScript } = load(
      "./src/run",
    ) as typeof import("../../src/composition/run"),
    { preparePythonArtifact } = load(
      "./packages/node-adapters/dist/python/artifact",
    ) as typeof import("../../packages/node-adapters/src/python/artifact"),
    { createPythonChecker } = load(
      "./packages/node-adapters/dist/python/checker",
    ) as typeof import("../../packages/node-adapters/src/python/checker"),
    file = path.join(f.session.directory, "after-cleanup.py");
  fs.writeFileSync(file, f.observedSource());
  const prepared = prepareRunScript(file, undefined, false),
    artifact = preparePythonArtifact([
      {
        id: "legacy-after-cleanup",
        filename: "after-cleanup.py",
        role: "user",
        source: prepared.script + '\nrun("")\n',
      },
    ]),
    typingRoot = path.join(root, "dist/runtime/python/typing"),
    checker = createPythonChecker({
      typingRoot,
      definitionsRoot: typingRoot,
      pythonPlatform: "Windows",
    }),
    result = await checker.check({ artifact, context: { kind: "run" } });
  assert.equal(result.status, "passed", JSON.stringify(result));
  assert.equal(result.provenance.checkerVersion, "1.40.2");
  assert.equal(
    result.provenance.definitionsHash,
    "83dc3697aa61a47ada93c323e2f719c7be3d72091938415f666089a96b159179",
  );
});

test("legacy final inventory requires and accepts the exact peer close after its original observation", async (t) => {
  const f = fixture(t),
    original = f.peerReport.requests[0]!;
  const requestId = f.peerReport.owner.clientId + ":1";
  f.peerReport.requests.push({
    ...original,
    phase: "cleanup",
    requestId,
    result: {
      ...original.result,
      requestId,
      stdout:
        marker +
        JSON.stringify({ creationId: f.peer.creationId, closed: true }),
      brokerReceipt: {
        ...original.result.brokerReceipt,
        requestId,
        jobId: randomUUID(),
      },
    },
  });
  f.peerReport.cleanup = "complete";
  f.peerReport.status = "passed";
  f.write(path.join(f.peerDirectory, "report.json"), f.peerReport);
  f.after.documents.pop();
  await f.run();
  assert.equal(f.cleanupCalls(), 1);
});

const invalid: { name: string; change(f: ReturnType<typeof fixture>): void }[] =
  [
    {
      name: "user document modification",
      change(f) {
        f.after.documents[0]!.modified = true;
      },
    },
    {
      name: "same-name foreign document",
      change(f) {
        f.after.documents[0]!.creationId = "foreign-id";
      },
    },
    {
      name: "changed user active identity",
      change(f) {
        f.after.activeCreationId = f.peer.creationId;
        f.after.active = f.peer.name;
      },
    },
    {
      name: "unproven new document",
      change(f) {
        f.after.documents.push({
          ...f.peer,
          creationId: "foreign-id",
          active: false,
        });
      },
    },
    {
      name: "observed peer disappearance without close",
      change(f) {
        f.after.documents.pop();
      },
    },
    {
      name: "unknown peer receipt",
      change(f) {
        f.peerReport.requests[0]!.result.sdkSettled = false;
        f.write(path.join(f.peerDirectory, "report.json"), f.peerReport);
      },
    },
    {
      name: "changed held user baseline without settled lifecycle proof",
      change(f) {
        f.peerReport.cleanup = "deferred";
        Reflect.set(f.peerReport, "cleanupHold", {
          reason: "unknown",
          requestId: f.peerReport.requests[0]!.requestId,
        });
        f.write(path.join(f.peerDirectory, "report.json"), f.peerReport);
        const file = path.join(f.session.directory, "..", "index.json"),
          index = JSON.parse(fs.readFileSync(file, "utf8")) as {
            before: { documents: unknown[] };
          };
        index.before.documents.push(f.peer);
        f.write(file, index);
        f.after.documents[1]!.modified = false;
      },
    },
    {
      name: "foreign coordinator receipt",
      change(f) {
        const file = path.join(
            f.session.directory,
            "..",
            "_coordinator/before.result.json",
          ),
          value = JSON.parse(fs.readFileSync(file, "utf8")) as {
            brokerReceipt: { clientId: string };
          };
        value.brokerReceipt.clientId = "foreign-client";
        f.write(file, value);
      },
    },
  ];
for (const fault of invalid)
  test(`legacy final inventory rejects ${fault.name} after owned cleanup`, async (t) => {
    const f = fixture(t);
    fault.change(f);
    await assert.rejects(() => f.run());
    assert.equal(f.cleanupCalls(), 1);
  });

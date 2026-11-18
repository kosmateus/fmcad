import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { record, type Execution, type ScenarioBackend } from "./contracts";
import {
  resolveCleanupHold,
  validateCleanupResolution,
  type CleanupHoldPorts,
} from "./cleanup-hold-resolution";
import { resumeCleanup } from "./runner";
import * as programs from "./programs";
import { childProcessIdentity } from "./legacy-handoff";
import { createRequire } from "node:module";

function fixture(t: TestContext, pose = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-held-resolution-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runId = randomUUID(),
    scenarioId = pose ? "native-pose-methods-0" : "native-thread-1";
  const owner = {
    runId,
    scenarioId,
    clientId: `scenario:${runId}:${scenarioId}`,
  };
  const directory = path.join(root, runId, scenarioId);
  fs.mkdirSync(directory, { recursive: true });
  const document = {
    creationId: randomUUID(),
    name: `FMCAD_SCENARIO_${runId}_${scenarioId}`,
  };
  const runtime = { buildHash: "a".repeat(64), instanceId: randomUUID() };
  const originals = new Map<string, unknown>(),
    executions = new Map<string, Execution>();
  const marker = (value: unknown) =>
    "FMCAD_SCENARIO " + JSON.stringify(value) + "\n";
  const create = {
    ...document,
    requestId: owner.clientId + ":0",
    clientId: owner.clientId,
  };
  const request = (
    ordinal: number,
    phase: string,
    stdout: string,
    source: string,
  ) => {
    const requestId = owner.clientId + ":" + ordinal;
    const filename = path.join(directory, `request-${ordinal}.py`);
    fs.writeFileSync(filename, source);
    const jobId = randomUUID();
    const result: Execution = {
      requestId,
      state: "succeeded",
      sdkSettled: true,
      mayHaveMutated: true,
      stdout,
      brokerReceipt: {
        requestId,
        jobId,
        clientId: owner.clientId,
        state: "succeeded",
        operationResult: {},
      },
    };
    executions.set(requestId, result);
    const now = Date.now();
    originals.set(requestId, {
      job: {
        id: jobId,
        requestId,
        clientId: owner.clientId,
        state: "succeeded",
        submittedAt: now - 2,
        startedAt: now - 1,
        finishedAt: now,
      },
      stdout,
      stderr: "",
      execution: { state: "succeeded", sdkSettled: true, mayHaveMutated: true },
      pythonChecks: [
        {
          status: "passed",
          diagnostics: [],
          reasons: [],
          provenance: {
            checkerVersion: "1.40.2",
            definitionsHash:
              "83dc3697aa61a47ada93c323e2f719c7be3d72091938415f666089a96b159179",
          },
        },
      ],
      provenance: {
        status: "available",
        inputs: [
          {
            kind: "source",
            originalPath: filename,
            bytes: Buffer.byteLength(source),
            sha256: createHash("sha256").update(source).digest("hex"),
          },
        ],
      },
    });
    return {
      requestId,
      phase,
      intent: {
        kind: ordinal === 0 ? "script" : "cad-fenced",
        ...(ordinal ? { operation: "model.thread" } : {}),
      },
      result,
    };
  };
  const rows = [{ ...document, saved: false, modified: true, fileId: null }];
  const requests = [
    request(0, "create", marker(create), "# original owned create\n"),
    request(
      1,
      "cad-native-modeling-13-model.thread",
      "FMCAD_RESULT " +
        JSON.stringify({
          success: true,
          helperCallsOnly: [],
          result: {
            success: true,
            operation: "model.thread",
            document: document.name,
            creationId: document.creationId,
            admission: {
              status: "inventory-changed",
              requestId: owner.clientId + ":1",
              helperCalls: 0,
              mutationStarted: false,
            },
            inventoryFence: { version: 1, before: rows, after: rows },
          },
        }),
      programs.cadFence(
        document,
        "model.thread",
        {},
        [],
        [],
        [],
        "root",
        owner.clientId + ":1",
      ),
    ),
  ];
  if (pose) {
    requests.pop();
    const shape = request(
      1,
      "cad-native-pose-methods-2",
      JSON.stringify({
        success: true,
        operation: "shape.box",
        document: document.name,
        result: {
          recipe: "box",
          feature: { name: "PoseBody" },
          bodies: [
            {
              token: "pose-owned-body",
              kind: "body",
              component: { name: "root" },
            },
          ],
        },
      }),
      "",
    );
    shape.intent = { kind: "cad" };
    record(fixRaw(shape.requestId)["provenance"])["inputIdentity"] = "d".repeat(
      64,
    );
    requests.push(
      shape,
      request(
        2,
        "observe-native-pose-methods-guard-3",
        marker({ creationId: document.creationId, documents: rows }),
        programs.unsavedState(document),
      ),
    );
  }
  function fixRaw(id: string) {
    return record(originals.get(id));
  }
  const report = {
    owner,
    directory,
    backendIdentity: "fusion:addin:" + runtime.buildHash,
    mode: "fusion",
    qualification: "broker",
    protocol: "addin",
    scope: "exclusive-instance",
    status: "failed",
    cleanup: "deferred",
    document,
    requests,
    cleanupHold: {
      requestId: requests[1]!.requestId,
      reason:
        "Fenced CAD turn failed; leave the owned document for inspection: Inventory re-admission lacks exact peer lifecycle receipts",
    },
  };
  if (pose)
    report.cleanupHold = {
      requestId: requests[2]!.requestId,
      reason:
        "Owned unsaved fixture guard failed; inspect original identity before cleanup: A non-fixture document changed during the owned unsaved case",
    };
  fs.writeFileSync(path.join(directory, "report.json"), JSON.stringify(report));
  fs.writeFileSync(
    path.join(directory, "creation.json"),
    JSON.stringify(create),
  );
  fs.writeFileSync(
    path.join(directory, "..", "index.json"),
    JSON.stringify({
      runId,
      status: "failed",
      processIdentity: {
        pid: 99999999,
        birth: childProcessIdentity.processBirth(),
      },
      before: { documents: [] },
    }),
  );
  let submissions = 0;
  const backend: ScenarioBackend = {
    identity: report.backendIdentity,
    mode: "fusion",
    qualification: "broker",
    protocol: "addin",
    capabilities: new Set(),
    fusionPath: (value) => value,
    lookup: async (_owner, id) => executions.get(id) ?? null,
    async execute(input) {
      submissions++;
      const stdout = marker({
        creationId: document.creationId,
        saved: false,
        modified: true,
        fileId: null,
        ...(pose
          ? { body: { token: "pose-owned-body", count: 1, volume: 1.68 } }
          : {}),
        inventoryFence: { version: 1, before: rows, after: rows },
      });
      const entry = request(
        Number(input.requestId.split(":").at(-1)),
        "inspection",
        stdout,
        input.source,
      );
      return entry.result;
    },
  };
  const ports: CleanupHoldPorts = {
    readRuntimeBinding: async () => runtime,
    readOriginalResult: async (_owner, id) => originals.get(id),
  };
  return {
    directory,
    report,
    backend,
    ports,
    runtime,
    document,
    originals,
    executions,
    request,
    submissions: () => submissions,
  };
}

test("supported held resolution preserves the original failed report and binds a new inspection", async (t) => {
  const f = fixture(t),
    filename = path.join(f.directory, "report.json");
  const before = fs.readFileSync(filename);
  const decision = await resolveCleanupHold(f.backend, f.directory, f.ports);
  assert.deepEqual(decision.document, f.document);
  assert.equal(decision.inspectedModified, true);
  assert.equal(f.submissions(), 1);
  assert.deepEqual(fs.readFileSync(filename), before);
  assert.deepEqual(
    validateCleanupResolution(f.directory, f.backend, f.runtime),
    decision,
  );
});

test("pose observation holds resolve using the authenticated owned shape and fresh exact-body inspection", async (t) => {
  const f = fixture(t, true),
    filename = path.join(f.directory, "report.json"),
    before = fs.readFileSync(filename);
  const proof = await resolveCleanupHold(f.backend, f.directory, f.ports);
  assert.equal(proof.inspectedModified, true);
  assert.equal(f.submissions(), 1);
  assert.deepEqual(fs.readFileSync(filename), before);
  assert.deepEqual(
    validateCleanupResolution(f.directory, f.backend, f.runtime),
    proof,
  );
});

test("settled historical failures remain failures and do not require fictional PASS for resolution", async (t) => {
  const f = fixture(t);
  const failed = f.request(
    3,
    "cad-native-history.check",
    JSON.stringify({
      success: false,
      operation: "history.check",
      error: "Historical check failed",
    }),
    "# historical failed readonly check\n",
  );
  const result = {
    ...failed.result,
    state: "failed" as const,
    brokerReceipt: {
      ...failed.result.brokerReceipt!,
      state: "failed" as const,
    },
  };
  failed.result = result;
  f.executions.set(failed.requestId, result);
  const raw = record(f.originals.get(failed.requestId));
  record(raw["job"])["state"] = "failed";
  record(raw["execution"])["state"] = "failed";
  f.report.requests.splice(1, 0, failed);
  const filename = path.join(f.directory, "report.json");
  fs.writeFileSync(filename, JSON.stringify(f.report));
  const before = fs.readFileSync(filename);
  await resolveCleanupHold(f.backend, f.directory, f.ports);
  assert.deepEqual(fs.readFileSync(filename), before);
  const decision = JSON.parse(
    fs.readFileSync(
      path.join(f.directory, "cleanup-hold-resolution.json"),
      "utf8",
    ),
  ) as { originals: { job: { state: string } }[] };
  assert.equal(decision.originals[1]!.job.state, "failed");
  assert.equal(f.report.status, "failed");
});

test("existing default cleanup still refuses a case-specific hold without submitting", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    resumeCleanup(f.backend, path.join(f.directory, "report.json")),
    /cleanup hold/u,
  );
  assert.equal(f.submissions(), 0);
});

test("unknown original evidence cannot authorize even the inspection", async (t) => {
  const f = fixture(t),
    requestId = f.report.requests[1]!.requestId;
  const original = record(f.originals.get(requestId));
  record(original["execution"])["sdkSettled"] = false;
  await assert.rejects(resolveCleanupHold(f.backend, f.directory, f.ports));
  assert.equal(f.submissions(), 0);
});

for (const [name, change] of Object.entries({
  "foreign job": (raw: Record<string, unknown>) => {
    record(raw["job"])["id"] = randomUUID();
  },
  "foreign owner": (raw: Record<string, unknown>) => {
    record(raw["job"])["clientId"] = "foreign";
  },
  "missing source provenance": (raw: Record<string, unknown>) => {
    record(raw["provenance"])["inputs"] = [];
  },
  "source digest mismatch": (raw: Record<string, unknown>) => {
    record((record(raw["provenance"])["inputs"] as unknown[])[0])["sha256"] =
      "b".repeat(64);
  },
  "nonterminal job": (raw: Record<string, unknown>) => {
    record(raw["job"])["state"] = "unknown";
  },
}))
  test(`resolution rejects ${name} before inspection`, async (t) => {
    const f = fixture(t);
    change(record(f.originals.get(f.report.requests[1]!.requestId)));
    await assert.rejects(resolveCleanupHold(f.backend, f.directory, f.ports));
    assert.equal(f.submissions(), 0);
    assert.equal(
      fs.existsSync(path.join(f.directory, "cleanup-hold-resolution.json")),
      false,
    );
  });

test("a forged no-helper marker cannot bless a changed admission source", async (t) => {
  const f = fixture(t),
    sourceFile = path.join(f.directory, "request-1.py");
  const source = fs
    .readFileSync(sourceFile, "utf8")
    .replace(
      "    app = adsk.core.Application.get()",
      "    app = adsk.core.Application.get()\n    app.activeDocument.close(False)",
    );
  fs.writeFileSync(sourceFile, source);
  const raw = record(f.originals.get(f.report.requests[1]!.requestId));
  const input = record((record(raw["provenance"])["inputs"] as unknown[])[0]);
  input["sha256"] = createHash("sha256").update(source).digest("hex");
  input["bytes"] = Buffer.byteLength(source);
  await assert.rejects(
    resolveCleanupHold(f.backend, f.directory, f.ports),
    /supported admission program/u,
  );
  assert.equal(f.submissions(), 0);
});

test("an active original producer blocks resolution", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    path.join(f.directory, "..", "index.json"),
    JSON.stringify({
      runId: f.report.owner.runId,
      status: "running",
      processIdentity: {
        pid: process.pid,
        birth: childProcessIdentity.processBirth(),
      },
    }),
  );
  await assert.rejects(
    resolveCleanupHold(f.backend, f.directory, f.ports),
    /producer is active/u,
  );
  assert.equal(f.submissions(), 0);
});

test("a runtime nonce change during evidence recovery blocks inspection", async (t) => {
  const f = fixture(t);
  let reads = 0;
  f.ports.readRuntimeBinding = async () => ({
    ...f.runtime,
    instanceId: ++reads === 1 ? f.runtime.instanceId : randomUUID(),
  });
  await assert.rejects(resolveCleanupHold(f.backend, f.directory, f.ports));
  assert.equal(f.submissions(), 0);
});

test("canonical validation notices tampered history and rejects foreign runtime bindings", async (t) => {
  const f = fixture(t);
  await resolveCleanupHold(f.backend, f.directory, f.ports);
  assert.throws(() =>
    validateCleanupResolution(f.directory, f.backend, {
      ...f.runtime,
      instanceId: randomUUID(),
    }),
  );
  fs.appendFileSync(path.join(f.directory, "report.json"), "\n");
  assert.throws(() =>
    validateCleanupResolution(f.directory, f.backend, f.runtime),
  );
});

test("an inspection failure cannot publish authorization or be replayed", async (t) => {
  const f = fixture(t),
    execute = f.backend.execute.bind(f.backend);
  f.backend.execute = async (input) => {
    const result = await execute(input);
    const raw = record(f.originals.get(input.requestId));
    record(raw["execution"])["sdkSettled"] = false;
    return result;
  };
  await assert.rejects(resolveCleanupHold(f.backend, f.directory, f.ports));
  assert.equal(f.submissions(), 1);
  assert.equal(
    fs.existsSync(path.join(f.directory, "cleanup-hold-resolution.json")),
    false,
  );
  await assert.rejects(resolveCleanupHold(f.backend, f.directory, f.ports));
  assert.equal(f.submissions(), 1);
});

for (const pose of [false, true])
  test(`the actual ${pose ? "pose" : "admission"} resolution inspection passes the pinned production checker`, async (t) => {
    const f = fixture(t, pose);
    const proof = await resolveCleanupHold(f.backend, f.directory, f.ports);
    const source = fs.readFileSync(
      path.join(
        f.directory,
        `request-${proof.inspectionRequestId.split(":").at(-1)}.py`,
      ),
      "utf8",
    );
    const root = path.resolve(__dirname, "../../.."),
      load = createRequire(path.join(root, "package.json"));
    const { createPythonChecker } = load(
      "./packages/node-adapters/dist/python/checker",
    ) as typeof import("../../packages/node-adapters/src/python/checker");
    const { preparePythonArtifact } = load(
      "./packages/node-adapters/dist/python/artifact",
    ) as typeof import("../../packages/node-adapters/src/python/artifact");
    const typingRoot = path.join(root, "dist/runtime/python/typing");
    const checker = createPythonChecker({
      typingRoot,
      definitionsRoot: typingRoot,
      pythonPlatform: "Windows",
    });
    const artifact = preparePythonArtifact([
      {
        id: "inspection",
        filename: "inspection.py",
        role: "user",
        source: source + '\nrun("")\n',
      },
    ]);
    const result = await checker.check({ artifact, context: { kind: "run" } });
    assert.equal(result.status, "passed", JSON.stringify(result));
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.provenance.checkerVersion, "1.40.2");
    assert.equal(
      result.provenance.definitionsHash,
      "83dc3697aa61a47ada93c323e2f719c7be3d72091938415f666089a96b159179",
    );
  });

test("a pose inspection cannot substitute a foreign body token", async (t) => {
  const f = fixture(t, true),
    execute = f.backend.execute.bind(f.backend);
  f.backend.execute = async (input) => {
    const result = await execute(input),
      raw = record(f.originals.get(input.requestId));
    const stdout = result.stdout!.replace("pose-owned-body", "foreign-body");
    const changed = { ...result, stdout };
    raw["stdout"] = stdout;
    f.executions.set(input.requestId, changed);
    return changed;
  };
  await assert.rejects(resolveCleanupHold(f.backend, f.directory, f.ports));
  assert.equal(
    fs.existsSync(path.join(f.directory, "cleanup-hold-resolution.json")),
    false,
  );
});

for (const failure of [
  "stale",
  "saved",
  "foreign-inventory",
  "missing-checker",
] as const)
  test(`a ${failure} inspection cannot publish cleanup authorization`, async (t) => {
    const f = fixture(t),
      execute = f.backend.execute.bind(f.backend);
    f.backend.execute = async (input) => {
      const result = await execute(input),
        raw = record(f.originals.get(input.requestId));
      if (failure === "missing-checker") {
        raw["pythonChecks"] = [];
        return result;
      }
      if (failure === "stale") {
        const job = record(raw["job"]);
        for (const key of ["submittedAt", "startedAt", "finishedAt"])
          job[key] = Number(job[key]) - 600_000;
        return result;
      }
      const value = record(
        JSON.parse(result.stdout!.slice(programs.marker.length)) as unknown,
      );
      if (failure === "saved") value["saved"] = true;
      else record(value["inventoryFence"])["after"] = [];
      const stdout = programs.marker + JSON.stringify(value),
        changed = { ...result, stdout };
      raw["stdout"] = stdout;
      f.executions.set(input.requestId, changed);
      return changed;
    };
    await assert.rejects(resolveCleanupHold(f.backend, f.directory, f.ports));
    assert.equal(
      fs.existsSync(path.join(f.directory, "cleanup-hold-resolution.json")),
      false,
    );
  });

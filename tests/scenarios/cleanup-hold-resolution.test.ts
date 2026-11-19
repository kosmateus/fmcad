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
  validateCleanupResolutionForClose,
  createCleanupRecoveryAdapter,
  recordFailedCleanupInspection,
  type CleanupHoldPorts,
} from "./cleanup-hold-resolution";
import { resumeCleanup } from "./runner";
import * as programs from "./programs";
import { childProcessIdentity } from "./legacy-handoff";
import { createRequire } from "node:module";
import { queueExecution } from "./queue-backend";

function fixture(t: TestContext, pose = false, modified = true) {
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
    activeCreationId: document.creationId,
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
    const operationResult = {
      version: 1,
      requestId,
      jobId,
      acceptance: "accepted",
      executionOutcome: "succeeded",
      mayHaveMutated: true,
    };
    const result: Execution = {
      requestId,
      state: "succeeded",
      sdkSettled: true,
      mayHaveMutated: true,
      stdout,
      exitCode: 0,
      brokerReceipt: {
        requestId,
        jobId,
        clientId: owner.clientId,
        state: "succeeded",
        operationResult,
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
        kind: "command",
        operationResult,
        submittedAt: now,
        startedAt: now,
        finishedAt: now,
      },
      stdout,
      stderr: "",
      execution: {
        state: "succeeded",
        sdkSettled: true,
        mayHaveMutated: true,
        exitCode: 0,
        publicationOutcome: "published",
      },
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
  const rows = [{ ...document, saved: false, modified, fileId: null }];
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
      mode: report.mode,
      qualification: report.qualification,
      protocol: report.protocol,
      backendIdentity: report.backendIdentity,
      scenarioIds: [scenarioId],
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
      const closing = input.source.includes("doc.close(False)");
      const stdout = marker(
        closing
          ? {
              creationId: document.creationId,
              closed: true,
              inventoryFence: { version: 1, before: rows, after: [] },
            }
          : {
              creationId: document.creationId,
              saved: false,
              modified,
              fileId: null,
              ...(pose
                ? { body: { token: "pose-owned-body", count: 1, volume: 1.68 } }
                : {}),
              inventoryFence: { version: 1, before: rows, after: rows },
            },
      );
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
  assert.deepEqual(
    await resolveCleanupHold(f.backend, f.directory, f.ports),
    decision,
  );
  assert.equal(
    f.submissions(),
    1,
    "A verified inspection must not be replayed",
  );
});

test("pristine admission holds bind the authenticated clean state instead of requiring a mutation", async (t) => {
  const f = fixture(t, false, false);
  const proof = await resolveCleanupHold(f.backend, f.directory, f.ports);
  assert.equal(proof.inspectedModified, false);
  assert.match(
    fs.readFileSync(path.join(f.directory, "request-2.py"), "utf8"),
    /assert doc\.isModified == False/u,
  );
  assert.deepEqual(
    validateCleanupResolution(f.directory, f.backend, f.runtime),
    proof,
  );
});

for (const modified of [false, true])
  test(`inspection rejects unexpected modified drift from ${modified} to ${!modified}`, async (t) => {
    const f = fixture(t, false, modified),
      execute = f.backend.execute.bind(f.backend);
    f.backend.execute = async (input) => {
      const result = await execute(input),
        raw = record(f.originals.get(input.requestId));
      const value = record(
        JSON.parse(result.stdout.slice(programs.marker.length)) as unknown,
      );
      value["modified"] = !modified;
      const fence = record(value["inventoryFence"]);
      for (const key of ["before", "after"])
        for (const row of fence[key] as Record<string, unknown>[])
          if (row["creationId"] === f.document.creationId)
            row["modified"] = !modified;
      const changed = {
        ...result,
        stdout: programs.marker + JSON.stringify(value),
      };
      raw["stdout"] = changed.stdout;
      f.executions.set(input.requestId, changed);
      return changed;
    };
    await assert.rejects(resolveCleanupHold(f.backend, f.directory, f.ports));
    assert.equal(
      fs.existsSync(path.join(f.directory, "cleanup-hold-resolution.json")),
      false,
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
  record(record(raw["job"])["operationResult"])["executionOutcome"] = "failed";
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

for (const pose of [false, true])
  test(`resumeCleanup uses supported ${pose ? "pose" : "admission"} resolution and the canonical publisher without rewriting original FAIL or hold`, async (t) => {
    const f = fixture(t, pose),
      filename = path.join(f.directory, "report.json"),
      before = fs.readFileSync(filename);
    const result = await resumeCleanup(f.backend, filename, f.ports);
    assert.equal(result.status, "failed");
    assert.equal(result.cleanup, "complete");
    assert.equal(f.submissions(), 2);
    assert.deepEqual(fs.readFileSync(filename), before);
    assert.ok(
      fs.existsSync(path.join(f.directory, "cleanup-hold-resolution.json")),
    );
    assert.ok(fs.existsSync(path.join(f.directory, "supplemental-close.json")));
    const again = await resumeCleanup(f.backend, filename, f.ports);
    assert.equal(again.cleanup, "complete");
    assert.equal(
      f.submissions(),
      2,
      "Canonical closure recovery must not submit work",
    );
  });

test("resumeCleanup recovers an original settled close publication without submitting it twice", async (t) => {
  const f = fixture(t),
    execute = f.backend.execute.bind(f.backend);
  f.backend.execute = async (input) => {
    const result = await execute(input);
    return input.source.includes("doc.close(False)")
      ? { ...result, state: "unknown", sdkSettled: false }
      : result;
  };
  const filename = path.join(f.directory, "report.json"),
    before = fs.readFileSync(filename);
  await assert.rejects(
    resumeCleanup(f.backend, filename, f.ports),
    /Held cleanup did not succeed/u,
  );
  assert.equal(f.submissions(), 2);
  assert.equal(
    fs.existsSync(path.join(f.directory, "supplemental-close.json")),
    false,
  );
  const recovered = await resumeCleanup(f.backend, filename, f.ports);
  assert.equal(recovered.cleanup, "complete");
  assert.equal(f.submissions(), 2);
  assert.deepEqual(fs.readFileSync(filename), before);
});

test("resumeCleanup cannot publish an unknown original close or replay the admitted intent", async (t) => {
  const f = fixture(t),
    execute = f.backend.execute.bind(f.backend);
  f.backend.execute = async (input) => {
    const result = await execute(input);
    if (!input.source.includes("doc.close(False)")) return result;
    const raw = record(f.originals.get(input.requestId));
    record(raw["execution"])["sdkSettled"] = false;
    const unknown = { ...result, state: "unknown" as const, sdkSettled: false };
    f.executions.set(input.requestId, unknown);
    return unknown;
  };
  const filename = path.join(f.directory, "report.json");
  await assert.rejects(resumeCleanup(f.backend, filename, f.ports));
  await assert.rejects(resumeCleanup(f.backend, filename, f.ports));
  assert.equal(f.submissions(), 2);
  assert.equal(
    fs.existsSync(path.join(f.directory, "supplemental-close.json")),
    false,
  );
});

test("an existing resolution does not weaken default resume refusal", async (t) => {
  const f = fixture(t);
  await resolveCleanupHold(f.backend, f.directory, f.ports);
  await assert.rejects(
    resumeCleanup(f.backend, path.join(f.directory, "report.json")),
    /cleanup hold/u,
  );
  assert.equal(f.submissions(), 1);
});

test("resume rechecks a live dependent before closing from an existing resolution", async (t) => {
  const f = fixture(t);
  await resolveCleanupHold(f.backend, f.directory, f.ports);
  const peer = path.join(path.dirname(path.dirname(f.directory)), randomUUID());
  fs.mkdirSync(peer);
  fs.writeFileSync(
    path.join(peer, "index.json"),
    JSON.stringify({
      status: "running",
      processIdentity: {
        pid: process.pid,
        birth: childProcessIdentity.processBirth(),
      },
      before: { documents: [f.document] },
    }),
  );
  await assert.rejects(
    resumeCleanup(f.backend, path.join(f.directory, "report.json"), f.ports),
    /producer is active/u,
  );
  assert.equal(f.submissions(), 1);
  assert.equal(
    fs.existsSync(path.join(f.directory, "supplemental-close.intent.json")),
    false,
  );
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

test("close authorization requires freshness while historical validation remains valid after expiry", async (t) => {
  const f = fixture(t);
  const proof = await resolveCleanupHold(f.backend, f.directory, f.ports);
  assert.deepEqual(
    validateCleanupResolutionForClose(f.directory, f.backend, f.runtime),
    proof,
  );
  t.mock.method(Date, "now", () => proof.expiresAt);
  assert.deepEqual(
    validateCleanupResolution(f.directory, f.backend, f.runtime),
    proof,
  );
  assert.throws(
    () => validateCleanupResolutionForClose(f.directory, f.backend, f.runtime),
    /stale/u,
  );
});

test("historical adapter reads exact original report jobs even when a fresh backend has no lookup ledger", async (t) => {
  const f = fixture(t);
  const calls: string[] = [];
  const adapted = createCleanupRecoveryAdapter(
    { ...f.backend, lookup: async () => null },
    f.directory,
    {
      readRuntimeBinding: f.ports.readRuntimeBinding,
      readJobResult: async (owner, requestId, jobId) => {
        assert.deepEqual(owner, f.report.owner);
        const raw = record(f.originals.get(requestId));
        assert.equal(record(raw["job"])["id"], jobId);
        calls.push(requestId);
        return raw;
      },
    },
  );
  const id = f.report.requests[0]!.requestId;
  const recovered = await adapted.backend.lookup!(f.report.owner, id);
  assert.equal(
    recovered?.brokerReceipt?.jobId,
    f.report.requests[0]!.result.brokerReceipt?.jobId,
  );
  assert.deepEqual(calls, [id]);
  await assert.rejects(
    adapted.backend.lookup!({ ...f.report.owner, clientId: "foreign" }, id),
  );
});

for (const corruption of ["missing", "job", "request", "client"] as const)
  test(`historical adapter rejects ${corruption} authenticated original evidence without submission`, async (t) => {
    const f = fixture(t),
      id = f.report.requests[0]!.requestId;
    const adapted = createCleanupRecoveryAdapter(
      { ...f.backend, lookup: async () => null },
      f.directory,
      {
        readRuntimeBinding: f.ports.readRuntimeBinding,
        readJobResult: async () => {
          if (corruption === "missing") return null;
          const raw = structuredClone(record(f.originals.get(id))),
            job = record(raw["job"]);
          job[
            corruption === "job"
              ? "id"
              : corruption === "request"
                ? "requestId"
                : "clientId"
          ] = "foreign";
          return raw;
        },
      },
    );
    await assert.rejects(adapted.backend.lookup!(f.report.owner, id));
    assert.equal(f.submissions(), 0);
  });

test("historical adapter executes the supported full cleanup from authenticated original jobs and never replays originals", async (t) => {
  const f = fixture(t),
    originalIds = new Set(f.report.requests.map((row) => row.requestId));
  for (const row of f.report.requests)
    row.result = queueExecution(
      f.originals.get(row.requestId),
      f.report.owner,
      row.requestId,
    );
  fs.writeFileSync(
    path.join(f.directory, "report.json"),
    JSON.stringify(f.report),
  );
  const base: ScenarioBackend = {
    ...f.backend,
    lookup: async (_owner, id) =>
      originalIds.has(id) ? null : (f.executions.get(id) ?? null),
    execute: async (input) => {
      await f.backend.execute(input);
      const result = queueExecution(
        f.originals.get(input.requestId),
        input.owner,
        input.requestId,
      );
      f.executions.set(input.requestId, result);
      return result;
    },
  };
  const adapted = createCleanupRecoveryAdapter(base, f.directory, {
    readRuntimeBinding: f.ports.readRuntimeBinding,
    readJobResult: async (_owner, id, jobId) => {
      const raw = record(f.originals.get(id));
      assert.equal(record(raw["job"])["id"], jobId);
      return raw;
    },
  });
  const id = f.report.requests[0]!.requestId;
  await assert.rejects(
    adapted.backend.execute({
      owner: f.report.owner,
      requestId: id,
      directory: f.directory,
      target: f.document,
      source: "forbidden replay",
    }),
    /Never replay/u,
  );
  const original = fs.readFileSync(path.join(f.directory, "report.json"));
  const result = await resumeCleanup(
    adapted.backend,
    path.join(f.directory, "report.json"),
    adapted.ports,
  );
  assert.equal(result.cleanup, "complete");
  assert.equal(f.submissions(), 2);
  assert.deepEqual(
    fs.readFileSync(path.join(f.directory, "report.json")),
    original,
  );
});

test("the source-backed lost peer lifecycle admission reason is supported without changing history", async (t) => {
  const f = fixture(t);
  f.report.cleanupHold.reason =
    "Fenced CAD turn failed; leave the owned document for inspection: A previously admitted peer lost its exact lifecycle proof";
  fs.writeFileSync(
    path.join(f.directory, "report.json"),
    JSON.stringify(f.report),
  );
  const before = fs.readFileSync(path.join(f.directory, "report.json"));
  await resolveCleanupHold(f.backend, f.directory, f.ports);
  assert.deepEqual(
    fs.readFileSync(path.join(f.directory, "report.json")),
    before,
  );
});

for (const kind of ["unsupported-reason", "helper-mutation"] as const)
  test(`admission resolution rejects ${kind} without inspection`, async (t) => {
    const f = fixture(t);
    if (kind === "unsupported-reason")
      f.report.cleanupHold.reason =
        "Fenced CAD turn failed; leave the owned document for inspection: A previously admitted peer lost its exact lifecycle proof but mutation continued";
    else {
      const row = f.report.requests.at(-1)!,
        payload = record(
          JSON.parse(
            row.result.stdout.slice("FMCAD_RESULT ".length),
          ) as unknown,
        );
      record(record(payload["result"])["admission"])["mutationStarted"] = true;
      const result = {
        ...row.result,
        stdout: "FMCAD_RESULT " + JSON.stringify(payload),
      };
      row.result = result;
      f.executions.set(row.requestId, result);
      record(f.originals.get(row.requestId))["stdout"] = result.stdout;
    }
    fs.writeFileSync(
      path.join(f.directory, "report.json"),
      JSON.stringify(f.report),
    );
    await assert.rejects(resolveCleanupHold(f.backend, f.directory, f.ports));
    assert.equal(f.submissions(), 0);
  });

test("the adapter cannot turn an unbound attempted request into null lookup or a replay", async (t) => {
  const f = fixture(t);
  let dispatched = 0;
  const adapted = createCleanupRecoveryAdapter(
    {
      ...f.backend,
      lookup: async () => null,
      execute: async (input) => {
        dispatched++;
        return {
          requestId: input.requestId,
          state: "unknown",
          sdkSettled: false,
          mayHaveMutated: true,
          stdout: "",
        };
      },
    },
    f.directory,
    {
      readRuntimeBinding: f.ports.readRuntimeBinding,
      readJobResult: async () => null,
    },
  );
  const input = {
    owner: f.report.owner,
    requestId: f.report.owner.clientId + ":2",
    directory: f.directory,
    target: f.document,
    source: "readonly inspection",
  };
  assert.equal((await adapted.backend.execute(input)).state, "unknown");
  await assert.rejects(
    adapted.backend.lookup!(input.owner, input.requestId),
    /never replay/u,
  );
  await assert.rejects(adapted.backend.execute(input), /Never replay/u);
  assert.equal(dispatched, 1);
});

// Retained v1 readonly wire program from 66fb, independent of the current generator.
function legacyInspectionSource(document: {
  creationId: string;
  name: string;
}) {
  return programs.program(`import adsk.core, adsk.fusion, json
app = adsk.core.Application.get()
def inventory() -> list[dict[str, str | bool | None]]:
    return [dict(creationId=d.creationId,name=d.name,saved=d.isSaved,modified=d.isModified,fileId=d.dataFile.id if d.dataFile else None,active=d == app.activeDocument) for d in app.documents]
before = inventory()
matches = [d for d in app.documents if d.creationId == ${JSON.stringify(document.creationId)}]
assert len(matches) == 1, 'Owned creationId is unavailable'
doc = matches[0]
assert doc.name == ${JSON.stringify(document.name)}, 'Owned identity changed'
assert sum(d.name == doc.name for d in app.documents) == 1, 'Ambiguous owned name'
assert not doc.isSaved and doc.dataFile is None, 'Owned fixture became saved'
assert doc.isModified, 'Held modified fixture unexpectedly became clean'

after = inventory()
assert before == after, 'Inventory changed during inspection'
${programs.emit("dict(creationId=doc.creationId,saved=doc.isSaved,modified=doc.isModified,fileId=None,inventoryFence=dict(version=1,before=before,after=after))")}`);
}
function failedInspectionFixture(t: TestContext, modified = false) {
  const f = fixture(t, false, modified),
    sha = (value: string | Buffer) =>
      createHash("sha256").update(value).digest("hex");
  for (const row of f.report.requests)
    row.result = queueExecution(
      f.originals.get(row.requestId),
      f.report.owner,
      row.requestId,
    );
  fs.writeFileSync(
    path.join(f.directory, "report.json"),
    JSON.stringify(f.report),
  );
  const source = legacyInspectionSource(f.document),
    requestId = f.report.owner.clientId + ":2";
  f.request(
    2,
    "inspection",
    "Held modified fixture unexpectedly became clean\nAssertionError: Held modified fixture unexpectedly became clean\n",
    source,
  );
  const raw = record(f.originals.get(requestId));
  record(raw["job"])["state"] = "failed";
  record(record(raw["job"])["operationResult"])["executionOutcome"] = "failed";
  record(raw["execution"])["state"] = "failed";
  record(raw["execution"])["code"] = "SDK_EXECUTION_FAILED";
  record(raw["execution"])["exitCode"] = 1;
  record(raw["execution"])["publicationOutcome"] = "failed";
  const jobId = String(record(raw["job"])["id"]);
  const intent = {
    version: 1,
    nonce: randomUUID(),
    owner: f.report.owner,
    requestId,
    runtime: f.runtime,
    reportHash: sha(fs.readFileSync(path.join(f.directory, "report.json"))),
    sourceHash: sha(source),
  };
  fs.writeFileSync(
    path.join(f.directory, "cleanup-hold-inspection-intent.json"),
    JSON.stringify(intent) + "\n",
  );
  const recoveryPorts = {
    readRuntimeBinding: f.ports.readRuntimeBinding,
    readJobResult: async (
      _owner: typeof f.report.owner,
      id: string,
      job: string,
    ) => {
      const result = record(f.originals.get(id));
      assert.equal(record(result["job"])["id"], job);
      return result;
    },
  };
  const base: ScenarioBackend = {
    ...f.backend,
    execute: async (input) => {
      await f.backend.execute(input);
      const result = queueExecution(
        f.originals.get(input.requestId),
        input.owner,
        input.requestId,
      );
      f.executions.set(input.requestId, result);
      return result;
    },
  };
  return {
    ...f,
    base,
    recoveryPorts,
    failedRaw: raw,
    failedRequestId: requestId,
    failedJobId: jobId,
  };
}

test("a settled failed readonly v1 inspection gets immutable disposition and a new inspection ID without replay", async (t) => {
  const f = failedInspectionFixture(t),
    intentFile = path.join(f.directory, "cleanup-hold-inspection-intent.json"),
    before = fs.readFileSync(intentFile);
  await recordFailedCleanupInspection(
    f.base,
    f.directory,
    f.recoveryPorts,
    f.failedJobId,
  );
  const adapted = createCleanupRecoveryAdapter(
    f.base,
    f.directory,
    f.recoveryPorts,
  );
  const proof = await resolveCleanupHold(
    adapted.backend,
    f.directory,
    adapted.ports,
  );
  assert.equal(proof.inspectionRequestId, f.report.owner.clientId + ":3");
  assert.equal(proof.inspectedModified, false);
  assert.deepEqual(fs.readFileSync(intentFile), before);
  assert.ok(
    fs.existsSync(
      path.join(f.directory, "cleanup-hold-inspection-failure.json"),
    ),
  );
  assert.ok(
    fs.existsSync(
      path.join(f.directory, "cleanup-hold-reinspection-intent.json"),
    ),
  );
  assert.equal(f.submissions(), 1);
  assert.equal(record(f.failedRaw["job"])["state"], "failed");
  const result = await resumeCleanup(
    adapted.backend,
    path.join(f.directory, "report.json"),
    adapted.ports,
  );
  assert.equal(result.cleanup, "complete");
  assert.equal(f.submissions(), 2);
  assert.deepEqual(fs.readFileSync(intentFile), before);
});

for (const corruption of [
  "unsettled",
  "unknown",
  "foreign-client",
  "checker",
  "source",
  "other-failure",
  "modified-drift",
] as const)
  test(`failed readonly disposition rejects ${corruption} without another inspection`, async (t) => {
    const f = failedInspectionFixture(t, corruption === "modified-drift");
    if (corruption === "unsettled")
      record(f.failedRaw["execution"])["sdkSettled"] = false;
    if (corruption === "unknown")
      record(f.failedRaw["job"])["state"] = "unknown";
    if (corruption === "foreign-client")
      record(f.failedRaw["job"])["clientId"] = "foreign";
    if (corruption === "checker") f.failedRaw["pythonChecks"] = [];
    if (corruption === "other-failure")
      f.failedRaw["stdout"] = "Owned identity changed\n";
    if (corruption === "source") {
      const file = path.join(f.directory, "request-2.py"),
        source = fs.readFileSync(file, "utf8") + "# different source\n";
      fs.writeFileSync(file, source);
      const input = record(
        (record(f.failedRaw["provenance"])["inputs"] as unknown[])[0],
      );
      input["sha256"] = createHash("sha256").update(source).digest("hex");
      input["bytes"] = Buffer.byteLength(source);
    }
    const intent = fs.readFileSync(
      path.join(f.directory, "cleanup-hold-inspection-intent.json"),
    );
    await assert.rejects(
      recordFailedCleanupInspection(
        f.base,
        f.directory,
        f.recoveryPorts,
        f.failedJobId,
      ),
    );
    assert.equal(f.submissions(), 0);
    assert.equal(
      fs.existsSync(
        path.join(f.directory, "cleanup-hold-inspection-failure.json"),
      ),
      false,
    );
    assert.deepEqual(
      fs.readFileSync(
        path.join(f.directory, "cleanup-hold-inspection-intent.json"),
      ),
      intent,
    );
  });

test("a prior inspection intent without authenticated settled disposition cannot be reset", async (t) => {
  const f = failedInspectionFixture(t),
    before = fs.readFileSync(
      path.join(f.directory, "cleanup-hold-inspection-intent.json"),
    );
  const adapted = createCleanupRecoveryAdapter(
    f.base,
    f.directory,
    f.recoveryPorts,
  );
  await assert.rejects(
    resolveCleanupHold(adapted.backend, f.directory, adapted.ports),
  );
  assert.equal(f.submissions(), 0);
  assert.deepEqual(
    fs.readFileSync(
      path.join(f.directory, "cleanup-hold-inspection-intent.json"),
    ),
    before,
  );
});

test("retained v1 modified-only decisions stay valid without rewriting their history", (t) => {
  const f = fixture(t),
    requestId = f.report.owner.clientId + ":2",
    source = legacyInspectionSource(f.document);
  const rows = [{ ...f.document, saved: false, modified: true, fileId: null }];
  const row = f.request(
    2,
    "inspection",
    programs.marker +
      JSON.stringify({
        creationId: f.document.creationId,
        saved: false,
        modified: true,
        fileId: null,
        inventoryFence: { version: 1, before: rows, after: rows },
      }),
    source,
  );
  row.intent = { kind: "script" };
  const sha = (value: string | Buffer) =>
    createHash("sha256").update(value).digest("hex");
  const reportHash = sha(
    fs.readFileSync(path.join(f.directory, "report.json")),
  );
  fs.writeFileSync(
    path.join(f.directory, "cleanup-hold-inspection-intent.json"),
    JSON.stringify({
      version: 1,
      owner: f.report.owner,
      runtime: f.runtime,
      requestId,
      reportHash,
      sourceHash: sha(source),
    }),
  );
  const raw = record(f.originals.get(requestId));
  const decision = {
    version: 1,
    owner: f.report.owner,
    document: f.document,
    runtime: f.runtime,
    reportHash,
    creationHash: sha(fs.readFileSync(path.join(f.directory, "creation.json"))),
    indexHash: sha(fs.readFileSync(path.join(f.directory, "..", "index.json"))),
    originals: f.report.requests.map((original) =>
      f.originals.get(original.requestId),
    ),
    holdProof: { kind: "admission-only" },
    inspection: { row, raw },
    expiresAt: Number(record(raw["job"])["finishedAt"]) + 300_000,
  };
  const file = path.join(f.directory, "cleanup-hold-resolution.json");
  fs.writeFileSync(file, JSON.stringify(decision));
  const before = fs.readFileSync(file);
  t.mock.method(Date, "now", () => decision.expiresAt + 1);
  assert.equal(
    validateCleanupResolution(f.directory, f.backend, f.runtime)
      .inspectedModified,
    true,
  );
  assert.deepEqual(fs.readFileSync(file), before);
});

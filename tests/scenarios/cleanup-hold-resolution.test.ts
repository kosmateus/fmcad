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
  recordTerminalLegacyChildEvidence,
  recordNativeCleanupResult,
  recordLegacyReadonlyCleanupResult,
  readCleanupRecoveryRequests,
  type CleanupHoldPorts,
} from "./cleanup-hold-resolution";
import { resumeCleanup } from "./runner";
import * as programs from "./programs";
import { childProcessIdentity } from "./legacy-handoff";
import { createRequire } from "node:module";
import { queueExecution } from "./queue-backend";
import { publishLegacyTerminalDisposition } from "./legacy-terminal-disposition";

function fixture(
  t: TestContext,
  pose = false,
  modified = true,
  legacy: boolean | "gm07" = false,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-held-resolution-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runId = randomUUID(),
    scenarioId =
      legacy === "gm07"
        ? "gm07-source-pinned"
        : legacy
          ? "native-legacy-0"
          : pose
            ? "native-pose-methods-0"
            : "native-thread-1";
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

for (const kind of ["admission", "pose", "accepted-legacy"])
  test(`the actual ${kind} resolution inspection passes the pinned production checker`, async (t) => {
    const f =
      kind === "accepted-legacy"
        ? await acceptedLegacyFixture(t)
        : fixture(t, kind === "pose");
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

function readmittedFixture(t: TestContext) {
  const f = fixture(t),
    prior = f.report.requests[1]!;
  const payload = JSON.parse(
    prior.result.stdout.slice("FMCAD_RESULT ".length),
  ) as Record<string, unknown>;
  record(record(payload["result"])["admission"])["requestId"] =
    f.report.owner.clientId + ":2";
  const row = f.request(
    2,
    prior.phase + "-readmitted",
    "FMCAD_RESULT " + JSON.stringify(payload),
    programs.cadFence(
      f.document,
      "model.thread",
      {},
      [],
      [],
      [],
      "root",
      f.report.owner.clientId + ":2",
    ),
  );
  f.report.requests.push(row);
  f.report.cleanupHold = {
    requestId: row.requestId,
    reason:
      "Fenced CAD turn failed; leave the owned document for inspection: ADMISSION_CHANGED: inventory changed again before the admitted CAD turn; no helper executed",
  };
  fs.writeFileSync(
    path.join(f.directory, "report.json"),
    JSON.stringify(f.report),
  );
  return f;
}
test("readmitted admission-only hold binds both original no-helper turns before guarded cleanup", async (t) => {
  const f = readmittedFixture(t),
    filename = path.join(f.directory, "report.json"),
    before = fs.readFileSync(filename);
  const result = await resumeCleanup(f.backend, filename, f.ports);
  assert.equal(result.cleanup, "complete");
  assert.equal(f.submissions(), 2);
  assert.deepEqual(fs.readFileSync(filename), before);
});
for (const kind of [
  "prior-mutation",
  "prior-helper",
  "prior-operation",
  "not-readmitted",
  "prior-source",
] as const)
  test(`readmitted admission hold refuses ${kind} before inspection`, async (t) => {
    const f = readmittedFixture(t),
      prior = f.report.requests[1]!,
      row = f.report.requests[2]!;
    if (kind === "not-readmitted") row.phase = "cad-unbound";
    if (kind === "prior-source")
      fs.appendFileSync(path.join(f.directory, "request-1.py"), "# changed\n");
    if (kind.startsWith("prior-") && kind !== "prior-source") {
      const payload = JSON.parse(
          prior.result.stdout.slice("FMCAD_RESULT ".length),
        ) as Record<string, unknown>,
        result = record(payload["result"]),
        admission = record(result["admission"]);
      if (kind === "prior-mutation") admission["mutationStarted"] = true;
      if (kind === "prior-helper") admission["helperCalls"] = 1;
      if (kind === "prior-operation") result["operation"] = "shape.box";
      const changed = {
        ...prior.result,
        stdout: "FMCAD_RESULT " + JSON.stringify(payload),
      };
      prior.result = changed;
      f.executions.set(prior.requestId, changed);
      record(f.originals.get(prior.requestId))["stdout"] = changed.stdout;
    }
    fs.writeFileSync(
      path.join(f.directory, "report.json"),
      JSON.stringify(f.report),
    );
    await assert.rejects(resolveCleanupHold(f.backend, f.directory, f.ports));
    assert.equal(f.submissions(), 0);
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

function terminalLegacyFixture(t: TestContext) {
  const f = fixture(t, false, false, true),
    sha = (v: string) => createHash("sha256").update(v).digest("hex");
  const legacy = path.join(f.directory, "legacy");
  fs.mkdirSync(path.join(legacy, "intents"), { recursive: true });
  const lease = {
    version: 1,
    owner: f.report.owner,
    document: f.document,
    directory: f.directory,
    source: "tests/scenarios/legacy-owned-driver.ts",
    testCase: "native-legacy-cli",
    protocol: "addin",
    mode: "owned-unsaved-script",
  };
  const launch = {
    state: "completed",
    pid: 2_000_000_000,
    birth: "known-dead-child:1",
    code: 1,
  };
  const stderr =
    "AssertionError [ERR_ASSERTION]: Original legacy snapshot is not explained by its protected baseline and exact peer receipts\n    at Object.<anonymous> (/original/dist/tests/scenarios/legacy-owned-driver.js:112:62)\n";
  fs.writeFileSync(path.join(legacy, "lease.json"), JSON.stringify(lease));
  fs.writeFileSync(path.join(legacy, "launch.json"), JSON.stringify(launch));
  fs.writeFileSync(path.join(legacy, "stderr.log"), stderr);
  fs.writeFileSync(path.join(legacy, "stdout.log"), "");
  const exported = f.request(
    1,
    "export",
    programs.marker +
      JSON.stringify({ creationId: f.document.creationId, exported: true }),
    programs.exportFile(f.document, path.join(f.directory, "fixture.f3d")),
  );
  exported.intent = { kind: "script" };
  f.report.requests[1] = exported;
  f.report.cleanupHold.reason =
    "Native import child lacks its durable completion disposition; inspect original requests";
  fs.writeFileSync(
    path.join(f.directory, "report.json"),
    JSON.stringify(f.report),
  );
  const sourcePins = {
    "tests/scenarios/runner.ts":
      "6b061c40f87bd073d676947a222d50b802ef14b954eeac3fdf3379a4be3e7393",
    "tests/scenarios/legacy-owned-driver.ts":
      "b8c9891cef4943a4a5d53379cd6c5d7f45cedacf6600cad0e21087a24c6c8e56",
    "tests/helpers/live-broker.js":
      "6c3b4c52084c981059201ce3e3792bddba835549dde472515f804e53670622ae",
    "tests/scenarios/legacy-handoff.ts":
      "24b074d85b3ff1dd2337bd7078f04ad56fa26a82eb9abf0bb9e148f5f2af71eb",
  };
  const evidence = {
    driverSource: "aa942f37710e872ef3f1997c9110d4fc2631328f",
    owner: f.report.owner,
    document: f.document,
    reportHold: f.report.cleanupHold,
    launch,
    intents: [],
    completionFileExists: false,
    artifactEvidence: Object.fromEntries(
      [
        "report.json",
        "creation.json",
        "legacy/lease.json",
        "legacy/launch.json",
        "legacy/stderr.log",
        "legacy/stdout.log",
      ].map((file) => [
        file,
        {
          path: path.join(f.directory, file),
          sha256: sha(fs.readFileSync(path.join(f.directory, file), "utf8")),
        },
      ]),
    ),
  };
  const value = {
    version: 1,
    evidence,
    sourcePins,
    continuity: {
      driverSource: evidence.driverSource,
      sourceBefore:
        "10a34a896bde9dc2c4901a46afa7a77f9a03ad3ed562ba9cf5493099db038365",
      sourceAfter:
        "10a34a896bde9dc2c4901a46afa7a77f9a03ad3ed562ba9cf5493099db038365",
      preflightHash: "a".repeat(64),
      terminalHash: "b".repeat(64),
      buildHash: "c".repeat(64),
    },
  };
  const file = path.join(f.directory, "cleanup-legacy-child-terminal.json");
  fs.writeFileSync(file, JSON.stringify(value));
  return { ...f, legacy, value, file };
}
function readonlyLegacyFixture(t: TestContext) {
  const f = terminalLegacyFixture(t);
  fs.unlinkSync(f.file);
  f.runtime.buildHash =
    "d3fcfc77da8e96102c4bc578066edf4701322705b2f45318e46abada4139edd8";
  f.report.backendIdentity = "fusion:addin:" + f.runtime.buildHash;
  const backend = { ...f.backend, identity: f.report.backendIdentity };
  const indexFile = path.join(f.directory, "..", "index.json"),
    index = JSON.parse(fs.readFileSync(indexFile, "utf8")) as Record<
      string,
      unknown
    >;
  index["backendIdentity"] = backend.identity;
  fs.writeFileSync(indexFile, JSON.stringify(index));
  const id = randomUUID(),
    requestId = f.report.owner.clientId + ":legacy:" + id;
  const row = f.request(
    2,
    "legacy-cli",
    `DOC name=${f.document.name} creationId=${f.document.creationId} isActive=true isModified=false isSaved=false\nDONE\n`,
    "",
  );
  const raw = record(f.originals.get(row.requestId)),
    job = record(raw["job"]),
    op = record(job["operationResult"]);
  const oldId = row.requestId;
  f.executions.delete(oldId);
  f.originals.delete(oldId);
  fs.unlinkSync(path.join(f.directory, "request-2.py"));
  row.requestId = requestId;
  job["requestId"] = requestId;
  op["requestId"] = requestId;
  job["physicalTurns"] = 1;
  job["code"] = "EXECUTION_COMPLETE";
  const cwd = path.join(f.directory, "original-driver"),
    runtimeRoot = path.join(f.directory, "runtime");
  fs.mkdirSync(
    path.join(runtimeRoot, "dist/src/dist/core/application/documents"),
    { recursive: true },
  );
  fs.mkdirSync(path.join(runtimeRoot, "dist/assets"), { recursive: true });
  const root = path.resolve(__dirname, "../../..");
  fs.copyFileSync(
    path.join(root, "packages/core/dist/application/documents/commands.js"),
    path.join(
      runtimeRoot,
      "dist/src/dist/core/application/documents/commands.js",
    ),
  );
  fs.copyFileSync(
    path.join(root, "assets/addin-bridge.py"),
    path.join(runtimeRoot, "dist/assets/addin-bridge.py"),
  );
  raw["provenance"] = {
    status: "available",
    inputs: [],
    inputIdentity: createHash("sha256")
      .update(JSON.stringify({ cwd, inputFiles: [], payload: null }))
      .digest("hex"),
  };
  row.result = queueExecution(raw, f.report.owner, requestId);
  f.executions.set(requestId, row.result);
  f.originals.set(requestId, raw);
  f.report.requests.push(row);
  f.report.cleanupHold = {
    requestId,
    reason:
      "Native import child retained an uncertain outcome; inspect original requests",
  };
  fs.writeFileSync(
    path.join(f.directory, "report.json"),
    JSON.stringify(f.report),
  );
  const write = (name: string, value: unknown) =>
    fs.writeFileSync(path.join(f.legacy, name), JSON.stringify(value));
  const intent = {
    version: 1,
    owner: f.report.owner,
    requestId,
    argvHash: createHash("sha256")
      .update(
        JSON.stringify([
          "doc",
          "list",
          "--timeout",
          "30000",
          "--request-id",
          requestId,
        ]),
      )
      .digest("hex"),
    admissionRequested: true,
    completed: true,
    pid: 2_000_000_000,
    birth: "dead:1",
    exitCode: 0,
    settlement: {
      requestId,
      clientId: f.report.owner.clientId,
      jobId: job["id"],
      state: "succeeded",
      sdkSettled: true,
    },
  };
  write("intents/" + id + ".json", intent);
  fs.mkdirSync(path.join(f.legacy, "queue-receipts"));
  write("queue-receipts/" + id + ".json", {
    version: 1,
    owner: f.report.owner,
    requestId,
    jobId: job["id"],
  });
  const failure =
    "Expected values to be strictly equal:\n+ actual - expected\n\n+ undefined\n- 'succeeded'\n";
  write("readback.json", {
    name: f.document.name,
    scope: "owned-unsaved-only",
    commands: [
      {
        args: ["doc", "list"],
        status: 0,
        stdout: raw["stdout"],
        stderr:
          "FMCAD_QUEUE_REQUEST " +
          JSON.stringify({ requestId, clientId: f.report.owner.clientId }) +
          "\nFMCAD_QUEUE_RESULT " +
          JSON.stringify(job) +
          "\n",
      },
    ],
    files: [],
    tests: [
      { name: "doc list and baseline", status: "failed", error: failure },
      { name: "remaining domains", status: "not-tested" },
    ],
    testDocumentRemainsOpen: "unknown",
  });
  write("completion.json", {
    owner: f.report.owner,
    document: f.document,
    status: "failed",
    safeForCleanup: false,
    reportPath: path.join(f.legacy, "readback.json"),
  });
  for (const prior of f.report.requests.slice(0, -1)) {
    prior.result = queueExecution(
      f.originals.get(prior.requestId),
      f.report.owner,
      prior.requestId,
    );
    f.executions.set(prior.requestId, prior.result);
  }
  fs.writeFileSync(
    path.join(f.directory, "report.json"),
    JSON.stringify(f.report),
  );
  const execute = backend.execute.bind(backend);
  backend.execute = async (input) => {
    await execute(input);
    const result = queueExecution(
      f.originals.get(input.requestId),
      input.owner,
      input.requestId,
    );
    f.executions.set(input.requestId, result);
    return result;
  };
  const ports = {
    readRuntimeBinding: f.ports.readRuntimeBinding,
    readJobResult: async (_owner: unknown, id: string, jobId: string) => {
      const value = record(f.originals.get(id));
      assert.equal(record(value["job"])["id"], jobId);
      return value;
    },
  };
  return {
    ...f,
    backend,
    ports,
    sources: { cwd, runtimeRoot },
    raw,
    requestId,
  };
}
test("settled readonly legacy doc-list releases only a separately bound cleanup, not its failed completion", async (t) => {
  const f = readonlyLegacyFixture(t),
    reportFile = path.join(f.directory, "report.json"),
    before = fs.readFileSync(reportFile),
    completion = fs.readFileSync(path.join(f.legacy, "completion.json"));
  await recordLegacyReadonlyCleanupResult(
    f.backend,
    f.directory,
    f.ports,
    f.sources,
  );
  const adapted = createCleanupRecoveryAdapter(f.backend, f.directory, f.ports);
  const result = await resolveCleanupHold(
    adapted.backend,
    f.directory,
    adapted.ports,
  );
  assert.equal(result.holdKind, "settled-legacy-doc-list");
  assert.equal(f.submissions(), 1);
  assert.deepEqual(fs.readFileSync(reportFile), before);
  assert.deepEqual(
    fs.readFileSync(path.join(f.legacy, "completion.json")),
    completion,
  );
  const resolution = JSON.parse(
    fs.readFileSync(
      path.join(f.directory, "cleanup-hold-resolution.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  assert.equal(resolution["expectedModified"], false);
  assert.equal(
    record(record(resolution["inspection"])["row"])["requestId"],
    f.report.owner.clientId + ":2",
  );
});
for (const kind of [
  "foreign-client",
  "foreign-request",
  "foreign-job",
  "unknown",
  "checker",
  "missing-receipt",
  "argv",
  "mutating-command",
  "source",
  "cwd",
  "extra-intent",
  "completion",
  "readback",
  "active-child",
] as const)
  test(`readonly legacy binding refuses ${kind} without inspection or close`, async (t) => {
    const f = readonlyLegacyFixture(t),
      job = record(f.raw["job"]),
      id = f.requestId.split(":").at(-1)!;
    const change = (
      name: string,
      edit: (value: Record<string, unknown>) => void,
    ) => {
      const file = path.join(f.legacy, name),
        value = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
          string,
          unknown
        >;
      edit(value);
      fs.writeFileSync(file, JSON.stringify(value));
    };
    if (kind === "foreign-client") job["clientId"] = "foreign";
    if (kind === "foreign-request") job["requestId"] = "foreign";
    if (kind === "foreign-job") job["id"] = randomUUID();
    if (kind === "unknown") record(f.raw["execution"])["sdkSettled"] = false;
    if (kind === "checker") f.raw["pythonChecks"] = [];
    if (kind === "missing-receipt")
      fs.unlinkSync(path.join(f.legacy, "queue-receipts", id + ".json"));
    if (kind === "argv")
      change(`intents/${id}.json`, (value) => {
        value["argvHash"] = "f".repeat(64);
      });
    if (kind === "mutating-command")
      change("readback.json", (value) => {
        record((value["commands"] as unknown[])[0])["args"] = ["doc", "close"];
      });
    if (kind === "source")
      fs.appendFileSync(
        path.join(f.sources.runtimeRoot, "dist/assets/addin-bridge.py"),
        "\napp.activeDocument.close(False)\n",
      );
    if (kind === "cwd") f.sources.cwd = path.join(f.directory, "foreign-cwd");
    if (kind === "extra-intent")
      fs.writeFileSync(
        path.join(f.legacy, "intents", randomUUID() + ".json"),
        "{}",
      );
    if (kind === "completion")
      change("completion.json", (value) => {
        value["safeForCleanup"] = true;
      });
    if (kind === "readback")
      change("readback.json", (value) => {
        record((value["commands"] as unknown[])[0])["stdout"] =
          "foreign output";
      });
    if (kind === "active-child")
      change("launch.json", (value) => {
        value["pid"] = process.pid;
        value["birth"] = childProcessIdentity.processBirth();
      });
    await assert.rejects(
      recordLegacyReadonlyCleanupResult(
        f.backend,
        f.directory,
        f.ports,
        f.sources,
      ),
    );
    assert.equal(f.submissions(), 0);
    assert.equal(
      fs.existsSync(
        path.join(f.directory, "cleanup-legacy-readonly-binding.json"),
      ),
      false,
    );
  });
for (const kind of [
  "completion",
  "readback",
  "intent",
  "source",
  "runtime",
] as const)
  test(`readonly legacy recovery refuses changed ${kind} after binding before dispatch`, async (t) => {
    const f = readonlyLegacyFixture(t);
    await recordLegacyReadonlyCleanupResult(
      f.backend,
      f.directory,
      f.ports,
      f.sources,
    );
    if (kind === "runtime") f.runtime.instanceId = randomUUID();
    else if (kind === "source")
      fs.appendFileSync(
        path.join(f.sources.runtimeRoot, "dist/assets/addin-bridge.py"),
        "# changed\n",
      );
    else
      fs.appendFileSync(
        path.join(
          f.legacy,
          kind === "intent"
            ? `intents/${f.requestId.split(":").at(-1)}.json`
            : `${kind}.json`,
        ),
        " ",
      );
    const adapted = createCleanupRecoveryAdapter(
      f.backend,
      f.directory,
      f.ports,
    );
    await assert.rejects(
      resolveCleanupHold(adapted.backend, f.directory, adapted.ports),
    );
    assert.equal(f.submissions(), 0);
  });
test("readonly legacy binding cannot replay the original UUID child through the cleanup adapter", async (t) => {
  const f = readonlyLegacyFixture(t);
  await recordLegacyReadonlyCleanupResult(
    f.backend,
    f.directory,
    f.ports,
    f.sources,
  );
  const adapted = createCleanupRecoveryAdapter(f.backend, f.directory, f.ports);
  await assert.rejects(
    adapted.backend.execute({
      owner: f.report.owner,
      requestId: f.requestId,
      source: "# no replay",
      directory: f.directory,
      target: f.document,
    }),
  );
  assert.equal(f.submissions(), 0);
});
test("readonly legacy binding never authorizes the untyped default cleanup path", async (t) => {
  const f = readonlyLegacyFixture(t);
  await recordLegacyReadonlyCleanupResult(
    f.backend,
    f.directory,
    f.ports,
    f.sources,
  );
  await assert.rejects(
    resumeCleanup(f.backend, path.join(f.directory, "report.json")),
    /Case-specific mutation outcome/u,
  );
  assert.equal(f.submissions(), 0);
});

function nativeBindingFixture(t: TestContext) {
  const f = fixture(t, false, true, "gm07"),
    root = path.join(f.directory, "runtime");
  const sourceFile = path.join(
    root,
    "dist/assets/native-qualification/gm07-curves.py",
  );
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  fs.copyFileSync(
    path.resolve(
      __dirname,
      "../../../assets/native-qualification/gm07-curves.py",
    ),
    sourceFile,
  );
  const scriptSha256 = createHash("sha256")
      .update(fs.readFileSync(sourceFile))
      .digest("hex"),
    manifestSha256 =
      "aef99573a0ce45f852ea6883f0921e20056961a9d0b44bb8ced7654fd0707bb5";
  for (let n = 2; n <= 3; n++)
    f.report.requests.push(
      f.request(
        n,
        "observe",
        programs.marker + JSON.stringify({ creationId: f.document.creationId }),
        "# original observation\n",
      ),
    );
  const status = { ...f.document, saved: false, fileId: null };
  const native = f.request(
    4,
    "gm07-fixed-run",
    "FMCAD_RESULT " +
      JSON.stringify({
        success: true,
        result: {
          document: {
            ...f.document,
            before: { ...status, modified: false },
            after: { ...status, modified: true },
          },
          modelChangedByFixture: true,
          nativeGeometry: true,
        },
      }),
    fs.readFileSync(sourceFile, "utf8"),
  );
  const raw = record(f.originals.get(native.requestId));
  record((record(raw["provenance"])["inputs"] as unknown[])[0])[
    "originalPath"
  ] = sourceFile;
  fs.unlinkSync(path.join(f.directory, "request-4.py"));
  const metadata = {
    fixtureId: "gm07-curves-program-v1",
    manifestSha256,
    scriptSha256,
    buildHash: f.runtime.buildHash,
    document: f.document,
  };
  f.report.requests.push({
    requestId: native.requestId,
    phase: "gm07-fixed-run",
    intent: metadata,
  } as unknown as typeof native);
  for (const row of f.report.requests.slice(0, -1))
    row.result = queueExecution(
      f.originals.get(row.requestId),
      f.report.owner,
      row.requestId,
    );
  const report = record(f.report);
  delete report["cleanupHold"];
  report["scope"] = "exclusive-instance";
  report["cleanupExpectedModified"] = false;
  report["error"] =
    "Fixed-run accepted/terminal identity or outcome is unverified; inspect the original request, never replay.";
  fs.writeFileSync(
    path.join(f.directory, "report.json"),
    JSON.stringify(f.report),
  );
  const command = [
    path.join(root, "dist/bin/fmcad.js"),
    "run",
    sourceFile,
    "--helpers",
    "cad-v1",
    "--args",
    JSON.stringify({
      approved: true,
      creationId: f.document.creationId,
      expectedFusionVersion: "2706.1.17",
      fixturePrefix: "NQGM07CURVE01",
    }),
    "--doc",
    f.document.name,
    "--doc-id",
    f.document.creationId,
    "--request-id",
    native.requestId,
    "--timeout",
    "180000",
  ];
  const intent = {
    version: 1,
    state: "prepared",
    binding: {
      ...metadata,
      requestId: native.requestId,
      clientId: f.report.owner.clientId,
      runtimeRoot: root,
      command,
    },
    commandSha256: createHash("sha256")
      .update(JSON.stringify(command))
      .digest("hex"),
  };
  const intentFile = path.join(f.directory, "native-intent.json");
  fs.writeFileSync(intentFile, JSON.stringify(intent));
  const ports = {
    readRuntimeBinding: f.ports.readRuntimeBinding,
    readJobResult: async (_owner: unknown, id: string, jobId: string) => {
      const value = record(f.originals.get(id));
      assert.equal(record(value["job"])["id"], jobId);
      return value;
    },
  };
  const execute = f.backend.execute.bind(f.backend);
  f.backend.execute = async (input) => {
    await execute(input);
    const result = queueExecution(
      f.originals.get(input.requestId),
      input.owner,
      input.requestId,
    );
    f.executions.set(input.requestId, result);
    return result;
  };
  return {
    ...f,
    raw,
    intentFile,
    ports,
    jobId: String(record(raw["job"])["id"]),
  };
}
async function acceptedLegacyFixture(t: TestContext) {
  const f = terminalLegacyFixture(t),
    id = randomUUID(),
    requestId = f.report.owner.clientId + ":legacy:" + id,
    jobId = randomUUID();
  fs.unlinkSync(f.file);
  const report = record(f.report);
  delete report["cleanupHold"];
  report["scope"] = "exclusive-instance";
  report["error"] =
    "Original legacy request remains unsettled; cleanup deferred: " + requestId;
  fs.writeFileSync(
    path.join(f.directory, "report.json"),
    JSON.stringify(report),
  );
  const write = (file: string, value: unknown) =>
    fs.writeFileSync(path.join(f.directory, file), JSON.stringify(value));
  write("legacy/completion.json", {
    owner: f.report.owner,
    document: f.document,
    status: "failed",
    safeForCleanup: true,
    reportPath: path.join(f.legacy, "readback.json"),
  });
  write("legacy/readback.json", { status: "failed" });
  write("legacy/intents/" + id + ".json", {
    version: 1,
    owner: f.report.owner,
    requestId,
    argvHash: "b".repeat(64),
    admissionRequested: true,
    completed: true,
    exitCode: 1,
    pid: 2_000_000_000,
    birth: "dead:1",
    settlementFailure: {
      requestId,
      clientId: f.report.owner.clientId,
      reason: "lookup-unavailable",
    },
  });
  fs.mkdirSync(path.join(f.legacy, "queue-receipts"));
  write("legacy/queue-receipts/" + id + ".json", {
    version: 1,
    owner: f.report.owner,
    requestId,
    jobId,
  });
  const raw = {
    job: {
      id: jobId,
      requestId,
      clientId: f.report.owner.clientId,
      kind: "command",
      state: "failed",
      code: "LOCAL_PREPARATION_FAILED",
      executionOutcome: "not_started",
      mayHaveMutated: false,
      finishedAt: Date.now() - 100,
      operationResult: {
        version: 1,
        requestId,
        jobId,
        acceptance: "accepted",
        executionOutcome: "not_started",
        mayHaveMutated: false,
        code: "LOCAL_PREPARATION_FAILED",
        validation: { status: "not_checked" },
      },
    },
    execution: {
      state: "failed",
      code: "LOCAL_PREPARATION_FAILED",
      executionOutcome: "not_started",
      mayHaveMutated: false,
      sdkSettled: true,
    },
    stdout: "",
    stderr: "preparation failed",
    pythonChecks: [],
  };
  const sourceHashes: Record<string, { path: string; sha256: string }> = {};
  for (const base of ["runner", "legacy-owned-driver", "legacy-handoff"])
    for (const file of [
      `tests/scenarios/${base}.ts`,
      `dist/tests/scenarios/${base}.js`,
    ]) {
      const filename = path.join(
        f.directory,
        "source-" + file.replaceAll("/", "_"),
      );
      fs.writeFileSync(filename, "retained bound source\n");
      sourceHashes[file] = {
        path: filename,
        sha256: createHash("sha256")
          .update(fs.readFileSync(filename))
          .digest("hex"),
      };
    }
  await publishLegacyTerminalDisposition(
    f.directory,
    { identity: f.backend.identity, mode: "fusion", protocol: "addin" },
    {
      readOriginal: async () => raw,
      producerAlive: () => false,
      sourceBinding: {
        driverSource: "a".repeat(40),
        buildHash: f.runtime.buildHash,
        sourceHashes,
      },
    },
  );
  return { ...f, requestId, raw };
}
test("accepted terminal legacy disposition authorizes a new pristine inspection without rewriting history", async (t) => {
  const f = await acceptedLegacyFixture(t),
    filename = path.join(f.directory, "report.json"),
    before = fs.readFileSync(filename),
    completion = fs.readFileSync(path.join(f.legacy, "completion.json"));
  const proof = await resolveCleanupHold(f.backend, f.directory, f.ports);
  assert.equal(proof.inspectedModified, false);
  assert.equal(proof.inspectionRequestId, f.report.owner.clientId + ":2");
  assert.deepEqual(fs.readFileSync(filename), before);
  assert.deepEqual(
    fs.readFileSync(path.join(f.legacy, "completion.json")),
    completion,
  );
  assert.equal(f.submissions(), 1);
});
for (const kind of ["missing", "raw", "intent", "report"] as const)
  test(`accepted terminal legacy recovery refuses ${kind} evidence before dispatch`, async (t) => {
    const f = await acceptedLegacyFixture(t),
      file = path.join(f.legacy, "terminal-disposition.json");
    if (kind === "missing") fs.unlinkSync(file);
    if (kind === "raw") {
      const proof = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
        string,
        unknown
      >;
      record(record(proof["raw"])["execution"])["mayHaveMutated"] = true;
      fs.writeFileSync(file, JSON.stringify(proof));
    }
    if (kind === "intent")
      fs.appendFileSync(
        path.join(
          f.legacy,
          "intents",
          f.requestId.split(":").at(-1)! + ".json",
        ),
        " ",
      );
    if (kind === "report")
      fs.appendFileSync(path.join(f.directory, "report.json"), " ");
    await assert.rejects(resolveCleanupHold(f.backend, f.directory, f.ports));
    assert.equal(f.submissions(), 0);
  });
test("missing authoritative native result cannot enter cleanup before its immutable binding", async (t) => {
  const f = nativeBindingFixture(t);
  await assert.rejects(
    resolveCleanupHold(f.backend, f.directory, {
      readRuntimeBinding: f.ports.readRuntimeBinding,
      readOriginalResult: async (_owner, id) => f.originals.get(id),
    }),
  );
  assert.equal(f.submissions(), 0);
});
test("authoritative native binding preserves FAIL and prepared intent while authorizing modified inspection", async (t) => {
  const f = nativeBindingFixture(t),
    report = fs.readFileSync(path.join(f.directory, "report.json")),
    intent = fs.readFileSync(f.intentFile);
  await recordNativeCleanupResult(
    f.backend,
    f.directory,
    f.ports,
    f.intentFile,
    f.jobId,
  );
  const adapted = createCleanupRecoveryAdapter(f.backend, f.directory, f.ports);
  const proof = await resolveCleanupHold(
    adapted.backend,
    f.directory,
    adapted.ports,
  );
  assert.equal(proof.inspectedModified, true);
  assert.equal(proof.inspectionRequestId, f.report.owner.clientId + ":5");
  assert.equal(
    readCleanupRecoveryRequests(f.directory, f.backend, f.runtime).at(-1)![
      "result"
    ] !== undefined,
    true,
  );
  assert.deepEqual(
    fs.readFileSync(path.join(f.directory, "report.json")),
    report,
  );
  assert.deepEqual(fs.readFileSync(f.intentFile), intent);
});
for (const kind of [
  "foreign-client",
  "foreign-request",
  "foreign-job",
  "source",
  "checker",
  "unknown",
] as const)
  test(`native binding refuses ${kind} without cleanup`, async (t) => {
    const f = nativeBindingFixture(t),
      job = record(f.raw["job"]);
    if (kind === "foreign-client") job["clientId"] = "foreign";
    if (kind === "foreign-request") job["requestId"] = "foreign";
    if (kind === "foreign-job") job["id"] = "foreign";
    if (kind === "source")
      record((record(f.raw["provenance"])["inputs"] as unknown[])[0])[
        "sha256"
      ] = "f".repeat(64);
    if (kind === "checker") f.raw["pythonChecks"] = [];
    if (kind === "unknown") record(f.raw["execution"])["sdkSettled"] = false;
    await assert.rejects(
      recordNativeCleanupResult(
        f.backend,
        f.directory,
        f.ports,
        f.intentFile,
        f.jobId,
      ),
    );
    assert.equal(f.submissions(), 0);
    assert.equal(
      fs.existsSync(
        path.join(f.directory, "cleanup-native-result-binding.json"),
      ),
      false,
    );
  });
for (const kind of ["report", "intent", "forged-result", "runtime"] as const)
  test(`native binding refuses changed ${kind} before dispatch`, async (t) => {
    const f = nativeBindingFixture(t);
    await recordNativeCleanupResult(
      f.backend,
      f.directory,
      f.ports,
      f.intentFile,
      f.jobId,
    );
    if (kind === "report")
      fs.appendFileSync(path.join(f.directory, "report.json"), " ");
    if (kind === "intent") fs.appendFileSync(f.intentFile, " ");
    if (kind === "forged-result") {
      const file = path.join(f.directory, "cleanup-native-result-binding.json"),
        binding = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
          string,
          unknown
        >;
      record(record(binding["raw"])["execution"])["sdkSettled"] = false;
      fs.writeFileSync(file, JSON.stringify(binding));
    }
    if (kind === "runtime") f.runtime.instanceId = randomUUID();
    await assert.rejects(async () => {
      readCleanupRecoveryRequests(f.directory, f.backend, f.runtime);
      const adapted = createCleanupRecoveryAdapter(
        f.backend,
        f.directory,
        f.ports,
      );
      await resolveCleanupHold(adapted.backend, f.directory, adapted.ports);
    });
    assert.equal(f.submissions(), 0);
  });
test("native result still requires typed ports and cannot use generic report-rewriting cleanup", async (t) => {
  const f = nativeBindingFixture(t);
  await recordNativeCleanupResult(
    f.backend,
    f.directory,
    f.ports,
    f.intentFile,
    f.jobId,
  );
  const before = fs.readFileSync(path.join(f.directory, "report.json"));
  await assert.rejects(
    resumeCleanup(f.backend, path.join(f.directory, "report.json")),
    /Case-specific mutation outcome/u,
  );
  assert.equal(f.submissions(), 0);
  assert.deepEqual(
    fs.readFileSync(path.join(f.directory, "report.json")),
    before,
  );
});

test("accepted legacy recovery publishes a pristine close without replacing its failed completion", async (t) => {
  const f = await acceptedLegacyFixture(t),
    file = path.join(f.directory, "report.json");
  const before = fs.readFileSync(file),
    completion = fs.readFileSync(path.join(f.legacy, "completion.json"));
  const result = await resumeCleanup(f.backend, file, f.ports);
  assert.equal(result.cleanup, "complete");
  assert.equal(f.submissions(), 2);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(
    fs.readFileSync(path.join(f.legacy, "completion.json")),
    completion,
  );
  assert.equal(
    fs.existsSync(path.join(f.directory, "supplemental-close.json")),
    true,
  );
  const close = record(
    JSON.parse(
      fs.readFileSync(
        path.join(f.directory, "supplemental-close.intent.json"),
        "utf8",
      ),
    ) as unknown,
  );
  assert.equal(close["expectedModified"], false);
  assert.equal(typeof close["resolutionDigest"], "string");
});

test("native recovery publishes an exact modified close without rewriting the failed report", async (t) => {
  const f = nativeBindingFixture(t);
  const filename = path.join(f.directory, "report.json");
  const before = fs.readFileSync(filename);
  const originalIntent = fs.readFileSync(f.intentFile);
  await recordNativeCleanupResult(
    f.backend,
    f.directory,
    f.ports,
    f.intentFile,
    f.jobId,
  );
  const adapted = createCleanupRecoveryAdapter(f.backend, f.directory, f.ports);
  const result = await resumeCleanup(adapted.backend, filename, adapted.ports);
  assert.equal(result.cleanup, "complete");
  assert.equal(f.submissions(), 2);
  assert.deepEqual(fs.readFileSync(filename), before);
  assert.deepEqual(fs.readFileSync(f.intentFile), originalIntent);
  const close = record(
    JSON.parse(
      fs.readFileSync(
        path.join(f.directory, "supplemental-close.intent.json"),
        "utf8",
      ),
    ) as unknown,
  );
  assert.equal(close["expectedModified"], true);
  assert.equal(
    fs.existsSync(path.join(f.directory, "supplemental-close.json")),
    true,
  );
});

test("source-bound terminal legacy child without dispatch resolves without creating completion or replay", async (t) => {
  const f = terminalLegacyFixture(t),
    original = fs.readFileSync(path.join(f.directory, "report.json"));
  const proof = await resolveCleanupHold(f.backend, f.directory, f.ports);
  assert.equal(proof.inspectedModified, false);
  assert.equal(f.submissions(), 1);
  assert.equal(fs.existsSync(path.join(f.legacy, "completion.json")), false);
  assert.deepEqual(
    fs.readFileSync(path.join(f.directory, "report.json")),
    original,
  );
  const result = await resumeCleanup(
    f.backend,
    path.join(f.directory, "report.json"),
    f.ports,
  );
  assert.equal(result.cleanup, "complete");
  assert.equal(f.submissions(), 2);
  assert.deepEqual(
    fs.readFileSync(path.join(f.directory, "report.json")),
    original,
  );
});
for (const corruption of [
  "missing-proof",
  "foreign-lease",
  "active-child",
  "intent",
  "completion",
  "source",
  "changed-artifact",
  "unknown-original",
] as const)
  test(`legacy no-dispatch resolution rejects ${corruption} before inspection`, async (t) => {
    const f = terminalLegacyFixture(t);
    if (corruption === "missing-proof") fs.unlinkSync(f.file);
    if (corruption === "foreign-lease")
      fs.writeFileSync(
        path.join(f.legacy, "lease.json"),
        JSON.stringify({ ...f.value.evidence, owner: { clientId: "foreign" } }),
      );
    if (corruption === "active-child")
      fs.writeFileSync(
        path.join(f.legacy, "launch.json"),
        JSON.stringify({ state: "running", pid: process.pid }),
      );
    if (corruption === "intent")
      fs.writeFileSync(path.join(f.legacy, "intents", "accepted.json"), "{}");
    if (corruption === "completion")
      fs.writeFileSync(path.join(f.legacy, "completion.json"), "{}");
    if (corruption === "source") {
      f.value.sourcePins["tests/helpers/live-broker.js"] = "f".repeat(64);
      fs.writeFileSync(f.file, JSON.stringify(f.value));
    }
    if (corruption === "changed-artifact")
      fs.appendFileSync(path.join(f.legacy, "stderr.log"), "changed");
    if (corruption === "unknown-original")
      record(
        record(f.originals.get(f.report.requests[1]!.requestId))["execution"],
      )["sdkSettled"] = false;
    await assert.rejects(resolveCleanupHold(f.backend, f.directory, f.ports));
    assert.equal(f.submissions(), 0);
  });
test("legacy evidence recording refuses unbound input rather than trusting a dead PID", (t) => {
  const f = terminalLegacyFixture(t);
  fs.unlinkSync(f.file);
  assert.throws(() =>
    recordTerminalLegacyChildEvidence(
      f.backend,
      f.directory,
      path.join(f.legacy, "launch.json"),
      {
        preflight: path.join(f.legacy, "lease.json"),
        terminal: path.join(f.legacy, "launch.json"),
        buildLog: path.join(f.legacy, "stdout.log"),
      },
    ),
  );
  assert.equal(fs.existsSync(f.file), false);
});

test("a rehashed live child launch still cannot authorize legacy cleanup", async (t) => {
  const f = terminalLegacyFixture(t);
  const queue = createRequire(
    path.resolve(__dirname, "../../..", "package.json"),
  )("./src/queue-instance") as { processBirth(): string };
  f.value.evidence.launch.pid = process.pid;
  f.value.evidence.launch.birth = queue.processBirth();
  const filename = path.join(f.legacy, "launch.json"),
    bytes = JSON.stringify(f.value.evidence.launch);
  fs.writeFileSync(filename, bytes);
  f.value.evidence.artifactEvidence["legacy/launch.json"]!.sha256 = createHash(
    "sha256",
  )
    .update(bytes)
    .digest("hex");
  fs.writeFileSync(f.file, JSON.stringify(f.value));
  await assert.rejects(
    resolveCleanupHold(f.backend, f.directory, f.ports),
    /Child exit is unverified/u,
  );
  assert.equal(f.submissions(), 0);
});
test("an export-shaped legacy mutation does not qualify as no-dispatch proof", async (t) => {
  const f = terminalLegacyFixture(t),
    id = f.report.requests[1]!.requestId;
  const filename = path.join(f.directory, "request-1.py"),
    source = fs.readFileSync(filename, "utf8") + "# changed program\n";
  fs.writeFileSync(filename, source);
  const input = record(
    (
      record(record(f.originals.get(id))["provenance"])["inputs"] as unknown[]
    )[0],
  );
  input["sha256"] = createHash("sha256").update(source).digest("hex");
  input["bytes"] = Buffer.byteLength(source);
  await assert.rejects(
    resolveCleanupHold(f.backend, f.directory, f.ports),
    /exact non-mutating program/u,
  );
  assert.equal(f.submissions(), 0);
});

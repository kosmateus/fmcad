import test from "node:test";
import assert from "node:assert/strict";
import * as saved from "./saved-programs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import type { Execution } from "./contracts";
import { savedIdentityTransition } from "./saved-identity";
import { saveIntent } from "./saved-files";
import { marker } from "./programs";
import { fixture as modelFixture, remaining } from "./test-support";
import { runScenarios, resumeCleanup } from "./runner";
import { simulatorFolder } from "./simulator";
import type { ScenarioBackend } from "./contracts";

test("first save reads the same retained document identity after saveAs", () => {
  const source = saved.save(
    { creationId: "original-id", name: "Housing" },
    { projectId: "project", folderId: "folder" },
    { runId: "run", scenarioId: "case", clientId: "owner" },
    "owner:2",
    "save-intent.json",
    "save-transition.json",
  );
  const afterSave = source.slice(source.indexOf("assert doc.saveAs"));
  assert.match(afterSave, /doc\.creationId/u);
  assert.match(afterSave, /doc\.name/u);
  assert.match(afterSave, /postReadbackError/u);
  assert.doesNotMatch(afterSave, /doc\.dataFile/u);
});

function fixture(t: TestContext, createOrdinal = 0) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "fmcad-save-identity-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const owner = {
    runId: "run",
    scenarioId: "saved",
    clientId: "scenario:run:saved",
  };
  const original = { creationId: "before-id", name: "Housing" };
  const intent = {
    ...original,
    projectId: "project",
    folderId: "folder",
    clientId: owner.clientId,
    requestId: owner.clientId + ":2",
  };
  const accepted: Record<string, unknown> = {
    ...intent,
    accepted: true,
    postCreationId: "after-id",
    postName: "Housing v0",
  };
  const write = (name: string, value: unknown) =>
    fs.writeFileSync(path.join(directory, name), JSON.stringify(value), {
      mode: 0o600,
    });
  const creation = {
    ...original,
    activeCreationId: original.creationId,
    clientId: owner.clientId,
    requestId: owner.clientId + ":" + createOrdinal,
  };
  write("creation.json", creation);
  write("save-intent.json", intent);
  write("save-transition.json", accepted);
  const result: Execution = {
    requestId: intent.requestId,
    state: "succeeded",
    sdkSettled: true,
    mayHaveMutated: true,
    stdout: marker + JSON.stringify(accepted) + "\n",
    brokerReceipt: {
      requestId: intent.requestId,
      clientId: owner.clientId,
      jobId: "original-save-job",
      state: "succeeded",
      operationResult: null,
    },
  };
  const createResult: Execution = {
    ...result,
    requestId: creation.requestId,
    stdout: marker + JSON.stringify(creation) + "\n",
    brokerReceipt: {
      ...result.brokerReceipt!,
      requestId: creation.requestId,
      jobId: "original-create-job",
    },
  };
  const requests = [
    ...(createOrdinal
      ? [
          {
            requestId: owner.clientId + ":0",
            phase: "original-user-view-capture",
            result: {
              ...createResult,
              requestId: owner.clientId + ":0",
              stdout: "",
              brokerReceipt: {
                ...createResult.brokerReceipt!,
                requestId: owner.clientId + ":0",
                jobId: "capture-job",
              },
            },
          },
        ]
      : []),
    { requestId: creation.requestId, phase: "create", result: createResult },
    { requestId: intent.requestId, phase: "save", result },
  ];
  return {
    directory,
    owner,
    original,
    intent,
    accepted,
    creation,
    requests,
    write,
  };
}

test("save bridge binds unique original create after capture:0/create:1", (t) => {
  const f = fixture(t, 1);
  const create = f.requests.find((entry) => entry.phase === "create")!;
  create.result = {
    ...create.result,
    brokerReceipt: {
      ...create.result.brokerReceipt!,
      operationResult: {
        version: 1,
        requestId: create.requestId,
        jobId: create.result.brokerReceipt!.jobId,
        acceptance: "accepted",
        executionOutcome: "succeeded",
        mayHaveMutated: true,
      },
    },
  };
  const before = fs.readFileSync(
    path.join(f.directory, "creation.json"),
    "utf8",
  );
  assert.equal(
    savedIdentityTransition(f.directory, f.original, f.owner, f.requests)
      ?.creationId,
    "after-id",
  );
  assert.equal(
    fs.readFileSync(path.join(f.directory, "creation.json"), "utf8"),
    before,
  );
});

for (const kind of [
  "capture-phase",
  "capture-result",
  "missing-create",
  "duplicate-create",
  "duplicate-request",
  "foreign-request",
  "noncanonical-request",
  "foreign-client",
  "foreign-result-request",
  "foreign-receipt-request",
  "missing-result",
  "missing-receipt",
  "missing-job",
  "reused-save-job",
  "unknown",
  "unsettled",
  "failed-receipt",
  "non-mutating",
  "nonzero-exit",
  "substituted-stdout",
  "duplicate-marker",
  "foreign-creation",
  "foreign-active",
  "foreign-operation-job",
  "foreign-operation-request",
  "failed-operation",
  "missing-creation",
  "create-after-save",
] as const) {
  test("save bridge rejects original create " + kind, (t) => {
    const f = fixture(t, kind === "capture-result" ? 1 : 0),
      entry = f.requests.find((value) => value.phase === "create")!,
      result = entry.result,
      receipt = result.brokerReceipt!;
    if (kind === "capture-phase") entry.phase = "original-user-view-capture";
    if (kind === "capture-result") entry.result = f.requests[0]!.result;
    if (kind === "missing-create")
      f.requests.splice(f.requests.indexOf(entry), 1);
    if (kind === "duplicate-create")
      f.requests.push({ ...entry, requestId: f.owner.clientId + ":3" });
    if (kind === "duplicate-request")
      f.requests.find((value) => value.phase === "save")!.requestId =
        entry.requestId;
    if (kind === "missing-creation")
      fs.unlinkSync(path.join(f.directory, "creation.json"));
    if (kind === "create-after-save") {
      f.requests.splice(f.requests.indexOf(entry), 1);
      f.requests.push(entry);
    }
    if (kind === "foreign-request" || kind === "noncanonical-request") {
      const requestId =
        kind === "foreign-request" ? "foreign:1" : f.owner.clientId + ":01";
      entry.requestId = requestId;
      entry.result = {
        ...result,
        requestId,
        brokerReceipt: { ...receipt, requestId },
        stdout: marker + JSON.stringify({ ...f.creation, requestId }),
      };
      f.write("creation.json", { ...f.creation, requestId });
    }
    if (kind === "foreign-client")
      entry.result = {
        ...result,
        brokerReceipt: { ...receipt, clientId: "foreign" },
      };
    if (kind === "foreign-result-request")
      entry.result = { ...result, requestId: "foreign" };
    if (kind === "foreign-receipt-request")
      entry.result = {
        ...result,
        brokerReceipt: { ...receipt, requestId: "foreign" },
      };
    if (kind === "missing-result") Reflect.deleteProperty(entry, "result");
    if (kind === "missing-receipt")
      Reflect.deleteProperty(result, "brokerReceipt");
    if (kind === "missing-job")
      entry.result = { ...result, brokerReceipt: { ...receipt, jobId: "" } };
    if (kind === "reused-save-job")
      entry.result = {
        ...result,
        brokerReceipt: { ...receipt, jobId: "original-save-job" },
      };
    if (kind === "unknown") entry.result = { ...result, state: "unknown" };
    if (kind === "unsettled") entry.result = { ...result, sdkSettled: false };
    if (kind === "failed-receipt")
      entry.result = {
        ...result,
        brokerReceipt: { ...receipt, state: "failed" },
      };
    if (kind === "non-mutating")
      entry.result = { ...result, mayHaveMutated: false };
    if (kind === "nonzero-exit") entry.result = { ...result, exitCode: 1 };
    if (kind === "substituted-stdout")
      entry.result = {
        ...result,
        stdout:
          marker + JSON.stringify({ ...f.creation, creationId: "foreign" }),
      };
    if (kind === "duplicate-marker")
      entry.result = { ...result, stdout: result.stdout + result.stdout };
    if (kind === "foreign-creation" || kind === "foreign-active") {
      const creation = {
        ...f.creation,
        ...(kind === "foreign-creation"
          ? { creationId: "foreign" }
          : { activeCreationId: "foreign" }),
      };
      f.write("creation.json", creation);
      entry.result = { ...result, stdout: marker + JSON.stringify(creation) };
    }
    if (kind.startsWith("foreign-operation") || kind === "failed-operation")
      entry.result = {
        ...result,
        brokerReceipt: {
          ...receipt,
          operationResult: {
            version: 1,
            requestId:
              kind === "foreign-operation-request"
                ? "foreign"
                : entry.requestId,
            jobId: kind === "foreign-operation-job" ? "foreign" : receipt.jobId,
            acceptance: "accepted",
            executionOutcome:
              kind === "failed-operation" ? "failed" : "succeeded",
            mayHaveMutated: true,
          },
        },
      };
    assert.throws(() =>
      savedIdentityTransition(f.directory, f.original, f.owner, f.requests),
    );
  });
}

for (const recover of [false, true]) {
  test(`saved lifecycle follows same-document ID/name transition${recover ? " after restart" : ""}`, async (t) => {
    const { directory, model, backend } = await modelFixture(t, "addin");
    const retained = new Map<string, Execution>();
    let saveCalls = 0,
      lost = false;
    const wrapped: ScenarioBackend = {
      ...backend,
      qualification: "broker",
      async execute(request) {
        let source = request.source;
        if (source.includes("assert doc.saveAs")) {
          saveCalls++;
          source = source.replace(
            "    accepted: dict[str, object]",
            "    doc.creationId = 'saved-transition-id'\n    doc.name = doc.name + ' v0'\n    accepted: dict[str, object]",
          );
        }
        const result = await backend.execute({ ...request, source });
        const settled: Execution = {
          ...result,
          exitCode: result.state === "succeeded" ? 0 : 1,
          brokerReceipt: {
            requestId: request.requestId,
            clientId: request.owner.clientId,
            jobId: "job:" + request.requestId,
            state: result.state,
            operationResult: null,
          },
        };
        retained.set(request.requestId, settled);
        if (recover && !lost && source.includes("complete=file.isComplete")) {
          lost = true;
          return { ...settled, state: "unknown", sdkSettled: false };
        }
        return settled;
      },
      lookup: async (_owner, requestId) => retained.get(requestId) ?? null,
    };
    const reports = await runScenarios(
      wrapped,
      [
        {
          id: "identity-transition",
          fixture: simulatorFolder,
          requires: [],
          async run(session) {
            assert.equal(session.document.creationId, "saved-transition-id");
            assert.ok(session.document.name.endsWith(" v0"));
            assert.ok(session.document.file);
          },
        },
      ],
      directory,
      1,
    );
    const report = reports[0]!;
    assert.equal(saveCalls, 1, JSON.stringify(reports));
    if (recover) {
      assert.equal(report.status, "failed");
      assert.equal(report.cleanup, "deferred");
      const recovered = await resumeCleanup(
        wrapped,
        path.join(report.directory, "report.json"),
      );
      assert.equal(recovered.cleanup, "complete");
    } else {
      assert.equal(report.status, "passed", report.error);
      assert.equal(report.cleanup, "complete", report.cleanupError);
    }
    assert.equal(saveCalls, 1);
    assert.equal(
      report.savedIdentityTransition?.creationId,
      "saved-transition-id",
    );
    const creation = JSON.parse(
      fs.readFileSync(path.join(report.directory, "creation.json"), "utf8"),
    ) as { creationId: string };
    assert.notEqual(creation.creationId, "saved-transition-id");
    assert.deepEqual(await remaining(model), { active: null, documents: [] });
  });
}

test("same-document bridge preserves immutable origin while following a new display name and ID", (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(
    path.join(f.directory, "creation.json"),
    "utf8",
  );
  const bridge = savedIdentityTransition(
    f.directory,
    f.original,
    f.owner,
    f.requests,
  );
  assert.deepEqual(bridge, {
    version: 1,
    originalCreationId: "before-id",
    saveRequestId: f.intent.requestId,
    creationId: "after-id",
    name: "Housing v0",
  });
  assert.equal(
    fs.readFileSync(path.join(f.directory, "creation.json"), "utf8"),
    before,
  );
  assert.deepEqual(
    saveIntent(
      f.directory,
      { creationId: "after-id", name: "Housing v0" },
      f.owner,
      f.requests,
    ),
    { projectId: "project", folderId: "folder" },
  );
});

test("legacy accepted save without a same-document bridge never adopts a new ID", (t) => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.directory, "save-transition.json"));
  assert.equal(
    savedIdentityTransition(f.directory, f.original, f.owner, f.requests),
    undefined,
  );
  assert.throws(
    () =>
      saveIntent(
        f.directory,
        { creationId: "after-id", name: "Housing v0" },
        f.owner,
        f.requests,
      ),
    /identity bridge/u,
  );
});

for (const kind of [
  "unknown",
  "unsettled",
  "foreign-client",
  "foreign-job-request",
  "missing-job",
  "duplicate-save",
  "tampered-bridge",
  "post-readback-error",
  "foreign-origin",
  "foreign-folder",
] as const) {
  test("save bridge refuses " + kind, (t) => {
    const f = fixture(t),
      entry = f.requests.find((entry) => entry.phase === "save")!;
    if (kind === "unknown")
      entry.result = { ...entry.result, state: "unknown" };
    if (kind === "unsettled")
      entry.result = { ...entry.result, sdkSettled: false };
    if (kind === "foreign-client")
      entry.result = {
        ...entry.result,
        brokerReceipt: { ...entry.result.brokerReceipt!, clientId: "foreign" },
      };
    if (kind === "foreign-job-request")
      entry.result = {
        ...entry.result,
        brokerReceipt: { ...entry.result.brokerReceipt!, requestId: "foreign" },
      };
    if (kind === "missing-job") {
      const { brokerReceipt, ...withoutReceipt } = entry.result;
      assert.ok(brokerReceipt);
      entry.result = withoutReceipt;
    }
    if (kind === "duplicate-save") f.requests.push({ ...entry });
    if (kind === "tampered-bridge")
      f.write("save-transition.json", {
        ...f.accepted,
        postCreationId: "foreign",
      });
    if (
      kind === "post-readback-error" ||
      kind === "foreign-origin" ||
      kind === "foreign-folder"
    ) {
      const value = {
        ...f.accepted,
        ...(kind === "post-readback-error"
          ? { postReadbackError: "getter failed" }
          : kind === "foreign-origin"
            ? { creationId: "foreign" }
            : { folderId: "foreign" }),
      };
      f.write("save-transition.json", value);
      entry.result = {
        ...entry.result,
        stdout: marker + JSON.stringify(value) + "\n",
      };
    }
    assert.throws(() =>
      savedIdentityTransition(f.directory, f.original, f.owner, f.requests),
    );
  });
}

test("file proof uses immutable requested file name rather than a display suffix", () => {
  const document = {
    creationId: "after-id",
    name: "Housing v0",
    file: {
      fileId: "file",
      version: 1,
      projectId: "project",
      folderId: "folder",
    },
  };
  const source = saved.observeSave(document, document.file, "Housing");
  assert.match(source, /file\.name == "Housing"/u);
  assert.doesNotMatch(source, /file\.name == doc\.name/u);
  assert.match(
    saved.fileOperation(document, true, "Housing"),
    /file\.name == "Housing"/u,
  );
});

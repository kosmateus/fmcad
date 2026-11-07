import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import type { ScenarioBackend } from "./contracts";
import { savedScenarios } from "./cases";
import { runScenarios, resumeCleanup, type Scenario } from "./runner";
import { simulatorFolder } from "./simulator";
import { fixture, remaining } from "./test-support";
import * as programs from "./programs";
import * as saved from "./saved-programs";
import { parse } from "./cli";
import { observeSavedFile, UnsettledCloudOperation } from "./saved-files";

async function files(model: Awaited<ReturnType<typeof fixture>>["model"]) {
  const result = await model.execute(saved.inventory(simulatorFolder));
  assert.equal(result.success, true, result.error);
  return JSON.parse(
    result.stdout.trim().slice(programs.marker.length),
  ) as unknown;
}

for (const protocol of ["mcp", "addin"] as const) {
  test(`saved fixtures observe completion and remove only owned files (${protocol})`, async (t) => {
    const { directory, model, backend } = await fixture(t, protocol);
    const before = await files(model);
    const reports = await runScenarios(
      backend,
      savedScenarios(simulatorFolder, 2),
      directory,
      2,
    );
    assert.ok(
      reports.every((r) => r.status === "passed" && r.cleanup === "complete"),
      JSON.stringify(reports),
    );
    assert.equal(new Set(reports.map((r) => r.document?.file?.fileId)).size, 3);
    for (const report of reports) {
      assert.equal(report.requests.filter((r) => r.phase === "save").length, 1);
      assert.equal(
        report.requests.filter((r) => r.phase === "cleanup-delete").length,
        1,
      );
      assert.equal(
        fs.existsSync(path.join(report.directory, "fixture.f3d")),
        false,
      );
    }
    assert.deepEqual(await files(model), before);
    assert.deepEqual(await remaining(model), { active: null, documents: [] });
  });

  for (const phase of [
    "save",
    "save-observe",
    "cleanup-close",
    "cleanup-delete",
    "cleanup-observe",
  ] as const) {
    test(`lost ${phase} reply recovers original evidence without replay (${protocol})`, async (t) => {
      const { directory, model, backend } = await fixture(t, protocol);
      let lost = false;
      const calls: string[] = [];
      const wrapped: ScenarioBackend = {
        ...backend,
        async execute(request) {
          const result = await backend.execute(request);
          const actual = request.source.includes("doc.saveAs(")
            ? "save"
            : request.source.includes("file.deleteMe()")
              ? "cleanup-delete"
              : request.source.includes("doc.close(False)")
                ? "cleanup-close"
                : request.source.includes("complete=file.isComplete")
                  ? "save-observe"
                  : request.source.includes("absent=not matches")
                    ? "cleanup-observe"
                    : "other";
          calls.push(actual);
          if (!lost && actual === phase) {
            lost = true;
            throw new Error("Lost original " + phase + " response");
          }
          return result;
        },
      };
      const [report] = await runScenarios(
        wrapped,
        [savedScenarios(simulatorFolder, 1)[0]!],
        directory,
        1,
      );
      assert.ok(report);
      assert.equal(report.status, "failed");
      assert.equal(report.cleanup, "deferred");
      const recovered = await resumeCleanup(
        wrapped,
        path.join(report.directory, "report.json"),
      );
      assert.equal(recovered.status, "failed");
      assert.equal(recovered.cleanup, "complete", JSON.stringify(recovered));
      for (const mutation of ["save", "cleanup-close", "cleanup-delete"])
        assert.equal(
          calls.filter((value) => value === mutation).length,
          1,
          mutation + " must not be replayed",
        );
      assert.deepEqual(await remaining(model), { active: null, documents: [] });
      assert.deepEqual(await files(model), { ...simulatorFolder, files: [] });
    });
  }
}

test("saved fixture operation and assertion failures still remove the file", async (t) => {
  const { directory, model, backend } = await fixture(t);
  const base = savedScenarios(simulatorFolder, 1)[0]!;
  const cases: Scenario[] = [
    {
      ...base,
      id: "saved-operation-error",
      async run(session) {
        await session.execute(
          "fail",
          programs.program("raise ValueError('operation failed')"),
        );
      },
    },
    {
      ...base,
      id: "saved-assertion-error",
      async run() {
        assert.fail("assertion failed");
      },
    },
  ];
  const reports = await runScenarios(backend, cases, directory, 2);
  assert.ok(
    reports.every((r) => r.status === "failed" && r.cleanup === "complete"),
    JSON.stringify(reports),
  );
  assert.match(reports[0]?.error ?? "", /operation failed/);
  assert.match(reports[1]?.error ?? "", /assertion failed/);
  assert.deepEqual(await files(model), { ...simulatorFolder, files: [] });
});

test("a save failure after acceptance is reconciled from its owned document without another save", async (t) => {
  const { directory, model, backend } = await fixture(t);
  let saves = 0;
  const wrapped: ScenarioBackend = {
    ...backend,
    async execute(request) {
      if (!request.source.includes("doc.saveAs("))
        return backend.execute(request);
      saves++;
      return backend.execute({
        ...request,
        source: request.source.replace(
          "assert doc.saveAs(doc.name, folder, 'fmcad isolated scenario', ''), 'Save was not accepted'",
          "assert doc.saveAs(doc.name, folder, 'fmcad isolated scenario', '')\n    raise ValueError('after acceptance')",
        ),
      });
    },
  };
  const [report] = await runScenarios(
    wrapped,
    [savedScenarios(simulatorFolder, 1)[0]!],
    directory,
    1,
  );
  assert.ok(report);
  assert.equal(report.status, "failed");
  assert.equal(report.cleanup, "complete", JSON.stringify(report));
  assert.equal(saves, 1);
  assert.deepEqual(await files(model), { ...simulatorFolder, files: [] });
});

test("ten saved owners preserve duplicate-named foreign files and restore the active document after recovery", async (t) => {
  const { directory, model, backend } = await fixture(t);
  const create = await model.execute(
    programs.program(`import adsk.core
app = adsk.core.Application.get()
folder = app.data.dataProjects.itemById('sim-project:fixtures').rootFolder
for _ in range(2):
    doc = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
    doc.name = 'USER_SENTINEL'
    assert doc.saveAs(doc.name, folder, '', '')
assert app.documents.item(1).activate()`),
  );
  assert.equal(create.success, true, create.error);
  await files(model); // Complete the model's pending saves before the baseline.
  const beforeFiles = await files(model),
    beforeDocs = await remaining(model);
  let lost = false;
  const wrapped: ScenarioBackend = {
    ...backend,
    async execute(request) {
      const result = await backend.execute(request);
      if (!lost && request.source.includes("file.deleteMe()")) {
        lost = true;
        throw new Error("lost delete response");
      }
      return result;
    },
  };
  const reports = await runScenarios(
    wrapped,
    savedScenarios(simulatorFolder, 9),
    directory,
    10,
  );
  const deferred = reports.filter((r) => r.cleanup === "deferred");
  assert.equal(deferred.length, 1);
  assert.equal(reports.filter((r) => r.status === "passed").length, 9);
  const recovered = await resumeCleanup(
    backend,
    path.join(deferred[0]!.directory, "report.json"),
  );
  assert.equal(recovered.cleanup, "complete");
  assert.deepEqual(await files(model), beforeFiles);
  assert.deepEqual(await remaining(model), beforeDocs);
});

for (const fault of ["read-only", "version"] as const) {
  test(`cleanup refuses a ${fault} file and preserves the original assertion error`, async (t) => {
    const { directory, model, backend } = await fixture(t);
    const base = savedScenarios(simulatorFolder, 1)[0]!;
    const scenario: Scenario = {
      ...base,
      async run(session) {
        const result = await model.execute(
          programs.program(`import adsk.core
file = adsk.core.Application.get().data.findFileById(${JSON.stringify(session.document.file!.fileId)})
${fault === "read-only" ? "file.isReadOnly = True" : "file.versionNumber += 1"}`),
        );
        assert.equal(result.success, true, result.error);
        assert.fail("original assertion");
      },
    };
    const [report] = await runScenarios(backend, [scenario], directory, 1);
    assert.ok(report);
    assert.equal(report.error, "original assertion");
    assert.equal(report.cleanup, "failed");
    const check = await model.execute(
      programs.program(`import adsk.core, json
print(json.dumps(dict(deletes=adsk.core.Application.get().data.delete_calls)))`),
    );
    assert.deepEqual(JSON.parse(check.stdout), { deletes: 0 });
    assert.ok(
      JSON.stringify(await files(model)).includes(
        report.document!.file!.fileId,
      ),
    );
  });
}

test("foreign absence proof cannot authorize a passed cleanup", async (t) => {
  const { directory, model, backend } = await fixture(t);
  let corrupted = false;
  const wrapped: ScenarioBackend = {
    ...backend,
    async execute(request) {
      const result = await backend.execute(request);
      if (
        !corrupted &&
        request.source.includes("absent=not matches") &&
        !request.source.includes("file.deleteMe()")
      ) {
        corrupted = true;
        const value = JSON.parse(
          result.stdout.trim().slice(programs.marker.length),
        ) as Record<string, unknown>;
        return {
          ...result,
          stdout:
            programs.marker +
            JSON.stringify({
              ...value,
              fileId: "someone-elses-file",
              absent: true,
            }),
        };
      }
      return result;
    },
  };
  const [report] = await runScenarios(
    wrapped,
    [savedScenarios(simulatorFolder, 1)[0]!],
    directory,
    1,
  );
  assert.ok(report);
  assert.equal(report.status, "failed");
  assert.equal(report.cleanup, "deferred");
  assert.equal(
    report.requests.some((r) => r.phase === "cleanup-delete"),
    false,
  );
  assert.ok(
    JSON.stringify(await files(model)).includes(report.document!.file!.fileId),
  );
  const recovered = await resumeCleanup(
    backend,
    path.join(report.directory, "report.json"),
  );
  assert.equal(recovered.cleanup, "complete");
});

test("a foreign save receipt blocks scenario steps and leaves cleanup deferred", async (t) => {
  const { directory, backend } = await fixture(t);
  let steps = 0;
  const wrapped: ScenarioBackend = {
    ...backend,
    async execute(request) {
      const result = await backend.execute(request);
      if (request.source.includes("doc.saveAs(")) {
        const filename = path.join(request.directory, "save-intent.json");
        const value = JSON.parse(fs.readFileSync(filename, "utf8")) as Record<
          string,
          unknown
        >;
        fs.writeFileSync(
          filename,
          JSON.stringify({ ...value, clientId: "foreign-owner" }),
        );
      }
      return result;
    },
  };
  const base = savedScenarios(simulatorFolder, 1)[0]!;
  const [report] = await runScenarios(
    wrapped,
    [
      {
        ...base,
        async run() {
          steps++;
        },
      },
    ],
    directory,
    1,
  );
  assert.ok(report);
  assert.equal(steps, 0);
  assert.equal(report.cleanup, "deferred");
  assert.equal(
    report.requests.some((r) => r.phase.startsWith("cleanup")),
    false,
  );
  await assert.rejects(
    resumeCleanup(backend, path.join(report.directory, "report.json")),
    /Save intent does not belong/,
  );
});

for (const phase of ["save", "close", "delete"] as const) {
  test(`${phase} refusal is a failure, and settled cleanup can recover without leaking files`, async (t) => {
    const { directory, model, backend } = await fixture(t);
    const operation =
      phase === "save"
        ? "doc.saveAs(doc.name, folder, 'fmcad isolated scenario', '')"
        : phase === "close"
          ? "doc.close(False)"
          : "file.deleteMe()";
    const wrapped: ScenarioBackend = {
      ...backend,
      execute(request) {
        return backend.execute({
          ...request,
          source: request.source.replace(operation, "False"),
        });
      },
    };
    const [report] = await runScenarios(
      wrapped,
      [savedScenarios(simulatorFolder, 1)[0]!],
      directory,
      1,
    );
    assert.ok(report);
    assert.equal(report.status, "failed");
    assert.equal(report.cleanup, phase === "save" ? "complete" : "failed");
    if (phase !== "save") {
      assert.ok(
        JSON.stringify(await files(model)).includes(
          report.document!.file!.fileId,
        ),
      );
      const recovered = await resumeCleanup(
        backend,
        path.join(report.directory, "report.json"),
      );
      assert.equal(recovered.cleanup, "complete", JSON.stringify(recovered));
    }
    assert.deepEqual(await remaining(model), { active: null, documents: [] });
    assert.deepEqual(await files(model), { ...simulatorFolder, files: [] });
  });
}

test("the model preserves save no-op/version behavior and refuses deleting an open file", async (t) => {
  const { model } = await fixture(t);
  const result = await model.execute(
    programs.program(`import adsk.core, json
app = adsk.core.Application.get()
doc = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
folder = app.data.dataProjects.itemById('sim-project:fixtures').rootFolder
assert doc.saveAs('version-test', folder, '', '')
file = doc.dataFile
assert not file.isComplete
app.data.advance_model()
app.data.advance_model()
assert file.isComplete
assert doc.save('unchanged') and doc.dataFile.versionNumber == 1
assert not file.deleteMe()
design = doc.products.itemByProductType('DesignProductType')
design.userParameters.add('width', adsk.core.ValueInput.createByString('20 mm'), 'mm', '')
assert doc.save('changed')
assert doc.dataFile.id == file.id and doc.dataFile.versionNumber == 2
assert file.latestVersionNumber == 2
assert doc.close(True)
app.data.advance_model()
app.data.advance_model()
assert file.latestVersion.deleteMe()
app.data.advance_model()
app.data.advance_model()
assert folder.dataFiles.count == 0
print(json.dumps(dict(saves=app.data.save_calls, deletes=app.data.delete_calls)))`),
  );
  assert.equal(result.success, true, result.error);
  assert.deepEqual(JSON.parse(result.stdout), { saves: 2, deletes: 1 });
});

test("the CLI requires explicit native fixture ownership and defaults the model to both suites", () => {
  const options = parse([]);
  assert.equal(options.suite, "all");
  assert.deepEqual(options.folder, simulatorFolder);
  assert.throws(
    () => parse(["--backend", "fusion", "--run"]),
    /explicitly configured/,
  );
  assert.throws(() => parse(["--project-id", "a"]), /both/);
  const live = parse([
    "--backend",
    "fusion",
    "--run",
    "--project-id",
    "a",
    "--folder-id",
    "b",
  ]);
  assert.equal(live.concurrency, 10);
  assert.deepEqual(live.folder, { projectId: "a", folderId: "b" });
  assert.equal(
    parse(["--backend", "fusion", "--run", "--suite", "foundation"]).suite,
    "foundation",
  );
});

test("cancellation after save acceptance waits for owned cleanup and skips scenario steps", async (t) => {
  const { directory, model, backend } = await fixture(t);
  const controller = new AbortController();
  let steps = 0;
  const wrapped: ScenarioBackend = {
    ...backend,
    async execute(request) {
      const result = await backend.execute(request);
      if (request.source.includes("doc.saveAs("))
        controller.abort(new Error("cancel after save"));
      return result;
    },
  };
  const base = savedScenarios(simulatorFolder, 1)[0]!;
  const [report] = await runScenarios(
    wrapped,
    [
      {
        ...base,
        async run() {
          steps++;
        },
      },
    ],
    directory,
    1,
    controller.signal,
  );
  assert.equal(steps, 0);
  assert.equal(report?.status, "failed");
  assert.equal(report.cleanup, "complete");
  assert.match(report.error ?? "", /cancel after save/);
  assert.deepEqual(await files(model), { ...simulatorFolder, files: [] });
});

test("an incomplete cloud save exhausts its observation budget without resubmitting the save", async () => {
  let observations = 0;
  await assert.rejects(
    observeSavedFile(
      { creationId: "owned", name: "fixture" },
      simulatorFolder,
      async (phase) => {
        assert.equal(phase, "save-observe");
        observations++;
        return {
          creationId: "owned",
          saved: true,
          complete: false,
          fileId: "file",
          version: 1,
          ...simulatorFolder,
        };
      },
      false,
      { timeoutMs: 0, intervalMs: 0 },
    ),
    UnsettledCloudOperation,
  );
  assert.equal(observations, 1);
});

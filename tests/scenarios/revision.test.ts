import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fixture, remaining } from "./test-support";
import { simulatorFolder } from "./simulator";
import { revisionScenarios, reopenScenarios } from "./reopen-cases";
import { resumeCleanup, runScenarios } from "./runner";
import { program } from "./programs";

for (const protocol of ["mcp", "addin"] as const) {
  for (const concurrency of [1, 2, 10]) {
    test(`saved geometry revision and reopen via ${protocol}, concurrency ${concurrency}`, async (t) => {
      const { backend, model, directory } = await fixture(t, protocol);
      const reports = await runScenarios(
        backend,
        revisionScenarios(simulatorFolder),
        directory,
        concurrency,
      );
      for (const report of reports) {
        assert.equal(report.status, "passed", JSON.stringify(report));
        assert.equal(report.cleanup, "complete");
        assert.equal(report.document?.file?.version, 2);
      }
      assert.deepEqual(await remaining(model), { active: null, documents: [] });
    });
  }
}

for (const boundary of ["save", "observation", "open", "delete"] as const) {
  test(`lost revision ${boundary} response recovers the exact version with no repeated mutations`, async (t) => {
    const { backend, model, directory } = await fixture(t);
    let saved = false,
      lost = false,
      saves = 0;
    const faulty = {
      ...backend,
      async execute(request: Parameters<typeof backend.execute>[0]) {
        const saving = request.source.includes(
          "doc.save('fmcad owned scenario revision')",
        );
        if (saving) {
          saved = true;
          saves++;
        }
        const selected =
          boundary === "save"
            ? saving
            : boundary === "open"
              ? request.source.includes("app.documents.open(file, True)")
              : boundary === "delete"
                ? request.source.includes("file.deleteMe()")
                : saved && request.source.includes("complete=file.isComplete");
        const result = await backend.execute(request);
        if (!lost && selected) {
          lost = true;
          throw new Error("Lost revision " + boundary);
        }
        return result;
      },
    };
    const [report] = await runScenarios(
      faulty,
      revisionScenarios(simulatorFolder, 1),
      directory,
      1,
    );
    assert.ok(report);
    assert.equal(report.status, "failed");
    assert.equal(report.cleanup, "deferred");
    const recovered = await resumeCleanup(
      faulty,
      path.join(report.directory, "report.json"),
    );
    assert.equal(recovered.status, "failed");
    assert.equal(recovered.cleanup, "complete", JSON.stringify(recovered));
    assert.equal(recovered.document?.file?.version, 2);
    assert.equal(saves, 1);
    const counters = await model.execute(
      program(`import adsk.core, json
app = adsk.core.Application.get()
print(json.dumps(dict(saves=app.data.save_calls, deletes=app.data.delete_calls)))`),
    );
    assert.equal(counters.success, true, counters.error);
    assert.deepEqual(JSON.parse(counters.stdout), { saves: 2, deletes: 1 });
    assert.deepEqual(await remaining(model), { active: null, documents: [] });
  });
}

test("unmodified revision keeps the exact version and rejects a second save before submission", async (t) => {
  const { backend, model, directory } = await fixture(t);
  const scenario = reopenScenarios(simulatorFolder, 1)[0]!;
  const [report] = await runScenarios(
    backend,
    [
      {
        ...scenario,
        async run(session) {
          const before = session.document;
          await session.saveRevision();
          assert.deepEqual(session.document, before);
          await assert.rejects(session.saveRevision(), /one revision/);
          await session.reopen();
          assert.deepEqual(session.document.file, before.file);
        },
      },
    ],
    directory,
    1,
  );
  assert.equal(report?.status, "passed", JSON.stringify(report));
  assert.equal(report?.cleanup, "complete");
  assert.deepEqual(await remaining(model), { active: null, documents: [] });
});

test("cancellation after completed revision still cleans its exact new version", async (t) => {
  const { backend, model, directory } = await fixture(t);
  const controller = new AbortController();
  const faulty = {
    ...backend,
    async execute(request: Parameters<typeof backend.execute>[0]) {
      const result = await backend.execute(request);
      if (
        request.source.includes("complete=file.isComplete") &&
        result.stdout.includes('"version": 2') &&
        result.stdout.includes('"complete": true')
      )
        controller.abort(new Error("Cancelled after revision completion"));
      return result;
    },
  };
  const [report] = await runScenarios(
    faulty,
    revisionScenarios(simulatorFolder, 1),
    directory,
    1,
    controller.signal,
  );
  assert.equal(report?.status, "failed");
  assert.match(report?.error ?? "", /Cancelled after revision completion/);
  assert.equal(report?.cleanup, "complete", JSON.stringify(report));
  assert.equal(report?.document?.file?.version, 2);
  assert.equal(
    report?.requests.filter((r) => r.phase === "revision-save").length,
    1,
  );
  assert.equal(
    report?.requests.filter((r) => r.phase === "reopen-open").length,
    0,
  );
  assert.deepEqual(await remaining(model), { active: null, documents: [] });
});

test("an extra foreign version after save cannot authorize deletion or a replacement save", async (t) => {
  const { backend, model, directory } = await fixture(t);
  let changed = false;
  const faulty = {
    ...backend,
    async execute(request: Parameters<typeof backend.execute>[0]) {
      const result = await backend.execute(request);
      if (
        !changed &&
        request.source.includes("doc.save('fmcad owned scenario revision')")
      ) {
        changed = true;
        const altered = await model.execute(
          program(`import adsk.core
app = adsk.core.Application.get()
assert app.activeDocument is not None and app.activeDocument.dataFile is not None
app.activeDocument.dataFile.versionNumber += 1`),
        );
        assert.equal(altered.success, true, altered.error);
      }
      return result;
    },
  };
  const [report] = await runScenarios(
    faulty,
    revisionScenarios(simulatorFolder, 1),
    directory,
    1,
  );
  assert.ok(report);
  assert.equal(report.status, "failed");
  assert.equal(report.cleanup, "deferred");
  await assert.rejects(
    resumeCleanup(faulty, path.join(report.directory, "report.json")),
    /file or version/,
  );
  assert.equal(
    report.requests.filter((r) => r.phase === "revision-save").length,
    1,
  );
  assert.equal(
    report.requests.filter((r) => r.phase === "cleanup-delete").length,
    0,
  );
});

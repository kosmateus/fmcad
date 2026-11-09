import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { fixture, remaining } from "./test-support";
import { simulatorFolder } from "./simulator";
import { reopenScenarios } from "./reopen-cases";
import { resumeCleanup, runScenarios } from "./runner";
import { program } from "./programs";
import { record } from "./contracts";

for (const protocol of ["mcp", "addin"] as const) {
  for (const concurrency of [1, 2, 10]) {
    test(`saved fixture reopen via ${protocol}, concurrency ${concurrency}`, async (t) => {
      const { backend, model, directory } = await fixture(t, protocol);
      const reports = await runScenarios(
        backend,
        reopenScenarios(simulatorFolder),
        directory,
        concurrency,
      );
      for (const report of reports) {
        assert.equal(report.status, "passed", JSON.stringify(report));
        assert.equal(report.cleanup, "complete");
        assert.notEqual(
          report.document?.creationId,
          report.originalDocument?.creationId,
        );
        assert.equal(
          report.requests.filter((r) => r.phase === "reopen-open").length,
          1,
        );
      }
      assert.deepEqual(await remaining(model), { active: null, documents: [] });
    });
  }
}

for (const boundary of ["close", "open"] as const) {
  test(`lost ${boundary} reply recovers original evidence without repeating either mutation`, async (t) => {
    const { backend, model, directory } = await fixture(t);
    let lost = false,
      opens = 0,
      closes = 0;
    const faulty = {
      ...backend,
      async execute(request: Parameters<typeof backend.execute>[0]) {
        const isOpen = request.source.includes(
          "app.documents.open(file, True)",
        );
        const isClose = request.source.includes("doc.close(False)");
        if (isOpen) opens++;
        if (isClose) closes++;
        const result = await backend.execute(request);
        if (!lost && (boundary === "open" ? isOpen : isClose)) {
          lost = true;
          throw new Error("Lost original reopen " + boundary);
        }
        return result;
      },
    };
    const [report] = await runScenarios(
      faulty,
      reopenScenarios(simulatorFolder, 1),
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
    assert.equal(opens, boundary === "open" ? 1 : 0);
    assert.equal(closes, boundary === "open" ? 2 : 1);
    assert.deepEqual(await remaining(model), { active: null, documents: [] });
  });
}

test("foreign durable reopened identity leaves cleanup deferred and never deletes a file", async (t) => {
  const { backend, model, directory } = await fixture(t);
  const faulty = {
    ...backend,
    async execute(request: Parameters<typeof backend.execute>[0]) {
      const result = await backend.execute(request);
      if (request.source.includes("app.documents.open(file, True)")) {
        const receipt = path.join(request.directory, "reopen.json");
        const value = record(
          JSON.parse(fs.readFileSync(receipt, "utf8")) as unknown,
        );
        fs.writeFileSync(
          receipt,
          JSON.stringify({ ...value, creationId: "foreign-document" }),
        );
      }
      return result;
    },
  };
  const [report] = await runScenarios(
    faulty,
    reopenScenarios(simulatorFolder, 1),
    directory,
    1,
  );
  assert.ok(report);
  assert.equal(report.status, "failed");
  assert.equal(report.cleanup, "deferred");
  await assert.rejects(
    resumeCleanup(faulty, path.join(report.directory, "report.json")),
    /identities differ/,
  );
  const state = await model.execute(
    program(`import adsk.core, json
app = adsk.core.Application.get()
print(json.dumps(dict(documents=app.documents.count, deletes=app.data.delete_calls)))`),
  );
  assert.equal(state.success, true, state.error);
  assert.deepEqual(JSON.parse(state.stdout), { documents: 1, deletes: 0 });
});

test("a settled failure after native open cannot replay or authorize cleanup without its successful receipt", async (t) => {
  const { backend, directory } = await fixture(t);
  const faulty = {
    ...backend,
    async execute(request: Parameters<typeof backend.execute>[0]) {
      const result = await backend.execute(request);
      return request.source.includes("app.documents.open(file, True)")
        ? {
            ...result,
            state: "failed" as const,
            mayHaveMutated: true,
            error: "Failure after native open",
            stdout: "",
          }
        : result;
    },
    async lookup(
      owner: Parameters<NonNullable<typeof backend.lookup>>[0],
      id: string,
    ) {
      const result = await backend.lookup!(owner, id);
      if (result?.stdout.includes('"previousCreationId"'))
        return {
          ...result,
          state: "failed" as const,
          mayHaveMutated: true,
          stdout: "",
        };
      return result;
    },
  };
  const [report] = await runScenarios(
    faulty,
    reopenScenarios(simulatorFolder, 1),
    directory,
    1,
  );
  assert.ok(report);
  assert.equal(report.cleanup, "deferred");
  await assert.rejects(
    resumeCleanup(faulty, path.join(report.directory, "report.json")),
    /lacks settlement proof/,
  );
  assert.equal(
    report.requests.filter((r) => r.phase === "reopen-open").length,
    1,
  );
  assert.equal(
    report.requests.filter((r) => r.phase === "cleanup-delete").length,
    0,
  );
});

for (const kind of ["assertion", "operation"] as const) {
  test(`failure after reopened ${kind} retains primary failure and removes the saved fixture`, async (t) => {
    const { backend, model, directory } = await fixture(t);
    const scenario = reopenScenarios(simulatorFolder, 1)[0]!;
    const [report] = await runScenarios(
      backend,
      [
        {
          ...scenario,
          async run(session) {
            await scenario.run(session);
            if (kind === "assertion") assert.fail("Primary reopened failure");
            await session.execute(
              "fail",
              program("raise ValueError('Primary reopened failure')"),
            );
          },
        },
      ],
      directory,
      1,
    );
    assert.equal(report?.status, "failed");
    assert.match(report?.error ?? "", /Primary reopened failure/);
    assert.equal(report?.cleanup, "complete");
    assert.deepEqual(await remaining(model), { active: null, documents: [] });
  });
}

test("cancellation after close skips open and cleans the exact file without a second close", async (t) => {
  const { backend, model, directory } = await fixture(t);
  const controller = new AbortController();
  const faulty = {
    ...backend,
    async execute(request: Parameters<typeof backend.execute>[0]) {
      const result = await backend.execute(request);
      if (request.source.includes("doc.close(False)"))
        controller.abort(new Error("Cancelled after close"));
      return result;
    },
  };
  const [report] = await runScenarios(
    faulty,
    reopenScenarios(simulatorFolder, 1),
    directory,
    1,
    controller.signal,
  );
  assert.equal(report?.status, "failed");
  assert.equal(report?.cleanup, "complete");
  assert.match(report?.error ?? "", /Cancelled after close/);
  assert.equal(
    report?.requests.filter((r) => r.phase === "reopen-open").length,
    0,
  );
  assert.equal(
    report?.requests.filter((r) => r.phase === "cleanup-close").length,
    0,
  );
  assert.deepEqual(await remaining(model), { active: null, documents: [] });
});

test("second reopen is rejected before submission while the first identity is still cleaned", async (t) => {
  const { backend, model, directory } = await fixture(t);
  const scenario = reopenScenarios(simulatorFolder, 1)[0]!;
  const [report] = await runScenarios(
    backend,
    [
      {
        ...scenario,
        async run(session) {
          await session.reopen();
          await assert.rejects(session.reopen(), /only once/);
        },
      },
    ],
    directory,
    1,
  );
  assert.equal(report?.status, "passed", JSON.stringify(report));
  assert.equal(
    report?.requests.filter((r) => r.phase === "reopen-open").length,
    1,
  );
  assert.deepEqual(await remaining(model), { active: null, documents: [] });
});

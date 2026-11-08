import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fixture, remaining } from "./test-support";
import { simulatorFolder } from "./simulator";
import { runScenarios, resumeCleanup, type Scenario } from "./runner";
import { parameter } from "./programs";
function scenario(id: string, exclusive = false): Scenario {
  return {
    id,
    fixture: simulatorFolder,
    requires: ["documents", "saved-fixtures"],
    scope: exclusive ? "exclusive-instance" : "owned-document",
    async run(session) {
      await session.execute("parameter", parameter(session.document, 12));
    },
  };
}
test("exclusive scenarios wait for earlier cleanup and finish cleanup before later creation", async (t) => {
  const { backend, model, directory } = await fixture(t);
  const barriers: string[] = [];
  const observed = {
    ...backend,
    async execute(request: Parameters<typeof backend.execute>[0]) {
      if (
        ["exclusive", "after"].includes(request.owner.scenarioId) &&
        request.source.includes("app.documents.add(")
      ) {
        assert.deepEqual(
          await remaining(model),
          { active: null, documents: [] },
          "A prior fixture survived the barrier",
        );
        barriers.push(request.owner.scenarioId);
      }
      return backend.execute(request);
    },
  };
  const reports = await runScenarios(
    observed,
    [
      scenario("left"),
      scenario("right"),
      scenario("exclusive", true),
      scenario("after"),
    ],
    directory,
    10,
  );
  assert.deepEqual(
    reports.map((r) => r.status),
    ["passed", "passed", "passed", "passed"],
  );
  assert.deepEqual(barriers, ["exclusive", "after"]);
  assert.equal(reports[2]?.scope, "exclusive-instance");
  assert.deepEqual(await remaining(model), { active: null, documents: [] });
});
test("failed exclusive scenario blocks later work even when its owned file is cleaned", async (t) => {
  const { backend, model, directory } = await fixture(t);
  const failed = {
    ...scenario("exclusive", true),
    async run() {
      throw new Error("Global restoration assertion failed");
    },
  };
  const reports = await runScenarios(
    backend,
    [failed, scenario("after")],
    directory,
    10,
  );
  assert.equal(reports[0]?.status, "failed");
  assert.equal(reports[0]?.cleanup, "complete");
  assert.equal(reports[1]?.status, "not-run");
  assert.equal(reports[1]?.cleanup, "not-created");
  assert.deepEqual(reports[1]?.requests, []);
  assert.deepEqual(await remaining(model), { active: null, documents: [] });
});
test("unknown earlier cleanup blocks exclusive work and recovery never launches blocked scenarios", async (t) => {
  const { backend, model, directory } = await fixture(t);
  let lost = false;
  const faulty = {
    ...backend,
    async execute(request: Parameters<typeof backend.execute>[0]) {
      const result = await backend.execute(request);
      if (!lost && request.source.includes("file.deleteMe()")) {
        lost = true;
        throw new Error("Lost deletion reply");
      }
      return result;
    },
  };
  const reports = await runScenarios(
    faulty,
    [scenario("before"), scenario("exclusive", true), scenario("after")],
    directory,
    10,
  );
  assert.equal(reports[0]?.cleanup, "deferred");
  assert.deepEqual(
    reports.slice(1).map((r) => r.status),
    ["not-run", "not-run"],
  );
  const restored = await resumeCleanup(
    backend,
    path.join(reports[0]!.directory, "report.json"),
  );
  assert.equal(restored.cleanup, "complete");
  assert.deepEqual(
    reports.slice(1).map((r) => r.requests),
    [[], []],
  );
  assert.deepEqual(await remaining(model), { active: null, documents: [] });
});

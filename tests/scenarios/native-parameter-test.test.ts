import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture } from "./test-support";
import { simulatorFolder } from "./simulator";
import { runScenarios, resumeCleanup } from "./runner";
import { parse } from "./cli";
import {
  nativeParameterFixtures,
  nativeParameterProgram,
  nativeParameterTestCapability,
  nativeParameterTestScenarios,
} from "./native-parameter-test-cases";
import type { Document, ScenarioBackend, ScriptRequest } from "./contracts";
const root = path.resolve(__dirname, "../../..");
const owned: Document = {
  creationId: "owned-creation",
  name: "Owned parameter scratch",
  file: {
    fileId: "owned-file",
    projectId: "owned-project",
    folderId: "owned-folder",
    version: 1,
  },
};
test("retained parameter programs preserve original run bodies and bind exact documented file arguments", () => {
  for (const retained of nativeParameterFixtures) {
    const original = fs.readFileSync(path.join(root, retained.source), "utf8");
    const actual = nativeParameterProgram(owned, retained);
    const injected = original.replace(
      /^ARGS = \{\}$/mu,
      'ARGS = {"fileId":"owned-file","projectId":"owned-project","folderId":"owned-folder"}',
    );
    assert.ok(actual.startsWith(injected));
    assert.equal(actual.split("def run(_context):").length, 2);
    assert.ok(
      actual.includes('file.id == "owned-file" and file.versionNumber == 1'),
    );
    assert.ok(
      actual.includes(
        'file.parentProject.id == "owned-project" and file.parentFolder.id == "owned-folder"',
      ),
    );
    assert.ok(actual.includes('d.creationId == "owned-creation"'));
  }
  assert.throws(
    () =>
      nativeParameterProgram(
        { creationId: "unsaved", name: "unsaved" },
        nativeParameterFixtures[0],
      ),
    /owned saved file/u,
  );
});
test("native parameter acceptance requires explicit native execution and a dedicated folder", () => {
  assert.throws(
    () => parse(["--backend", "fusion", "--suite", "native-parameter-test"]),
    /requires --run/u,
  );
  assert.throws(
    () =>
      parse([
        "--backend",
        "fusion",
        "--run",
        "--suite",
        "native-parameter-test",
      ]),
    /explicitly configured/u,
  );
});
for (const protocol of ["mcp", "addin"] as const) {
  test(`parameter native capability refuses every owned instance before dispatch via ${protocol}`, async (t) => {
    const { backend, model, directory } = await fixture(t, protocol);
    const before = model.executions;
    for (const scenario of nativeParameterTestScenarios(simulatorFolder)) {
      const reports = await runScenarios(backend, [scenario], directory, 10);
      assert.equal(reports[0]?.status, "unsupported");
      assert.equal(reports[0]?.cleanup, "not-created");
      assert.deepEqual(reports[0]?.requests, []);
    }
    assert.equal(model.executions, before);
  });
  for (const state of ["failed", "unknown"] as const)
    test(`unproved native parameter restoration keeps its original owned file after ${state} via ${protocol}`, async (t) => {
      const { backend, directory } = await fixture(t, protocol);
      const requests: ScriptRequest[] = [];
      const faulted: ScenarioBackend = {
        ...backend,
        capabilities: new Set([
          ...backend.capabilities,
          nativeParameterTestCapability,
        ]),
        async execute(request) {
          requests.push(request);
          if (request.source.includes("_retained_parameter_run = run"))
            return {
              requestId: request.requestId,
              state,
              sdkSettled: state === "failed",
              mayHaveMutated: true,
              stdout: "",
              error: "Injected unverified native local restoration",
            };
          return backend.execute(request);
        },
      };
      const [report] = await runScenarios(
        faulted,
        nativeParameterTestScenarios(simulatorFolder, 1),
        directory,
        1,
      );
      assert.ok(report);
      assert.equal(report.status, "failed");
      assert.equal(report.cleanup, "deferred");
      assert.ok(report.document?.file);
      assert.equal(
        requests.filter((request) =>
          request.source.includes("_retained_parameter_run = run"),
        ).length,
        1,
      );
      assert.equal(
        report.requests.some(
          (request) =>
            request.phase === "cleanup-close" ||
            request.phase === "delete-file",
        ),
        false,
      );
      await assert.rejects(
        () => resumeCleanup(faulted, report.directory),
        /hold|restor|review/iu,
      );
      assert.equal(
        requests.filter((request) =>
          request.source.includes("_retained_parameter_run = run"),
        ).length,
        1,
      );
    });
}

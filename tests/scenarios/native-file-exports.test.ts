import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, remaining } from "./test-support";
import { record } from "./contracts";
import { marker } from "./programs";
import { runScenarios, resumeCleanup } from "./runner";
import {
  nativeFileExportScenarios,
  nativeFileExportsCapability,
  ownedExportPaths,
} from "./native-file-export-cases";

for (const protocol of ["mcp", "addin"] as const) {
  test(`native exports reject all ten unsupported owners before SDK dispatch via ${protocol}`, async (t) => {
    const { backend, model, directory } = await fixture(t, protocol);
    const before = model.executions;
    const reports = [];
    for (const scenario of nativeFileExportScenarios())
      reports.push(...(await runScenarios(backend, [scenario], directory, 10)));
    assert.equal(reports.length, 10);
    assert.equal(model.executions, before);
    for (const report of reports) {
      assert.equal(report.status, "unsupported");
      assert.equal(report.cleanup, "not-created");
      assert.equal(report.fixture, undefined);
      assert.deepEqual(report.requests, []);
    }
    assert.deepEqual(await remaining(model), { active: null, documents: [] });
  });

  test(`native export uncertain metadata retains the exact owner and forbids file work or replay via ${protocol}`, async (t) => {
    const { backend, model, directory } = await fixture(t, protocol);
    let injected = false;
    let cadCommands = 0;
    let fileRequests = 0;
    const faulted = {
      ...backend,
      // Inject only into a real metadata reply, before any unsupported geometry.
      capabilities: new Set([
        ...backend.capabilities,
        nativeFileExportsCapability,
      ]),
      async execute(request: Parameters<typeof backend.execute>[0]) {
        if (request.command) cadCommands++;
        if (
          request.source.includes("existing = [filename") ||
          request.source.includes("os.remove(filename)")
        )
          fileRequests++;
        const result = await backend.execute(request);
        if (
          !injected &&
          request.source.includes("version=app.version, documents=docs")
        ) {
          assert.equal(request.target, undefined);
          assert.equal(result.state, "succeeded");
          assert.equal(result.sdkSettled, true);
          const lines = result.stdout
            .trim()
            .split(/\r?\n/u)
            .filter((line) => line.startsWith(marker));
          assert.equal(lines.length, 1);
          const value = record(
            JSON.parse(lines[0]!.slice(marker.length)) as unknown,
          );
          value["nativeFiles"] = { completed: false };
          injected = true;
          return { ...result, stdout: marker + JSON.stringify(value) + "\n" };
        }
        return result;
      },
    };
    const reports = await runScenarios(
      faulted,
      nativeFileExportScenarios(2),
      directory,
      10,
    );
    assert.equal(injected, true);
    assert.equal(cadCommands, 0);
    assert.equal(fileRequests, 0);
    const first = reports[0]!;
    assert.equal(first.status, "failed");
    assert.equal(first.cleanup, "deferred");
    assert.match(first.cleanupHold?.reason ?? "", /unknown\/pending/u);
    assert.equal(reports[1]?.status, "not-run");
    assert.deepEqual(reports[1]?.requests, []);
    const state = record(await remaining(model));
    assert.ok(Array.isArray(state["documents"]));
    assert.equal(state["documents"].length, 1);
    assert.equal(
      record(state["documents"][0])["creationId"],
      first.document?.creationId,
    );
    assert.ok(!first.requests.some((request) => request.phase === "cleanup"));
    const persisted = record(
      JSON.parse(
        fs.readFileSync(path.join(first.directory, "report.json"), "utf8"),
      ) as unknown,
    );
    assert.deepEqual(persisted["cleanupHold"], first.cleanupHold);
    const count = model.executions;
    await assert.rejects(
      resumeCleanup(backend, path.join(first.directory, "report.json")),
      /case-specific|cleanup hold|uncertainty/iu,
    );
    assert.equal(model.executions, count);
  });
}

test("export files are exact owner-private session children and reject escaping native mappings", () => {
  const directory = path.resolve(".test-artifacts/export-path-proof/run/owner");
  const document = { name: "FMCAD_SCENARIO_run_owner", creationId: "owned-id" };
  const fusionPath = (local: string) =>
    path.win32.join(
      "C:\\owned-scenarios",
      path.relative(path.dirname(directory), local),
    );
  const backend = { fusionPath };
  const paths = ownedExportPaths({ directory, document, backend });
  assert.equal(paths.files.length, 4);
  assert.deepEqual(
    paths.files.map((file) => file.key),
    ["step", "stl", "partsStep", "partsStl"],
  );
  assert.ok(
    paths.files.every((file) => path.dirname(file.local) === directory),
  );
  assert.ok(
    paths.files.every(
      (file) => path.win32.dirname(file.native) === paths.nativeParent,
    ),
  );
  assert.throws(() =>
    ownedExportPaths({
      directory,
      document: { ...document, name: "../foreign" },
      backend,
    }),
  );
  assert.throws(() =>
    ownedExportPaths({
      directory,
      document,
      backend: { ...backend, fusionPath: () => "relative.step" },
    }),
  );
  assert.throws(() =>
    ownedExportPaths({
      directory,
      document,
      backend: {
        ...backend,
        fusionPath: (local) =>
          local === directory ? fusionPath(local) : "C:\\foreign\\file.step",
      },
    }),
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fixture, remaining } from "./test-support";
import { runScenarios } from "./runner";
import { NativeProbe } from "./native-probe";
import {
  nativeStyleSaveScenarios,
  nativeStyleSavePreview,
  nativeStyleSaveRuntime,
  nativeStyleSaveProbePrelude,
  instrumentStyleSaveCad,
} from "./native-style-save-cases";

test("style probes retain handlers invoked directly by their rejection and archive checks", () => {
  const source = nativeStyleSaveRuntime();
  for (const handler of [
    "_io_material_assign",
    "_io_appearance_assign",
    "_io_appearance_clear",
    "_document_save_as",
    "_io_checkpoint_open",
  ]) {
    assert.ok(source.includes(`def ${handler}(`), `Missing ${handler}`);
  }
});

for (const mode of ["script", "compiled"] as const)
  test(`complete style ${mode} passes the public no-helper checker before SDK dispatch`, async (t) => {
    const { backend, directory } = await fixture(t, "addin");
    const load = createRequire(path.join(process.cwd(), "package.json"));
    const { prepareRunScript } = load(
      "./src/run",
    ) as typeof import("../../src/composition/run");
    const { preparePythonArtifact } = load(
      "./packages/node-adapters/dist/python/artifact",
    ) as typeof import("../../packages/node-adapters/src/python/artifact");
    const { createPythonChecker } = load(
      "./packages/node-adapters/dist/python/checker",
    ) as typeof import("../../packages/node-adapters/src/python/checker");
    const typingRoot = path.join(process.cwd(), "dist/runtime/python/typing");
    const checker = createPythonChecker({
      typingRoot,
      definitionsRoot: typingRoot,
      pythonPlatform: "Windows",
    });
    let checked = false;
    let result: Awaited<ReturnType<typeof checker.check>> | undefined;
    const capture = {
      ...backend,
      async execute(request: Parameters<typeof backend.execute>[0]) {
        if (
          request.source.includes("STYLE_SAVE ") ||
          request.source.includes(
            "_native_case_results, _native_case_observations",
          )
        ) {
          checked = true;
          const filename = path.join(directory, "style-probe.py");
          fs.writeFileSync(filename, request.source);
          const prepared = prepareRunScript(filename, undefined, false);
          const artifact = preparePythonArtifact([
            {
              id: "style-probe",
              filename: "style-probe.py",
              role: "user",
              source: prepared.script + '\nrun("")\n',
            },
          ]);
          result = await checker.check({ artifact, context: { kind: "run" } });
          throw new Error("Offline capture stops before SDK dispatch");
        }
        return backend.execute(request);
      },
    };
    await runScenarios(
      capture,
      [
        {
          id: "style-probe-admission",
          requires: ["documents"],
          scope: "exclusive-instance",
          async run(session) {
            const probe = new NativeProbe(
              session,
              "style-probe",
              "STYLE_SAVE ",
              nativeStyleSaveProbePrelude(),
            );
            if (mode === "compiled") {
              await probe.compiled(
                "component.create",
                { name: "StyleDefinition" },
                "root",
                (source) =>
                  instrumentStyleSaveCad(
                    source,
                    `doc = guard(${JSON.stringify(session.document)}, [])\n`,
                  ),
              );
            } else
              await probe.script(
                `ctx = CadContext(${JSON.stringify(session.document.name)})\nprint('STYLE_SAVE ' + json.dumps(_cad_json(ctx.call('document.status', {})), allow_nan=False))`,
              );
          },
        },
      ],
      directory,
      1,
    );
    assert.equal(checked, true);
    assert.equal(result?.status, "passed", JSON.stringify(result));
  });

for (const protocol of ["mcp", "addin"] as const)
  test(`native style/save qualification requires the real kernel before all ten owners or user-view capture via ${protocol}`, async (t) => {
    const { backend, model, directory } = await fixture(t, protocol);
    const before = model.executions;
    const reports = [];
    for (const scenario of nativeStyleSaveScenarios())
      reports.push(...(await runScenarios(backend, [scenario], directory, 10)));
    assert.equal(reports.length, 10);
    assert.equal(
      model.executions,
      before,
      "Unsupported native styles must not read or change the user's view",
    );
    for (const report of reports) {
      assert.equal(report.status, "unsupported");
      assert.match(report.error ?? "", /Missing capabilities:/);
      assert.equal(report.cleanup, "not-created");
      assert.deepEqual(report.requests, []);
    }
    assert.deepEqual(await remaining(model), { active: null, documents: [] });
  });

test("retained style/save local preview validates inputs without backend or cloud destination", async () => {
  const preview = await nativeStyleSavePreview();
  assert.equal(preview["mutation"], false);
  assert.equal(preview["state"], "input-validated-only");
});

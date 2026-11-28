import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { cameraComponentNamePlan } from "../packages/node-adapters/src/python/camera-component-registry.js";
import type { PreparedPythonArtifact } from "../packages/core/src/domain/python-artifact.js";
import type { PythonCheckReport } from "../packages/core/src/domain/python-checker.js";

const root = process.env["FMCAD_CONTEXT_TEST_ROOT"] ?? process.cwd();
const load = createRequire(path.join(root, "package.json"));
const adapter = "./packages/node-adapters/dist/python/";
const { planCameraSaveContext } = load(adapter + "camera-context-registry.js");
const {
  cameraSaveHandlerPlan: handler,
  cameraSaveCanonicalSources: refs,
  cameraSaveTypingSources: types,
} = load(adapter + "camera-read-registry.js");
const { prepareCanonicalRegisteredPayload } = load(
  adapter + "registered-payload.js",
);
const checker = load(adapter + "checker.js").createPythonChecker({
  typingRoot: path.join(root, "dist/runtime/python/typing"),
  definitionsRoot: path.join(root, "dist/runtime/python/typing"),
});

for (const stage of ["initial", "resume-alias"] as const) {
  test(`camera component ${stage} closure passes official SDK checking`, async () => {
    const ctx = planCameraSaveContext({});
    const plan = cameraComponentNamePlan(stage);
    const artifact: PreparedPythonArtifact = prepareCanonicalRegisteredPayload(
      root,
      [...handler.definitions, ...ctx.definitions, ...plan.definitions],
      [
        ...refs,
        ...ctx.references,
        ...plan.references.map((r) => ({
          ...r,
          filename: path.relative(root, path.resolve(r.filename)),
        })),
      ],
      ["adsk", "adsk.fusion", ...ctx.roots, ...handler.roots, ...plan.roots],
      {},
      {
        id: "wrapper",
        filename: "<fmcad-wrapper>",
        role: "wrapper",
        source: `def run(_context: str):\n    ctx = CadContext('Test')\n    ${
          stage === "initial"
            ? "print(_camera_try_component_name(ctx, 'Part'))"
            : "_camera_resume_component_name(ctx, 'Part', 'root', lambda _: ctx.root)"
        }\n`,
      },
      {},
      [...types, ...ctx.typingReferences, ...plan.typingReferences].filter(
        (r) => r.importName !== "typing.TYPE_CHECKING",
      ),
    );
    assert.doesNotMatch(
      artifact.script,
      /def resolve\(|def _entity_query\(|def _entities\(/,
    );
    assert.equal(
      artifact.script.includes("def _cad_owner("),
      stage === "resume-alias",
    );
    const report: PythonCheckReport = await checker.check({
      artifact,
      context: { kind: "raw", entrypoint: "run" },
    });
    assert.equal(report.status, "passed", JSON.stringify(report.diagnostics));
  });
}

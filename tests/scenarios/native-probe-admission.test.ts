import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fixture } from "./test-support";
import { runScenarios } from "./runner";
import { NativeProbe } from "./native-probe";

for (const kind of ["script", "compiled"] as const) {
  test(`complete NativeProbe ${kind} wrapper passes public production admission`, async (t) => {
    const { backend, directory } = await fixture(t);
    let source: string | undefined;
    const [report] = await runScenarios(
      {
        ...backend,
        async execute(request) {
          if (request.source.includes("def print(")) {
            assert.equal(source, undefined);
            source = request.source;
            throw new Error("Captured native payload before SDK dispatch");
          }
          return backend.execute(request);
        },
      },
      [
        {
          id: "native-probe-admission-" + kind,
          requires: ["documents"],
          scope: "exclusive-instance",
          async run(session) {
            const probe = new NativeProbe(
              session,
              "native-admission",
              "PROBE ",
            );
            if (kind === "script")
              await probe.script(`print('ordinary output', sep='|', end='\\n', flush=True)
print('PROBE ' + json.dumps(dict(value=7, nested=[True, None])))`);
            else await probe.compiled("document.status");
          },
        },
      ],
      directory,
      1,
    );
    assert.match(
      report?.error ?? "",
      /Captured native payload before SDK dispatch/u,
    );
    assert.ok(source);
    const root = path.resolve(__dirname, "../../.."),
      load = createRequire(path.join(root, "package.json")),
      { prepareRunScript } = load(
        "./src/run",
      ) as typeof import("../../src/composition/run"),
      { preparePythonArtifact } = load(
        "./packages/node-adapters/dist/python/artifact",
      ) as typeof import("../../packages/node-adapters/src/python/artifact"),
      { createPythonChecker } = load(
        "./packages/node-adapters/dist/python/checker",
      ) as typeof import("../../packages/node-adapters/src/python/checker");
    const filename = path.join(directory, "native-" + kind + ".py");
    fs.writeFileSync(filename, source);
    const prepared = prepareRunScript(filename, undefined, false),
      artifact = preparePythonArtifact([
        {
          id: "native-probe-" + kind,
          filename: "native-probe.py",
          role: "user",
          source: prepared.script + '\nrun("")\n',
        },
      ]),
      typingRoot = path.join(root, "dist/runtime/python/typing"),
      checker = createPythonChecker({
        typingRoot,
        definitionsRoot: typingRoot,
        pythonPlatform: "Windows",
      }),
      result = await checker.check({ artifact, context: { kind: "run" } });
    assert.equal(result.status, "passed", JSON.stringify(result));
    assert.equal(result.provenance.checkerVersion, "1.40.2");
    assert.equal(
      result.provenance.definitionsHash,
      "83dc3697aa61a47ada93c323e2f719c7be3d72091938415f666089a96b159179",
    );
  });
}

test("native print forwarding preserves options and the nested JSON envelope", async (t) => {
  const { backend, directory } = await fixture(t);
  const [report] = await runScenarios(
    backend,
    [
      {
        id: "native-probe-print-options",
        requires: ["documents"],
        scope: "exclusive-instance",
        async run(session) {
          const value = await new NativeProbe(session, "native-print", "PROBE ")
            .script(`import io
output = io.StringIO()
print('left', 'right', sep='|', end='!', file=output, flush=True)
assert output.getvalue() == 'left|right!'
print('PROBE ' + json.dumps(dict(value=7, nested=[True, None])))`);
          assert.deepEqual(value, { value: 7, nested: [true, null] });
        },
      },
    ],
    directory,
    1,
  );
  assert.equal(report?.status, "passed", report?.error);
  assert.equal(report.cleanup, "complete");
});

test("compiled native wrapper still executes the retained entry point and captures its result", async (t) => {
  const { backend, directory } = await fixture(t);
  const [report] = await runScenarios(
    backend,
    [
      {
        id: "native-probe-compiled-envelope",
        requires: ["documents"],
        scope: "exclusive-instance",
        async run(session) {
          const probe = new NativeProbe(session, "native-compiled", "PROBE ");
          const value = await probe.compiled("document.status");
          assert.equal(value["operation"], "document.status");
          assert.equal(value["document"], session.document.name);
          assert.equal(probe.methods.length, 1);
          assert.equal(probe.observations.length, 1);
        },
      },
    ],
    directory,
    1,
  );
  assert.equal(report?.status, "passed", report?.error);
  assert.equal(report.cleanup, "complete");
});

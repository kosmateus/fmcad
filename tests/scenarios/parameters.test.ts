import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fixture, remaining } from "./test-support";
import { simulatorFolder, type PythonSimulator } from "./simulator";
import { parameterScenarios } from "./parameter-cases";
import { runScenarios } from "./runner";
import { record } from "./contracts";
import * as programs from "./programs";
import { parse } from "./cli";

const root = path.resolve(__dirname, "../../..");
const load = createRequire(path.join(root, "package.json"));
const { pythonLiteral } = load(
  "./src/python",
) as typeof import("../../packages/node-adapters/src/python/artifact");
const historical = fs.readFileSync(
  path.join(root, "tests/fixtures/history/parameters-a26222f.py.txt"),
  "utf8",
);
const current =
  fs.readFileSync(
    path.join(root, "runtime/python/fmcad/adapters/fusion/legacy_document.py"),
    "utf8",
  ) +
  "\n" +
  fs.readFileSync(
    path.join(
      root,
      "runtime/python/fmcad/adapters/fusion/legacy_parameters.py",
    ),
    "utf8",
  );

for (const protocol of ["mcp", "addin"] as const) {
  for (const concurrency of [1, 2, 10]) {
    test(`parameter contracts and saved cleanup via ${protocol}, concurrency ${concurrency}`, async (t) => {
      const { directory, model, backend } = await fixture(t, protocol);
      const reports = await runScenarios(
        backend,
        parameterScenarios(simulatorFolder),
        directory,
        concurrency,
      );
      assert.equal(reports.length, 4);
      for (const report of reports) {
        assert.equal(report.status, "passed", JSON.stringify(report));
        assert.equal(report.cleanup, "complete");
      }
      assert.deepEqual(await remaining(model), { active: null, documents: [] });
    });
  }
}

async function execute(
  model: PythonSimulator,
  source: string,
  operation: string,
  args: string[],
) {
  const patched = source
    .replace('OP = "help"', () => "OP = " + pythonLiteral(operation))
    .replace(
      /ARGS(?:: list\[str\])? = \[\]/,
      () => "ARGS: list[str] = " + pythonLiteral(args),
    )
    .replace(
      /def run\(_context: str\)(?: -> None)?:/,
      "def _legacy_run(_context: str) -> None:",
    );
  const result = await model.execute(
    patched +
      "\n" +
      programs.program(`import contextlib, io, json
output = io.StringIO()
failure = None
with contextlib.redirect_stdout(output):
    try:
        _legacy_run('')
    except Exception as error:
        failure = type(error).__name__ + ': ' + str(error)
app = adsk.core.Application.get()
documents = [dict(name=d.name, parameters=[dict(name=p.name, expression=p.expression, value=p.value, unit=p.unit, comment=p.comment) for p in d.products.product.userParameters]) for d in app.documents]
print(json.dumps(dict(output=output.getvalue(), error=failure, documents=documents)))`),
  );
  assert.equal(result.success, true, result.error);
  return record(JSON.parse(result.stdout));
}
async function create(model: PythonSimulator) {
  const result = await model.execute(
    programs.program(`import adsk.core
app = adsk.core.Application.get()
doc = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
doc.name = 'Model'`),
  );
  assert.equal(result.success, true, result.error);
}

test("historical parameter fixture is the pre-migration source", () => {
  const metadata = record(
    JSON.parse(
      fs.readFileSync(
        path.join(root, "tests/fixtures/history/parameters-a26222f.json"),
        "utf8",
      ),
    ),
  );
  assert.equal(metadata["commit"], "a26222ff617b0e9597b2a91b50474bdca8d0a0ce");
  assert.equal(
    createHash("sha256").update(historical).digest("hex"),
    metadata["sha256"],
  );
});

test("historical CRUD, inferred units and missing-name failures retain output and effects", async (t) => {
  const before = await fixture(t),
    after = await fixture(t);
  await create(before.model);
  await create(after.model);
  for (const [operation, args] of [
    [
      "param_add",
      ["migration_width", "10 mm", "mm", "live migration test", "Model"],
    ],
    ["param_list", ["Model"]],
    ["param_set", ["migration_width", "20 mm", "Model"]],
    ["param_rename", ["migration_width", "migration_width_renamed", "Model"]],
    ["param_list", ["Model"]],
    ["param_delete", ["migration_width_renamed", "Model"]],
    ["param_list", ["Model"]],
    ["param_add", ["width", "1 in", "", "", "Model"]],
    ["param_add", ["height", "width * 2", "", "", "Model"]],
    ["param_add", ["width", "999 mm", "mm", "ignore", "Model"]],
    ["param_set", ["absent", "3 mm", "Model"]],
    ["param_rename", ["absent", "newName", "Model"]],
    ["param_delete", ["absent", "Model"]],
  ] as const) {
    const a = await execute(before.model, historical, operation, [...args]);
    const b = await execute(after.model, current, operation, [...args]);
    assert.deepEqual(b, a, operation);
    assert.equal(b["error"], null);
  }
});

test("delete success without absence is an inherited false success, corrected without replay", async (t) => {
  for (const [source, expectDeleted] of [
    [historical, true],
    [current, false],
  ] as const) {
    const { model } = await fixture(t);
    await create(model);
    await execute(model, source, "param_add", [
      "width",
      "10 mm",
      "mm",
      "",
      "Model",
    ]);
    await execute(model, source, "param_add", [
      "height",
      "width * 2",
      "mm",
      "",
      "Model",
    ]);
    const result = await execute(model, source, "param_delete", [
      "width",
      "Model",
    ]);
    assert.equal(
      String(result["output"]).includes("DELETED_PARAM"),
      expectDeleted,
    );
    assert.equal(
      String(result["output"]).includes("ERROR param_delete"),
      !expectDeleted,
    );
    const docs = result["documents"] as { parameters: unknown[] }[];
    assert.equal(docs[0]?.parameters.length, 2);
    const calls = await model.execute(
      programs.program(`import adsk.core
assert adsk.core.Application.get().activeProduct.userParameters.itemByName('width').model_delete_calls == 1`),
    );
    assert.equal(calls.success, true, calls.error);
  }
});

for (const fault of [
  "duplicate-name",
  "activation-false",
  "wrong-active",
] as const) {
  test(`historical wrong-document mutation is blocked: ${fault}`, async (t) => {
    for (const [source, safe] of [
      [historical, false],
      [current, true],
    ] as const) {
      const { model } = await fixture(t);
      const setup = await model.execute(
        programs.program(`import adsk.core
app = adsk.core.Application.get()
target = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
target.name = 'Model'
foreign = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
foreign.name = ${pythonLiteral(fault === "duplicate-name" ? "MODEL" : "Foreign")}
${fault === "activation-false" ? "target.activate = lambda: False" : fault === "wrong-active" ? "target.activate = lambda: True" : ""}`),
      );
      assert.equal(setup.success, true, setup.error);
      const result = await execute(model, source, "param_add", [
        "unsafe",
        "10 mm",
        "mm",
        "",
        "Model",
      ]);
      assert.equal(result["error"], null);
      const docs = result["documents"] as { parameters: unknown[] }[];
      assert.equal(
        docs.reduce((n, d) => n + d.parameters.length, 0),
        safe ? 0 : 1,
      );
      assert.equal(String(result["output"]).startsWith("ERROR "), safe);
    }
  });
}

test("parameter suite uses an explicit native folder and remains in all", () => {
  assert.equal(parse(["--suite", "parameters"]).suite, "parameters");
  assert.equal(parse([]).suite, "all");
  assert.throws(
    () => parse(["--backend", "fusion", "--run", "--suite", "parameters"]),
    /project-id/,
  );
});

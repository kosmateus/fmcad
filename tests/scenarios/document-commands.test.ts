import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { fixture, remaining } from "./test-support";
import { simulatorFolder, type PythonSimulator } from "./simulator";
import { runScenarios } from "./runner";
import { documentScenarios } from "./document-cases";
import { record } from "./contracts";
import * as programs from "./programs";

const root = path.resolve(__dirname, "../../..");
const load = createRequire(path.join(root, "package.json"));
const { pythonLiteral } = load(
  "./src/python",
) as typeof import("../../packages/node-adapters/src/python/artifact");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const common = read("runtime/python/fmcad/adapters/fusion/legacy_document.py");
const sources = {
  plane: [
    read("tests/fixtures/history/parameters-a26222f.py.txt"),
    common + read("runtime/python/fmcad/adapters/fusion/legacy_planes.py"),
  ],
  component: [
    read("tests/fixtures/history/component-a26222f.py.txt"),
    common + read("runtime/python/fmcad/adapters/fusion/legacy_components.py"),
  ],
  inspect: [
    read("tests/fixtures/history/inspect-a262.py.txt"),
    common + read("runtime/python/fmcad/adapters/fusion/legacy_inspect.py"),
  ],
} as const;

for (const protocol of ["mcp", "addin"] as const) {
  for (const concurrency of [1, 2, 10]) {
    test(`document contracts and cleanup via ${protocol}, concurrency ${concurrency}`, async (t) => {
      const { directory, model, backend } = await fixture(t, protocol);
      const reports = await runScenarios(
        backend,
        documentScenarios(simulatorFolder),
        directory,
        concurrency,
      );
      assert.equal(reports.length, 3);
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
  const prepared = source
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
    prepared +
      "\n" +
      programs.program(`import contextlib, io, json
output = io.StringIO()
failure = None
with contextlib.redirect_stdout(output):
    try:
        _legacy_run('')
    except Exception as error:
        failure = type(error).__name__ + ': ' + str(error)
docs = []
for document in adsk.core.Application.get().documents:
    design = document.products.product
    components = []
    def visit(component, parent):
        components.append(dict(name=component.name, parent=parent))
        for occurrence in component.occurrences:
            visit(occurrence.component, component.name)
    visit(design.rootComponent, None)
    docs.append(dict(name=document.name, components=components,
        planes=[dict(name=p.name, origin=p.geometry.origin.asArray(), normal=p.geometry.normal.asArray()) for p in design.rootComponent.constructionPlanes],
        units=design.unitsManager.defaultLengthUnits, marker=design.timeline.markerPosition))
print(json.dumps(dict(output=output.getvalue(), error=failure, documents=docs)))`),
  );
  assert.equal(result.success, true, result.error);
  return record(JSON.parse(result.stdout));
}

test("component baseline retains the pre-migration source hash", () => {
  const metadata = record(
    JSON.parse(read("tests/fixtures/history/component-a26222f.json")),
  );
  assert.equal(metadata["commit"], "a26222ff617b0e9597b2a91b50474bdca8d0a0ce");
  assert.equal(
    createHash("sha256").update(sources.component[0]).digest("hex"),
    metadata["sha256"],
  );
});

test("historical plane, component and unit commands preserve their output and observed state", async (t) => {
  const before = await fixture(t),
    after = await fixture(t);
  for (const { model } of [before, after]) {
    const setup = await model.execute(
      programs.program(`import adsk.core
doc = adsk.core.Application.get().documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
doc.name = 'Model'`),
    );
    assert.equal(setup.success, true, setup.error);
  }
  for (const [family, operation, args] of [
    [
      "plane",
      "plane_add",
      ["MigrationOffset", "offset", "XY", "10 mm", "Model"],
    ],
    ["plane", "plane_list", ["Model"]],
    [
      "plane",
      "plane_add",
      ["MigrationMid", "mid", "XY", "MigrationOffset", "Model"],
    ],
    ["plane", "plane_rename", ["MigrationMid", "MigrationMidRenamed", "Model"]],
    ["plane", "plane_delete", ["MigrationMidRenamed", "Model"]],
    [
      "plane",
      "plane_add",
      ["MigrationAngle", "angle", "XY", "X", "30 deg", "Model"],
    ],
    ["plane", "plane_add", ["Rejected", "offset", "Absent", "10 mm", "Model"]],
    [
      "plane",
      "plane_add",
      ["MigrationOffset", "offset", "XY", "999 mm", "Model"],
    ],
    ["component", "comp_add", ["MigrationComponent", "Model"]],
    ["component", "comp_add", ["Child", "MigrationComponent", "Model"]],
    ["component", "comp_list", ["Model"]],
    ["component", "comp_add", ["Child", "Model"]],
    ["component", "comp_add", ["Rejected", "Missing", "Model"]],
    ["inspect", "units", ["cm", "Model"]],
    ["inspect", "units", ["mm", "Model"]],
    ["inspect", "units", ["in", "Model"]],
    ["inspect", "units", ["unsupported", "Model"]],
  ] as const) {
    const a = await execute(before.model, sources[family][0], operation, [
      ...args,
    ]);
    const b = await execute(after.model, sources[family][1], operation, [
      ...args,
    ]);
    assert.deepEqual(b, a, operation);
    assert.equal(b["error"], null);
  }
});

for (const family of ["plane", "component"] as const) {
  for (const fault of [
    "duplicate-name",
    "activation-false",
    "wrong-active",
  ] as const) {
    test(`${family} rejects inherited wrong-document mutation: ${fault}`, async (t) => {
      for (const index of [0, 1] as const) {
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
        const args =
          family === "plane"
            ? ["Unsafe", "offset", "XY", "10 mm", "Model"]
            : ["Unsafe", "Model"];
        const result = await execute(
          model,
          sources[family][index],
          family === "plane" ? "plane_add" : "comp_add",
          args,
        );
        assert.equal(result["error"], null);
        const docs = result["documents"] as {
          planes: unknown[];
          components: unknown[];
        }[];
        const changes = docs.reduce(
          (n, d) =>
            n +
            (family === "plane" ? d.planes.length : d.components.length - 1),
          0,
        );
        assert.equal(changes, index === 0 ? 1 : 0);
        assert.equal(
          String(result["output"]).startsWith("ERROR "),
          index === 1,
        );
      }
    });
  }
}

test("broker snapshots observe modeled edits without changing foreign documents", async (t) => {
  const { model } = await fixture(t);
  const source =
    read("runtime/python/fmcad/adapters/fusion/identity.py") +
    "\n" +
    read("runtime/python/fmcad/adapters/fusion/legacy_queue_document.py");
  const result = await model.execute(
    source +
      "\n" +
      programs.program(`import adsk.core, json
app = adsk.core.Application.get()
target = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
foreign = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
design = target.products.product
selector = dict(creationId=target.creationId)
foreign_selector = dict(creationId=foreign.creationId)
before_foreign = _qd_capture(app, foreign_selector)
def capture():
    snapshot = _qd_capture(app, selector)
    assert snapshot['status'] == 'complete', snapshot
    assert snapshot == _qd_capture(app, selector), 'Read-only probes must be stable'
    assert _qd_capture(app, foreign_selector) == before_foreign
    assert app.activeDocument is foreign, 'Snapshot must not activate the target'
    return snapshot['fingerprint']
fingerprints = [capture()]
plane_input = design.rootComponent.constructionPlanes.createInput()
assert plane_input.setByOffset(design.rootComponent.xYConstructionPlane, adsk.core.ValueInput.createByString('10 mm'))
plane = design.rootComponent.constructionPlanes.add(plane_input)
fingerprints.append(capture())
plane.name = 'Renamed'
fingerprints.append(capture())
child = design.rootComponent.occurrences.addNewComponent(adsk.core.Matrix3D.create())
fingerprints.append(capture())
child.component.name = 'Child'
fingerprints.append(capture())
design.unitsManager.distanceDisplayUnits = adsk.fusion.DistanceUnits.InchDistanceUnits
fingerprints.append(capture())
print(json.dumps(fingerprints))`),
  );
  assert.equal(result.success, true, result.error);
  const fingerprints = JSON.parse(result.stdout) as string[];
  assert.equal(fingerprints.length, 6);
  assert.equal(new Set(fingerprints).size, fingerprints.length);
});

for (const kind of [
  "duplicate-parent",
  "root-collision",
  "duplicate-existing",
] as const) {
  test(`historical component ambiguity is rejected before mutation: ${kind}`, async (t) => {
    for (const index of [0, 1] as const) {
      const { model } = await fixture(t);
      const setup = await model.execute(
        programs.program(`import adsk.core
app = adsk.core.Application.get()
doc = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
doc.name = 'Model'
root = doc.products.product.rootComponent
root.name = 'Root'
for index in range(2):
    occurrence = root.occurrences.addNewComponent(adsk.core.Matrix3D.create())
    occurrence.component.name = ${pythonLiteral(kind === "root-collision" ? "Root" : "Duplicate")}
`),
      );
      assert.equal(setup.success, true, setup.error);
      const before = await execute(
        model,
        sources.component[index],
        "comp_list",
        ["Model"],
      );
      const args =
        kind === "duplicate-existing"
          ? ["Duplicate", "Model"]
          : [
              "UnsafeChild",
              kind === "root-collision" ? "Root" : "Duplicate",
              "Model",
            ];
      const result = await execute(
        model,
        sources.component[index],
        "comp_add",
        args,
      );
      if (index === 0) {
        assert.equal(result["error"], null);
        assert.match(
          String(result["output"]),
          kind === "duplicate-existing"
            ? /EXISTS name=Duplicate/
            : /CREATED_COMP name=UnsafeChild/,
        );
        if (kind !== "duplicate-existing")
          assert.notDeepEqual(result["documents"], before["documents"]);
      } else {
        assert.match(String(result["error"]), /ambiguous component name/);
        assert.deepEqual(result["documents"], before["documents"]);
        assert.doesNotMatch(
          String(result["output"]),
          /CREATED_COMP|EXISTS |DONE/,
        );
      }
    }
  });
}

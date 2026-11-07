import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { program, guard, emit } from "./programs";
import { record } from "./contracts";
import assert from "node:assert/strict";
import { fixture, remaining } from "./test-support";
import { simulatorFolder } from "./simulator";
import { runScenarios } from "./runner";
import {
  createSketch,
  rectangle,
  sketchReadback,
  sketchScenarios,
  coordinateExpectations,
} from "./sketch-cases";
import { cadCommand } from "./cad-programs";

for (const protocol of ["mcp", "addin"] as const) {
  for (const concurrency of [1, 2, 10]) {
    test(`owned rectangular sketches via ${protocol}, concurrency ${concurrency}`, async (t) => {
      const { directory, model, backend } = await fixture(t, protocol);
      const reports = await runScenarios(
        backend,
        sketchScenarios(simulatorFolder),
        directory,
        concurrency,
      );
      for (const report of reports) {
        assert.equal(report.status, "passed", JSON.stringify(report));
        assert.equal(report.cleanup, "complete");
      }
      assert.deepEqual(await remaining(model), { active: null, documents: [] });
    });
  }
}

test("invalid rectangle input leaves the empty sketch unchanged", async (t) => {
  const { directory, model, backend } = await fixture(t);
  const reports = await runScenarios(
    backend,
    [
      {
        ...sketchScenarios(simulatorFolder, 1)[0]!,
        async run(session) {
          const ref = await createSketch(session);
          for (const [width, height] of [
            [0, 20],
            [10, 0],
          ]) {
            const result = await session.execute(
              "degenerate",
              cadCommand(
                session.document,
                "sketch.geometry",
                rectangle(ref, width, height),
              ),
              session.document,
              "cad-v1",
            );
            assert.match(String(result["error"]), /nonzero width and height/);
            assert.equal(result["result"], null);
            const readback = await sketchReadback(session, ref);
            assert.equal(readback["profiles"], 0);
            assert.deepEqual(readback["lines"], []);
          }
        },
      },
    ],
    directory,
    1,
  );
  assert.equal(reports[0]?.status, "passed", JSON.stringify(reports));
  assert.equal(reports[0]?.cleanup, "complete");
  assert.deepEqual(await remaining(model), { active: null, documents: [] });
});

test("coordinate proof rejects an entity from another sketch in the same owned document", async (t) => {
  const { directory, model, backend } = await fixture(t);
  const reports = await runScenarios(
    backend,
    [
      {
        ...sketchScenarios(simulatorFolder, 1)[0]!,
        async run(session) {
          const first = await createSketch(session);
          const second = await createSketch(session);
          const created = await session.execute(
            "rectangle",
            cadCommand(session.document, "sketch.geometry", rectangle(second)),
            session.document,
            "cad-v1",
          );
          assert.equal(created["error"], null, JSON.stringify(created));
          const refs = record(record(created["result"])["refs"])["outline"];
          assert.ok(Array.isArray(refs));
          const before = await sketchReadback(session, second);
          const result = await session.execute(
            "foreign-curve",
            cadCommand(session.document, "sketch.coordinate-check", {
              schemaVersion: 1,
              sketch: first,
              expectations: coordinateExpectations(record(refs[1]), 10, 20),
            }),
            session.document,
            "cad-v1",
          );
          assert.match(
            String(result["error"]),
            /entity belongs to a different sketch/,
          );
          assert.equal(result["result"], null);
          assert.deepEqual(await sketchReadback(session, second), before);
          assert.deepEqual((await sketchReadback(session, first))["lines"], []);
        },
      },
    ],
    directory,
    1,
  );
  assert.equal(reports[0]?.status, "passed", JSON.stringify(reports));
  assert.equal(reports[0]?.cleanup, "complete");
  assert.deepEqual(await remaining(model), { active: null, documents: [] });
});

test("model coordinate transforms copy points and refuse unmodeled assembly and plane frames", async (t) => {
  const { model } = await fixture(t);
  const result = await model.execute(
    program(`import adsk.core, adsk.fusion, json
app = adsk.core.Application.get()
doc = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
try:
    design = adsk.fusion.Design.cast(doc.products.itemByProductType('DesignProductType'))
    assert design is not None
    root = design.rootComponent
    sketch = root.sketches.addWithoutEdges(root.xYConstructionPlane)
    point = adsk.core.Point3D.create(1, 2, 0)
    model_point = sketch.sketchToModelSpace(point)
    roundtrip = sketch.modelToSketchSpace(model_point)
    assert roundtrip.asArray() == [1, 2, 0]
    model_point.x, roundtrip.y = 8, 9
    assert point.asArray() == [1, 2, 0]
    lines = sketch.sketchCurves.sketchLines.addTwoPointRectangle(adsk.core.Point3D.create(0,0,0), point)
    endpoint = lines.item(1).endSketchPoint
    world = endpoint.worldGeometry
    world.x = 99
    assert endpoint.geometry.asArray() == [1, 2, 0]
    child = root.occurrences.addNewComponent(adsk.core.Matrix3D.create()).component
    child_sketch = child.sketches.addWithoutEdges(child.xYConstructionPlane)
    plane_input = root.constructionPlanes.createInput()
    assert plane_input.setByOffset(root.xYConstructionPlane, adsk.core.ValueInput.createByReal(1))
    plane = root.constructionPlanes.add(plane_input)
    offset_sketch = root.sketches.addWithoutEdges(plane)
    rejected = 0
    for unsupported in [child_sketch, offset_sketch]:
        try:
            unsupported.sketchToModelSpace(point)
        except NotImplementedError:
            rejected += 1
        else:
            raise AssertionError('Unmodeled frame accepted')
    ${emit("dict(rejected=rejected)")}
finally:
    doc.close(False)`),
  );
  assert.equal(result.success, true, result.error);
  assert.match(result.stdout, /"rejected": 2/);
  assert.deepEqual(await remaining(model), { active: null, documents: [] });
});

for (const kind of ["operation", "assertion"]) {
  test(`sketch ${kind} failure still closes and removes its saved fixture`, async (t) => {
    const { directory, model, backend } = await fixture(t);
    const reports = await runScenarios(
      backend,
      [
        {
          ...sketchScenarios(simulatorFolder, 1)[0]!,
          async run(session) {
            await createSketch(session);
            if (kind === "assertion") assert.fail("Injected sketch assertion");
            await session.execute(
              "injected-error",
              "def run(_context: str) -> None:\n    raise RuntimeError('Injected sketch operation')\n",
            );
          },
        },
      ],
      directory,
      1,
    );
    assert.equal(reports[0]?.status, "failed");
    assert.match(reports[0]?.error ?? "", /Injected sketch/);
    assert.equal(reports[0]?.cleanup, "complete");
    assert.deepEqual(await remaining(model), { active: null, documents: [] });
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
test("foreign sketch tokens cannot route rectangle creation into another fixture", async (t) => {
  const { directory, model, backend } = await fixture(t);
  const refs = [
    deferred<Record<string, unknown> | null>(),
    deferred<Record<string, unknown> | null>(),
  ];
  const attempted = [deferred<void>(), deferred<void>()];
  const scenarios = sketchScenarios(simulatorFolder).map((scenario, index) => ({
    ...scenario,
    async run(session: Parameters<typeof scenario.run>[0]) {
      try {
        const own = await createSketch(session);
        refs[index]!.resolve(own);
        const foreign = await refs[1 - index]!.promise;
        assert.ok(foreign, "other fixture could not be created");
        const result = await session.execute(
          "foreign-sketch",
          cadCommand(session.document, "sketch.geometry", rectangle(foreign)),
          session.document,
          "cad-v1",
        );
        assert.match(
          String(result["error"]),
          /Entity token: expected one match, found 0/,
        );
        assert.equal(result["result"], null);
        attempted[index]!.resolve();
        await attempted[1 - index]!.promise;
        const unchanged = await sketchReadback(session, own);
        assert.equal(unchanged["profiles"], 0);
        assert.deepEqual(unchanged["lines"], []);
      } finally {
        refs[index]!.resolve(null);
        attempted[index]!.resolve();
      }
    },
  }));
  const reports = await runScenarios(backend, scenarios, directory, 2);
  for (const report of reports) {
    assert.equal(report.status, "passed", JSON.stringify(report));
    assert.equal(report.cleanup, "complete");
  }
  assert.deepEqual(await remaining(model), { active: null, documents: [] });
});

test("pre-refactor and current sketch handlers preserve rectangle refs and profile geometry", async (t) => {
  const root = path.resolve(__dirname, "../../..");
  const metadata = JSON.parse(
    fs.readFileSync(
      path.join(root, "tests/fixtures/history/manifest.json"),
      "utf8",
    ),
  ) as Array<{ file: string; sha256: string }>;
  const source = fs.readFileSync(
    path.join(root, "tests/fixtures/history/model-a262.py.txt"),
    "utf8",
  );
  assert.equal(
    createHash("sha256").update(source).digest("hex"),
    metadata.find((item) => item.file === "model-a262.py.txt")?.sha256,
  );
  const { prepareCadBundle } = createRequire(path.join(root, "package.json"))(
    "./src/python",
  ) as typeof import("../../packages/node-adapters/src/python/bundle");
  const observations: unknown[] = [];
  for (const historical of [true, false]) {
    const { directory, model, backend } = await fixture(t);
    const reports = await runScenarios(
      backend,
      [
        {
          ...sketchScenarios(simulatorFolder, 1)[0]!,
          async run(session) {
            const observed = await session.execute(
              "paired-rectangle",
              prepareCadBundle(
                root,
                (historical
                  ? source.slice(0, source.indexOf("\nCAD_HANDLERS.update")) +
                    "\n"
                  : "") +
                  program(`${guard(session.document)}
ctx = CadContext(doc.name, 'root', doc_id=doc.creationId)
_ = design.userParameters.add('rect_width', adsk.core.ValueInput.createByString('12 mm'), 'mm', '')
_ = design.userParameters.add('rect_height', adsk.core.ValueInput.createByString('24 mm'), 'mm', '')
created = model_sketch_create(ctx, dict(name='Paired rectangle', plane='XY'))
ref = created['sketch']
geometry = ${historical ? "model_sketch_geometry" : "sketch_geometry"}(ctx, dict(sketch=ref, geometry=[dict(type='rectangle', name='outline', start=['0 mm','0 mm','0 mm'], end=['rect_width','rect_height','0 mm'])]))
sketch = ctx.resolve(ref, 'sketch')
lines = sketch.sketchCurves.sketchLines
coordinates = [[lines.item(i).startSketchPoint.geometry.asArray(), lines.item(i).endSketchPoint.geometry.asArray()] for i in range(lines.count)]
refs = geometry['refs']['outline']
${emit("dict(creationId=doc.creationId, profiles=sketch.profiles.count, name=sketch.name, kinds=[r['kind'] for r in refs], resolvable=[len(design.findEntityByToken(r['token'])) == 1 for r in refs], coordinates=coordinates)")}`),
              ).script,
            );
            const { creationId, ...geometry } = observed;
            assert.equal(creationId, session.document.creationId);
            observations.push(geometry);
          },
        },
      ],
      directory,
      1,
    );
    assert.equal(reports[0]?.status, "passed", JSON.stringify(reports));
    assert.equal(reports[0]?.cleanup, "complete");
    assert.deepEqual(await remaining(model), { active: null, documents: [] });
  }
  assert.deepEqual(observations[1], observations[0]);
  const result = record(observations[0]);
  assert.equal(result["profiles"], 1);
  assert.deepEqual(result["resolvable"], [true, true, true, true]);
  assert.deepEqual(result["kinds"], [
    "SketchLine",
    "SketchLine",
    "SketchLine",
    "SketchLine",
  ]);
});

test("model rectangle bounds fail explicitly and copied inputs cannot mutate the profile", async (t) => {
  const { model } = await fixture(t);
  const result = await model.execute(
    program(`import adsk.core, adsk.fusion, json
app = adsk.core.Application.get()
doc = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
try:
    design = adsk.fusion.Design.cast(doc.products.itemByProductType('DesignProductType'))
    assert design is not None
    component = design.rootComponent
    rejected = 0
    try:
        component.sketches.addWithoutEdges(component.xZConstructionPlane)
    except NotImplementedError:
        rejected += 1
    else:
        raise AssertionError('Unsupported plane accepted')
    sketch = component.sketches.addWithoutEdges(component.xYConstructionPlane)
    start, end = adsk.core.Point3D.create(0, 0, 0), adsk.core.Point3D.create(1, 2, 0)
    lines = sketch.sketchCurves.sketchLines.addTwoPointRectangle(start, end)
    start.x, end.y = 99, 99
    assert lines.item(0).startSketchPoint.geometry.x == 0
    assert lines.item(1).endSketchPoint.geometry.y == 2
    for action in ['overlap', 'fixed', 'construction']:
        try:
            if action == 'overlap':
                sketch.sketchCurves.sketchLines.addTwoPointRectangle(adsk.core.Point3D.create(0,0,0), adsk.core.Point3D.create(3,3,0))
            elif action == 'fixed':
                lines.item(0).isFixed = True
            else:
                lines.item(0).isConstruction = True
        except NotImplementedError:
            rejected += 1
        else:
            raise AssertionError('Unsupported sketch edit accepted')
    token = lines.item(0).startSketchPoint.entityToken
    assert len(design.findEntityByToken(token)) == 1
    assert sketch.profiles.count == 1 and sketch.sketchCurves.sketchLines.count == 4
    manager = design.unitsManager
    assert manager.isValidExpression('10 mm', 'cm')
    assert not manager.isValidExpression('10 deg', 'cm')
    assert not manager.isValidExpression('10 mm', 'cm/cm')
    assert manager.isValidExpression('4 / 2', 'cm/cm')
    assert manager.evaluateExpression('10 mm', 'cm') == 1
    ${emit("dict(rejected=rejected)")}
finally:
    doc.close(False)
assert design.findEntityByToken(token) == []`),
  );
  assert.equal(result.success, true, result.error);
  assert.match(result.stdout, /"rejected": 4/);
  assert.deepEqual(await remaining(model), { active: null, documents: [] });
});

import assert from "node:assert/strict";
import type { Scenario, ScenarioSession } from "./runner";
import { record, text, type FixtureFolder } from "./contracts";
import { cadCommand } from "./cad-programs";
import { program, guard, emit } from "./programs";

export async function createSketch(
  session: ScenarioSession,
): Promise<Record<string, unknown>> {
  const result = await session.execute(
    "create-sketch",
    cadCommand(session.document, "sketch.create", {
      name: "Shared rectangle",
      plane: "XY",
    }),
    session.document,
    "cad-v1",
  );
  assert.equal(result["error"], null, JSON.stringify(result));
  const ref = record(record(result["result"])["sketch"]);
  assert.equal(ref["kind"], "sketch");
  text(ref["token"]);
  return ref;
}
export function rectangle(
  ref: Record<string, unknown>,
  width = 10,
  height = 20,
) {
  return {
    sketch: ref,
    geometry: [
      {
        type: "rectangle",
        name: "outline",
        start: ["0 mm", "0 mm", "0 mm"],
        end: [`${width} mm`, `${height} mm`, "0 mm"],
      },
    ],
  };
}
export async function sketchReadback(
  session: ScenarioSession,
  ref: Record<string, unknown>,
) {
  return session.execute(
    "sketch-readback",
    program(`${guard(session.document)}
entities = design.findEntityByToken(${JSON.stringify(ref["token"])})
assert len(entities) == 1
sketch = cast(adsk.fusion.Sketch, entities[0])
assert sketch.parentComponent == design.rootComponent
lines = sketch.sketchCurves.sketchLines
coordinates: list[list[list[float]]] = []
for i in range(lines.count):
    line = lines.item(i)
    coordinates.append([line.startSketchPoint.geometry.asArray(), line.endSketchPoint.geometry.asArray()])
${emit("dict(creationId=doc.creationId, name=sketch.name, profiles=sketch.profiles.count, lines=coordinates)")}`),
  );
}

export function coordinateExpectations(
  ref: Record<string, unknown>,
  width: number,
  height: number,
) {
  return ["sketch", "model", "world"].map((frame) => ({
    entity: ref,
    frame,
    start: [`${width} mm`, "0 mm", "0 mm"],
    end: [`${width} mm`, `${height} mm`, "0 mm"],
  }));
}

export function assertCoordinateProof(
  value: Record<string, unknown>,
  count: number,
): void {
  assert.equal(value["status"], "pass");
  assert.equal(value["geometryStatus"], "pass");
  assert.equal(value["healthStatus"], "pass");
  const entities = record(value["analytic"])["entities"];
  assert.ok(Array.isArray(entities));
  assert.equal(entities.length, count);
  for (const item of entities) {
    const entity = record(item);
    assert.equal(entity["status"], "pass");
    const checks = entity["checks"];
    assert.ok(Array.isArray(checks));
    assert.equal(checks.length, 6);
    for (const check of checks) assert.equal(record(check)["status"], "pass");
  }
}

export function sketchScenarios(folder: FixtureFolder, owners = 2): Scenario[] {
  return Array.from({ length: owners }, (_, index): Scenario => ({
    id: "sketch-" + index,
    fixture: folder,
    requires: [
      "documents",
      "saved-fixtures",
      "rectangular-sketch",
      "sketch-coordinate-proof",
    ],
    async run(session) {
      const ref = await createSketch(session);
      const width = 10 + index,
        height = 20 + index;
      const result = await session.execute(
        "rectangle",
        cadCommand(
          session.document,
          "sketch.geometry",
          rectangle(ref, width, height),
        ),
        session.document,
        "cad-v1",
      );
      assert.equal(result["error"], null, JSON.stringify(result));
      const value = record(result["result"]);
      assert.equal(value["success"], true);
      assert.equal(value["status"], "pass");
      assert.equal(
        record(value["documentIdentity"])["creationId"],
        session.document.creationId,
      );
      const refs = record(value["refs"])["outline"];
      assert.ok(Array.isArray(refs));
      assert.equal(refs.length, 4);
      const tokens = refs.map((line) => text(record(line)["token"]));
      assert.equal(new Set(tokens).size, 4);
      const readback = await sketchReadback(session, ref);
      assert.equal(readback["profiles"], 1);
      assert.equal(readback["name"], "Shared rectangle");
      const expected = [
        [
          [0, 0, 0],
          [width / 10, 0, 0],
        ],
        [
          [width / 10, 0, 0],
          [width / 10, height / 10, 0],
        ],
        [
          [width / 10, height / 10, 0],
          [0, height / 10, 0],
        ],
        [
          [0, height / 10, 0],
          [0, 0, 0],
        ],
      ];
      const lines = readback["lines"];
      assert.ok(Array.isArray(lines));
      assert.equal(lines.length, expected.length);
      for (const [i, line] of expected.entries()) {
        const actual: unknown = lines[i];
        assert.ok(Array.isArray(actual));
        assert.equal(actual.length, 2);
        for (const [j, point] of line.entries()) {
          const coordinates: unknown = actual[j];
          assert.ok(Array.isArray(coordinates));
          assert.equal(coordinates.length, 3);
          for (const [axis, coordinate] of point.entries()) {
            const measured: unknown = coordinates[axis];
            assert.equal(typeof measured, "number");
            assert.ok(
              typeof measured === "number" &&
                Math.abs(measured - coordinate) <= 1e-9,
            );
          }
        }
      }
      const checked = await session.execute(
        "coordinate-proof",
        cadCommand(session.document, "sketch.coordinate-check", {
          schemaVersion: 1,
          sketch: ref,
          tolerance: "0.001 mm",
          expectations: coordinateExpectations(record(refs[1]), width, height),
        }),
        session.document,
        "cad-v1",
      );
      assert.equal(checked["error"], null, JSON.stringify(checked));
      const proof = record(checked["result"]);
      assertCoordinateProof(proof, 3);
      assert.equal(
        record(proof["documentIdentity"])["creationId"],
        session.document.creationId,
      );
      assert.deepEqual(await sketchReadback(session, ref), readback);
      const mismatch = await session.execute(
        "coordinate-mismatch",
        cadCommand(session.document, "sketch.coordinate-check", {
          schemaVersion: 1,
          sketch: ref,
          tolerance: "0.001 mm",
          expectations: coordinateExpectations(
            record(refs[1]),
            width,
            height + 1,
          ),
        }),
        session.document,
        "cad-v1",
      );
      assert.equal(mismatch["error"], null, JSON.stringify(mismatch));
      const failedProof = record(mismatch["result"]);
      assert.equal(failedProof["status"], "fail");
      assert.equal(failedProof["success"], false);
      assert.equal(failedProof["geometryStatus"], "fail");
      assert.deepEqual(await sketchReadback(session, ref), readback);
    },
  }));
}

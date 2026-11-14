import assert from "node:assert/strict";
import type { Scenario } from "./runner";
import { number, record, type FixtureFolder, type Document } from "./contracts";
import { cadCommand } from "./cad-programs";
import { emit, guard, program } from "./programs";

function observed(document: Document): string {
  return program(`${guard(document)}
${emit("dict(creationId=doc.creationId, modified=doc.isModified, bodies=design.rootComponent.bRepBodies.count, sketches=design.rootComponent.sketches.count, parameters=design.userParameters.count, timeline=design.timeline.count)")}`);
}
const near = (actual: unknown, expected: number) =>
  assert.ok(Math.abs(number(actual) - expected) <= 1e-9);
export function animationScenarios(
  folder: FixtureFolder,
  owners = 2,
): Scenario[] {
  return Array.from({ length: owners }, (_, index): Scenario => ({
    id: "animation-plan-" + index,
    fixture: folder,
    requires: ["documents", "saved-fixtures", "animation-sequence"],
    async run(session) {
      const before = await session.execute(
        "animation-before",
        observed(session.document),
      );
      const input = {
        schemaVersion: 1,
        tracks: [
          {
            type: "camera",
            phase: "camera-move",
            from: {
              eye: ["0 cm", "0 cm", "30 cm"],
              target: ["0 cm", "0 cm", "0 cm"],
              up: [0, 0, 1],
            },
            to: {
              eye: ["10 cm", "0 cm", "30 cm"],
              target: ["0 cm", "0 cm", "0 cm"],
              up: [0, 0, 1],
            },
          },
        ],
        phases: ["camera-move"],
        duration: "1 s",
        fps: 2,
        easing: "linear",
      };
      const output = await session.execute(
        "animation-sequence",
        cadCommand(session.document, "animation.sequence", input),
        session.document,
        "cad-v1",
      );
      assert.equal(output["error"], null, String(output["error"]));
      const sequence = record(output["result"]);
      assert.equal(sequence["success"], true);
      assert.equal(sequence["status"], "pass");
      assert.equal(sequence["operation"], "animation.sequence");
      assert.equal(sequence["frameCount"], 3);
      assert.equal(sequence["trackCount"], 1);
      assert.equal(sequence["fps"], 2);
      assert.equal(sequence["nativeStoryboardActionsCreated"], false);
      assert.ok(Array.isArray(sequence["frames"]));
      const frames = sequence["frames"].map(record);
      assert.deepEqual(
        frames.map((frame) => frame["index"]),
        [0, 1, 2],
      );
      [0, 0.5, 1].forEach((time, i) => near(frames[i]!["timeSeconds"], time));
      [0, 5, 10].forEach((x, i) => {
        const eye = record(frames[i]!["camera"])["eye"];
        assert.ok(Array.isArray(eye));
        near(eye[0], x);
      });
      const middle = record(frames[1]!["camera"]),
        eye = middle["eye"];
      assert.ok(Array.isArray(eye));
      near(eye[2], 30);
      assert.deepEqual(middle["target"], [0, 0, 0]);
      assert.deepEqual(middle["up"], [0, 0, 1]);
      assert.deepEqual(sequence["affected"], []);
      assert.deepEqual(
        await session.execute("animation-after", observed(session.document)),
        before,
      );
      for (const [id, data, error] of [
        [
          "duration",
          { ...input, duration: "0 s" },
          /duration must be positive/u,
        ],
        ["fps", { ...input, fps: 0 }, /fps must be a positive integer/u],
        [
          "tracks",
          { ...input, tracks: [] },
          /tracks must be a nonempty array/u,
        ],
      ] as const) {
        const rejected = await session.execute(
          "animation-invalid-" + id,
          cadCommand(session.document, "animation.sequence", data),
          session.document,
          "cad-v1",
        );
        assert.match(String(rejected["error"]), error);
        assert.deepEqual(
          await session.execute(
            "animation-unchanged-" + id,
            observed(session.document),
          ),
          before,
        );
      }
    },
  }));
}

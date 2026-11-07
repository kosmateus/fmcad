import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import type { Scenario } from "./runner";
import { number, text, type Document, type FixtureFolder } from "./contracts";
import { emit, guard, program } from "./programs";
import { documentCommand } from "./document-programs";

const root = path.resolve(__dirname, "../../..");
const { buildRunScript } = createRequire(path.join(root, "package.json"))(
  "./src/run",
) as {
  buildRunScript(
    name: string,
    args: unknown,
    hasArgs: boolean,
    doc: string,
    identity: { docId: string; docFileId?: string },
  ): string;
};

const observation = `bodies = design.rootComponent.bRepBodies
volumes = [b.physicalProperties.volume * 1000 for b in bodies]
dimensions = [[(b.boundingBox.maxPoint.x-b.boundingBox.minPoint.x)*10,
               (b.boundingBox.maxPoint.y-b.boundingBox.minPoint.y)*10,
               (b.boundingBox.maxPoint.z-b.boundingBox.minPoint.z)*10] for b in bodies]
${emit("dict(creationId=doc.creationId, bodies=bodies.count, volumes=volumes, dimensions=dimensions, timelineCount=design.timeline.count, marker=design.timeline.markerPosition)")}`;

export function createBox(document: Document, size: number): string {
  // Use the shipped, identity-bound public run preparation, including its wrapper.
  const source = buildRunScript("box", [size], true, document.name, {
    docId: document.creationId,
    ...(document.file ? { docFileId: document.file.fileId } : {}),
  });
  const signature = "def run(_context: str) -> object | None:";
  if (!source.includes(signature))
    throw new Error("Unexpected public run wrapper");
  return (
    source.replace(signature, "def _box_run(_context: str) -> object | None:") +
    "\n" +
    program(`${guard(document)}
_ = _box_run("")
${observation}`)
  );
}

export function boxState(document: Document): string {
  return program(`${guard(document)}\n${observation}`);
}

function assertBox(state: Record<string, unknown>, size: number): void {
  assert.equal(state["bodies"], 1);
  const dimensions = state["dimensions"],
    volumes = state["volumes"];
  assert.ok(Array.isArray(dimensions) && dimensions.length === 1);
  assert.ok(Array.isArray(dimensions[0]) && dimensions[0].length === 3);
  for (const length of dimensions[0])
    assert.ok(Math.abs(number(length) - size) <= 1e-6);
  assert.ok(Array.isArray(volumes) && volumes.length === 1);
  assert.ok(Math.abs(number(volumes[0]) - size ** 3) <= 1e-6);
}

export function boxScenarios(folder: FixtureFolder): Scenario[] {
  return [10, 25].map((size): Scenario => ({
    id: "box-" + size,
    fixture: folder,
    requires: [
      "documents",
      "saved-fixtures",
      "fixture-export",
      "rectangular-extrusion",
    ],
    async run(session) {
      const made = await session.execute(
        "create-box",
        createBox(session.document, size),
      );
      assertBox(made, size);
      const count = number(made["timelineCount"]);
      assert.ok(count > 0);
      assert.equal(made["marker"], count);
      for (const [operation, expected] of [
        ["stats", "BODIES=1 "],
        [
          "bbox",
          `size=(${size.toFixed(1)} x ${size.toFixed(1)} x ${size.toFixed(1)}) mm`,
        ],
        ["bodies", `volume=${(size ** 3).toFixed(2)} mm3`],
      ]) {
        const result = await session.execute(
          operation!,
          documentCommand(session.document, operation!),
        );
        assert.equal(result["error"], null);
        assert.ok(text(result["output"]).includes(expected!));
        assert.doesNotMatch(text(result["output"]), /ERROR |TIMELINE_ISSUE/);
      }
      const rolled = await session.execute(
        "rollback",
        documentCommand(session.document, "rollback", [String(count - 1)]),
      );
      assert.equal(rolled["error"], null);
      assert.equal(rolled["marker"], count - 1);
      const hidden = await session.execute(
        "rolled-back-state",
        boxState(session.document),
      );
      assert.equal(hidden["bodies"], 0);
      assert.deepEqual(hidden["volumes"], []);
      const restored = await session.execute(
        "restore",
        documentCommand(session.document, "rollback", [String(count)]),
      );
      assert.equal(restored["error"], null);
      assert.equal(restored["marker"], count);
      const after = await session.execute(
        "restored-state",
        boxState(session.document),
      );
      assertBox(after, size);
      for (const field of ["creationId", "timelineCount", "marker"])
        assert.equal(after[field], made[field]);
    },
  }));
}

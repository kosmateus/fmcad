import test from "node:test";
import assert from "node:assert/strict";
import { fixture, remaining } from "./test-support";
import { simulatorFolder } from "./simulator";
import { runScenarios } from "./runner";
import { createBox } from "./box-cases";
import { guard, program, emit } from "./programs";

for (const size of [2, 37]) {
  test(`rectangular-prism audit cardinality derives bounded faces and edges for ${size} mm`, async (t) => {
    const { backend, model, directory } = await fixture(t);
    const [report] = await runScenarios(
      backend,
      [
        {
          id: "prism-audit-" + size,
          fixture: simulatorFolder,
          requires: [
            "documents",
            "saved-fixtures",
            "rectangular-extrusion",
            "rectangular-audit",
          ],
          async run(session) {
            await session.execute("box", createBox(session.document, size));
            const result = await session.execute(
              "boundary-counts",
              program(`${guard(session.document)}
body = design.rootComponent.bRepBodies.item(0)
assert body.faces.count == 6
assert body.edges.count == 12
for boundary in (body.faces, body.edges):
    try:
        boundary.item(0)
    except NotImplementedError:
        pass
    else:
        raise AssertionError('Unmodeled topology must not be synthesized')
${emit("dict(creationId=doc.creationId, faces=body.faces.count, edges=body.edges.count)")}`),
            );
            assert.equal(result["faces"], 6);
            assert.equal(result["edges"], 12);
          },
        },
      ],
      directory,
      1,
    );
    assert.equal(report?.status, "passed", JSON.stringify(report));
    assert.equal(report?.cleanup, "complete");
    assert.deepEqual(await remaining(model), { active: null, documents: [] });
  });
}

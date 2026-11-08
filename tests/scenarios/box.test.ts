import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fixture, remaining } from "./test-support";
import { simulatorFolder } from "./simulator";
import { runScenarios } from "./runner";
import { boxScenarios } from "./box-cases";
import { program } from "./programs";
import { record } from "./contracts";

const root = path.resolve(__dirname, "../../..");
const read = (name: string) => readFileSync(path.join(root, name), "utf8");
for (const protocol of ["mcp", "addin"] as const) {
  for (const concurrency of [1, 2, 10]) {
    test(`box dimensions, volume and rollback via ${protocol}, concurrency ${concurrency}`, async (t) => {
      const { directory, model, backend } = await fixture(t, protocol);
      const reports = await runScenarios(
        backend,
        boxScenarios(simulatorFolder),
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

test("historical box source and current extent API produce the same geometry", async (t) => {
  const baseline = read("tests/fixtures/history/box-a26222f.py.txt");
  const metadata = record(
    JSON.parse(read("tests/fixtures/history/box-a26222f.py.json")),
  );
  assert.equal(
    createHash("sha256").update(baseline).digest("hex"),
    metadata["sha256"],
  );
  const results = [];
  for (const source of [baseline, read("assets/scripts/box.py")]) {
    const { model } = await fixture(t);
    const prepared = source
      .replace('DOC_NAME = ""', 'DOC_NAME = "Model"')
      .replace(
        /def run\(_context(?:: str)?\)(?: -> None)?:/,
        "def _box_run(_context: str) -> None:",
      );
    const result = await model.execute(
      prepared +
        "\n" +
        program(`import adsk.core, json, contextlib, io
app = adsk.core.Application.get()
doc = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
doc.name = 'Model'
output = io.StringIO()
with contextlib.redirect_stdout(output):
    _box_run('')
design = doc.products.product
body = design.rootComponent.bRepBodies.item(0)
print(json.dumps(dict(output=output.getvalue(), sketches=design.rootComponent.sketches.count,
    features=design.rootComponent.features.count, timeline=design.timeline.count,
    volume=body.physicalProperties.volume, min=body.boundingBox.minPoint.asArray(),
    max=body.boundingBox.maxPoint.asArray())))`),
    );
    assert.equal(result.success, true, result.error);
    results.push(record(JSON.parse(result.stdout)));
  }
  assert.deepEqual(results[1], results[0]);
  assert.equal(results[0]?.["volume"], 1);
  assert.deepEqual(results[0]?.["max"], [1, 1, 1]);
});

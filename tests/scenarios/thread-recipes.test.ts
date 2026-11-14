import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { record } from "./contracts";
import { program, guard, emit } from "./programs";
import test from "node:test";
import assert from "node:assert/strict";
import { fixture, remaining } from "./test-support";
import { simulatorFolder } from "./simulator";
import { runScenarios } from "./runner";
import { threadRecipeScenarios } from "./thread-recipe-cases";
for (const protocol of ["mcp", "addin"] as const) {
  for (const concurrency of [1, 2, 10]) {
    test(`thread recipe assertions via ${protocol}, concurrency ${concurrency}`, async (t) => {
      const { backend, model, directory } = await fixture(t, protocol);
      const reports = await runScenarios(
        backend,
        threadRecipeScenarios(simulatorFolder, concurrency === 10 ? 10 : 2),
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

test("curated query mismatch predates the refactor", async (t) => {
  const root = path.resolve(__dirname, "../../..");
  const source = readFileSync(
    path.join(root, "tests/fixtures/history/thread-catalog-a262.py.txt"),
    "utf8",
  );
  const metadata = record(
    JSON.parse(
      readFileSync(
        path.join(root, "tests/fixtures/history/thread-catalog-a262.py.json"),
        "utf8",
      ),
    ),
  );
  assert.equal(
    createHash("sha256").update(source).digest("hex"),
    metadata["sha256"],
  );
  const { prepareCadBundle } = createRequire(path.join(root, "package.json"))(
    "./src/python",
  ) as typeof import("../../packages/node-adapters/src/python/bundle");
  const observations: unknown[] = [];
  for (const historical of [true, false]) {
    const { backend, directory } = await fixture(t);
    const reports = await runScenarios(
      backend,
      [
        {
          ...threadRecipeScenarios(simulatorFolder, 1)[0]!,
          async run(session) {
            const result = await session.execute(
              "catalog-comparison",
              prepareCadBundle(
                root,
                (historical ? source : "") +
                  "\n" +
                  program(`${guard(session.document)}
ctx = CadContext(doc.name, 'root', doc_id=doc.creationId)
rows: list[object] = []
for query in ['M10', 'M10x1.5']:
    try:
        out = thread_catalog(ctx, dict(schemaVersion=1, frame='component', system='iso-metric-coarse', query=query, starts=2))
        rows.append(dict(query=query, entries=out['entries'], curated=out['curated']))
    except ValueError as error:
        rows.append(dict(query=query, error=str(error)))
${emit("dict(creationId=doc.creationId, rows=rows)")}`),
              ).script,
            );
            observations.push(result["rows"]);
          },
        },
      ],
      directory,
      1,
    );
    assert.equal(reports[0]?.status, "passed", JSON.stringify(reports));
    assert.equal(reports[0]?.cleanup, "complete");
  }
  assert.deepEqual(observations[1], observations[0]);
  assert.ok(Array.isArray(observations[0]));
  assert.equal(
    record(observations[0][1])["error"],
    "Unknown designation in curated table: M10x1.5",
  );
});

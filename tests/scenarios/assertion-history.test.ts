import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { inventorySources } from "./assertion-inventory";
import { compareAssertionSources } from "./assertion-history";

test("predecessor comparison retains removed expectations and duplicate multiplicity across source ports", () => {
  const result = compareAssertionSources(
    "old.js",
    "assert.equal(value, 1); assert.equal(value, 1); assert.equal(active, name);",
    "new.ts",
    "assert.equal(value, 1); assert.equal(value, 2);",
  );
  assert.equal(result.before.source, "old.js");
  assert.equal(result.after.source, "new.ts");
  assert.equal(result.retainedIds.length, 1);
  assert.deepEqual(
    result.removed.map((site) => site.expression),
    ["assert.equal(value, 1)", "assert.equal(active, name)"],
  );
  assert.equal(result.addedIds.length, 1);
  assert.notEqual(result.before.sha256, result.after.sha256);
});

test("frozen predecessor evidence partitions every current source and preserves removed expressions", () => {
  const root = path.resolve(__dirname, "../../..");
  const evidence = JSON.parse(
    fs.readFileSync(
      path.join(root, "tests/live-assertion-predecessors.json"),
      "utf8",
    ),
  ) as {
    sources: {
      source: string;
      commit: string;
      predecessor: string;
      introduced: boolean;
      comparison: ReturnType<typeof compareAssertionSources>;
    }[];
  };
  const current = inventorySources(root);
  assert.deepEqual(
    evidence.sources.map((row) => row.source),
    current.map((row) => row.source),
  );
  for (const [index, row] of evidence.sources.entries()) {
    assert.match(row.commit, /^[0-9a-f]{40}$/u);
    assert.match(row.predecessor, /^[0-9a-f]{40}$/u);
    const comparison = row.comparison;
    assert.equal(comparison.after.sha256, current[index]!.sha256);
    assert.equal(comparison.after.count, current[index]!.assertions.length);
    assert.deepEqual(
      [...comparison.retainedIds, ...comparison.addedIds].sort(),
      current[index]!.assertions.map((site) => site.id).sort(),
    );
    assert.equal(
      comparison.before.count,
      comparison.retainedIds.length + comparison.removed.length,
    );
    assert.ok(comparison.removed.every((site) => site.expression.length > 0));
    if (
      [
        "tests/live-data-import.ts",
        "tests/live-data-import-fixed.ts",
        "tests/live-sketch-operations.ts",
      ].includes(row.source)
    ) {
      assert.equal(row.introduced, false);
      assert.equal(
        comparison.before.source,
        row.source.replace(/\.ts$/u, ".js"),
      );
      assert.ok(comparison.before.count > 0);
    }
  }
});

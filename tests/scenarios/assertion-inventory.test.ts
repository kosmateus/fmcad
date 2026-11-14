import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  assertionSites,
  inventorySources,
  reviewedImportSnapshots,
} from "./assertion-inventory";

const root = path.resolve(__dirname, "../../..");
test("every retained live assertion site matches the reviewed source ledger", () => {
  const ledger = JSON.parse(
    fs.readFileSync(
      path.join(root, "tests/live-assertion-inventory.json"),
      "utf8",
    ),
  ) as { sources: ReturnType<typeof inventorySources> };
  assert.deepEqual(
    inventorySources(root),
    ledger.sources,
    "Review added, changed or removed live assertions; do not silently regenerate dispositions",
  );
});

test("assertion discovery preserves duplicate calls, helpers, multiline Python and loop inputs", () => {
  const source = `assert.equal(x, 1); assert.equal(x, 1);
for (const expected of [1,2,3]) near(x, expected, 0.001);
assertion('sketch', 'bounds', actual === 3);
const py = \`assert (x == 1\n  and y == 2)\nraise AssertionError('failed')\`;
// assert.equal(ignored, 0)
const text = 'assert.equal(ignored, 0)';`;
  const rows = assertionSites("fixture.ts", source);
  assert.equal(rows.length, 5);
  assert.notEqual(rows[0]!.id, rows[1]!.id);
  assert.equal(rows[2]!.expression, "near(x, expected, 0.001)");
  assert.equal(rows[4]!.kind, "embedded-python");
  assert.match(rows[4]!.expression, /and y == 2/u);
});

test("assertion wrappers retain call-site expected values through named functions and arrow wrappers", () => {
  const source = `
function check(label, actual, expected) { assert.equal(actual, expected, label); }
const equalPose = (actual, expected) => check('pose', actual, expected);
function verifyFrame(value) { equalPose(value, 24); }
check('volume', actual, 1771);
equalPose(actual, 40);
verifyFrame(actual);
function unrelated() { return 'assert.equal(fake, 0)'; }
unrelated();
`;
  const expressions = assertionSites("fixture.js", source).map(
    (row) => row.expression,
  );
  for (const expression of [
    "check('volume', actual, 1771)",
    "equalPose(actual, 40)",
    "verifyFrame(actual)",
  ])
    assert.ok(expressions.includes(expression), expression);
  assert.equal(expressions.includes("unrelated()"), false);
});

test("reviewed import extraction preserves all 482 old sites and separately binds current sources", () => {
  const reviewed = reviewedImportSnapshots(root);
  assert.deepEqual(
    [...reviewed.entries()].map(([source, content]) => ({
      source,
      count: assertionSites(source, content).length,
    })),
    [
      { source: "tests/live-data-import-fixed.ts", count: 166 },
      { source: "tests/live-data-import.ts", count: 285 },
      { source: "tests/live-import-receipts.ts", count: 31 },
    ],
  );
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(root, "tests/live-import-extraction-review.json"),
      "utf8",
    ),
  ) as { current: { source: string; assertions: unknown[] }[] };
  assert.equal(manifest.current.length, 7);
  assert.equal(
    manifest.current.reduce((total, row) => total + row.assertions.length, 0),
    536,
  );
});

for (const tamper of [
  "retained-source",
  "current-guard",
  "extracted-assertion",
  "missing-disposition",
] as const) {
  test(`import extraction review rejects ${tamper} without replacing retained obligations`, (t) => {
    const fixture = fs.mkdtempSync(
      path.join(os.tmpdir(), "fmcad-import-review-"),
    );
    t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
    const reviewPath = "tests/live-import-extraction-review.json";
    const mappingPath = "tests/scenarios/assertion-dispositions-import.json";
    const review = JSON.parse(
      fs.readFileSync(path.join(root, reviewPath), "utf8"),
    ) as { retained: { snapshot: string }[]; current: { source: string }[] };
    for (const relative of [
      reviewPath,
      mappingPath,
      ...review.retained.map((row) => row.snapshot),
      ...review.current.map((row) => row.source),
    ]) {
      const file = path.join(fixture, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.copyFileSync(path.join(root, relative), file);
    }
    if (tamper === "missing-disposition") {
      const file = path.join(fixture, mappingPath);
      const mappings = JSON.parse(fs.readFileSync(file, "utf8")) as {
        mappings: unknown[];
      };
      mappings.mappings.pop();
      fs.writeFileSync(file, JSON.stringify(mappings));
      assert.throws(
        () => reviewedImportSnapshots(fixture),
        /exactly one semantic disposition/,
      );
    } else {
      const relative =
        tamper === "retained-source"
          ? review.retained[0]!.snapshot
          : tamper === "current-guard"
            ? "tests/live-import-receipts.ts"
            : "tests/import-result-contracts.ts";
      fs.appendFileSync(
        path.join(fixture, relative),
        "\nassert.equal('unreviewed', 'changed');\n",
      );
      assert.throws(
        () => reviewedImportSnapshots(fixture),
        /Retained import snapshot changed|Review changed current import source/,
      );
    }
  });
}

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { assertionSites, inventorySources } from "./assertion-inventory";

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

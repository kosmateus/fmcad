import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  assertionSites,
  digest,
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
  // 4fb56ac added the receipt-bound original/protected inventory baseline:
  // 37 additional sites, without changing the frozen 482 above.
  assert.deepEqual(
    manifest.current.map(({ source, assertions }) => ({
      source,
      count: assertions.length,
    })),
    [
      { source: "tests/fixed-import-result-contracts.ts", count: 50 },
      { source: "tests/import-result-contracts.ts", count: 58 },
      { source: "tests/live-data-import-fixed.ts", count: 112 },
      { source: "tests/live-data-import.ts", count: 208 },
      { source: "tests/live-import-receipts.ts", count: 80 },
      { source: "tests/scenarios/import-baseline.ts", count: 37 },
      { source: "tests/scenarios/native-import-cases.ts", count: 9 },
      { source: "tests/scenarios/programs.ts", count: 30 },
    ],
  );
  assert.equal(
    manifest.current.reduce((total, row) => total + row.assertions.length, 0),
    584,
  );
});

test("saved peer fence review keeps the earlier current observation without qualifying import equivalence", () => {
  const review = JSON.parse(
    fs.readFileSync(
      path.join(root, "tests/live-import-extraction-review.json"),
      "utf8",
    ),
  ) as {
    current: { source: string; sha256: string; assertions: unknown[] }[];
    currentSourceTransitions: {
      source: string;
      predecessor: string;
      commit: string;
      gitParent: string;
      comparisonBasis: string;
      qualification: string;
      comparison: ReturnType<
        typeof import("./assertion-history").compareAssertionSources
      >;
    }[];
  };
  const transition = review.currentSourceTransitions[0]!;
  assert.equal(transition.source, "tests/scenarios/programs.ts");
  assert.equal(
    transition.predecessor,
    "06908330fd309390318b86a807e534fe9f92d665",
  );
  assert.equal(transition.commit, "f9edac60a9b531fe006233950752b0b2a8eec43d");
  assert.equal(
    transition.gitParent,
    "d79e4a15b970ae60804e840cfa4f246e06938116",
  );
  assert.equal(transition.comparisonBasis, "reviewed-source-span");
  assert.equal(
    transition.qualification,
    "source-reviewed-native-not-qualified",
  );
  assert.equal(
    transition.comparison.before.sha256,
    "aaca0a88fd1f9995065d75104b9a949505ba555e8f8b402a016485e4df561a9e",
  );
  assert.equal(transition.comparison.before.count, 29);
  assert.equal(
    digest(JSON.stringify(transition.comparison.removed)),
    "0ad19f907ec697ba3e694e6eabaa6ecf49dcfb688c0d38cd452e2867128eeab9",
  );
  const current = review.current.find(
    (row) => row.source === transition.source,
  )!;
  const latest = review.currentSourceTransitions.at(-1)!;
  assert.equal(latest.comparison.after.sha256, current.sha256);
  assert.equal(latest.comparison.after.count, current.assertions.length);
});

test("reviewed import evidence is checkout-line-ending independent without changing frozen hashes", (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-import-crlf-"));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const reviewPath = "tests/live-import-extraction-review.json";
  const mappingPath = "tests/scenarios/assertion-dispositions-import.json";
  const review = JSON.parse(
    fs.readFileSync(path.join(root, reviewPath), "utf8"),
  ) as {
    retained: { source: string; snapshot: string; sha256: string }[];
    current: { source: string }[];
  };
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
  const observations: Array<ReturnType<typeof reviewedImportSnapshots>> = [];
  for (const ending of ["\n", "\r\n"]) {
    for (const relative of [
      ...review.retained.map((row) => row.snapshot),
      ...review.current.map((row) => row.source),
    ]) {
      const file = path.join(fixture, relative);
      const normalized = fs.readFileSync(file, "utf8").replace(/\r\n/gu, "\n");
      fs.writeFileSync(file, normalized.replace(/\n/gu, ending));
    }
    const observed = reviewedImportSnapshots(fixture);
    for (const retained of review.retained)
      assert.equal(digest(observed.get(retained.source)!), retained.sha256);
    observations.push(observed);
  }
  assert.deepEqual([...observations[0]!], [...observations[1]!]);
});

for (const tamper of [
  "retained-source",
  "current-guard",
  "cleanup-guard",
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
            : tamper === "cleanup-guard"
              ? "tests/scenarios/programs.ts"
              : "tests/import-result-contracts.ts";
      const file = path.join(fixture, relative);
      if (tamper === "cleanup-guard") {
        const source = fs.readFileSync(file, "utf8");
        const changed = source.replace(
          "assert len(matches) == 1, 'Owned fixture identity is missing or duplicated'",
          "assert len(matches) <= 1, 'Owned fixture identity is missing or duplicated'",
        );
        assert.notEqual(
          changed,
          source,
          "The actual cleanup guard must be weakened by this negative test",
        );
        fs.writeFileSync(file, changed);
      } else {
        fs.appendFileSync(file, "\nassert.equal('unreviewed', 'changed');\n");
      }
      assert.throws(
        () => reviewedImportSnapshots(fixture),
        /Retained import snapshot changed|Review changed current import source/,
      );
    }
  });
}

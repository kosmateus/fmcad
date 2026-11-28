import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  digest,
  inventorySources,
  reviewedImportSnapshots,
} from "./assertion-inventory";
import {
  appendLatestSourceTransitions,
  compareAssertionSources,
} from "./assertion-history";

test("reviewed current import evidence preserves the three frozen source obligations", () => {
  const snapshots = reviewedImportSnapshots(
    path.resolve(__dirname, "../../.."),
  );
  assert.deepEqual(
    [...snapshots.keys()],
    [
      "tests/live-data-import-fixed.ts",
      "tests/live-data-import.ts",
      "tests/live-import-receipts.ts",
    ],
  );
});

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

test("history regeneration appends a source transition without replacing the frozen comparison", () => {
  const frozenComparison = compareAssertionSources(
    "source.ts",
    "assert.equal(value, 1);",
    "source.ts",
    "assert.equal(value, 1); assert.equal(value, 2);",
  );
  const latest = {
    source: "source.ts",
    commit: "c".repeat(40),
    predecessor: "a".repeat(40),
    introduced: false,
    comparison: compareAssertionSources(
      "source.ts",
      "assert.equal(value, 1); assert.equal(value, 2);",
      "source.ts",
      "assert.equal(value, 1); assert.equal(value, 2); assert.equal(value, 3);",
    ),
  };
  const previous = [
    {
      source: "source.ts",
      commit: "a".repeat(40),
      predecessor: "b".repeat(40),
      introduced: false,
      comparison: frozenComparison,
    },
  ];

  const appended = appendLatestSourceTransitions([latest], previous);

  assert.deepEqual(appended[0]!.comparison, frozenComparison);
  assert.deepEqual(appended[0]!.transitions, [
    {
      commit: latest.commit,
      predecessor: latest.predecessor,
      introduced: latest.introduced,
      comparison: latest.comparison,
    },
  ]);
  assert.deepEqual(appendLatestSourceTransitions([latest], appended), appended);
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
      transitions?: {
        commit: string;
        predecessor: string;
        introduced: boolean;
        comparison: ReturnType<typeof compareAssertionSources>;
      }[];
    }[];
  };
  const current = inventorySources(root);
  const frozenSources = new Map(
    evidence.sources.map((row) => [row.source, row]),
  );
  for (const [source, commit, predecessor, beforeSha256, afterSha256] of [
    [
      "tests/live-normal-multidocument.ts",
      "8042151fe57351da80c109c176487c38abeb7b04",
      "e6804e66eeea85eb9183ff28186d2ecc95be21b8",
      "ec73cf25a31db4bf912b8849bbe7b366ca9dc0bcac58d59c68cb18baca4eb75f",
      "1bcf6831378c871c31c0c902e2b2807cdaa53d44aef5d08086f619ae0d8ffb54",
    ],
    [
      "tests/live-recovery-ports.ts",
      "8042151fe57351da80c109c176487c38abeb7b04",
      "e6804e66eeea85eb9183ff28186d2ecc95be21b8",
      "73e48dbc2322ca40b63a84ad36329db0d1b250a1560559fa4ae08cd5df273984",
      "0ce78906cd0bfe7b647555a6aa02173418dede2e363c9fb0881f66889318bd56",
    ],
  ] as const) {
    const row = frozenSources.get(source);
    assert.ok(row, source);
    assert.equal(row.commit, commit, source);
    assert.equal(row.predecessor, predecessor, source);
    assert.equal(row.comparison.before.sha256, beforeSha256, source);
    assert.equal(row.comparison.after.sha256, afterSha256, source);
  }
  assert.deepEqual(
    evidence.sources.map((row) => row.source),
    current.map((row) => row.source),
  );
  for (const [index, row] of evidence.sources.entries()) {
    assert.match(row.commit, /^[0-9a-f]{40}$/u);
    assert.match(row.predecessor, /^[0-9a-f]{40}$/u);
    let previousAfter = row.comparison.after;
    const comparisons = [row.comparison];
    for (const transition of row.transitions ?? []) {
      assert.match(transition.commit, /^[0-9a-f]{40}$/u);
      assert.match(transition.predecessor, /^[0-9a-f]{40}$/u);
      assert.equal(transition.comparison.before.sha256, previousAfter.sha256);
      assert.equal(transition.comparison.before.count, previousAfter.count);
      comparisons.push(transition.comparison);
      previousAfter = transition.comparison.after;
    }
    for (const comparison of comparisons) {
      assert.equal(
        comparison.before.count,
        comparison.retainedIds.length + comparison.removed.length,
      );
      assert.equal(
        comparison.after.count,
        comparison.retainedIds.length + comparison.addedIds.length,
      );
      assert.ok(comparison.removed.every((site) => site.expression.length > 0));
    }
    const comparison = comparisons.at(-1)!;
    assert.equal(comparison.after.sha256, current[index]!.sha256);
    assert.equal(comparison.after.count, current[index]!.assertions.length);
    assert.deepEqual(
      [...comparison.retainedIds, ...comparison.addedIds].sort(),
      current[index]!.assertions.map((site) => site.id).sort(),
    );
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

test("source drift appends history without rewriting any previously frozen comparison", () => {
  const root = path.resolve(__dirname, "../../..");
  const history = JSON.parse(
    fs.readFileSync(
      path.join(root, "tests/live-assertion-predecessors.json"),
      "utf8",
    ),
  ) as { sources: import("./assertion-history").AssertionHistorySource[] };
  const original = history.sources
    .filter(
      (row) => row.source !== "tests/live-normal-multidocument-processes.js",
    )
    .map(({ transitions, ...row }) => {
      const retainedCount =
        row.source === "tests/live-normal-multidocument.ts"
          ? 3
          : row.source === "tests/live-recovery-ports.ts"
            ? 2
            : 0;
      if (retainedCount)
        return { ...row, transitions: transitions!.slice(0, retainedCount) };
      return row;
    });
  // Entire pre-.35 history, including all prior transition expressions, not just two hashes.
  assert.equal(original.length, 39);
  assert.equal(
    digest(JSON.stringify(original)),
    "c141e2c4f5fa40b88d70495b14156d653d5ceaa8dd972c8124e11bd502ef5890",
  );
});

test("all 44 removed reviewed sites keep their exact unqualified native obligations", () => {
  const root = path.resolve(__dirname, "../../..");
  const ledger = JSON.parse(
    fs.readFileSync(
      path.join(
        root,
        "tests/scenarios/assertion-dispositions-source-drift.json",
      ),
      "utf8",
    ),
  ) as {
    mappings: {
      source: string;
      assertionId: string;
      historicalCommit?: string;
      requiredObservation: string;
      disposition: string;
      qualification: string;
    }[];
  };
  const removed = ledger.mappings.filter(
    (row) =>
      row.historicalCommit &&
      row.source !== "tests/live-normal-multidocument-processes.js",
  );
  assert.equal(removed.length, 44);
  assert.equal(
    digest(
      JSON.stringify(
        removed.map((row) => [
          row.source,
          row.assertionId,
          row.requiredObservation,
        ]),
      ),
    ),
    "495239ad927f9b8fe8b724e5e56f44ddc67a13b4947f9d2a285c0794c425b6b3",
  );
  for (const row of removed) {
    assert.equal(row.disposition, "native-only");
    assert.equal(row.qualification, "not-run");
  }
});

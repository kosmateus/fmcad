import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { digest } from "./assertion-inventory";

test("result retention review preserves the six predecessor obligations without qualifying native work", () => {
  const root = path.resolve(__dirname, "../../..");
  const source = "tests/live-normal-multidocument.ts";
  const contents = fs
    .readFileSync(path.join(root, source), "utf8")
    .replace(/\r\n/gu, "\n");
  const dispositions = JSON.parse(
    fs.readFileSync(
      path.join(root, "tests/scenarios/assertion-dispositions-recovery.json"),
      "utf8",
    ),
  ) as {
    mappings: {
      source: string;
      assertionId: string;
      historicalCommit?: string;
      sourceSha256: string;
      sourceKind: string;
      currentSourceSha256?: string;
      requiredObservation: string;
      evidenceAssertion: string;
      disposition: string;
      qualification: string;
    }[];
  };
  const predecessors = JSON.parse(
    fs.readFileSync(
      path.join(root, "tests/live-assertion-predecessors.json"),
      "utf8",
    ),
  ) as {
    sources: {
      source: string;
      transitions?: {
        commit: string;
        predecessor: string;
        comparison: {
          before: { sha256: string; count: number };
          after: { sha256: string; count: number };
          retainedIds: string[];
          removed: { id: string; kind: string; expression: string }[];
          addedIds: string[];
        };
      }[];
    }[];
  };
  const history = predecessors.sources.find((row) => row.source === source);
  assert.ok(history, source);
  const transitions = history.transitions ?? [];
  const replacementCommits = [
    "3badcefbfe2c3e43a050cf02bba235e6d0333ef0",
    "6b8ec5f8f82069b0701b8c8881178c30f5bd77e1",
  ];
  const replacementTransitions = transitions.filter((transition) =>
    replacementCommits.includes(transition.commit),
  );
  assert.deepEqual(
    replacementTransitions.map((transition) => transition.commit),
    replacementCommits,
  );
  assert.deepEqual(
    replacementTransitions.map((transition) => transition.predecessor),
    [
      "6f32da55bdb4b8114720add67451c3adc20dab1f",
      "a365989c3eab56bbb51841be56f92998351847c4",
    ],
  );
  assert.deepEqual(
    replacementTransitions.map(({ comparison }) => [
      comparison.before.count,
      comparison.after.count,
      comparison.removed.length,
      comparison.addedIds.length,
    ]),
    [
      [48, 86, 5, 43],
      [86, 87, 1, 2],
    ],
  );
  const removedSites = replacementTransitions.flatMap((transition) =>
    transition.comparison.removed.map((site) => ({
      ...site,
      predecessor: transition.predecessor,
      sourceSha256: transition.comparison.before.sha256,
    })),
  );
  assert.equal(
    replacementTransitions.reduce(
      (total, transition) => total + transition.comparison.addedIds.length,
      0,
    ),
    45,
  );
  const settlementTransition = transitions.find(
    (row) => row.commit === "135007c1b29b1004f9aa17d688b293a9813ebc95",
  );
  assert.ok(settlementTransition);
  assert.deepEqual(
    [
      settlementTransition.comparison.before.count,
      settlementTransition.comparison.after.count,
      settlementTransition.comparison.retainedIds.length,
      settlementTransition.comparison.removed.length,
      settlementTransition.comparison.addedIds.length,
    ],
    [87, 87, 87, 0, 0],
  );
  const ids = [
    "834fa79e8be487ec7ad5-1",
    "f7266c62ba420bc00665-1",
    "8c73897632a3d94c5fb4-1",
    "1758d82687dd9b86db42-1",
    "f0f9b6a9ab5c318ea62e-1",
    "3598b94c2025217faac7-1",
  ];
  assert.deepEqual(
    removedSites.map((site) => site.id).sort(),
    [...ids].sort(),
    "Six removed predecessor obligations remain individually accounted for",
  );
  for (const id of ids) {
    const row = dispositions.mappings.find(
      (row) => row.source === source && row.assertionId === id,
    )!;
    const historical = removedSites.find((site) => site.id === id);
    assert.ok(row, id);
    assert.ok(historical, id);
    assert.equal(row.historicalCommit, historical.predecessor, id);
    assert.equal(row.sourceSha256, historical.sourceSha256, id);
    assert.equal(row.sourceKind, historical.kind, id);
    assert.equal(row.requiredObservation, historical.expression, id);
    assert.notEqual(
      row.sourceSha256,
      row.currentSourceSha256,
      "Historical and current source bindings stay distinct",
    );
    assert.equal(
      digest(row.sourceKind + "\n" + row.requiredObservation).slice(0, 20) +
        "-1",
      id,
      "The original expression remains bound to its historical assertion ID",
    );
    assert.equal(row.currentSourceSha256, digest(contents), id);
    assert.ok(contents.includes(row.evidenceAssertion), id);
    assert.equal(row.disposition, "native-only");
    assert.equal(
      row.qualification,
      "not-run",
      "Reviewing source bytes is not native settlement or cleanup evidence",
    );
  }
});

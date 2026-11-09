import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { record, text } from "./contracts";
const root = path.resolve(__dirname, "../../..");
test("reviewed assertion mappings name retained individual assertions and real evidence", () => {
  const ledger = record(
    JSON.parse(
      fs.readFileSync(
        path.join(root, "tests/live-assertion-inventory.json"),
        "utf8",
      ),
    ) as unknown,
  );
  assert.ok(Array.isArray(ledger["sources"]));
  const available = new Set<string>();
  const expressions = new Map<string, string>();
  for (const value of ledger["sources"]) {
    const source = record(value);
    assert.ok(Array.isArray(source["assertions"]));
    for (const site of source["assertions"]) {
      const key = text(source["source"]) + ":" + text(record(site)["id"]);
      available.add(key);
      expressions.set(key, text(record(site)["expression"]));
    }
  }
  const predecessors = JSON.parse(
    fs.readFileSync(
      path.join(root, "tests/live-assertion-predecessors.json"),
      "utf8",
    ),
  ) as {
    sources: {
      source: string;
      predecessor: string;
      comparison: { removed: { id: string }[] };
    }[];
  };
  const historical = new Set(
    predecessors.sources.flatMap((source) =>
      source.comparison.removed.map(
        (site) => source.source + ":" + source.predecessor + ":" + site.id,
      ),
    ),
  );
  const directory = path.join(root, "tests/scenarios");
  const mappings = fs
    .readdirSync(directory)
    .filter((name) => /^assertion-dispositions(?:-[a-z-]+)?\.json$/u.test(name))
    .sort()
    .flatMap((name) => {
      const file = record(
        JSON.parse(
          fs.readFileSync(path.join(directory, name), "utf8"),
        ) as unknown,
      );
      assert.ok(Array.isArray(file["mappings"]), name);
      return file["mappings"];
    });
  const contents = new Map<string, string>();
  const mapped = new Set<string>();
  for (const value of mappings) {
    const row = record(value),
      key =
        text(row["source"]) +
        ":" +
        (row["historicalCommit"] ? text(row["historicalCommit"]) + ":" : "") +
        text(row["assertionId"]);
    assert.ok((row["historicalCommit"] ? historical : available).has(key), key);
    assert.ok(!mapped.has(key), "Duplicate semantic disposition: " + key);
    mapped.add(key);
    assert.ok(
      ["shared", "native-only", "offline-only"].includes(
        text(row["disposition"]),
      ),
    );
    if (row["requiredObservation"] !== undefined)
      assert.equal(row["requiredObservation"], expressions.get(key), key);
    if (row["disposition"] === "native-only") {
      if (row["scenario"] === "native-solids-*") {
        assert.equal(row["qualification"], "not-run");
        assert.equal(
          row["expectationReview"],
          "annular-interior-extremum-corrected",
        );
      } else {
        assert.match(text(row["scenario"]), /^native-/u);
        assert.equal(row["qualification"], "not-run");
        assert.ok(text(row["nativeObligation"]).length > 0);
        assert.ok(Array.isArray(row["requiredCapabilities"]));
        assert.equal(row["retainedSource"], row["source"]);
        assert.equal(row["requiredObservation"], expressions.get(key));
        assert.ok(
          ["migration-required", "owned-handoff-ready"].includes(
            text(row["runnerStatus"]),
          ),
        );
      }
      assert.ok(fs.existsSync(path.join(root, text(row["blocker"]))));
    }
    const evidencePath = path.join(root, text(row["evidence"]));
    assert.ok(fs.existsSync(evidencePath));
    if (row["evidenceAssertion"] !== undefined) {
      if (!contents.has(evidencePath))
        contents.set(evidencePath, fs.readFileSync(evidencePath, "utf8"));
      assert.ok(
        contents.get(evidencePath)!.includes(text(row["evidenceAssertion"])),
        "Reviewed assertion evidence disappeared: " + key,
      );
    }
    if (row["disposition"] !== "native-only")
      assert.ok(
        [
          "scenario-session-contracts",
          "retained-engineering-*",
          "recovery-port-contracts",
          "import-receipt-contracts",
          "import-result-contracts",
          "mechanical-declarations-*",
          "gm07-catalog-contracts",
          "gm12-catalog-contracts",
          "fixed-native-source-contracts",
          "gm12-terminal-classification",
          "installed-style-save-preflight",
          "installed-sketch-preflight",
          "parameters-*",
          "sketch-*",
          "attributes-*",
          "thread-recipes-*",
          "gear-pair-*",
          "engineering-declarations-*",
          "definition-transaction-*",
          "camera-state-*",
          "pose-visibility-*",
          "animation-plan-*",
          "native-solids-*",
          "document-lifecycle",
          "material-metadata-*",
          "appearance-metadata-*",
          "body-style-assignment-*",
          "parameter-crud",
          "construction-planes",
          "component-tree",
          "document-units",
          "box-10",
        ].includes(text(row["scenario"])),
      );
    assert.ok(text(row["reason"]).length > 40);
  }
  assert.deepEqual(
    [...available].filter((key) => !mapped.has(key)),
    [],
    "Every retained assertion requires its individual reviewed offline or native disposition",
  );
  assert.equal(
    [...mapped].filter((key) => available.has(key)).length,
    available.size,
    "All current assertion sites must be accounted for exactly once",
  );
});

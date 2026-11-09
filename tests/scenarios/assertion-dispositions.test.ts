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
  for (const value of ledger["sources"]) {
    const source = record(value);
    assert.ok(Array.isArray(source["assertions"]));
    for (const site of source["assertions"])
      available.add(text(source["source"]) + ":" + text(record(site)["id"]));
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
  const dispositions = record(
    JSON.parse(
      fs.readFileSync(
        path.join(root, "tests/scenarios/assertion-dispositions.json"),
        "utf8",
      ),
    ) as unknown,
  );
  assert.ok(Array.isArray(dispositions["mappings"]));
  const mapped = new Set<string>();
  for (const value of dispositions["mappings"]) {
    const row = record(value),
      key =
        text(row["source"]) +
        ":" +
        (row["historicalCommit"] ? text(row["historicalCommit"]) + ":" : "") +
        text(row["assertionId"]);
    assert.ok((row["historicalCommit"] ? historical : available).has(key), key);
    assert.ok(!mapped.has(key), "Duplicate semantic disposition: " + key);
    mapped.add(key);
    assert.ok(["shared", "native-only"].includes(text(row["disposition"])));
    if (row["disposition"] === "native-only") {
      assert.equal(row["scenario"], "native-solids-*");
      assert.equal(
        row["qualification"],
        "blocked-historical-bound-expectation",
      );
      assert.ok(fs.existsSync(path.join(root, text(row["blocker"]))));
    }
    const evidencePath = path.join(root, text(row["evidence"]));
    assert.ok(fs.existsSync(evidencePath));
    if (row["evidenceAssertion"] !== undefined) {
      assert.ok(
        fs
          .readFileSync(evidencePath, "utf8")
          .includes(text(row["evidenceAssertion"])),
        "Reviewed assertion evidence disappeared: " + key,
      );
    }
    assert.ok(
      [
        "attributes-*",
        "thread-recipes-*",
        "gear-pair-*",
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
  assert.ok(
    mapped.size > 0 && mapped.size < available.size,
    "This partial ledger must not imply complete migration",
  );
});

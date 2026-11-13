import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { digest } from "./assertion-inventory";

test("result retention review preserves the six predecessor obligations without qualifying native work", () => {
  const root = path.resolve(__dirname, "../../..");
  const source = "tests/live-normal-multidocument.ts";
  const contents = fs.readFileSync(path.join(root, source), "utf8");
  const dispositions = JSON.parse(
    fs.readFileSync(
      path.join(root, "tests/scenarios/assertion-dispositions-recovery.json"),
      "utf8",
    ),
  ) as {
    mappings: {
      source: string;
      assertionId: string;
      sourceSha256: string;
      sourceKind: string;
      currentSourceSha256?: string;
      reviewedBinding?: string;
      requiredObservation: string;
      evidenceAssertion: string;
      disposition: string;
      qualification: string;
    }[];
  };
  const ids = [
    "834fa79e8be487ec7ad5-1",
    "f7266c62ba420bc00665-1",
    "8c73897632a3d94c5fb4-1",
    "1758d82687dd9b86db42-1",
    "f0f9b6a9ab5c318ea62e-1",
    "3598b94c2025217faac7-1",
  ];
  for (const id of ids) {
    const row = dispositions.mappings.find(
      (row) => row.source === source && row.assertionId === id,
    )!;
    assert.ok(row, id);
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
    assert.match(
      row.reviewedBinding!,
      /Review of 135007c against its first parent confirms all 87 assertion IDs and expressions are unchanged/,
    );
    assert.equal(row.disposition, "native-only");
    assert.equal(
      row.qualification,
      "not-run",
      "Reviewing source bytes is not native settlement or cleanup evidence",
    );
  }
});

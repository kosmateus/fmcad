import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { nativeIntegrationSourceHash } from "./native-integration-cases";

const root = path.resolve(__dirname, "../../..");
interface NativeCase {
  id: string;
  source: string;
  title: string;
  sourceSha256: string;
}
interface CaseGap {
  caseManifest?: string;
  caseIds?: string[];
  caseCount?: number;
  sourceSha256?: string;
  manifestSourceSha256?: string;
  sourcePinStatus?: string;
  blockers?: string[];
  runnerStatus?: string;
  nativeExecution?: string;
}
test("native integration provenance pins all 251 reviewed callbacks independent of line endings", () => {
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(root, "tests/scenarios/native-integration-cases.json"),
      "utf8",
    ),
  ) as { qualification: string; cases: NativeCase[] };
  const manifestSha256 = nativeIntegrationSourceHash(
    fs.readFileSync(
      path.join(root, "tests/scenarios/native-integration-cases.json"),
      "utf8",
    ),
  );
  assert.equal(manifest.qualification, "not-run");
  assert.equal(manifest.cases.length, 251);
  assert.equal(new Set(manifest.cases.map((entry) => entry.id)).size, 251);

  const sources = new Map<string, { hash: string; ids: string[] }>();
  for (const entry of manifest.cases) {
    assert.ok(entry.id.length > 0);
    assert.ok(entry.title.length > 0);
    assert.match(entry.sourceSha256, /^[a-f0-9]{64}$/u);
    let source = sources.get(entry.source);
    if (!source) {
      source = {
        hash: nativeIntegrationSourceHash(
          fs.readFileSync(path.join(root, entry.source), "utf8"),
        ),
        ids: [],
      };
      sources.set(entry.source, source);
    }
    assert.equal(
      entry.sourceSha256,
      source.hash,
      entry.source + ":" + entry.id,
    );
    source.ids.push(entry.id);
  }
  assert.equal(sources.size, 34);

  const profiles = JSON.parse(
    fs.readFileSync(
      path.join(root, "tests/live-required-profiles.json"),
      "utf8",
    ),
  ) as {
    profiles: Record<
      string,
      {
        cases: {
          id: string;
          sourceSha256: string;
          qualification: string;
          runnerStatus: string;
        }[];
      }
    >;
  };
  const profile = profiles.profiles["native-fixtures"]?.cases.find(
    (entry) => entry.id === "native-integration",
  );
  assert.ok(profile);
  assert.equal(profile.sourceSha256, manifestSha256);
  assert.equal(profile.qualification, "not-run");
  assert.equal(profile.runnerStatus, "owned-handoff-source-ready");

  const gaps = JSON.parse(
    fs.readFileSync(
      path.join(root, "docs/integration/ci-registration-gaps.json"),
      "utf8",
    ),
  ) as {
    nativeIntegrationEvidence: {
      manifestSha256: string;
      sourceCount: number;
      caseCount: number;
      executionStatus: string;
      handoffBlockers: { id: string; status: string }[];
    };
    gaps: Record<string, CaseGap>;
  };
  assert.equal(gaps.nativeIntegrationEvidence.manifestSha256, manifestSha256);
  assert.equal(gaps.nativeIntegrationEvidence.sourceCount, 34);
  assert.equal(gaps.nativeIntegrationEvidence.caseCount, 251);
  assert.equal(gaps.nativeIntegrationEvidence.executionStatus, "NOTRUN");
  assert.deepEqual(
    gaps.nativeIntegrationEvidence.handoffBlockers.map((entry) => entry.status),
    ["verified-offline", "verified-offline"],
  );

  const registered = Object.entries(gaps.gaps).filter(
    ([, entry]) =>
      entry.caseManifest === "tests/scenarios/native-integration-cases.json",
  );
  assert.equal(registered.length, sources.size);
  for (const [filename, entry] of registered) {
    const expected = sources.get(filename);
    assert.ok(expected, filename);
    assert.equal(entry.caseCount, expected.ids.length, filename);
    assert.deepEqual(
      [...(entry.caseIds ?? [])].sort(),
      [...expected.ids].sort(),
      filename,
    );
    assert.equal(entry.sourceSha256, expected.hash, filename);
    assert.equal(entry.manifestSourceSha256, expected.hash, filename);
    assert.equal(entry.sourcePinStatus, "matched", filename);
    assert.equal(entry.runnerStatus, "owned-handoff-source-ready", filename);
    assert.deepEqual(entry.blockers, [], filename);
    assert.equal(entry.nativeExecution, "NOTRUN", filename);
  }
});

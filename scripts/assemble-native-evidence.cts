// Offline envelope/integrity review, not re-execution of native validators.
import * as fs from "node:fs";
import path from "node:path";
import * as crypto from "node:crypto";
import assert from "node:assert/strict";
type Fields = Record<string, unknown>;
function record(value: unknown): Fields {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "Evidence object required",
  );
  return value as Fields;
}
function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value), "Evidence list required");
  return value;
}
function text(value: unknown): string {
  assert.equal(typeof value, "string", "Evidence text required");
  return value as string;
}
const manifest = record(
  JSON.parse(
    fs.readFileSync(
      path.join(
        __dirname,
        "../tests/native/integrated-qualification/manifest.json",
      ),
      "utf8",
    ),
  ) as unknown,
);
assert.ok(
  Array.isArray(manifest["features"]),
  "Native feature manifest required",
);
const manifestFeatures = array(manifest["features"]).map(record);

const contracts: Record<string, readonly [string, string]> = {
  "regional-geometry": [
    "regional-native-kernel-qualification-pass",
    "ACCEPTED_AT_RECORDED_VERSION",
  ],
  containment: [
    "independently-verified-native-containment-pass",
    "ACCEPTED_AT_RECORDED_VERSION",
  ],
  "section-witnesses": [
    "independently-verified-native-sections-witness-pass",
    "ACCEPTED_AT_RECORDED_VERSION",
  ],
  "sketch-geometry-proof": [
    "native-sketch-proof-with-corrected-seam-pass",
    "ACCEPTED_AT_RECORDED_VERSION",
  ],
  "measured-fasteners": [
    "independently-verified-native-measured-fasteners-pass",
    "ACCEPTED_AT_RECORDED_VERSION",
  ],
  "motion-link": [
    "independently-verified-native-degree-grid-coupling-pass",
    "ACCEPTED_GRID_ONLY",
  ],
  "native-drive-test": [
    "independently-verified-native-degree-grid-coupling-pass",
    "PARTIAL_GRID_ONLY",
  ],
  "drive-precision": [
    "independently-verified-native-coordinate-diagnosis",
    "DIAGNOSTIC_ONLY",
  ],
};
const referenceFields = [
  "receipt",
  "closedEpochProof",
  "nativeProof",
  "diagnosticProof",
  "originalRunProof",
  "originalFixedRun",
  "correctedReadbackProof",
  "result",
];

export function assemble(input: unknown) {
  const index = record(input);
  assert.equal(index["schemaVersion"], 1, "Unsupported evidence index");
  assert.ok(
    Array.isArray(index["evidenceRoots"]) && index["evidenceRoots"].length,
    "Explicit evidence roots required",
  );
  const roots = array(index["evidenceRoots"]).map((value) => {
    const root = text(value);
    assert.ok(
      path.isAbsolute(root) && fs.realpathSync(root) === path.resolve(root),
      "Real absolute evidence root required",
    );
    return path.resolve(root);
  });
  const verified = new Map<string, unknown>();
  function readReference(input: unknown): unknown {
    const reference = record(input);
    assert.ok(
      reference &&
        typeof reference["path"] === "string" &&
        /^[a-f0-9]{64}$/.test(text(reference["sha256"])),
      "Hashed reference required",
    );
    const file = path.resolve(reference["path"]);
    assert.ok(
      path.isAbsolute(reference["path"]) &&
        roots.some((root) => file.startsWith(root + path.sep)),
      "Reference outside evidence roots",
    );
    assert.ok(
      fs.lstatSync(file).isFile() && fs.realpathSync(file) === file,
      "Regular evidence file without symlinks required",
    );
    const bytes = fs.readFileSync(file);
    assert.equal(
      crypto.createHash("sha256").update(bytes).digest("hex"),
      reference["sha256"],
      "Evidence hash mismatch: " + file,
    );
    if (verified.has(file)) return verified.get(file);
    const value = file.endsWith(".json")
      ? (JSON.parse(bytes.toString("utf8")) as unknown)
      : null;
    verified.set(file, value);
    // Follow only known evidence-envelope fields, not arbitrary paths in SDK data.
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const envelope = record(value);
      for (const key of referenceFields) {
        const child = envelope[key];
        if (child && typeof child === "object" && !Array.isArray(child)) {
          const ref = record(child);
          if (ref["path"] && ref["sha256"]) readReference(ref);
        }
      }
      for (const key of ["evidence", "qualificationEvidence"]) {
        const children = envelope[key];
        if (Array.isArray(children))
          for (const child of array(children)) {
            if (child && typeof child === "object" && !Array.isArray(child)) {
              const ref = record(child);
              if (ref["path"] && ref["sha256"]) readReference(ref);
            }
          }
      }
    }
    return value;
  }
  assert.ok(Array.isArray(index["entries"]), "Evidence entries required");
  const imported = new Map<string, Fields & { id: string; status: string }>();
  for (const item of array(index["entries"])) {
    const entry = record(item);
    const featureId = text(entry["featureId"]);
    const contract = contracts[featureId];
    assert.ok(
      contract && !imported.has(featureId),
      "Unknown or duplicate feature",
    );
    const proof = record(readReference(entry["proof"])),
      cleanup = record(readReference(entry["cleanup"])),
      qualification = record(readReference(entry["qualification"]));
    assert.equal(proof["version"], 1);
    assert.equal(
      proof["status"],
      contract[0],
      "Unsupported native proof status",
    );
    assert.ok(
      /^[a-f0-9]{40}$/.test(text(entry["sourceCommit"])) &&
        /^[a-f0-9]{64}$/.test(text(entry["buildHash"])),
      "Exact recorded source/build required",
    );
    assert.equal(
      proof["sourceCommit"],
      entry["sourceCommit"],
      "Proof source mismatch",
    );
    assert.equal(
      proof["buildHash"],
      entry["buildHash"],
      "Proof build mismatch",
    );
    assert.equal(qualification["passed"], true);
    assert.equal(
      qualification["sourceCommit"],
      entry["sourceCommit"],
      "Qualification source mismatch",
    );
    assert.equal(
      qualification["buildHash"],
      entry["buildHash"],
      "Qualification build mismatch",
    );
    assert.equal(
      qualification["liveSdkRequestsSent"],
      0,
      "Installed qualification must remain offline",
    );
    assert.ok(
      proof["epochId"] &&
        record(proof["document"])["creationId"] &&
        record(proof["document"])["name"],
      "Exact epoch/document required",
    );
    assert.equal(
      record(proof["document"])["fileId"],
      null,
      "Only recorded unsaved-scratch envelopes supported",
    );
    assert.equal(
      cleanup["epochId"],
      proof["epochId"],
      "Cleanup epoch mismatch",
    );
    assert.deepEqual(
      cleanup["document"],
      proof["document"],
      "Cleanup document mismatch",
    );
    assert.equal(cleanup["closed"], true);
    assert.equal(cleanup["saved"], false);
    assert.equal(cleanup["activeDocumentRestored"], true);
    assert.ok(
      cleanup["restoredActiveCreationId"],
      "Exact restored active identity required",
    );
    const closed = record(readReference(cleanup["closedEpochProof"])),
      receipt = record(readReference(cleanup["receipt"]));
    assert.equal(closed["epochId"], proof["epochId"]);
    assert.deepEqual(closed["document"], proof["document"]);
    assert.deepEqual(
      closed["receipt"],
      cleanup["receipt"],
      "Closed proof receipt mismatch",
    );
    assert.equal(receipt["status"], "complete");
    assert.equal(
      record(receipt["summary"])["purpose"],
      "isolated-scratch-close-v1",
    );
    assert.deepEqual(record(receipt["summary"])["document"], proof["document"]);
    assert.equal(record(receipt["summary"])["closed"], true);
    assert.equal(record(receipt["summary"])["saved"], false);
    assert.equal(record(receipt["summary"])["activeDocumentRestored"], true);
    assert.equal(
      record(receipt["summary"])["restoredActiveCreationId"],
      cleanup["restoredActiveCreationId"],
    );
    assert.ok(
      Array.isArray(proof["evidence"]) && proof["evidence"].length,
      "Independent evidence references required",
    );
    for (const evidence of array(proof["evidence"])) readReference(evidence);
    if (
      entry["featureId"] === "drive-precision" ||
      entry["featureId"] === "motion-link" ||
      entry["featureId"] === "native-drive-test"
    )
      assert.equal(
        proof["arbitraryAnglePrecisionQualified"],
        false,
        "Do not promote precision diagnosis/grid to arbitrary-angle PASS",
      );
    imported.set(featureId, {
      id: featureId,
      status: contract[1],
      sourceCommit: proof["sourceCommit"],
      buildHash: proof["buildHash"],
      epochId: proof["epochId"],
      document: proof["document"],
      jobId: proof["jobId"] ?? null,
      proof: entry["proof"],
      cleanup: entry["cleanup"],
      qualification: entry["qualification"],
      recordedEvidence: proof,
      verifiedCleanup: {
        closed: true,
        saved: false,
        activeDocumentRestored: true,
        restoredActiveCreationId: cleanup["restoredActiveCreationId"],
        receipt: cleanup["receipt"],
      },
      currentCandidateQualified: false,
      physicalValidationPerformed: false,
    });
  }
  const features = manifestFeatures.map(
    (feature) =>
      imported.get(text(feature["id"])) || {
        id: feature["id"],
        status: "NOT_IMPORTED",
      },
  );
  const diagnostics = [...imported.values()].filter(
    (entry) =>
      !manifestFeatures.some((feature) => feature["id"] === entry["id"]),
  );
  return {
    schemaVersion: 1,
    kind: "distributed-native-evidence-review",
    assembledAt: new Date().toISOString(),
    nativeQualified: false,
    currentCandidateQualified: false,
    liveSdkRequestsSent: 0,
    features,
    diagnostics,
    verifiedFiles: [...verified.keys()],
    limitations: [
      "Integrity/identity review of explicit independent attestations; geometric/native validators were not rerun.",
      "Each feature retains its original source/build. No single integrated run, sequenceId, or current-candidate PASS is fabricated.",
      "Original failure/unknown observations and sampled/partial limits remain in recordedEvidence and referenced artifacts.",
      "NOT_IMPORTED means no supported evidence envelope was supplied, not proof that a feature was never tested.",
      "Grid coupling excludes arbitrary-angle precision; the parent Drive restore-failure live case remains unqualified.",
    ],
  };
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    assert.ok(
      args.length === 4 && args[0] === "--index" && args[2] === "--out",
      'Usage: --index <explicit-index["json"]> --out <new-report.json>',
    );
    const report = assemble(JSON.parse(fs.readFileSync(text(args[1]), "utf8")));
    fs.writeFileSync(text(args[3]), JSON.stringify(report, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        report: args[3],
        imported: report.features.filter((row) => row.status !== "NOT_IMPORTED")
          .length,
        diagnostics: report.diagnostics.length,
        verifiedFiles: report.verifiedFiles.length,
        currentCandidateQualified: false,
      }),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

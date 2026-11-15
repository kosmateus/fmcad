import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { PreparedPythonArtifact } from "../../packages/core/src/domain/python-artifact";

/** Pin the current public output independently of unavailable historical source. */
export function assertCurrentDocumentStatusAdmission(
  artifact: PreparedPythonArtifact,
): void {
  const evidence = JSON.parse(
    readFileSync(
      path.join(
        process.cwd(),
        "tests/fixtures/document-status-admission-current.json",
      ),
      "utf8",
    ),
  ) as {
    artifact: {
      wireHash: string;
      artifactHash: string;
      bytes: number;
      units: { id: string; filename: string; sha256: string }[];
    };
  };
  assert.equal(artifact.sha256, evidence.artifact.wireHash);
  assert.equal(artifact.artifactHash, evidence.artifact.artifactHash);
  assert.equal(artifact.bytes.length, evidence.artifact.bytes);
  assert.deepEqual(
    artifact.units.map(({ id, filename, sha256 }) => ({
      id,
      filename,
      sha256,
    })),
    evidence.artifact.units,
  );
  assert.equal(
    createHash("sha256").update(artifact.script).digest("hex"),
    artifact.sha256,
  );
  assert.deepEqual(Buffer.from(artifact.bytes), Buffer.from(artifact.script));
}

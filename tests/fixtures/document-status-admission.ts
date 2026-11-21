import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { PreparedPythonArtifact } from "../../packages/core/src/domain/python-artifact";

/** Pin exact public output for each supported source-checkout line ending. */
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
      checkoutProfile: string;
      wireHash: string;
      artifactHash: string;
      bytes: number;
      units: { id: string; filename: string; sha256: string }[];
      checkoutVariants: {
        checkoutProfile: string;
        wireHash: string;
        artifactHash: string;
        bytes: number;
        units: { id: string; filename: string; sha256: string }[];
      }[];
    };
  };
  const profile = [
    {
      checkoutProfile: evidence.artifact.checkoutProfile,
      wireHash: evidence.artifact.wireHash,
      artifactHash: evidence.artifact.artifactHash,
      bytes: evidence.artifact.bytes,
      units: evidence.artifact.units,
    },
    ...evidence.artifact.checkoutVariants,
  ].find(({ wireHash }) => wireHash === artifact.sha256);
  assert.ok(
    profile,
    `No pinned document.status artifact for wire hash ${artifact.sha256}`,
  );
  assert.equal(artifact.sha256, profile.wireHash);
  assert.equal(artifact.artifactHash, profile.artifactHash);
  assert.equal(artifact.bytes.length, profile.bytes);
  assert.deepEqual(
    artifact.units.map(({ id, filename, sha256 }) => ({
      id,
      filename,
      sha256,
    })),
    profile.units,
  );
  assert.equal(
    createHash("sha256").update(artifact.script).digest("hex"),
    artifact.sha256,
  );
  assert.deepEqual(Buffer.from(artifact.bytes), Buffer.from(artifact.script));
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { preparePythonArtifact } from "../../packages/node-adapters/src/python/artifact";
import type { PreparedPythonArtifact } from "../../packages/core/src/domain/python-artifact";

/** The retained candidate was captured from a CRLF working tree. Recreate only
 * those four source line endings, leaving injected owner lines and wrapper exact.
 * Historical bytes and every unit hash remain pinned; current certificates must
 * still bind the actual checkout bytes, never this reconstructed evidence. */
export function assertDocumentStatusAdmission(
  artifact: PreparedPythonArtifact,
): void {
  const evidence = JSON.parse(
    readFileSync(
      path.join(
        process.cwd(),
        "tests/fixtures/document-status-admission-6bb.json",
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
  const historical = preparePythonArtifact(
    artifact.units.map((unit) => {
      let source = unit.source;
      if (
        ["values", "fusion-values", "identity", "document_snapshot"].includes(
          unit.id,
        )
      ) {
        const owner =
          unit.id === "identity" || unit.id === "document_snapshot"
            ? `CAD_HANDLERS.owner = ${JSON.stringify(unit.id)}\n`
            : "";
        assert.ok(source.startsWith(owner));
        source =
          owner +
          source
            .slice(owner.length)
            .replace(/\r\n?/g, "\n")
            .replace(/\n/g, "\r\n");
      }
      return { id: unit.id, filename: unit.filename, role: unit.role, source };
    }),
    { context: artifact.context, request: artifact.request },
  );
  assert.equal(historical.sha256, evidence.artifact.wireHash);
  assert.equal(historical.artifactHash, evidence.artifact.artifactHash);
  assert.equal(historical.bytes.length, evidence.artifact.bytes);
  assert.deepEqual(
    historical.units.map(({ id, filename, sha256 }) => ({
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

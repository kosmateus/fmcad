import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { assertCurrentDocumentStatusAdmission } from "./fixtures/document-status-admission";
import { preparePythonArtifact } from "../packages/node-adapters/src/python/artifact";
import type { PreparedPythonArtifact } from "../packages/core/src/domain/python-artifact";
const load = createRequire(
  path.join(process.cwd(), "tests/document-status-evidence.test.ts"),
);
const cad = load("../src/cad") as {
  prepareCadScript(
    operation: string,
    data: unknown,
    context: unknown,
  ): PreparedPythonArtifact;
};
function fixture() {
  return cad.prepareCadScript(
    "document.status",
    {},
    {
      doc: "Model",
      docId: "creation",
      docFileId: "file",
      preview: false,
    },
  );
}
test("current document.status output matches its separate candidate manifest", () => {
  assertCurrentDocumentStatusAdmission(fixture());
});
test("current output cannot replace historical 6bb evidence", () => {
  const current = fixture();
  assertCurrentDocumentStatusAdmission(current);
  const historical = load("./fixtures/document-status-admission-6bb.json") as {
    candidateRuntimeCommit: string;
    profile: string;
    artifact: { wireHash: string; artifactHash: string };
  };
  assert.equal(
    historical.candidateRuntimeCommit,
    "6bb45185ce1b3a6595d1999528cf7cc990d9467b",
  );
  assert.equal(historical.profile, "document-status-6bb");
  assert.notEqual(current.sha256, historical.artifact.wireHash);
  assert.notEqual(current.artifactHash, historical.artifact.artifactHash);
});
test("current status evidence rejects changed behavior and altered target identity", () => {
  const artifact = fixture();
  const changed = preparePythonArtifact(
    artifact.units.map((unit) => ({
      ...unit,
      source:
        unit.id === "document_snapshot"
          ? unit.source.replace("doc.isSaved", "False")
          : unit.source,
    })),
    { context: artifact.context, request: artifact.request },
  );
  assert.throws(
    () => assertCurrentDocumentStatusAdmission(changed),
    assert.AssertionError,
  );
  const other = cad.prepareCadScript(
    "document.status",
    {},
    {
      doc: "Other",
      docId: "creation",
      docFileId: "file",
      preview: false,
    },
  );
  assert.throws(
    () => assertCurrentDocumentStatusAdmission(other),
    assert.AssertionError,
  );
});

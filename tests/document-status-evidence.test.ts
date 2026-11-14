import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { assertDocumentStatusAdmission } from "./fixtures/document-status-admission";
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
test("historical status evidence allows checkout newline changes without replacing pinned hashes", () => {
  assertDocumentStatusAdmission(fixture());
});
test("historical status evidence rejects changed behavior and altered target identity", () => {
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
    () => assertDocumentStatusAdmission(changed),
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
    () => assertDocumentStatusAdmission(other),
    assert.AssertionError,
  );
});

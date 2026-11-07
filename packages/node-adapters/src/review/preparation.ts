import type {
  ReviewPreparationPort,
  ReviewRequest,
} from "../../../core/src/application/review/contracts.js";
import {
  preparePythonArtifact,
  pythonLiteral,
  type SourceInput,
} from "../python/artifact.js";
import { documentIoFamilyUnits } from "../python/document-io-manifest.js";

export function prepareReviewArtifact(
  request: ReviewRequest,
  runtimeRoot: string,
) {
  let injected = false;
  const sources: SourceInput[] = [
    ...documentIoFamilyUnits(runtimeRoot, "identity"),
    ...documentIoFamilyUnits(runtimeRoot, "legacy-review"),
  ].map((unit) => {
    if (unit.id !== "legacy-review") return unit;
    const source = unit.source.replace(/^ARGS = .*$/m, () => {
      injected = true;
      return "ARGS = " + pythonLiteral(request);
    });
    return { ...unit, source };
  });
  if (!injected)
    throw new Error("Canonical review adapter has no ARGS assignment");
  return preparePythonArtifact(sources, {
    request: { operation: "review", ...request },
    context: {
      doc: request.doc,
      docId: request.docId,
      docFileId: request.docFileId,
    },
  });
}

export function createReviewPreparationPort(
  runtimeRoot: string,
): ReviewPreparationPort {
  return { prepare: (request) => prepareReviewArtifact(request, runtimeRoot) };
}

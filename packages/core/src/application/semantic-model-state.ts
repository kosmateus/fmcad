import type {
  SemanticFrameContextAuditData,
  SemanticSnapshotCaptureData,
  SemanticSnapshotDiffData,
} from "../domain/semantic-model-state";
import type {
  CadContext,
  CadData,
  CadOutput,
  CadServices,
} from "./cad/contracts";
import { executeCad } from "./cad/execute";

export type SemanticModelStateRequest =
  | {
      readonly operation: "frame.context_audit";
      readonly data: SemanticFrameContextAuditData;
    }
  | {
      readonly operation: "snapshot.capture_v2";
      readonly data: SemanticSnapshotCaptureData;
    }
  | {
      readonly operation: "snapshot.diff_v2";
      readonly data: SemanticSnapshotDiffData;
    };

/** Typed semantic request through the existing CAD artifact/execution boundary.
 * No second artifact port, executor, snapshot store, or unknown-outcome replay.
 */
export function executeSemanticModelState(
  request: SemanticModelStateRequest,
  context: Readonly<CadContext>,
  services: CadServices,
): Promise<CadOutput> {
  if (!context.docId && !context.docFileId) {
    throw new Error("Semantic observations require a pinned document identity");
  }
  return executeCad(
    request.operation,
    request.data as unknown as CadData,
    context,
    services,
  );
}

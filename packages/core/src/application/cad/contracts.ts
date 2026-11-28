import type { OperationDeclaration } from "../../catalog";
import type { PreparedPythonArtifact } from "../../domain/python-artifact";

/** Transport-neutral targeting. Output formatting belongs to the entrypoint. */
export interface CadContext {
  doc?: string | null;
  component?: string | Readonly<Record<string, unknown>> | null;
  projectId?: string | null;
  docId?: string | null;
  docFileId?: string | null;
  preview?: boolean;
  json?: boolean;
  summary?: boolean;
}
export type CadData = Record<string, unknown>;
export type CadOutput = Record<string, unknown>;
/** Private readback; never decoded as an input to the public operation. */
export interface CameraAliasObservation {
  readonly name: string;
  readonly raw: string;
  readonly docId: string;
  readonly observed?: readonly {
    readonly name: string;
    readonly raw: string;
  }[];
}
export interface CadExecutionRequest {
  operation: string;
  context: Readonly<CadContext>;
  artifact: PreparedPythonArtifact;
  readOnly: boolean;
}
export interface CadExecutionReply {
  text?: string;
  failed?: boolean;
}
/** One settled SDK turn. Implementations must not replay an unknown outcome. */
export interface CadExecutionPort {
  execute(request: CadExecutionRequest): Promise<CadExecutionReply>;
}
export interface CadServices {
  validate(operation: string, data: CadData): OperationDeclaration;
  prepare(
    operation: string,
    data: CadData,
    context: CadContext,
    cameraAlias?: CameraAliasObservation,
  ): PreparedPythonArtifact;
  execution: CadExecutionPort;
  /** Route selection is synchronous; a selected coordinator may be asynchronous.
   * An SDK request must be prepared before yielding caller-owned input data. */
  dispatch(
    operation: string,
    data: CadData,
    context: CadContext,
    entry: OperationDeclaration,
  ): CadOutput | Promise<CadOutput> | undefined;
  sketchValidates(operation: string): boolean;
  failed(output: unknown): boolean;
}
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

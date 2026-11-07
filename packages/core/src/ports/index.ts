import type {
  ArtifactId,
  Id,
  JobId,
  OperationRequest,
  OperationResult,
  RequestContext,
} from "../domain/contracts";
export interface Clock {
  nowMs(): number;
}
export interface IdGenerator {
  next<K extends string>(kind: K): Id<K>;
}
export interface ExecutionStore {
  read(jobId: JobId): Promise<OperationResult | null>;
  write(jobId: JobId, result: OperationResult): Promise<void>;
}
export interface ArtifactStore {
  read(context: RequestContext, artifactId: ArtifactId): Promise<string | null>;
  write(
    context: RequestContext,
    content: string,
    mediaType: string,
  ): Promise<ArtifactId>;
}
/** Only the broker composition root supplies physical dispatch. */
export interface PhysicalDispatch {
  dispatch(request: OperationRequest): Promise<OperationResult>;
  observe(context: RequestContext, jobId: JobId): Promise<OperationResult>;
}
export interface LocalProcess {
  run(input: {
    readonly artifactId: ArtifactId;
    readonly timeoutMs: number | null;
  }): Promise<{
    readonly exitCode: number | null;
    readonly stopped: boolean;
    readonly stdout: ArtifactId;
    readonly stderr: ArtifactId;
  }>;
}
export interface ScriptChecker {
  check(artifactId: ArtifactId): Promise<{
    readonly status: "pass" | "fail" | "unavailable";
    readonly diagnostics: ArtifactId | null;
  }>;
}
export * from "./event-sink";
export * from "./presence";
export * from "./brep-baseline";
export * from "./project-history";

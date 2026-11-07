import type { PreparedPythonArtifact } from "./python-artifact.js";

export type PythonCheckStatus =
  "passed" | "failed" | "incomplete" | "tool_error";
export interface PythonCheckDiagnostic {
  readonly severity: "error" | "warning" | "information";
  readonly message: string;
  readonly rule: string;
  readonly filename: string;
  readonly unitId: string | null;
  readonly line: number;
  readonly column: number;
}
/** Namespace availability is explicit, never inferred from an artifact label. */
export interface PythonCheckContext {
  readonly kind: "raw" | "run" | "bundle" | "cad-v1";
  readonly app?: boolean;
  readonly ui?: boolean;
  /** cad-v1 injects this instance only after module initialization. */
  readonly deferredFacade?: boolean;
  /** This namespace is invoked by the actual wrapper as run(stringContext). */
  readonly entrypoint?: "run" | "run-if-present";
}
export interface PythonCheckRequest {
  readonly artifact: PreparedPythonArtifact;
  readonly context: PythonCheckContext;
  /** Embedded namespaces do not inherit the wrapper's globals. */
  readonly unitContexts?: Readonly<Record<string, PythonCheckContext>>;
}
export interface PythonCheckAbortSignal {
  readonly aborted: boolean;
  addEventListener(
    type: "abort",
    listener: () => void,
    options?: { readonly once?: boolean },
  ): void;
  removeEventListener(type: "abort", listener: () => void): void;
}
export interface PythonCheckReport {
  readonly status: PythonCheckStatus;
  readonly diagnostics: readonly PythonCheckDiagnostic[];
  readonly reasons: readonly string[];
  readonly provenance: {
    readonly artifactHash: string;
    readonly wireHash: string;
    readonly checker: string;
    readonly checkerVersion: string;
    readonly checkerHash: string | null;
    readonly pythonVersion: string;
    readonly pythonInterpreterVersion: string | null;
    readonly definitionsHash: string | null;
    readonly contextHash: string;
    readonly configHash: string | null;
    readonly typingHash: string | null;
    readonly analysisHash: string | null;
    /** No report cache: a key is evidence identity, not permission to skip work. */
    readonly cache: "disabled";
  };
}
export interface PythonChecker {
  check(
    request: PythonCheckRequest,
    options?: { readonly signal?: PythonCheckAbortSignal },
  ): Promise<PythonCheckReport>;
}

import type { PythonJson } from "./python-artifact";

export type SemanticModelStateChannel =
  "geometry" | "pose" | "attributes" | "topology" | "visibility";

export type SemanticOccurrenceSubtree = readonly [string, ...string[]];

export interface SemanticSourceDocument {
  readonly creationId: string | null;
  readonly fileId: string | null;
  readonly version: number | null;
}

export interface SemanticDocumentPin {
  readonly creationId: string;
  readonly fileId: string;
  readonly version: number;
}

export interface SemanticModelScope {
  readonly kind: "explicit-bindings";
  readonly document: SemanticDocumentPin;
}

export interface SemanticModelBinding {
  readonly role: string;
  readonly sourceId: string;
  readonly ref: SemanticEntityReference;
  /** Complete root-qualified occurrence segments; [] selects a root body. */
  readonly instance: readonly string[];
}

export type SemanticEntityReference =
  | string
  | {
      readonly kind?: string;
      readonly token?: string;
      readonly name?: string;
      readonly component?: SemanticEntityReference;
      readonly occurrence?: SemanticEntityReference;
      readonly path?: readonly string[];
    };

export interface SemanticModelEntityObservation {
  readonly role: string;
  readonly source: {
    readonly id: string;
    readonly document: SemanticSourceDocument;
  };
  readonly instance: readonly string[];
  readonly geometry?: PythonJson;
  readonly pose?: PythonJson;
  readonly attributes?: PythonJson;
  readonly topology?: PythonJson;
  readonly visibility?: PythonJson;
  readonly observedTokens?: PythonJson;
}

export interface SemanticModelSnapshot {
  readonly schemaVersion: 2;
  readonly status: "partial";
  readonly coverage: "partial";
  readonly precision: "observational";
  readonly exactBRepEquivalence: false;
  readonly scope: SemanticModelScope;
  readonly entities: readonly SemanticModelEntityObservation[];
}

export interface SemanticFrameContextAuditData {
  readonly ref: SemanticEntityReference;
  readonly sourceId: string;
  readonly instance: readonly string[];
  readonly datumToRoot: readonly number[];
  readonly datumSource: {
    readonly kind: string;
    readonly version: string | number;
  };
  readonly lengthToleranceCm?: number;
  readonly matrixTolerance?: number;
}

export interface SemanticSnapshotCaptureData {
  readonly scope: SemanticModelScope;
  readonly bindings: readonly SemanticModelBinding[];
}

export interface SemanticSnapshotDiffData {
  readonly before: SemanticModelSnapshot;
  readonly after: SemanticModelSnapshot;
  readonly allowedMovedSubtrees?: readonly SemanticOccurrenceSubtree[];
  readonly tolerances?: Partial<Record<SemanticModelStateChannel, number>>;
}

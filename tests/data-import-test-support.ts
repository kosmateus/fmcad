import type { DataImportFiles } from "../packages/core/src/ports/data-import-files";
import type { ImportPlan } from "../packages/core/src/application/documents/data-import";
export interface ImportResult {
  parameters: {
    comment: string;
    unit: string;
    expression: string;
    provenance: { row: number; status: string };
  }[];
  counts: { ids: number; models: number; instances: number };
  instances: { id: string; item: string; parent: string | null }[];
  ledger: {
    id: string;
    purchase: number | null;
    physical: number;
    contents: number | null;
  }[];
  differences: {
    actual: unknown;
    status: string;
    distance: number;
    units: string;
  }[];
  bomProvenance: { path: string };
  delta: number[];
  model: { representation: string };
  mass: unknown;
  childrenPolicy: string;
  items: {
    id: string;
    parent: string | null;
    functionalGroups: string[];
    model: { representation: string; path: string; sha256: string };
  }[];
}
export interface Prepared extends Omit<
  ImportPlan,
  "result" | "provenance" | "unresolved"
> {
  result: ImportResult & Record<string, unknown>;
  provenance: { sha256: string };
  unresolved: { field: string }[];
}
export interface ImportExample extends Record<string, unknown> {
  model: { path: string; sha256?: string };
  datumMap: { name: string; old: unknown; new: unknown }[];
}
export interface ImportApi extends Pick<
  typeof import("../packages/core/src/application/documents/import-values"),
  "transform" | "multiply" | "inverse" | "csv"
> {
  descriptors: Record<string, { example: ImportExample }>;
  prepare(
    operation: string,
    data: Record<string, unknown>,
    files?: DataImportFiles,
  ): Prepared;
  offlineResult(plan: Prepared): {
    status: string;
    success: boolean;
    result: ImportResult;
  };
}

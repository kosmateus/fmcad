import assert from "node:assert/strict";
import type {
  PreparedPythonArtifact,
  PythonArtifactManifest,
} from "@fmcad/core";
import { at, list, number, record, text } from "./integration/offline-cli";

export function present<T>(value: T | undefined | null): T {
  assert.ok(value !== undefined && value !== null);
  return value;
}
/** These tests intentionally corrupt the private serialized manifest boundary. */
export interface MutableManifest extends Record<string, unknown> {
  units: Record<string, unknown>[];
  sourceMap: Record<string, unknown>[];
  context: unknown;
}
export function mutableManifest(
  manifest: PythonArtifactManifest,
): MutableManifest {
  const copy = record(structuredClone(manifest));
  return {
    ...copy,
    units: list(copy["units"]).map(record),
    sourceMap: list(copy["sourceMap"]).map(record),
    context: copy["context"],
  };
}
export function diagnostics(error: unknown): Record<string, unknown>[] {
  return list(at(error, "pythonCheck", "diagnostics")).map(record);
}
/** Retained origin inventories omit source bytes; their exact values remain compared below. */
export function retainedOrigin(artifact: PreparedPythonArtifact) {
  const origin = record(at(artifact.context, "origin"));
  return {
    ...origin,
    artifactHash: text(origin["artifactHash"]),
    sha256: text(origin["sha256"]),
    context: origin["context"],
    units: list(origin["units"]).map((value) => {
      const unit = record(value);
      return {
        ...unit,
        id: text(unit["id"]),
        filename: text(unit["filename"]),
        role: text(unit["role"]),
        sha256: text(unit["sha256"]),
      };
    }),
    sourceMap: list(origin["sourceMap"]).map((value) => {
      const entry = record(value);
      return {
        ...entry,
        unitId: text(entry["unitId"]),
        generatedStartLine: number(entry["generatedStartLine"]),
        generatedEndLine: number(entry["generatedEndLine"]),
        sourceStartLine: number(entry["sourceStartLine"]),
      };
    }),
  };
}

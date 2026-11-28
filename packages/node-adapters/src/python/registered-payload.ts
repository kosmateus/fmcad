import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { planPayloadDependencies, type PayloadDefinition } from "@fmcad/core";
import { preparePythonArtifact, type SourceInput } from "./artifact.js";

export interface CanonicalPayloadDefinition {
  readonly id: string;
  readonly filename: string;
  readonly symbol: string;
  readonly importName?: string;
  readonly guard?: string;
  /** Extract beneath the canonical guard for a single checker-only block. */
  readonly typeOnly?: boolean;
  readonly nullArguments?: readonly string[];
  readonly members?: readonly string[];
  readonly typingMembers?: readonly string[];
  readonly bindings?: Readonly<Record<string, Readonly<Record<string, null>>>>;
}

/** Resolve only selected source references; never substitute a complete unit. */
export function loadPayloadDefinitions(
  root: string,
  definitions: readonly CanonicalPayloadDefinition[],
): readonly SourceInput[] {
  if (!definitions.length) return [];
  const ids = new Set<string>();
  const files = new Map<string, string>();
  const input = definitions.map((definition) => {
    if (ids.has(definition.id))
      throw new Error(`Duplicate canonical source ID: ${definition.id}`);
    ids.add(definition.id);
    let source = files.get(definition.filename);
    if (source === undefined) {
      source = readFileSync(join(root, definition.filename), "utf8");
      files.set(definition.filename, source);
    }
    return { ...definition, source };
  });
  const encoded = JSON.stringify({ definitions: input });
  const parsed = spawnSync(
    "python3",
    [
      "-I",
      "-S",
      "-B",
      join(root, "runtime/python/entrypoints/payload_definitions.py"),
    ],
    {
      input: encoded,
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: Math.max(1024 * 1024, Buffer.byteLength(encoded) * 2),
    },
  );
  if (parsed.error || parsed.status !== 0)
    throw new Error(
      "Canonical payload extraction failed: " +
        (parsed.error?.message ?? parsed.stderr),
    );
  const result: unknown = JSON.parse(parsed.stdout);
  if (!Array.isArray(result) || result.length !== definitions.length)
    throw new Error("Invalid canonical payload extraction response");
  return definitions.map((definition, index) => {
    const item: unknown = result[index];
    if (
      typeof item !== "object" ||
      item === null ||
      !("id" in item) ||
      item.id !== definition.id ||
      !("source" in item) ||
      typeof item.source !== "string"
    )
      throw new Error("Invalid canonical payload extraction identity");
    return {
      id: definition.id,
      filename: `${definition.filename}#${definition.id}`,
      source: item.source,
      role: "runtime",
    };
  });
}

export function prepareCanonicalRegisteredPayload(
  root: string,
  registry: readonly PayloadDefinition[],
  references: readonly CanonicalPayloadDefinition[],
  roots: readonly string[],
  conditions: Readonly<Record<string, boolean>>,
  wrapper: SourceInput,
  metadata: { readonly context?: unknown; readonly request?: unknown } = {},
  typing: readonly CanonicalPayloadDefinition[] = [],
  projectedSources: readonly SourceInput[] = [],
) {
  const symbols = planPayloadDependencies(registry, roots, conditions);
  const byId = new Map<string, CanonicalPayloadDefinition>();
  for (const reference of references) {
    if (byId.has(reference.id))
      throw new Error(`Duplicate canonical source reference: ${reference.id}`);
    byId.set(reference.id, reference);
  }
  const definitions = new Map(registry.map((entry) => [entry.symbol, entry]));
  const sourceIds = new Set<string>();
  const selected = symbols.flatMap((symbol) => {
    const id = definitions.get(symbol)!.sourceId;
    if (sourceIds.has(id)) return [];
    sourceIds.add(id);
    const projected = projectedSources.filter((unit) => unit.id === id);
    if (projected.length) {
      if (
        projected.length !== 1 ||
        byId.has(id) ||
        projected[0]!.role !== "runtime"
      )
        throw new Error("Conflicting projected source: " + id);
      return [];
    }
    const reference = byId.get(id);
    if (!reference)
      throw new Error(`Missing canonical source reference: ${id}`);
    return [reference];
  });
  const loaded = new Map(
    [...loadPayloadDefinitions(root, selected), ...projectedSources].map(
      (unit) => [unit.id, unit],
    ),
  );
  const units = [...sourceIds].map((id) => loaded.get(id)!);
  if (typing.length) {
    const sources = loadPayloadDefinitions(
      root,
      typing.map((ref) => ({ ...ref, typeOnly: true })),
    );
    // A single lexical guard preserves forward type references across source
    // files. None of these definitions or typing imports execute inside Fusion.
    const selection = spawnSync(
      "python3",
      [
        "-I",
        "-S",
        "-B",
        join(root, "runtime/python/entrypoints/payload_definitions.py"),
      ],
      {
        input: JSON.stringify({
          typingClosure: true,
          runtime: [...units, wrapper].map((unit) => unit.source),
          types: sources.map((unit, i) => ({
            symbol: typing[i]!.symbol,
            source: unit.source,
          })),
        }),
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      },
    );
    if (selection.error || selection.status !== 0)
      throw new Error(
        "Registered type closure failed: " +
          (selection.error?.message ?? selection.stderr),
      );
    const indices: unknown = JSON.parse(selection.stdout);
    if (
      !Array.isArray(indices) ||
      indices.some(
        (i) => !Number.isInteger(i) || i < 0 || i >= sources.length,
      ) ||
      new Set(indices).size !== indices.length
    )
      throw new Error("Invalid registered type closure");
    const declaration = indices
      .map((i: number) => sources[i]!)
      .map((unit) =>
        unit.source
          .trimEnd()
          .split("\n")
          .map((line) => (line ? "    " + line : ""))
          .join("\n"),
      )
      .join("\n");
    const firstDefinition = units.findIndex(
      (unit) => !/^(import |from )/.test(unit.source),
    );
    units.splice(firstDefinition < 0 ? units.length : firstDefinition, 0, {
      id: "registered.types",
      filename: "<fmcad-registered-types>",
      role: "runtime",
      source:
        "from typing import TYPE_CHECKING\nif TYPE_CHECKING:\n" +
        declaration +
        "\n",
    });
  }
  return preparePythonArtifact([...units, wrapper], metadata);
}

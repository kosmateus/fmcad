import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  selectPythonSources,
  unusedPythonDefinitions,
  pythonSourceRewrites,
  type PythonSelectionFacts,
} from "@fmcad/core";
import { cadBundleManifest, cadBundleUnits } from "./bundle-inventory.js";
import type { SourceInput } from "./artifact.js";

const selectionCache = new WeakMap<
  readonly SourceInput[],
  Map<string, readonly SourceInput[]>
>();

/** The parser is an offline adapter: it never imports user code or the SDK. */
export function selectRunBundle(
  root: string,
  source: string,
  generated = false,
): readonly SourceInput[] {
  const original = cadBundleUnits(root);
  const key = createHash("sha256")
    .update(source)
    .update(generated ? "generated" : "user")
    .update(
      readFileSync(
        join(root, "runtime/python/entrypoints/dependency_facts.py"),
      ),
    )
    .digest("hex");
  let cached = selectionCache.get(original);
  const previous = cached?.get(key);
  if (previous) return previous;
  const retain = (selected: readonly SourceInput[]) => {
    const value = Object.freeze(selected.map((unit) => Object.freeze(unit)));
    if (!cached) {
      cached = new Map();
      selectionCache.set(original, cached);
    }
    if (cached.size >= 8) cached.delete(cached.keys().next().value!);
    cached.set(key, value);
    return value;
  };
  let units = original;
  while (true) {
    const next = selectDeclarations(
      root,
      source,
      generated,
      units,
      units !== original,
    );
    if (next === null) return retain(original);
    if (
      next.length === units.length &&
      next.every(
        (unit, index) =>
          unit.id === units[index]!.id && unit.source === units[index]!.source,
      )
    ) {
      if (units === original) {
        units = next;
        continue;
      }
      return retain(
        next.map((unit) => {
          const initial = original.find((entry) => entry.id === unit.id)!;
          if (unit.source === initial.source) return unit;
          const hash = createHash("sha256")
            .update(initial.source)
            .digest("hex");
          return {
            ...unit,
            source:
              unit.source +
              `\n# Automatic source selection; original-sha256=${hash}\n`,
          };
        }),
      );
    }
    units = next;
  }
}

/** Reanalyse the remaining declarations: deleted bodies cannot keep units alive. */
function selectDeclarations(
  root: string,
  source: string,
  generated: boolean,
  units: readonly SourceInput[],
  specialize: boolean,
): readonly SourceInput[] | null {
  const input = JSON.stringify({
    source,
    generated,
    specialize,
    units: units.map((unit) => ({
      ...unit,
      dependencies: cadBundleManifest.find((item) => item.id === unit.id)!
        .dependencies,
    })),
  });
  const parsed = spawnSync(
    "python3",
    [
      "-I",
      "-S",
      "-B",
      join(root, "runtime/python/entrypoints/dependency_facts.py"),
    ],
    {
      input,
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: Math.max(1024 * 1024, Buffer.byteLength(input) * 12),
    },
  );
  if (parsed.error || parsed.status !== 0)
    throw new Error(
      "Offline Python dependency analysis failed: " +
        (parsed.error?.message ?? parsed.stderr),
    );
  const result = JSON.parse(parsed.stdout) as {
    unsupported: boolean;
    facts: PythonSelectionFacts;
    spans: Record<string, readonly [number, number]>;
  };
  if (result.unsupported) return null;
  const selection = selectPythonSources(result.facts);
  if (selection.mode === "conservative") return null;
  const rewrites = pythonSourceRewrites(result.facts, selection);
  const unused = unusedPythonDefinitions(result.facts, selection);
  return units
    .filter((unit) => selection.units.includes(unit.id))
    .map((unit) => {
      const removed = unused.filter((entry) => entry.unit === unit.id);
      let bytes = Buffer.from(unit.source, "utf8");
      const lines = unit.source.split("\n");
      const starts = [0];
      for (const line of lines)
        starts.push(starts.at(-1)! + Buffer.byteLength(line) + 1);
      const edits: { byteStart: number; byteEnd: number; source: string }[] =
        [];
      const lineEdit = (start: number, end: number, prefix = "") => ({
        byteStart: starts[start - 1]!,
        byteEnd: starts[end - 1]! + Buffer.byteLength(lines[end - 1]!),
        source: prefix + "\n".repeat(end - start),
      });
      for (const entry of removed) {
        if (entry.byteStart === undefined || entry.byteEnd === undefined) {
          edits.push(
            lineEdit(entry.start, entry.end, " ".repeat(entry.column) + "pass"),
          );
          continue;
        }
        const masked = Buffer.from(
          bytes.subarray(entry.byteStart, entry.byteEnd),
        );
        for (let offset = 0; offset < masked.length; offset++)
          if (masked[offset] !== 10 && masked[offset] !== 13)
            masked[offset] = 32;
        edits.push({
          byteStart: entry.byteStart,
          byteEnd: entry.byteEnd,
          source: masked.toString("utf8"),
        });
      }
      for (const [method, [start, end]] of Object.entries(
        unit.id === "helpers" ? result.spans : {},
      )) {
        if (selection.methods.includes(method)) continue;
        edits.push(lineEdit(start, end));
      }
      for (const edit of rewrites.filter((edit) => edit.unit === unit.id))
        if (
          !edits.some(
            (removed) =>
              removed.byteStart < edit.byteEnd &&
              edit.byteStart < removed.byteEnd,
          )
        )
          edits.push(edit);
      const outer = edits.filter(
        (edit, index) =>
          !edits.some(
            (other, otherIndex) =>
              otherIndex !== index &&
              other.byteStart <= edit.byteStart &&
              other.byteEnd >= edit.byteEnd &&
              (other.byteStart < edit.byteStart ||
                other.byteEnd > edit.byteEnd ||
                otherIndex < index),
          ),
      );
      for (const edit of outer.sort((a, b) => b.byteStart - a.byteStart))
        bytes = Buffer.concat([
          bytes.subarray(0, edit.byteStart),
          Buffer.from(edit.source, "utf8"),
          bytes.subarray(edit.byteEnd),
        ]);
      const source = bytes.toString("utf8");
      if (source === unit.source) return unit;
      return {
        ...unit,
        source,
      };
    });
}

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  selectPythonSources,
  unusedPythonDefinitions,
  type PythonSelectionFacts,
} from "@fmcad/core";
import { cadBundleManifest, cadBundleUnits } from "./bundle-inventory.js";
import type { SourceInput } from "./artifact.js";

/** The parser is an offline adapter: it never imports user code or the SDK. */
export function selectRunBundle(
  root: string,
  source: string,
  generated = false,
): readonly SourceInput[] {
  const original = cadBundleUnits(root);
  let units = original;
  while (true) {
    const next = selectDeclarations(root, source, generated, units);
    if (next === null) return original;
    if (
      next.length === units.length &&
      next.every(
        (unit, index) =>
          unit.id === units[index]!.id && unit.source === units[index]!.source,
      )
    ) {
      return next.map((unit) => {
        const initial = original.find((entry) => entry.id === unit.id)!;
        if (unit.source === initial.source) return unit;
        const hash = createHash("sha256").update(initial.source).digest("hex");
        return {
          ...unit,
          source:
            unit.source +
            `\n# Automatic source selection; original-sha256=${hash}\n`,
        };
      });
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
): readonly SourceInput[] | null {
  const input = JSON.stringify({
    source,
    generated,
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
  const unused = unusedPythonDefinitions(result.facts, selection);
  return units
    .filter((unit) => selection.units.includes(unit.id))
    .map((unit) => {
      const removed = unused.filter((entry) => entry.unit === unit.id);
      const bytes = Buffer.from(unit.source, "utf8");
      for (const entry of removed) {
        if (entry.byteStart === undefined || entry.byteEnd === undefined)
          continue;
        for (let offset = entry.byteStart; offset < entry.byteEnd; offset++)
          if (bytes[offset] !== 10 && bytes[offset] !== 13) bytes[offset] = 32;
      }
      const lines = bytes.toString("utf8").split("\n");
      for (const entry of removed) {
        if (entry.byteStart !== undefined) continue;
        for (let line = entry.start - 1; line < entry.end; line++)
          lines[line] = "";
        lines[entry.start - 1] = " ".repeat(entry.column) + "pass";
      }
      for (const [method, [start, end]] of Object.entries(
        unit.id === "helpers" ? result.spans : {},
      )) {
        if (selection.methods.includes(method)) continue;
        for (let line = start - 1; line < end; line++) lines[line] = "";
      }
      if (lines.join("\n") === unit.source) return unit;
      return {
        ...unit,
        source: lines.join("\n"),
      };
    });
}

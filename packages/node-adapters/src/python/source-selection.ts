import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { selectPythonSources, type PythonSelectionFacts } from "@fmcad/core";
import { cadBundleManifest, cadBundleUnits } from "./bundle.js";
import type { SourceInput } from "./artifact.js";

/** The parser is an offline adapter: it never imports user code or the SDK. */
export function selectRunBundle(
  root: string,
  source: string,
): readonly SourceInput[] {
  const units = cadBundleUnits(root);
  const input = JSON.stringify({
    source,
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
  if (result.unsupported) return units;
  const selection = selectPythonSources(result.facts);
  if (selection.mode === "conservative") return units;
  return units
    .filter((unit) => selection.units.includes(unit.id))
    .map((unit) => {
      if (unit.id !== "helpers") return unit;
      const lines = unit.source.split("\n");
      for (const [method, [start, end]] of Object.entries(result.spans)) {
        if (selection.methods.includes(method)) continue;
        for (let line = start - 1; line < end; line++) lines[line] = "";
      }
      const original = createHash("sha256").update(unit.source).digest("hex");
      return {
        ...unit,
        source:
          lines.join("\n") +
          `\n# Automatic facade selection; original-sha256=${original}\n`,
      };
    });
}

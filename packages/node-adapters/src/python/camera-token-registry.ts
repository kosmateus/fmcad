import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SourceInput } from "./artifact.js";

export function planCameraToken(root: string, raw: string) {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("token" in value) ||
    typeof value.token !== "string" ||
    !value.token ||
    ("path" in value && value.path !== null) ||
    Object.keys(value).some(
      (key) => !["token", "kind", "name", "path"].includes(key),
    )
  )
    return null;
  const hash = createHash("sha256").update(raw).digest("hex");
  const symbol = "_camera_token_" + hash.slice(0, 16);
  const id = "camera.token." + hash;
  const filename = "runtime/python/fmcad/adapters/fusion/camera_alias.py";
  const process = spawnSync(
    "python3",
    [
      "-I",
      "-S",
      "-B",
      join(root, "runtime/python/entrypoints/camera_token_projection.py"),
    ],
    {
      input: JSON.stringify({
        raw,
        symbol,
        source: readFileSync(join(root, filename), "utf8"),
        core: readFileSync(join(root, "assets/cad/core.py"), "utf8"),
      }),
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    },
  );
  if (process.error || process.status !== 0)
    throw new Error(
      "Canonical camera token projection failed: " +
        (process.error?.message ?? process.stderr),
    );
  const result: unknown = JSON.parse(process.stdout);
  if (
    result === null ||
    typeof result !== "object" ||
    !("source" in result) ||
    typeof result.source !== "string" ||
    !("alwaysEligibleAliasTarget" in result) ||
    typeof result.alwaysEligibleAliasTarget !== "boolean"
  )
    throw new Error("Invalid canonical camera token projection");
  const projectedSources: readonly SourceInput[] = [
    {
      id,
      filename: filename + "#" + id,
      source: result.source,
      role: "runtime",
    },
  ];
  return {
    resolverSymbol: symbol,
    receiver: "design" as const,
    acceptsRaw: false as const,
    alwaysEligibleAliasTarget: result.alwaysEligibleAliasTarget,
    roots: [symbol],
    conditions: {},
    definitions: [
      { symbol, sourceId: id, dependencies: [{ symbol: "_cad_unique" }] },
    ],
    references: [],
    typingReferences: [
      {
        id: "camera.token.type.core",
        filename: "assets/cad/core.py",
        symbol: "adsk",
        importName: "adsk.core",
      },
      {
        id: "camera.token.type.fusion",
        filename: "assets/cad/core.py",
        symbol: "adsk",
        importName: "adsk.fusion",
      },
    ],
    projectedSources,
  };
}

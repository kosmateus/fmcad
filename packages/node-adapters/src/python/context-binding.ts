import type {
  PreparedPythonArtifact,
  PythonArtifactManifest,
  PythonCheckContext,
} from "@fmcad/core";
import { preparePythonArtifact, verifyPythonArtifact } from "./artifact.js";

function changed(message: string): never {
  throw Object.assign(new Error(message), {
    code: "PYTHON_CONTEXT_CHANGED",
    notStarted: true,
  });
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Context follows a verified source unit, never a filename or helper label
 * alone. Receipt and original-builder declarations describe separate namespaces. */
export function pythonUnitContexts(
  artifact: PreparedPythonArtifact,
): Readonly<Record<string, PythonCheckContext>> {
  const contexts = Object.create(null) as Record<string, PythonCheckContext>;
  const context = object(artifact.context);
  const origin = object(context["origin"]);
  const originalContext = object(origin["context"]);
  for (const values of [
    context["entrypoints"],
    originalContext["entrypoints"],
  ]) {
    if (values === undefined) continue;
    if (
      !Array.isArray(values) ||
      values.some((value) => typeof value !== "string")
    )
      changed("Invalid embedded entrypoint inventory");
    for (const filename of values) {
      const unit = artifact.units.find((unit) => unit.filename === filename);
      if (!unit)
        changed("Embedded entrypoint is absent from the final artifact");
      contexts[unit.id] = { kind: "raw", entrypoint: "run" };
    }
  }
  const declared = object(originalContext["unitContexts"]);
  const units = Array.isArray(origin["units"])
    ? origin["units"].map(object)
    : [];
  for (const [id, value] of Object.entries(declared)) {
    const source = units.find((unit) => unit["id"] === id);
    const target =
      source &&
      artifact.units.find(
        (unit) =>
          unit.sha256 === source["sha256"] &&
          unit.filename === source["filename"],
      );
    if (!target)
      changed("Original unit context has no matching final source namespace");
    const item = object(value);
    if (
      !Object.keys(item).every((key) =>
        ["kind", "app", "ui", "deferredFacade", "entrypoint"].includes(key),
      ) ||
      !["raw", "run", "bundle", "cad-v1"].includes(String(item["kind"])) ||
      ["app", "ui", "deferredFacade"].some(
        (key) => item[key] !== undefined && typeof item[key] !== "boolean",
      ) ||
      (item["entrypoint"] !== undefined &&
        !["run", "run-if-present"].includes(String(item["entrypoint"])))
    )
      changed("Invalid original Python namespace context");
    contexts[target.id] = {
      ...contexts[target.id],
      ...item,
    } as PythonCheckContext;
  }
  Object.values(contexts).forEach(Object.freeze);
  return Object.freeze(contexts);
}

export function pythonArtifactManifest(
  artifact: PreparedPythonArtifact,
): PythonArtifactManifest {
  verifyPythonArtifact(artifact);
  const { script: _script, bytes: _bytes, ...manifest } = artifact;
  void _script;
  void _bytes;
  return Object.freeze(manifest);
}

/** A receipt's compiled parent can still be mapped to the caller's original
 * concatenated units, but only when its exact original source hash matches. */
export function mapPythonOrigin(
  artifact: PreparedPythonArtifact,
  sourceHash: string,
  line: number,
  filename?: string,
): { filename: string; unitId: string; line: number } | null {
  const origin = object(object(artifact.context)["origin"]);
  if (!Array.isArray(origin["sourceMap"]) || !Array.isArray(origin["units"]))
    return null;
  const maps = origin["sourceMap"].map(object);
  const units = origin["units"].map(object);
  if (
    filename &&
    units.some(
      (unit) =>
        unit["filename"] === filename &&
        !maps.some((entry) => entry["unitId"] === unit["id"]),
    )
  )
    return null;
  if (origin["sha256"] !== sourceHash) {
    const segment = Array.isArray(origin["segments"])
      ? origin["segments"]
          .map(object)
          .find(
            (item) =>
              item["sha256"] === sourceHash &&
              typeof item["startLine"] === "number" &&
              typeof item["endLine"] === "number" &&
              line >= item["startLine"] &&
              line <= item["endLine"],
          )
      : undefined;
    if (!segment || typeof segment["startLine"] !== "number") return null;
    line = line - segment["startLine"] + 1;
  }
  const entry = maps.find(
    (item) =>
      typeof item["generatedStartLine"] === "number" &&
      typeof item["generatedEndLine"] === "number" &&
      line >= item["generatedStartLine"] &&
      line <= item["generatedEndLine"],
  );
  if (
    !entry ||
    typeof entry["sourceStartLine"] !== "number" ||
    typeof entry["generatedStartLine"] !== "number"
  )
    return null;
  const unit = units.find((item) => item["id"] === entry["unitId"]);
  if (
    !unit ||
    typeof unit["id"] !== "string" ||
    typeof unit["filename"] !== "string"
  )
    return null;
  return {
    filename: unit["filename"],
    unitId: unit["id"],
    line: line - entry["generatedStartLine"] + entry["sourceStartLine"],
  };
}

/** Verify source inventory against the actual input script, before a transport
 * appends guards or entrypoint calls. This is not a checker result/cache. */
export function bindPythonArtifactManifest(
  source: string,
  manifest: PythonArtifactManifest,
): PythonArtifactManifest {
  let reconstructed: PreparedPythonArtifact;
  try {
    const mapped = new Set(manifest.sourceMap.map((entry) => entry.unitId));
    reconstructed = preparePythonArtifact(
      manifest.units.map((unit) => ({
        ...unit,
        embedded: !mapped.has(unit.id),
      })),
      { context: manifest.context, request: manifest.request },
    );
  } catch {
    return changed("Original Python source inventory is invalid");
  }
  if (
    reconstructed.script !== source ||
    reconstructed.artifactHash !== manifest.artifactHash ||
    reconstructed.sha256 !== manifest.sha256 ||
    manifest.version !== 1 ||
    manifest.runtimeVersion !== "cad-v1"
  )
    changed(
      "Original Python inventory does not match the source being transformed",
    );
  return pythonArtifactManifest(reconstructed);
}

/** Preserve previously declared embedded units, including unused ones. Mapped
 * runtime units remain concatenated in their real shared namespace; analyzing
 * them as independent embedded modules would invent a different runtime. */
export function retainPythonOrigin(
  final: PreparedPythonArtifact,
  original: PythonArtifactManifest,
): PreparedPythonArtifact {
  verifyPythonArtifact(final);
  const originalMapped = new Set(
    original.sourceMap.map((entry) => entry.unitId),
  );
  const finalMapped = new Set(final.sourceMap.map((entry) => entry.unitId));
  const originalSource = original.units
    .filter((unit) => originalMapped.has(unit.id))
    .map((unit) => unit.source)
    .join("\n\n");
  original = bindPythonArtifactManifest(originalSource, original);
  const segments = final.units.flatMap((unit) => {
    const start = unit.source.indexOf(originalSource);
    const end = start + originalSource.length;
    if (
      start < 0 ||
      start !== unit.source.lastIndexOf(originalSource) ||
      (start > 0 && unit.source[start - 1] !== "\n") ||
      (end < unit.source.length && unit.source[end] !== "\n")
    )
      return [];
    const startLine = unit.source.slice(0, start).split("\n").length;
    return [
      {
        sha256: unit.sha256,
        startLine,
        endLine: startLine + originalSource.split("\n").length - 1,
      },
    ];
  });
  if (!segments.length)
    changed("Original Python namespace is absent from the final wire artifact");
  const missing = original.units.filter((unit) => {
    if (originalMapped.has(unit.id)) return false;
    const existing = final.units.find(
      (candidate) => candidate.filename === unit.filename,
    );
    if (existing && existing.sha256 !== unit.sha256)
      changed("Embedded Python source changed during transport wrapping");
    return !existing;
  });
  const context =
    final.context !== null &&
    typeof final.context === "object" &&
    !Array.isArray(final.context)
      ? final.context
      : {};
  return preparePythonArtifact(
    [
      ...final.units.map((unit) => ({
        ...unit,
        embedded: !finalMapped.has(unit.id),
      })),
      ...missing.map((unit) => ({
        ...unit,
        id: `origin:${unit.id}`,
        embedded: true,
      })),
    ],
    {
      context: {
        ...context,
        origin: {
          artifactHash: original.artifactHash,
          sha256: original.sha256,
          context: original.context,
          request: original.request,
          sourceMap: original.sourceMap,
          segments,
          units: original.units.map(({ id, filename, role, sha256 }) => ({
            id,
            filename,
            role,
            sha256,
          })),
        },
      },
      request: final.request,
    },
  );
}

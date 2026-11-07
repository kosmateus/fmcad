import { createHash } from "node:crypto";
import type {
  PreparedPythonArtifact,
  PythonJson,
  PythonSourceMapEntry,
  PythonSourceUnit,
} from "../../../core/src/domain/python-artifact.js";

const hash = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

/** Retains the legacy JSON policy: nonfinite numbers become null, undefined
 * object fields disappear, and JSON.stringify rejects cycles/BigInt. */
export function pythonValue(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined)
    throw new TypeError("Python payload must be JSON serializable");
  const ascii = serialized.replace(
    /[^\x00-\x7f]/g,
    (character) =>
      "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"),
  );
  return `__import__('json').loads(${JSON.stringify(ascii)})`;
}

/** Emit the normalized JSON value as Python syntax so generated wrappers stay typed. */
export function pythonLiteral(value: unknown): string {
  const encode = (item: PythonJson): string => {
    if (item === null) return "None";
    if (typeof item === "boolean") return item ? "True" : "False";
    if (typeof item === "number") return String(item);
    if (typeof item === "string")
      return (
        '"' +
        Array.from(item, (character) => {
          const point = character.codePointAt(0)!;
          if (point < 128) return JSON.stringify(character).slice(1, -1);
          return point <= 0xffff
            ? "\\u" + point.toString(16).padStart(4, "0")
            : "\\U" + point.toString(16).padStart(8, "0");
        }).join("") +
        '"'
      );
    if (Array.isArray(item)) return "[" + item.map(encode).join(", ") + "]";
    return (
      "{" +
      Object.entries(item)
        .map(([key, child]) => encode(key) + ": " + encode(child))
        .join(", ") +
      "}"
    );
  };
  return encode(freezeJson(value));
}

function freezeJson(value: unknown): PythonJson {
  const text = JSON.stringify(value);
  if (text === undefined)
    throw new TypeError("Artifact metadata must be JSON serializable");
  const copy: unknown = JSON.parse(text);
  const freeze = (item: unknown): void => {
    if (item && typeof item === "object") {
      Object.values(item).forEach(freeze);
      Object.freeze(item);
    }
  };
  freeze(copy);
  return copy as PythonJson;
}

export interface SourceInput {
  readonly id: string;
  readonly filename: string;
  readonly source: string;
  readonly role: PythonSourceUnit["role"];
  /** User code embedded in compile/exec is checked independently, not concatenated. */
  readonly embedded?: boolean;
}

export function preparePythonArtifact(
  inputs: readonly SourceInput[],
  metadata: { readonly context?: unknown; readonly request?: unknown } = {},
): PreparedPythonArtifact {
  const ids = new Set<string>();
  const filenames = new Set<string>();
  const units: PythonSourceUnit[] = [];
  const sourceMap: PythonSourceMapEntry[] = [];
  const parts: string[] = [];
  let line = 1;
  for (const input of inputs) {
    if (
      !input.id ||
      !input.filename ||
      ids.has(input.id) ||
      filenames.has(input.filename)
    ) {
      throw new Error("Duplicate or empty Python source unit identity");
    }
    ids.add(input.id);
    filenames.add(input.filename);
    units.push(
      Object.freeze({
        id: input.id,
        filename: input.filename,
        source: input.source,
        role: input.role,
        sha256: hash(input.source),
      }),
    );
    if (input.embedded) continue;
    const count = input.source.split("\n").length;
    sourceMap.push(
      Object.freeze({
        unitId: input.id,
        generatedStartLine: line,
        generatedEndLine: line + count - 1,
        sourceStartLine: 1,
      }),
    );
    parts.push(input.source);
    line += count + 1;
  }
  if (!parts.length) throw new Error("Python artifact has no executable units");
  const script = parts.join("\n\n");
  const bytes = Object.freeze(Array.from(Buffer.from(script, "utf8")));
  const context = freezeJson(metadata.context ?? null);
  const request = freezeJson(metadata.request ?? null);
  const sha256 = hash(Buffer.from(bytes));
  const artifactHash = hash(
    JSON.stringify({ version: 1, units, context, request, sourceMap, sha256 }),
  );
  return Object.freeze({
    version: 1,
    runtimeVersion: "cad-v1",
    units: Object.freeze(units),
    context,
    request,
    sourceMap: Object.freeze(sourceMap),
    script,
    bytes,
    sha256,
    artifactHash,
  });
}

export function verifyPythonArtifact(artifact: PreparedPythonArtifact): void {
  if (artifact.version !== 1 || artifact.runtimeVersion !== "cad-v1") {
    throw new Error("Unsupported prepared Python artifact version");
  }
  if (
    hash(Buffer.from(artifact.bytes)) !== artifact.sha256 ||
    !Buffer.from(artifact.bytes).equals(Buffer.from(artifact.script, "utf8"))
  ) {
    throw new Error("Prepared Python artifact bytes changed after preparation");
  }
  const expected = hash(
    JSON.stringify({
      version: 1,
      units: artifact.units,
      context: artifact.context,
      request: artifact.request,
      sourceMap: artifact.sourceMap,
      sha256: artifact.sha256,
    }),
  );
  if (
    expected !== artifact.artifactHash ||
    artifact.units.some((unit) => hash(unit.source) !== unit.sha256)
  ) {
    throw new Error(
      "Prepared Python artifact identity changed after preparation",
    );
  }
}

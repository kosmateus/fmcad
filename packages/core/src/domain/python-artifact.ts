/** Prepared source is immutable. Binding metadata must never rewrite checked code. */
export interface PythonSourceUnit {
  readonly id: string;
  readonly filename: string;
  readonly source: string;
  readonly role: "runtime" | "wrapper" | "user";
  readonly sha256: string;
}

export interface PythonSourceMapEntry {
  readonly unitId: string;
  readonly generatedStartLine: number;
  readonly generatedEndLine: number;
  readonly sourceStartLine: number;
}

export type PythonJson =
  | null
  | boolean
  | number
  | string
  | readonly PythonJson[]
  | {
      readonly [key: string]: PythonJson;
    };

export interface PreparedPythonArtifact {
  readonly version: 1;
  readonly runtimeVersion: "cad-v1";
  readonly units: readonly PythonSourceUnit[];
  readonly context: PythonJson;
  readonly request: PythonJson;
  readonly sourceMap: readonly PythonSourceMapEntry[];
  readonly script: string;
  /** Exact UTF-8 wire bytes, represented immutably rather than a mutable Buffer. */
  readonly bytes: readonly number[];
  readonly sha256: string;
  readonly artifactHash: string;
}

/** Private worker IPC inventory. The transport already carries script bytes;
 * duplicating their number[] representation would unnecessarily widen IPC. */
export type PythonArtifactManifest = Omit<
  PreparedPythonArtifact,
  "script" | "bytes"
>;

export function mapPythonPosition(
  artifact: PreparedPythonArtifact,
  filename: string,
  line: number,
): { filename: string; line: number; unitId: string } | null {
  if (!Number.isInteger(line) || line < 1) return null;
  const nested = artifact.units.find((unit) => unit.filename === filename);
  if (nested && line <= nested.source.split("\n").length) {
    return { filename, line, unitId: nested.id };
  }
  if (filename !== "<fmcad-artifact>") return null;
  const entry = artifact.sourceMap.find(
    (item) => line >= item.generatedStartLine && line <= item.generatedEndLine,
  );
  const unit = artifact.units.find((item) => item.id === entry?.unitId);
  return entry && unit
    ? {
        filename: unit.filename,
        line: line - entry.generatedStartLine + entry.sourceStartLine,
        unitId: unit.id,
      }
    : null;
}

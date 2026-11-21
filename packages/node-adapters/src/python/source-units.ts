import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { preparePythonArtifact } from "./artifact.js";
import type { PreparedPythonArtifact } from "../../../core/src/domain/python-artifact.js";

/** AST-only preparation of the actual wire wrapper and literal compile inputs.
 * The subprocess does not import adsk, evaluate user code or contact Fusion. */
export function prepareWireArtifact(
  runtime: string,
  source: string,
  metadata: { readonly context?: unknown; readonly request?: unknown } = {},
): PreparedPythonArtifact {
  return prepare(runtime, source, metadata, false);
}

/** Native-only envelope before outgoing request construction and certification. */
export function prepareEncodedWireArtifact(
  runtime: string,
  source: string,
  metadata: { readonly context?: unknown; readonly request?: unknown } = {},
): PreparedPythonArtifact {
  return prepare(runtime, source, metadata, true);
}

function prepare(
  runtime: string,
  source: string,
  metadata: { readonly context?: unknown; readonly request?: unknown },
  encodeNative: boolean,
): PreparedPythonArtifact {
  const result = spawnSync(
    "python3",
    ["-I", "-S", "-B", join(runtime, "entrypoints/source_units.py")],
    {
      input: JSON.stringify({ source, encodeNative }),
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 16 * 1024 * 1024 * 12,
    },
  );
  if (result.error || result.status !== 0) {
    throw Object.assign(
      new Error(
        "Python artifact preparation failed before dispatch: " +
          (result.error?.message ?? result.stderr),
      ),
      {
        code: "INVALID_PYTHON_ARTIFACT",
        notStarted: true,
        executionOutcome: "not_started",
        userScriptSubmitted: false,
        mayHaveMutated: false,
      },
    );
  }
  const extracted = JSON.parse(result.stdout) as {
    source: string;
    units: { filename: string; source: string }[];
  };
  return preparePythonArtifact(
    [
      ...extracted.units.map((unit, index) => ({
        ...unit,
        id: `embedded:${index}`,
        role: "user" as const,
        embedded: true,
      })),
      {
        id: "wire",
        filename: "<fmcad-wire>",
        source: extracted.source,
        role: "wrapper",
      },
    ],
    metadata,
  );
}

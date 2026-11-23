import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  prepareRun,
  validateRunRequest,
  type RunIdentity,
  type RunRequest,
  type RunSourceManifest,
  type RunUnit,
} from "@fmcad/core";
import { pythonLiteral, preparePythonArtifact } from "./artifact.js";
import { selectRunBundle } from "./source-selection.js";
import {
  resolveRuntimePaths,
  type RuntimePathsOptions,
} from "../config-platform/runtime-paths.js";

export interface RunScriptOptions extends Omit<RuntimePathsOptions, "anchor"> {
  readonly trustedStageContext?: unknown;
}

export interface RunSourcePorts {
  observeSource(filename: string, bytes: Buffer): void;
  verifySource(filename: string, bytes: Buffer): void;
}

function verifiedCadSourceManifest(
  root: string,
  source: string,
): RunSourceManifest | undefined {
  if (!source.includes("# Resolved manifest source units:")) return;
  const prelude = source.startsWith("DOC_NAME = None\n")
    ? "DOC_NAME = None\n"
    : "";
  const bundle = source.slice(prelude.length);
  let selected: ReturnType<typeof selectRunBundle>;
  try {
    selected = selectRunBundle(root, source);
  } catch {
    return;
  }
  const prepared = selected.map((unit) => unit.source).join("\n\n");
  if (!prepared || !bundle.startsWith(prepared)) return;
  const units: RunUnit[] = selected.map(({ id, filename, source, role }) => ({
    id,
    filename,
    source,
    role,
  }));
  return {
    units,
    userSource: prelude + bundle.slice(prepared.length),
  };
}

/** Read once: provenance, queue admission and preparation share the same bytes. */
export function createRunScriptAdapter(ports: RunSourcePorts) {
  function userScriptsDir(options: RunScriptOptions = {}): string {
    return resolveRuntimePaths({ anchor: __filename, ...options }).scripts;
  }

  function pkgScriptsDir(): string {
    return path.join(
      resolveRuntimePaths({ anchor: __filename }).assets,
      "scripts",
    );
  }

  function resolveScript(name: string, options: RunScriptOptions = {}): string {
    if (name.includes("/") || name.endsWith(".py")) {
      const file = path.resolve(name);
      if (existsSync(file)) return file;
      throw new Error(`script not found: ${file}`);
    }
    for (const directory of [userScriptsDir(options), pkgScriptsDir()]) {
      const file = path.join(directory, name + ".py");
      if (existsSync(file)) return file;
    }
    throw new Error(
      `script "${name}" not found in ${userScriptsDir(options)} or ${pkgScriptsDir()}`,
    );
  }

  function prepareRunScript(
    name: string,
    args: unknown,
    hasArgs: boolean,
    docName?: string,
    identity: RunIdentity = {},
    helperVersion?: string,
    readOnlyOperations: readonly string[] = [],
    options: RunScriptOptions = {},
  ) {
    const request: RunRequest = {
      name,
      args,
      hasArgs,
      ...(docName === undefined ? {} : { doc: docName }),
      identity,
      ...(helperVersion === undefined ? {} : { helperVersion }),
      readOnlyOperations,
    };
    validateRunRequest(request);
    const file = resolveScript(name, options);
    const bytes = readFileSync(file);
    ports.observeSource(file, bytes);
    ports.verifySource(file, bytes);
    const source = bytes.toString("utf8");
    const sourceManifest =
      helperVersion === undefined
        ? verifiedCadSourceManifest(
            resolveRuntimePaths({ anchor: __filename }).installation,
            source,
          )
        : undefined;
    return prepareRun(
      request,
      {
        filename: file,
        source,
        ...(sourceManifest ? { sourceManifest } : {}),
      },
      {
        pythonValue: pythonLiteral,
        prepare: preparePythonArtifact,
        runtime: (version, source) => {
          const paths = resolveRuntimePaths({ anchor: __filename });
          if (version)
            return selectRunBundle(paths.installation, source.source);
          const filename = "fmcad/adapters/fusion/identity.py";
          return [
            {
              id: "identity",
              filename: "runtime/python/" + filename,
              source: readFileSync(path.join(paths.runtime, filename), "utf8"),
              role: "runtime",
            },
          ];
        },
      },
      options.trustedStageContext,
    );
  }

  function buildRunScript(
    ...args: Parameters<typeof prepareRunScript>
  ): string {
    return prepareRunScript(...args).script;
  }

  function listScripts(options: RunScriptOptions = {}) {
    const entries: { name: string; dir: string }[] = [];
    for (const dir of [userScriptsDir(options), pkgScriptsDir()]) {
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir).sort()) {
        if (file.endsWith(".py"))
          entries.push({ name: file.replace(/\.py$/, ""), dir });
      }
    }
    return entries;
  }

  return {
    prepareRunScript,
    buildRunScript,
    resolveScript,
    userScriptsDir,
    pkgScriptsDir,
    listScripts,
  };
}

export {
  validateRunIdentity,
  validateRunOutput,
  formatRunOutput,
} from "@fmcad/core";

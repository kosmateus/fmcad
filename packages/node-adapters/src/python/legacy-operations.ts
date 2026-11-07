import * as fs from "node:fs";
import path from "node:path";
import {
  pythonValue,
  pythonLiteral,
  preparePythonArtifact,
  type SourceInput,
} from "./artifact.js";
import { resolveRuntimePaths } from "../config-platform/runtime-paths.js";
import { documentIoFamilyUnits } from "./document-io-manifest.js";

export const OPS: Readonly<Record<string, number>> = {
  projects: 0,
  project_create: 1,
  project_rename: 2,
  folder_list: 1,
  folder_create: 2,
  folder_rename: 3,
  folder_delete: 2,
  file_rename: 4,
  file_move: 4,
  file_delete: 3,
  file_editability: 0,
  file_editability_list: 0,
  tree: 1,
  param_list: 0,
  param_add: 2,
  param_set: 2,
  param_rename: 2,
  param_delete: 1,
  plane_list: 0,
  plane_add: 4,
  plane_rename: 2,
  plane_delete: 1,
  stats: 0,
  bbox: 0,
  bodies: 0,
  comp_list: 0,
  comp_add: 1,
  rollback: 1,
  units: 1,
  upload: 1,
};

export const DOCUMENT_OPS = [
  "param",
  "plane",
  "stats",
  "bbox",
  "bodies",
  "comp",
  "rollback",
  "units",
];

function scriptFileForOp(op: string) {
  if (
    op === "stats" ||
    op === "bbox" ||
    op === "bodies" ||
    op === "rollback" ||
    op === "units"
  )
    return "inspect.py";
  if (op === "comp_list" || op === "comp_add") return "component.py";
  if (op === "upload") return "upload.py";
  return "fusion_data_manager.py";
}

export function prepareOpScript(op: string, args: readonly string[]) {
  const paths = resolveRuntimePaths({ anchor: __filename });
  if (op.startsWith("param_") && Object.hasOwn(OPS, op)) {
    const filename = "fmcad/adapters/fusion/legacy_parameters.py";
    const source = fs
      .readFileSync(path.join(paths.runtime, filename), "utf8")
      .replace('OP = "help"', () => "OP = " + pythonLiteral(op))
      .replace(
        "ARGS: list[str] = []",
        () => "ARGS: list[str] = " + pythonLiteral(args),
      );
    return preparePythonArtifact(
      [
        {
          id: "legacy-parameters",
          filename: "runtime/python/" + filename,
          source,
          role: "wrapper",
        },
      ],
      { request: { op, args } },
    );
  }
  const family = (
    { "inspect.py": "legacy-inspect", "upload.py": "legacy-upload" } as Record<
      string,
      string
    >
  )[scriptFileForOp(op)];
  if (family) {
    const units = documentIoFamilyUnits(paths.runtime, family).map(
      (unit, index, all): SourceInput => ({
        ...unit,
        role: index === all.length - 1 ? "wrapper" : "runtime",
        source: unit.source
          .replace('OP = "help"', () => "OP = " + pythonLiteral(op))
          .replace(
            /ARGS(?:: list\[str\])? = \[\]/,
            () => "ARGS: list[str] = " + pythonLiteral(args),
          ),
      }),
    );
    return preparePythonArtifact(units, { request: { op, args } });
  }
  const file = path.join(paths.assets, scriptFileForOp(op));
  let code = fs.readFileSync(file, "utf8");
  code = code.replace('OP = "help"', () => "OP = " + pythonValue(op));
  code = code.replace("ARGS = []", () => "ARGS = " + pythonValue(args));
  return preparePythonArtifact(
    [
      {
        id: "operation",
        filename: "assets/" + scriptFileForOp(op),
        source: code,
        role: "wrapper",
      },
    ],
    { request: { op, args } },
  );
}

export function buildOpScript(op: string, args: readonly string[]) {
  return prepareOpScript(op, args).script;
}

export function prepareExportScript(args: readonly string[]) {
  const { runtime } = resolveRuntimePaths({ anchor: __filename });
  const units = documentIoFamilyUnits(runtime, "legacy-export").map(
    (unit, index, all): SourceInput => ({
      ...unit,
      role: index === all.length - 1 ? "wrapper" : "runtime",
      source: unit.source
        .replace('OP = "help"', 'OP = "export"')
        .replace("ARGS = []", () => "ARGS = " + pythonValue(args)),
    }),
  );
  return preparePythonArtifact(units, { request: { op: "export", args } });
}

export function buildExportScript(args: readonly string[]) {
  return prepareExportScript(args).script;
}

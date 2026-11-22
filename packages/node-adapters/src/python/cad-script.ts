import path from "node:path";
import {
  planCadScript,
  type CadContext,
  type CadData,
  type OperationDeclaration,
} from "@fmcad/core";
import { pythonLiteral } from "./artifact.js";
import { prepareCadBundle } from "./bundle.js";
import { resolveRuntimePaths } from "../config-platform/runtime-paths.js";
import { detectPlatform, toWindowsPath } from "../config-platform/platform.js";

interface ImportModel {
  path: string;
  fusionPath?: string;
}
export interface PreparedImport extends CadData {
  result: { model?: ImportModel; items?: { model?: ImportModel | null }[] };
}
export interface CadPreparationPorts {
  validate(operation: string, data: CadData): OperationDeclaration;
  inspection(data: CadData): CadData;
  curve(operation: string, data: CadData): CadData;
  dataImport(operation: string, data: CadData): PreparedImport;
}

type CheckpointJson =
  | string
  | number
  | boolean
  | null
  | readonly CheckpointJson[]
  | { readonly [key: string]: CheckpointJson };

export interface ParamCheckpointGuardV1 {
  readonly schema: "fmcad.param-checkpoint-v1";
  readonly document: {
    readonly identity: {
      readonly creationId: string;
      readonly name: string;
      readonly fileId: string | null;
      readonly version: number | null;
      readonly isSaved: boolean;
      readonly isModified: boolean;
    };
    readonly fingerprint: string;
  };
  readonly parameters: readonly {
    readonly name: string;
    readonly expression: string;
    readonly unit: string;
    readonly value: CheckpointJson;
    readonly valueType: "numeric" | "text";
    readonly valueUnits: string | null;
    readonly comment: string;
    readonly metadata: { readonly [key: string]: CheckpointJson };
  }[];
}

const PARAM_CHECKPOINT_FIELD = "_fmcadCheckpointGuard";

export function fusionPath(value: unknown): string {
  if (typeof value !== "string") throw new Error("File path must be a string");
  if (/^[A-Za-z]:[\\/]|^\\\\/.test(value)) return value;
  return toWindowsPath(path.resolve(value), detectPlatform());
}

interface PathFields extends CadData {
  parts?: { path: unknown }[];
  shots?: { path: unknown }[];
  frameFiles?: unknown[];
  frames?: unknown[];
}

/** Map a cloned payload only; validation and file reads stay at their existing boundaries. */
export function mapCadPaths(
  operation: string,
  data: CadData,
  pathMapper: (value: unknown) => string = fusionPath,
): CadData {
  const out = structuredClone(data) as PathFields;
  if (
    operation.startsWith("export.") ||
    operation.startsWith("checkpoint.") ||
    operation === "import.file"
  ) {
    if (out["path"]) out["path"] = pathMapper(out["path"]);
    if (out["directory"]) out["directory"] = pathMapper(out["directory"]);
    if (out.parts)
      for (const part of out.parts) part.path = pathMapper(part.path);
  }
  if (operation === "shot.pack")
    for (const shot of out.shots!) shot.path = pathMapper(shot.path);
  if (operation === "view.compare")
    for (const field of ["left", "right"]) out[field] = pathMapper(out[field]);
  if (operation === "texture.heightmap" && out["path"])
    out["path"] = pathMapper(out["path"]);
  if (
    ["motion.sample", "animation.joints", "explode.render"].includes(operation)
  ) {
    if (out["directory"]) out["directory"] = pathMapper(out["directory"]);
    if (out.frameFiles) out.frameFiles = out.frameFiles.map(pathMapper);
  }
  if (operation === "animation.export") {
    if (out.frames) out.frames = out.frames.map(pathMapper);
    if (out["output"]) out["output"] = pathMapper(out["output"]);
  }
  return out;
}

export function createCadScriptAdapter(ports: CadPreparationPorts) {
  function prepareCadScript(
    operation: string,
    data: CadData,
    context: CadContext,
    pathMapper: (value: unknown) => string = fusionPath,
    checkpointGuard?: ParamCheckpointGuardV1,
  ) {
    if (Object.hasOwn(data, PARAM_CHECKPOINT_FIELD))
      throw new Error("Parameter checkpoint guard is compiler-owned");
    if (checkpointGuard !== undefined && operation !== "param.apply")
      throw new Error("Parameter checkpoint guard is only valid for param.apply");
    const entry = ports.validate(operation, data);
    if (operation === "inspect.pack") data = ports.inspection(data);
    if (entry["curve"]) data = ports.curve(operation, data);
    if (entry.dataImport) {
      const imported = ports.dataImport(operation, data);
      const models =
        operation === "cots.replace"
          ? [imported.result.model!]
          : (imported.result.items ?? [])
              .map((row) => row.model)
              .filter((model): model is ImportModel => Boolean(model));
      for (const model of models) model.fusionPath = pathMapper(model.path);
      data = imported;
    }
    const preparedData = mapCadPaths(operation, data, pathMapper);
    if (checkpointGuard !== undefined)
      preparedData[PARAM_CHECKPOINT_FIELD] = structuredClone(checkpointGuard);
    const plan = planCadScript(
      operation,
      preparedData,
      context,
      entry,
      pythonLiteral,
    );
    return prepareCadBundle(
      resolveRuntimePaths({ anchor: __filename }).installation,
      plan.wrapper,
      { request: plan.request, context: plan.context },
      plan.profile,
    );
  }
  function buildCadScript(
    ...args: Parameters<typeof prepareCadScript>
  ): string {
    return prepareCadScript(...args).script;
  }
  return { prepareCadScript, buildCadScript };
}

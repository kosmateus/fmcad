import { createRequire } from "node:module";
import { parentPort } from "node:worker_threads";
import type { CadContext, CadData, QueueRequest } from "@fmcad/core";
import type { PreparedPythonArtifact } from "../packages/core/src/domain/python-artifact.js";
import type { ParamCheckpointGuardV1 } from "../packages/node-adapters/src/python/cad-script.js";
import type { ContinuationPrograms } from "./document-continuation-broker.js";

const load = createRequire(__filename);
const { compileDocumentContinuationPrograms } = load(
  "./document-continuation-broker.js",
) as {
  compileDocumentContinuationPrograms(
    request: QueueRequest,
    checkpoint: ParamCheckpointGuardV1,
  ): ContinuationPrograms;
};
const { prepareCadScript } = load("./dist/composition/cad.js") as {
  prepareCadScript(
    operation: string,
    data: CadData,
    context: CadContext,
    pathMapper: ((value: unknown) => string) | undefined,
    checkpoint?: ParamCheckpointGuardV1,
    privateReadback?: "param-checkpoint",
  ): PreparedPythonArtifact;
};

type CompilerTask =
  | {
      id: number;
      kind: "continuation";
      request: QueueRequest;
      checkpoint: ParamCheckpointGuardV1;
    }
  | {
      id: number;
      kind: "cad";
      operation: string;
      data: CadData;
      context: CadContext;
      checkpoint?: ParamCheckpointGuardV1;
      privateReadback?: "param-checkpoint";
    };

function objectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function compilerTask(value: unknown): value is CompilerTask {
  if (!objectRecord(value) || !Number.isSafeInteger(value["id"])) return false;
  if (value["kind"] === "continuation")
    return (
      onlyKeys(value, ["id", "kind", "request", "checkpoint"]) &&
      objectRecord(value["request"]) &&
      objectRecord(value["checkpoint"])
    );
  return (
    value["kind"] === "cad" &&
    onlyKeys(value, [
      "id",
      "kind",
      "operation",
      "data",
      "context",
      "checkpoint",
      "privateReadback",
    ]) &&
    typeof value["operation"] === "string" &&
    value["operation"].length > 0 &&
    objectRecord(value["data"]) &&
    objectRecord(value["context"]) &&
    (value["checkpoint"] === undefined || objectRecord(value["checkpoint"])) &&
    (value["privateReadback"] === undefined ||
      value["privateReadback"] === "param-checkpoint")
  );
}

function errorResponse(id: number, error: unknown) {
  const value =
    error && typeof error === "object" && error instanceof Error
      ? error
      : new Error("Source compilation failed");
  const code =
    "code" in value && typeof value.code === "string"
      ? value.code.slice(0, 128)
      : undefined;
  return {
    id,
    ok: false as const,
    error: {
      name:
        typeof value.name === "string"
          ? value.name.slice(0, 128) || "Error"
          : "Error",
      message:
        typeof value.message === "string"
          ? value.message.slice(0, 2048) || "Source compilation failed"
          : "Source compilation failed",
      ...(code === undefined ? {} : { code }),
    },
  };
}

function compile(task: CompilerTask): unknown {
  switch (task.kind) {
    case "continuation":
      return compileDocumentContinuationPrograms(task.request, task.checkpoint);
    case "cad":
      return prepareCadScript(
        task.operation,
        task.data,
        task.context,
        undefined,
        task.checkpoint,
        task.privateReadback,
      );
  }
}

if (!parentPort) throw new Error("Source compiler worker needs a parent port");

function postResult(id: number, result: unknown): void {
  try {
    parentPort!.postMessage({ id, ok: true, result });
  } catch (error) {
    parentPort!.postMessage(errorResponse(id, error));
  }
}

parentPort.on("message", (value: unknown) => {
  if (!compilerTask(value)) {
    const id =
      objectRecord(value) && Number.isSafeInteger(value["id"])
        ? (value["id"] as number)
        : -1;
    parentPort!.postMessage(
      errorResponse(id, new Error("Invalid source compiler task")),
    );
    return;
  }
  try {
    postResult(value.id, compile(value));
  } catch (error) {
    parentPort!.postMessage(errorResponse(value.id, error));
  }
});

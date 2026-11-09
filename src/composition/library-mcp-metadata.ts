import { description } from "@fmcad/core";
import type { JsonRpcRequest } from "./library-mcp-protocol";
export interface QueueMetadataOptions {
  sequence?: { action: "continue" | "end"; id: string };
  expectedRevision?: number;
  requestId?: string;
  description?: string | undefined;
  projectDirectory?: string;
  roots?: { uri: string; name?: string }[];
  sessionId?: string;
  doc?: string;
  docId?: string;
  docFileId?: string;
  projectId?: string;
  purpose?: string;
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const identifier = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 256;
function invalidQueueParams(message: string): never {
  throw Object.assign(new Error(message), { code: "INVALID_QUEUE_PARAMS" });
}

export function queueMetadata(request: JsonRpcRequest): {
  payload: JsonRpcRequest;
  options: QueueMetadataOptions;
} {
  const meta = request.params?.["_meta"];
  if (
    request.method !== "tools/call" ||
    !object(meta) ||
    !Object.hasOwn(meta, "fmcad")
  )
    return { payload: request, options: {} };
  const options = meta["fmcad"];
  if (
    !object(options) ||
    Object.keys(options).some(
      (key) =>
        ![
          "sequence",
          "expectedRevision",
          "requestId",
          "description",
          "projectDirectory",
          "roots",
          "sessionId",
          "doc",
          "docId",
          "docFileId",
          "projectId",
          "purpose",
        ].includes(key),
    )
  ) {
    invalidQueueParams(
      "params._meta.fmcad accepts only queue options and validated client context fields",
    );
  }
  if (options["description"] !== undefined) description(options["description"]);
  if (options["sequence"] !== undefined) {
    const seq = options["sequence"];
    if (
      !object(seq) ||
      Object.keys(seq).some((key) => !["action", "id"].includes(key)) ||
      typeof seq["action"] !== "string" ||
      !["continue", "end"].includes(seq["action"]) ||
      !identifier(seq["id"])
    ) {
      invalidQueueParams(
        "sequence requires action continue|end and id; begin with fmcad_queue_begin",
      );
    }
  }
  if (
    options["expectedRevision"] !== undefined &&
    (typeof options["expectedRevision"] !== "number" ||
      !Number.isSafeInteger(options["expectedRevision"]) ||
      options["expectedRevision"] < 0)
  ) {
    invalidQueueParams("expectedRevision must be a nonnegative safe integer");
  }
  if (options["requestId"] !== undefined && !identifier(options["requestId"]))
    invalidQueueParams("requestId must contain 1..256 characters");
  if (options["sessionId"] !== undefined && !identifier(options["sessionId"]))
    invalidQueueParams("sessionId must contain 1..256 characters");
  for (const key of ["doc", "docId", "docFileId", "projectId"]) {
    if (options[key] !== undefined && !identifier(options[key]))
      invalidQueueParams(key + " must contain 1..256 characters");
  }
  if (options["purpose"] !== undefined) description(options["purpose"]);
  if (
    options["description"] !== undefined &&
    options["purpose"] !== undefined &&
    options["description"] !== options["purpose"]
  ) {
    invalidQueueParams("Conflicting purpose and description");
  }
  if (
    options["projectDirectory"] !== undefined &&
    (!identifier(options["projectDirectory"]) ||
      options["projectDirectory"].length > 4096)
  ) {
    invalidQueueParams("projectDirectory must contain 1..4096 characters");
  }
  if (
    options["roots"] !== undefined &&
    (!Array.isArray(options["roots"]) ||
      options["roots"].length > 32 ||
      options["roots"].some(
        (root) =>
          !object(root) ||
          Object.keys(root).some((key) => !["uri", "name"].includes(key)) ||
          !identifier(root["uri"]) ||
          (root["name"] !== undefined && typeof root["name"] !== "string"),
      ))
  ) {
    invalidQueueParams(
      "roots must be at most 32 local MCP root hints with a URI and optional name",
    );
  }
  const upstreamMeta = { ...meta };
  delete upstreamMeta["fmcad"];
  const params: Record<string, unknown> = {
    ...request.params,
    _meta: upstreamMeta,
  };
  if (!Object.keys(upstreamMeta).length) delete params["_meta"];
  return {
    payload: { ...request, params },
    options: {
      ...options,
      ...(options["description"] !== undefined
        ? { description: description(options["description"]) }
        : {}),
    } as QueueMetadataOptions,
  };
}

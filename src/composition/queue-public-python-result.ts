import { createHash } from "node:crypto";
import { isDeepStrictEqual as same } from "node:util";
import type * as P from "../queue-broker-ports";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

/** A retained receipt is evidence only for its exact original execution. */
export function verifyBoundRemoteReceipt(
  record: Pick<P.RecordEvidence, "binding" | "instance">,
  receipt: P.RemoteReceipt,
): P.RemoteReceipt {
  const binding = record.binding;
  if (
    receipt.terminal !== true ||
    !["succeeded", "failed"].includes(receipt.outcome) ||
    !["jobId", "rpcId", "requestHash", "buildHash", "sourceHash"].every(
      (key) => receipt[key] === binding[key],
    ) ||
    !receipt.instance ||
    !record.instance ||
    receipt.instance.pid !== record.instance.pid ||
    receipt.instance.birth !== record.instance.birth ||
    receipt.instance.version !== record.instance.version
  )
    fail(
      "RECEIPT_MISMATCH",
      "Receipt is not terminal or bound to the original request/instance/build",
    );
  return receipt;
}

/** Adapt only the caller's copy; original wire responses and receipts stay intact. */
export function responseForCaller(
  response: P.Response,
  request: P.Rpc,
  reply: P.Reply | null,
  publicPythonValue?: Record<string, unknown>,
) {
  if (publicPythonValue && reply && !reply.error) {
    reply = {
      ...reply,
      result: {
        isError: false,
        content: [{ type: "text", text: JSON.stringify(publicPythonValue) }],
      },
    };
  }
  if (
    request.method === "tools/call" &&
    request.params?.name === "execute_python" &&
    reply &&
    !reply.error
  ) {
    const result = object(reply.result),
      content = result["content"];
    if (
      Array.isArray(content) &&
      content.length === 1 &&
      object(content[0])["type"] === "text"
    ) {
      try {
        const outer = object(JSON.parse(String(object(content[0])["text"])));
        if (outer["success"] === true && typeof outer["message"] === "string") {
          const value = object(JSON.parse(outer["message"]));
          if (
            typeof value["success"] === "boolean" &&
            typeof value["stdout"] === "string" &&
            typeof value["stderr"] === "string"
          ) {
            reply = {
              ...reply,
              result: {
                ...result,
                isError: value["success"] !== true,
                content: [{ type: "text", text: JSON.stringify(value) }],
              },
            };
          }
        }
      } catch {
        // Not the native compatibility envelope: preserve the original reply.
      }
    }
  }
  return Object.hasOwn(request, "id")
    ? { ...response, raw: JSON.stringify({ ...reply, id: request.id }) }
    : response;
}

function boundPublicPythonValue(
  record: P.RecordEvidence,
  receipt: P.RemoteReceipt,
  request: P.Rpc,
  reply: P.Reply | null,
): Record<string, unknown> {
  const schema = "fmcad-public-python-result-v1";
  const result = object(receipt["publicPythonResult"]),
    value = object(result["value"]);
  const allowed = new Set([
    ...Object.keys(record.binding),
    "terminal",
    "outcome",
    "instance",
    "publicPythonResult",
  ]);
  if (
    record.binding["publicPythonResultSchema"] !== schema ||
    request.params?.name !== "execute_python" ||
    typeof request.params.arguments?.code !== "string" ||
    createHash("sha256").update(request.params.arguments.code).digest("hex") !==
      record.binding.sourceHash ||
    !Object.entries(record.binding).every(([key, expected]) =>
      same(receipt[key], expected),
    ) ||
    Object.keys(receipt).some((key) => !allowed.has(key)) ||
    receipt.terminal !== true ||
    receipt.outcome !== "succeeded" ||
    Object.keys(result).length !== 2 ||
    result["schema"] !== schema ||
    Object.keys(value).length !== 3 ||
    value["success"] !== true ||
    typeof value["stdout"] !== "string" ||
    typeof value["stderr"] !== "string" ||
    !reply ||
    reply.error ||
    object(reply.result)["isError"] === true
  )
    fail(
      "RECEIPT_MISMATCH",
      "Fresh public Python result is incomplete or differs from its exact native binding",
    );
  const content = object(reply.result)["content"];
  if (
    Object.keys(object(reply.result)).some(
      (key) => !["content", "isError"].includes(key),
    )
  )
    fail(
      "UNKNOWN_RPC",
      "Public Python native response has an unsupported result envelope",
    );
  if (
    !Array.isArray(content) ||
    content.length !== 1 ||
    object(content[0])["type"] !== "text"
  )
    fail(
      "UNKNOWN_RPC",
      "Public Python native response has no canonical result envelope",
    );
  let outer: Record<string, unknown>;
  try {
    outer = object(JSON.parse(String(object(content[0])["text"])));
  } catch {
    fail("UNKNOWN_RPC", "Public Python native response is malformed");
  }
  if (
    Object.keys(outer).length !== 2 ||
    outer["success"] !== true ||
    typeof outer["message"] !== "string"
  )
    fail(
      "UNKNOWN_RPC",
      "Public Python native response conflicts with its terminal result",
    );
  if (outer["message"]) {
    let wireValue: unknown;
    try {
      wireValue = JSON.parse(outer["message"]);
    } catch {
      fail("UNKNOWN_RPC", "Public Python wire result is malformed");
    }
    if (!same(wireValue, value))
      fail(
        "RECEIPT_MISMATCH",
        "Public Python wire result conflicts with its bound native result",
      );
  }
  return value;
}

/** Complete retained-native result boundary. This function never executes SDK. */
export function decodeBoundPublicPythonResponse(
  record: P.RecordEvidence,
  receipt: P.RemoteReceipt,
  request: P.Rpc,
  response: P.Response,
  reply: P.Reply | null,
): P.Response {
  verifyBoundRemoteReceipt(record, receipt);
  return responseForCaller(
    response,
    request,
    reply,
    boundPublicPythonValue(record, receipt, request, reply),
  );
}

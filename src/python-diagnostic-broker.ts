import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createRequire } from "node:module";
import type { QueueRequest } from "@fmcad/core";
import type { ProtocolMetadataPins } from "./protocol-metadata-broker";

const load = createRequire(__filename);
const { hash } = load(
  "./dist/core/application/cad/json",
) as typeof import("../packages/core/src/application/cad/json");
type RecordValue = Record<string, unknown>;
export interface DiagnosticRequest extends QueueRequest {
  readonly backend?: string;
  readonly readOnly?: boolean;
}
export interface DiagnosticEffectResult {
  readonly status: "proven" | "unproven";
  readonly sourceSha256: string;
  readonly engineVersion: string;
  readonly effect?: string;
}
export interface DiagnosticPreparationPorts {
  readonly engineVersion: string;
  /** An analysis result is not authority. The caller must separately establish
   * the execution environment required by the analyzer's primitive semantics. */
  analyze(
    source: string,
  ): DiagnosticEffectResult | Promise<DiagnosticEffectResult>;
  currentPins(): ProtocolMetadataPins;
  recheck(): void;
}
function refuse(): never {
  throw Object.assign(
    new Error("A current exact diagnostic analysis is required"),
    {
      code: "PYTHON_DIAGNOSTIC_UNPROVEN",
    },
  );
}
function object(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse();
  return value as RecordValue;
}
const sha = (source: string) =>
  createHash("sha256").update(source, "utf8").digest("hex");
function requestHash(request: QueueRequest) {
  const { description, ...bound } = request;
  void description;
  return hash(bound);
}
function pins(ports: DiagnosticPreparationPorts) {
  const checked: unknown = ports.recheck();
  if (checked !== undefined) {
    void Promise.resolve(checked).catch(() => {});
    refuse();
  }
  const current = ports.currentPins();
  if (
    !current ||
    Object.keys(current).sort().join() !== "buildHash,configHash,generation" ||
    !/^[a-f0-9]{64}$/.test(current.buildHash) ||
    !/^[a-f0-9]{64}$/.test(current.configHash) ||
    typeof current.generation !== "string" ||
    !current.generation.trim() ||
    current.generation.length > 256
  )
    refuse();
  return Object.freeze({ ...current });
}
function sourceOf(request: QueueRequest): string | null {
  if (request.kind !== "rpc") return null;
  const rpc = object(request.payload);
  if (rpc["method"] !== "tools/call") return null;
  const params = object(rpc["params"]);
  if (
    !["execute_python", "fusion_mcp_execute"].includes(String(params["name"]))
  )
    return null;
  if (
    rpc["jsonrpc"] !== "2.0" ||
    Object.keys(rpc).some(
      (key) => !["jsonrpc", "id", "method", "params"].includes(key),
    ) ||
    Object.keys(params).sort().join() !== "arguments,name"
  )
    refuse();
  const args = object(params["arguments"]);
  if (params["name"] === "execute_python") {
    if (
      Object.keys(args).sort().join() !== "code,persistent" ||
      typeof args["code"] !== "string" ||
      args["persistent"] !== false
    )
      refuse();
    return args["code"];
  }
  if (
    Object.keys(args).sort().join() !== "featureType,object" ||
    args["featureType"] !== "script"
  )
    refuse();
  const script = object(args["object"]);
  if (
    Object.keys(script).some((key) => !["script", "readOnly"].includes(key)) ||
    typeof script["script"] !== "string" ||
    (script["readOnly"] !== undefined &&
      typeof script["readOnly"] !== "boolean")
  )
    refuse();
  // A caller's readOnly flag is neither necessary nor sufficient evidence.
  return script["script"];
}

/** Preparation ONLY. No domain capability, environment attestation or SDK grant
 * can be obtained from this descriptor, including by serializing it. */
export async function preparePythonDiagnostic(
  input: DiagnosticRequest,
  ports: DiagnosticPreparationPorts,
) {
  const request = structuredClone(input);
  const source = sourceOf(request);
  if (source === null) return null;
  const initial = pins(ports);
  if (
    request.backend !== "addin" ||
    request.buildHash !== initial.buildHash ||
    typeof request.clientId !== "string" ||
    !request.clientId.trim() ||
    typeof request.requestId !== "string" ||
    !request.requestId.trim() ||
    typeof request.ownerToken !== "string" ||
    !/^[a-f0-9]{64}$/.test(request.ownerToken)
  )
    refuse();
  const originalHash = requestHash(request),
    sourceHash = sha(source);
  const result = await ports.analyze(source);
  if (
    !isDeepStrictEqual(pins(ports), initial) ||
    result.status !== "proven" ||
    result.sourceSha256 !== sourceHash ||
    result.effect !== "stdout-and-readonly-metadata" ||
    result.engineVersion !== ports.engineVersion ||
    typeof result.engineVersion !== "string" ||
    !result.engineVersion.trim() ||
    result.engineVersion.length > 256
  )
    refuse();
  const descriptor = Object.freeze({
    version: 1 as const,
    kind: "python-diagnostic-preparation" as const,
    requestHash: originalHash,
    rpcHash: hash(request.payload),
    sourceHash,
    engineVersion: result.engineVersion,
    ...initial,
  });
  const reverify = (current: QueueRequest) => {
    if (
      !isDeepStrictEqual(pins(ports), initial) ||
      requestHash(current) !== originalHash ||
      sourceOf(current) !== source
    )
      refuse();
  };
  reverify(request);
  return Object.freeze({
    descriptor,
    reverify,
    assertSource(current: QueueRequest, actual: string) {
      reverify(current);
      if (actual !== source || sha(actual) !== sourceHash) refuse();
    },
    assertRpc(current: QueueRequest, actual: unknown) {
      reverify(current);
      if (hash(actual) !== descriptor.rpcHash) refuse();
    },
  });
}

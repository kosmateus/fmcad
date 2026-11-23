import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import type { QueueRequest } from "@fmcad/core";

const load = createRequire(__filename);
const { hash } = load(
  "./dist/core/application/cad/json",
) as typeof import("../packages/core/src/application/cad/json");

export interface ProtocolMetadataPins {
  readonly buildHash: string;
  readonly configHash: string;
  readonly generation: string;
}
export interface ProtocolMetadataPorts {
  currentPins(): ProtocolMetadataPins;
  /** Broker-owned synchronous source/root/owner verification. */
  recheck(): void;
}
export interface CompiledProtocolMetadata {
  readonly descriptor: Readonly<{
    version: 1;
    kind: "protocol-metadata";
    requestHash: string;
    rpcHash: string;
    generation: string;
  }>;
  reverify(request: QueueRequest): void;
  assertRpc(request: QueueRequest, actual: unknown): void;
}
function refuse(): never {
  throw Object.assign(new Error("Verified protocol metadata is unavailable"), {
    code: "PROTOCOL_METADATA_UNPROVEN",
  });
}
function pins(ports: ProtocolMetadataPorts): ProtocolMetadataPins {
  const checked: unknown = ports.recheck();
  if (checked !== undefined) {
    void Promise.resolve(checked).catch(() => {});
    refuse();
  }
  const value: unknown = ports.currentPins();
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse();
  const current = value as ProtocolMetadataPins;
  if (
    Object.keys(current).sort().join() !== "buildHash,configHash,generation" ||
    typeof current.buildHash !== "string" ||
    typeof current.configHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(current.buildHash) ||
    !/^[a-f0-9]{64}$/.test(current.configHash) ||
    typeof current.generation !== "string" ||
    !current.generation.trim() ||
    current.generation.length > 256
  )
    refuse();
  return Object.freeze({ ...current });
}
function requestHash(request: QueueRequest): string {
  const { description, ...bound } = request;
  void description;
  return hash(bound);
}

/**
 * Preparation only, never domain or dispatch authority. These protocol methods
 * describe transport capabilities and do not execute a tool or access CAD data.
 * In particular, a caller's readonly flag cannot classify tools/call as metadata.
 */
export function compileProtocolMetadata(
  input: QueueRequest,
  ports: ProtocolMetadataPorts,
): CompiledProtocolMetadata | null {
  if (input.kind !== "rpc") return null;
  const request = structuredClone(input);
  const rpc = request.payload;
  if (
    !rpc ||
    rpc["jsonrpc"] !== "2.0" ||
    typeof rpc["method"] !== "string" ||
    !["initialize", "notifications/initialized", "tools/list", "ping"].includes(
      rpc["method"],
    )
  )
    return null;
  if (
    Object.keys(rpc).some(
      (key) => !["jsonrpc", "id", "method", "params"].includes(key),
    ) ||
    (rpc["params"] !== undefined &&
      (!rpc["params"] ||
        typeof rpc["params"] !== "object" ||
        Array.isArray(rpc["params"])))
  )
    refuse();
  const initial = pins(ports);
  if (
    request.buildHash !== initial.buildHash ||
    typeof request.clientId !== "string" ||
    !request.clientId.trim() ||
    typeof request.requestId !== "string" ||
    !request.requestId.trim() ||
    typeof request.ownerToken !== "string" ||
    !/^[a-f0-9]{64}$/.test(request.ownerToken)
  )
    refuse();
  const expectedRequest = requestHash(request);
  const expectedRpc = hash(rpc);
  const descriptor = Object.freeze({
    version: 1 as const,
    kind: "protocol-metadata" as const,
    requestHash: expectedRequest,
    rpcHash: expectedRpc,
    generation: initial.generation,
  });
  const reverify = (currentRequest: QueueRequest) => {
    if (
      !isDeepStrictEqual(pins(ports), initial) ||
      requestHash(currentRequest) !== expectedRequest
    )
      refuse();
  };
  reverify(request);
  return Object.freeze({
    descriptor,
    reverify,
    assertRpc(currentRequest: QueueRequest, actual: unknown) {
      reverify(currentRequest);
      if (hash(actual) !== expectedRpc) refuse();
    },
  });
}

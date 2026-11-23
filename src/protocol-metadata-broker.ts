import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import type { QueueJob, QueueRequest } from "@fmcad/core";
import type { ProtocolMetadata } from "../packages/core/src/domain/protocol-metadata";

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
export interface ProtocolMetadataRequest extends QueueRequest {
  readonly backend?: string | undefined;
}
export interface CompiledProtocolMetadata {
  readonly descriptor: ProtocolMetadata;
  readonly runtimePins: ProtocolMetadataPins;
  reverify(request: QueueRequest): void;
  assertRpc(request: QueueRequest, actual: unknown): void;
}
const compiledPrograms = new WeakSet<CompiledProtocolMetadata>();
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
  input: ProtocolMetadataRequest,
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
  const prepared = Object.freeze({
    descriptor,
    runtimePins: initial,
    reverify,
    assertRpc(currentRequest: QueueRequest, actual: unknown) {
      reverify(currentRequest);
      if (hash(actual) !== expectedRpc) refuse();
    },
  });
  compiledPrograms.add(prepared);
  return prepared;
}

/** Broker-owned witnesses are ephemeral. Neither queued JSON nor a repeated
 * client submission may reconstruct or replace an original admitted witness. */
export function createProtocolMetadataBroker() {
  const entries = new Map<string, CompiledProtocolMetadata>();
  function program(job: QueueJob): CompiledProtocolMetadata {
    const prepared = entries.get(job.id);
    if (
      !prepared ||
      job.hash !== prepared.descriptor.requestHash ||
      !isDeepStrictEqual(job.protocolMetadata, prepared.descriptor) ||
      !["queued", "preparing", "processing", "running", "sending"].includes(
        job.state,
      )
    )
      refuse();
    prepared.reverify(job.request);
    return prepared;
  }
  return {
    prepare: compileProtocolMetadata,
    admit(job: QueueJob, prepared: CompiledProtocolMetadata) {
      if (entries.has(job.id)) refuse();
      if (
        !compiledPrograms.has(prepared) ||
        job.hash !== prepared.descriptor.requestHash ||
        !isDeepStrictEqual(job.protocolMetadata, prepared.descriptor)
      )
        refuse();
      prepared.reverify(job.request);
      entries.set(job.id, prepared);
    },
    program,
    assertWire(job: QueueJob, outgoing: unknown, physicalRpcId: string) {
      const prepared = program(job);
      if (!outgoing || typeof outgoing !== "object" || Array.isArray(outgoing))
        refuse();
      const logical: Record<string, unknown> = { ...outgoing };
      const original = job.request.payload;
      if (!original) refuse();
      if (Object.hasOwn(original, "id")) {
        if (logical["id"] !== "fmcad:" + physicalRpcId) refuse();
        logical["id"] = original["id"];
      } else if (Object.hasOwn(logical, "id")) {
        refuse();
      }
      // Only the transport-owned JSON-RPC ID is rebound. All other logical
      // contents stay bound by canonical hashing and the final wire certificate.
      prepared.assertRpc(job.request, logical);
    },
    prune(lookup: (id: string) => QueueJob | undefined) {
      for (const id of entries.keys()) {
        const job = lookup(id);
        if (
          !job ||
          ["succeeded", "failed", "cancelled", "expired"].includes(job.state)
        )
          entries.delete(id);
      }
    },
  };
}

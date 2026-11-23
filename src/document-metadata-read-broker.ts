import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { QueueRequest } from "@fmcad/core";

const load = createRequire(__filename);
const { hash: canonicalHash } = load(
  "./dist/core/application/cad/json",
) as typeof import("../packages/core/src/application/cad/json");
const { prepareRequest } = load(
  "./dist/composition/execution-request",
) as typeof import("./composition/execution-request");
const parser = load(
  "./dist/entrypoints/cli/parser",
) as typeof import("./entrypoints/cli/parser");
const registry = load("./commands") as {
  findCommand(
    argv: string[],
  ): import("./entrypoints/cli/parser").CommandEntry | undefined;
};
const { executeDocumentCommand } = load(
  "./dist/core/application/documents/commands",
) as typeof import("../packages/core/src/application/documents/commands");
const { documentListReadCommand } = load(
  "./docops",
) as typeof import("./composition/library-docops");
const bridge = load(
  "./addin-bridge",
) as typeof import("./composition/library-addin-bridge");
const { createBrokerTransport } = load(
  "./dist/fusion-transport/broker",
) as typeof import("../packages/node-adapters/src/fusion-transport/broker");

export interface DocumentMetadataReadPins {
  readonly buildHash: string;
  readonly generation: string;
  readonly configHash: string;
}
export interface DocumentMetadataReadRequest extends QueueRequest {
  readonly backend?: string;
  readonly inputFiles?: Array<{ path: string; sha256: string }>;
}
export interface DocumentMetadataReadCompilerPorts {
  /** Broker-owned current runtime/physical generation, never request fields. */
  currentPins(): DocumentMetadataReadPins;
  /** Synchronous owner/source/root check, repeated after awaits and at dispatch. */
  recheck(): void;
}
export interface DocumentMetadataReadRpc {
  readonly method: "callTool";
  readonly tool: "fusion_mcp_read";
  readonly arguments: Readonly<{ queryType: "document"; operation: "open" }>;
}
export interface DocumentMetadataReadDescriptor {
  readonly version: 1;
  readonly kind: "document-list";
  readonly requestHash: string;
  readonly generation: string;
  readonly rpcHash: string;
  /** Actual ADDIN preparePost program, before dynamic receipt/native wrapping. */
  readonly programHash: string;
}
export interface CompiledDocumentMetadataRead {
  readonly descriptor: DocumentMetadataReadDescriptor;
  readonly expectedRpc: DocumentMetadataReadRpc;
  readonly runtimePins: DocumentMetadataReadPins;
  readonly program: Readonly<{
    stage: "addin-prepare-post-before-receipt";
    source: string;
    programHash: string;
  }>;
  reverify(currentRequest: QueueRequest): void;
  assertRpc(currentRequest: QueueRequest, actual: unknown): void;
  assertProgram(currentRequest: QueueRequest, actualBindSource: unknown): void;
}
const digest = (source: string) =>
  createHash("sha256").update(source).digest("hex");
function refuse(): never {
  throw Object.assign(
    new Error("Trusted document metadata read is unavailable"),
    {
      code: "DOCUMENT_METADATA_READ_UNPROVEN",
    },
  );
}
function synchronous(check: () => unknown): void {
  const result = check();
  if (result !== undefined) {
    void Promise.resolve(result).catch(() => {});
    refuse();
  }
}
function pins(
  ports: DocumentMetadataReadCompilerPorts,
): DocumentMetadataReadPins {
  synchronous(() => ports.recheck());
  const value: unknown = ports.currentPins();
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).sort().join() !== "buildHash,configHash,generation"
  )
    refuse();
  const current = value as DocumentMetadataReadPins;
  if (
    typeof current.buildHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(current.buildHash) ||
    typeof current.configHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(current.configHash) ||
    typeof current.generation !== "string" ||
    !current.generation.trim() ||
    current.generation.length > 256
  )
    refuse();
  return Object.freeze({ ...current });
}
export function documentMetadataReadRequestHash(request: QueueRequest): string {
  const { description, ...bound } = request;
  void description;
  return canonicalHash(bound);
}

/**
 * Compile a closed, broker-owned read proof, not a grant or RPC submitter.
 * Only the canonical public doc-list route is eligible. Caller source,
 * readonly, entry.target and an argv spelling alone never establish authority.
 */
export async function compileDocumentMetadataRead(
  input: DocumentMetadataReadRequest,
  ports: DocumentMetadataReadCompilerPorts,
): Promise<CompiledDocumentMetadataRead | null> {
  const request = structuredClone(input);
  if (request.kind !== "command" || !request.argv || !request.cwd) return null;
  // Pure classification MUST precede prepareRequest: CAD/run can read files.
  const { rest } = parser.parseFlags(request.argv);
  const entry = registry.findCommand(rest);
  if (entry?.kind !== "docops" || entry.target !== "docListCmd") return null;
  if (!request.payload || request.payload["kind"] !== "legacy-command")
    refuse();
  const initial = pins(ports);
  if (
    request.backend !== "addin" ||
    request.buildHash !== initial.buildHash ||
    (request.inputFiles && request.inputFiles.length !== 0)
  )
    refuse();
  // Deliberately remove the advertised payload: prepareRequest otherwise
  // passes already typed envelopes through without independently parsing them.
  const authoritative = prepareRequest({
    request: {
      ...request,
      argv: request.argv,
      cwd: request.cwd,
      payload: undefined,
    },
  });
  if (
    authoritative.payload?.["kind"] !== "legacy-command" ||
    !isDeepStrictEqual(authoritative.argv, request.argv) ||
    !isDeepStrictEqual(
      JSON.parse(JSON.stringify(authoritative.payload)),
      request.payload,
    )
  )
    refuse();
  const requestHash = documentMetadataReadRequestHash(request);
  const rawBridge = bridge.addinBridgeSource();
  const rawBridgeHash = digest(rawBridge);
  const logical: unknown[] = [];
  const result = await executeDocumentCommand(documentListReadCommand, {
    async call(arguments_, tool) {
      logical.push(
        structuredClone({ method: "callTool", tool, arguments: arguments_ }),
      );
      return { text: "", data: { success: true, results: [] }, failed: false };
    },
    async newDocument() {
      return refuse();
    },
    async download() {
      return refuse();
    },
  });
  const expectedRpc: DocumentMetadataReadRpc = Object.freeze({
    method: "callTool",
    tool: "fusion_mcp_read",
    arguments: Object.freeze({ queryType: "document", operation: "open" }),
  });
  if (
    result.code !== 0 ||
    logical.length !== 1 ||
    !isDeepStrictEqual(logical[0], expectedRpc)
  )
    refuse();
  // Real transport preparation, with all send/session paths forbidden.
  // This captures ADDIN's run invocation and any actual transport guards;
  // it does NOT guess a final receipt-wrapped wire from a raw bridge hash.
  const client = createBrokerTransport(
    {
      backend: "addin",
      url: "http://127.0.0.1:8765/mcp",
      tool: "execute_python",
      transport: "node",
      headers: {},
      protocolVersion: "2025-06-18",
      timeoutMs: 1,
    },
    {
      version: "offline-document-metadata-read-compiler",
      bridgeSource: () => rawBridge,
      requestTimeout: (server) => server.timeoutMs ?? 1,
    },
  );
  const preparedPayloads: Record<string, unknown>[] = [];
  client._post = async () => refuse();
  client._openSession = async () => refuse();
  client.preparePost = async (payload) => {
    preparedPayloads.push(structuredClone(payload));
    return {
      fence() {},
      async send() {
        return refuse();
      },
    };
  };
  const send = await client.prepareCallTool(
    expectedRpc.arguments,
    expectedRpc.tool,
  );
  send.fence(); // Local fence only; never invoke send().
  if (preparedPayloads.length !== 1) refuse();
  const captured = preparedPayloads[0]!;
  const params = captured["params"] as Record<string, unknown> | undefined;
  const arguments_ = params?.["arguments"] as
    Record<string, unknown> | undefined;
  if (
    captured["jsonrpc"] !== "2.0" ||
    captured["method"] !== "tools/call" ||
    params?.["name"] !== "execute_python" ||
    !arguments_ ||
    Object.keys(arguments_).sort().join() !== "code,persistent" ||
    arguments_["persistent"] !== false ||
    typeof arguments_["code"] !== "string"
  )
    refuse();
  const source = arguments_["code"];
  const programHash = digest(source);
  const descriptor: DocumentMetadataReadDescriptor = Object.freeze({
    version: 1,
    kind: "document-list",
    requestHash,
    generation: initial.generation,
    rpcHash: canonicalHash(expectedRpc),
    programHash,
  });
  function reverify(currentRequest: QueueRequest): void {
    if (
      !isDeepStrictEqual(pins(ports), initial) ||
      documentMetadataReadRequestHash(currentRequest) !== requestHash ||
      digest(bridge.addinBridgeSource()) !== rawBridgeHash ||
      digest(source) !== programHash
    )
      refuse();
  }
  reverify(input);
  return Object.freeze({
    descriptor,
    expectedRpc,
    runtimePins: initial,
    program: Object.freeze({
      stage: "addin-prepare-post-before-receipt" as const,
      source,
      programHash,
    }),
    reverify,
    assertRpc(currentRequest: QueueRequest, actual: unknown) {
      reverify(currentRequest);
      if (!isDeepStrictEqual(actual, expectedRpc)) refuse();
    },
    assertProgram(currentRequest: QueueRequest, actualBindSource: unknown) {
      reverify(currentRequest);
      if (
        typeof actualBindSource !== "string" ||
        actualBindSource !== source ||
        digest(actualBindSource) !== programHash
      )
        refuse();
    },
  });
}

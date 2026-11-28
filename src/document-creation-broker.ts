import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { isDeepStrictEqual as same } from "node:util";
import type { QueueJob, QueueRequest } from "@fmcad/core";

const load = createRequire(__filename);
const { hash } = load("./dist/core/application/cad/json") as typeof import("../packages/core/src/application/cad/json");
const { prepareRequest } = load("./dist/composition/execution-request") as typeof import("./composition/execution-request");
const parser = load("./dist/entrypoints/cli/parser") as typeof import("./entrypoints/cli/parser");
const registry = load("./commands") as { findCommand(argv: string[]): import("./entrypoints/cli/parser").CommandEntry | undefined };
const { executeDocumentCommand } = load("./dist/core/application/documents/commands") as typeof import("../packages/core/src/application/documents/commands");
const { documentCommandPorts } = load("./dist/node-adapters/persistence/document-commands") as typeof import("../packages/node-adapters/src/persistence/document-commands");
const bridge = load("./addin-bridge") as typeof import("./composition/library-addin-bridge");
const { createBrokerTransport } = load("./dist/fusion-transport/broker") as typeof import("../packages/node-adapters/src/fusion-transport/broker");
const digest = (source: string) => createHash("sha256").update(source).digest("hex");
const requestHash = (request: QueueRequest) => {
  const { description, ...bound } = request;
  void description;
  return hash(bound);
};
function refuse(reason = "compiler proof"): never {
  throw Object.assign(new Error("Document creation verification failed: " + reason), {
    code: "DOCUMENT_CREATION_UNPROVEN",
  });
}
type Request = QueueRequest & { backend?: string; inputFiles?: Array<{ path: string; sha256: string }> };
export interface DocumentCreationCompilerPorts {
  currentPins(): { buildHash: string; configHash: string; generation: string };
  recheck(): void;
}
export async function compileDocumentCreation(input: Request, ports: DocumentCreationCompilerPorts) {
  const request = structuredClone(input);
  if (request.kind !== "command" || !request.argv || !request.cwd) return null;
  // Classification is pure: never prepare arbitrary CAD/run input files.
  const { rest } = parser.parseFlags(request.argv);
  const entry = registry.findCommand(rest);
  if (entry?.kind !== "docops" || entry.target !== "docNewCmd") return null;
  function pins() {
    const result = ports.recheck();
    if (result !== undefined) { void Promise.resolve(result).catch(() => {}); refuse(); }
    const value = ports.currentPins();
    if (!value || typeof value !== "object" ||
        Object.keys(value).sort().join() !== "buildHash,configHash,generation" ||
        !/^[a-f0-9]{64}$/.test(value.buildHash) || !/^[a-f0-9]{64}$/.test(value.configHash) ||
        typeof value.generation !== "string" || !value.generation.trim() || value.generation.length > 256)
      refuse();
    return Object.freeze({ ...value });
  }
  const initial = pins();
  if (request.backend !== "addin" || request.buildHash !== initial.buildHash ||
      (request.inputFiles && request.inputFiles.length !== 0)) refuse();
  const parsed = prepareRequest({ request: { ...request, cwd: request.cwd, argv: request.argv, payload: undefined } });
  if (parsed.payload?.["kind"] !== "legacy-command" ||
      !same(parsed.argv, request.argv) ||
      !same(JSON.parse(JSON.stringify(parsed.payload)), request.payload)) refuse();
  const args: unknown = (parsed.payload as Record<string, unknown>)["rawArgs"];
  if (!Array.isArray(args) || !args.every((value): value is string => typeof value === "string")) refuse();
  // Match the public docNewCmd parser; names remain literal Python strings.
  let name = "";
  for (let i = 0; i < args.length; i++) if (args[i] === "--name") name = args[++i] || "";
  const logical: unknown[] = [];
  const result = await executeDocumentCommand({ kind: "new", name }, documentCommandPorts(
    async (arguments_, tool) => {
      logical.push(structuredClone({ method: "callTool", tool, arguments: arguments_ }));
      return { text: "", data: { success: true }, failed: false };
    },
    () => refuse(),
  ));
  if (result.code !== 0 || logical.length !== 1) refuse();
  const expectedRpc = logical[0] as {
    method: "callTool"; tool: "fusion_mcp_execute";
    arguments: { featureType: "script"; object: { script: string } };
  };
  if (expectedRpc.method !== "callTool" || expectedRpc.tool !== "fusion_mcp_execute" ||
      expectedRpc.arguments.featureType !== "script" ||
      typeof expectedRpc.arguments.object.script !== "string") refuse();
  const rawBridge = bridge.addinBridgeSource();
  const client = createBrokerTransport(
    { backend: "addin", url: "http://127.0.0.1:8765/mcp", tool: "execute_python", transport: "node",
      headers: {}, protocolVersion: "2025-06-18", timeoutMs: 1 },
    { version: "offline-document-creation-compiler", bridgeSource: () => rawBridge,
      requestTimeout: (server) => server.timeoutMs ?? 1 },
  );
  const payloads: Record<string, unknown>[] = [];
  client._post = async () => refuse();
  client._openSession = async () => refuse();
  client.preparePost = async (payload) => {
    payloads.push(structuredClone(payload));
    return { fence() {}, async send() { return refuse(); } };
  };
  const send = await client.prepareCallTool(expectedRpc.arguments, expectedRpc.tool);
  send.fence(); // Offline local fence; no send/session/SDK.
  if (payloads.length !== 1) refuse();
  const wire = payloads[0]!;
  const params = wire["params"] as Record<string, unknown> | undefined;
  const arguments_ = params?.["arguments"] as Record<string, unknown> | undefined;
  if (wire["jsonrpc"] !== "2.0" || wire["method"] !== "tools/call" ||
      params?.["name"] !== "execute_python" || !arguments_ ||
      Object.keys(arguments_).sort().join() !== "code,persistent" ||
      arguments_["persistent"] !== false || typeof arguments_["code"] !== "string") refuse();
  const source = arguments_["code"];
  // The real ADDIN write adapter supplies a fresh diagnostic UI-guard nonce.
  // Only that one literal UUID may differ; the complete guard and service
  // program must still be precisely the independently rendered bytes.
  const guardLine = /^_fmcad_guard_token = "([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})"$/gm;
  const compiledGuards = [...source.matchAll(guardLine)];
  if (compiledGuards.length !== 1) refuse("UI guard nonce");
  const descriptor = Object.freeze({
    version: 1 as const, kind: "document-new" as const,
    requestHash: requestHash(request), generation: initial.generation,
    rpcHash: hash(expectedRpc), programHash: digest(source),
  });
  function reverify(current: QueueRequest) {
    if (!same(pins(), initial)) refuse("runtime pins");
    if (requestHash(current) !== descriptor.requestHash) refuse("request binding");
    if (bridge.addinBridgeSource() !== rawBridge || digest(source) !== descriptor.programHash) refuse("compiler source");
  }
  reverify(input);
  return Object.freeze({
    descriptor, expectedRpc, runtimePins: initial,
    program: Object.freeze({ stage: "addin-prepare-post-before-receipt" as const, source, programHash: descriptor.programHash }),
    reverify,
    assertRpc(current: QueueRequest, actual: unknown) {
      reverify(current);
      if (!same(actual, expectedRpc)) refuse("logical RPC");
    },
    assertProgram(current: QueueRequest, actual: unknown) {
      reverify(current);
      if (typeof actual !== "string") refuse("pre-receipt program");
      const guards = [...actual.matchAll(guardLine)];
      const compiled = compiledGuards[0]!;
      if (guards.length !== 1 ||
          actual !== source.slice(0, compiled.index) + guards[0]![0] + source.slice(compiled.index + compiled[0].length))
        refuse("pre-receipt program");
    },
  });
}
export type CompiledDocumentCreation = NonNullable<Awaited<ReturnType<typeof compileDocumentCreation>>>;
export function createDocumentCreationBroker() {
  const prepared = new WeakSet<CompiledDocumentCreation>();
  const programs = new Map<string, CompiledDocumentCreation>();
  function marker(program: CompiledDocumentCreation) {
    const { kind, ...value } = program.descriptor;
    void kind;
    return value;
  }
  return Object.freeze({
    async prepare(request: Request, ports: DocumentCreationCompilerPorts) {
      const program = await compileDocumentCreation(request, ports);
      if (program) prepared.add(program);
      return program;
    },
    admit(job: QueueJob, program: CompiledDocumentCreation) {
      if (!prepared.has(program) || !["queued", "preparing", "processing", "running", "sending"].includes(job.state)) refuse();
      const original = programs.get(job.id);
      if (original) {
        // Both submitters can compile before either commits. Core dedup returns
        // the unchanged first job; a fresh renderer nonce must not replace its
        // marker/proof or turn an identical submission into a refusal.
        if (!same(job.documentCreation, marker(original))) refuse();
        original.reverify(job.request);
        program.reverify(job.request);
        program.assertRpc(job.request, original.expectedRpc);
        program.assertProgram(job.request, original.program.source);
        prepared.delete(program);
        return;
      }
      if (!same(job.documentCreation, marker(program))) refuse();
      program.reverify(job.request);
      prepared.delete(program);
      if (!programs.has(job.id)) programs.set(job.id, program);
    },
    program(job: QueueJob) {
      const program = programs.get(job.id);
      if (!program || !same(job.documentCreation, marker(program))) refuse();
      program.reverify(job.request);
      return program;
    },
    prune(read: (id: string) => { state: string } | undefined) {
      for (const id of programs.keys()) {
        const state = read(id)?.state;
        if (!state || ["succeeded", "failed", "cancelled", "expired", "needs_reconciliation"].includes(state)) programs.delete(id);
      }
    },
  });
}

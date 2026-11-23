import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createRequire } from "node:module";
import type {
  QueueJob,
  QueueRequest,
  PreparedPythonArtifact,
} from "@fmcad/core";
import type { PythonStdout } from "../packages/core/src/domain/python-stdout";
import type { ProtocolMetadataPins } from "./protocol-metadata-broker";

const load = createRequire(__filename);
const { hash } = load(
  "./dist/core/application/cad/json",
) as typeof import("../packages/core/src/application/cad/json");
const { verifyPythonArtifact } = load(
  "./dist/python/artifact",
) as typeof import("../packages/node-adapters/src/python/artifact");
const { pythonArtifactManifest } = load(
  "./dist/python/context-binding",
) as typeof import("../packages/node-adapters/src/python/context-binding");
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
function pins(
  ports: Pick<DiagnosticPreparationPorts, "currentPins" | "recheck">,
) {
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
    (request.buildHash !== undefined &&
      request.buildHash !== initial.buildHash) ||
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

export interface StdoutKernel {
  readonly status: "prepared";
  readonly sourceSha256: string;
  readonly programHash: string;
  readonly script: string;
  readonly artifact: PreparedPythonArtifact;
  readonly engineVersion: "python-source-effects-v2";
  readonly profileVersion: "isolated-stdout-v1";
}
export interface StdoutCompilationPorts extends Omit<
  DiagnosticPreparationPorts,
  "analyze" | "engineVersion"
> {
  prepareKernel(
    source: string,
  ):
    | StdoutKernel
    | { readonly status: "unsupported" }
    | Promise<StdoutKernel | { readonly status: "unsupported" }>;
  /** Broker-owned live verification of the qualified fresh host entrypoint.
   * A JSON field supplied by the logical caller cannot implement this port. */
  verifyHostBindings(current: ProtocolMetadataPins): {
    readonly proofHash: string;
    readonly profileVersion: "isolated-stdout-v1";
  };
}
function hostProof(
  ports: StdoutCompilationPorts,
  current: ProtocolMetadataPins,
) {
  const proof = ports.verifyHostBindings(current);
  if (
    !proof ||
    Object.keys(proof).sort().join() !== "profileVersion,proofHash" ||
    proof.profileVersion !== "isolated-stdout-v1" ||
    !/^[a-f0-9]{64}$/.test(proof.proofHash)
  ) {
    void Promise.resolve(proof).catch(() => {});
    refuse();
  }
  return proof.proofHash;
}
/** Compiles one exact nonpersistent RPC for the bounded stdout namespace. This
 * still needs private domain admission and the final wire certificate. */
export async function compilePythonStdout(
  input: DiagnosticRequest,
  ports: StdoutCompilationPorts,
) {
  if (
    input.kind !== "rpc" ||
    object(input.payload)["method"] !== "tools/call" ||
    object(object(input.payload)["params"])["name"] !== "execute_python"
  )
    return null;
  const request = structuredClone(input);
  const source = sourceOf(request);
  if (source === null) return null;
  const current = pins(ports);
  if (
    request.backend !== "addin" ||
    (request.buildHash !== undefined &&
      request.buildHash !== current.buildHash) ||
    typeof request.clientId !== "string" ||
    !request.clientId.trim() ||
    typeof request.requestId !== "string" ||
    !request.requestId.trim() ||
    typeof request.ownerToken !== "string" ||
    !/^[a-f0-9]{64}$/.test(request.ownerToken)
  )
    refuse();
  const boundHost = hostProof(ports, current);
  const kernel = await ports.prepareKernel(source);
  const afterCompilation = pins(ports);
  if (
    !isDeepStrictEqual(afterCompilation, current) ||
    hostProof(ports, afterCompilation) !== boundHost
  )
    refuse();
  if (
    kernel.status !== "prepared" ||
    kernel.engineVersion !== "python-source-effects-v2" ||
    kernel.profileVersion !== "isolated-stdout-v1" ||
    kernel.sourceSha256 !== sha(source) ||
    typeof kernel.script !== "string" ||
    !kernel.script ||
    kernel.programHash !== sha(kernel.script)
  )
    refuse();
  const program = kernel.script;
  const artifact = structuredClone(kernel.artifact);
  verifyPythonArtifact(artifact);
  const mapped = new Set(artifact.sourceMap.map((entry) => entry.unitId));
  const embedded = artifact.units.filter((unit) => !mapped.has(unit.id));
  if (
    artifact.script !== program ||
    artifact.sha256 !== kernel.programHash ||
    embedded.length !== 1 ||
    embedded[0]?.source !== source ||
    embedded[0].role !== "user" ||
    embedded[0].sha256 !== sha(source)
  )
    refuse();
  const manifest = pythonArtifactManifest(artifact);
  const rpc = structuredClone(request.payload);
  if (!rpc) refuse();
  object(object(rpc["params"])["arguments"])["code"] = program;
  const descriptor: PythonStdout = Object.freeze({
    version: 1,
    kind: "python-stdout",
    engineVersion: "python-source-effects-v2",
    profileVersion: "isolated-stdout-v1",
    requestHash: requestHash(request),
    rpcHash: hash(rpc),
    sourceHash: sha(source),
    programHash: sha(program),
    hostBindingHash: boundHost,
    generation: current.generation,
  });
  const reverify = (actual: QueueRequest) => {
    const fresh = pins(ports);
    if (
      !isDeepStrictEqual(fresh, current) ||
      hostProof(ports, fresh) !== boundHost ||
      requestHash(actual) !== descriptor.requestHash ||
      sourceOf(actual) !== source
    )
      refuse();
  };
  reverify(request);
  const compiled = Object.freeze({
    descriptor,
    reverify,
    rpc() {
      return structuredClone(rpc);
    },
    origin() {
      return structuredClone(manifest);
    },
    assertProgram(actual: QueueRequest, script: string) {
      reverify(actual);
      if (script !== program || sha(script) !== descriptor.programHash)
        refuse();
    },
    assertWire(actual: QueueRequest, wire: unknown, rpcId: string) {
      reverify(actual);
      const logical = { ...object(wire) };
      if (Object.hasOwn(rpc, "id")) {
        if (logical["id"] !== "fmcad:" + rpcId) refuse();
        logical["id"] = rpc["id"];
      } else if (Object.hasOwn(logical, "id")) refuse();
      if (hash(logical) !== descriptor.rpcHash) refuse();
    },
  });
  compiledStdout.add(compiled);
  return compiled;
}
type CompiledStdout = NonNullable<
  Awaited<ReturnType<typeof compilePythonStdout>>
>;
const compiledStdout = new WeakSet<CompiledStdout>();
export function createPythonStdoutBroker() {
  const entries = new Map<string, CompiledStdout>();
  function program(job: QueueJob) {
    const prepared = entries.get(job.id);
    if (
      !prepared ||
      job.hash !== prepared.descriptor.requestHash ||
      !isDeepStrictEqual(job.pythonStdout, prepared.descriptor) ||
      !["queued", "preparing", "processing", "running", "sending"].includes(
        job.state,
      )
    )
      refuse();
    prepared.reverify(job.request);
    return prepared;
  }
  return {
    prepare: compilePythonStdout,
    admit(job: QueueJob, prepared: CompiledStdout) {
      if (
        entries.has(job.id) ||
        !compiledStdout.has(prepared) ||
        job.hash !== prepared.descriptor.requestHash ||
        !isDeepStrictEqual(job.pythonStdout, prepared.descriptor)
      )
        refuse();
      prepared.reverify(job.request);
      entries.set(job.id, prepared);
    },
    program,
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

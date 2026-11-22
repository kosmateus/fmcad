import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { PreparedPythonArtifact } from "../../../core/src/domain/python-artifact";
import type {
  QueueJob,
  QueuePhysicalBinding,
  QueuePhysicalDispatch,
} from "../../../core/src/domain/queue-model";
import {
  quarantineTarget,
  validPhysicalDispatch,
} from "../../../core/src/domain/queue-quarantine";
import { hash as canonicalHash } from "../../../core/src/application/cad/json";
import { parseNativeResult } from "../../../core/src/application/cad/native-result";
import { verifyPythonArtifact } from "../python/artifact";
import { pythonArtifactManifest } from "../python/context-binding";
import type { ParamCheckpointGuardV1 } from "../python/cad-script";
import type {
  BrokerRecoveryEvidence,
  RemoteReceipt,
  RpcRecord,
} from "../persistence/broker-records";
import type {
  ObservationArtifact,
  ObservationStoreOptions,
} from "./document-observation-store";

export interface CheckpointRpc {
  jsonrpc: "2.0";
  method: "tools/call";
  id: string | number;
  params: {
    name: "execute_python";
    arguments: { code: string; persistent: false };
  };
}
export interface ExpectedCheckpointProgram {
  /** Independently rebuilt with the pinned compiler's private param-checkpoint
   * mode, full includeModel:true and exact resolved document identity. Never
   * reconstruct this by trusting record.pythonArtifact or caller source. */
  compiled: PreparedPythonArtifact;
  /** Actual transport/receipt wrappers rebuilt by the existing private pipeline. */
  wrapped: PreparedPythonArtifact;
  payload: CheckpointRpc;
  wire: CheckpointRpc;
}
export interface CheckpointProducerPorts {
  buildHash: string;
  records: BrokerRecoveryEvidence;
  readJob(jobId: string): QueueJob;
  prepareExpectedProgram(input: {
    job: QueueJob;
    record: RpcRecord;
  }): ExpectedCheckpointProgram;
  /** Existing matching(client, record.response, record.wireRequest). Must return
   * the actual parsed envelope, not a success flag or a synthetic result. */
  matchResponse(record: RpcRecord): unknown;
  /** Existing native receipt/physical proof verifier. Authenticate the original
   * completed read, its source/request/build/runtime, not the currently active
   * document or a caller's checksum. Missing/UNKNOWN/active proof must throw.
   * Any native workflow lifecycle must also be verified, not inferred from the
   * terminal flag. This is a required private host port with no permissive default. */
  verifyNativeRead(input: {
    job: QueueJob;
    record: RpcRecord;
    intent: QueuePhysicalDispatch;
    receipt: RemoteReceipt;
    artifacts: readonly ObservationArtifact[];
  }): {
    physicalTurn: QueuePhysicalBinding;
    generation: string;
    receipt: RemoteReceipt;
  };
  /** Shared host codec, called only after source/response/native authentication.
   * It validates the complete private checkpoint, finite metadata and exact
   * target. A normal parameter listing is not a valid checkpoint. */
  decodeReadback(
    value: unknown,
    target: { creationId?: string; fileId?: string },
  ): ParamCheckpointGuardV1;
}
const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const clone = <T>(value: T): T => structuredClone(value);
function reject(): never {
  throw Object.assign(
    new Error("Original checkpoint producer proof is unavailable or changed"),
    {
      code: "DOCUMENT_CHECKPOINT_PRODUCER_MISMATCH",
    },
  );
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return reject();
  return value as Record<string, unknown>;
}
function requireSame(left: unknown, right: unknown) {
  if (!isDeepStrictEqual(left, right)) reject();
}
function rpcIdentity(rpc: CheckpointRpc) {
  return { jsonrpc: rpc.jsonrpc, method: rpc.method, id: rpc.id };
}
function fixedRpc(rpc: CheckpointRpc) {
  const value = object(rpc);
  const params = object(value["params"]),
    args = object(params["arguments"]);
  if (
    value["jsonrpc"] !== "2.0" ||
    value["method"] !== "tools/call" ||
    !(typeof value["id"] === "string" || typeof value["id"] === "number") ||
    params["name"] !== "execute_python" ||
    args["persistent"] !== false ||
    typeof args["code"] !== "string" ||
    !args["code"]
  )
    reject();
  requireSame(Object.keys(args).sort(), ["code", "persistent"]);
  requireSame(Object.keys(params).sort(), ["arguments", "name"]);
  requireSame(Object.keys(value).sort(), ["id", "jsonrpc", "method", "params"]);
}
function recordedManifest(artifact: PreparedPythonArtifact) {
  return {
    version: artifact.version,
    sha256: artifact.sha256,
    artifactHash: artifact.artifactHash,
    sourceMap: artifact.sourceMap,
    units: artifact.units.map(({ id, filename, role, sha256 }) => ({
      id,
      filename,
      role,
      sha256,
    })),
  };
}
/** Concrete verifier for the immutable observation store. This module does not
 * dispatch, replay, settle the whole job, grant access or release an old UNKNOWN. */
export function createDocumentCheckpointProducer(
  ports: CheckpointProducerPorts,
): ObservationStoreOptions["verifyProducer"] {
  if (
    !ports ||
    !digest(ports.buildHash) ||
    ![
      "readJob",
      "prepareExpectedProgram",
      "matchResponse",
      "verifyNativeRead",
      "decodeReadback",
    ].every(
      (name) =>
        typeof (ports as unknown as Record<string, unknown>)[name] ===
        "function",
    ) ||
    !ports.records
  )
    reject();
  return (input) => {
    try {
      const { context, proof } = clone(input);
      if (
        !proof ||
        !Array.isArray(input.artifacts) ||
        context.scope !== "parameters"
      )
        reject();
      const job = clone(ports.readJob(proof.jobId));
      if (
        !job ||
        job.id !== proof.jobId ||
        job.kind !== "command" ||
        job.request.kind !== "command" ||
        job.requestId !== proof.probeRequestId ||
        job.clientId !== job.request.clientId ||
        job.requestId !== job.request.requestId ||
        !job.documentInspection ||
        job.documentInspection.version !== 1 ||
        !job.documentInspection.target.creationId
      )
        reject();
      const target = quarantineTarget(job.request);
      if (
        !target?.creationId ||
        job.request.argv?.[job.request.argv[0] === "cad" ? 2 : 1] !== "inspect"
      )
        reject();
      requireSame(target, job.documentInspection.target);
      requireSame(context.target, target);
      if (
        context.actorClientId !== job.clientId ||
        context.generation !== job.documentInspection.generation
      )
        reject();
      const byRole = new Map<string, unknown>();
      if (proof.artifacts.length !== input.artifacts.length) reject();
      for (let index = 0; index < input.artifacts.length; index++) {
        const artifact = input.artifacts[index]!;
        const { bytes, value, ...source } = artifact;
        requireSame(source, proof.artifacts[index]);
        const names: Record<string, string> = {
          rpc: `rpc-${proof.rpcId}.json`,
          response: `received-response-${proof.rpcId}.json`,
          "physical-intent": `physical-turn-${sha256(proof.rpcId)}.json`,
          "remote-receipt": `remote-${proof.rpcId}.json`,
        };
        if (
          names[artifact.role] !== undefined &&
          artifact.reference !== `jobs/${job.id}/${names[artifact.role]}`
        )
          reject();
        if (byRole.has(artifact.role) || sha256(bytes) !== artifact.sha256)
          reject();
        const decoded: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
        requireSame(decoded, value);
        byRole.set(artifact.role, decoded);
      }
      const records = ports.records
        .readRpcRecords(job.id)
        .filter((r) => r.binding.rpcId === proof.rpcId);
      if (records.length !== 1) reject();
      const record = clone(records[0]!);
      requireSame(byRole.get("rpc"), record);
      const binding = record.binding;
      if (
        !binding ||
        binding.jobId !== job.id ||
        binding.rpcId !== proof.rpcId ||
        binding.buildHash !== ports.buildHash ||
        binding.buildHash !== proof.buildHash ||
        binding.requestHash !== proof.requestHash ||
        !digest(binding.sourceHash) ||
        record.terminal !== true ||
        record.failed === true ||
        record.nonterminal === true ||
        !record.response ||
        !Number.isInteger(record.response.status) ||
        record.response.status < 200 ||
        record.response.status >= 300 ||
        typeof record.response.raw !== "string" ||
        !record.receipt ||
        !record.remoteReceipt
      )
        reject();
      const original = ports.records.readReceivedResponse(
        job.id,
        binding.rpcId,
      );
      if (!original) reject();
      requireSame(byRole.get("response"), original);
      requireSame(original, {
        version: 1,
        kind: "owned-rpc-received-response-v1",
        binding,
        wireId: record.wireRequest?.id,
        response: record.response,
      });
      const intents = job.physicalDispatches?.filter(
        (entry) => entry.physical.turnId === binding.rpcId,
      );
      if (
        intents?.length !== 1 ||
        (job.physicalDispatchCount !== undefined &&
          job.physicalDispatchCount !== job.physicalDispatches?.length)
      )
        reject();
      const intent = intents[0];
      if (
        !intent ||
        !validPhysicalDispatch(job, intent) ||
        intent.request.kind !== "product"
      )
        reject();
      requireSame(byRole.get("physical-intent"), {
        request: intent.request,
        physical: intent.physical,
        target: intent.target,
        ...(intent.catalogIndex === undefined
          ? {}
          : { catalogIndex: intent.catalogIndex }),
      });
      const intentArtifact = input.artifacts.find(
        (artifact) => artifact.role === "physical-intent",
      );
      if (
        !intentArtifact ||
        intent.intentDigest !== intentArtifact.sha256 ||
        intent.intentReference !== `physical-turn-${sha256(binding.rpcId)}.json`
      )
        reject();
      requireSame(intent.target, target);
      requireSame(binding["physicalTurn"], intent.physical);
      requireSame(proof.physicalTurn, intent.physical);
      const expected = ports.prepareExpectedProgram({
        job: clone(job),
        record: clone(record),
      });
      verifyPythonArtifact(expected.compiled);
      verifyPythonArtifact(expected.wrapped);
      fixedRpc(expected.payload);
      fixedRpc(expected.wire);
      const request = object(expected.compiled.request);
      if (
        request["operation"] !== "param.inspect" ||
        request["docId"] !== target.creationId ||
        request["docFileId"] !== target.fileId ||
        request["component"] != null ||
        expected.wire.id !== `fmcad:${binding.rpcId}` ||
        sha256(JSON.stringify(expected.payload)) !== binding.requestHash ||
        sha256(expected.payload.params.arguments.code) !== binding.sourceHash ||
        expected.wire.params.arguments.code !== expected.wrapped.script ||
        proof.sourceHash !== expected.compiled.sha256
      )
        reject();
      requireSame(request["data"], { includeModel: true });
      requireSame(record.request, rpcIdentity(expected.payload));
      requireSame(record.wireRequest, rpcIdentity(expected.wire));
      requireSame(record.method, "tools/call");
      requireSame(object(binding["documentScope"]), {
        producer: "compiled-cad-v1",
        operation: "param.inspect",
        sourceHash: expected.compiled.sha256,
        wireSourceHash: binding.sourceHash,
        buildHash: ports.buildHash,
        target,
      });
      const manifestHash = canonicalHash(
        pythonArtifactManifest(expected.compiled),
      );
      if (proof.producerManifestHash !== manifestHash) reject();
      requireSame(
        object(record)["pythonArtifact"],
        recordedManifest(expected.wrapped),
      );
      const receipt = ports.records.readRemoteReceipt(record);
      if (receipt.outcome !== "succeeded") reject();
      requireSame(receipt, record.remoteReceipt);
      // Remote receipt bytes are part of the immutable proof too; the existing
      // reader enforces the original receipt path and request/source binding.
      requireSame(byRole.get("remote-receipt"), receipt);
      const native = ports.verifyNativeRead({
        job: clone(job),
        record: clone(record),
        intent: clone(intent),
        receipt: clone(receipt),
        artifacts: clone(input.artifacts),
      });
      requireSame(native.physicalTurn, intent.physical);
      requireSame(native.receipt, receipt);
      if (native.generation !== job.documentInspection.generation) reject();
      const reply = object(ports.matchResponse(clone(record)));
      if (
        reply["jsonrpc"] !== "2.0" ||
        reply["id"] !== expected.wire.id ||
        reply["error"]
      )
        reject();
      const result = object(reply["result"]);
      if (
        result["isError"] ||
        !Array.isArray(result["content"]) ||
        !result["content"].length
      )
        reject();
      const text = result["content"]
        .map((entry: unknown) => {
          const item = object(entry);
          if (item["type"] !== "text" || typeof item["text"] !== "string")
            return reject();
          return item["text"];
        })
        .join("");
      const payload = object(JSON.parse(text));
      if (
        payload["success"] !== true ||
        payload["error"] ||
        typeof payload["stdout"] !== "string" ||
        /^ERROR /m.test(payload["stdout"])
      )
        reject();
      if (result["structuredContent"] !== undefined)
        requireSame(result["structuredContent"], payload);
      const output = parseNativeResult(payload["stdout"]);
      if (output["success"] !== true || output["operation"] !== "param.inspect")
        reject();
      const checkpoint = ports.decodeReadback(output["result"], clone(target));
      const derivedTarget = {
        creationId: checkpoint.document.identity.creationId,
        ...(target.fileId === undefined
          ? {}
          : { fileId: checkpoint.document.identity.fileId }),
      };
      requireSame(derivedTarget, target);
      const stateDigest = canonicalHash(checkpoint);
      if (stateDigest !== context.stateDigest) reject();
      return {
        actorClientId: job.clientId,
        target: clone(target),
        generation: native.generation,
        stateDigest,
        probeRequestId: job.requestId,
        proof: {
          ...proof,
          jobId: job.id,
          rpcId: binding.rpcId,
          probeRequestId: job.requestId,
          requestHash: binding.requestHash,
          buildHash: binding.buildHash,
          sourceHash: expected.compiled.sha256,
          producerManifestHash: manifestHash,
          physicalTurn: clone(intent.physical),
        },
      };
    } catch {
      // Host errors and response/source fragments can contain private state.
      return reject();
    }
  };
}

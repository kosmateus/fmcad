import * as fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createRequire } from "node:module";
import type { DocumentObservation, QueueJob, QueuePhysicalBinding, PreparedPythonArtifact } from "@fmcad/core";
import type { ParamCheckpointGuardV1 } from "../packages/node-adapters/src/python/cad-script";
import type { CheckpointRpc } from "../packages/node-adapters/src/execution/document-checkpoint-producer";
import type { ObservationProof } from "../packages/node-adapters/src/execution/document-observation-store";
import type { BrokerRecords, RpcRecord, RemoteReceipt } from "../packages/node-adapters/src/persistence/broker-records";
import { decodeDocumentCheckpointReadback } from "./document-checkpoint-readback";
const load = createRequire(__filename);
const { decodeCadWorkerInvocation } = load("./dist/core/application/cad/worker-command") as
  typeof import("../packages/core/src/application/cad/worker-command");
const { hash: canonicalHash } = load("./dist/core/application/cad/json") as
  typeof import("../packages/core/src/application/cad/json");
const { parseNativeResult } = load("./dist/core/application/cad/native-result") as
  typeof import("../packages/core/src/application/cad/native-result");
const { pythonArtifactManifest, retainPythonOrigin } = load("./dist/python/context-binding") as
  typeof import("../packages/node-adapters/src/python/context-binding");
const { createDocumentCheckpointProducer } = load("./dist/node-adapters/execution/document-checkpoint-producer") as
  typeof import("../packages/node-adapters/src/execution/document-checkpoint-producer");
const { createDocumentObservationStore } = load("./dist/node-adapters/execution/document-observation-store") as
  typeof import("../packages/node-adapters/src/execution/document-observation-store");
const { readBytes, MAX_JSON_RECORD_BYTES } = load("./dist/node-adapters/persistence/records") as
  typeof import("../packages/node-adapters/src/persistence/records");
const { validRelease } = load("./dist/core/domain/queue-quarantine") as
  typeof import("../packages/core/src/domain/queue-quarantine");

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function reject(): never {
  throw Object.assign(new Error("Verified checkpoint read evidence is unavailable"), {
    code: "STORAGE_UNAVAILABLE",
  });
}
export function checkpointGeneration(binding: QueuePhysicalBinding): string {
  return canonicalHash({ generation: binding.generation, physicalRuntime: binding.physicalRuntime });
}
export interface BrokerCheckpointEvidencePorts {
  directory: string;
  buildHash: string;
  records: BrokerRecords;
  readJob(jobId: string): QueueJob;
  /** Actual claimed broker/client authorization; called before/after async work
   * and from every operation-scoped synchronous verifier. */
  recheck(): void;
  currentGeneration(): string;
  compile: typeof import("./composition/cad").prepareCadScript;
  wrapReceipt(code: string, receipt: string, binding: RpcRecord["binding"]): PreparedPythonArtifact;
  matchResponse(record: RpcRecord): unknown;
  verifyReceipt(record: RpcRecord, receipt: RemoteReceipt): void;
  authenticatePhysical(binding: QueuePhysicalBinding): Promise<unknown>;
}

/** Host-only bridge. No verifier fixture/default, no SDK call, no native proof
 * persisted as authorization. Each use authenticates the ORIGINAL turn again. */
export function createBrokerCheckpointEvidence(ports: BrokerCheckpointEvidencePorts) {
  function compile(job: QueueJob) {
    const decoded = decodeCadWorkerInvocation(job.request.payload);
    const invocation = decoded.kind === "cad-command" ? decoded.invocation :
      decoded.kind === "cad" ? decoded : null;
    if (!invocation || invocation.operation !== "param.inspect") reject();
    return ports.compile("param.inspect", invocation.data, {
      ...(invocation.doc === undefined ? {} : { doc: invocation.doc }),
      ...(invocation.docId === undefined ? {} : { docId: invocation.docId }),
      ...(invocation.docFileId === undefined ? {} : { docFileId: invocation.docFileId }),
      ...(invocation.component === undefined ? {} : { component: invocation.component }),
      ...(invocation.projectId === undefined ? {} : { projectId: invocation.projectId }),
      preview: invocation.preview === true,
    }, undefined, undefined, "param-checkpoint");
  }
  function expectedProgram(job: QueueJob, record: RpcRecord) {
    const compiled = compile(job);
    const callerId = record.request?.id;
    if (typeof callerId !== "string" && typeof callerId !== "number") reject();
    // Exact BrokerAddinClient readOnly=true transformation. No UI guard token
    // is generated on this read-only path; source identity remains reproducible.
    const payload: CheckpointRpc = {
      jsonrpc: "2.0", id: callerId, method: "tools/call",
      params: { name: "execute_python", arguments: {
        code: compiled.script + '\n\nrun("")\n', persistent: false,
      } },
    };
    // Physical binding is admitted AFTER receipt compilation, not part of its
    // original wrapper input. All original source/epoch fields remain intact.
    const wrapperBinding = { ...record.binding };
    delete wrapperBinding["physicalTurn"];
    const wrapped = retainPythonOrigin(
      ports.wrapReceipt(payload.params.arguments.code, record.receipt!, wrapperBinding),
      pythonArtifactManifest(compiled),
    );
    const wire = structuredClone(payload);
    wire.id = `fmcad:${record.binding.rpcId}`;
    wire.params.arguments.code = wrapped.script;
    return { compiled, payload, wire, wrapped };
  }
  function recordFor(jobId: string, rpcId?: string) {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(jobId)) reject();
    const records = ports.records.evidence.readRpcRecords(jobId).filter((record) => {
      const scope = record.binding["documentScope"] as { operation?: string } | undefined;
      return scope?.operation === "param.inspect" &&
        (rpcId === undefined || record.binding.rpcId === rpcId);
    });
    if (records.length !== 1) reject();
    return records[0]!;
  }
  async function authenticatedStore(job: QueueJob, record: RpcRecord) {
    ports.recheck();
    const binding = record.binding["physicalTurn"] as QueuePhysicalBinding;
    if (!binding) reject();
    const receipt = ports.records.evidence.readRemoteReceipt(record);
    ports.verifyReceipt(record, receipt);
    const authenticated = await ports.authenticatePhysical(structuredClone(binding));
    ports.recheck();
    if (!validRelease(authenticated, binding, hash)) reject();
    const exactRecord = structuredClone(record), exactReceipt = structuredClone(receipt);
    const verifyProducer = createDocumentCheckpointProducer({
      buildHash: ports.buildHash, records: ports.records.evidence,
      readJob: ports.readJob,
      prepareExpectedProgram: ({ job, record }) => expectedProgram(job, record),
      matchResponse: ports.matchResponse,
      decodeReadback: decodeDocumentCheckpointReadback,
      verifyNativeRead(input) {
        ports.recheck();
        if (!isDeepStrictEqual(input.record, exactRecord) ||
            !isDeepStrictEqual(input.receipt, exactReceipt) ||
            !isDeepStrictEqual(input.intent.physical, binding) ||
            input.job.id !== job.id)
          reject();
        ports.verifyReceipt(input.record, input.receipt);
        return {
          physicalTurn: structuredClone(binding),
          generation: checkpointGeneration(binding),
          receipt: structuredClone(exactReceipt),
        };
      },
    });
    return createDocumentObservationStore({
      directory: ports.directory,
      namespace: `checkpoint:${hash(ports.directory)}`,
      verifyProducer,
    });
  }
  function proofFor(job: QueueJob, record: RpcRecord): ObservationProof {
    const rpcId = record.binding.rpcId;
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(rpcId)) reject();
    const compiled = compile(job);
    const body: ObservationProof = {
      jobId: job.id, rpcId, probeRequestId: job.requestId,
      requestHash: record.binding.requestHash, buildHash: record.binding.buildHash,
      sourceHash: compiled.sha256,
      producerManifestHash: canonicalHash(pythonArtifactManifest(compiled)),
      physicalTurn: structuredClone(record.binding["physicalTurn"] as QueuePhysicalBinding),
      artifacts: [],
    };
    for (const [role, name] of Object.entries({
      "job-request": "request.json", rpc: `rpc-${rpcId}.json`,
      response: `received-response-${rpcId}.json`,
      "physical-intent": `physical-turn-${hash(rpcId)}.json`,
      "remote-receipt": `remote-${rpcId}.json`,
    })) {
      const reference = `jobs/${job.id}/${name}`;
      const file = path.join(ports.directory, reference);
      const bytes = readBytes(file, MAX_JSON_RECORD_BYTES, fs, file);
      body.artifacts.push({ role, reference, sha256: hash(bytes) });
    }
    for (const [role, suffix] of [
      ["native-start", ".native-start.json"], ["native-end", ".native-end.json"],
    ] as const) {
      const name = `remote-${rpcId}.json${suffix}`;
      const file = path.join(ports.directory, "jobs", job.id, name);
      if (fs.existsSync(file)) {
        const bytes = readBytes(file, MAX_JSON_RECORD_BYTES, fs, file);
        body.artifacts.push({ role, reference: `jobs/${job.id}/${name}`, sha256: hash(bytes) });
      }
    }
    return body;
  }
  return {
    compile,
    async persist(
      observation: Omit<DocumentObservation, "readback">,
      jobId: string,
    ): Promise<DocumentObservation> {
      ports.recheck();
      const job = ports.readJob(jobId), record = recordFor(jobId);
      if (job.clientId !== observation.actorClientId ||
          observation.generation !== ports.currentGeneration() ||
          checkpointGeneration(record.binding["physicalTurn"] as QueuePhysicalBinding) !== observation.generation)
        reject();
      const store = await authenticatedStore(job, record);
      const readback = store.persist(observation, proofFor(job, record));
      ports.recheck();
      return { ...observation, readback };
    },
    async verify(observation: DocumentObservation, historical = false): Promise<ParamCheckpointGuardV1> {
      ports.recheck();
      if (!historical && observation.generation !== ports.currentGeneration()) reject();
      const reference = `document-observations/${hash(observation.id)}.json`;
      if (observation.readback.reference !== reference) reject();
      const file = path.join(ports.directory, reference);
      const bytes = readBytes(file, MAX_JSON_RECORD_BYTES, fs, file);
      if (hash(bytes) !== observation.readback.sha256) reject();
      const stored = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as { proof: ObservationProof };
      const job = ports.readJob(stored.proof.jobId);
      if (job.clientId !== observation.actorClientId ||
          job.requestId !== observation.readback.probeRequestId) reject();
      const record = recordFor(job.id, stored.proof.rpcId);
      const store = await authenticatedStore(job, record);
      store.verify(observation);
      ports.recheck();
      const reply = ports.matchResponse(record) as {
        result: { content: { type: string; text: string }[] };
      };
      const payload = JSON.parse(reply.result.content.map((item) => item.text).join("")) as { stdout: string };
      const checkpoint = decodeDocumentCheckpointReadback(
        parseNativeResult(payload.stdout)["result"], observation.target,
      );
      if (canonicalHash(checkpoint) !== observation.stateDigest) reject();
      return checkpoint;
    },
    /** Canonical parsed state after existing client normalization. This proves
     * shape only; persist/verify above must authenticate original RPC evidence. */
    decode(value: unknown, target: DocumentObservation["target"]): ParamCheckpointGuardV1 {
      return decodeDocumentCheckpointReadback(value, target);
    },
  };
}

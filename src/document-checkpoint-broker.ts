import * as fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createRequire } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import type { TurnIdentity } from "../packages/core/src/application/broker-execution";
import type { UnlockPrincipal, ConfirmedUnlockTarget } from "./document-unlock-admission";
import type { DocumentObservation, QueueJob, QueuePhysicalBinding, PreparedPythonArtifact, QueueDomain } from "@fmcad/core";
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
const { validRelease, physicalReleaseInput } = load("./dist/core/domain/queue-quarantine") as
  typeof import("../packages/core/src/domain/queue-quarantine");

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export interface CheckpointReadTask<Send> {
  readonly actor: UnlockPrincipal;
  readonly target: ConfirmedUnlockTarget;
  readonly turn: TurnIdentity;
  readonly send: Send | undefined;
  readonly result: Promise<{ jobId: string; checkpoint: ParamCheckpointGuardV1 }>;
  resolve(value: { jobId: string; checkpoint: ParamCheckpointGuardV1 }): void;
  reject(error: unknown): void;
}

/** Local preparation and notification ownership only. This is neither a
 * physical executor nor evidence that an SDK request has settled. */
export function createCheckpointReadWorkflow<Send>() {
  type Entry = { task: CheckpointReadTask<Send>; send?: Send; settled: boolean };
  const reads = new Map<string, Entry>();
  const handles = new WeakMap<CheckpointReadTask<Send>, Entry>();
  let generationPin: string | undefined;
  function current(task: CheckpointReadTask<Send>): Entry | undefined {
    const entry = handles.get(task);
    return entry && reads.get(task.turn.jobId) === entry ? entry : undefined;
  }
  return Object.freeze({
    pinGeneration(generation: string): string {
      if (!generation || (generationPin !== undefined && generationPin !== generation))
        throw Object.assign(new Error("Native generation changed"), { code: "DOCUMENT_STATE_CHANGED" });
      generationPin = generation;
      return generation;
    },
    begin(jobId: string, actor: UnlockPrincipal, target: ConfirmedUnlockTarget, turn: TurnIdentity) {
      if (turn.jobId !== jobId || reads.has(jobId))
        throw Object.assign(new Error("Checkpoint read already has an owner"), { code: "CHECKPOINT_READ_UNAVAILABLE" });
      let resolve!: (value: { jobId: string; checkpoint: ParamCheckpointGuardV1 }) => void;
      let reject!: (error: unknown) => void;
      const result = new Promise<{ jobId: string; checkpoint: ParamCheckpointGuardV1 }>((yes, no) => {
        resolve = yes; reject = no;
      });
      void result.catch(() => {});
      const entry: Entry = {
        settled: false,
        task: Object.freeze({
          actor: Object.freeze({ ...actor }),
          // Preserve the admission WeakMap capability: never clone this target.
          target, turn, result,
          get send() { return entry.send; },
          resolve(value: { jobId: string; checkpoint: ParamCheckpointGuardV1 }) {
            if (current(entry.task) !== entry || entry.settled || value.jobId !== jobId) return;
            entry.settled = true;
            resolve(value);
          },
          reject(error: unknown) {
            if (current(entry.task) !== entry || entry.settled) return;
            entry.settled = true;
            reject(error);
          },
        }),
      };
      handles.set(entry.task, entry);
      reads.set(jobId, entry);
      return entry.task;
    },
    attachSend(task: CheckpointReadTask<Send>, send: Send): void {
      const entry = current(task);
      if (!entry || entry.settled || entry.send !== undefined)
        throw Object.assign(new Error("Checkpoint preparation lost its owner"), { code: "CHECKPOINT_READ_UNAVAILABLE" });
      entry.send = send;
    },
    read(jobId: string): CheckpointReadTask<Send> | undefined { return reads.get(jobId)?.task; },
    isCurrent(task: CheckpointReadTask<Send>): boolean { return current(task) !== undefined; },
    release(task: CheckpointReadTask<Send>): void {
      if (current(task)) reads.delete(task.turn.jobId);
    },
    prune(readStatus: (jobId: string) => { state: string; code?: string } | undefined): void {
      for (const [id, entry] of reads) {
        const status = readStatus(id);
        if (!status || ["failed", "cancelled", "expired"].includes(status.state)) {
          entry.task.reject(Object.assign(new Error("Checkpoint read was not completed"), {
            code: status?.code || "DOCUMENT_STATE_CHANGED",
          }));
          // A callback cannot delete a newer admission.
          if (current(entry.task)) reads.delete(id);
        }
      }
    },
  });
}

/** Operation-scoped projections and synchronous final checks never escape as
 * mutable collections, including across concurrent asynchronous requests. */
export function createCheckpointViews() {
  const views = new AsyncLocalStorage<{
    states: Map<string, ParamCheckpointGuardV1>;
    produced: Set<string>;
    checks: Map<string, (() => void)[]>;
  }>();
  function scope() {
    const value = views.getStore();
    if (!value) reject();
    return value;
  }
  return Object.freeze({
    run<T>(action: () => T): T {
      return views.run({ states: new Map(), produced: new Set(), checks: new Map() }, action);
    },
    produced(id: string): void { views.getStore()?.produced.add(id); },
    consumeProduced(id: string): boolean { return scope().produced.delete(id); },
    retainChecks(id: string, checks: readonly (() => void)[]): void {
      scope().checks.set(id, [...checks]);
    },
    verifyFinal(id: string): void {
      const checks = scope().checks.get(id);
      if (!checks?.length) reject();
      for (const check of checks) check();
    },
    retainState(id: string, state: ParamCheckpointGuardV1): void {
      scope().states.set(id, structuredClone(state));
    },
    state(id: string): ParamCheckpointGuardV1 | undefined {
      const value = views.getStore()?.states.get(id);
      return value && structuredClone(value);
    },
  });
}
function reject(): never {
  throw Object.assign(new Error("Verified checkpoint read evidence is unavailable"), {
    code: "STORAGE_UNAVAILABLE",
  });
}
export function checkpointGeneration(binding: QueuePhysicalBinding): string {
  return canonicalHash({ generation: binding.generation, physicalRuntime: binding.physicalRuntime });
}
/** Public metadata projection only. All conflicts, including hidden ones, must
 * still participate in queue admission and checkpoint CAS. */
export function checkpointDisclosableConflicts(
  conflicts: ReturnType<QueueDomain["documentConflicts"]>,
  actorClientId: string,
  lookup: (jobId: string) => Pick<QueueJob, "clientId"> | undefined,
): ReturnType<QueueDomain["documentConflicts"]> {
  return conflicts.filter((entry) => lookup(entry.jobId)?.clientId === actorClientId);
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
    if (!validRelease(authenticated, binding, hash) ||
        (authenticated as { evidenceDigest: string }).evidenceDigest !==
          hash(physicalReleaseInput(binding, "dispatch-finally"))) reject();
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
    async verify(observation: DocumentObservation, historical = false) {
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
      // This capability is only retained in the caller's operation scope.
      // Re-read all immutable artifacts synchronously after its last await,
      // immediately before queue CAS or public disclosure.
      return Object.freeze({
        checkpoint,
        reverify() {
          ports.recheck();
          store.verify(observation);
          ports.recheck();
        },
      });
    },
    /** Canonical parsed state after existing client normalization. This proves
     * shape only; persist/verify above must authenticate original RPC evidence. */
    decode(value: unknown, target: DocumentObservation["target"]): ParamCheckpointGuardV1 {
      return decodeDocumentCheckpointReadback(value, target);
    },
  };
}

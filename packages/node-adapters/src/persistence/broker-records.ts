import * as fs from "node:fs";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { QueueRequest } from "../../../core/src/domain/queue-model";
import type { DocumentSnapshot } from "../../../core/src/domain/document";
import {
  durable,
  durableBytes,
  failure,
  MAX_JSON_RECORD_BYTES,
  readJson,
} from "./records";

export type ProbeStage = "preflight" | "postflight" | "reconcile";
type ReceiptStage = ProbeStage | "atomic-observation";

export interface RecordInstance {
  pid: number;
  birth: string;
  version: string;
  activeCommand?: string;
  documents?: Array<{ isModified?: boolean; creationId?: string }>;
  documentState?: DocumentSnapshot;
}

export interface RecordBinding {
  jobId: string;
  rpcId: string;
  requestHash: string;
  buildHash: string;
  sourceHash?: string;
  [key: string]: unknown;
}

interface ReceiptReference {
  binding: RecordBinding;
  instance: RecordInstance;
  receipt?: string;
}

export interface RemoteReceipt extends RecordBinding {
  terminal: boolean;
  outcome: string;
  instance: RecordInstance;
}

interface WireRequest extends Record<string, unknown> {
  jsonrpc: string;
  method: string;
  id?: string | number | undefined;
}

interface WireResponse {
  status: number;
  raw: string;
}

export interface RpcRecord extends ReceiptReference {
  method: string;
  terminal: boolean;
  request?: WireRequest;
  wireRequest?: WireRequest;
  response?: WireResponse;
  failed?: boolean;
  nonterminal?: boolean;
  nativeCompletion?: unknown;
  remoteReceipt?: RemoteReceipt;
}

interface ReceivedResponse {
  version: 1;
  kind: "owned-rpc-received-response-v1";
  binding: RecordBinding;
  wireId?: WireRequest["id"];
  response: WireResponse;
}

interface ProbeReference extends ReceiptReference {
  receipt: string;
}

export interface ProbeIntent extends ProbeReference {
  version: number;
  jobId: string;
  buildHash: string;
  at: number;
}

export interface CompletedPreflight {
  version: number;
  jobId: string;
  buildHash: string;
  completed: boolean;
  instance: RecordInstance;
  idle: boolean;
  requiresIdle: boolean;
}

interface JobIntent {
  id: string;
  request: QueueRequest;
  buildHash: string;
  properties: object;
  deadline: number;
}

interface WorkerStart {
  jobId: string;
  buildHash: string;
  at: number;
}

export interface BrokerRecoveryEvidence {
  readProbeIntent(jobId: string, stage: "reconcile"): ProbeReference | null;
  readProbeIntent(
    jobId: string,
    stage: Exclude<ProbeStage, "reconcile">,
  ): ProbeIntent | null;
  readCompletedPreflight(jobId: string): CompletedPreflight | null;
  readRpcRecords(jobId: string): RpcRecord[];
  readRemoteReceipt(
    record: ReceiptReference,
    stage?: ReceiptStage,
  ): RemoteReceipt;
  /** The optional copy may be absent for an already settled historical RPC. */
  findRemoteReceipt(
    record: ReceiptReference,
    stage?: ReceiptStage,
  ): RemoteReceipt | null;
  readReceivedResponse(jobId: string, rpcId: string): ReceivedResponse | null;
  readWorkerResult(jobId: string): {
    jobId: string;
    terminal?: boolean;
    nonterminal?: boolean;
    workflowOutcome?: unknown;
    code: number;
  } | null;
  readWorkerIdentity(jobId: string): { pid: number; birth: string } | null;
  readWorkerStart(jobId: string): WorkerStart | null;
  readAdapterOutcome(jobId: string): {
    jobId: string;
    buildHash: string;
    unknown?: boolean;
    rpcId?: string;
  } | null;
  readOutcome(jobId: string): unknown;
}

export interface BrokerRecords {
  readonly evidence: BrokerRecoveryEvidence;
  createIntent(jobId: string, intent: JobIntent): string;
  createProbeIntent(
    jobId: string,
    stage: Exclude<ProbeStage, "reconcile">,
    record: ProbeIntent,
  ): string;
  createRpcIntent(jobId: string, record: RpcRecord): string;
  recordReceivedResponse(jobId: string, evidence: ReceivedResponse): void;
  /** Call only after execution has matched the transport reply to its wire request. */
  recordRpcTerminal(jobId: string, record: RpcRecord): void;
  recordRpcNativeCompletion(jobId: string, record: RpcRecord): void;
  retainRpcWorkflowFence(jobId: string, record: RpcRecord): void;
  recordProbeTerminal(
    jobId: string,
    stage: "preflight",
    evidence: CompletedPreflight,
  ): void;
  recordProbeTerminal(
    jobId: string,
    stage: "postflight",
    evidence: RecordInstance,
  ): void;
}

/** The composition supplies one writer under its existing broker lock. No
 * operation here owns dispatch, authenticates clients or settles queue state. */
export function createBrokerRecords(directory: string, io = fs): BrokerRecords {
  const jobs = path.join(io.realpathSync(directory), "jobs");
  const missing = (error: unknown) =>
    (error as NodeJS.ErrnoException).code === "ENOENT";
  const mismatch = (message: string): never =>
    failure("RECEIPT_MISMATCH", message);
  function segment(id: string): string {
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id))
      mismatch("Invalid job or RPC record identity");
    return id;
  }
  function jobDir(jobId: string): string {
    const dir = path.join(jobs, segment(jobId));
    for (const entry of [jobs, dir]) {
      const stat = io.lstatSync(entry);
      if (
        !stat.isDirectory() ||
        (process.getuid && stat.uid !== process.getuid())
      )
        failure(
          "UNSAFE_DIRECTORY",
          "Broker records require an owned job directory",
        );
    }
    return dir;
  }
  function read<T>(file: string, maxBytes?: number): T {
    return readJson(file, maxBytes, io, file) as T;
  }
  function optional<T>(
    jobId: string,
    name: string,
    maxBytes?: number,
  ): T | null {
    try {
      const value = read<T>(path.join(jobDir(jobId), name), maxBytes);
      if (!value || typeof value !== "object" || Array.isArray(value))
        failure("CORRUPT_STATE", "Broker record must be an object");
      return value;
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }
  function create(jobId: string, name: string, value: object): string {
    const file = path.join(jobDir(jobId), name);
    durable(file, value, true, io);
    return file;
  }
  const rpcName = (rpcId: string) => {
    if (rpcId === "result")
      mismatch("RPC identity collides with the public result");
    return `rpc-${segment(rpcId)}.json`;
  };
  const responseName = (rpcId: string) =>
    `received-response-${segment(rpcId)}.json`;
  function assertJob(jobId: string, binding: RecordBinding): void {
    if (binding?.jobId !== jobId)
      mismatch("Broker record belongs to a different job");
  }
  function rpcFile(jobId: string, record: RpcRecord): string {
    assertJob(jobId, record.binding);
    return path.join(jobDir(jobId), rpcName(record.binding.rpcId));
  }
  function rpcReceiptStage(
    record: RpcRecord,
  ): "atomic-observation" | undefined {
    return record.binding["observationKind"] === "atomic_holder_status"
      ? "atomic-observation"
      : undefined;
  }
  function receiptPath(record: ReceiptReference, stage?: ReceiptStage): string {
    if (
      stage !== undefined &&
      !["preflight", "postflight", "reconcile", "atomic-observation"].includes(
        stage,
      )
    )
      mismatch("Invalid remote receipt stage");
    const rpcId = segment(record.binding.rpcId);
    const expected = path.join(
      jobDir(record.binding.jobId),
      stage ? `${stage}-${rpcId}.receipt.json` : `remote-${rpcId}.json`,
    );
    if (record.receipt !== expected)
      mismatch("Remote receipt path does not match the original record");
    return expected;
  }
  function findRemoteReceipt(
    record: ReceiptReference,
    stage?: ReceiptStage,
  ): RemoteReceipt | null {
    if (!record.receipt)
      failure("RECEIPT_UNAVAILABLE", "No remote terminal receipt was declared");
    const file = receiptPath(record, stage);
    let value: RemoteReceipt;
    try {
      value = read<RemoteReceipt>(file);
    } catch (error) {
      if (missing(error)) return null;
      failure(
        "RECEIPT_UNAVAILABLE",
        "Remote terminal receipt is unavailable or unreadable",
      );
    }
    if (
      value?.terminal !== true ||
      !["succeeded", "failed"].includes(value.outcome) ||
      !["jobId", "rpcId", "requestHash", "buildHash", "sourceHash"].every(
        (key) => value[key] === record.binding[key],
      ) ||
      !value.instance ||
      value.instance.pid !== record.instance.pid ||
      value.instance.birth !== record.instance.birth ||
      value.instance.version !== record.instance.version
    )
      mismatch(
        "Remote receipt is not terminal or bound to the original dispatch",
      );
    return value;
  }
  function readRemoteReceipt(
    record: ReceiptReference,
    stage?: ReceiptStage,
  ): RemoteReceipt {
    return (
      findRemoteReceipt(record, stage) ??
      failure("RECEIPT_UNAVAILABLE", "Remote terminal receipt is missing")
    );
  }
  function readReceivedResponse(
    jobId: string,
    rpcId: string,
    maxBytes?: number,
  ): ReceivedResponse | null {
    const response = optional<ReceivedResponse>(
      jobId,
      responseName(rpcId),
      maxBytes,
    );
    if (response) {
      assertJob(jobId, response.binding);
      if (response.binding.rpcId !== rpcId)
        mismatch("Received response belongs to a different RPC");
    }
    return response;
  }
  function assertOriginalResponse(
    jobId: string,
    record: RpcRecord,
    response: WireResponse,
  ): void {
    const expected: ReceivedResponse = {
      version: 1,
      kind: "owned-rpc-received-response-v1",
      binding: record.binding,
      wireId: (record.wireRequest ?? record.request)?.id,
      response,
    };
    // Retention and publication allow large responses. Bound this writer-side
    // read by the candidate's serialized size without changing recovery limits.
    const limit = Math.max(
      MAX_JSON_RECORD_BYTES,
      Buffer.byteLength(JSON.stringify(expected)),
    );
    const original = readReceivedResponse(jobId, record.binding.rpcId, limit);
    if (!original)
      failure(
        "RECEIPT_UNAVAILABLE",
        "The original transport response was not retained",
      );
    if (
      original.version !== expected.version ||
      original.kind !== expected.kind ||
      !isDeepStrictEqual(original.binding, expected.binding) ||
      original.wireId !== expected.wireId ||
      !original.response ||
      original.response.status !== response.status ||
      original.response.raw !== response.raw
    )
      mismatch(
        "Terminal response differs from the retained transport response",
      );
  }
  function readProbeIntent(
    jobId: string,
    stage: "reconcile",
  ): ProbeReference | null;
  function readProbeIntent(
    jobId: string,
    stage: Exclude<ProbeStage, "reconcile">,
  ): ProbeIntent | null;
  function readProbeIntent(
    jobId: string,
    stage: ProbeStage,
  ): ProbeReference | null {
    if (
      stage !== "preflight" &&
      stage !== "postflight" &&
      stage !== "reconcile"
    )
      mismatch("Invalid probe stage");
    const record = optional<ProbeReference>(
      jobId,
      stage === "reconcile" ? "reconcile-probe.json" : `${stage}-start.json`,
    );
    if (record) {
      assertJob(jobId, record.binding);
      receiptPath(record, stage);
    }
    return record;
  }
  // The mutable RPC journal keeps its original intent. Later writes may only
  // add their specific evidence; the remote receipt itself is never written here.
  function updateRpc(
    jobId: string,
    record: RpcRecord,
    wasTerminal: boolean,
    allowedChanges: readonly string[],
  ): void {
    const file = rpcFile(jobId, record);
    const text = JSON.stringify(record);
    // A previous journal can be one byte longer when a false flag becomes true.
    const limit = Math.max(MAX_JSON_RECORD_BYTES, Buffer.byteLength(text) + 1);
    const old = read<Record<string, unknown>>(file, limit);
    if (old?.["terminal"] !== wasTerminal)
      mismatch("RPC journal is not in the expected state");
    const next = JSON.parse(text) as Record<string, unknown>;
    if (
      wasTerminal &&
      ((old["nativeCompletion"] !== undefined &&
        JSON.stringify(old["nativeCompletion"]) !==
          JSON.stringify(next["nativeCompletion"])) ||
        (old["failed"] === true && next["failed"] !== true))
    )
      mismatch("RPC journal update changed settled lifecycle evidence");
    const immutableFields = (value: Record<string, unknown>) =>
      JSON.stringify(
        Object.entries(value).filter(
          ([name]) => !allowedChanges.includes(name),
        ),
      );
    if (immutableFields(old) !== immutableFields(next))
      mismatch(
        "RPC journal update changed the original dispatch or evidence bytes",
      );
    durableBytes(file, text, false, io);
  }
  function recordProbeTerminal(
    jobId: string,
    stage: "preflight" | "postflight",
    evidence: CompletedPreflight | RecordInstance,
  ): void {
    if (stage !== "preflight" && stage !== "postflight")
      mismatch("Invalid completion probe stage");
    const intent = readProbeIntent(jobId, stage);
    if (!intent)
      failure("RECEIPT_UNAVAILABLE", "Probe has no durable start record");
    if (
      stage === "preflight" &&
      (!("completed" in evidence) ||
        evidence.completed !== true ||
        evidence.jobId !== jobId ||
        evidence.buildHash !== intent.buildHash)
    )
      mismatch("Preflight evidence is not bound to the original probe");
    create(jobId, `${stage}.json`, evidence);
  }
  return {
    evidence: {
      readProbeIntent,
      readCompletedPreflight: (id) => optional(id, "preflight.json"),
      readRpcRecords(jobId) {
        const dir = jobDir(jobId);
        return io
          .readdirSync(dir)
          .filter(
            (name) => /^rpc-.*\.json$/.test(name) && name !== "rpc-result.json",
          )
          .map((name) => {
            const value = read<RpcRecord>(path.join(dir, name));
            assertJob(jobId, value?.binding);
            if (rpcName(value.binding.rpcId) !== name)
              mismatch(
                "RPC journal filename does not match the original dispatch",
              );
            if (value.receipt !== undefined)
              receiptPath(value, rpcReceiptStage(value));
            return value;
          });
      },
      readRemoteReceipt,
      findRemoteReceipt,
      readReceivedResponse: (id, rpcId) => readReceivedResponse(id, rpcId),
      readWorkerResult: (id) => optional(id, "worker-result.json"),
      readWorkerIdentity: (id) => optional(id, "worker-identity.json"),
      readWorkerStart: (id) => optional(id, "worker-start.json"),
      readAdapterOutcome: (id) => optional(id, "adapter-outcome.json"),
      readOutcome: (id) => optional(id, "outcome.json"),
    },
    createIntent(jobId, intent) {
      if (
        intent.id !== jobId ||
        !intent.request.clientId ||
        !intent.request.requestId
      )
        mismatch("Intent must identify the original job, client and request");
      return create(jobId, "request.json", intent);
    },
    createProbeIntent(jobId, stage, record) {
      if (stage !== "preflight" && stage !== "postflight")
        mismatch("Invalid start probe stage");
      assertJob(jobId, record.binding);
      if (
        record.jobId !== jobId ||
        record.buildHash !== record.binding.buildHash
      )
        mismatch("Probe does not match the original job and build");
      receiptPath(record, stage);
      return create(jobId, `${stage}-start.json`, record);
    },
    createRpcIntent(jobId, record) {
      assertJob(jobId, record.binding);
      if (record.terminal !== false || record.response || record.remoteReceipt)
        mismatch("RPC intent cannot contain a terminal response or receipt");
      if (record.receipt !== undefined)
        receiptPath(record, rpcReceiptStage(record));
      return create(jobId, rpcName(record.binding.rpcId), record);
    },
    recordReceivedResponse(jobId, evidence) {
      assertJob(jobId, evidence.binding);
      const name = rpcName(evidence.binding.rpcId);
      const intent = read<RpcRecord>(path.join(jobDir(jobId), name));
      if (
        intent?.terminal !== false ||
        !isDeepStrictEqual(intent.binding, evidence.binding) ||
        evidence.wireId !== (intent.wireRequest ?? intent.request)?.id
      )
        mismatch("Received response is not bound to the original RPC intent");
      create(jobId, responseName(evidence.binding.rpcId), evidence);
    },
    recordRpcTerminal(jobId, record) {
      assertJob(jobId, record.binding);
      if (record.terminal !== true || !record.response)
        mismatch("Terminal RPC requires a matched response");
      if (record.receipt) {
        if (
          !isDeepStrictEqual(
            readRemoteReceipt(record, rpcReceiptStage(record)),
            record.remoteReceipt,
          )
        )
          mismatch("Terminal RPC requires the original durable remote receipt");
      } else if (record.remoteReceipt) {
        mismatch("Terminal RPC cannot attach an undeclared receipt");
      }
      if (rpcReceiptStage(record) === "atomic-observation") {
        // The observation deliberately retains a sanitized response only.
        if (!record.receipt)
          mismatch("Atomic observation requires its remote receipt");
      } else {
        assertOriginalResponse(jobId, record, record.response);
      }
      updateRpc(jobId, record, false, [
        "terminal",
        "response",
        "failed",
        "nonterminal",
        "remoteReceipt",
        "nativeDeclaration",
        "nativeCompletion",
      ]);
    },
    recordRpcNativeCompletion(jobId, record) {
      if (record.terminal !== true || !record.nativeCompletion)
        mismatch(
          "Native completion requires terminal RPC and lifecycle evidence",
        );
      updateRpc(jobId, record, true, ["nativeCompletion", "failed"]);
    },
    retainRpcWorkflowFence(jobId, record) {
      if (record.terminal !== true || record.nonterminal !== true)
        mismatch("Retained workflow fence cannot certify completion");
      updateRpc(jobId, record, true, ["nonterminal"]);
    },
    recordProbeTerminal,
  };
}

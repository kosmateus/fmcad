import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type {
  PreparedPythonArtifact,
  PythonArtifactManifest,
} from "@fmcad/core";
import {
  createReceiptPublication,
  dispatchPrepared,
} from "../../../core/src/application/execution";
import { auditSummary } from "../../../core/src/application/cad/recovery-audit";
import { hash as canonicalHash } from "../../../core/src/application/cad/json";
import { record } from "../../../core/src/application/cad/contracts";
import { durable, readJson } from "../persistence/records";
import { directory as assertDirectory } from "../persistence/migration-files";
import { pythonArtifactManifest } from "../python/context-binding";
import { verifyPythonArtifact } from "../python/artifact";

export interface AuditMessage extends Record<string, unknown> {
  jobId?: unknown;
  observationJobId?: unknown;
  requestId?: unknown;
}
export interface AuditRpc extends Record<string, unknown> {
  method: string;
  id?: string | number | undefined;
  params?: {
    name?: string;
    arguments?: { code?: string; persistent?: boolean; [key: string]: unknown };
  };
}
export interface AuditBinding extends Record<string, unknown> {
  currentInstance?: unknown;
  historicalInstance?: unknown;
}
export interface AuditPreparation {
  identity: unknown;
  binding: AuditBinding;
  instance: unknown;
}
export interface AuditReader {
  artifact: PreparedPythonArtifact;
  sourceFile: string;
  sourceSha256: string;
}
export interface AuditCertificate {
  report: unknown;
  fence(payload: AuditRpc): void;
}
export interface AuditWire {
  outgoing: AuditRpc;
  artifact: PreparedPythonArtifact;
  record: {
    binding: Record<string, unknown>;
    instance: unknown;
    receipt: string;
  };
  certificate: AuditCertificate | null;
}
export type AuditResponse = Record<string, unknown>;
export interface AuditScope {
  expectedCode: string;
  origin: PythonArtifactManifest;
  sent: boolean;
  summary: unknown;
  post(payload: AuditRpc, sessionId?: string): Promise<AuditResponse>;
}
export interface RecoveryAuditPorts {
  kind?: string;
  extraKeys?: string[];
  priorObservationRequired?: boolean;
  installation: string;
  buildHash: string;
  jobDirectory(job: string): string;
  assertOwner(job: string, observer: string | undefined, client: string): void;
  inspect(message: AuditMessage, client: string): Promise<AuditPreparation>;
  fence(prepared: AuditPreparation, inFlight: boolean): void;
  begin(): void;
  end(): void;
  admit<T>(send: () => Promise<T>): Promise<T>;
  post(payload: AuditRpc, sessionId?: string): Promise<AuditResponse>;
  check(
    payload: AuditRpc,
    artifact: PreparedPythonArtifact,
  ): Promise<AuditCertificate>;
  match(response: AuditResponse, outgoing: AuditRpc): AuditResponse | null;
  remoteReceipt(value: AuditWire["record"]): { outcome: string };
  sendScript(scope: AuditScope, script: string): Promise<unknown>;
  parseSummary?(reply: unknown, identity: unknown, binding: unknown): unknown;
  prepareReader?(
    installation: string,
    identity: unknown,
    binding: AuditBinding,
    output: { directory: string; key: Record<string, string> },
  ): AuditReader;
  publishComplete?(
    result: Record<string, unknown>,
    prior: Record<string, unknown>,
    receipt: string,
  ): unknown | Promise<unknown>;
}
export interface RecoveryAuditRuntime {
  prepareReader: NonNullable<RecoveryAuditPorts["prepareReader"]>;
  prepareWire(input: {
    payload: AuditRpc;
    reader: AuditReader;
    rpcId: string;
    receipt: string;
    instance: unknown;
    buildHash: string;
    jobId: string;
    auditBinding: AuditBinding;
  }): AuditWire;
}
function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
const identifier = (value: unknown): value is string =>
  typeof value === "string" && !!value.trim() && value.length <= 180;
const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
function readRecord(file: string): Record<string, unknown> {
  const value = readJson(file);
  if (!record(value))
    fail("AUDIT_RESULT_CHANGED", "Stored audit evidence must be an object");
  return value;
}

// Composition ports are private broker objects, never caller-supplied options.
// No independent process/lifecycle/SDK authority. Private typed compositions may
// authorize one fixed scratch operation; the same gate/physical port still owns it.
export function createRecoveryAudit(
  p: RecoveryAuditPorts,
  runtime: RecoveryAuditRuntime,
) {
  const kind = p.kind || "atomic-recovery-audit";
  const publication = createReceiptPublication(
    (
      result: Record<string, unknown>,
      prior: Record<string, unknown>,
      receipt: string,
    ) => p.publishComplete?.(result, prior, receipt),
  );
  async function publishComplete(
    result: Record<string, unknown>,
    prior: Record<string, unknown>,
    receipt: string,
  ) {
    if (!p.publishComplete) return;
    // Polls for one authenticated receipt join its original publication. A
    // different job/owner must never inherit that activation or its failure.
    return publication(receipt, result, prior, receipt);
  }
  async function handle(message: AuditMessage, clientId: string) {
    const identifiers =
      p.priorObservationRequired === false
        ? [message.jobId, message.requestId]
        : [message.jobId, message.observationJobId, message.requestId];
    if (
      Object.keys(message).some(
        (k) =>
          ![
            "action",
            "auth",
            "jobId",
            "observationJobId",
            "requestId",
            "control",
            ...(p.extraKeys || []),
          ].includes(k),
      ) ||
      !identifiers.every(identifier) ||
      (p.priorObservationRequired === false &&
        message.observationJobId !== undefined)
    )
      fail(
        "INVALID_REQUEST",
        "Audit requires target, prior observation and one stable request ID",
      );
    if (
      !identifier(message.jobId) ||
      !identifier(message.requestId) ||
      (message.observationJobId !== undefined &&
        !identifier(message.observationJobId))
    )
      fail("INVALID_REQUEST", "Audit requires bounded request identifiers");
    p.assertOwner(message.jobId, message.observationJobId, clientId);
    const directory = path.join(p.jobDirectory(message.jobId), kind);
    if (fs.existsSync(directory)) assertDirectory(directory);
    const intentFile = path.join(directory, "intent.json"),
      resultFile = path.join(directory, "result.json");
    const key: Record<string, string> =
      p.priorObservationRequired === false
        ? { jobId: message.jobId, requestId: message.requestId, clientId }
        : {
            jobId: message.jobId,
            observationJobId: message.observationJobId!,
            requestId: message.requestId,
            clientId,
          };
    if (fs.existsSync(intentFile)) {
      const prior = readRecord(intentFile);
      if (canonicalHash(prior["key"]) !== canonicalHash(key))
        fail(
          "AUDIT_ALREADY_REQUESTED",
          "The original audit cannot be replayed under another request",
        );
      if (!fs.existsSync(resultFile))
        return { kind, ...key, status: "pending", receipt: resultFile };
      const result = readRecord(resultFile);
      if (
        result["kind"] !== kind ||
        Object.entries(key).some(([k, v]) => result[k] !== v) ||
        result["nativeOutcome"] !== "unknown" ||
        result["modelValidation"] !== "not_performed" ||
        result["rollbackVerification"] !== "not_performed"
      )
        fail(
          "AUDIT_RESULT_CHANGED",
          "Stored audit result differs from its owner/purpose binding",
        );
      if (result["status"] === "complete") {
        (p.parseSummary || auditSummary)(
          {
            result: {
              content: [
                {
                  type: "text",
                  text: "FMCAD_RESULT " + JSON.stringify(result["summary"]),
                },
              ],
            },
          },
          prior["identity"],
          prior["binding"],
        );
        const activation = await publishComplete(result, prior, resultFile);
        if (activation) return { ...result, activation };
      }
      return result;
    }
    const prepared = await p.inspect(message, clientId);
    const reader = (p.prepareReader || runtime.prepareReader)(
      p.installation,
      prepared.identity,
      prepared.binding,
      { directory, key },
    );
    p.fence(prepared, false);
    fs.mkdirSync(directory, { mode: 0o700 });
    durable(
      intentFile,
      {
        version: 1,
        key,
        binding: prepared.binding,
        identity: prepared.identity,
        sourceSha256: reader.sourceSha256,
        sourceArtifactHash: reader.artifact.artifactHash,
      },
      true,
    );
    let begun = false;
    try {
      p.begin();
      begun = true;
    } catch (error) {
      durable(
        resultFile,
        {
          kind,
          ...key,
          status: "failed",
          code: record(error) ? error["code"] : undefined,
          sdkRequestsSent: 0,
          nativeOutcome: "unknown",
          modelValidation: "not_performed",
          rollbackVerification: "not_performed",
        },
        true,
      );
      throw error;
    }
    const scope: AuditScope = {
      post: async () =>
        fail("AUDIT_REQUEST_INVALID", "Audit scope is not initialized"),
      expectedCode: reader.artifact.script + '\n\nrun("")\n',
      origin: pythonArtifactManifest(reader.artifact),
      sent: false,
      summary: null,
    };
    scope.post = async (payload, sessionId) => {
      if (["initialize", "notifications/initialized"].includes(payload?.method))
        return p.admit(() => {
          p.fence(prepared, true);
          return p.post(payload, sessionId);
        });
      if (
        scope.sent ||
        payload?.method !== "tools/call" ||
        payload.params?.name !== "execute_python" ||
        payload.params.arguments?.code !== scope.expectedCode ||
        payload.params.arguments.persistent !== false ||
        Object.keys(payload.params.arguments).some(
          (k) => !["code", "persistent"].includes(k),
        )
      )
        fail(
          "AUDIT_REQUEST_INVALID",
          "Only the exact broker-derived administrative script may use this grant",
        );
      return dispatchPrepared<AuditWire, AuditResponse, AuditResponse>({
        prepare() {
          const rpcId = randomUUID();
          return runtime.prepareWire({
            payload,
            reader,
            rpcId,
            receipt: path.join(directory, "remote-" + rpcId + ".json"),
            instance: prepared.instance,
            buildHash: p.buildHash,
            jobId: key["jobId"]!,
            auditBinding: prepared.binding,
          });
        },
        async check(value) {
          value.certificate = await p.check(value.outgoing, value.artifact);
        },
        admit: p.admit,
        fence(value) {
          p.fence(prepared, true);
          if (hash(fs.readFileSync(reader.sourceFile)) !== reader.sourceSha256)
            fail("BUILD_CHANGED", "Audit source changed after checking");
          verifyPythonArtifact(value.artifact);
          if (value.outgoing.params?.arguments?.code !== value.artifact.script)
            fail("AUDIT_BYTES_CHANGED", "Audit wire changed after checking");
          value.certificate!.fence(value.outgoing);
          if (scope.sent || fs.existsSync(path.join(directory, "start.json")))
            fail("AUDIT_ALREADY_SENT", "No replay after an audit start");
          durable(
            path.join(directory, "wire.json"),
            {
              outgoing: value.outgoing,
              artifact: pythonArtifactManifest(value.artifact),
            },
            true,
          );
          durable(
            path.join(directory, "start.json"),
            {
              ...value.record,
              pythonCheck: value.certificate!.report,
              originArtifactHash: reader.artifact.artifactHash,
            },
            true,
          );
          scope.sent = true;
        },
        send: (value) => p.post(value.outgoing, sessionId),
        settle(value, response) {
          const reply = p.match(response, value.outgoing),
            receipt = p.remoteReceipt(value.record);
          if (
            !reply ||
            reply["error"] ||
            (record(reply["result"]) && reply["result"]["isError"]) ||
            receipt.outcome !== "succeeded"
          )
            fail(
              "AUDIT_TRANSPORT_FAILED",
              "Audit did not return a successful bound receipt",
            );
          scope.summary = (p.parseSummary || auditSummary)(
            reply,
            prepared.identity,
            prepared.binding,
          );
          durable(
            path.join(directory, "response.json"),
            {
              version: 1,
              binding: value.record.binding,
              wireId: value.outgoing.id,
              callerId: payload.id,
              reply,
              summary: scope.summary,
            },
            true,
          );
          // The physical receipt/matcher must see the unique wire ID, but the
          // enclosing real McpClient still expects its original id (normally 2).
          // Do not return the wire reply unchanged and manufacture EPROTO after
          // successful validation. Keep the original wire reply durably above.
          const callerReply = { ...reply, id: payload.id };
          return typeof response["raw"] === "string"
            ? { ...response, raw: JSON.stringify(callerReply) }
            : callerReply;
        },
        unknown() {
          /* Retain uncertainty; a scratch operation may have run. Never replay. */
        },
      });
    };
    setImmediate(async () => {
      let result: Record<string, unknown> = {};
      try {
        await p.sendScript(scope, reader.artifact.script);
        if (!scope.summary)
          fail(
            "AUDIT_RECEIPT_UNAVAILABLE",
            "Audit returned without bound facts",
          );
        p.fence(prepared, false);
        result = { status: "complete", summary: scope.summary };
      } catch (error) {
        result = {
          status: "failed",
          code: (record(error) && error["code"]) || "AUDIT_UNKNOWN",
          ...(record(error) && error["pythonCheck"]
            ? { pythonCheck: error["pythonCheck"] }
            : {}),
        };
      } finally {
        try {
          const published: Record<string, unknown> = {
            kind,
            ...key,
            ...result,
            sdkRequestsSent: scope.sent ? 1 : 0,
            ...(prepared.binding.currentInstance
              ? {
                  currentInstance: prepared.binding.currentInstance,
                  historicalInstance: prepared.binding.historicalInstance,
                  historicalProcessState: "terminated",
                  endpointVerified: result["status"] === "complete",
                  currentModelingAdmission: "blocked",
                }
              : {}),
            nativeOutcome: "unknown",
            modelValidation: "not_performed",
            rollbackVerification: "not_performed",
          };
          durable(resultFile, published, true);
          if (published["status"] === "complete")
            await publishComplete(
              published,
              { key, identity: prepared.identity, binding: prepared.binding },
              resultFile,
            );
        } catch {
          /* Intent/start remain unresolved. Never replay or crash the broker on publication loss. */
        } finally {
          if (begun) p.end();
        }
      }
    });
    return { kind, ...key, status: "pending", receipt: resultFile };
  }
  return { handle };
}

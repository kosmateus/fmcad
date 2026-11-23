import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type * as P from "./queue-broker-ports";
import type { prepareBrokerScript } from "../packages/node-adapters/src/execution/broker-preparation";
import type { BrokerModules } from "./queue-broker-modules";
import type { createPythonRpcAdmission } from "../packages/node-adapters/src/python/admission";
import type { CompiledDocumentMetadataRead } from "./document-metadata-read-broker";

export type RpcPreparationJob = Readonly<
  Pick<P.Job, "id"> & Partial<Pick<P.Job, "request">>
>;
type ReceiptPreparation =
  BrokerModules["./queue-instance"]["prepareReceiptScript"];

/** Existing broker services, not a second executor or mutable broker context. */
export interface BrokerRpcPreparationPorts {
  readonly buildHash: string;
  readonly nativeMcp: boolean;
  readonly nativePaths: Parameters<ReceiptPreparation>[4];
  view(): Readonly<{
    epoch: Readonly<P.Epoch> | null | undefined;
    admissionMode: string | undefined;
    contextEpoch: number;
    approvedRuntimeRoot: boolean;
    metadataAdmission: boolean;
  }>;
  runtimeInstance(): P.Instance;
  jobDirectory(jobId: string): string;
  admitEpochRequest(
    request: P.Request | undefined,
  ): { kind?: string; purpose?: string } | null;
  verifyPreparedJob(job: RpcPreparationJob, contextEpoch: number): void;
  isolatedTool(name: string | undefined, args?: P.ToolArguments): void;
  localPreparation():
    | Readonly<{
        job: Readonly<Pick<P.Job, "id">>;
        compiledScope?: Readonly<Record<string, unknown>>;
      }>
    | false
    | undefined;
  readonly metadata: {
    job(jobId: string): Readonly<P.Job> | undefined;
    program(
      job: Readonly<P.Job>,
    ): Pick<CompiledDocumentMetadataRead, "assertProgram">;
    assertDocumentMetadataRead(
      jobId: string,
      programHash: string,
      rpcHash: string,
    ): void;
  };
  readonly creation?: {
    program(job: Readonly<P.Job>): Pick<CompiledDocumentMetadataRead, "assertProgram">;
    assertDocumentCreation(jobId: string, programHash: string, rpcHash: string): void;
  };
  readonly protocol?: {
    assertWire(job: Readonly<P.Job>, outgoing: P.Rpc, rpcId: string): void;
    assertProtocolMetadata(jobId: string, rpcHash: string): void;
  };
  readonly prepareBrokerScript: typeof prepareBrokerScript;
  readonly prepareReceiptScript: ReceiptPreparation;
  retainPythonOrigin(
    artifact: ReturnType<ReceiptPreparation>,
    origin: P.Origin,
  ): ReturnType<ReceiptPreparation>;
  prepareMetadataWire(payload: P.Rpc): P.MetadataWireProof;
  readonly pythonAdmission: Pick<
    ReturnType<typeof createPythonRpcAdmission>,
    "check"
  >;
  localCheckOptions(): { readonly signal?: AbortSignal };
  testCheckPrepared?(prepared: P.PreparedCall): void | Promise<void>;
}

const hash = (source: string) =>
  createHash("sha256").update(source).digest("hex");
const own = (value: object, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);
function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

/** Prepare exactly one owned RPC. The caller keeps canonical prepared-turn
 * ownership, physical dispatch, grants, and settlement outside this module. */
export function createBrokerRpcPreparation(ports: BrokerRpcPreparationPorts) {
  return {
    async prepareOwnedPost(
      payload: P.Rpc,
      job: RpcPreparationJob,
      origin?: P.Origin,
      rawMetadata = false,
    ): Promise<P.PreparedCall> {
      const view = ports.view();
      // Startup metadata without a user request keeps its administrative scope.
      const epochPolicy =
        view.epoch || (view.approvedRuntimeRoot && job.request)
          ? ports.admitEpochRequest(job.request)
          : null;
      const contextEpoch = view.contextEpoch || 0;
      const rpcId = randomUUID();
      const binding: P.Binding = {
        jobId: job.id,
        rpcId,
        requestHash: hash(JSON.stringify(payload)),
        buildHash: ports.buildHash,
      };
      if (view.epoch && view.admissionMode !== "normal-multidocument")
        Object.assign(binding, {
          isolatedEpoch: view.epoch.epochId,
          qualifiedDocumentHash: hash(JSON.stringify(view.epoch.document)),
          auditExpectedInstance: view.epoch.currentInstance,
          auditExpectedDocument: view.epoch.document,
        });
      if (epochPolicy?.kind === "saved-first-save")
        Object.assign(binding, {
          purpose: epochPolicy.purpose,
          auditFirstSave: true,
        });
      const request: P.Rpc = { jsonrpc: "2.0", method: payload.method };
      if (own(payload, "id")) request.id = payload.id;
      const record: P.RecordEvidence = {
        binding,
        instance: ports.runtimeInstance(),
        request,
        terminal: false,
        method: payload.method,
      };
      const outgoing = structuredClone(payload);
      let pythonArtifact;
      if (own(outgoing, "id")) outgoing.id = "fmcad:" + rpcId;
      const protocolJob = ports.metadata.job(job.id);
      if (protocolJob?.protocolMetadata) {
        if (!ports.protocol || payload.method === "tools/call")
          fail("PROTOCOL_METADATA_UNPROVEN", "Protocol witness is unavailable");
        ports.protocol.assertWire(protocolJob, outgoing, rpcId);
        ports.protocol.assertProtocolMetadata(job.id, protocolJob.protocolMetadata.rpcHash);
        binding["protocolScope"] = {
          producer: "compiled-protocol-metadata-v1",
          requestHash: protocolJob.hash,
          rpcHash: protocolJob.protocolMetadata.rpcHash,
          generation: protocolJob.protocolMetadata.generation,
          buildHash: ports.buildHash,
        };
      }
      record.wireRequest = {
        jsonrpc: "2.0",
        method: outgoing.method,
        ...(own(outgoing, "id") ? { id: outgoing.id } : {}),
      };
      if (payload.method === "tools/call") {
        ports.isolatedTool(outgoing.params?.name, outgoing.params?.arguments);
        pythonArtifact = ports.prepareBrokerScript(outgoing, {
          nativeMcp: ports.nativeMcp,
          bindSource(source, nativePublicPython) {
            record.receipt = path.join(
              ports.jobDirectory(job.id),
              `remote-${rpcId}.json`,
            );
            binding.sourceHash = hash(source);
            const local = ports.localPreparation();
            const metadataJob = ports.metadata.job(job.id);
            if (metadataJob?.documentCreation) {
              if (!ports.creation) fail("DOCUMENT_CREATION_UNPROVEN", "Creation verifier is missing");
              ports.creation.program(metadataJob).assertProgram(
                metadataJob.request as unknown as import("@fmcad/core").QueueRequest, source,
              );
              const scope = local && local.job.id === job.id ? local.compiledScope : undefined;
              if (!scope || scope["producer"] !== "compiled-document-creation-v1" ||
                  scope["requestHash"] !== metadataJob.hash || scope["programHash"] !== metadataJob.documentCreation.programHash ||
                  scope["rpcHash"] !== metadataJob.documentCreation.rpcHash)
                fail("DOCUMENT_CREATION_UNPROVEN", "Actual ADDIN program differs from the fixed creation service");
              ports.creation.assertDocumentCreation(job.id, metadataJob.documentCreation.programHash, metadataJob.documentCreation.rpcHash);
            }
            if (metadataJob?.documentMetadataRead) {
              ports.metadata
                .program(metadataJob)
                .assertProgram(
                  metadataJob.request as unknown as import("@fmcad/core").QueueRequest,
                  source,
                );
              const scope =
                local && local.job.id === job.id
                  ? local.compiledScope
                  : undefined;
              if (
                !scope ||
                scope["producer"] !== "compiled-document-metadata-v1" ||
                scope["requestHash"] !== metadataJob.hash ||
                scope["programHash"] !== hash(source) ||
                scope["rpcHash"] !== metadataJob.documentMetadataRead.rpcHash
              )
                fail(
                  "DOCUMENT_METADATA_READ_UNPROVEN",
                  "Actual ADDIN program differs from the compiled metadata read",
                );
              ports.metadata.assertDocumentMetadataRead(
                job.id,
                hash(source),
                metadataJob.documentMetadataRead.rpcHash,
              );
            }
            if (local && local.job.id === job.id && local.compiledScope)
              binding["documentScope"] = {
                ...local.compiledScope,
                wireSourceHash: binding.sourceHash,
              };
            if (nativePublicPython)
              binding["publicPythonResultSchema"] =
                "fmcad-public-python-result-v1";
          },
          wrap(executable, official, nativePublicPython) {
            if (record.receipt === undefined || record.receipt === null)
              throw new TypeError("Missing broker record");
            const prepared = ports.prepareReceiptScript(
              executable,
              official,
              record.receipt,
              binding,
              {
                ...ports.nativePaths,
                ...(nativePublicPython
                  ? { capturePublicPythonResult: true }
                  : {}),
              },
            );
            return origin
              ? ports.retainPythonOrigin(prepared, origin)
              : prepared;
          },
        });
        if (pythonArtifact)
          record.pythonArtifact = {
            version: pythonArtifact.version,
            sha256: pythonArtifact.sha256,
            artifactHash: pythonArtifact.artifactHash,
            sourceMap: pythonArtifact.sourceMap,
            units: pythonArtifact.units.map(
              ({ id, filename, role, sha256 }) => ({
                id,
                filename,
                role,
                sha256,
              }),
            ),
          };
      }
      const metadataOnly = [
        "initialize",
        "notifications/initialized",
        "ping",
        "tools/list",
      ].includes(payload.method);
      let prepared: P.PreparedCall;
      if (rawMetadata) {
        if (!view.metadataAdmission)
          fail(
            "unsupported_queue_route",
            "ADDIN metadata admission is not provisioned",
          );
        const metadataProof = ports.prepareMetadataWire(outgoing);
        record.dispatchClass = "addin-metadata";
        prepared = {
          outgoing: metadataProof.wire,
          record,
          rpcId,
          contextEpoch,
          metadataOnly,
          metadataProof,
        };
      } else {
        const pythonCertificate = await ports.pythonAdmission.check(
          outgoing,
          pythonArtifact,
          ports.localCheckOptions(),
        );
        if (pythonCertificate.report)
          record.pythonCheck = pythonCertificate.report;
        record.dispatchClass = pythonCertificate.kind;
        prepared = {
          outgoing,
          record,
          rpcId,
          pythonArtifact,
          contextEpoch,
          metadataOnly,
          pythonCertificate,
        };
      }
      // Observation can suspend preparation, never replace certification.
      if (!prepared.metadataProof) await ports.testCheckPrepared?.(prepared);
      (prepared.metadataProof ?? prepared.pythonCertificate).fence(
        prepared.outgoing,
      );
      ports.verifyPreparedJob(job, prepared.contextEpoch);
      return prepared;
    },
  };
}

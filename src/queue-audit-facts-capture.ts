import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type {
  AuditBinding,
  AuditMessage,
  AuditReader,
  RecoveryAuditPorts,
} from "../packages/node-adapters/src/execution/recovery-audit";
import type { SourceInput } from "../packages/node-adapters/src/python/artifact";
import type { Reference } from "./queue-epoch-lineage";
const load = createRequire(__filename);
const { hash, readJson, fusionPath, sameInstance, buildHash } = load(
  "./queue-instance",
) as {
  hash(value: string): string;
  readJson(file: string, max?: number): unknown;
  fusionPath(file: string): string;
  sameInstance(a: unknown, b: unknown): boolean;
  buildHash(root: string): string;
};
const { fileHash, exclusive } = load(
  "./queue-atomic-migration-files",
) as typeof import("./queue-atomic-migration-files");
const { preparePythonArtifact, pythonLiteral, bindPythonArtifactManifest } =
  load(
    "./python",
  ) as typeof import("../packages/node-adapters/src/python/artifact") &
    typeof import("../packages/node-adapters/src/python/context-binding");
const { createRecoveryAudit, auditSummary, prepareRecoveryAuditWire } = load(
  "./queue-atomic-recovery-audit",
) as typeof import("./queue-atomic-recovery-audit");
const { auditResponseProofStillCurrent } = load(
  "./queue-audit-response-proof",
) as typeof import("./queue-audit-response-proof");
type Data = Record<string, unknown>;
interface CaptureProof {
  key: {
    clientId: string;
    requestId: string;
    jobId: string;
    observationJobId: string;
  };
  originalRpcId: string;
  evidenceHash: string;
  files: Record<string, Reference>;
  currentInstance: unknown;
  originalIdentity: unknown;
}
interface CapturePorts {
  auditPorts: RecoveryAuditPorts;
  scope?: { auditResponseRecovery?: CaptureProof };
  dir: string;
  targetJobId: string;
  state: { epoch?: unknown };
  approval: {
    candidateRoot: string;
    sourceCommit: string;
    qualification: Reference;
  };
  buildHash: string;
  ownerNonce: string;
  clients(): Record<string, string>;
  assertControl(value: unknown): void;
}
function fields(value: unknown): Data {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Data)
    : {};
}
function text(value: unknown): string {
  if (typeof value !== "string")
    fail(
      "AUDIT_CAPTURE_PROOF_INVALID",
      "Capture evidence requires an exact string identity or path",
    );
  return value;
}
function readRecord(file: string, limit = 256 * 1024 * 1024): Data {
  const value = readJson(file, limit);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail(
      "AUDIT_CAPTURE_PROOF_INVALID",
      "Object-shaped capture evidence required",
    );
  return value as Data;
}
const canonicalHash = (value: unknown): string =>
  (
    load(
      "./dist/core/application/cad/json",
    ) as typeof import("../packages/core/src/application/cad/json")
  ).hash(value);
function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
const kind = "atomic-audit-facts-capture";
const purpose = "atomic-recovery-audit-facts-capture-v1";
export function prepareAuditFactsCapture(
  installation: string,
  identity: unknown,
  binding: AuditBinding,
  { directory }: { directory: string },
): AuditReader {
  if (binding["captureProofPath"] !== path.join(directory, "sdk-facts.json"))
    fail("INVALID_CAPTURE_PATH", "Exact broker-derived evidence path required");
  const names = [
    "runtime/python/recovery/atomic_audit.py",
    "runtime/python/recovery/audit_facts_capture.py",
  ] as const;
  const inputs: SourceInput[] = names.map((filename, i) => ({
    id: i ? "current-facts-capture" : "audit-reader",
    filename,
    role: "runtime",
    source: fs.readFileSync(path.join(installation, filename), "utf8"),
  }));
  const args = {
    identity,
    proofPath: fusionPath(text(binding["captureProofPath"])),
    bindingHash: canonicalHash(binding),
    originalRpcId: binding["originalRpcId"],
  };
  inputs.push({
    id: "wrapper",
    filename: "<fmcad-current-facts-capture>",
    role: "wrapper",
    source: `
_AC_REQUEST: AaObject = ${pythonLiteral(args)}
def run(_context: str) -> None:
    import adsk.core
    captured = capture_current_audit_facts(_aa_cast(AaApplication, adsk.core.Application.get()), _AC_REQUEST)
    print('FMCAD_RESULT ' + _aa_json.dumps(captured['summary'], allow_nan=False))
`,
  });
  const artifact = preparePythonArtifact(inputs, {
    request: args,
    context: { kind: purpose, ...binding },
  });
  return {
    artifact,
    sourceFile: path.join(installation, names[1]),
    sourceSha256: hash(inputs[1]!.source),
  };
}
export function createAuditFactsCapture(p: CapturePorts) {
  const base = p.auditPorts,
    proof = p.scope?.auditResponseRecovery;
  const directory = path.join(p.dir, "jobs", p.targetJobId, kind);
  const authorityFile = path.join(
    p.dir,
    "isolated-scratch-creation-authority.json",
  );
  function original(clientId: string): CaptureProof {
    if (
      !proof ||
      proof.key.clientId !== clientId ||
      !auditResponseProofStillCurrent(proof)
    )
      fail(
        "AUDIT_CAPTURE_NOT_AUTHORIZED",
        "Only the exact owner-bound failed audit has a qualified facts observation grant",
      );
    if (p.state.epoch)
      fail(
        "EPOCH_ALREADY_EXISTS",
        "Never collect old audit facts after scratch admission has begun",
      );
    return proof;
  }
  const controller = createRecoveryAudit({
    ...base,
    kind,
    extraKeys: ["confirmReadOnly"],
    prepareReader: prepareAuditFactsCapture,
    async inspect(message, clientId) {
      const proof = original(clientId);
      if (
        message["confirmReadOnly"] !== true ||
        message["requestId"] !== proof.key.requestId
      )
        fail(
          "AUDIT_CAPTURE_CONFIRMATION_REQUIRED",
          "Explicit new read-only observation under the ORIGINAL audit request is required; no audit replay",
        );
      const value = await base.inspect(message, clientId);
      return {
        ...value,
        binding: {
          ...value.binding,
          purpose,
          originalRpcId: proof.originalRpcId,
          originalEvidenceHash: proof.evidenceHash,
          captureProofPath: path.join(directory, "sdk-facts.json"),
          producerRoot: p.approval.candidateRoot,
          producerBuildHash: p.buildHash,
          ownerTokenHash: p.clients()[clientId],
        },
      };
    },
    fence(value, inFlight) {
      const proof = original(text(value.binding["clientId"]));
      if (
        value.binding["originalEvidenceHash"] !== proof.evidenceHash ||
        value.binding["ownerTokenHash"] !==
          p.clients()[text(value.binding["clientId"])]
      )
        fail(
          "AUDIT_CAPTURE_FENCE_CHANGED",
          "Original audit or owner credential changed",
        );
      base.fence(value, inFlight);
    },
  });
  function derive() {
    if (!proof || !fs.existsSync(path.join(directory, "result.json")))
      return null;
    if (!auditResponseProofStillCurrent(proof))
      fail("AUDIT_CAPTURE_FENCE_CHANGED", "Original audit evidence changed");
    const read = (name: string): Data =>
      readRecord(path.join(directory, name + ".json"));
    const intent = read("intent"),
      start = read("start"),
      result = read("result"),
      wire = read("wire"),
      b = fields(intent["binding"]);
    if (result["sdkRequestsSent"] !== 1) return null;
    if (
      b["purpose"] !== purpose ||
      b["originalEvidenceHash"] !== proof.evidenceHash ||
      b["originalRpcId"] !== proof.originalRpcId ||
      canonicalHash(intent["key"]) !== canonicalHash(proof.key) ||
      b["producerRoot"] !== p.approval.candidateRoot ||
      b["producerBuildHash"] !== p.buildHash ||
      buildHash(text(b["producerRoot"])) !== p.buildHash ||
      Object.entries(fields(intent["key"])).some(([k, v]) => result[k] !== v) ||
      result["kind"] !== kind ||
      result["nativeOutcome"] !== "unknown" ||
      result["modelValidation"] !== "not_performed" ||
      result["rollbackVerification"] !== "not_performed" ||
      b["ownerTokenHash"] !== p.clients()[proof.key.clientId] ||
      !["failed", "complete"].includes(text(result["status"]))
    )
      fail(
        "AUDIT_CAPTURE_PROOF_INVALID",
        "Stored capture owner, result or qualified producer changed",
      );
    // Never infer facts from an error code (or its absence). The independent
    // exact SDK envelope + successful checked physical receipt below are the
    // authority; the failed transport result remains immutable and explicit.
    if (
      !fs.existsSync(text(b["captureProofPath"])) ||
      !fs.existsSync(text(start["receipt"]))
    )
      return null;
    const reader = prepareAuditFactsCapture(
      text(b["producerRoot"]),
      intent["identity"],
      b,
      { directory },
    );
    const payload = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "execute_python",
        arguments: {
          code: reader.artifact.script + '\n\nrun("")\n',
          persistent: false,
        },
      },
    };
    const expected = prepareRecoveryAuditWire({
      payload,
      reader,
      receipt: text(start["receipt"]),
      instance: b["currentInstance"],
      buildHash: p.buildHash,
      jobId: text(fields(intent["key"])["jobId"]),
      auditBinding: b,
      rpcId: text(fields(start["binding"])["rpcId"]),
    });
    if (
      reader.artifact.artifactHash !== intent["sourceArtifactHash"] ||
      reader.sourceSha256 !== intent["sourceSha256"] ||
      canonicalHash(start["binding"]) !==
        canonicalHash(expected.record.binding) ||
      canonicalHash(wire["outgoing"]) !== canonicalHash(expected.outgoing) ||
      fields(wire["artifact"])["artifactHash"] !==
        expected.artifact.artifactHash ||
      fields(start["pythonCheck"])["status"] !== "passed" ||
      fields(fields(start["pythonCheck"])["provenance"])["artifactHash"] !==
        fields(wire["artifact"])["artifactHash"] ||
      !sameInstance(start["instance"], proof.currentInstance) ||
      !sameInstance(b["currentInstance"], proof.currentInstance) ||
      path.dirname(text(start["receipt"])) !== directory ||
      base.remoteReceipt({
        ...start,
        binding: fields(start["binding"]),
        instance: start["instance"],
        receipt: text(start["receipt"]),
      }).outcome !== "succeeded"
    )
      fail(
        "AUDIT_CAPTURE_PROOF_INVALID",
        "Facts need the exact qualified producer, checked final wire and successful process-bound physical receipt",
      );
    bindPythonArtifactManifest(
      text(
        fields(fields(fields(wire["outgoing"])["params"])["arguments"])["code"],
      ),
      wire["artifact"],
    );
    const sdk = readRecord(text(b["captureProofPath"]));
    if (
      sdk["version"] !== 1 ||
      sdk["kind"] !== "atomic-current-facts-capture-v1" ||
      sdk["bindingHash"] !== canonicalHash(b) ||
      sdk["originalRpcId"] !== proof.originalRpcId ||
      !Number.isSafeInteger(sdk["observedAtMs"]) ||
      typeof sdk["observedAtMs"] !== "number" ||
      sdk["observedAtMs"] <= 0 ||
      sdk["historicalOutcome"] !== "unknown" ||
      sdk["modelValidation"] !== "not_performed" ||
      sdk["rollbackVerification"] !== "not_performed"
    )
      fail(
        "AUDIT_CAPTURE_PROOF_INVALID",
        "No exact durable SDK-produced facts envelope",
      );
    const summary = auditSummary(
      {
        result: {
          content: [
            {
              type: "text",
              text: "FMCAD_RESULT " + JSON.stringify(sdk["summary"]),
            },
          ],
        },
      },
      intent["identity"],
    );
    if (
      result["status"] === "complete" &&
      canonicalHash(result["summary"]) !== canonicalHash(summary)
    )
      fail("AUDIT_CAPTURE_PROOF_INVALID", "Network and SDK facts disagree");
    const captureFiles: Record<string, string> = {
      captureIntent: path.join(directory, "intent.json"),
      captureStart: path.join(directory, "start.json"),
      captureWire: path.join(directory, "wire.json"),
      captureResult: path.join(directory, "result.json"),
      captureSdkFacts: text(b["captureProofPath"]),
      captureRemote: text(start["receipt"]),
    };
    const responseFile = path.join(directory, "response.json");
    if (fs.existsSync(responseFile)) {
      const response = readRecord(responseFile);
      if (
        canonicalHash(response["binding"]) !==
          canonicalHash(start["binding"]) ||
        response["wireId"] !== fields(wire["outgoing"])["id"] ||
        fields(response["reply"])["id"] !== fields(wire["outgoing"])["id"] ||
        response["callerId"] !== 2 ||
        canonicalHash(response["summary"]) !== canonicalHash(summary)
      )
        fail(
          "AUDIT_CAPTURE_PROOF_INVALID",
          "Durable wire reply and SDK facts disagree",
        );
      captureFiles["captureResponse"] = responseFile;
    }
    const files = {
      ...proof.files,
      ...Object.fromEntries(
        Object.entries(captureFiles).map(([name, file]) => [
          name,
          { path: file, sha256: fileHash(file).sha256 },
        ]),
      ),
    };
    const derived = {
      version: 1,
      kind: "derived-current-audit-facts-v1",
      key: intent["key"],
      status: "complete",
      originalAuditStatus: {
        status: "failed",
        code: "EPROTO",
        endpointVerified: false,
      },
      originalAuditFactsRecovered: false,
      observation:
        "one explicit new read-only observation, not original RPC replay",
      originalRpcId: proof.originalRpcId,
      currentInstance: b["currentInstance"],
      historicalInstance: b["historicalInstance"],
      observedAtMs: sdk["observedAtMs"],
      endpointVerified: true,
      summary,
      transportStatus: result["status"],
      transportCode: result["code"] || null,
      sdkRequestsSent: 1,
      currentModelingAdmission: "blocked-pending-separate-facts-approval",
      files,
      historicalOutcome: "unknown",
      modelValidation: "not_performed",
      rollbackVerification: "not_performed",
      factsComplete: true,
      epochEligible:
        result["status"] === "complete" &&
        fields(summary["ui"])["idle"] === true &&
        summary["modulePresent"] === false &&
        fields(summary["commandDefinition"])["status"] === "absent",
    };
    const derivedFile = path.join(directory, "derived-facts.json");
    exclusive(derivedFile, derived);
    return {
      derived,
      derivedFile,
      files: {
        ...files,
        derivedFacts: {
          path: derivedFile,
          sha256: fileHash(derivedFile).sha256,
        },
      },
    };
  }
  function validateFactsApproval(
    a: Data,
    captured: NonNullable<ReturnType<typeof derive>>,
  ) {
    if (!proof)
      fail("EPOCH_AUDIT_REQUIRED", "Original response proof required");
    if (
      Object.keys(a).sort().join(",") !==
        "auditRequestId,buildHash,currentInstance,derivedFacts,purpose,qualification,sourceCommit,version" ||
      a["version"] !== 1 ||
      a["purpose"] !== "isolated-scratch-current-facts-approval-v1" ||
      a["auditRequestId"] !== proof.key.requestId ||
      a["sourceCommit"] !== p.approval.sourceCommit ||
      a["buildHash"] !== p.buildHash ||
      canonicalHash(a["qualification"]) !==
        canonicalHash(p.approval.qualification) ||
      fields(a["derivedFacts"])["path"] !== captured.derivedFile ||
      fields(a["derivedFacts"])["sha256"] !==
        captured.files.derivedFacts.sha256 ||
      !sameInstance(a["currentInstance"], captured.derived.currentInstance) ||
      fileHash(p.approval.qualification.path).sha256 !==
        p.approval.qualification.sha256
    )
      fail(
        "EPOCH_AUDIT_REQUIRED",
        "Approval must pin the qualified runtime and these actual captured facts",
      );
  }
  function approvedPrerequisite() {
    if (!proof || !fs.existsSync(authorityFile)) return null;
    const authority = readRecord(authorityFile, 16 * 1024 * 1024),
      captured = derive();
    if (
      !captured ||
      captured.derived.epochEligible !== true ||
      authority["version"] !== 1 ||
      authority["kind"] !== "owner-approved-new-scratch-creation-authority" ||
      authority["permission"] !== "one-proven-new-document-only" ||
      authority["globalModelingAdmission"] !== "blocked" ||
      authority["historicalOutcome"] !== "unknown" ||
      authority["buildHash"] !== p.buildHash ||
      authority["clientId"] !== proof.key.clientId ||
      authority["ownerTokenHash"] !==
        p.clients()[text(authority["clientId"])] ||
      authority["derivedFactsHash"] !== captured.files.derivedFacts.sha256 ||
      authority["ownerNonce"] !== p.ownerNonce
    )
      fail(
        "EPOCH_AUDIT_REQUIRED",
        "Current facts creation authority is not bound to the exact owner/build/capture",
      );
    const files = {
      ...captured.files,
      creationAuthority: {
        path: authorityFile,
        sha256: fileHash(authorityFile).sha256,
      },
      factsApproval: authority["approval"],
      runtimeQualification: p.approval.qualification,
    };
    if (
      fileHash(text(fields(authority["approval"])["path"])).sha256 !==
      fields(authority["approval"])["sha256"]
    )
      fail("EPOCH_AUDIT_REQUIRED", "Facts approval changed");
    validateFactsApproval(
      readRecord(text(fields(authority["approval"])["path"]), 32768),
      captured,
    );
    return {
      files,
      clientId: proof.key.clientId,
      hash: canonicalHash(files),
      currentInstance: captured.derived.currentInstance,
      originalInstance: captured.derived.historicalInstance,
      identity: proof.originalIdentity,
      historicalOutcome: "unknown",
    };
  }
  return {
    async handle(message: AuditMessage, clientId: string) {
      original(clientId);
      const result = await controller.handle(message, clientId);
      if (result["status"] === "pending") return result;
      return derive()?.derived || result; // File-only completion; NEVER another SDK send.
    },
    approvedPrerequisite,
    async authorize(message: Data, clientId: string) {
      const proof = original(clientId);
      p.assertControl(message["control"]);
      if (
        Object.keys(message).some(
          (k) =>
            ![
              "action",
              "auth",
              "control",
              "requestId",
              "confirmCurrentFacts",
              "approval",
            ].includes(k),
        )
      )
        fail(
          "INVALID_REQUEST",
          "Only exact actual-facts approval is supported",
        );
      if (
        message["requestId"] !== proof.key.requestId ||
        message["confirmCurrentFacts"] !== true ||
        typeof message["approval"] !== "string" ||
        !path.isAbsolute(message["approval"])
      )
        fail(
          "EPOCH_FACTS_CONFIRMATION_REQUIRED",
          "Separate actual-facts approval required before any scratch creation permission",
        );
      const captured = derive();
      if (!captured?.derived.epochEligible)
        fail("EPOCH_AUDIT_REQUIRED", "No qualified actual current facts");
      const approvalHash = fileHash(message["approval"]).sha256;
      const a = readRecord(message["approval"], 32768);
      validateFactsApproval(a, captured);
      const inspected = await base.inspect(
        { ...proof.key, control: message["control"] },
        clientId,
      );
      base.begin();
      try {
        base.fence(inspected, false);
        if (
          fileHash(message["approval"]).sha256 !== approvalHash ||
          Object.values(captured.files).some(
            (entry) => fileHash(entry.path).sha256 !== entry.sha256,
          )
        )
          fail(
            "EPOCH_AUDIT_REQUIRED",
            "Actual-facts approval or capture evidence changed during authorization",
          );
        exclusive(authorityFile, {
          version: 1,
          kind: "owner-approved-new-scratch-creation-authority",
          clientId,
          ownerTokenHash: p.clients()[clientId],
          ownerNonce: p.ownerNonce,
          buildHash: p.buildHash,
          derivedFactsHash: captured.files.derivedFacts.sha256,
          approval: { path: message["approval"], sha256: approvalHash },
          historicalOutcome: "unknown",
          globalModelingAdmission: "blocked",
          permission: "one-proven-new-document-only",
        });
        return {
          permission: "one-proven-new-document-only",
          globalModelingAdmission: "blocked",
          historicalOutcome: "unknown",
        };
      } finally {
        base.end();
      }
    },
  };
}
export async function auditFactsAction(
  client: { call(action: string, input?: unknown): Promise<Data> },
  action: string,
  input: Data,
  expectedBuild: string,
) {
  const status = await client.call("queue-summary");
  if (
    !["capture-audit-facts", "authorize-isolated-scratch"].includes(action) ||
    fields(status["features"])["auditFactsCapture"] !== true
  )
    fail(
      "AUDIT_CAPTURE_UNSUPPORTED",
      "Broker has no separately qualified original-audit facts recovery contract",
    );
  if (fields(status["control"])["buildHash"] !== expectedBuild)
    fail("BUILD_CHANGED", "Reader CLI and actual broker build must match");
  const { instanceId, generation, contextEpoch } = fields(status["control"]);
  return client.call(action, {
    ...input,
    control: { instanceId, generation, contextEpoch, buildHash: expectedBuild },
  });
}

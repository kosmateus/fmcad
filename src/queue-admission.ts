import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type {
  PreparedPythonArtifact,
  PythonArtifactManifest,
} from "../packages/core/src/domain/python-artifact";
import type { PythonCheckReport } from "../packages/core/src/domain/python-checker";
import type { PythonRpcCertificate } from "../packages/node-adapters/src/python/admission";

const load = createRequire(__filename);
const { createPythonChecker } = load(
  "./dist/python/checker",
) as typeof import("../packages/node-adapters/src/python/checker");
const { createPythonRpcAdmission, pythonAdmissionResources } = load(
  "./dist/python/admission",
) as typeof import("../packages/node-adapters/src/python/admission");
const { cadBundleUnits } = load(
  "./dist/python/bundle",
) as typeof import("../packages/node-adapters/src/python/bundle");
const { verifyPythonArtifact } = load(
  "./dist/python/artifact",
) as typeof import("../packages/node-adapters/src/python/artifact");
const { resolveRuntimePaths } = load(
  "./dist/config-platform",
) as typeof import("../packages/node-adapters/src/config-platform/runtime-paths");
const { buildHash, hash } = load("./queue-instance") as {
  buildHash(): string;
  hash(bytes: string | Uint8Array): string;
};
const { hash: canonicalHash } = load(
  "./dist/core/application/cad/json",
) as typeof import("../packages/core/src/application/cad/json");
function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
interface AbiUnit {
  id: string;
  filename: string;
  sha256: string;
}
interface SourceReceipt {
  rpcId: string;
  sourceHash: string;
}
interface AbiWitness {
  operation: string;
  rpcId: string;
  sourceHash: string;
  generatorBuildHash: string;
  reconstructedBuilderArtifactHash: string;
  originalReceiptArtifactHash: string;
}
export interface AtomicRuntimeAbi {
  version: number;
  kind: string;
  jobId: string;
  requestId: string;
  jobHash: string;
  originalBuildHash: string;
  identityHash: string;
  abiPinnedUnits: AbiUnit[];
  sourceReceipts: SourceReceipt[];
  witness?: AbiWitness;
}
interface OriginUnit {
  id: string;
  filename: string;
  role: string;
  sha256: string;
}
interface Origin {
  artifactHash: string;
  sha256: string;
  units: OriginUnit[];
  sourceMap: {
    unitId: string;
    generatedStartLine: number;
    generatedEndLine: number;
    sourceStartLine: number;
  }[];
  segments: { sha256: string; startLine: number; endLine: number }[];
  context?: unknown;
  request?: unknown;
}
export interface ObserverBinding {
  atomicRuntimeAbiHash?: string;
  observationTargetJobId?: string;
  observationIdentityHash?: string;
  pythonOriginHash?: string;
  sourceHash?: string;
  observationKind?: string;
  rpcId?: string;
  buildHash?: string;
}
interface Rpc extends Record<string, unknown> {
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}
export type ObserverArtifactRecord = Omit<
  PythonArtifactManifest,
  "runtimeVersion" | "units"
> & {
  units: readonly Pick<
    PreparedPythonArtifact["units"][number],
    "id" | "filename" | "role" | "sha256"
  >[];
};
export interface ScopedPrepared {
  outgoing: Rpc;
  pythonArtifact: PreparedPythonArtifact;
  rpcId: string;
  record: {
    binding: ObserverBinding;
    atomicRuntimeAbi?: AtomicRuntimeAbi;
    pythonArtifact?: ObserverArtifactRecord;
    receipt?: string;
    pythonCheck?: PythonCheckReport;
    dispatchClass?: string;
  };
  dispatchTimeoutMs: number;
  pythonCertificate?: PythonRpcCertificate;
}
interface CheckedState {
  certificate: PythonRpcCertificate;
  outgoing: Rpc;
  artifact: PreparedPythonArtifact;
  record: ScopedPrepared["record"];
  binding: ObserverBinding;
  bindingJson: string;
  originJson: string;
  abiProofJson: string;
  buildHash: string;
  artifactHash: string;
  userSourceHash: string;
  recordJson: string;
  dispatchTimeoutMs: number;
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}
function originUnit(value: unknown): value is OriginUnit {
  return (
    object(value) &&
    typeof value["id"] === "string" &&
    typeof value["filename"] === "string" &&
    typeof value["role"] === "string" &&
    digest(value["sha256"])
  );
}
function sourceMapEntry(value: unknown): value is Origin["sourceMap"][number] {
  return (
    object(value) &&
    typeof value["unitId"] === "string" &&
    integer(value["generatedStartLine"]) &&
    integer(value["generatedEndLine"]) &&
    integer(value["sourceStartLine"]) &&
    value["generatedStartLine"] >= 1 &&
    value["generatedEndLine"] >= value["generatedStartLine"] &&
    value["sourceStartLine"] >= 1
  );
}
function segment(value: unknown): value is Origin["segments"][number] {
  return (
    object(value) &&
    digest(value["sha256"]) &&
    integer(value["startLine"]) &&
    integer(value["endLine"]) &&
    value["startLine"] >= 1 &&
    value["endLine"] >= value["startLine"]
  );
}
const atomicAbiFiles = new Set([
  "runtime/python/fmcad/adapters/fusion/atomic.py",
  "runtime/python/fmcad/adapters/fusion/identity.py",
  "runtime/python/fmcad/adapters/fusion/values.py",
  "runtime/python/fmcad/domain/values.py",
  "assets/cad/core.py",
]);

function canonicalAtomicAbiUnits(installation: string) {
  const units = cadBundleUnits(installation, "full")
    .filter((unit) => atomicAbiFiles.has(unit.filename))
    .map((unit) => ({
      id: unit.id,
      filename: unit.filename,
      sha256: hash(unit.source),
    }));
  if (units.length !== atomicAbiFiles.size)
    fail(
      "PYTHON_ADMISSION_UNAVAILABLE",
      "Canonical atomic ABI unit inventory is incomplete",
    );
  return units;
}

function validateAtomicRuntimeAbi(
  proof: AtomicRuntimeAbi | undefined,
  binding: ObserverBinding,
  installation: string,
) {
  const validKind = [
    "original-unit-manifest-v1",
    "legacy-full-program-witness-v1",
  ].includes(proof?.kind ?? "");
  if (
    !proof ||
    proof.version !== 1 ||
    !validKind ||
    typeof proof.jobId !== "string" ||
    !proof.jobId.trim() ||
    typeof proof.requestId !== "string" ||
    !proof.requestId.trim() ||
    !/^[a-f0-9]{64}$/.test(proof.jobHash || "") ||
    !/^[a-f0-9]{64}$/.test(proof.originalBuildHash || "") ||
    !/^[a-f0-9]{64}$/.test(proof.identityHash || "") ||
    !Array.isArray(proof.abiPinnedUnits) ||
    !Array.isArray(proof.sourceReceipts) ||
    !proof.sourceReceipts.length ||
    !/^[a-f0-9]{64}$/.test(binding.atomicRuntimeAbiHash || "") ||
    binding.observationTargetJobId !== proof.jobId ||
    binding.observationIdentityHash !== proof.identityHash ||
    canonicalHash(proof) !== binding.atomicRuntimeAbiHash
  ) {
    fail(
      "PYTHON_ADMISSION_UNAVAILABLE",
      "Scoped observer original-runtime ABI proof is missing or malformed",
    );
  }
  const proofKeys = [
    "version",
    "jobId",
    "requestId",
    "jobHash",
    "originalBuildHash",
    "identityHash",
    "kind",
    "abiPinnedUnits",
    "sourceReceipts",
    ...(proof.kind === "legacy-full-program-witness-v1" ? ["witness"] : []),
  ];
  if (Object.keys(proof).sort().join("\0") !== proofKeys.sort().join("\0"))
    fail(
      "RECEIPT_MISMATCH",
      "Original atomic ABI proof contains unexpected fields",
    );
  const units = canonicalAtomicAbiUnits(installation);
  if (canonicalHash(proof.abiPinnedUnits) !== canonicalHash(units))
    fail(
      "BUILD_CHANGED",
      "Pinned original atomic ABI units differ from the canonical installed source",
    );
  const rpcIds = new Set();
  for (const receipt of proof.sourceReceipts) {
    if (
      !receipt ||
      Object.keys(receipt).sort().join("\0") !==
        ["rpcId", "sourceHash"].sort().join("\0") ||
      !/^[a-f0-9-]{36}$/.test(receipt.rpcId || "") ||
      !/^[a-f0-9]{64}$/.test(receipt.sourceHash || "") ||
      rpcIds.has(receipt.rpcId)
    ) {
      fail(
        "RECEIPT_MISMATCH",
        "Original atomic source receipt inventory is invalid",
      );
    }
    rpcIds.add(receipt.rpcId);
  }
  if (proof.kind === "legacy-full-program-witness-v1") {
    const witness = proof.witness;
    if (
      !witness ||
      Object.keys(witness).sort().join("\0") !==
        [
          "operation",
          "rpcId",
          "sourceHash",
          "generatorBuildHash",
          "reconstructedBuilderArtifactHash",
          "originalReceiptArtifactHash",
        ]
          .sort()
          .join("\0") ||
      witness.operation !== "atomic_resolve" ||
      !rpcIds.has(witness.rpcId) ||
      !/^[a-f0-9]{64}$/.test(witness.sourceHash || "") ||
      !/^[a-f0-9]{64}$/.test(witness.generatorBuildHash || "") ||
      witness.generatorBuildHash !== proof.originalBuildHash ||
      !/^[a-f0-9]{64}$/.test(witness.reconstructedBuilderArtifactHash || "") ||
      !/^[a-f0-9]{64}$/.test(witness.originalReceiptArtifactHash || "")
    ) {
      fail("RECEIPT_MISMATCH", "Legacy atomic ABI witness is invalid");
    }
    const sourceReceipt = proof.sourceReceipts.find(
      (receipt) => receipt.rpcId === witness.rpcId,
    );
    if (sourceReceipt?.sourceHash !== witness.sourceHash)
      fail(
        "RECEIPT_MISMATCH",
        "Legacy atomic ABI witness source differs from its original receipt",
      );
  }
  return proof;
}

function verifiedOrigin(artifact: PreparedPythonArtifact): Origin {
  const context = artifact.context;
  const origin = object(context) ? context["origin"] : null;
  if (
    !object(origin) ||
    !digest(origin["artifactHash"]) ||
    !digest(origin["sha256"]) ||
    !Array.isArray(origin["units"]) ||
    !origin["units"].length ||
    !Array.isArray(origin["sourceMap"]) ||
    !origin["sourceMap"].length ||
    !Array.isArray(origin["segments"]) ||
    !origin["segments"].length
  )
    fail(
      "PYTHON_ADMISSION_UNAVAILABLE",
      "Scoped observer receipt has no verified original source-unit manifest",
    );
  const originUnits: unknown[] = origin["units"];
  if (
    !originUnits.every(originUnit) ||
    new Set(originUnits.map((unit) => unit.id)).size !== originUnits.length
  )
    fail(
      "PYTHON_ADMISSION_UNAVAILABLE",
      "Scoped observer origin unit inventory is invalid",
    );
  const sourceMap: unknown[] = origin["sourceMap"];
  if (
    !sourceMap.every(sourceMapEntry) ||
    sourceMap.some(
      (entry) => !originUnits.some((unit) => unit.id === entry.unitId),
    )
  )
    fail(
      "PYTHON_ADMISSION_UNAVAILABLE",
      "Scoped observer origin source map is invalid",
    );
  const segments: unknown[] = origin["segments"];
  const userUnits =
    artifact.units?.filter((unit) => unit.role === "user") || [];
  const userUnit = userUnits[0];
  if (
    userUnits.length !== 1 ||
    !userUnit ||
    !segments.every(segment) ||
    !segments.some((item) => item.sha256 === userUnit.sha256)
  )
    fail(
      "PYTHON_ADMISSION_UNAVAILABLE",
      "Scoped observer origin does not map its exact final user source unit",
    );
  // Preserve the original object and property order for the asynchronous fence.
  // These structural checks establish the type without asserting untrusted data.
  if (!isOrigin(origin))
    fail(
      "PYTHON_ADMISSION_UNAVAILABLE",
      "Scoped observer origin context is malformed",
    );
  return origin;
}
function isOrigin(
  value: Record<string, unknown>,
): value is Record<string, unknown> & Origin {
  return (
    digest(value["artifactHash"]) &&
    digest(value["sha256"]) &&
    Array.isArray(value["units"]) &&
    value["units"].every(originUnit) &&
    Array.isArray(value["sourceMap"]) &&
    value["sourceMap"].every(sourceMapEntry) &&
    Array.isArray(value["segments"]) &&
    value["segments"].every(segment)
  );
}

export function createProductionQueueAdmission(
  runtime = resolveRuntimePaths({ anchor: __filename }).runtime,
) {
  const installation = resolveRuntimePaths({ anchor: __filename }).installation;
  const typingRoot = path.join(runtime, "typing");
  const checkerRoot = path.dirname(
    require.resolve("basedpyright/package.json"),
  );
  const resources = () => pythonAdmissionResources([typingRoot, checkerRoot]);
  const checker = createPythonChecker({
    typingRoot,
    definitionsRoot: typingRoot,
    pythonPlatform: "Windows",
    checkerResources: () => pythonAdmissionResources([checkerRoot]),
  });
  const admission = createPythonRpcAdmission({ runtime, checker, resources });
  const checked = new WeakMap<ScopedPrepared, CheckedState>();

  function validatePrepared(
    prepared: ScopedPrepared,
    expectedBuildHash: string,
  ) {
    if (
      !prepared ||
      typeof prepared !== "object" ||
      !prepared.outgoing ||
      !prepared.pythonArtifact ||
      !prepared.record ||
      !prepared.record.binding
    ) {
      fail(
        "PYTHON_ADMISSION_UNAVAILABLE",
        "Scoped atomic status has no final prepared Python artifact",
      );
    }
    const args = prepared.outgoing.params?.arguments;
    if (
      prepared.outgoing.method !== "tools/call" ||
      prepared.outgoing.params?.name !== "execute_python" ||
      !args ||
      args["persistent"] !== false ||
      args["session_id"] !== undefined ||
      Object.keys(args).some((key) => !["code", "persistent"].includes(key))
    ) {
      fail(
        "WORKFLOW_OBSERVATION_NOT_ALLOWED",
        "Scoped admission accepts only the final persistent:false execute_python artifact",
      );
    }
    if (
      typeof args["code"] !== "string" ||
      args["code"] !== prepared.pythonArtifact.script
    ) {
      fail(
        "WORKFLOW_ARTIFACT_CHANGED",
        "Final observer bytes do not match the prepared Python artifact",
      );
    }
    const origin = verifiedOrigin(prepared.pythonArtifact);
    const originContext = object(origin.context) ? origin.context : {};
    const binding = prepared.record.binding;
    const suppliedAbi = prepared.record.atomicRuntimeAbi;
    const abiProof = validateAtomicRuntimeAbi(
      suppliedAbi,
      binding,
      installation,
    );
    if (
      binding.pythonOriginHash !== origin.artifactHash ||
      originContext["atomicRuntimeAbiHash"] !== binding.atomicRuntimeAbiHash ||
      canonicalHash(originContext["abiPinnedUnits"]) !==
        canonicalHash(abiProof.abiPinnedUnits) ||
      !Array.isArray(originContext["executedUnits"]) ||
      canonicalHash(originContext["executedUnits"]) !==
        canonicalHash(origin.units.map((unit) => unit.filename))
    ) {
      fail(
        "WORKFLOW_ARTIFACT_CHANGED",
        "Original source manifest is not bound to the atomic ABI proof and executed units",
      );
    }
    const userUnits =
      prepared.pythonArtifact.units?.filter((unit) => unit.role === "user") ||
      [];
    if (
      userUnits.length !== 1 ||
      typeof binding.sourceHash !== "string" ||
      userUnits[0]!.sha256 !== binding.sourceHash ||
      binding.observationKind !== "atomic_holder_status" ||
      typeof binding.observationTargetJobId !== "string" ||
      !binding.observationTargetJobId.trim() ||
      !/^[a-f0-9]{64}$/.test(binding.observationIdentityHash || "") ||
      prepared.record.pythonArtifact?.version !==
        prepared.pythonArtifact.version ||
      prepared.record.pythonArtifact?.sha256 !==
        prepared.pythonArtifact.sha256 ||
      prepared.record.pythonArtifact?.artifactHash !==
        prepared.pythonArtifact.artifactHash ||
      canonicalHash(prepared.record.pythonArtifact?.sourceMap) !==
        canonicalHash(prepared.pythonArtifact.sourceMap) ||
      canonicalHash(prepared.record.pythonArtifact?.context) !==
        canonicalHash(prepared.pythonArtifact.context) ||
      canonicalHash(prepared.record.pythonArtifact?.request) !==
        canonicalHash(prepared.pythonArtifact.request) ||
      canonicalHash(prepared.record.pythonArtifact?.units) !==
        canonicalHash(
          prepared.pythonArtifact.units.map(
            ({ id, filename, role, sha256 }) => ({
              id,
              filename,
              role,
              sha256,
            }),
          ),
        ) ||
      canonicalHash(prepared.pythonArtifact.request) !==
        canonicalHash(binding) ||
      typeof prepared.record.receipt !== "string" ||
      typeof prepared.rpcId !== "string" ||
      binding.rpcId !== prepared.rpcId ||
      typeof expectedBuildHash !== "string" ||
      binding.buildHash !== expectedBuildHash
    ) {
      fail(
        "WORKFLOW_ARTIFACT_CHANGED",
        "Observer receipt/source/broker bindings do not match the final artifact",
      );
    }
    if (
      !Number.isSafeInteger(prepared.dispatchTimeoutMs) ||
      prepared.dispatchTimeoutMs <= 0
    ) {
      fail(
        "INVALID_TIMEOUT",
        "Scoped observer requires a positive prepared dispatch timeout",
      );
    }
    return { binding, userSourceHash: userUnits[0]!.sha256, origin, abiProof };
  }

  async function checkPrepared(prepared: ScopedPrepared) {
    const currentBuildHash = buildHash();
    const { binding, userSourceHash, origin, abiProof } = validatePrepared(
      prepared,
      currentBuildHash,
    );
    const bindingJson = JSON.stringify(binding);
    const originJson = JSON.stringify(origin);
    const abiProofJson = JSON.stringify(abiProof);
    const outgoing = prepared.outgoing;
    const artifact = prepared.pythonArtifact;
    const record = prepared.record;
    const recordJson = JSON.stringify(record);
    const dispatchTimeoutMs = prepared.dispatchTimeoutMs;
    verifyPythonArtifact(prepared.pythonArtifact);
    const certificate = await admission.check(
      prepared.outgoing,
      prepared.pythonArtifact,
    );
    if (
      prepared.outgoing !== outgoing ||
      prepared.pythonArtifact !== artifact ||
      prepared.record !== record ||
      JSON.stringify(prepared.record) !== recordJson ||
      prepared.dispatchTimeoutMs !== dispatchTimeoutMs ||
      prepared.record.binding !== binding ||
      JSON.stringify(binding) !== bindingJson ||
      JSON.stringify(verifiedOrigin(prepared.pythonArtifact)) !== originJson ||
      JSON.stringify(validatePrepared(prepared, currentBuildHash).abiProof) !==
        abiProofJson
    ) {
      fail(
        "WORKFLOW_ARTIFACT_CHANGED",
        "Observer receipt binding/origin/ABI proof changed during Python analysis",
      );
    }
    if (
      certificate.kind !== "python" ||
      !certificate.artifact ||
      !certificate.report ||
      certificate.report.status !== "passed" ||
      certificate.artifact.artifactHash !== prepared.pythonArtifact.artifactHash
    ) {
      fail(
        "PYTHON_ADMISSION_UNAVAILABLE",
        "Scoped observer did not receive a complete real Python admission certificate",
      );
    }
    verifyPythonArtifact(prepared.pythonArtifact);
    prepared.pythonCertificate = certificate;
    prepared.record.pythonCheck = certificate.report;
    prepared.record.dispatchClass = certificate.kind;
    checked.set(prepared, {
      certificate,
      outgoing: prepared.outgoing,
      artifact: prepared.pythonArtifact,
      record: prepared.record,
      binding,
      bindingJson,
      originJson,
      abiProofJson,
      buildHash: currentBuildHash,
      artifactHash: prepared.pythonArtifact.artifactHash,
      userSourceHash,
      recordJson: JSON.stringify(prepared.record),
      dispatchTimeoutMs,
    });
    return certificate;
  }

  function fencePrepared(prepared: ScopedPrepared, expectedBuildHash: string) {
    const state = prepared && checked.get(prepared);
    if (
      !state ||
      prepared.pythonCertificate !== state.certificate ||
      prepared.outgoing !== state.outgoing ||
      prepared.pythonArtifact !== state.artifact ||
      prepared.record !== state.record ||
      prepared.record.binding !== state.binding ||
      JSON.stringify(prepared.record.binding) !== state.bindingJson ||
      JSON.stringify(prepared.record) !== state.recordJson ||
      prepared.dispatchTimeoutMs !== state.dispatchTimeoutMs
    ) {
      fail(
        "PYTHON_ADMISSION_UNAVAILABLE",
        "Scoped observer lost its checked final-byte certificate",
      );
    }
    if (
      expectedBuildHash !== state.buildHash ||
      buildHash() !== state.buildHash
    ) {
      fail(
        "BUILD_CHANGED",
        "Broker build changed after scoped Python admission",
      );
    }
    const { binding, userSourceHash, origin, abiProof } = validatePrepared(
      prepared,
      state.buildHash,
    );
    if (
      binding.sourceHash !== state.userSourceHash ||
      userSourceHash !== state.userSourceHash ||
      prepared.pythonArtifact.artifactHash !== state.artifactHash ||
      JSON.stringify(origin) !== state.originJson ||
      JSON.stringify(abiProof) !== state.abiProofJson
    ) {
      fail(
        "WORKFLOW_ARTIFACT_CHANGED",
        "Scoped observer source binding changed after Python analysis",
      );
    }
    verifyPythonArtifact(prepared.pythonArtifact);
    state.certificate.fence(prepared.outgoing);
  }

  return {
    admission,
    checkPrepared,
    fencePrepared,
    checkerFingerprint: resources,
  };
}

export async function migrationAdmissionPreflight(prepared: ScopedPrepared) {
  const runtime = resolveRuntimePaths({ anchor: __filename }).runtime;
  const production = createProductionQueueAdmission(runtime);
  const certificate = await production.checkPrepared(prepared);
  const currentBuildHash = buildHash();
  production.fencePrepared(prepared, currentBuildHash);
  if (!certificate.report || !certificate.artifact)
    fail("PYTHON_ADMISSION_UNAVAILABLE", "Migration certificate is incomplete");
  const provenance = certificate.report.provenance;
  const sourceUnit = certificate.artifact.units.find(
    (unit) => unit.role === "user",
  );
  if (!sourceUnit || !prepared.record.atomicRuntimeAbi)
    fail("PYTHON_ADMISSION_UNAVAILABLE", "Migration origin is incomplete");
  const origin = verifiedOrigin(certificate.artifact);
  return Object.freeze({
    version: 1,
    production: true,
    scopedAtomicObservation: true,
    finalByteCertificate: true,
    status: certificate.report.status,
    buildHash: currentBuildHash,
    sourceModuleHash: hash(fs.readFileSync(__filename)),
    sourceHash: sourceUnit.sha256,
    artifactHash: certificate.artifact.artifactHash,
    originArtifactHash: origin.artifactHash,
    originSourceHash: origin.sha256,
    originContextHash: hash(JSON.stringify(origin.context ?? null)),
    originUnitHashes: origin.units.map(({ id, filename, role, sha256 }) => ({
      id,
      filename,
      role,
      sha256,
    })),
    atomicRuntimeAbiHash: prepared.record.binding.atomicRuntimeAbiHash,
    atomicRuntimeAbiKind: prepared.record.atomicRuntimeAbi.kind,
    executedUnits: origin.units.map(({ id, filename, role, sha256 }) => ({
      id,
      filename,
      role,
      sha256,
    })),
    checkedUnits: certificate.artifact.units.map(
      ({ id, filename, role, sha256 }) => ({ id, filename, role, sha256 }),
    ),
    abiPinnedUnits: prepared.record.atomicRuntimeAbi.abiPinnedUnits,
    abiSourceReceiptCount:
      prepared.record.atomicRuntimeAbi.sourceReceipts.length,
    observationKind: prepared.record.binding.observationKind,
    observationTargetJobId: prepared.record.binding.observationTargetJobId,
    observationIdentityHash: prepared.record.binding.observationIdentityHash,
    checkerFingerprint: production.checkerFingerprint(),
    checker: provenance.checker,
    checkerVersion: provenance.checkerVersion,
    checkerHash: provenance.checkerHash,
    definitionsHash: provenance.definitionsHash,
    contextHash: provenance.contextHash,
    configHash: provenance.configHash,
    typingHash: provenance.typingHash,
    pythonVersion: provenance.pythonVersion,
    pythonInterpreterVersion: provenance.pythonInterpreterVersion,
  });
}

interface PreparedAudit {
  artifact: PreparedPythonArtifact;
  record: {
    binding: {
      purpose?: string;
      auditBindingHash?: string;
      auditExpectedInstance?: unknown;
      pythonOriginHash?: string;
      buildHash?: string;
      sourceHash?: string;
    };
  };
  outgoing: Rpc;
}
export async function recoveryAuditAdmissionPreflight(prepared: PreparedAudit) {
  const currentBuildHash = buildHash();
  const paths = resolveRuntimePaths({ anchor: __filename });
  const production = createProductionQueueAdmission(paths.runtime);
  const origin = verifiedOrigin(prepared.artifact);
  if (!object(origin.context) || !object(origin.request))
    fail(
      "WORKFLOW_IDENTITY_MISMATCH",
      "Audit preflight has no exact origin purpose/binding",
    );
  const { kind, ...binding } = origin.context;
  if (
    kind !== "atomic-recovery-audit-v1" ||
    prepared.record.binding.purpose !== kind ||
    canonicalHash(binding) !== prepared.record.binding.auditBindingHash ||
    canonicalHash(binding["currentInstance"] ?? null) !==
      canonicalHash(prepared.record.binding.auditExpectedInstance ?? null)
  )
    fail(
      "WORKFLOW_IDENTITY_MISMATCH",
      "Audit preflight has no exact origin purpose/binding",
    );
  const expected = (
    load("./queue-atomic-recovery-audit") as {
      prepareRecoveryAudit(
        installation: string,
        identity: unknown,
        binding: Record<string, unknown>,
      ): { artifact: PreparedPythonArtifact };
    }
  ).prepareRecoveryAudit(
    paths.installation,
    origin.request["identity"],
    binding,
  );
  if (
    expected.artifact.artifactHash !== origin.artifactHash ||
    prepared.record.binding.pythonOriginHash !== origin.artifactHash ||
    prepared.record.binding.buildHash !== currentBuildHash ||
    canonicalHash(prepared.artifact.request) !==
      canonicalHash(prepared.record.binding) ||
    prepared.record.binding.sourceHash !==
      hash(expected.artifact.script + '\n\nrun("")\n') ||
    prepared.outgoing.params?.arguments?.["code"] !== prepared.artifact.script
  )
    fail(
      "WORKFLOW_ARTIFACT_CHANGED",
      "Audit preflight differs from its canonical executed reader and final bytes",
    );
  const outgoing = prepared.outgoing;
  const artifact = prepared.artifact;
  const record = prepared.record;
  const preparedJson = JSON.stringify(prepared);
  const certificate = await production.admission.check(
    prepared.outgoing,
    prepared.artifact,
  );
  if (
    prepared.outgoing !== outgoing ||
    prepared.artifact !== artifact ||
    prepared.record !== record ||
    JSON.stringify(prepared) !== preparedJson
  )
    fail(
      "WORKFLOW_ARTIFACT_CHANGED",
      "Audit evidence changed during Python analysis",
    );
  if (buildHash() !== currentBuildHash)
    fail("BUILD_CHANGED", "Broker build changed during audit Python admission");
  certificate.fence(prepared.outgoing);
  if (!certificate.report)
    fail("PYTHON_ADMISSION_UNAVAILABLE", "Audit certificate is incomplete");
  const p = certificate.report.provenance;
  return {
    version: 1,
    production: true,
    purpose: kind,
    finalByteCertificate: true,
    status: certificate.report.status,
    buildHash: currentBuildHash,
    sourceModuleHash: hash(fs.readFileSync(__filename)),
    checkerFingerprint: production.checkerFingerprint(),
    artifactHash: prepared.artifact.artifactHash,
    sourceHash: prepared.record.binding.sourceHash,
    originArtifactHash: origin.artifactHash,
    auditBindingHash: prepared.record.binding.auditBindingHash,
    executedUnits: origin.units.map(({ id, filename, role, sha256 }) => ({
      id,
      filename,
      role,
      sha256,
    })),
    checker: {
      name: p.checker,
      version: p.checkerVersion,
      hash: p.checkerHash,
      definitionsHash: p.definitionsHash,
      analysisHash: p.analysisHash,
      contextHash: p.contextHash,
      configHash: p.configHash,
      typingHash: p.typingHash,
    },
  };
}

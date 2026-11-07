import * as fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const runtimeRequire = createRequire(__filename);
interface Reference {
  path: string;
  sha256: string;
}
interface DocumentIdentity {
  name: string;
  creationId: string;
  fileId: null;
}
interface ProcessIdentity {
  pid: number;
  birth: string;
  version: string;
}
interface Epoch {
  epochId: string;
  root: string;
  document: DocumentIdentity;
  ownerClientId: string;
  ownerTokenHash: string;
  currentInstance: ProcessIdentity;
  originalInstance: ProcessIdentity;
  qualificationReceipt: Reference;
  restoreActiveCreationId?: string | null;
}
interface Prerequisite {
  clientId: string;
  hash: string;
  currentInstance: ProcessIdentity;
}
interface Scope {
  epochPrerequisite?: Prerequisite;
  currentInstance: ProcessIdentity;
  originalInstance: ProcessIdentity;
}
interface Message {
  action?: string;
  control?: unknown;
  epochId?: string;
  grantClientId?: string;
  admissionMode?: unknown;
}
interface AuditKey {
  jobId: string;
  observationJobId: string;
}
interface Binding {
  purpose: string;
  epochId: string;
  document: DocumentIdentity;
  clientId: string;
  currentInstance: ProcessIdentity;
  historicalInstance?: ProcessIdentity;
  historicalProcessState?: string;
  ownerTokenHash: string;
  sdkProofPath: string;
  prerequisiteHash?: string;
  historicalSnapshotHash?: string;
  historicalIdentityHash?: string;
  captureActiveDocument?: boolean;
  forbiddenIds?: string[];
  createdAtMs?: number;
  before?: unknown;
  control?: unknown;
  admissionMode?: unknown;
  restoreActiveCreationId?: string | null;
}
interface Inspection {
  identity: { resolvedIdentity?: { creationId?: string } } | DocumentIdentity;
  instance: ProcessIdentity;
  before?: unknown;
  binding: Binding;
}
interface Prior {
  binding: Binding;
  key: AuditKey;
}
interface Summary {
  document: DocumentIdentity;
  activeCommand: string;
  previousActiveCreationId?: string | null;
}
interface AuditResult {
  status: string;
  sdkRequestsSent: number;
  endpointVerified: boolean;
  clientId: string;
  summary: Summary;
}
interface Start {
  binding: {
    auditBindingHash: string;
    purpose: string;
    pythonOriginHash: string;
    auditExpectedInstance: ProcessIdentity;
  };
  receipt: string;
}
interface AuditPorts {
  inspect(
    message: Message & Partial<AuditKey>,
    clientId: string,
  ): Promise<Inspection>;
  fence(value: Inspection, inFlight: boolean): void;
  remoteReceipt(start: Start): { outcome: string };
  [key: string]: unknown;
}
interface AuditOptions extends Record<string, unknown> {
  inspect(message: Message, clientId: string): Promise<Inspection>;
  fence(value: Inspection, inFlight: boolean): void;
  publishComplete(
    result: AuditResult,
    prior: Prior,
    receipt: string,
  ): Promise<unknown>;
}
interface State {
  epoch: Epoch | null;
  historical?: unknown;
  data: unknown;
  assertEpoch(): void;
  summary(): { blocked?: unknown };
  installEpoch(
    pointer: unknown,
    identity: unknown,
    initialization: unknown,
  ): void;
}
interface Parameters {
  state: State;
  auditPorts: AuditPorts;
  dir: string;
  scope: Scope;
  configHash: string;
  buildHash: string;
  creationRoot?: string;
  successor?: {
    matches(epoch: Epoch): boolean;
    forbiddenIds: string[];
    authority: unknown;
    sourceCommit: string;
  };
  additionalPrerequisite?(): Prerequisite | undefined;
  clients(): Record<string, string>;
  assertControl(control: unknown): void;
  epochSnapshot(): unknown;
  epochFence(inFlight: boolean): void;
  activate(epoch: Epoch, identity: unknown): void;
  closed(epoch: Epoch): void;
}
const {
  hash,
  durable,
  readJson: readUnknown,
  sameInstance,
} = runtimeRequire("./queue-instance") as {
  hash(value: string): string;
  durable(file: string, value: unknown, exclusive?: boolean): void;
  readJson(file: string): unknown;
  sameInstance(a: unknown, b: unknown): boolean;
};
const readJson = <T>(file: string): T => readUnknown(file) as T;
const { fileHash, exclusive } = runtimeRequire(
  "./queue-atomic-migration-files",
) as {
  fileHash(file: string): { sha256: string };
  exclusive(file: string, value: unknown): void;
};
const { createRecoveryAudit } = runtimeRequire(
  "./queue-atomic-recovery-audit",
) as {
  createRecoveryAudit(options: AuditOptions): {
    handle(message: Message, clientId: string): Promise<unknown>;
  };
};
const { epochPrerequisiteStillCurrent } = runtimeRequire(
  "./queue-epoch-prerequisite",
) as { epochPrerequisiteStillCurrent(proof: Prerequisite): boolean };
const {
  prepareScratchQualification,
  parseScratchQualification,
  parseScratchClose,
} = runtimeRequire("./queue-scratch-qualification") as {
  prepareScratchQualification: unknown;
  parseScratchQualification: unknown;
  parseScratchClose: unknown;
};
const { epochControlDirectory } = runtimeRequire("./queue-epoch-lineage") as {
  epochControlDirectory(root: string, epoch: Epoch | null): string;
};
const canonicalHash = (value: unknown): string =>
  (
    runtimeRequire("./dist/core/application/cad/json") as {
      hash(value: unknown): string;
    }
  ).hash(value);
const normalAdmission = runtimeRequire(
  "./dist/node-adapters/broker-ipc/normal-admission",
) as {
  validateCloseMode(mode: unknown, restoreRecorded: boolean): void;
  closeModeFields(binding: { admissionMode?: unknown }): {
    admissionMode?: string;
  };
  verifyRepeatedClose(
    file: string,
    mode: unknown,
    read: (file: string) => unknown,
  ): void;
};
const fail = (code: string, message: string): never => {
  throw Object.assign(new Error(message), { code });
};

function verifyScratchSdkProof(
  result: AuditResult,
  prior: Prior,
  receipt: string,
  base: AuditPorts,
) {
  if (
    result.status !== "complete" ||
    result.sdkRequestsSent !== 1 ||
    result.endpointVerified !== true ||
    canonicalHash(readJson(prior.binding.sdkProofPath)) !==
      canonicalHash(result.summary)
  )
    fail(
      "EPOCH_PROOF_INVALID",
      "Both the physical terminal receipt and exact durable SDK proof are required",
    );
  const directory = path.dirname(receipt),
    intentFile = path.join(directory, "intent.json"),
    startFile = path.join(directory, "start.json");
  const intent = readJson<{ binding: Binding; sourceArtifactHash: string }>(
      intentFile,
    ),
    start = readJson<Start>(startFile),
    binding = start.binding;
  if (
    canonicalHash(intent.binding) !== canonicalHash(prior.binding) ||
    !binding ||
    binding.auditBindingHash !== canonicalHash(prior.binding) ||
    binding.purpose !== prior.binding.purpose ||
    binding.pythonOriginHash !== intent.sourceArtifactHash ||
    !sameInstance(
      binding.auditExpectedInstance,
      prior.binding.currentInstance,
    ) ||
    path.dirname(start.receipt || "") !== directory ||
    base.remoteReceipt(start).outcome !== "succeeded"
  )
    fail(
      "EPOCH_PROOF_INVALID",
      "Replayed/tampered source or physical receipt cannot publish a scratch epoch",
    );
  return [
    intentFile,
    startFile,
    path.join(directory, "wire.json"),
    prior.binding.sdkProofPath,
    start.receipt,
  ].map((file) => ({ path: file, sha256: fileHash(file).sha256 }));
}

function createScratchControl(p: Parameters) {
  const state = p.state,
    base = p.auditPorts;
  const replacing = () => state.epoch && p.successor?.matches(state.epoch);
  const history = () => state.historical || state.data;
  const creationRoot = p.creationRoot || p.dir;
  const controlRoot = () => epochControlDirectory(p.dir, state.epoch);
  function prerequisite(clientId: string): Prerequisite {
    const proof = p.scope?.epochPrerequisite || p.additionalPrerequisite?.();
    if (
      !proof ||
      proof.clientId !== clientId ||
      !epochPrerequisiteStillCurrent(proof) ||
      !sameInstance(proof.currentInstance, p.scope.currentInstance)
    )
      fail(
        "EPOCH_AUDIT_REQUIRED",
        "A separately qualified current audit is required before one new scratch may be created",
      );
    return proof!;
  }
  function owner(clientId: string): Epoch {
    const epoch = state.epoch;
    if (
      !epoch ||
      epoch.ownerClientId !== clientId ||
      p.clients()[clientId] !== epoch.ownerTokenHash
    )
      fail(
        "NOT_OWNER",
        "Only the original credential-bound scratch owner may administer this epoch",
      );
    return epoch!;
  }
  function sdkProof(result: AuditResult, prior: Prior, receipt: string) {
    return verifyScratchSdkProof(result, prior, receipt, base);
  }
  const creation = createRecoveryAudit({
    ...base,
    kind: "isolated-scratch-qualification",
    jobDirectory: () => creationRoot,
    prepareReader: prepareScratchQualification,
    parseSummary: parseScratchQualification,
    async inspect(message, clientId) {
      if (state.epoch && !replacing())
        fail(
          "EPOCH_ALREADY_EXISTS",
          "Never adopt, replace or recreate a qualified scratch",
        );
      const proof = prerequisite(clientId),
        inspected = await base.inspect(message, clientId),
        epochId = randomUUID();
      const forbiddenId =
        "resolvedIdentity" in inspected.identity
          ? inspected.identity.resolvedIdentity?.creationId
          : undefined;
      if (
        !forbiddenId ||
        !sameInstance(inspected.instance, proof.currentInstance)
      )
        fail(
          "EPOCH_PROOF_INVALID",
          "Exact historical identity and current process fences required",
        );
      return {
        ...inspected,
        binding: {
          ...inspected.binding,
          purpose: "isolated-scratch-epoch-v1",
          epochId,
          sdkProofPath: path.join(
            creationRoot,
            "isolated-scratch-qualification",
            "sdk-qualified.json",
          ),
          forbiddenIds: [
            ...new Set([forbiddenId!, ...(p.successor?.forbiddenIds || [])]),
          ],
          prerequisiteHash: proof.hash,
          historicalSnapshotHash: hash(JSON.stringify(history())),
          historicalIdentityHash: fileHash(path.join(p.dir, "instance.json"))
            .sha256,
          ...(p.successor ? { captureActiveDocument: true } : {}),
          ownerTokenHash: p.clients()[clientId]!,
          createdAtMs: Date.now(),
        },
      };
    },
    fence(value, inFlight) {
      if (state.epoch && !replacing())
        fail(
          "EPOCH_ALREADY_EXISTS",
          "An epoch was already committed; no second SDK creation",
        );
      const proof = prerequisite(value.binding.clientId);
      if (
        value.binding.prerequisiteHash !== proof.hash ||
        value.binding.ownerTokenHash !== p.clients()[proof.clientId] ||
        value.binding.historicalSnapshotHash !==
          hash(JSON.stringify(history())) ||
        value.binding.historicalIdentityHash !==
          fileHash(path.join(p.dir, "instance.json")).sha256
      )
        fail(
          "EPOCH_FENCE_CHANGED",
          "Historical snapshot, audit prerequisite or original credential changed",
        );
      base.fence(value, inFlight);
    },
    async publishComplete(result, prior, receipt) {
      const qualificationEvidence = sdkProof(result, prior, receipt);
      const binding = prior.binding;
      if (state.epoch && !replacing()) {
        if (
          state.epoch.epochId !== binding.epochId ||
          state.epoch.qualificationReceipt.path !== receipt ||
          state.epoch.qualificationReceipt.sha256 !== fileHash(receipt).sha256
        )
          fail(
            "EPOCH_PROOF_INVALID",
            "An unrelated epoch already owns admission",
          );
        p.activate(
          state.epoch,
          readJson(path.join(state.epoch.root, "instance.json")),
        );
        return {
          epochId: state.epoch.epochId,
          document: state.epoch.document,
          admission: fs.existsSync(path.join(state.epoch.root, "closed.json"))
            ? "closed"
            : state.summary().blocked
              ? "blocked-current-unknown"
              : "qualified-fresh-scratch-only",
        };
      }
      prerequisite(result.clientId);
      const inspected = await base.inspect(
        { ...prior.key, control: binding.control },
        result.clientId,
      );
      const value = { ...inspected, binding };
      // Recheck original owner/state/evidence after the SDK result and on a
      // publication-only retry. This never sends or creates another document.
      this.fence(value, false);
      const pointer = {
        version: 1,
        kind: "isolated-fresh-scratch-epoch",
        epochId: binding.epochId,
        root: path.join(p.dir, "admission-epochs", binding.epochId),
        document: result.summary.document,
        ownerClientId: result.clientId,
        ownerTokenHash: binding.ownerTokenHash,
        currentInstance: p.scope.currentInstance,
        originalInstance: p.scope.originalInstance,
        historicalSnapshotHash: binding.historicalSnapshotHash,
        historicalIdentityHash: binding.historicalIdentityHash,
        qualificationReceipt: {
          path: receipt,
          sha256: fileHash(receipt).sha256,
        },
        qualificationEvidence,
        quarantinedJobIds: [prior.key.jobId, prior.key.observationJobId],
        historicalOutcome: "unknown",
        originalModelValidation: "not_performed",
        originalRollbackVerification: "not_performed",
        ...(p.successor
          ? {
              succession: p.successor.authority,
              restoreActiveCreationId: result.summary.previousActiveCreationId,
            }
          : {}),
      };
      const identity = {
        configHash: p.configHash,
        buildHash: p.buildHash,
        instance: {
          ...p.scope.currentInstance,
          activeCommand: result.summary.activeCommand,
        },
        ...(p.successor ? { sourceCommit: p.successor.sourceCommit } : {}),
      };
      state.installEpoch(pointer, identity, {
        createdAtMs: binding.createdAtMs,
        bindingHash: canonicalHash(binding),
      });
      p.activate(pointer, identity);
      return {
        epochId: pointer.epochId,
        document: pointer.document,
        admission: "qualified-fresh-scratch-only",
      };
    },
  });
  const closing = createRecoveryAudit({
    ...base,
    kind: "isolated-scratch-close",
    jobDirectory: controlRoot,
    extraKeys: ["admissionMode"],
    prepareReader: prepareScratchQualification,
    parseSummary: parseScratchClose,
    async inspect(message, clientId) {
      const epoch = owner(clientId);
      state.assertEpoch();
      p.assertControl(message.control);
      normalAdmission.validateCloseMode(
        message.admissionMode,
        Object.hasOwn(epoch, "restoreActiveCreationId"),
      );
      if (fs.existsSync(path.join(epoch.root, "saved-first-save-scope.json")))
        fail(
          "SAVED_FIRST_SAVE_PENDING",
          "A first-save namespace requires its own publication/retention disposition, never unsaved close",
        );
      if (
        fs.existsSync(
          path.join(controlRoot(), "isolated-scratch-close", "intent.json"),
        )
      )
        fail(
          "EPOCH_CLEANUP_PENDING",
          "Cleanup intent closes new modeling grants, even after an uncertain result",
        );
      const before = p.epochSnapshot();
      return {
        identity: epoch.document,
        instance: epoch.currentInstance,
        before,
        binding: {
          purpose: "isolated-scratch-close-v1",
          epochId: epoch.epochId,
          document: epoch.document,
          clientId,
          currentInstance: epoch.currentInstance,
          historicalInstance: epoch.originalInstance,
          historicalProcessState: "terminated",
          ownerTokenHash: epoch.ownerTokenHash,
          ...normalAdmission.closeModeFields(message),
          ...(Object.hasOwn(epoch, "restoreActiveCreationId")
            ? { restoreActiveCreationId: epoch.restoreActiveCreationId }
            : {}),
          sdkProofPath: path.join(
            controlRoot(),
            "isolated-scratch-close",
            "sdk-closed.json",
          ),
          before,
        },
      };
    },
    fence(value, inFlight) {
      owner(value.binding.clientId);
      state.assertEpoch();
      if (
        canonicalHash(p.epochSnapshot()) !== canonicalHash(value.binding.before)
      )
        fail(
          "EPOCH_FENCE_CHANGED",
          "Current epoch work or broker identity changed during close",
        );
      p.epochFence(inFlight);
    },
    async publishComplete(result, prior, receipt) {
      const epoch = owner(result.clientId),
        file = path.join(epoch.root, "closed.json");
      const qualificationEvidence = sdkProof(result, prior, receipt);
      const closed = {
        epochId: epoch.epochId,
        document: epoch.document,
        receipt: { path: receipt, sha256: fileHash(receipt).sha256 },
        qualificationEvidence,
        historicalOutcome: "unknown",
        ...normalAdmission.closeModeFields(prior.binding),
      };
      if (!fs.existsSync(file)) {
        this.fence(
          {
            identity: epoch.document,
            instance: epoch.currentInstance,
            binding: prior.binding,
          },
          false,
        );
        durable(file, closed, true);
      } else if (canonicalHash(readJson(file)) !== canonicalHash(closed))
        fail("EPOCH_PROOF_INVALID", "Closed scratch proof changed");
      p.closed(epoch);
      return {
        epochId: epoch.epochId,
        document: epoch.document,
        admission: closed.admissionMode || "closed",
        historicalOutcome: "unknown",
      };
    },
  });
  return {
    create: (message: Message, clientId: string) =>
      creation.handle(message, clientId),
    close(message: Message, clientId: string) {
      owner(clientId);
      const intent = path.join(
        controlRoot(),
        "isolated-scratch-close",
        "intent.json",
      );
      normalAdmission.verifyRepeatedClose(
        intent,
        message.admissionMode,
        readJson,
      );
      return closing.handle(message, clientId);
    },
    grant(message: Message, clientId: string) {
      if (
        Object.keys(message).some(
          (k) =>
            !["action", "auth", "control", "epochId", "grantClientId"].includes(
              k,
            ),
        )
      )
        fail(
          "INVALID_REQUEST",
          "Only an exact registered client grant is supported",
        );
      const epoch = owner(clientId);
      state.assertEpoch();
      p.assertControl(message.control);
      const token = message.grantClientId
        ? p.clients()[message.grantClientId]
        : undefined;
      if (fs.existsSync(path.join(epoch.root, "saved-first-save-scope.json")))
        fail(
          "SAVED_FIRST_SAVE_PENDING",
          "First-save transition forbids widening ordinary scratch authority",
        );
      if (
        fs.existsSync(
          path.join(controlRoot(), "isolated-scratch-close", "intent.json"),
        )
      )
        fail(
          "EPOCH_CLEANUP_PENDING",
          "Cleanup closes new modeling grants even when its outcome is uncertain",
        );
      if (
        message.epochId !== epoch.epochId ||
        typeof message.grantClientId !== "string" ||
        !token
      )
        fail(
          "EPOCH_CLIENT_NOT_REGISTERED",
          "Grant requires this exact epoch and an already authenticated registered client",
        );
      const grant = {
        epochId: epoch.epochId,
        clientId: message.grantClientId,
        clientTokenHash: token,
        document: epoch.document,
      };
      exclusive(
        path.join(
          epoch.root,
          "access-" + hash(message.grantClientId + "\0" + token) + ".json",
        ),
        grant,
      );
      return {
        epochId: epoch.epochId,
        clientId: grant.clientId,
        document: epoch.document,
        scope: "qualified-fresh-scratch-only",
      };
    },
  };
}

async function scratchEpochAction(
  client: {
    call(action: string, input?: Record<string, unknown>): Promise<unknown>;
  },
  action: string,
  input: Record<string, unknown>,
  buildHash: string,
) {
  if (
    ![
      "create-isolated-scratch",
      "close-isolated-scratch",
      "grant-isolated-scratch",
    ].includes(action)
  )
    fail("INVALID_REQUEST", "Unknown isolated scratch action");
  const status = (await client.call("queue-summary")) as {
    features?: { isolatedScratchEpoch?: boolean };
    control?: {
      buildHash: string;
      instanceId: string;
      generation: number;
      contextEpoch: number;
    };
  };
  if (status.features?.isolatedScratchEpoch !== true)
    fail(
      "EPOCH_UNSUPPORTED",
      "Broker has no separately qualified isolated scratch contract",
    );
  if (status.control?.buildHash !== buildHash)
    fail(
      "BUILD_CHANGED",
      "Isolated scratch CLI and broker must have the same qualified build",
    );
  const { instanceId, generation, contextEpoch } = status.control!;
  return client.call(action, {
    ...input,
    control: { instanceId, generation, contextEpoch, buildHash },
  });
}

export { createScratchControl, scratchEpochAction, verifyScratchSdkProof };

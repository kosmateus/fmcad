import * as fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { QueueDomain } from "../packages/core/src/domain/queue";
import type {
  QueueRequest as BaseRequest,
  QueueSnapshot,
} from "../packages/core/src/domain/queue-model";
type QueueRequest = BaseRequest & {
  isolatedEpoch?: string;
  inputFiles?: unknown[];
};
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
interface Identity {
  buildHash: string;
  instance: ProcessIdentity;
  sourceCommit?: string;
}
interface Pointer {
  version: number;
  kind: string;
  epochId: string;
  root: string;
  document: DocumentIdentity;
  historicalOutcome: string;
  originalModelValidation: string;
  originalRollbackVerification: string;
  quarantinedJobIds: string[];
  ownerClientId: string;
  ownerTokenHash: string;
  qualificationReceipt: Reference;
  qualificationEvidence: Reference[];
  historicalSnapshotHash: string;
  historicalIdentityHash: string;
  originalInstance: ProcessIdentity;
  currentInstance: ProcessIdentity;
  succession?: Reference;
  restoreActiveCreationId?: string | null;
}
interface Proof {
  status: string;
  kind: string;
  clientId: string;
  currentInstance: ProcessIdentity;
  nativeOutcome: string;
  summary: {
    purpose: string;
    epochId: string;
    document: DocumentIdentity;
    independent?: boolean;
    empty?: boolean;
    unsaved?: boolean;
    previousActiveCreationId?: string | null;
  };
}
interface StateOptions extends Record<string, unknown> {
  expectedSnapshotHash?: string;
  recover?: boolean;
}
interface Authority {
  kind: string;
  previousOwner: unknown;
  sourceCommit: string;
  buildHash: string;
  expectedProcess: ProcessIdentity;
  predecessor: { state: Reference; pointer: Reference };
}
interface Lineage {
  pointer: Pointer;
  authority: Authority;
  state: QueueSnapshot;
}
interface Grant {
  epochId: string;
  clientId: string;
  clientTokenHash: string;
  document: DocumentIdentity;
  savedFirstSave?: unknown;
  nativeFixture?: { kind: string };
}
type Facade = Omit<QueueDomain, "summary"> & {
  historical: QueueSnapshot | null;
  lookup(id: string): QueueSnapshot["jobs"][string] | undefined;
  installEpoch(
    pointer: Pointer,
    identity: Identity,
    initialization: { createdAtMs: number; bindingHash: string },
  ): void;
  summary(): ReturnType<QueueDomain["summary"]> & {
    admissionEpoch?: string;
    admissionScope?: string;
    qualifiedDocument?: DocumentIdentity;
    historicalUnknownJobCount?: number;
    retiredEpochCount?: number;
    historicalOutcome?: string;
    historicalModelValidation?: string;
  };
  epoch: Pointer | null;
  admissionMode: string;
  assertEpoch(normal?: boolean): void;
  isHistorical(id: string): boolean;
  findAnyRequest(
    clientId: string,
    requestId: string,
  ): Record<string, unknown> | null;
};
const { QueueState } = runtimeRequire("./queue-state") as {
  QueueState: new (root: string, options: StateOptions) => QueueDomain;
};
const {
  durable,
  readJson: boundedJson,
  hash,
  sameInstance,
  priorProcessAlive,
} = runtimeRequire("./queue-instance") as {
  durable(file: string, value: unknown, exclusive?: boolean): void;
  readJson(file: string, size: number): unknown;
  hash(value: string): string;
  sameInstance(a: unknown, b: unknown): boolean;
  priorProcessAlive(value: unknown): boolean | null;
};
const { directory, fileHash } = runtimeRequire(
  "./queue-atomic-migration-files",
) as {
  directory(dir: string): void;
  fileHash(file: string): { sha256: string };
};
const { epochLineage, epochControlDirectory, successionAuthority } =
  runtimeRequire("./queue-epoch-lineage") as {
    epochLineage(root: string, pointer: Pointer): Lineage[];
    epochControlDirectory(root: string, pointer: Pointer): string;
    successionAuthority(root: string, reference: Reference): Lineage;
  };
function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
const read = <T>(file: string): T => boundedJson(file, 256 * 1024 * 1024) as T;
const canonicalHash = (value: unknown): string =>
  (
    runtimeRequire("./dist/core/application/cad/json") as {
      hash(value: unknown): string;
    }
  ).hash(value);

// Read-only client/startup selection. Never opens a QueueState or commits a
// snapshot; library compatibility checks must not inspect the old identity as
// though it belonged to the new epoch, nor mutate either queue.
function isolatedEpochDirectory(root: string) {
  const file = path.join(root, "isolated-admission-epoch.json");
  if (!fs.existsSync(file)) return root;
  const p = read<Pointer>(file),
    expected = path.join(root, "admission-epochs", p.epochId || "");
  const qualificationRoot = epochControlDirectory(root, p);
  if (
    p.version !== 1 ||
    p.kind !== "isolated-fresh-scratch-epoch" ||
    !/^[a-f0-9-]{36}$/.test(p.epochId || "") ||
    p.root !== expected ||
    fs.realpathSync(expected) !== expected ||
    fs.existsSync(path.join(root, "queue-state.pending.json")) ||
    fs.existsSync(path.join(expected, "queue-state.pending.json")) ||
    p.qualificationReceipt?.path !==
      path.join(
        qualificationRoot,
        "isolated-scratch-qualification",
        "result.json",
      ) ||
    fileHash(p.qualificationReceipt.path).sha256 !==
      p.qualificationReceipt.sha256 ||
    fileHash(path.join(root, "queue-state.json")).sha256 !==
      p.historicalSnapshotHash ||
    fileHash(path.join(root, "instance.json")).sha256 !==
      p.historicalIdentityHash
  )
    fail(
      "EPOCH_PROOF_INVALID",
      "Invalid epoch directory selection or changed historical lineage",
    );
  epochLineage(root, p);
  return expected;
}

function openIsolatedEpoch(root: string, options: StateOptions = {}): Facade {
  // A migration snapshot hash belongs to the immutable historical queue, never
  // to the new empty epoch's independent snapshot.
  const epochOptions = { ...options };
  delete epochOptions.expectedSnapshotHash;
  const pointerFile = path.join(root, "isolated-admission-epoch.json");
  let pointer = fs.existsSync(pointerFile) ? read<Pointer>(pointerFile) : null;
  const historicalHash = pointer?.historicalSnapshotHash;
  const historical = new QueueState(
    root,
    pointer
      ? { ...options, recover: false, expectedSnapshotHash: historicalHash! }
      : options,
  );
  let current = historical;
  const oldRequests = new Map<string, string>();
  const retired = new Map<string, { store: QueueDomain; epochId: string }>();
  function validate(p: Pointer) {
    const qualificationRoot = epochControlDirectory(root, p);
    if (
      fs.existsSync(path.join(root, "queue-state.pending.json")) ||
      fs.existsSync(path.join(p.root || root, "queue-state.pending.json"))
    )
      fail(
        "EPOCH_PROOF_INVALID",
        "Historical or current queue has an unresolved durable write",
      );
    if (
      p.version !== 1 ||
      p.kind !== "isolated-fresh-scratch-epoch" ||
      !/^[a-f0-9-]{36}$/.test(p.epochId || "") ||
      !p.document ||
      p.document.fileId !== null ||
      typeof p.document.creationId !== "string" ||
      !p.document.creationId ||
      typeof p.document.name !== "string" ||
      p.document.name !== "FMCAD_ISOLATED_" + p.epochId ||
      p.historicalOutcome !== "unknown" ||
      p.originalModelValidation !== "not_performed" ||
      p.originalRollbackVerification !== "not_performed" ||
      !Array.isArray(p.quarantinedJobIds) ||
      p.quarantinedJobIds.length !== 2 ||
      p.root !== path.join(root, "admission-epochs", p.epochId) ||
      !p.ownerClientId ||
      !p.ownerTokenHash ||
      p.qualificationReceipt?.path !==
        path.join(
          qualificationRoot,
          "isolated-scratch-qualification",
          "result.json",
        ) ||
      !Array.isArray(p.qualificationEvidence) ||
      p.qualificationEvidence.length !== 5
    )
      fail("EPOCH_PROOF_INVALID", "Invalid isolated scratch epoch record");
    if (
      hash(JSON.stringify(historical.data)) !== p.historicalSnapshotHash ||
      fileHash(path.join(root, "instance.json")).sha256 !==
        p.historicalIdentityHash ||
      fileHash(p.qualificationReceipt.path).sha256 !==
        p.qualificationReceipt.sha256
    )
      fail(
        "EPOCH_PROOF_INVALID",
        "Historical snapshot/identity or scratch qualification changed",
      );
    const proofDirectory = path.dirname(p.qualificationReceipt.path);
    const evidenceNames = p.qualificationEvidence.map((entry) =>
      path.basename(entry.path),
    );
    if (
      new Set(evidenceNames).size !== 5 ||
      !["intent.json", "start.json", "wire.json", "sdk-qualified.json"].every(
        (name) => evidenceNames.includes(name),
      ) ||
      !evidenceNames.some((name) =>
        /^remote-[a-f0-9-]{36}\.json$/.test(name),
      ) ||
      p.qualificationEvidence.some(
        (entry) =>
          path.dirname(entry.path) !== proofDirectory ||
          fileHash(entry.path).sha256 !== entry.sha256,
      )
    )
      fail(
        "EPOCH_PROOF_INVALID",
        "Qualified source/SDK/physical receipt evidence changed",
      );
    const unknown = Object.values(historical.data.jobs).filter(
      (j) => !["succeeded", "failed", "cancelled", "expired"].includes(j.state),
    );
    if (
      unknown.length !== 2 ||
      unknown.some(
        (j) =>
          !p.quarantinedJobIds.includes(j.id) ||
          j.state !== "needs_reconciliation",
      )
    )
      fail(
        "EPOCH_PROOF_INVALID",
        "Epoch must preserve exactly the two historical unknown jobs",
      );
    const proof = read<Proof>(p.qualificationReceipt.path);
    if (
      proof.status !== "complete" ||
      proof.kind !== "isolated-scratch-qualification" ||
      proof.clientId !== p.ownerClientId ||
      proof.summary?.purpose !== "isolated-scratch-epoch-v1" ||
      proof.summary.epochId !== p.epochId ||
      canonicalHash(proof.summary.document) !== canonicalHash(p.document) ||
      !sameInstance(proof.currentInstance, p.currentInstance) ||
      proof.nativeOutcome !== "unknown"
    )
      fail(
        "EPOCH_PROOF_INVALID",
        "Fresh scratch has no exact completed qualified receipt",
      );
    if (
      p.succession &&
      (!proof.summary.independent ||
        !proof.summary.empty ||
        !proof.summary.unsaved)
    )
      fail(
        "EPOCH_PROOF_INVALID",
        "A successor must have a real new, empty, unsaved document proof",
      );
    if (
      p.succession &&
      (!Object.hasOwn(p, "restoreActiveCreationId") ||
        p.restoreActiveCreationId !== proof.summary.previousActiveCreationId ||
        (p.restoreActiveCreationId !== null &&
          (typeof p.restoreActiveCreationId !== "string" ||
            !p.restoreActiveCreationId ||
            p.restoreActiveCreationId === p.document.creationId)))
    )
      fail(
        "EPOCH_PROOF_INVALID",
        "A successor must preserve its captured pre-scratch active-document identity",
      );
    epochLineage(root, p);
  }
  function activate(p: Pointer, stateOptions = epochOptions) {
    validate(p);
    const dir = path.join(root, "admission-epochs", p.epochId);
    directory(dir);
    if (fs.realpathSync(dir) !== dir)
      fail("EPOCH_PROOF_INVALID", "Epoch data directory is not canonical");
    // A lost physical epoch is metadata-only. Do not rewrite in-flight states
    // while merely restoring access to their original receipts.
    const unavailable =
      priorProcessAlive(p.originalInstance) !== false ||
      priorProcessAlive(p.currentInstance) !== true;
    current = new QueueState(
      dir,
      unavailable ? { ...stateOptions, recover: false } : stateOptions,
    );
    pointer = p;
    oldRequests.clear();
    retired.clear();
    for (const job of Object.values(historical.data.jobs))
      oldRequests.set(job.clientId + "\0" + job.requestId, job.id);
    for (const previous of epochLineage(root, p)) {
      const store = new QueueState(previous.pointer.root, {
        ...epochOptions,
        recover: false,
        expectedSnapshotHash: previous.authority.predecessor.state.sha256,
      });
      for (const job of Object.values(store.data.jobs)) {
        const key = job.clientId + "\0" + job.requestId;
        if (
          oldRequests.has(key) ||
          retired.has(job.id) ||
          historical.data.jobs[job.id]
        )
          fail(
            "EPOCH_PROOF_INVALID",
            "Retired epoch request/job identities overlap",
          );
        retired.set(job.id, { store, epochId: previous.pointer.epochId });
        oldRequests.set(key, job.id);
      }
    }
  }
  if (pointer) {
    isolatedEpochDirectory(root);
    activate(pointer);
  }
  function admissionMode(): string {
    const port = runtimeRequire(
      "./dist/node-adapters/broker-ipc/normal-admission",
    ) as {
      readAdmissionMode(
        root: string | undefined,
        read: (file: string) => unknown,
        verify: (file: string) => void,
      ): string;
    };
    return port.readAdmissionMode(pointer?.root, read, (file) =>
      (
        runtimeRequire("./queue-closed-epoch-proof") as {
          closedEpochProof(
            root: string,
            pointer: Pointer | null,
            reference: Reference,
          ): unknown;
        }
      ).closedEpochProof(root, pointer, {
        path: file,
        sha256: fileHash(file).sha256,
      }),
    );
  }
  const facade = new Proxy(
    {},
    {
      get(_target, key) {
        if (key === "epoch") return pointer;
        if (key === "admissionMode") return admissionMode();
        if (key === "assertEpoch")
          return (normal = false) => {
            if (
              !pointer ||
              canonicalHash(read(pointerFile)) !== canonicalHash(pointer)
            )
              fail(
                "EPOCH_PROOF_INVALID",
                "Durable admission epoch pointer changed",
              );
            validate(pointer!);
            if (
              priorProcessAlive(pointer!.originalInstance) !== false ||
              priorProcessAlive(pointer!.currentInstance) !== true
            )
              fail(
                "INSTANCE_CHANGED",
                "Qualified scratch process is no longer the same live instance",
              );
            if (
              fs.existsSync(path.join(pointer!.root, "closed.json")) &&
              !(normal && admissionMode() === "normal-multidocument")
            )
              fail(
                "EPOCH_CLOSED",
                "This isolated scratch has been closed; no replacement or replay is allowed",
              );
          };
        if (key === "historical") return pointer ? historical.data : null;
        if (key === "lookup")
          return (id: string) =>
            current.data.jobs[id] ||
            (pointer && historical.data.jobs[id]) ||
            retired.get(id)?.store.data.jobs[id];
        if (key === "isHistorical")
          return (id: string) =>
            !!((pointer && historical.data.jobs[id]) || retired.has(id));
        if (key === "findAnyRequest")
          return (clientId: string, requestId: string) => {
            const job = Object.values(current.data.jobs).find(
              (j) => j.clientId === clientId && j.requestId === requestId,
            );
            const id = job?.id || oldRequests.get(clientId + "\0" + requestId);
            return id ? facade.status(id) : null;
          };
        if (key === "summary")
          return () => ({
            ...current.summary(),
            ...(pointer
              ? {
                  admissionEpoch: pointer.epochId,
                  admissionScope:
                    admissionMode() === "normal-multidocument"
                      ? "normal-multidocument"
                      : "qualified-fresh-scratch-only",
                  qualifiedDocument: pointer.document,
                  historicalUnknownJobCount:
                    2 +
                    [...retired.entries()].filter(
                      ([id, row]) =>
                        ![
                          "succeeded",
                          "failed",
                          "cancelled",
                          "expired",
                        ].includes(row.store.data.jobs[id]!.state),
                    ).length,
                  retiredEpochCount: new Set(
                    [...retired.values()].map((row) => row.epochId),
                  ).size,
                  historicalOutcome: "unknown",
                  historicalModelValidation: "not_performed",
                }
              : {}),
          });
        if (key === "status")
          return (id?: string) => {
            if (id && retired.has(id)) {
              const previous = retired.get(id)!;
              return {
                ...previous.store.status(id),
                quarantined: true,
                admissionEpoch: previous.epochId,
                historicalOutcome: "unknown",
              };
            }
            if (pointer && id && historical.data.jobs[id])
              return {
                ...historical.status(id),
                quarantined: true,
                admissionEpoch: "historical-terminated-instance",
                historicalOutcome: "unknown",
              };
            return id === undefined
              ? { ...current.status(), ...facade.summary() }
              : current.status(id);
          };
        if (key === "submit")
          return (request: QueueRequest, preparedId?: string) => {
            if (
              pointer &&
              oldRequests.has(request.clientId + "\0" + request.requestId)
            )
              fail(
                "HISTORICAL_REQUEST_QUARANTINED",
                "An old request cannot be replayed in the isolated epoch",
              );
            return current.submit(request, preparedId);
          };
        if (key === "installEpoch")
          return (
            p: Pointer,
            identity: Identity,
            initialization: { createdAtMs: number; bindingHash: string },
          ) => {
            let replacing: Lineage | null = null;
            if (pointer) {
              if (canonicalHash(pointer) === canonicalHash(p)) return;
              if (!p.succession)
                fail(
                  "EPOCH_ALREADY_EXISTS",
                  "The qualified epoch cannot be replaced or recreated",
                );
              replacing = successionAuthority(root, p.succession!);
              const closedSuccessor =
                replacing.authority.kind ===
                "owner-authenticated-closed-epoch-successor";
              if (
                canonicalHash(pointer) !== canonicalHash(replacing.pointer) ||
                priorProcessAlive(pointer.currentInstance) !==
                  closedSuccessor ||
                priorProcessAlive(replacing.authority.previousOwner) !==
                  closedSuccessor ||
                (closedSuccessor &&
                  (!sameInstance(p.currentInstance, pointer.currentInstance) ||
                    canonicalHash(read(path.join(root, "broker.lock"))) !==
                      canonicalHash(replacing.authority.previousOwner))) ||
                p.epochId === pointer.epochId ||
                p.document.creationId === pointer.document.creationId ||
                identity.buildHash !== replacing.authority.buildHash ||
                identity.sourceCommit !== replacing.authority.sourceCommit ||
                p.currentInstance.pid !==
                  replacing.authority.expectedProcess.pid ||
                p.currentInstance.birth !==
                  replacing.authority.expectedProcess.birth ||
                fileHash(pointerFile).sha256 !==
                  replacing.authority.predecessor.pointer.sha256
              )
                fail(
                  "EPOCH_SUCCESSOR_UNPROVEN",
                  "Only the exact owner-authorized dead predecessor may acquire a proven-new successor",
                );
            }
            validate(p);
            const dir = path.join(root, "admission-epochs", p.epochId);
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
            directory(dir);
            if (fs.realpathSync(dir) !== dir)
              fail(
                "EPOCH_PROOF_INVALID",
                "Epoch publication must not follow a symlink",
              );
            const initFile = path.join(dir, "initialization.json");
            const existing = fs.existsSync(initFile) ? read(initFile) : null;
            if (
              existing &&
              canonicalHash(existing) !== canonicalHash(initialization)
            )
              fail("EPOCH_PENDING", "Original epoch initialization differs");
            if (!existing) durable(initFile, initialization, true);
            const next = new QueueState(dir, {
              ...epochOptions,
              now: () => initialization.createdAtMs,
            });
            if (
              Object.keys(next.data.jobs).length ||
              next.data.active ||
              next.data.blocked ||
              next.data.lease
            )
              fail(
                "EPOCH_PENDING",
                "An uncommitted epoch contains unexpected work; never replace it",
              );
            const previousControl = replacing?.state || historical.data;
            if (
              (next.data.controlGeneration || 0) === 0 &&
              (next.data.contextEpoch || 0) === 0
            )
              next._commit((d) => {
                d.paused = false;
                d.controlGeneration =
                  (previousControl.controlGeneration || 0) + 1;
                d.contextEpoch = (previousControl.contextEpoch || 0) + 1;
                Reflect.set(d, "pauseStartedAt", null);
                return null;
              });
            if (
              next.data.paused ||
              next.data.controlGeneration !==
                (previousControl.controlGeneration || 0) + 1 ||
              next.data.contextEpoch !== (previousControl.contextEpoch || 0) + 1
            )
              fail("EPOCH_PENDING", "Uncommitted epoch control proof differs");
            const identityFile = path.join(dir, "instance.json");
            if (fs.existsSync(identityFile)) {
              if (canonicalHash(read(identityFile)) !== canonicalHash(identity))
                fail("EPOCH_PENDING", "Epoch identity differs");
            } else durable(identityFile, identity, true);
            if (
              replacing &&
              fileHash(pointerFile).sha256 !==
                replacing.authority.predecessor.pointer.sha256
            )
              fail(
                "EPOCH_SUCCESSOR_UNPROVEN",
                "The predecessor pointer changed before successor publication",
              );
            durable(pointerFile, p, !replacing); // Last: crash before this keeps the old admission blocked.
            activate(p);
          };
        const value: unknown = Reflect.get(current, key);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (
            pointer &&
            typeof args[0] === "string" &&
            (historical.data.jobs[args[0]] || retired.has(args[0]))
          )
            fail(
              "INSTANCE_HISTORY_QUARANTINED",
              "Historical unknown work is read-only, never cancelled/reconciled/replayed",
            );
          return Reflect.apply(value, current, args);
        };
      },
    },
  ) as Facade;
  return facade;
}

function epochAdmission(
  state: Facade,
  request: QueueRequest,
  clients: Record<string, string> = {},
) {
  const epoch = state.epoch;
  if (!epoch) return;
  const normal = state.admissionMode === "normal-multidocument";
  state.assertEpoch(normal);
  if (
    state.data.blocked ||
    state.data.localUnknown ||
    state.data.controlBlocked
  )
    fail(
      "EPOCH_RECONCILIATION_REQUIRED",
      "An uncertain operation in this scratch epoch must never be replayed or bypassed",
    );
  if (normal) return;
  if (
    fs.existsSync(
      path.join(
        epochControlDirectory(path.dirname(path.dirname(epoch.root)), epoch),
        "isolated-scratch-close",
        "intent.json",
      ),
    )
  )
    fail(
      "EPOCH_CLEANUP_PENDING",
      "Scratch cleanup was requested or has uncertain outcome; never resume modeling or replay it",
    );
  if (
    request.isolatedEpoch !== undefined &&
    request.isolatedEpoch !== epoch.epochId
  )
    fail(
      "EPOCH_SCOPE_REQUIRED",
      "Request belongs to a different admission epoch",
    );
  if (
    request.clientId === epoch.ownerClientId &&
    clients[request.clientId] !== epoch.ownerTokenHash
  )
    fail(
      "EPOCH_CLIENT_NOT_GRANTED",
      "The original scratch owner credential changed",
    );
  let granted: Grant | null = null;
  if (request.clientId !== epoch.ownerClientId) {
    const grantFile = path.join(
      epoch.root,
      "access-" +
        hash(request.clientId + "\0" + clients[request.clientId]) +
        ".json",
    );
    const grant = fs.existsSync(grantFile) ? read<Grant>(grantFile) : null;
    if (
      !grant ||
      grant.epochId !== epoch.epochId ||
      grant.clientId !== request.clientId ||
      grant.clientTokenHash !== clients[request.clientId] ||
      canonicalHash(grant.document) !== canonicalHash(epoch.document)
    )
      fail(
        "EPOCH_CLIENT_NOT_GRANTED",
        "This authenticated client has no modeling grant for the isolated scratch",
      );
    granted = grant;
  }
  const saved = runtimeRequire("./queue-saved-first-save") as {
    markerFile(epoch: Pointer): string;
    firstSaveAdmission(
      epoch: Pointer,
      request: QueueRequest,
      grant: Grant,
      identity: unknown,
    ): unknown;
  };
  if (fs.existsSync(saved.markerFile(epoch)) && !granted?.savedFirstSave)
    fail(
      "SAVED_FIRST_SAVE_PENDING",
      "A pinned first-save transition closes ordinary modeling until publication or explicit owner disposition",
    );
  if (granted?.savedFirstSave) {
    return saved.firstSaveAdmission(
      epoch,
      request,
      granted,
      read(path.join(epoch.root, "instance.json")),
    );
  }
  if (granted?.nativeFixture?.kind === "fixed-run-v1") {
    (
      runtimeRequire("./queue-fixed-fixture-admission") as {
        fixedFixtureAdmission(
          epoch: Pointer,
          request: QueueRequest,
          grant: Grant,
        ): void;
      }
    ).fixedFixtureAdmission(epoch, request, granted);
    return;
  }
  const raw =
    request.payload?.["kind"] === "cad-command"
      ? request.payload["invocation"]
      : request.payload;
  const payload =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  const exactDoc =
    payload?.["doc"] === epoch.document.name &&
    payload["docId"] === epoch.document.creationId &&
    (payload["docFileId"] ?? null) === null &&
    (payload["projectId"] ?? null) === null;
  const fixtureOperations = granted?.nativeFixture
    ? (
        runtimeRequire("./queue-native-fixture-grant") as {
          fixtureGrantOperations(grant: Grant, identity: unknown): string[];
        }
      ).fixtureGrantOperations(
        granted,
        read(path.join(epoch.root, "instance.json")),
      )
    : null;
  const allowed = fixtureOperations || [
    "sketch.create",
    "sketch.geometry",
    "sketch.inspect",
    "sketch.check",
    "sketch.profile-query",
    "model.extrude",
    "entity.list",
    "entity.inspect",
    "measure.volume",
    "document.status",
  ];
  let policyArguments: string[];
  try {
    const service = runtimeRequire("./cad-service") as {
      decodeInvocation(payload: unknown): unknown;
      policyArguments(invocation: unknown): string[];
    };
    policyArguments = service.policyArguments(
      service.decodeInvocation(request.payload),
    );
  } catch {
    fail(
      "EPOCH_SCOPE_REQUIRED",
      "A validated typed CAD invocation is required",
    );
  }
  const { catalog } = runtimeRequire("./catalog") as {
    catalog: Record<string, unknown>;
  };
  const { isTransactional } = runtimeRequire("./batch-atomic") as {
    isTransactional(operation: string, spec: unknown): boolean;
  };
  if (
    request.kind !== "command" ||
    JSON.stringify(request.argv) !== JSON.stringify(policyArguments) ||
    request.inputFiles?.length ||
    !payload ||
    payload["kind"] !== "cad" ||
    typeof payload["operation"] !== "string" ||
    !exactDoc ||
    !allowed.includes(payload["operation"]) ||
    !Object.hasOwn(catalog, payload["operation"]) ||
    !isTransactional(payload["operation"], catalog)
  )
    fail(
      "EPOCH_SCOPE_REQUIRED",
      "Only typed transactional modeling/readback pinned to the newly qualified scratch is admitted; raw, old/recovered documents and external effects are blocked",
    );
  return undefined;
}

export { openIsolatedEpoch, epochAdmission, isolatedEpochDirectory };

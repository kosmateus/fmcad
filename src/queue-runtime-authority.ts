import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual as same } from "node:util";
import type * as P from "./queue-broker-ports";
import type { BrokerModules } from "./queue-broker-modules";
import type * as Backend from "./queue-backend-transition";
import type * as Lineage from "./queue-epoch-lineage";
import type * as NormalAdmission from "../packages/node-adapters/src/broker-ipc/normal-admission";
import type * as NormalRestart from "../packages/node-adapters/src/broker-ipc/normal-restart";
import type * as AtomicObservation from "./composition/library-atomic-workflow-observation";
import type {
  ApprovedRuntimeRoot,
  RuntimeRootPhysicalWiring,
} from "./queue-runtime-physical-wiring";

/**
 * Current runtime identity, not execution permission. Queue/session grants and
 * durable recovery evidence remain owned by their existing modules.
 */
interface RuntimeInstanceIdentity {
  readonly pid: number;
  readonly birth: string;
  readonly version: string;
}

export interface RuntimeAuthorityPins<
  Instance extends RuntimeInstanceIdentity = RuntimeInstanceIdentity,
> {
  readonly instance: Readonly<Instance> | null;
  readonly identityFile: string;
  readonly epochId: string | null;
  readonly root: string;
  readonly buildHash: string;
  readonly configHash: string;
  readonly processUnavailable: boolean;
}

declare const authorityCapture: unique symbol;
export interface RuntimeAuthorityCapture {
  readonly [authorityCapture]: true;
}

export interface RuntimeAuthorityVerification<
  Instance extends RuntimeInstanceIdentity = RuntimeInstanceIdentity,
> {
  /** Synchronous read/check of original durable identity and owner pins. */
  verifyCurrent(pins: RuntimeAuthorityPins<Instance>): boolean;
  /**
   * Verify the already-established durable transition, including its original
   * owner/epoch lineage. A caller-supplied next identity alone is not evidence.
   * This does not write records or probe/replay physical work.
   */
  verifyTransition(
    previous: RuntimeAuthorityPins<Instance>,
    next: RuntimeAuthorityPins<Instance>,
  ): boolean;
}

function freeze<Value>(value: Value): Value {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function immutable<Instance extends RuntimeInstanceIdentity>(
  pins: RuntimeAuthorityPins<Instance>,
): RuntimeAuthorityPins<Instance> {
  return Object.freeze({
    instance: pins.instance ? freeze(structuredClone(pins.instance)) : null,
    identityFile: pins.identityFile,
    epochId: pins.epochId,
    root: pins.root,
    buildHash: pins.buildHash,
    configHash: pins.configHash,
    processUnavailable: pins.processUnavailable,
  });
}

function stale(): never {
  throw Object.assign(new Error("Runtime authority changed or is unverified"), {
    code: "RUNTIME_AUTHORITY_CHANGED",
  });
}

export function createQueueRuntimeAuthority<
  Instance extends RuntimeInstanceIdentity,
>(
  initial: RuntimeAuthorityPins<Instance>,
  { verifyCurrent, verifyTransition }: RuntimeAuthorityVerification<Instance>,
) {
  let current = immutable(initial);
  const captures = new WeakMap<
    RuntimeAuthorityCapture,
    RuntimeAuthorityPins<Instance>
  >();
  const original = (capture: RuntimeAuthorityCapture) => {
    const pins = captures.get(capture);
    if (!pins || pins !== current) stale();
    return pins;
  };
  return Object.freeze({
    /** Diagnostic only: even a genuine snapshot cannot stand in for a capture. */
    snapshot: (): RuntimeAuthorityPins<Instance> => current,
    capture(): RuntimeAuthorityCapture {
      const pins = current;
      if (verifyCurrent(pins) !== true || pins !== current) stale();
      const capture = Object.freeze({}) as RuntimeAuthorityCapture;
      captures.set(capture, current);
      return capture;
    },
    /** Recheck the original capture after await, immediately before the effect. */
    assertCurrent(capture: RuntimeAuthorityCapture): void {
      const pins = original(capture);
      if (verifyCurrent(pins) !== true) stale();
      // Verifiers are synchronous, but must not be able to reenter a transition.
      original(capture);
    },
    transition(
      capture: RuntimeAuthorityCapture,
      next: RuntimeAuthorityPins<Instance>,
    ): RuntimeAuthorityPins<Instance> {
      const previous = original(capture);
      const candidate = immutable(next);
      if (verifyTransition(previous, candidate) !== true) stale();
      original(capture);
      current = candidate;
      return current;
    },
  });
}

/**
 * Existing protocol readers, not caller-defined verification predicates. The
 * composition supplies modules once; all selection, comparisons and transitions
 * below belong to this owner. No writer or physical executor is introduced.
 */
export interface BrokerRuntimeIdentityReaders {
  instance: Pick<
    BrokerModules["./queue-instance"],
    | "readJson"
    | "durable"
    | "hash"
    | "sameInstance"
    | "idle"
    | "priorProcessAlive"
    | "buildHash"
  >;
  backend: Pick<typeof Backend, "resolveBackendHead">;
  epochs: {
    openIsolatedEpoch(
      directory: string,
      options: { recover: false },
    ): { readonly epoch: P.Epoch | null };
  };
  lineage: Pick<
    typeof Lineage,
    "epochLineage" | "epochControlDirectory" | "successionAuthority"
  >;
  normalAdmission: Pick<typeof NormalAdmission, "epochStartupPinned">;
  normalRestart: Pick<
    typeof NormalRestart,
    | "inspectSettledNormalRestart"
    | "normalRestartInstance"
    | "commitSettledNormalRestart"
  >;
  atomicObservation: Pick<
    typeof AtomicObservation,
    "isAtomicObservationCandidate"
  >;
  hasRuntimeRootEvidence(directory: string): boolean;
}

/** Only the current startup/control view and two existing domain operations. */
export type BrokerRuntimeStartupView = Readonly<
  Pick<
    P.Snapshot,
    | "revision"
    | "controlGeneration"
    | "contextEpoch"
    | "paused"
    | "active"
    | "blocked"
    | "lease"
    | "localUnknown"
    | "controlBlocked"
    | "controlRequests"
    | "jobs"
  >
>;

export interface BrokerRuntimeQueue {
  epoch(): P.Epoch | null;
  admissionMode(): string;
  current(): BrokerRuntimeStartupView;
  assertEpoch(normal: boolean): void;
  writerStatus(): { readonly ready: boolean };
  advanceInstanceEpoch(transitionId: string): unknown;
}

export interface BrokerRuntimeIdentityOptions {
  directory: string;
  buildHash: string;
  configHash: string;
  owner: P.Owner;
  runtimeRoot?: Pick<
    RuntimeRootPhysicalWiring,
    "verifyRuntimeRootBeforeRestore" | "assertVerifiedRoot"
  >;
  transitions?: {
    backend?: unknown;
    atomicMigrationNonce?: string;
    epochRuntimeUpgradeNonce?: string;
    deadEpochSuccessorNonce?: string;
  };
  confirmVersionTransition?: boolean;
  /** Preserve the existing explicit injected-backend test seam, not a new flag. */
  testBackendFactory?: NonNullable<P.Options["createBackend"]>;
  observationScope: Parameters<
    typeof AtomicObservation.isAtomicObservationCandidate
  >[2];
}

function reject(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

type BackendScope = ReturnType<typeof Backend.resolveBackendHead>;
type BackendCommit = NonNullable<
  ReturnType<typeof Backend.prepareBackendTransition>
>;
export interface BrokerRuntimeStartupProbe {
  binding: P.Binding;
  receiptPath: string;
  diagnosticPath: string;
}

export interface BrokerRuntimeSelection {
  readonly approvedRuntimeRoot: ApprovedRuntimeRoot | undefined;
  readonly backendScope: BackendScope;
  readonly identityFile: string;
  readonly previousIdentity: Readonly<P.Identity> | null;
}

export interface BrokerRuntimeIdentity {
  selection(): BrokerRuntimeSelection;
  current(): RuntimeAuthorityPins<P.Instance>;
  previousIdentity(): Readonly<P.Identity> | null;
  isAtomicObservationOnly(): boolean;
  capture(): RuntimeAuthorityCapture;
  assertCurrent(capture: RuntimeAuthorityCapture): void;
  bindQueue(
    port: BrokerRuntimeQueue,
    claims?: { successorAuthority?: P.Reference },
  ): void;
  identifyStartup(
    probe: BrokerRuntimeStartupProbe,
    observe: () => Promise<P.Instance>,
    backendTransition?: BackendCommit | null,
  ): Promise<{ hold: string | null; atomicObservationOnly: boolean }>;
  activatePublishedEpoch(): RuntimeAuthorityPins<P.Instance>;
}

/**
 * Select before restoring the queue. Native roots use their authenticated
 * closure; legacy backend heads use the existing lineage-aware reader.
 */
export async function openBrokerRuntimeAuthority(
  input: BrokerRuntimeIdentityOptions,
  readers: BrokerRuntimeIdentityReaders,
): Promise<BrokerRuntimeIdentity> {
  const options = Object.freeze({
    ...input,
    transitions: Object.freeze({ ...input.transitions }),
  });
  const dir = path.resolve(options.directory);
  const owner = freeze(structuredClone(options.owner));
  const {
    readJson,
    durable,
    hash,
    sameInstance,
    idle,
    priorProcessAlive,
    buildHash,
  } = readers.instance;
  const approvedRuntimeRoot: ApprovedRuntimeRoot | undefined =
    await options.runtimeRoot?.verifyRuntimeRootBeforeRestore({
      directory: dir,
      buildHash: options.buildHash,
      configHash: options.configHash,
    });
  if (!approvedRuntimeRoot && readers.hasRuntimeRootEvidence(dir))
    reject(
      "RUNTIME_ROOT_AUTHORITY_REQUIRED",
      "Use the private native-authenticated runtime-root startup",
    );
  if (
    approvedRuntimeRoot &&
    Object.values(options.transitions ?? {}).some(
      (value) => value !== undefined,
    )
  )
    reject(
      "PHYSICAL_CAPABILITY_CONFLICT",
      "Native runtime-root startup cannot also claim a legacy transition",
    );
  const readEpoch = () =>
    readers.epochs.openIsolatedEpoch(dir, { recover: false }).epoch;
  const resolveHead = (): BackendScope =>
    readers.backend.resolveBackendHead(dir, () => ({ epoch: readEpoch() }));
  let backendScope: BackendScope = approvedRuntimeRoot
    ? { current: null, retired: null }
    : resolveHead();
  if (backendScope.current) {
    const epoch = readEpoch();
    const head = backendScope.current.head;
    if (
      !epoch ||
      epoch.epochId !== head.epochId ||
      epoch.ownerClientId !== head.ownerClientId ||
      epoch.ownerTokenHash !== head.ownerTokenHash
    )
      reject(
        "BACKEND_TRANSITION_CHANGED",
        "Backend transition no longer belongs to the exact active epoch owner",
      );
    if (
      !options.transitions.backend &&
      !options.transitions.deadEpochSuccessorNonce &&
      backendScope.current.identity.buildHash !== options.buildHash
    )
      reject(
        "BUILD_CHANGED",
        "Restore the exact physical backend transition runtime before reopening",
      );
  }
  let identityFile = approvedRuntimeRoot
    ? path.join(dir, "runtime-rebaseline-current-instance.json")
    : backendScope.retired?.identityFile || path.join(dir, "instance.json");
  const readIdentity = (file = identityFile): P.Identity | null =>
    fs.existsSync(file) ? readJson<P.Identity>(file) : null;
  const initialIdentity = readIdentity();
  if (
    !options.transitions?.backend &&
    initialIdentity &&
    (backendScope.current?.identity || initialIdentity).configHash !==
      options.configHash
  )
    reject(
      "CONFIG_CHANGED",
      "Pinned backend configuration differs from the durable broker identity",
    );
  // Selection is diagnostic input for existing restore/claim protocols, not a grant.
  const selection = Object.freeze({
    approvedRuntimeRoot,
    backendScope: freeze(structuredClone(backendScope)),
    identityFile,
    previousIdentity: initialIdentity
      ? freeze(structuredClone(initialIdentity))
      : null,
  });
  let queue: BrokerRuntimeQueue | undefined;
  let successor: ReturnType<typeof Lineage.successionAuthority> | null = null;
  let identity = initialIdentity;
  let atomicObservationOnly = false;
  let started = false;
  let startupCompleted = false;
  let bindingStarted = false;
  let bound = false;
  const state = (): BrokerRuntimeQueue => {
    if (!queue)
      reject(
        "RUNTIME_AUTHORITY_UNBOUND",
        "Restore the selected current queue before binding identity",
      );
    return queue;
  };
  const assertOwner = () => {
    if (
      !same(readJson(path.join(dir, "broker.lock")), owner) ||
      buildHash() !== options.buildHash
    )
      reject(
        "RUNTIME_AUTHORITY_CHANGED",
        "The original broker owner or executable changed",
      );
  };
  const assertHead = (permittedBuild = options.buildHash) => {
    if (approvedRuntimeRoot) {
      if (state().admissionMode() !== "runtime-rebaseline")
        reject(
          "RUNTIME_ROOT_AUTHORITY_REQUIRED",
          "Native runtime-root state is required",
        );
      options.runtimeRoot!.assertVerifiedRoot(dir);
      return;
    }
    const actual = resolveHead();
    if (!same(actual, backendScope))
      reject(
        "BACKEND_TRANSITION_CHANGED",
        "Physical backend head changed before startup",
      );
    const head = actual.current?.head;
    const epoch = state().epoch();
    if (
      head &&
      (!epoch ||
        epoch.epochId !== head.epochId ||
        epoch.ownerClientId !== head.ownerClientId ||
        epoch.ownerTokenHash !== head.ownerTokenHash)
    )
      reject(
        "BACKEND_TRANSITION_CHANGED",
        "Backend transition no longer belongs to the exact active epoch owner",
      );
    if (
      actual.current &&
      !options.transitions?.backend &&
      actual.current.identity.buildHash !== permittedBuild
    )
      reject(
        "BUILD_CHANGED",
        "Restore the exact physical backend transition runtime before reopening",
      );
  };
  const sameDurableIdentity = () => same(readIdentity(), identity);
  const pins = (instance: P.Instance | null, processUnavailable: boolean) => ({
    instance,
    identityFile,
    epochId: queue?.epoch()?.epochId ?? null,
    root: queue?.epoch()?.root ?? dir,
    buildHash: identity?.buildHash ?? options.buildHash,
    configHash: identity?.configHash ?? options.configHash,
    processUnavailable,
  });
  const verifyCurrent = (pinned: RuntimeAuthorityPins<P.Instance>) => {
    assertOwner();
    assertHead(successor?.effectiveIdentity?.buildHash);
    const epoch = state().epoch();
    return (
      state().writerStatus().ready &&
      (approvedRuntimeRoot !== undefined || same(readEpoch(), epoch)) &&
      pinned.epochId === (epoch?.epochId ?? null) &&
      pinned.root === (epoch?.root ?? dir) &&
      pinned.identityFile === identityFile &&
      pinned.buildHash === (identity?.buildHash ?? options.buildHash) &&
      pinned.configHash === (identity?.configHash ?? options.configHash) &&
      (!pinned.instance || sameInstance(pinned.instance, identity?.instance)) &&
      sameDurableIdentity()
    );
  };
  const verifyTransition = (
    _previous: RuntimeAuthorityPins<P.Instance>,
    next: RuntimeAuthorityPins<P.Instance>,
  ) => {
    assertOwner();
    return (
      next.identityFile === identityFile &&
      sameDurableIdentity() &&
      sameInstance(next.instance, identity?.instance)
    );
  };
  let authority = createQueueRuntimeAuthority(pins(null, false), {
    verifyCurrent,
    // Kept private: callers cannot supply new pins or a verification flag.
    verifyTransition,
  });
  const adopt = (
    original: RuntimeAuthorityCapture,
    instance: P.Instance | null,
    processUnavailable: boolean,
  ) => {
    // The preceding protocol owns durable publication. Rebind only after its
    // identity has been reread, not from an activate callback's supplied DTO.
    identity = readIdentity();
    authority.transition(original, pins(instance, processUnavailable));
  };
  return Object.freeze({
    selection: () => selection,
    current: () => authority.snapshot(),
    previousIdentity: () =>
      identity ? freeze(structuredClone(identity)) : null,
    isAtomicObservationOnly: () => atomicObservationOnly,
    capture() {
      if (!bound)
        reject(
          "RUNTIME_AUTHORITY_UNBOUND",
          "Current runtime identity is not bound",
        );
      return authority.capture();
    },
    assertCurrent(capture: RuntimeAuthorityCapture) {
      if (!bound)
        reject(
          "RUNTIME_AUTHORITY_UNBOUND",
          "Current runtime identity is not bound",
        );
      authority.assertCurrent(capture);
    },
    /** Bind only once, after existing restore and authenticated claim protocols. */
    bindQueue(
      port: BrokerRuntimeQueue,
      claims: {
        successorAuthority?: P.Reference;
      } = {},
    ) {
      if (bindingStarted)
        reject(
          "RUNTIME_AUTHORITY_BOUND",
          "Runtime identity already has its current queue",
        );
      bindingStarted = true;
      queue = port;
      if (claims.successorAuthority) {
        // claimSuccessorBroker owns process acquisition. Re-read its immutable
        // evidence without re-claiming or re-running a pre-claim process guard.
        const claimed = readers.lineage.successionAuthority(
          dir,
          claims.successorAuthority,
        );
        if (
          claimed.authority["nonce"] !==
            options.transitions?.deadEpochSuccessorNonce ||
          claimed.authority.buildHash !== options.buildHash ||
          claimed.authority["configHash"] !== options.configHash ||
          !same(readJson(path.join(dir, "active-epoch-succession.json")), {
            version: 1,
            authority: claims.successorAuthority,
          })
        )
          reject(
            "EPOCH_SUCCESSOR_CLAIM_UNPROVEN",
            "Successor identity must bind the exact claimed authority",
          );
        successor = claimed;
      }
      if (port.epoch())
        identityFile = path.join(port.epoch()!.root, "instance.json");
      if (successor?.effectiveIdentity) {
        const expected = backendScope.current?.identity || readIdentity();
        if (
          !expected ||
          successor.effectiveIdentity.buildHash !== expected.buildHash ||
          successor.effectiveIdentity.configHash !== expected.configHash ||
          !sameInstance(successor.effectiveIdentity.instance, expected.instance)
        )
          reject(
            "BACKEND_TRANSITION_CHANGED",
            "Successor claim differs from the verified predecessor identity",
          );
      }
      assertHead(successor?.effectiveIdentity?.buildHash);
      if (backendScope.current)
        identityFile = backendScope.current.identityFile;
      identity = readIdentity();
      // No capture from before restore may authorize a later operation.
      authority = createQueueRuntimeAuthority(pins(null, false), {
        verifyCurrent,
        verifyTransition,
      });
      bound = true;
    },
    async identifyStartup(
      probe: BrokerRuntimeStartupProbe,
      observe: () => Promise<P.Instance>,
      backendTransition: BackendCommit | null = null,
    ): Promise<{ hold: string | null; atomicObservationOnly: boolean }> {
      if (!bound || started)
        reject(
          "RUNTIME_STARTUP_ALREADY_STARTED",
          "Startup identity cannot be replayed",
        );
      started = true;
      assertOwner();
      if (
        !backendTransition &&
        identity &&
        identity.configHash !== options.configHash
      )
        reject(
          "CONFIG_CHANGED",
          "Pinned backend configuration differs from the durable broker identity",
        );
      const q = state();
      const original = authority.capture();
      const epoch = q.epoch();
      const data = q.current();
      const normal = q.admissionMode() === "normal-multidocument";
      const view = {
        epoch,
        admissionMode: q.admissionMode(),
        data,
        assertEpoch: (allowNormal: boolean) => q.assertEpoch(allowNormal),
      };
      let restart: ReturnType<typeof NormalRestart.inspectSettledNormalRestart>;
      if (
        epoch &&
        normal &&
        identity &&
        !successor &&
        !backendTransition &&
        !backendScope.current
      ) {
        try {
          restart = readers.normalRestart.inspectSettledNormalRestart(
            dir,
            epoch,
            identity,
            data,
            { priorProcessAlive },
          );
        } catch (cause) {
          if (cause && typeof cause === "object")
            Object.assign(cause, { probeNotSubmitted: true });
          throw cause;
        }
      }
      if (
        !backendTransition &&
        (successor ||
          readers.normalAdmission.epochStartupPinned(
            view,
            identity?.buildHash,
            options.buildHash,
            !!restart,
          ))
      ) {
        if (!epoch)
          reject(
            "EPOCH_PROOF_INVALID",
            "Pinned startup requires its qualified epoch",
          );
        const closed = fs.existsSync(path.join(epoch.root, "closed.json"));
        let unavailable = !!successor;
        if (!closed || normal) {
          try {
            q.assertEpoch(normal);
          } catch (cause) {
            if (
              !cause ||
              typeof cause !== "object" ||
              !("code" in cause) ||
              cause.code !== "INSTANCE_CHANGED"
            )
              throw cause;
            unavailable = true;
          }
        }
        const expectedBuild =
          successor?.effectiveIdentity?.buildHash ||
          successor?.authority.previousBuildHash ||
          options.buildHash;
        if (!identity || identity.buildHash !== expectedBuild)
          reject(
            "BUILD_CHANGED",
            "An isolated epoch requires its exact qualified runtime and current process identity",
          );
        const expectedInstance = normal
          ? backendScope.current?.identity.instance ||
            readers.normalRestart.normalRestartInstance(
              dir,
              epoch,
              identity,
              data,
            )
          : epoch.currentInstance;
        if (!sameInstance(identity.instance, expectedInstance as P.Instance))
          reject(
            "BUILD_CHANGED",
            "An isolated epoch requires its exact qualified runtime and current process identity",
          );
        adopt(original, identity.instance, unavailable);
        const hold = unavailable
          ? "Qualified isolated scratch process is unavailable; metadata only, no SDK or replacement authority"
          : normal
            ? null
            : closed
              ? "Qualified isolated scratch is closed; historical unknown work remains quarantined"
              : fs.existsSync(
                    path.join(
                      readers.lineage.epochControlDirectory(dir, epoch),
                      "isolated-scratch-close",
                      "intent.json",
                    ),
                  )
                ? "Isolated scratch cleanup remains pending or uncertain"
                : null;
        startupCompleted = true;
        return { hold, atomicObservationOnly };
      }
      if (data.blocked || data.controlBlocked) {
        if (identity && identity.buildHash !== options.buildHash) {
          const target = data.blocked && data.jobs[data.blocked.id];
          if (
            !target ||
            !readers.atomicObservation.isAtomicObservationCandidate(
              target,
              identity.buildHash,
              options.observationScope,
            )
          )
            reject(
              "BUILD_CHANGED",
              "Restore the original executable build before reconciling the unfinished job",
            );
          if (!identity.instance)
            reject(
              "INSTANCE_UNAVAILABLE",
              "Original Fusion instance identity is unavailable",
            );
          atomicObservationOnly = true;
        }
        if (identity) adopt(original, identity.instance, false);
        startupCompleted = true;
        return {
          hold: atomicObservationOnly
            ? "Read-only atomic holder observation only; all other admission remains blocked"
            : "Restored unfinished job; matching remote terminal receipts are required before any probe",
          atomicObservationOnly,
        };
      }
      const originalControl = [
        data.revision,
        data.controlGeneration,
        data.contextEpoch,
      ];
      const observed = await observe();
      authority.assertCurrent(original);
      const current = q.current();
      if (
        !same(originalControl, [
          current.revision,
          current.controlGeneration,
          current.contextEpoch,
        ])
      )
        reject(
          "RUNTIME_AUTHORITY_CHANGED",
          "Current queue changed during startup observation",
        );
      let restartReference: P.Reference | undefined;
      if (
        !backendTransition &&
        identity &&
        !sameInstance(observed, identity.instance)
      ) {
        const versionChanged = identity.instance.version !== observed.version;
        const quiescent =
          !current.paused &&
          !current.active &&
          !current.blocked &&
          !current.lease &&
          !current.controlBlocked &&
          Object.values(current.jobs).every((job) =>
            ["succeeded", "failed", "cancelled", "expired"].includes(job.state),
          );
        if (
          typeof identity.buildHash !== "string" ||
          priorProcessAlive(identity.instance) !== false ||
          !idle(observed) ||
          !Array.isArray(observed.documents) ||
          observed.documents.some(
            (document) => document?.isModified !== false,
          ) ||
          (versionChanged &&
            (options.confirmVersionTransition !== true || !quiescent))
        )
          reject(
            "INSTANCE_CHANGED",
            versionChanged
              ? "Fusion version changed; explicit confirmation, a dead old process, an unpaused quiescent queue, an idle UI and clean documents are required"
              : "Fusion identity changed; automatic recovery requires the old process gone, an idle UI and unmodified documents",
          );
        const transitionId = hash(
          JSON.stringify({
            configHash: options.configHash,
            buildHash: options.buildHash,
            previous: identity.instance,
            current: observed,
          }),
        );
        if (restart)
          restartReference = readers.normalRestart.commitSettledNormalRestart(
            restart,
            current,
            observed,
            probe.binding,
            probe.receiptPath,
            { priorProcessAlive },
          );
        const queueTransition = q.advanceInstanceEpoch(transitionId);
        durable(path.join(dir, `instance-transition-${transitionId}.json`), {
          source: versionChanged
            ? "explicit-quiescent-version-transition"
            : "automatic-quiescent-restart-recovery",
          transitionId,
          at: new Date().toISOString(),
          configHash: options.configHash,
          previousBuildHash: identity.buildHash,
          buildHash: options.buildHash,
          previous: identity.instance,
          current: observed,
          queueTransition,
        });
      }
      if (backendTransition) {
        const receipt = fs.existsSync(probe.receiptPath)
          ? readJson<Record<string, unknown>>(probe.receiptPath)
          : null;
        const exactReceipt =
          !!receipt &&
          receipt["terminal"] === true &&
          receipt["outcome"] === "succeeded" &&
          sameInstance(receipt["instance"] as P.Instance, observed) &&
          !Object.entries(probe.binding).some(
            ([key, value]) => !same(receipt[key], value),
          );
        if (!options.testBackendFactory && !exactReceipt)
          reject(
            "BACKEND_TRANSITION_UNPROVEN",
            "Exact target startup receipt is required; ownership is retained without replay",
          );
        const published = backendTransition.commit(
          observed,
          options.buildHash,
          [probe.diagnosticPath, ...(exactReceipt ? [probe.receiptPath] : [])],
        );
        backendScope = resolveHead();
        if (
          published !== backendScope.current?.identityFile ||
          !sameInstance(backendScope.current.identity.instance, observed) ||
          backendScope.current.identity.buildHash !== options.buildHash ||
          backendScope.current.identity.configHash !== options.configHash
        )
          reject(
            "BACKEND_TRANSITION_CHANGED",
            "Published target is not the authenticated backend head",
          );
        identityFile = published;
      } else if (backendScope.current) {
        if (
          identity?.buildHash !== options.buildHash ||
          !sameInstance(identity.instance, observed)
        )
          reject(
            "BUILD_CHANGED",
            "Restore the exact physical backend transition runtime before reopening",
          );
      } else {
        durable(identityFile, {
          configHash: options.configHash,
          buildHash: options.buildHash,
          instance: observed,
          ...(restartReference || identity?.normalRestart
            ? { normalRestart: restartReference || identity?.normalRestart }
            : {}),
        });
      }
      adopt(original, observed, false);
      startupCompleted = true;
      return { hold: null, atomicObservationOnly };
    },
    /** Re-read the published protocol; never adopt a caller's epoch/identity DTO. */
    activatePublishedEpoch() {
      if (!startupCompleted)
        reject(
          "RUNTIME_STARTUP_UNVERIFIED",
          "Epoch activation requires the completed original startup",
        );
      assertOwner();
      if (!sameDurableIdentity())
        reject(
          "RUNTIME_AUTHORITY_CHANGED",
          "The original runtime identity changed before epoch publication",
        );
      if (approvedRuntimeRoot)
        reject(
          "PHYSICAL_CAPABILITY_CONFLICT",
          "A native runtime root cannot adopt a legacy epoch",
        );
      const previous = authority.snapshot();
      const epoch = readEpoch();
      if (!epoch || !same(epoch, state().epoch()))
        reject(
          "EPOCH_PROOF_INVALID",
          "Current queue differs from the qualified published epoch",
        );
      const publishedPointer = readJson<Lineage.EpochPointer>(
        path.join(dir, "isolated-admission-epoch.json"),
      );
      if (!same(publishedPointer, epoch))
        reject(
          "EPOCH_PROOF_INVALID",
          "Published epoch pointer changed during activation",
        );
      const links = readers.lineage.epochLineage(dir, publishedPointer);
      if (previous.epochId && previous.epochId !== epoch.epochId) {
        const link = links.find(
          (entry) => entry.pointer.epochId === previous.epochId,
        );
        const predecessor = link?.effectiveIdentity || link?.identity;
        if (
          !predecessor ||
          predecessor.configHash !== previous.configHash ||
          predecessor.buildHash !== previous.buildHash ||
          !sameInstance(predecessor.instance as P.Instance, previous.instance)
        )
          reject(
            "EPOCH_LINEAGE_INVALID",
            "Published successor does not bind the original current identity",
          );
      }
      const nextScope = resolveHead();
      if (
        !same(
          backendScope.current?.head || backendScope.retired?.head,
          nextScope.current?.head || nextScope.retired?.head,
        )
      )
        reject(
          "BACKEND_TRANSITION_CHANGED",
          "Epoch publication cannot replace a physical backend head",
        );
      const nextFile =
        nextScope.current?.identityFile ||
        path.join(epoch.root, "instance.json");
      const next = readIdentity(nextFile);
      if (
        !next ||
        next.configHash !== options.configHash ||
        next.buildHash !== options.buildHash ||
        !sameInstance(next.instance, epoch.currentInstance)
      )
        reject(
          "EPOCH_PROOF_INVALID",
          "Published epoch identity does not bind its qualified runtime",
        );
      if (
        previous.epochId === epoch.epochId &&
        previous.instance &&
        !sameInstance(previous.instance, next.instance)
      )
        reject(
          "EPOCH_LINEAGE_INVALID",
          "The same epoch cannot silently replace its qualified process",
        );
      backendScope = nextScope;
      identityFile = nextFile;
      successor = null;
      identity = next;
      // Existing protocol readers have established the new epoch. Recreate the
      // private authority so old captures (including same-instance ABA) expire.
      authority = createQueueRuntimeAuthority(pins(next.instance, false), {
        verifyCurrent,
        verifyTransition: () => false,
      });
      atomicObservationOnly = false;
      return authority.snapshot();
    },
  });
}

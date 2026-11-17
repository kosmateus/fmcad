import * as fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import type * as P from "./queue-broker-ports";
import type { BrokerModules } from "./queue-broker-modules";
import { epochLineage, type EpochPointer } from "./queue-epoch-lineage";

const load = createRequire(__filename);
const { readJson, durable, hash, brokerConfigHash, sameInstance, idle } = load(
  "./queue-instance",
) as BrokerModules["./queue-instance"];

export interface BackendTransitionApproval {
  requestId: string;
  clientId: string;
  clientToken: string;
  previousConfig: P.Config;
  nextConfig: P.Config;
  stopRequestId?: string;
}
interface Reference {
  path: string;
  sha256: string;
}
interface Head {
  version: 1;
  kind: "owner-bound-physical-backend-transition";
  requestId: string;
  ownerClientId: string;
  ownerTokenHash: string;
  epochId: string;
  previousConfigHash: string;
  nextConfigHash: string;
  previousConfig: P.Config;
  nextConfig: P.Config;
  predecessor: Reference[];
  observation: Reference[];
  identity: Reference;
  deadPredecessor?: Reference;
}
export interface DeadPredecessorProof {
  identity: P.Identity;
  references: Reference[];
  record: Record<string, unknown>;
  assertValid(): void;
}
function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
function reference(file: string): Reference {
  return { path: file, sha256: hash(fs.readFileSync(file)) };
}
function verify(ref: Reference): void {
  if (
    !ref ||
    typeof ref.path !== "string" ||
    reference(ref.path).sha256 !== ref.sha256
  )
    fail(
      "BACKEND_TRANSITION_CHANGED",
      "Backend transition predecessor evidence changed",
    );
}
function headFile(dir: string): string {
  return path.join(dir, "physical-backend-head.json");
}

/** No fallback to root identity on a damaged transition. All predecessor bytes
 * remain authoritative, including the quarantined root identity and receipts. */
export function backendHead(
  dir: string,
): { head: Head; identityFile: string; identity: P.Identity } | null {
  if (!fs.existsSync(headFile(dir))) return null;
  const head = readJson<Head>(headFile(dir));
  if (
    head.version !== 1 ||
    head.kind !== "owner-bound-physical-backend-transition" ||
    !Array.isArray(head.predecessor) ||
    !Array.isArray(head.observation) ||
    typeof head.requestId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(head.requestId)
  )
    fail(
      "BACKEND_TRANSITION_CHANGED",
      "Invalid physical backend transition head",
    );
  const destination = path.join(
    dir,
    "physical-backend-transitions",
    head.requestId,
  );
  if (
    !isDeepStrictEqual(
      head,
      readJson<Head>(path.join(destination, "transition.json")),
    ) ||
    head.identity.path !== path.join(destination, "instance.json") ||
    brokerConfigHash(head.previousConfig) !== head.previousConfigHash ||
    brokerConfigHash(head.nextConfig) !== head.nextConfigHash
  )
    fail(
      "BACKEND_TRANSITION_CHANGED",
      "Transition head differs from immutable owner approval evidence",
    );
  for (const ref of head.predecessor) verify(ref);
  if (head.deadPredecessor) {
    const expected = path.join(destination, "dead-predecessor.json");
    if (
      head.deadPredecessor.path !== expected ||
      !head.predecessor.some((ref) =>
        isDeepStrictEqual(ref, head.deadPredecessor),
      )
    )
      fail(
        "BACKEND_TRANSITION_CHANGED",
        "Dead predecessor proof is not anchored by the transition head",
      );
    const proof = readJson<Record<string, unknown>>(expected);
    if (
      proof["kind"] !== "settled-normal-dead-predecessor-v1" ||
      !Array.isArray(proof["evidence"])
    )
      fail("BACKEND_TRANSITION_CHANGED", "Dead predecessor proof is invalid");
    for (const ref of proof["evidence"] as Reference[]) {
      if (!head.predecessor.some((entry) => isDeepStrictEqual(entry, ref)))
        fail(
          "BACKEND_TRANSITION_CHANGED",
          "Dead predecessor source evidence is not anchored by the transition head",
        );
    }
  }
  for (const ref of head.observation) verify(ref);
  verify(head.identity);
  const identity = readJson<P.Identity>(head.identity.path);
  if (identity.configHash !== head.nextConfigHash)
    fail(
      "BACKEND_TRANSITION_CHANGED",
      "Transition identity/config binding changed",
    );
  return { head, identityFile: head.identity.path, identity };
}

/** A head from another epoch is history only when the authenticated lineage
 * contains these exact bytes. Never validate its stale live-pointer refs as if
 * they described the current epoch, or silently fall back on a damaged head. */
export function resolveBackendHead(
  dir: string,
  readState: () => Pick<P.State, "epoch">,
) {
  const file = headFile(dir);
  const currentEpoch = () => {
    // openIsolatedEpoch(recover:false) validates qualification/lineage without
    // granting live admission. assertEpoch() would incorrectly reject a dead
    // predecessor here before the successor's stricter dead-process proof.
    const epoch = readState().epoch;
    if (!epoch) return null;
    const pointer = readJson<EpochPointer>(
      path.join(dir, "isolated-admission-epoch.json"),
    );
    if (!isDeepStrictEqual(pointer, epoch))
      fail(
        "BACKEND_TRANSITION_CHANGED",
        "Admission epoch changed during backend resolution",
      );
    return pointer;
  };
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // An authenticated successor which inherited a transition cannot silently
      // lose its mutable head and fall back to the original root configuration.
      try {
        fs.lstatSync(path.join(dir, "isolated-admission-epoch.json"));
      } catch (pointerError) {
        if ((pointerError as NodeJS.ErrnoException).code === "ENOENT")
          return { current: null, retired: null };
        throw pointerError;
      }
      const epoch = currentEpoch();
      if (epoch) {
        if (
          epochLineage(dir, epoch).some(
            (value) => value.authority.backendTransition,
          )
        )
          fail(
            "BACKEND_TRANSITION_CHANGED",
            "Authenticated backend predecessor head is missing",
          );
      }
      return { current: null, retired: null };
    }
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink())
    fail(
      "BACKEND_TRANSITION_CHANGED",
      "Physical backend head must be a regular file",
    );
  const head = readJson<Head>(file);
  const epoch = currentEpoch();
  if (!epoch || head.epochId === epoch.epochId) {
    const current = backendHead(dir);
    if (epoch && current?.head.deadPredecessor) epochLineage(dir, epoch);
    return { current, retired: null };
  }
  const entry = reference(file);
  const previous = epochLineage(dir, epoch).find(
    (value) =>
      value.effectiveIdentity &&
      value.pointer.epochId === head.epochId &&
      value.authority.backendTransition?.head.sha256 === entry.sha256,
  );
  if (
    !epoch.succession ||
    !previous?.authority.backendTransition ||
    head.ownerClientId !== epoch.ownerClientId ||
    head.ownerTokenHash !== epoch.ownerTokenHash
  )
    fail(
      "BACKEND_TRANSITION_CHANGED",
      "Backend head is not an authenticated predecessor of this epoch",
    );
  return {
    current: null,
    retired: {
      head,
      reference: entry,
      authority: epoch.succession,
      transition: previous.authority.backendTransition.head,
      identityFile: path.join(epoch.root, "instance.json"),
      epochId: epoch.epochId,
      ownerClientId: epoch.ownerClientId,
      ownerTokenHash: epoch.ownerTokenHash,
    },
  };
}

export function assertTransitionIdle(
  state: P.State,
  allowPaused = false,
  deadPredecessor?: DeadPredecessorProof,
): void {
  const data = state.data;
  if (!state.epoch || state.admissionMode !== "normal-multidocument")
    fail(
      "BACKEND_TRANSITION_SCOPE",
      "Only a released normal multidocument epoch supports backend transition",
    );
  if (deadPredecessor) deadPredecessor.assertValid();
  else state.assertEpoch(true);
  if (
    (data.paused && !allowPaused) ||
    data.active ||
    data.blocked ||
    data.lease ||
    data.localUnknown ||
    data.controlBlocked ||
    Object.values(data.jobs).some(
      (job) =>
        !["succeeded", "failed", "cancelled", "expired"].includes(job.state),
    )
  )
    fail(
      "EPOCH_BUSY",
      "Backend transition requires settled current work and an unpaused or exactly stop-proven gate; unknown work cannot be replayed",
    );
}

export function prepareBackendTransition(
  dir: string,
  state: P.State,
  cfg: P.Config,
  approval: BackendTransitionApproval,
  deadPredecessor?: DeadPredecessorProof,
): {
  identity: P.Identity;
  deadPredecessor: boolean;
  assertEvidence(): void;
  commit(
    instance: P.Instance,
    buildHash: string,
    observationFiles?: string[],
  ): string;
} {
  assertTransitionIdle(state, true, deadPredecessor);
  const epoch = state.epoch!;
  const clients = readJson<Record<string, string>>(
    path.join(dir, "clients.json"),
  );
  if (
    !approval ||
    approval.clientId !== epoch.ownerClientId ||
    hash(approval.clientToken || "") !== epoch.ownerTokenHash ||
    clients[approval.clientId] !== epoch.ownerTokenHash
  )
    fail(
      "NOT_OWNER",
      "Exact existing epoch owner credentials are required for physical backend transition",
    );
  const stopEvidence: Reference[] = [];
  let stopBuildHash: string | undefined;
  const paused = state.data.paused;
  const generation = state.data.controlGeneration;
  if (paused) {
    const requestId = approval.stopRequestId;
    if (
      typeof requestId !== "string" ||
      requestId.length === 0 ||
      requestId.length > 256
    )
      fail(
        "EPOCH_BUSY",
        "A paused backend transition requires the exact completed owner stop request",
      );
    const digest = hash(requestId);
    const adminFile = path.join(dir, `console-admin-${digest}.json`);
    const releaseFile = path.join(dir, `console-release-${digest}.json`);
    const admin = readJson<{
      action: string;
      clientId: string;
      requestId: string;
      instanceId: string;
      expectedGeneration: number;
      status: string;
      buildHash: string;
      result: { releaseFile: string };
    }>(adminFile);
    const release = readJson<{
      terminal: boolean;
      outcome: string;
      requestId: string;
      instanceId: string;
      buildHash: string;
    }>(releaseFile);
    const pause = state.data.controlRequests?.[requestId];
    if (
      admin.action !== "console-stop" ||
      admin.clientId !== epoch.ownerClientId ||
      admin.requestId !== requestId ||
      admin.status !== "accepted" ||
      admin.result?.releaseFile !== releaseFile ||
      release.terminal !== true ||
      release.outcome !== "released" ||
      release.requestId !== requestId ||
      release.instanceId !== admin.instanceId ||
      release.buildHash !== admin.buildHash ||
      !pause ||
      pause.paused !== true ||
      pause.generation !== generation ||
      (admin.expectedGeneration !== generation &&
        admin.expectedGeneration + 1 !== generation)
    )
      fail(
        "BACKEND_TRANSITION_UNPROVEN",
        "Exact owner stop/release and unchanged durable pause are required",
      );
    stopEvidence.push(reference(adminFile), reference(releaseFile));
    stopBuildHash = admin.buildHash;
  }
  if (
    typeof approval.requestId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(approval.requestId)
  )
    fail(
      "INVALID_REQUEST",
      "A unique backend transition request id is required",
    );
  if (!isDeepStrictEqual(approval.nextConfig, cfg))
    fail(
      "CONFIG_CHANGED",
      "The exact approved next configuration must match the startup configuration",
    );
  const previous = approval.previousConfig;
  const stripEndpoint = (config: P.Config) => {
    const rest = { ...config };
    for (const key of ["backend", "url", "headers", "tool", "protocolVersion"])
      delete rest[key];
    return rest;
  };
  if (
    !previous ||
    !["addin", "mcp"].includes(String(previous.backend)) ||
    !["addin", "mcp"].includes(String(cfg.backend)) ||
    previous.backend === cfg.backend ||
    !isDeepStrictEqual(stripEndpoint(previous), stripEndpoint(cfg))
  )
    fail(
      "CONFIG_CHANGED",
      "Transition may change only the explicitly approved physical backend, endpoint, headers, tool and protocol version",
    );
  const resolved = resolveBackendHead(dir, () => state);
  const prior = resolved.current;
  const identityFile =
    prior?.identityFile || path.join(epoch.root, "instance.json");
  const identity = readJson<P.Identity>(identityFile);
  if (deadPredecessor && !isDeepStrictEqual(identity, deadPredecessor.identity))
    fail(
      "BACKEND_TRANSITION_UNPROVEN",
      "Dead predecessor proof does not bind the exact durable source identity",
    );
  if (
    stopEvidence.length &&
    (stopBuildHash !== identity.buildHash ||
      prior?.head.predecessor.some((ref) =>
        stopEvidence.some((stop) => stop.path === ref.path),
      ))
  )
    fail(
      "BACKEND_TRANSITION_UNPROVEN",
      "The original completed stop must match the predecessor runtime and may authorize only one transition",
    );
  if (
    brokerConfigHash(previous) !== identity.configHash ||
    (!prior &&
      !resolved.retired &&
      readJson<P.Identity>(path.join(dir, "instance.json")).configHash !==
        identity.configHash)
  )
    fail(
      "CONFIG_CHANGED",
      "Exact approved previous configuration differs from durable identity",
    );
  const destination = path.join(
    dir,
    "physical-backend-transitions",
    approval.requestId,
  );
  if (fs.existsSync(destination))
    fail(
      "BACKEND_TRANSITION_EXISTS",
      "Original transition evidence exists; inspect it without replaying the transition",
    );
  const predecessor = [
    path.join(dir, "instance.json"),
    path.join(epoch.root, "instance.json"),
    path.join(dir, "isolated-admission-epoch.json"),
    ...(prior ? [headFile(dir), identityFile] : []),
    ...(resolved.retired
      ? [
          headFile(dir),
          resolved.retired.authority.path,
          resolved.retired.transition.path,
        ]
      : []),
  ].map(reference);
  predecessor.push(...stopEvidence);
  if (deadPredecessor)
    for (const ref of deadPredecessor.references)
      if (!predecessor.some((entry) => isDeepStrictEqual(entry, ref)))
        predecessor.push(ref);
  // The mutable head is escrowed under this transition before replacing it.
  const stable = predecessor.filter((ref) => ref.path !== headFile(dir));
  const ownerProof = reference(path.join(dir, "clients.json"));
  function assertEvidence() {
    assertTransitionIdle(state, paused, deadPredecessor);
    if (
      state.data.paused !== paused ||
      state.data.controlGeneration !== generation
    )
      fail(
        "BACKEND_TRANSITION_CHANGED",
        "The approved stop pause changed during transition",
      );
    for (const ref of predecessor) verify(ref);
    verify(ownerProof);
  }
  assertEvidence();
  return {
    identity,
    deadPredecessor: !!deadPredecessor,
    assertEvidence,
    commit(instance, buildHash, observationFiles = []) {
      assertEvidence();
      if (
        (deadPredecessor
          ? sameInstance(identity.instance, instance)
          : !sameInstance(identity.instance, instance)) ||
        !idle(instance) ||
        !Array.isArray(instance.documents) ||
        instance.documents.some((document) => document.isModified !== false)
      )
        fail(
          "INSTANCE_CHANGED",
          "Backend transition requires the same live Fusion PID/birth/version, idle UI and clean documents",
        );
      fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
      if (prior) {
        const escrow = path.join(destination, "predecessor-head.json");
        durable(escrow, prior.head, true);
        stable.push(
          reference(escrow),
          ...prior.head.predecessor,
          ...prior.head.observation,
        );
      }
      const nextIdentityFile = path.join(destination, "instance.json");
      let deadPredecessorReference: Reference | undefined;
      if (deadPredecessor) {
        const proofFile = path.join(destination, "dead-predecessor.json");
        durable(proofFile, deadPredecessor.record, true);
        deadPredecessorReference = reference(proofFile);
        stable.push(deadPredecessorReference);
      }
      durable(
        nextIdentityFile,
        { configHash: brokerConfigHash(cfg), buildHash, instance },
        true,
      );
      const head: Head = {
        version: 1,
        kind: "owner-bound-physical-backend-transition",
        requestId: approval.requestId,
        ownerClientId: epoch.ownerClientId,
        ownerTokenHash: epoch.ownerTokenHash,
        epochId: epoch.epochId,
        previousConfigHash: identity.configHash,
        nextConfigHash: brokerConfigHash(cfg),
        predecessor: stable,
        observation: observationFiles.map(reference),
        previousConfig: previous,
        nextConfig: cfg,
        identity: reference(nextIdentityFile),
        ...(deadPredecessorReference
          ? { deadPredecessor: deadPredecessorReference }
          : {}),
      };
      durable(path.join(destination, "transition.json"), head, true);
      durable(headFile(dir), head);
      return nextIdentityFile;
    },
  };
}

import * as fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import type * as P from "./queue-broker-ports";
import type { BrokerModules } from "./queue-broker-modules";

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

export function assertTransitionIdle(state: P.State): void {
  const data = state.data;
  if (!state.epoch || state.admissionMode !== "normal-multidocument")
    fail(
      "BACKEND_TRANSITION_SCOPE",
      "Only a released normal multidocument epoch supports backend transition",
    );
  state.assertEpoch(true);
  if (
    data.paused ||
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
      "Backend transition requires an unpaused settled current queue; unknown work cannot be replayed",
    );
}

export function prepareBackendTransition(
  dir: string,
  state: P.State,
  cfg: P.Config,
  approval: BackendTransitionApproval,
): {
  identity: P.Identity;
  assertEvidence(): void;
  commit(
    instance: P.Instance,
    buildHash: string,
    observationFiles?: string[],
  ): string;
} {
  assertTransitionIdle(state);
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
    delete rest.backend;
    delete rest["url"];
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
      "Transition may change only the explicitly approved physical backend and URL",
    );
  const prior = backendHead(dir);
  const identityFile =
    prior?.identityFile || path.join(epoch.root, "instance.json");
  const identity = readJson<P.Identity>(identityFile);
  if (
    brokerConfigHash(previous) !== identity.configHash ||
    (!prior &&
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
  ].map(reference);
  // The mutable head is escrowed under this transition before replacing it.
  const stable = predecessor.filter((ref) => ref.path !== headFile(dir));
  const ownerProof = reference(path.join(dir, "clients.json"));
  function assertEvidence() {
    assertTransitionIdle(state);
    for (const ref of predecessor) verify(ref);
    verify(ownerProof);
  }
  assertEvidence();
  return {
    identity,
    assertEvidence,
    commit(instance, buildHash, observationFiles = []) {
      assertEvidence();
      if (
        !sameInstance(identity.instance, instance) ||
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
      };
      durable(path.join(destination, "transition.json"), head, true);
      durable(headFile(dir), head);
      return nextIdentityFile;
    },
  };
}

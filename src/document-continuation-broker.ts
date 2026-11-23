import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  CadContext,
  DocumentContinuation,
  DocumentObservation,
  PythonArtifactManifest,
  QueueDomain,
  QueueIsolationTarget,
  QueueRequest,
  QueueJob,
} from "@fmcad/core";
import type { TurnIdentity } from "../packages/core/src/application/broker-execution";
import type { ParamCheckpointGuardV1 } from "../packages/node-adapters/src/python/cad-script";
import { decodeDocumentCheckpointReadback } from "./document-checkpoint-readback";

const load = createRequire(__filename);
const commands = load(
  "./dist/core/application/cad/worker-command",
) as typeof import("../packages/core/src/application/cad/worker-command");
const { hash: canonicalHash } = load(
  "./dist/core/application/cad/json",
) as typeof import("../packages/core/src/application/cad/json");
const { prepareCadScript } = load(
  "./dist/composition/cad",
) as typeof import("./composition/cad");
const { pythonArtifactManifest } = load(
  "./dist/python/context-binding",
) as typeof import("../packages/node-adapters/src/python/context-binding");

export interface ContinuationActor {
  readonly clientId: string;
  readonly clientTokenHash: string;
}
export interface VerifiedContinuationCheckpoint {
  readonly checkpoint: ParamCheckpointGuardV1;
  /** Revalidate original producer/store synchronously after the last await. */
  reverify(): void;
}
export interface DocumentContinuationBrokerPorts {
  readonly domain: QueueDomain;
  currentGeneration(): string;
  /** Current broker ownership and model rights, never a caller assertion. */
  recheck(actor: ContinuationActor, target: QueueIsolationTarget): void;
  verifyObservation(
    observation: DocumentObservation,
    actor: ContinuationActor,
  ): Promise<VerifiedContinuationCheckpoint>;
}
export interface ContinuationProgram {
  readonly script: string;
  readonly sourceHash: string;
  readonly operation: "param.apply";
  readonly target: QueueIsolationTarget;
  readonly readOnly: false;
  readonly manifest: PythonArtifactManifest;
}
export interface ContinuationPrograms {
  readonly requestHash: string;
  readonly guardDigest: string;
  readonly target: QueueIsolationTarget;
  readonly ordinary: ContinuationProgram;
  readonly guarded: ContinuationProgram;
}
export interface PreparedDocumentContinuationSubmission {
  /** One private commit, with no await, for the host's project-activity fence. */
  submit(): Record<string, unknown>;
}
function refuse(): never {
  throw Object.assign(
    new Error("Verified document continuation is unavailable"),
    {
      code: "DOCUMENT_CONTINUATION_UNPROVEN",
    },
  );
}
export function continuationRequestHash(request: QueueRequest): string {
  const { description, ...bound } = request;
  void description;
  return canonicalHash(bound);
}

/** Offline source preparation only, not authority or permission to dispatch.
 * The guarded program must subsequently be bound to a domain-private capability. */
function boundedInvocation(request: QueueRequest) {
  if (request.kind !== "command" || !request.payload || !request.argv) refuse();
  const decoded = commands.decodeCadWorkerInvocation(request.payload);
  const invocation =
    decoded.kind === "cad-command"
      ? decoded.invocation
      : decoded.kind === "cad"
        ? decoded
        : null;
  const argv =
    request.argv[0] === "cad" ? request.argv : ["cad", ...request.argv];
  if (
    !invocation ||
    invocation.operation !== "param.apply" ||
    !invocation.docId ||
    invocation.preview === true ||
    invocation.component !== undefined ||
    !isDeepStrictEqual(commands.cadWorkerPolicyArguments(decoded), argv)
  )
    refuse();
  return { ...invocation, docId: invocation.docId };
}

export function compileDocumentContinuationPrograms(
  input: QueueRequest,
  checkpoint: ParamCheckpointGuardV1,
): ContinuationPrograms {
  const request = structuredClone(input);
  const invocation = boundedInvocation(request);
  const target = {
    creationId: invocation.docId,
    ...(invocation.docFileId === undefined
      ? {}
      : { fileId: invocation.docFileId }),
  };
  const guard = decodeDocumentCheckpointReadback(checkpoint, target);
  const context: CadContext = {
    ...(invocation.doc === undefined ? {} : { doc: invocation.doc }),
    docId: invocation.docId,
    ...(invocation.docFileId === undefined
      ? {}
      : { docFileId: invocation.docFileId }),
    ...(invocation.projectId === undefined
      ? {}
      : { projectId: invocation.projectId }),
    preview: false,
  };
  function compile(checkpoint?: ParamCheckpointGuardV1): ContinuationProgram {
    const artifact = prepareCadScript(
      "param.apply",
      invocation!.data,
      context,
      undefined,
      checkpoint,
    );
    const sourceHash = createHash("sha256")
      .update(artifact.script)
      .digest("hex");
    if (sourceHash !== artifact.sha256) refuse();
    return {
      script: artifact.script,
      sourceHash,
      operation: "param.apply",
      target: structuredClone(target),
      readOnly: false,
      manifest: pythonArtifactManifest(artifact),
    };
  }
  return {
    requestHash: continuationRequestHash(request),
    guardDigest: canonicalHash(guard),
    target,
    ordinary: compile(),
    guarded: compile(guard),
  };
}

function synchronous(check: () => unknown): void {
  const result = check();
  if (result !== undefined) {
    void Promise.resolve(result).catch(() => {});
    refuse();
  }
}

/** Private broker composition. No SDK transport, global registry, serialized
 * authority or fallback compiler is provided by this module. */
export function createDocumentContinuationBroker(
  ports: DocumentContinuationBrokerPorts,
) {
  type Entry = {
    actor: ContinuationActor;
    request: QueueRequest;
    observation: DocumentObservation;
    programs: ContinuationPrograms;
    descriptor: DocumentContinuation;
    verified: VerifiedContinuationCheckpoint;
    jobId?: string;
  };
  const jobs = new Map<string, Entry>();
  const live = new Set<Entry>();
  const turns = new WeakMap<
    TurnIdentity,
    { entry: Entry; verified: VerifiedContinuationCheckpoint }
  >();
  const usedTurns = new WeakSet<TurnIdentity>();
  const activeTurn = new Map<string, TurnIdentity>();
  const latestAttempt = new Map<string, object>();
  if (
    !ports ||
    typeof ports.recheck !== "function" ||
    typeof ports.currentGeneration !== "function" ||
    typeof ports.verifyObservation !== "function" ||
    typeof ports.domain?.createDocumentContinuationAuthority !== "function"
  )
    refuse();
  const domain = ports.domain;
  function generation(): string {
    const value: unknown = ports.currentGeneration();
    if (typeof value !== "string" || !value.trim() || value.length > 256) {
      void Promise.resolve(value).catch(() => {});
      refuse();
    }
    return value;
  }

  function verify(entry: Entry): DocumentContinuation {
    if (!live.has(entry)) refuse();
    synchronous(() => ports.recheck(entry.actor, entry.descriptor.target));
    synchronous(() => entry.verified.reverify());
    if (
      generation() !== entry.descriptor.generation ||
      continuationRequestHash(entry.request) !== entry.descriptor.requestHash ||
      canonicalHash(entry.verified.checkpoint) !==
        entry.descriptor.stateDigest ||
      createHash("sha256")
        .update(entry.programs.guarded.script)
        .digest("hex") !== entry.descriptor.sourceHash
    )
      refuse();
    const fence = domain.documentInspectionFence(
      entry.descriptor.target,
      entry.descriptor.generation,
    );
    const records = domain.data.documentCheckpoints;
    const current = records?.observations[entry.observation.id];
    const acceptance = records?.acceptances[entry.descriptor.acceptanceId];
    if (
      fence.priorCheckpointId !== entry.descriptor.acceptanceId ||
      fence.blockersDigest !== entry.descriptor.blockersDigest ||
      !current ||
      canonicalHash(current) !== canonicalHash(entry.observation) ||
      !acceptance ||
      acceptance.actorClientId !== entry.actor.clientId ||
      acceptance.observationId !== entry.observation.id ||
      acceptance.observationDigest !== canonicalHash(current)
    )
      refuse();
    if (entry.jobId) {
      const job = domain.data.jobs[entry.jobId];
      if (
        !job ||
        job.hash !== entry.descriptor.requestHash ||
        continuationRequestHash(job.request) !== entry.descriptor.requestHash ||
        !isDeepStrictEqual(job.documentContinuation, entry.descriptor)
      )
        refuse();
    }
    return structuredClone(entry.descriptor);
  }

  function entryFor(job: QueueJob) {
    const entry = jobs.get(job.id);
    if (
      !entry ||
      entry.jobId !== job.id ||
      job.hash !== entry.descriptor.requestHash ||
      continuationRequestHash(job.request) !== entry.descriptor.requestHash ||
      !isDeepStrictEqual(job.documentContinuation, entry.descriptor)
    )
      refuse();
    verify(entry);
    domain.assertDocumentContinuation(
      job.id,
      entry.programs.guarded.sourceHash,
    );
    return entry;
  }

  function readVerified(
    value: VerifiedContinuationCheckpoint,
    entry: Pick<Entry, "observation" | "descriptor">,
  ) {
    if (!value || typeof value.reverify !== "function") refuse();
    const checkpoint = decodeDocumentCheckpointReadback(
      value.checkpoint,
      entry.descriptor.target,
    );
    if (canonicalHash(checkpoint) !== entry.observation.stateDigest) refuse();
    // Retain our own decoded copy, not an externally mutable checkpoint object.
    return { checkpoint, reverify: value.reverify.bind(value) };
  }

  async function prepareSubmit(
    input: QueueRequest,
    principal: ContinuationActor,
  ): Promise<PreparedDocumentContinuationSubmission> {
    const request = structuredClone(input),
      actor = Object.freeze({ ...principal });
    if (
      request.clientId !== actor.clientId ||
      request.ownerToken !== actor.clientTokenHash
    )
      refuse();
    const invocation = boundedInvocation(request);
    const target = {
      creationId: invocation.docId,
      ...(invocation.docFileId === undefined
        ? {}
        : { fileId: invocation.docFileId }),
    };
    synchronous(() => ports.recheck(actor, target));
    const currentGeneration = generation();
    const fence = domain.documentInspectionFence(target, currentGeneration);
    const records = domain.data.documentCheckpoints;
    const acceptance =
      fence.priorCheckpointId && records?.acceptances[fence.priorCheckpointId];
    const selected =
      acceptance && records?.observations[acceptance.observationId];
    if (
      !acceptance ||
      !selected ||
      selected.actorClientId !== actor.clientId ||
      acceptance.actorClientId !== actor.clientId ||
      selected.generation !== currentGeneration ||
      acceptance.observationDigest !== canonicalHash(selected) ||
      !isDeepStrictEqual(selected.target, target)
    )
      refuse();
    const observation = structuredClone(selected);
    const verified = await ports.verifyObservation(observation, actor);
    const programs = compileDocumentContinuationPrograms(
      request,
      verified?.checkpoint,
    );
    if (programs.guardDigest !== observation.stateDigest) refuse();
    const descriptor: DocumentContinuation = {
      version: 1,
      actorClientId: actor.clientId,
      requestHash: programs.requestHash,
      target,
      generation: currentGeneration,
      observationId: observation.id,
      acceptanceId: acceptance.id,
      stateDigest: observation.stateDigest,
      blockersDigest: fence.blockersDigest,
      sourceHash: programs.guarded.sourceHash,
    };
    const entry: Entry = {
      actor,
      request,
      observation,
      programs,
      descriptor,
      verified: readVerified(verified, { observation, descriptor }),
    };
    let consumed = false;
    return Object.freeze({
      submit() {
        if (consumed) refuse();
        consumed = true;
        live.add(entry);
        try {
          // No await after the final complete source check through core submission.
          verify(entry);
          const authority = domain.createDocumentContinuationAuthority(() =>
            verify(entry),
          );
          const existing = new Set(Object.keys(domain.data.jobs));
          const result = domain.submitDocumentContinuation(request, authority);
          const id = result["id"];
          if (typeof id === "string" && !existing.has(id)) {
            const job = domain.data.jobs[id];
            if (
              job &&
              ["queued", "preparing", "processing"].includes(job.state) &&
              isDeepStrictEqual(job.documentContinuation, descriptor)
            ) {
              entry.jobId = id;
              jobs.set(id, entry);
              return result;
            }
          }
          // A repeated old request ID must never re-arm its retained marker/cap.
          live.delete(entry);
          return result;
        } catch (error) {
          live.delete(entry);
          throw error;
        }
      },
    });
  }

  return Object.freeze({
    prepareSubmit,
    async submit(input: QueueRequest, principal: ContinuationActor) {
      return (await prepareSubmit(input, principal)).submit();
    },

    async prepareWorker(
      job: QueueJob,
      call: { method: string; args: unknown[] },
      turn: TurnIdentity,
    ) {
      const entry = entryFor(job);
      if (turn.jobId !== job.id || usedTurns.has(turn)) refuse();
      usedTurns.add(turn);
      // Attempt order, not completion order, owns the next private turn.
      // Even a newer failed attempt invalidates older pending verification.
      const attempt = {};
      latestAttempt.set(job.id, attempt);
      activeTurn.delete(job.id);
      const ordinary = entry.programs.ordinary;
      const envelope = {
        featureType: "script",
        object: { script: ordinary.script, readOnly: false },
      };
      if (
        call.method !== "callTool" ||
        call.args.length !== 3 ||
        call.args[1] !== "fusion_mcp_execute" ||
        !isDeepStrictEqual(call.args[0], envelope) ||
        !isDeepStrictEqual(call.args[2], ordinary.manifest)
      )
        refuse();
      const proof = await ports.verifyObservation(
        structuredClone(entry.observation),
        entry.actor,
      );
      if (latestAttempt.get(job.id) !== attempt) refuse();
      entry.verified = readVerified(proof, entry);
      // Both native/source verification and authorization finish before issuing
      // the one turn-scoped guarded program. This is still not an SDK grant.
      entryFor(job);
      if (latestAttempt.get(job.id) !== attempt) refuse();
      turns.set(turn, { entry, verified: entry.verified });
      activeTurn.set(job.id, turn);
      return structuredClone(entry.programs.guarded);
    },

    expectedProduct(job: QueueJob, turn: TurnIdentity): ContinuationProgram {
      const entry = entryFor(job),
        prepared = turns.get(turn);
      if (
        turn.jobId !== job.id ||
        activeTurn.get(job.id) !== turn ||
        prepared?.entry !== entry ||
        prepared.verified !== entry.verified
      )
        refuse();
      synchronous(() => prepared.verified.reverify());
      return structuredClone(entry.programs.guarded);
    },

    forget(jobId: string, turn?: TurnIdentity): void {
      // A late finalizer from an earlier turn cannot revoke its successor.
      if (turn !== undefined && activeTurn.get(jobId) !== turn) return;
      const entry = jobs.get(jobId);
      if (entry) live.delete(entry);
      jobs.delete(jobId);
      activeTurn.delete(jobId);
      latestAttempt.delete(jobId);
    },
    prune(readStatus: (jobId: string) => { state: string } | undefined): void {
      for (const [id, entry] of jobs) {
        const status = readStatus(id);
        if (jobs.get(id) !== entry) continue;
        if (!status || ["succeeded", "failed", "cancelled", "expired", "needs_reconciliation"].includes(status.state)) {
          live.delete(entry);
          jobs.delete(id);
          activeTurn.delete(id);
          latestAttempt.delete(id);
        }
      }
    },
  });
}

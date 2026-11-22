import { isDeepStrictEqual } from "node:util";
import type {
  QueueDomain,
  DocumentObservation,
  DocumentInspection,
} from "@fmcad/core";
import { quarantineTargetConflicts } from "@fmcad/core";
import type {
  createDocumentUnlockAdmission,
  CurrentUnlockTarget,
  UnlockPrincipal,
  UnlockTargetSelector,
} from "./document-unlock-admission";
import {
  serializeDocumentUnlockError,
  serializeDocumentUnlockStatus,
  type DocumentUnlockMcpRequest,
  type DocumentUnlockServerResolution,
} from "./document-unlock-diagnostics";

interface CompletedInspection {
  id: string;
  stateDigest: string;
  createdAt: number;
  readback: DocumentObservation["readback"];
}
export interface DocumentUnlockControllerPorts {
  domain: QueueDomain;
  admission: ReturnType<typeof createDocumentUnlockAdmission>;
  generation(): string;
  /** Current, source-verified identity. Never an active-tab or inventory guess. */
  probeIdentity(
    actor: UnlockPrincipal,
    selector: UnlockTargetSelector,
  ): Promise<CurrentUnlockTarget>;
  /** Submit the exact server-authored read with this marker; persist original
   * RPC/source/receipt artifacts before returning the readback reference. */
  inspect(
    actor: UnlockPrincipal,
    requestId: string,
    target: CurrentUnlockTarget,
    marker: DocumentInspection,
  ): Promise<CompletedInspection>;
  /** Required actual producer verifier, also on cached reads and acceptance.
   * Hash equality or an unauthenticated response is not sufficient. */
  verifyObservation(
    observation: DocumentObservation,
    target: CurrentUnlockTarget,
  ): void | Promise<void>;
  /** Authorize/filter all metadata before constructing the public DTO. */
  resolution(
    actor: UnlockPrincipal,
    selector: UnlockTargetSelector,
    observation?: DocumentObservation,
  ): Parameters<typeof serializeDocumentUnlockStatus>[0];
}
function refused(code: string): never {
  throw Object.assign(new Error("Document unlock request was refused"), {
    code,
  });
}
function targetFor(value: CurrentUnlockTarget) {
  return {
    creationId: value.creationId,
    ...(value.fileId ? { fileId: value.fileId } : {}),
  };
}
function sameTarget(
  observation: DocumentObservation,
  target: CurrentUnlockTarget,
) {
  return (
    observation.target.creationId === target.creationId &&
    (observation.target.fileId === undefined ||
      observation.target.fileId === target.fileId)
  );
}

/** Authenticated broker control plane, not a new queue or a recovery settlement.
 * The IPC boundary must first use the shared strict request decoder.
 */
export function createDocumentUnlockController(
  ports: DocumentUnlockControllerPorts,
) {
  const inFlight = new Map<
    string,
    { request: DocumentUnlockMcpRequest; result: Promise<unknown> }
  >();

  async function execute(
    request: DocumentUnlockMcpRequest,
    actor: UnlockPrincipal,
  ) {
    // Even identity lookup needs current namespace metadata authorization.
    const metadata = ports.admission.authorizeStatus(actor, request.target);
    if (request.action === "status") {
      metadata.recheck();
      return serializeDocumentUnlockStatus(
        ports.resolution(actor, metadata.selector),
      );
    }
    ports.domain.assertDocumentProbeAllowed();
    ports.domain.rememberDocumentUnlockRequest(actor.clientId, request);
    const records = ports.domain.data.documentCheckpoints;
    const acceptance = Object.values(records?.acceptances ?? {}).find(
      (value) =>
        value.actorClientId === actor.clientId &&
        value.requestId === request.requestId,
    );
    const prior = Object.values(records?.observations ?? {}).find(
      (value) =>
        value.actorClientId === actor.clientId &&
        value.requestId === request.requestId,
    );
    if (
      (request.action === "inspect" && acceptance) ||
      (request.action === "accept" && prior) ||
      (acceptance &&
        request.action === "accept" &&
        acceptance.observationId !== request.observationId)
    )
      refused("REQUEST_CONFLICT");
    const selected =
      request.action === "accept"
        ? records?.observations[request.observationId]
        : prior;
    if (
      request.action === "accept" &&
      (!selected || selected.actorClientId !== actor.clientId)
    )
      refused("NOT_AUTHORIZED");

    const ticket = ports.admission.beginProbe(metadata.selector);
    metadata.recheck();
    const observed = await ports.probeIdentity(actor, metadata.selector);
    const target = ports.admission.confirmTarget(ticket, observed);
    const permission = ports.admission.authorize(actor, request.action, target);
    permission.recheck();
    if (
      selected &&
      (!sameTarget(selected, target) ||
        selected.generation !== ports.generation())
    )
      refused(
        request.action === "inspect"
          ? "REQUEST_CONFLICT"
          : "DOCUMENT_STATE_CHANGED",
      );
    if (selected) {
      await ports.verifyObservation(selected, target);
      permission.recheck();
      if (request.action === "accept") {
        ports.domain.acceptDocumentObservation({
          observationId: selected.id,
          requestId: request.requestId,
          actorClientId: actor.clientId,
          generation: ports.generation(),
          observedStateDigest: selected.stateDigest,
        });
      }
      return serializeDocumentUnlockStatus(
        ports.resolution(actor, request.target, selected),
      );
    }

    const marker = ports.domain.documentInspectionFence(
      targetFor(target),
      ports.generation(),
    );
    const blockers = quarantineTargetConflicts(
      ports.domain.data,
      marker.target,
    ).map((value) => ({
      jobId: value.jobId,
      requestId: value.requestId,
      originalHash: value.jobHash,
      catalogDigest: value.catalogDigest,
      barrierRef: value.evidenceReference,
    }));
    const read = await ports.inspect(actor, request.requestId, target, marker);
    permission.recheck();
    const observation: DocumentObservation = {
      version: 1,
      id: read.id,
      requestId: request.requestId,
      actorClientId: actor.clientId,
      target: marker.target,
      generation: marker.generation,
      scope: "parameters",
      stateDigest: read.stateDigest,
      readback: read.readback,
      blockers,
      priorCheckpointId: marker.priorCheckpointId,
      createdAt: read.createdAt,
    };
    await ports.verifyObservation(observation, target);
    permission.recheck();
    const stored = ports.domain.recordDocumentObservation(observation);
    return serializeDocumentUnlockStatus(
      ports.resolution(actor, request.target, stored),
    );
  }
  return Object.freeze({
    async handle(
      request: DocumentUnlockMcpRequest,
      principal: UnlockPrincipal,
    ) {
      // Freeze copies before any await; external mutation cannot replace actor
      // or target while a private lookup or inspection is running.
      const command = Object.freeze({
        ...structuredClone(request),
        target: Object.freeze({ ...request.target }),
      });
      const actor = Object.freeze({ ...principal });
      try {
        const key =
          request.action === "status"
            ? null
            : JSON.stringify([
                actor.clientId,
                actor.clientTokenHash,
                request.requestId,
              ]);
        const pending = key === null ? undefined : inFlight.get(key);
        if (pending) {
          if (!isDeepStrictEqual(pending.request, command))
            refused("REQUEST_CONFLICT");
          return await pending.result;
        }
        const result = execute(command, actor);
        if (key !== null) inFlight.set(key, { request: command, result });
        try {
          return await result;
        } finally {
          if (key !== null && inFlight.get(key)?.result === result)
            inFlight.delete(key);
        }
      } catch (error) {
        let resolution: DocumentUnlockServerResolution = {};
        try {
          ports.admission.authorizeStatus(actor, command.target).recheck();
          resolution = ports.resolution(actor, command.target);
        } catch {
          // A revoked principal must not see metadata saved before the await.
        }
        let code =
          error &&
          typeof error === "object" &&
          "code" in error &&
          typeof error.code === "string"
            ? error.code
            : "DOCUMENT_UNLOCK_ERROR";
        if (
          [
            "DOCUMENT_UNLOCK_NOT_AUTHENTICATED",
            "DOCUMENT_UNLOCK_FROZEN_SCOPE",
            "EPOCH_SCOPE_REQUIRED",
            "NOT_AUTHENTICATED",
            "NOT_OWNER",
          ].includes(code)
        )
          code = "NOT_AUTHORIZED";
        if (code === "DOCUMENT_UNLOCK_STALE") code = "DOCUMENT_STATE_CHANGED";
        return serializeDocumentUnlockError({
          ...resolution,
          code,
          ...(command.action === "status"
            ? {}
            : { currentRequestId: command.requestId }),
        });
      }
    },
  });
}

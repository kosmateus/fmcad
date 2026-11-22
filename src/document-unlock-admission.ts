import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import type { epochAdmission } from "./queue-isolated-epoch";
import type * as CadService from "./composition/cad-service";

const load = createRequire(__filename);
type EpochState = Parameters<typeof epochAdmission>[0];
export interface UnlockTargetSelector {
  readonly docId?: string;
  readonly docFileId?: string;
}
/** Supplied only by the broker's current document probe, never request JSON. */
export interface CurrentUnlockTarget {
  readonly complete: true;
  readonly name: string;
  readonly creationId: string;
  readonly fileId?: string | null;
  readonly version?: number;
  readonly fingerprint: string;
}
export interface UnlockAdmissionContext {
  readonly state: EpochState;
  readonly clients: Readonly<Record<string, string>>;
  readonly generation: string;
  readonly scope: "ordinary" | "frozen-metadata";
}
export interface UnlockPrincipal {
  readonly clientId: string;
  readonly clientTokenHash: string;
}
declare const confirmed: unique symbol;
export interface ConfirmedUnlockTarget extends CurrentUnlockTarget {
  readonly [confirmed]: true;
}
function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Private broker adapter. No SDK calls, grants, jobs, settlement or admin rights.
 * The composition supplies live state and the authenticated IPC principal.
 * Confirm only an identity obtained from a current probe of the exact selector.
 */
export function createDocumentUnlockAdmission(
  current: () => UnlockAdmissionContext,
) {
  const proofs = new WeakMap<
    ConfirmedUnlockTarget,
    {
      generation: string;
      epoch: string | null;
      control: number;
      context: number;
    }
  >();
  function binding(context: UnlockAdmissionContext) {
    if (!text(context.generation) || context.generation.length > 256)
      fail(
        "DOCUMENT_UNLOCK_GENERATION_REQUIRED",
        "Current generation is required",
      );
    return {
      generation: context.generation,
      epoch: context.state.epoch?.epochId ?? null,
      control: context.state.data.controlGeneration ?? 0,
      context: context.state.data.contextEpoch ?? 0,
    };
  }
  function confirmTarget(
    selector: UnlockTargetSelector,
    observed: CurrentUnlockTarget,
  ): ConfirmedUnlockTarget {
    if (
      Object.keys(selector).some(
        (key) => !["docId", "docFileId"].includes(key),
      ) ||
      (!text(selector.docId) && !text(selector.docFileId)) ||
      (selector.docId !== undefined && !text(selector.docId)) ||
      (selector.docFileId !== undefined && !text(selector.docFileId)) ||
      observed.complete !== true ||
      !text(observed.creationId) ||
      !text(observed.name) ||
      !text(observed.fingerprint) ||
      (observed.fileId != null && !text(observed.fileId)) ||
      (observed.version !== undefined &&
        (!Number.isSafeInteger(observed.version) || observed.version < 0)) ||
      (selector.docId !== undefined &&
        selector.docId !== observed.creationId) ||
      (selector.docFileId !== undefined &&
        selector.docFileId !== observed.fileId)
    )
      fail(
        "DOCUMENT_UNLOCK_TARGET_UNPROVEN",
        "Both exact document pins must agree with a complete current probe",
      );
    const proof = Object.freeze({
      complete: true as const,
      name: observed.name,
      creationId: observed.creationId,
      fileId: observed.fileId ?? null,
      ...(observed.version === undefined ? {} : { version: observed.version }),
      fingerprint: observed.fingerprint,
    }) as ConfirmedUnlockTarget;
    proofs.set(proof, binding(current()));
    return proof;
  }
  function authorize(
    principal: UnlockPrincipal,
    action: "status" | "inspect" | "accept",
    target: ConfirmedUnlockTarget,
  ) {
    const original = proofs.get(target);
    if (!original)
      fail(
        "DOCUMENT_UNLOCK_TARGET_UNPROVEN",
        "A broker-confirmed target is required",
      );
    // Copy the trusted principal; subsequent caller mutation cannot change actor.
    const actor = { ...principal };
    function recheck() {
      const context = current();
      if (!isDeepStrictEqual(binding(context), original))
        fail(
          "DOCUMENT_UNLOCK_STALE",
          "The current generation or epoch changed",
        );
      if (context.scope !== "ordinary")
        fail(
          "DOCUMENT_UNLOCK_FROZEN_SCOPE",
          "Scoped metadata qualification does not authorize document unlocking",
        );
      if (
        !text(actor.clientId) ||
        !text(actor.clientTokenHash) ||
        !Object.hasOwn(context.clients, actor.clientId) ||
        context.clients[actor.clientId] !== actor.clientTokenHash
      )
        fail(
          "DOCUMENT_UNLOCK_NOT_AUTHENTICATED",
          "Current IPC principal is required",
        );
      if (!["status", "inspect", "accept"].includes(action))
        fail("INVALID_REQUEST", "Unknown document unlock action");
      const service = load("./cad-service") as typeof CadService;
      // Capability checks use an actual, fixed typed policy request, not a
      // caller's claimed readOnly flag. This request is never submitted/executed.
      const payload = service.decodeInvocation({
        version: 1,
        kind: "cad",
        operation: action === "accept" ? "sketch.create" : "document.status",
        doc: target.name,
        docId: target.creationId,
        ...(target.fileId ? { docFileId: target.fileId } : {}),
        data:
          action === "accept" ? { name: "unlock-admission", plane: "XY" } : {},
      });
      const request: Parameters<typeof epochAdmission>[1] = {
        kind: "command",
        clientId: actor.clientId,
        requestId: "document-unlock-admission",
        timeoutMs: 1,
        argv: service.policyArguments(payload),
        payload: { ...payload },
      };
      (
        load("./queue-isolated-epoch") as {
          epochAdmission: typeof epochAdmission;
        }
      ).epochAdmission(context.state, request, { ...context.clients });
    }
    recheck();
    // No job/result/token or historical author identity crosses this boundary.
    return Object.freeze({ target, recheck });
  }
  return Object.freeze({ confirmTarget, authorize });
}

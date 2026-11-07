import { validateBrokerFence } from "@fmcad/core";
import type { BrokerControlFence } from "@fmcad/core";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { durable, readJson } from "../persistence/records";

interface ControlGate {
  adminTransition: string | null;
  buildHash?: string;
  controlCapabilities?: Record<string, boolean>;
  snapshot(): {
    generation: number;
    instanceId: string;
    activeOperations: number;
    unresolved: boolean;
  };
  control(
    paused: boolean,
    fence: BrokerControlFence,
    check?: () => Promise<unknown>,
  ): Promise<unknown>;
}

interface AdminPort {
  accepts(action: string): boolean;
  handle(message: LifecycleMessage, clientId: string): Promise<unknown>;
}

export interface LifecycleMessage {
  action: string;
  control?: BrokerControlFence;
  /** Single-use owner token for restoring this reset's exact confirmed pause. */
  resetOwnerNonce?: string;
}

function deny(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

/** Install only after authentication in the one production broker dispatcher. */
export function createLifecycleDispatcher({
  gate,
  admin,
  dir,
  buildHash,
  canResume,
  authorizeResetResume,
  resumeCheck,
  diagnostics,
}: {
  gate: ControlGate;
  admin: AdminPort;
  dir: string;
  buildHash: string;
  canResume(): void;
  authorizeResetResume?(
    nonce: string | undefined,
    clientId: string,
    fence: BrokerControlFence,
  ): unknown;
  resumeCheck(authorization?: unknown): Promise<unknown>;
  diagnostics(): void;
}) {
  gate.buildHash = buildHash;
  gate.controlCapabilities = {
    inspect: true,
    pause: true,
    drain: true,
    resume: true,
    stop: true,
    reload: true,
    restart: true,
    // Starting an absent process and resetting Fusion are local explicit use
    // cases, not endpoints of a running broker. Do not advertise dead RPCs.
    start: false,
    reset: false,
  };
  return {
    accepts(action: string) {
      return (
        admin.accepts(action) || ["pause", "drain", "resume"].includes(action)
      );
    },
    async handle(message: LifecycleMessage, clientId: string) {
      if (
        message.resetOwnerNonce !== undefined &&
        (message.action !== "resume" ||
          typeof message.resetOwnerNonce !== "string" ||
          message.resetOwnerNonce.length === 0)
      )
        deny(
          "INVALID_REQUEST",
          "Reset-owner authorization is available only for a fenced resume",
        );
      if (admin.accepts(message.action)) return admin.handle(message, clientId);
      if (!["pause", "drain", "resume"].includes(message.action))
        deny("INVALID_ACTION", "Unknown lifecycle action");
      const fence = message.control;
      if (!fence) deny("INVALID_REQUEST", "Control fence is required");
      validateBrokerFence(fence);
      const current = gate.snapshot();
      if (current.instanceId !== fence.instanceId)
        deny("INSTANCE_CHANGED", "Read the current broker instance");
      const binding = {
        action: message.action,
        clientId,
        ...fence,
        ...(message.resetOwnerNonce === undefined
          ? {}
          : {
              resetOwnerNonceHash: createHash("sha256")
                .update(message.resetOwnerNonce)
                .digest("hex"),
            }),
        buildHash,
      };
      const file = join(
        dir,
        "lifecycle-control-" +
          createHash("sha256").update(fence.requestId).digest("hex") +
          ".json",
      );
      let prior: unknown;
      try {
        prior = readJson(file);
      } catch (error) {
        if (
          !error ||
          typeof error !== "object" ||
          !("code" in error) ||
          error.code !== "ENOENT"
        )
          throw error;
      }
      if (prior !== undefined) {
        if (
          !prior ||
          typeof prior !== "object" ||
          !("binding" in prior) ||
          JSON.stringify(prior.binding) !== JSON.stringify(binding)
        )
          deny(
            "REQUEST_CONFLICT",
            "Request ID already belongs to a different control intent",
          );
        if ("result" in prior) return prior.result;
        // A prepared/failed resume may already have sent a physical probe.
        // Never call gate.control again. Only original receipt inspection is safe.
        deny(
          "REQUEST_PENDING",
          "Observe the original control receipt; the action will not be replayed",
        );
      }
      if (message.resetOwnerNonce !== undefined && !authorizeResetResume)
        deny(
          "FUSION_RESET_IN_PROGRESS",
          "Reset-owner authorization is unavailable; the reset fence remains closed",
        );
      const resetAuthorization =
        message.action !== "resume"
          ? undefined
          : authorizeResetResume?.(message.resetOwnerNonce, clientId, fence);
      if (
        message.resetOwnerNonce !== undefined &&
        resetAuthorization === undefined
      )
        deny(
          "FUSION_RESET_IN_PROGRESS",
          "Reset-owner authorization is unavailable; the reset fence remains closed",
        );
      if (current.generation !== fence.expectedGeneration)
        deny("STATE_CONFLICT", "Read the current broker control generation");
      durable(file, { binding, status: "prepared" }, true);
      try {
        if (message.action === "resume") canResume();
        const result = await gate.control(
          message.action !== "resume",
          fence,
          () => resumeCheck(resetAuthorization),
        );
        durable(file, { binding, status: "completed", result });
        diagnostics();
        // Drain reports PAUSING until physical work really settles. No cancel.
        return result;
      } catch (error) {
        try {
          durable(file, { binding, status: "unresolved" });
        } catch {
          /* Prepared intent remains a no-replay fence. */
        }
        throw error;
      }
    },
  };
}

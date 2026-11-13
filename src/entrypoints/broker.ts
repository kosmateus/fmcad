import { createRequire } from "node:module";
import type { FmcadConfiguration } from "../api";

const runtimeRequire = createRequire(__filename);

export interface BrokerCompositionOptions {
  readonly backendTransition?: import("../queue-backend-transition").BackendTransitionApproval;
  readonly confirmOwnership: boolean;
  readonly confirmVersionTransition?: boolean;
  readonly stateOptions?: {
    readonly idleMs?: number;
    readonly leaseMs?: number;
    readonly maxQueued?: number;
    readonly maxPerClient?: number;
  };
  readonly autoReconcile?: boolean;
  readonly startPaused?: boolean;
  readonly fusionResetNonce?: string;
}

export interface BrokerHandle {
  readonly socket: string;
  readonly buildHash: string;
  close(): Promise<void>;
}

interface BrokerRuntime {
  serve(
    config: FmcadConfiguration,
    options: BrokerCompositionOptions,
  ): Promise<BrokerHandle>;
  reclaim(directory: string): unknown;
}

function brokerRuntime(): BrokerRuntime {
  return runtimeRequire("../../queue-broker.js") as BrokerRuntime;
}

/** Select the one shared broker runtime and normalize its queue config. */
export function serveBroker(
  config: FmcadConfiguration,
  options: BrokerCompositionOptions,
): Promise<BrokerHandle> {
  return brokerRuntime().serve(
    { ...config, routing: "queue", queue: {} },
    options,
  );
}

/** Existing-owner cleanup; never starts a broker or Fusion process. */
export function reclaimBroker(directory: string): unknown {
  return brokerRuntime().reclaim(directory);
}

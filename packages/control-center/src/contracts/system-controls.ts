import type { BrokerControlSnapshot, BrokerControlFence } from "@fmcad/core";
import type { ConsoleQueryScope } from "./query.js";

export const SYSTEM_CONTROLS_API_VERSION = 1 as const;

export type SystemControlAction = "pause" | "drain" | "resume" | "start";

export interface SystemControlCapabilities {
  readonly pause: boolean;
  readonly drain: boolean;
  readonly resume: boolean;
  readonly start: boolean;
}

export interface SystemControlStatus {
  readonly version: typeof SYSTEM_CONTROLS_API_VERSION;
  readonly requestedScope: ConsoleQueryScope;
  /** All control actions affect the one shared broker. */
  readonly effectiveScope: { readonly kind: "global" };
  readonly state: "available" | "unavailable";
  readonly observedAt: number | null;
  readonly snapshot: BrokerControlSnapshot | null;
  readonly capabilities: SystemControlCapabilities;
  readonly reason?: string;
}

export interface SystemControlCommand extends BrokerControlFence {
  readonly version: typeof SYSTEM_CONTROLS_API_VERSION;
  readonly scope: ConsoleQueryScope;
  readonly action: SystemControlAction;
}

export interface SystemControlReceipt {
  readonly version: typeof SYSTEM_CONTROLS_API_VERSION;
  readonly requestedScope: ConsoleQueryScope;
  readonly effectiveScope: { readonly kind: "global" };
  readonly requestId: string;
  readonly action: SystemControlAction;
  readonly instanceId: string;
  readonly expectedGeneration: number;
  readonly state: "confirmed" | "accepted" | "pending" | "unknown" | "conflict";
  readonly snapshot: BrokerControlSnapshot | null;
  readonly code?: string;
  readonly reason?: string;
}

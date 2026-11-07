import type {
  FmcadServices,
  FmcadOptions,
  CatalogServices,
} from "../../../../src/api/contracts";

export interface Presence {
  touch(sessionID: string, data?: Record<string, unknown>): void;
  event(event: unknown): void;
  close(): Promise<void>;
}
/** The composition root owns service construction; adapters only map the host. */
export interface Dependencies {
  catalog: CatalogServices;
  create(options: FmcadOptions): FmcadServices;
  /** Optional loopback web service; called only from a selected plugin setup. */
  ensureWeb?(): Promise<void>;
  /** Safe diagnostics only; web startup failure never changes CAD results. */
  diagnostic?(message: string): void;
  config(
    directory: string,
    options: Record<string, unknown>,
  ): FmcadOptions["config"];
  presence(directory: string): Presence | null;
  clientID(sessionID: string, agent: string): string;
  requestID(): string;
  instanceID: string;
}
export interface Invocation {
  projectId?: string;
  sessionID: string;
  agent: string;
  directory: string;
  signal: AbortSignal;
  authorize(resource: string, metadata: Record<string, unknown>): Promise<void>;
}

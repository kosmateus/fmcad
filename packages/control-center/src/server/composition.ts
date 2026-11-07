import type {
  ConsoleQueryHandler,
  ConsoleQueryPrincipal,
  ConsoleRevisionEvent,
  ConsoleRevisionListener,
} from "../contracts/index.js";
import { createConsoleQueryApi } from "./query-api.js";
import type {
  ConsoleQueryApiOptions,
  ConsoleQueryReadPort,
} from "./query/port.js";
import {
  CONTROL_CENTER_PROTOCOL_VERSION,
  ConsoleHttpError,
} from "./protocol.js";
import type { ConsoleHttpAsset, ConsoleHttpSession } from "./protocol.js";
import type { ProjectActionsExecutor } from "./project-actions.js";

export interface ControlCenterCompositionContext {
  readonly port: number;
  readonly installationRoot: string;
  readonly stateDirectory: string;
  readonly buildIdentity: string;
  readonly protocolVersion: typeof CONTROL_CENTER_PROTOCOL_VERSION;
  readonly instanceNonce: string;
}

export interface ControlCenterComposition {
  readonly query: ConsoleQueryHandler;
  readonly projectActions?: ProjectActionsExecutor | null;
  readonly resolvePrincipal: (
    session: ConsoleHttpSession,
  ) => ConsoleQueryPrincipal | Promise<ConsoleQueryPrincipal>;
  readonly assets?: readonly ConsoleHttpAsset[];
  readonly close?: () => void | Promise<void>;
}

export interface ControlCenterCompositionDependencies {
  /** Null keeps the process online but exposes explicit unavailable query results. */
  readonly readPort: ConsoleQueryReadPort | null;
  readonly projectActions?: ProjectActionsExecutor | null;
  readonly resolvePrincipal?: (
    session: ConsoleHttpSession,
  ) => ConsoleQueryPrincipal | Promise<ConsoleQueryPrincipal>;
  readonly subscribeRevisions?: (
    listener: (event: ConsoleRevisionEvent) => void,
  ) => (() => void) | null;
  readonly assets?: readonly ConsoleHttpAsset[];
  readonly queryOptions?: ConsoleQueryApiOptions;
  readonly close?: () => void | Promise<void>;
}

export interface ControlCenterCompositionModule {
  createControlCenterComposition(
    context: ControlCenterCompositionContext,
  ): ControlCenterComposition | Promise<ControlCenterComposition>;
}

const unavailableReadPort: ConsoleQueryReadPort = {
  async readSnapshot() {
    throw new Error("Control Center read model is unavailable");
  },
  async readArtifact() {
    throw new Error("Control Center artifact reader is unavailable");
  },
};

/** Joins injected, already-authorized read sources without polling or SDK work. */
export function composeControlCenterService(
  dependencies: ControlCenterCompositionDependencies,
): ControlCenterComposition {
  const queryApi = createConsoleQueryApi(
    dependencies.readPort ?? unavailableReadPort,
    dependencies.queryOptions,
  );
  const stopRevisionSource = dependencies.subscribeRevisions?.((event) =>
    queryApi.invalidate(event),
  );
  let closed = false;
  const query: ConsoleQueryHandler = {
    snapshot: (scope, principal) => queryApi.snapshot(scope, principal),
    query: (request, principal) => queryApi.query(request, principal),
    export: (request, principal) => queryApi.export(request, principal),
    detail: (request, principal) => queryApi.detail(request, principal),
    subscribe: (scope, after, principal, listener: ConsoleRevisionListener) =>
      stopRevisionSource
        ? queryApi.subscribe(scope, after, principal, listener)
        : null,
  };
  return {
    query,
    ...(dependencies.projectActions !== undefined
      ? { projectActions: dependencies.projectActions }
      : {}),
    resolvePrincipal:
      dependencies.resolvePrincipal ??
      (() => {
        throw new ConsoleHttpError(
          503,
          "PRINCIPAL_UNAVAILABLE",
          "Console project registry is unavailable",
        );
      }),
    ...(dependencies.assets ? { assets: dependencies.assets } : {}),
    async close() {
      if (closed) return;
      closed = true;
      try {
        stopRevisionSource?.();
      } finally {
        await dependencies.close?.();
      }
    },
  };
}

/** Builds the private process entry module from installed typed dependencies. */
export function createControlCenterCompositionModule(
  loadDependencies: (
    context: ControlCenterCompositionContext,
  ) =>
    | ControlCenterCompositionDependencies
    | Promise<ControlCenterCompositionDependencies>,
): ControlCenterCompositionModule {
  return {
    async createControlCenterComposition(context) {
      return composeControlCenterService(await loadDependencies(context));
    },
  };
}

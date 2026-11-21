import { createRequire } from "node:module";
import type {
  CadContext,
  CadData,
  CadOutput,
  OperationContract,
  OperationDeclaration,
} from "@fmcad/core";
import type { NativeActionClient } from "../../packages/node-adapters/src/python/native-actions.js";
import type { PythonArtifactManifest } from "../../packages/core/src/domain/python-artifact.js";

const load = createRequire(__filename);
const core = load(
  "../core/application/cad/index.js",
) as typeof import("../../packages/core/src/application/cad/index.js");
const preparation = load("./cad.js") as typeof import("./cad.js");
const native = load(
  "../python/native-actions.js",
) as typeof import("../../packages/node-adapters/src/python/native-actions.js");
type Result = CadOutput | Promise<CadOutput>;
type Catalog = Record<string, OperationDeclaration>;
export interface CadClient extends NativeActionClient {
  capabilities?: { backend?: unknown; brokerSdkProbePort?: unknown };
  server?: { timeoutMs?: number; backend?: unknown };
  brokerSdkProbePort?: unknown;
  callTool(
    request: Parameters<NativeActionClient["callTool"]>[0],
    tool?: string,
    manifest?: PythonArtifactManifest,
  ): ReturnType<NativeActionClient["callTool"]>;
}
type Client = CadClient | null | undefined;
export interface CadInternal {
  projectDirectory?: string;
  fusionPath?: (value: unknown) => string;
  stageDependencies?: {
    batch?: unknown;
    owner?: { scope?: { project?: string } };
    document?: { stages?: unknown };
  };
}
type Execute = (
  client: Client,
  operation: string,
  data: CadData,
  context: CadContext,
  internal?: CadInternal,
) => Promise<CadOutput>;
type LocalService = { execute(operation: string, data: CadData): Result };
const catalogModule = load("../../catalog/index.js") as {
  catalog: Catalog;
  contracts: Record<string, OperationContract>;
  validateCad(operation: string, data: CadData): OperationDeclaration;
  executeCapability(
    operation: string,
    data: CadData,
    context?: CadContext,
    ports?: { backend: unknown; brokerSdkProbePort: unknown },
  ): Result;
};
export const { catalog, validateCad } = catalogModule;
const batch = load("../../batch.js") as {
  runBatchEntry(
    client: Client,
    data: CadData,
    context: CadContext,
    execute: Execute,
    catalog: Catalog,
    stages?: unknown,
  ): Result;
  definitionInstantiate(
    client: Client,
    data: CadData,
    context: CadContext,
    execute: Execute,
    catalog: Catalog,
    stages?: unknown,
  ): Result;
  definitionInspect(
    data: CadData,
    catalog: Catalog,
    operation: string,
  ): CadOutput;
  readBatchSummary(data: CadData): Result;
};
const dataImport = load("../../data-import.js") as {
  isOffline(operation: string, data: CadData): boolean;
  prepare(operation: string, data: CadData): CadData;
  offlineResult(prepared: CadData, preview: boolean): CadOutput;
};
const curve = load("../../curve.js") as {
  prepare(operation: string, data: CadData): CadData;
};
const sketch = load("../../sketch.js") as {
  validates(operation: string): boolean;
};
const ui = load("../../ui.js") as {
  execute(
    client: Client,
    operation: string,
    data: CadData,
    context: CadContext,
  ): Result;
  validate(operation: string, data: CadData): void;
  armWatcher(client: Client, data: CadData): Result;
};
const failedOutcome = (
  load("../../outcome.js") as { failedOutcome(value: unknown): boolean }
).failedOutcome;
const python = load("../../python.js") as {
  pythonArtifactManifest: typeof import("../../packages/node-adapters/src/python/context-binding.js").pythonArtifactManifest;
};
const localServices: Record<string, LocalService> = Object.fromEntries(
  ["reference", "drawing-package", "drawing-check", "drawing-export"].map(
    (name) => [name, load("../../" + name + ".js") as LocalService],
  ),
);

export const executeCad: Execute = async (
  client,
  operation,
  data,
  context,
  internal = {},
) =>
  core.executeCad(operation, data, context, {
    validate: validateCad,
    prepare: (operation, data, context) =>
      preparation.prepareCadScript(
        operation,
        data,
        context,
        internal.fusionPath,
      ),
    execution: {
      execute: ({ artifact, readOnly }) =>
        client!.callTool(
          {
            featureType: "script",
            object: { script: artifact.script, readOnly },
          },
          "fusion_mcp_execute",
          python.pythonArtifactManifest(artifact),
        ),
    },
    dispatch: (operation, data, context, entry) => {
      const executeWithInternal: Execute = (
        targetClient,
        operation,
        data,
        context,
      ) => executeCad(targetClient, operation, data, context, internal);
      return core.dispatchCad(operation, data, context, entry, {
        curve: curve.prepare,
        importOffline: dataImport.isOffline,
        importResult: (operation, data, preview) =>
          dataImport.offlineResult(
            dataImport.prepare(operation, data),
            preview,
          ),
        definitionInspect: (operation, data) =>
          batch.definitionInspect(data, catalog, operation),
        definitionInstantiate: (data, context) =>
          batch.definitionInstantiate(
            client,
            data,
            context,
            executeWithInternal,
            catalog,
            internal.stageDependencies?.batch,
          ),
        batch: (data, context) =>
          batch.runBatchEntry(
            client,
            data,
            context,
            executeWithInternal,
            catalog,
            internal.stageDependencies?.batch,
          ),
        node: (operation, data, context) =>
          executeNode(client, operation, data, context, internal),
      });
    },
    sketchValidates: sketch.validates,
    failed: failedOutcome,
  });

function executeNode(
  client: Client,
  operation: string,
  data: CadData,
  context: CadContext,
  internal: CadInternal,
): Result | undefined {
  const handler = catalogModule.contracts[operation]!.service.handler;
  const projectDirectory =
    internal.projectDirectory ||
    internal.stageDependencies?.owner?.scope?.project;
  if (handler === "brep-baseline") {
    const service = load("../../brep-baseline.js") as {
      execute(
        client: Client,
        operation: string,
        data: CadData,
        context: CadContext,
        ports: {
          projectDirectory: string | undefined;
          stageDependencies: CadInternal["stageDependencies"];
          executeNative(
            action: string,
            payload: CadData,
            context: CadContext,
          ): Promise<CadOutput>;
          toFusionPath(value: unknown): string;
        },
      ): Result;
    };
    return service.execute(client, operation, data, context, {
      projectDirectory,
      stageDependencies: internal.stageDependencies,
      executeNative: (action, payload, target) =>
        executeCad(
          client,
          `measure.baseline.${action}_internal`,
          payload,
          target,
          internal,
        ),
      toFusionPath: internal.fusionPath ?? preparation.fusionPath,
    });
  }
  if (handler === "selection-rules") {
    const service = load("../../selection-rules.js") as {
      execute(
        client: Client,
        operation: string,
        data: CadData,
        context: CadContext,
        ports: {
          projectDirectory: string | undefined;
          stageDependencies: CadInternal["stageDependencies"];
          executeNative(
            operation: string,
            payload: CadData,
            context: CadContext,
          ): Promise<CadOutput>;
        },
      ): Result;
    };
    return service.execute(client, operation, data, context, {
      projectDirectory,
      stageDependencies: internal.stageDependencies,
      executeNative: (operation, payload, target) =>
        executeCad(client, operation, payload, target, internal),
    });
  }
  if (handler === "capabilities")
    return operation === "capabilities.inspect"
      ? catalogModule.executeCapability(operation, data)
      : catalogModule.executeCapability(operation, data, context, {
          backend: client?.capabilities?.backend ?? client?.server?.backend,
          brokerSdkProbePort:
            client?.brokerSdkProbePort ??
            client?.capabilities?.brokerSdkProbePort,
        });
  if (handler === "ui") return ui.execute(client, operation, data, context);
  if (handler === "document-publication") {
    const service = load("../../document-publication.js") as {
      execute(
        client: Client,
        operation: string,
        data: CadData,
        context: CadContext,
        execute: Execute,
        deps: { stages: unknown },
      ): Result;
    };
    return service.execute(client, operation, data, context, executeCad, {
      stages: internal.stageDependencies?.document?.stages,
    });
  }
  if (handler === "externalization") {
    const service = load("../../externalization.js") as {
      execute(
        client: Client,
        data: CadData,
        context: CadContext,
        ports: {
          step(
            action: string,
            payload: CadData,
            readOnly?: boolean,
          ): Promise<CadOutput>;
          refresh(request: CadData): Promise<CadOutput>;
        },
      ): Result;
    };
    return service.execute(client, data, context, {
      step: (action, payload, readOnly) =>
        native.executeExternalizationAction(client, action, payload, readOnly),
      refresh: (request) =>
        executeCad(client, "references.refresh", request, {}),
    });
  }
  if (handler === "references-refresh") {
    const service = load("../../references-refresh.js") as {
      execute(
        client: Client,
        data: CadData,
        context: CadContext,
        ports: {
          step(
            action: string,
            payload: CadData,
            input: { lifecycle?: string },
            target?: CadContext,
          ): Promise<CadOutput>;
          inspectUi(
            client: Client,
            request: CadData,
            context: CadContext,
          ): Result;
          armWatcher(client: Client, request: CadData): Result;
          backend: unknown;
        },
      ): Result;
    };
    return service.execute(client, data, context, {
      step: (action, payload, input) =>
        native.executeReferencesAction(client, action, payload, input),
      inspectUi(targetClient, request, targetContext) {
        ui.validate("ui.inspect", request);
        return ui.execute(targetClient, "ui.inspect", request, targetContext);
      },
      armWatcher: (targetClient, request) =>
        ui.armWatcher(targetClient, request),
      backend: client?.capabilities?.backend ?? null,
    });
  }
  const local = localServices[handler];
  if (local) return local.execute(operation, data);
  if (handler === "batch-summary") return batch.readBatchSummary(data);
  if (handler === "batch-atomic") {
    const atomic = load("../../batch-atomic.js") as {
      setObserveReadOnlyCatalog(catalog: Catalog): void;
      reconcileAtomicBatch(
        client: CadClient,
        reportPath: unknown,
        operations: unknown,
      ): Result;
      finalizeAtomicBatch(client: CadClient, reportPath: unknown): Result;
    };
    atomic.setObserveReadOnlyCatalog(catalog);
    if (!client)
      throw new Error(
        `${operation} requires the selected addin backend; no offline result is available`,
      );
    return operation === "batch.reconcile"
      ? atomic.reconcileAtomicBatch(
          client,
          data["reportPath"],
          data["operations"] ?? [],
        )
      : atomic.finalizeAtomicBatch(client, data["reportPath"]);
  }
  return undefined;
}

export const {
  buildReferencesActionScript,
  executeReferencesAction,
  executeExternalizationAction,
} = native;
export const buildCadScript: typeof import("./cad.js").buildCadScript =
  preparation.buildCadScript;
export const prepareCadScript: typeof import("./cad.js").prepareCadScript =
  preparation.prepareCadScript;
export const mapCadPaths: typeof import("../../packages/node-adapters/src/python/cad-script.js").mapCadPaths =
  preparation.mapCadPaths;

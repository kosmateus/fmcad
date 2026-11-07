import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import type {
  CadData,
  CadContext,
  CadExecutionRequest,
  BatchCatalog,
  BatchStep,
  BatchValidation,
  BatchServices,
  AtomicServices,
} from "@fmcad/core";
import type { NativeActionClient } from "../../packages/node-adapters/src/python/native-actions.js";
import type { PythonArtifactManifest } from "../../packages/core/src/domain/python-artifact.js";
const load = createRequire(__filename);
const { pythonLiteral, prepareCadBundle, pythonArtifactManifest } = load(
  "../../python.js",
) as typeof import("../../packages/node-adapters/src/python/artifact.js") &
  typeof import("../../packages/node-adapters/src/python/bundle.js") &
  typeof import("../../packages/node-adapters/src/python/context-binding.js");
const { publishComplete } = load(
  "../node-adapters/persistence/publish.js",
) as typeof import("../../packages/node-adapters/src/persistence/publish.js");
const { resolveRuntimePaths } = load(
  "../config-platform/runtime-paths.js",
) as typeof import("../../packages/node-adapters/src/config-platform/runtime-paths.js");
const application = load(
  "../core/application/cad/atomic.js",
) as typeof import("../../packages/core/src/application/cad/atomic.js");
export interface AtomicClient extends NativeActionClient {
  capabilities?: { backend?: string; atomicBatch?: boolean };
  server?: { timeoutMs?: number };
  callTool(
    request: {
      featureType: "script";
      object: { script: string; readOnly?: boolean };
    },
    tool?: string,
    manifest?: PythonArtifactManifest,
  ): ReturnType<NativeActionClient["callTool"]>;
}
type Client = AtomicClient | null | undefined;
const { batchServices } = load("../../batch.js") as {
  batchServices(
    client: Client,
    execute: undefined,
    catalog: BatchCatalog,
  ): Pick<
    BatchServices,
    "reportPath" | "now" | "timestamp" | "redact" | "open"
  >;
};
const { localOperations } = load("../../engineering-local.js") as {
  localOperations: Record<string, unknown>;
};
// Test-only deterministic fault injection; absent from the public catalog.
export function injectTestFault(steps: BatchStep[]): BatchStep[] {
  const spec = process.env["FMCAD_TEST_ATOMIC_FAULT"];
  if (!spec) return steps;
  const match =
    /^(after_mutation|before_ref_publish|final_validation)(?::(\d+))?$/.exec(
      String(spec).trim(),
    );
  if (!match)
    throw new Error(
      "FMCAD_TEST_ATOMIC_FAULT must be <phase>[:<afterIndex>] with phase in after_mutation | before_ref_publish | final_validation",
    );
  const afterIndex =
    match[2] === undefined ? steps.length - 1 : Number(match[2]);
  if (afterIndex < -1 || afterIndex >= steps.length)
    throw new Error(
      "FMCAD_TEST_ATOMIC_FAULT afterIndex is out of range for the current batch",
    );
  return [
    ...steps.slice(0, afterIndex + 1),
    {
      id: "__test_fault",
      operation: "__test.fault",
      data: { phase: match[1] },
    },
    ...steps.slice(afterIndex + 1),
  ];
}
export function prepareAtomicScript(args: CadData) {
  const wrapper = `

_ATOMIC_REQUEST: "JsonObject"

_ATOMIC_REQUEST = ${pythonLiteral(args)}

def run(_context: str) -> None:
    import json
    import adsk.core
    result = execute(_ATOMIC_REQUEST)
    print('FMCAD_RESULT ' + json.dumps(result, allow_nan=False))
`;
  return prepareCadBundle(
    resolveRuntimePaths({ anchor: __filename }).installation,
    wrapper,
    { request: args },
  );
}
export function buildAtomicScript(args: CadData) {
  return prepareAtomicScript(args).script;
}
function executeAtomic(client: Client, request: CadExecutionRequest) {
  return client!.callTool(
    {
      featureType: "script",
      object: {
        script: request.artifact.script,
        ...(request.readOnly ? { readOnly: true } : {}),
      },
    },
    "fusion_mcp_execute",
    pythonArtifactManifest(request.artifact),
  );
}
async function callAtomicWithinBudget(
  client: Client,
  request: CadExecutionRequest,
  deadline: number,
  reserveMs = 5000,
) {
  const remaining = Math.floor(deadline - performance.now() - reserveMs);
  if (remaining < 1)
    throw Object.assign(
      new Error(
        "RPC not submitted: insufficient batch budget after native-finalize reserve",
      ),
      { code: "FMCAD_BATCH_BUDGET_EXHAUSTED" },
    );
  const server = client!.server!;
  const configured = server.timeoutMs ?? 180000,
    previous = server.timeoutMs;
  server.timeoutMs = Math.min(configured, remaining);
  try {
    return await executeAtomic(client, request);
  } finally {
    if (previous === undefined) delete server.timeoutMs;
    else server.timeoutMs = previous;
  }
}
export async function readAtomicReceipt(reportPath: string) {
  if (typeof reportPath !== "string" || !reportPath.trim())
    throw new Error("reportPath must be a nonempty directory");
  const dir = path.resolve(reportPath);
  const names = (await fs.readdir(dir))
    .filter((name) => /^\d{8}\.json$/.test(name))
    .sort();
  if (
    !names.length ||
    names.some((name, i) => name !== `${String(i).padStart(8, "0")}.json`)
  )
    throw new Error("Missing or incomplete atomic journal; outcome unknown");
  const records: unknown[] = [];
  for (const name of names)
    records.push(JSON.parse(await fs.readFile(path.join(dir, name), "utf8")));
  return { dir, report: application.validateAtomicHistory(records), records };
}
let observeCatalog: BatchCatalog = {};
export function setObserveReadOnlyCatalog(
  catalog: BatchCatalog | null | undefined,
) {
  observeCatalog = catalog ?? {};
}
function atomicServices(
  client: Client,
  catalog: BatchCatalog = observeCatalog,
): AtomicServices {
  const services = batchServices(client, undefined, catalog);
  return {
    catalog,
    backend: client?.capabilities?.backend ?? "mcp",
    supported: client?.capabilities
      ? client.capabilities.atomicBatch === true
      : true,
    isLocal: (operation) => Object.hasOwn(localOperations, operation),
    reportPath: services.reportPath,
    now: services.now,
    timestamp: services.timestamp,
    redact: services.redact,
    nonce: () => randomBytes(16).toString("hex"),
    faultSteps: injectTestFault,
    wait: () => new Promise((resolve) => setTimeout(resolve, 200)),
    prepare: prepareAtomicScript,
    execution: {
      execute: (request, deadline) =>
        deadline === undefined
          ? executeAtomic(client, request)
          : callAtomicWithinBudget(client, request, deadline),
    },
    open: async (reportPath) => {
      const port = await services.open(reportPath);
      return {
        ...port,
        assertEmpty: async () => {
          if (
            (await fs.readdir(reportPath)).some((name) => name !== "run.lock")
          )
            throw new Error(
              "Atomic run report already exists; inspect before rerunning (no automatic replay)",
            );
        },
      };
    },
  };
}
export function runAtomicBatch(
  client: Client,
  data: CadData,
  context: CadContext = {},
  _executeCad: unknown,
  catalog: BatchCatalog | undefined,
  validation: BatchValidation,
) {
  const services = atomicServices(client, catalog);
  services.supported = client?.capabilities?.atomicBatch === true;
  return application.runAtomicBatch(data, context, validation, services);
}
export async function reconcileAtomicBatch(
  client: Client,
  reportPath: string,
  observe: unknown = [],
) {
  if (!Array.isArray(observe) || observe.length > 100)
    throw new Error("observe must be an array of at most 100 read operations");
  const { report } = await readAtomicReceipt(reportPath);
  return application.reconcileAtomicBatch(
    report,
    observe,
    atomicServices(client),
  );
}
export async function finalizeAtomicBatch(client: Client, reportPath: string) {
  const { dir, report } = await readAtomicReceipt(reportPath);
  return application.finalizeAtomicBatch(
    report,
    atomicServices(client),
    async () => {
      let lock;
      try {
        lock = await fs.open(path.join(dir, "run.lock"), "wx", 0o600);
      } catch (error) {
        if (
          error !== null &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "EEXIST"
        )
          throw new Error(
            "Batch writer lock exists; finalize refused without lock theft",
          );
        throw error;
      }
      return {
        latest: async () => report,
        assertEmpty: async () => {},
        publish: (value) =>
          publishComplete(
            path.join(dir, `${String(value.sequence).padStart(8, "0")}.json`),
            JSON.stringify(value, null, 2) + "\n",
          ),
        close: async (preserveLock) => {
          await lock.close();
          if (!preserveLock) await fs.unlink(path.join(dir, "run.lock"));
        },
      };
    },
  );
}
export const isTransactional = application.isTransactional;
export const { readOperationJournal, writeOperationRecord } = load(
  "../node-adapters/persistence/operation-journal.js",
) as typeof import("../../packages/node-adapters/src/persistence/operation-journal.js");

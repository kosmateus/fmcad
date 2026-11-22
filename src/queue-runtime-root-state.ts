import path from "node:path";
import { createRequire } from "node:module";
import type { QueueDomain } from "@fmcad/core";
import type {
  QueueRequest,
  QueueSnapshot,
} from "../packages/core/src/domain/queue-model";
import type { QueueStateOptions } from "./queue-state";
import type { ApprovedRuntimeRoot } from "./queue-runtime-physical-wiring";
import type { openIsolatedEpoch } from "./queue-isolated-epoch";

const load = createRequire(__filename);
const { QueueState } = load("./queue-state") as typeof import("./queue-state");
const { createApprovedRuntimeRetirement } = load(
  "./queue-runtime-retirement",
) as typeof import("./queue-runtime-retirement");
const { decodeOpaqueQueueJson } = load(
  "./dist/node-adapters/execution/admission-json",
) as typeof import("../packages/node-adapters/src/execution/admission-json");
const { canonical } = load(
  "./dist/core/domain/queue",
) as typeof import("../packages/core/src/domain/queue");
type State = ReturnType<typeof openIsolatedEpoch>;
type ModelGrant = (clientId: string, tokenHash: string) => void;
const grants = new WeakMap<object, ModelGrant>();

function refused(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
function syncAssertion(result: unknown): void {
  if (result === undefined) return;
  void Promise.resolve(result).catch(() => {});
  refused(
    "RUNTIME_ROOT_AUTHORITY_REQUIRED",
    "Runtime root assertions must finish synchronously",
  );
}

/** The authenticated new runtime writes the existing canonical root, not an
 * empty store or a replayed legacy epoch. Other layers remain owner-only history.
 * The actual writer claim and native consumed-root verification precede this. */
export function openRuntimeRootState(options: {
  root: ApprovedRuntimeRoot;
  assertVerifiedRoot(directory: string): void;
  assertBrokerOwner(): void;
  assertNativeModelGrant: ModelGrant;
  stateOptions?: QueueStateOptions;
}): State {
  const directory = options.root.record.store;
  const retirement = createApprovedRuntimeRetirement(options);
  const history = new Map<string, QueueDomain>();
  const outcomes = new Map<string, string>();
  const requests = new Map<string, QueueDomain>();
  const historicalStates: QueueDomain[] = [];
  const stateOptions = {
    ...options.stateOptions,
    physicalCatalogDirectory: directory,
  };
  for (const layer of Object.keys(options.root.record.layers)) {
    if (layer === "root") continue;
    const layerDirectory = path.join(directory, layer);
    const historical = new QueueState(layerDirectory, {
      ...stateOptions,
      recover: false,
      runtimeRetirement: retirement.forDirectory(layerDirectory),
    });
    const frozen = options.root.frozenBaseline.snapshots[
      layer
    ] as unknown as QueueSnapshot;
    if (!frozen || canonical(historical.data.jobs) !== canonical(frozen.jobs))
      refused(
        "RUNTIME_RETIREMENT_CHANGED",
        "Read-only historical jobs differ from their immutable original identities",
      );
    historicalStates.push(historical);
    for (const job of Object.values(historical.data.jobs)) {
      if (history.has(job.id) || requests.has(job.requestId))
        refused(
          "CORRUPT_STATE",
          "Ambiguous historical job or request identity",
        );
      history.set(job.id, historical);
      requests.set(job.requestId, historical);
      const outcome = ["succeeded", "failed", "cancelled", "expired"].includes(
        job.state,
      )
        ? job.state
        : options.root.record.layers[layer]?.dispositions[job.id]?.outcome;
      if (!outcome)
        refused(
          "RUNTIME_RETIREMENT_CHANGED",
          "Historical work has no immutable outcome classification",
        );
      outcomes.set(job.id, outcome);
    }
  }
  // Refuse ambiguity before the first projection can write.
  const currentRootBytes = options.root.currentFiles["queue-state.json"];
  if (!currentRootBytes)
    refused(
      "RUNTIME_RETIREMENT_CHANGED",
      "Approved current root bytes are required",
    );
  const currentRoot = decodeOpaqueQueueJson(
    new TextDecoder("utf-8", { fatal: true }).decode(currentRootBytes),
  ) as unknown as QueueSnapshot;
  for (const original of Object.values(currentRoot.jobs)) {
    if (history.has(original.id) || requests.has(original.requestId))
      refused(
        "CORRUPT_STATE",
        "Historical identity collides with the canonical root",
      );
  }
  const current = new QueueState(directory, {
    ...stateOptions,
    recover: true,
    runtimeRetirement: retirement.forDirectory(directory),
  });
  const assertCurrent = () => {
    syncAssertion(options.assertBrokerOwner());
    syncAssertion(options.assertVerifiedRoot(directory));
  };
  const facade = new Proxy(current, {
    get(target, key) {
      if (key === "epoch") return null;
      if (key === "admissionMode") return "runtime-rebaseline";
      if (key === "historical") return null;
      if (key === "assertEpoch" || key === "installEpoch")
        return () =>
          refused(
            "RUNTIME_ROOT_AUTHORITY_REQUIRED",
            "Legacy epoch authority cannot replace a native-approved root",
          );
      if (key === "isHistorical") return (id: string) => history.has(id);
      if (key === "lookup")
        return (id: string) =>
          current.data.jobs[id] ?? history.get(id)?.data.jobs[id];
      if (key === "findAnyRequest")
        return (clientId: string, requestId: string) => {
          const store = requests.get(requestId) ?? current;
          const job = Object.values(store.data.jobs).find(
            (item) =>
              item.requestId === requestId && item.clientId === clientId,
          );
          return job ? facade.status(job.id) : null;
        };
      if (key === "status")
        return (id?: string) => {
          const historical = id && history.get(id);
          return historical
            ? {
                ...historical.status(id),
                quarantined: outcomes.get(id!) === "unknown",
                historicalOutcome: outcomes.get(id!),
                historicalModelValidation: "not_performed",
              }
            : current.status(id);
        };
      if (key === "summary")
        return () => ({
          ...current.summary(),
          admissionScope: "native-approved-runtime-root",
          retiredEpochCount: historicalStates.length,
          historicalModelValidation: "not_performed",
        });
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      if (
        [
          "submit",
          "submitDocumentInspection",
          "submitDocumentContinuation",
          "refuseDocumentContinuation",
        ].includes(String(key))
      )
        return (request: QueueRequest, ...args: unknown[]) => {
          assertCurrent();
          if (requests.has(request.requestId))
            refused(
              "HISTORICAL_REQUEST_QUARANTINED",
              "Use a new requestId; historical work cannot be replayed",
            );
          return Reflect.apply(value, target, [request, ...args]);
        };
      return value.bind(target);
    },
  }) as unknown as State;
  grants.set(facade, (clientId, tokenHash) => {
    assertCurrent();
    syncAssertion(options.assertNativeModelGrant(clientId, tokenHash));
  });
  return facade;
}

/** An explicit new grant is required; epoch=null itself grants nothing. */
export function admitRuntimeRootRequest(
  state: object,
  request: QueueRequest | undefined,
  clients: Record<string, string>,
): boolean {
  const grant = grants.get(state);
  if (!grant) return false;
  if (
    !request ||
    !Object.hasOwn(clients, request.clientId) ||
    typeof clients[request.clientId] !== "string" ||
    !clients[request.clientId]
  )
    refused(
      "NOT_AUTHORIZED",
      "A registered runtime-root principal is required",
    );
  grant(request.clientId, clients[request.clientId]!);
  return true;
}

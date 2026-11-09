import * as fs from "node:fs/promises";
import * as path from "node:path";
import { referenceStore } from "./references";
import { validate } from "../../../core/src/application/documents/reference-input";
import { makePlan } from "../../../core/src/application/documents/reference-plan";
import {
  staleBeforeStep,
  planFreshness,
} from "../../../core/src/application/documents/reference-freshness";
import {
  executeReferences,
  inspectReferences,
  finishReferenceRead,
} from "../../../core/src/application/documents/references";
import type {
  ReferenceInput,
  ReferencePlan,
  ReferenceReport,
  ReferenceReadServices,
} from "../../../core/src/application/documents/references";
import { applyReferences } from "../../../core/src/application/documents/references-apply";
import type {
  ReferenceApplyPlan,
  ReferenceApplyServices,
} from "../../../core/src/application/documents/references-apply";

interface ReferenceClient {
  capabilities?: { backend?: string };
}
type UiInspect = NonNullable<ReferenceApplyServices["inspectUi"]>;
type Watcher = Awaited<ReturnType<ReferenceApplyServices["armWatcher"]>>;
interface Dependencies {
  fs?: typeof fs;
  backend?: string | null;
  step?: ReferenceApplyServices["step"];
  initialBlockers?: unknown[];
  initialSnapshot?: unknown;
  inspectUi?: (
    client: ReferenceClient | null,
    data: Parameters<UiInspect>[0],
    context: Parameters<UiInspect>[1],
  ) => ReturnType<UiInspect>;
  armWatcher?: (
    client: ReferenceClient | null,
    data: Record<string, unknown>,
  ) => Promise<Omit<Watcher, "evidence">>;
  now?: () => number;
}
/** Host wiring only: immutable plan and receipt publication stays in referenceStore. */
export function createReferenceWorkflow(
  port: Parameters<typeof referenceStore>[0],
) {
  const { loadJournal, writePlan, readPlan, acquire, acquireRead } =
    referenceStore(port);
  function readServices(deps: Dependencies): ReferenceReadServices {
    return {
      journal: (input) =>
        loadJournal(
          path.resolve(input.reportPath),
          input.requestId,
          deps.fs ?? fs,
        ),
      readPlan: (input) =>
        readPlan(path.resolve(input.reportPath), input.planId!, deps.fs ?? fs),
      acquire: (input, requestHash, result) =>
        acquireRead(input, requestHash, result, deps.backend, deps.fs),
    };
  }
  async function apply(
    client: ReferenceClient | null,
    input: ReferenceInput,
    plan: ReferenceApplyPlan,
    deps: Dependencies,
  ) {
    return applyReferences(input, plan, {
      backend: client?.capabilities?.backend ?? null,
      initialBlockers:
        deps.initialBlockers as ReferenceApplyServices["initialBlockers"],
      initialSnapshot:
        deps.initialSnapshot as ReferenceApplyServices["initialSnapshot"],
      journal: (request) =>
        loadJournal(
          path.resolve(request.reportPath),
          request.requestId,
          deps.fs ?? fs,
        ),
      acquire: (request, immutablePlan, requestHash) =>
        acquire(
          request,
          immutablePlan,
          requestHash,
          client?.capabilities?.backend,
          deps.fs,
        ),
      step: (...args) => deps.step!(...args),
      stale: staleBeforeStep,
      inspectUi:
        typeof deps.inspectUi === "function"
          ? (data, context) => deps.inspectUi!(client, data, context)
          : undefined,
      armWatcher: async (data) => {
        const watcher = await deps.armWatcher!(client, data);
        return {
          status: watcher.status,
          evidence: JSON.parse(JSON.stringify(watcher)) as Record<
            string,
            unknown
          >,
          complete: () => watcher.complete(),
          disarm: () => watcher.disarm(),
        };
      },
      now: deps.now ?? Date.now,
    });
  }
  async function execute(
    client: ReferenceClient | null,
    data: Record<string, unknown>,
    context: Record<string, unknown>,
    deps: Dependencies = {},
  ) {
    return executeReferences(data, {
      validate,
      inspect: (input) => inspectReferences(input, readServices(deps)),
      readPlan: (input) =>
        readPlan(path.resolve(input.reportPath), input.planId!, deps.fs ?? fs),
      journal: (input) =>
        loadJournal(
          path.resolve(input.reportPath),
          input.requestId,
          deps.fs ?? fs,
        ),
      graph: (input, request) => {
        if (!deps.step)
          throw new Error(
            "references.refresh requires the shipped SDK step adapter",
          );
        return deps.step("graph", input, request, context);
      },
      plan: makePlan,
      freshness: planFreshness,
      apply: (input, plan: ReferencePlan, preflight) =>
        apply(client, input, plan as ReferenceApplyPlan, {
          ...deps,
          ...preflight,
        }),
      publishPlan: (input, plan) =>
        writePlan(path.resolve(input.reportPath), plan, deps.fs ?? fs),
      finishRead: (input, result: ReferenceReport) =>
        finishReferenceRead(input, result, readServices(deps)),
    });
  }
  return { writePlan, readPlan, loadJournal, apply, execute };
}

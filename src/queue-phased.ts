import { createRequire } from "node:module";
import type { PhasedWorkerOptions } from "../packages/node-adapters/src/execution/phased-workers";
const load = createRequire(__filename);
const instance = load("./queue-instance") as Pick<
  PhasedWorkerOptions,
  "durable" | "processBirth" | "workflowNonterminal"
> & { readJson: PhasedWorkerOptions["readResult"] };
const { resolveRuntimePaths, resolveChildEntrypoint } = load(
  "./dist/config-platform",
) as typeof import("../packages/node-adapters/src/config-platform");
const { PhasedWorkers: NodePhasedWorkers, resolvePreparationConcurrency } =
  load(
    "./dist/node-adapters/execution/phased-workers",
  ) as typeof import("../packages/node-adapters/src/execution/phased-workers");
export { resolvePreparationConcurrency };
type HostFields =
  | "durable"
  | "readResult"
  | "prepareRequest"
  | "processBirth"
  | "workflowNonterminal"
  | "responsePath"
  | "entrypoint";
export class PhasedWorkers extends NodePhasedWorkers {
  constructor(options: Omit<PhasedWorkerOptions, HostFields>) {
    super({
      ...options,
      durable: instance.durable,
      readResult: instance.readJson,
      prepareRequest: (
        load(
          "./composition/execution-request",
        ) as typeof import("./composition/execution-request")
      ).prepareRequest,
      processBirth: instance.processBirth,
      workflowNonterminal: instance.workflowNonterminal,
      responsePath: (
        load("./queue-response-files") as Pick<
          PhasedWorkerOptions,
          "responsePath"
        >
      ).responsePath,
      entrypoint: resolveChildEntrypoint(
        resolveRuntimePaths({ anchor: __filename }),
        "queue-worker",
      ),
    });
  }
}

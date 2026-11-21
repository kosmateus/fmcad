import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  createBrepBaselineService,
  type BrepBaselineOperation,
} from "../../../core/src/application/cad/brep-baseline";
import {
  brepBaselineArtifacts,
  createBrepBaselineStage,
} from "./brep-baseline";
import { projectDirectory } from "./owned-results";
export const publicOperations = new Set([
  "measure.baseline.capture",
  "measure.baseline.inspect",
  "measure.baseline.compare",
]);
export interface BrepExecutionPorts {
  projectDirectory?: string;
  stageDependencies?: { owner?: { scope?: { project?: string } } };
  toFusionPath(path: string): string;
  executeNative(
    action: "capture" | "compare",
    payload: Record<string, unknown>,
    context: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
}
function operation(value: string): value is BrepBaselineOperation {
  return (
    value === "measure.baseline.capture" ||
    value === "measure.baseline.inspect" ||
    value === "measure.baseline.compare"
  );
}
export function createBrepExecutor(
  authorize: (payload: Record<string, unknown>) => void,
) {
  return async function execute(
    client: unknown,
    op: string,
    data: Record<string, unknown>,
    context: Readonly<Record<string, unknown>>,
    ports: BrepExecutionPorts,
  ): Promise<Record<string, unknown>> {
    if (!operation(op))
      throw new Error("Unknown BRep baseline service operation");
    if (op !== "measure.baseline.inspect") {
      if (!client)
        throw new Error(op + " requires the selected Fusion backend");
      if (!context?.["docId"] && !context?.["docFileId"])
        throw new Error(op + " requires a pinned --doc-id or --doc-file-id");
    }
    const cwd = realpathSync(
      ports.projectDirectory ||
        ports.stageDependencies?.owner?.scope?.project ||
        process.cwd(),
    );
    const root = projectDirectory(cwd) || cwd;
    const coordinator = createBrepBaselineService({
      artifacts: brepBaselineArtifacts(root),
      stage: (count) =>
        createBrepBaselineStage(root, count, ports.toFusionPath),
      newSession: randomUUID,
      executeNative: (action, payload, target) => {
        authorize(payload);
        return ports.executeNative(action, payload, target);
      },
    });
    return coordinator.execute(op, data, context || {});
  };
}

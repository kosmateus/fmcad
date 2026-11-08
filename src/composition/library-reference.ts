import path from "node:path";
import { createRequire } from "node:module";
import {
  redactDiagnostic,
  runReferencePipeline,
} from "../../packages/core/src";
const load = createRequire(__filename);
const { resolveRuntimePaths, resolvePython } = load(
  "../config-platform/index.js",
) as typeof import("../../packages/node-adapters/src/config-platform/index.js");
const { createLocalWorker } = load(
  "../python/local-pipeline.js",
) as typeof import("../../packages/node-adapters/src/python/local-pipeline.js");
const local = new Set([
  "reference.layout",
  "reference.calibrate",
  "reference.compare",
]);

export function validate(
  operation: string,
  data: Record<string, unknown>,
): void {
  if (local.has(operation) && data["schemaVersion"] !== 1)
    throw new Error("reference schemaVersion must be 1");
  if (operation !== "reference.image") return;
  if (data["mode"] !== "calibrate" && data["mode"] !== "inspect")
    throw new Error("reference image mode must be calibrate or inspect");
  if (
    data["mode"] === "inspect" &&
    Object.keys(data).some((k) => !["mode", "ref"].includes(k))
  )
    throw new Error("reference image inspect accepts only mode/ref");
  if (
    data["mode"] === "calibrate" &&
    ["segment", "length", "anchor"].some((k) => !Object.hasOwn(data, k))
  )
    throw new Error(
      "reference image calibrate requires segment, length and anchor",
    );
}

/** Keep interpreter/schema preflight synchronous; only worker completion is asynchronous. */
export function execute(operation: string, data: unknown): Promise<unknown> {
  const worker = createLocalWorker({
    redactDiagnostic,
    resolveWorker: () =>
      path.join(
        resolveRuntimePaths({ anchor: __filename }).assets,
        "reference_images.py",
      ),
    resolvePython: (plan) =>
      resolvePython({
        ...(plan.python === undefined ? {} : { pythonPath: plan.python }),
        feature: "reference",
      }),
  });
  return runReferencePipeline(operation, data, worker);
}

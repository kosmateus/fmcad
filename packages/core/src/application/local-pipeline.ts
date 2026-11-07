import {
  imagePathFields,
  parseImageArguments,
  planImage,
  planReference,
  type ImageMode,
} from "../domain/local-pipeline-plan";
import type {
  LocalPipelineFiles,
  LocalWorkerPort,
  LocalWorkerResult,
} from "../ports/local-pipeline";

export async function runImagePipeline(
  mode: ImageMode,
  args: readonly string[],
  files: LocalPipelineFiles,
  worker: LocalWorkerPort,
): Promise<LocalWorkerResult> {
  const arguments_ = parseImageArguments(mode, args);
  const text =
    arguments_.file === null
      ? "{}"
      : await files.readText(files.resolve(arguments_.file));
  const plan = planImage(arguments_, text);
  const request = { ...plan.request };
  for (const key of imagePathFields(mode))
    if (typeof request[key] === "string")
      request[key] = files.resolve(request[key]);
  return worker.run({ ...plan, request });
}

export function runReferencePipeline(
  operation: string,
  data: unknown,
  worker: LocalWorkerPort,
): Promise<unknown> {
  // Keep outer validation/interpreter preflight synchronous, as in the existing
  // reference consumer. Worker completion and JSON decoding remain asynchronous.
  return worker.run(planReference(operation, data)).then((result) => {
    if (result.code !== 0)
      throw new Error(
        `Local reference worker failed: ${result.stderr.trim()}. Requires Pillow, NumPy and SciPy in --python environment.`,
      );
    try {
      return JSON.parse(result.stdout) as unknown;
    } catch (error) {
      throw new Error(
        `Invalid reference worker output: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
}

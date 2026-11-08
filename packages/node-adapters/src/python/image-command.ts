import { runImagePipeline, type ImageMode } from "@fmcad/core";
import {
  createLocalWorker,
  localPipelineFiles,
  type LocalProcessOptions,
} from "./local-pipeline";

interface Output {
  write(chunk: string | Buffer): unknown;
}
export interface ImageInterpreterOptions {
  pythonPath: string | undefined;
  feature:
    "image-trace" | "image-detail" | "image-optimize" | "image-boundaries";
}
export interface ImageCommandDependencies {
  stdout: Output;
  stderr: Output;
  resolvePython?: (options: ImageInterpreterOptions) => string;
  spawnImageTrace?: LocalProcessOptions["spawn"];
  spawnImageOptimize?: LocalProcessOptions["spawn"];
  spawnImageBoundaries?: LocalProcessOptions["spawn"];
}
export interface ImageCommandOptions {
  mode: ImageMode;
  worker: string;
  requirements: string;
  resolvePython(options: ImageInterpreterOptions): string;
  redactDiagnostic(text: string): string;
}

/** Host-only composition. Parsing and preflight finish before starting a worker. */
export function createImageCommand(options: ImageCommandOptions) {
  return async (
    args: readonly string[],
    deps: ImageCommandDependencies,
  ): Promise<number> => {
    const { mode, worker, requirements, redactDiagnostic } = options;
    let setup: string | undefined;
    const spawn =
      mode === "trace"
        ? deps.spawnImageTrace
        : mode === "optimize"
          ? deps.spawnImageOptimize
          : deps.spawnImageBoundaries;
    const process = createLocalWorker({
      redactDiagnostic,
      resolveWorker: () => worker,
      resolvePython: (plan) => {
        const feature =
          mode === "trace" && Number(plan.request["traceDetailAreaPx2"]) > 0
            ? "image-detail"
            : (`image-${mode}` as const);
        const python = (deps.resolvePython || options.resolvePython)({
          pythonPath: plan.python,
          feature,
        });
        const label =
          mode === "trace"
            ? "tracing"
            : mode === "optimize"
              ? "optimization"
              : "boundary";
        const cairo =
          mode === "trace"
            ? " CairoSVG also needs the system Cairo library."
            : "";
        setup = `Image ${label} dependencies: run ${JSON.stringify(python)} -m pip install -r ${JSON.stringify(requirements)} in your user-owned environment.${cairo} Nothing was installed automatically.\n`;
        return python;
      },
      ...(spawn ? { spawn } : {}),
      stdout: (chunk) => deps.stdout.write(chunk),
      stderr: (chunk) => deps.stderr.write(chunk),
      startError: (error, plan) =>
        new Error(
          `Cannot start local Python ${JSON.stringify(plan.python)}: ${error.message}. Select an installed interpreter with --python ${mode === "trace" ? "PATH" : "EXE"}.\n${setup}`,
        ),
    });
    const result = await runImagePipeline(
      mode,
      args,
      localPipelineFiles,
      process,
    );
    if (result.code !== 0)
      deps.stderr.write(
        `image ${mode} worker failed (${result.signal || result.code}). ${setup}`,
      );
    return result.code === 0 ? 0 : 1;
  };
}

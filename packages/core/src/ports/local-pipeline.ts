export type LocalWorker =
  "image-trace" | "image-optimize" | "image-boundaries" | "reference";
export interface LocalWorkerPlan {
  worker: LocalWorker;
  python: string | undefined;
  args: readonly string[];
  request: Readonly<Record<string, unknown>>;
}
export interface LocalPipelineFiles {
  resolve(path: string): string;
  readText(path: string): string | Promise<string>;
}
export interface LocalWorkerResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}
export interface LocalWorkerPort {
  run(plan: LocalWorkerPlan): Promise<LocalWorkerResult>;
}

import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { validateRunIdentity, formatRunOutput } from "./run";
import {
  REVIEW_VIEWS,
  executeReview,
  verifyReviewReport,
  type ReviewRequest,
  type ReviewRunPorts,
} from "../../packages/core/src/application/review";
const load = createRequire(__filename);
const adapters = load(
  "../review/index.js",
) as typeof import("../../packages/node-adapters/src/review/index.js");
const { resolveRuntimePaths } = load(
  "../config-platform/index.js",
) as typeof import("../../packages/node-adapters/src/config-platform/index.js");
export const views = REVIEW_VIEWS;
export const flags = Object.fromEntries(
  [
    "--doc",
    "--doc-id",
    "--doc-file-id",
    "--out",
    "--width",
    "--height",
    "--recipes",
  ].map((flag) => [flag, "value"]),
);
export type ParsedReviewArgs = Omit<ReviewRequest, "fusionOut" | "requestId">;
export interface ReviewCommandClient {
  callTool(
    request: unknown,
    tool: string,
  ): Promise<{ text?: string; failed?: boolean; uiGuard?: unknown }>;
}
export interface ReviewCommandIo {
  stdout?: { write(value: string): unknown };
  write?: (value: string) => unknown;
  reviewPorts?: Partial<ReviewRunPorts>;
}
export function parseReviewArgs(args: readonly string[]): ParsedReviewArgs {
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (!Object.hasOwn(flags, flag))
      throw new Error("Unknown review option: " + flag);
    if (Object.hasOwn(values, flag))
      throw new Error("Duplicate review option: " + flag);
    const value = args[++i];
    if (typeof value !== "string" || !value.trim() || value.startsWith("-"))
      throw new Error(flag + " requires a value");
    values[flag] = value;
  }
  if (!values["--doc"] || (!values["--doc-id"] && !values["--doc-file-id"]))
    throw new Error("review requires --doc and --doc-id or --doc-file-id");
  validateRunIdentity(values, false);
  const out = values["--out"];
  if (!out) throw new Error("review requires --out <new-local-directory>");
  if (process.platform !== "win32" && /^[A-Za-z]:[\\/]|^\\\\/.test(out))
    throw new Error("--out must be a CLI-local path, not a Windows/UNC path");
  const dimension = (flag: string, fallback: number): number => {
    const value = values[flag] ?? String(fallback);
    if (!/^\d+$/.test(value) || Number(value) < 32 || Number(value) > 4096)
      throw new Error(flag + " must be an integer from 32 to 4096");
    return Number(value);
  };
  const width = dimension("--width", 1600),
    height = dimension("--height", 1200);
  if (width * height > 16000000)
    throw new Error("review images must not exceed 16 megapixels");
  let recipes: ReviewRequest["recipes"];
  if (values["--recipes"] !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(values["--recipes"]);
    } catch {
      throw new Error("--recipes must be a JSON array");
    }
    if (!Array.isArray(parsed))
      throw new Error("--recipes must be a JSON array");
    // The application validates every recipe before claiming output or execution.
    recipes = parsed;
  }
  return {
    doc: values["--doc"],
    docId: values["--doc-id"] ?? null,
    docFileId: values["--doc-file-id"] ?? null,
    out: path.resolve(out),
    width,
    height,
    ...(recipes === undefined ? {} : { recipes }),
  };
}
export function buildReviewScript(request: ReviewRequest): string {
  return adapters.prepareReviewArtifact(
    request,
    resolveRuntimePaths({ anchor: __filename }).runtime,
  ).script;
}
export function verifyReport(report: unknown, request: ReviewRequest) {
  return verifyReviewReport(report, {
    ...request,
    docId: request.docId ?? null,
    docFileId: request.docFileId ?? null,
  });
}
export async function reviewCmd(
  client: ReviewCommandClient,
  args: readonly string[],
  toWindowsPath: (value: string) => string,
  io: ReviewCommandIo = process,
): Promise<number> {
  const options = parseReviewArgs(args);
  if (typeof toWindowsPath !== "function")
    throw new Error("review requires the CLI Fusion path mapper");
  const fusionOut = ["win32", "darwin"].includes(process.platform)
    ? options.out
    : toWindowsPath(options.out);
  const request = { ...options, fusionOut, requestId: randomUUID() };
  const injected = io.reviewPorts || {};
  const outcome = await executeReview(request, {
    artifacts: injected.artifacts || adapters.createReviewArtifactStore(),
    execution:
      injected.execution ||
      adapters.createReviewExecutionPort(client, formatRunOutput),
    preparation:
      injected.preparation ||
      adapters.createReviewPreparationPort(
        resolveRuntimePaths({ anchor: __filename }).runtime,
      ),
    sha256: injected.sha256 || adapters.sha256ReviewImage,
  });
  const manifestPath = path.join(options.out, "manifest.json");
  const stdout = io.stdout || io;
  if (typeof stdout.write !== "function")
    throw new TypeError("review requires an output writer");
  stdout.write(
    JSON.stringify({
      ...outcome.report,
      transportStatus: outcome.transport,
      artifactStatus: outcome.artifacts,
      cadAcceptance: outcome.cadAcceptance,
      ...(outcome.manifestWritten ? { manifestPath } : {}),
    }) + "\n",
  );
  return outcome.code;
}

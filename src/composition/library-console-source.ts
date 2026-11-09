import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { createRequire } from "node:module";
const load = createRequire(__filename);
const { resolveRuntimePaths, resolvePython } = load(
  "../config-platform",
) as typeof import("../../packages/node-adapters/src/config-platform");
const { sourceHashMismatch, redactDiagnostic } = load(
  "../core",
) as typeof import("../../packages/core/src");
export const { readSource } = load(
  "../node-adapters/console/bounded-read",
) as typeof import("../../packages/node-adapters/src/console/bounded-read");
const { parseWorkerJson } = load(
  "../python/local-pipeline",
) as typeof import("../../packages/node-adapters/src/python/local-pipeline");
export interface SourcePreviewOptions {
  pythonPath?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxBytes?: number;
  cwd?: string;
}
interface Span {
  text: string;
  tone: string;
}
interface FormatterOutput {
  formatted: string;
  applied: boolean;
  error: string | null;
  lines: Span[][];
}
export interface SourcePreview {
  path: string | null;
  original: string | null;
  formatted: string | null;
  lines: Span[][];
  sha256: string | null;
  expectedSha256: string | null;
  changedSinceRun: boolean | null;
  formatter: { applied: boolean; error: string | null };
}
function isFormatterOutput(value: unknown): value is FormatterOutput {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  return (
    typeof result["formatted"] === "string" &&
    typeof result["applied"] === "boolean" &&
    (result["error"] === null || typeof result["error"] === "string") &&
    Array.isArray(result["lines"]) &&
    result["lines"].every(
      (line: unknown) =>
        Array.isArray(line) &&
        line.every((value: unknown) => {
          if (!value || typeof value !== "object") return false;
          const span = value as Record<string, unknown>;
          return (
            typeof span["text"] === "string" &&
            !span["text"].includes("\n") &&
            typeof span["tone"] === "string" &&
            TONES.has(span["tone"])
          );
        }),
    )
  );
}
const HELPER = resolveRuntimePaths({ anchor: __filename }).formatter;
const TONES = new Set([
  "text",
  "accent",
  "success",
  "warning",
  "muted",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxType",
  "syntaxBuiltin",
  "syntaxKey",
]);
const integer = (value: unknown, fallback: number, maximum: number) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, maximum)
    : fallback;

function formatCopy(
  original: string,
  options: SourcePreviewOptions,
): Promise<FormatterOutput> {
  const python = resolvePython({
    ...(options.pythonPath ? { pythonPath: options.pythonPath } : {}),
    feature: "formatter",
  });
  const timeout = integer(options.timeoutMs, 3000, 3000);
  const limit = integer(
    options.maxOutputBytes,
    32 * 1024 * 1024,
    64 * 1024 * 1024,
  );
  return new Promise<FormatterOutput>((resolve, reject) => {
    const child = spawn(python, ["-I", "-B", HELPER], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let settled = false,
      size = 0,
      stderr = "";
    const chunks: Buffer[] = [];
    const finish = (error: unknown, value?: FormatterOutput) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        child.kill("SIGKILL");
        reject(error);
      } else if (value) resolve(value);
      else reject(new Error("Formatter returned no result"));
    };
    const timer = setTimeout(
      () => finish(new Error(`Formatter timed out after ${timeout} ms`)),
      timeout,
    );
    child.on("error", (error) =>
      finish(new Error(`Formatter unavailable: ${error.message}`)),
    );
    child.stdin.on("error", (error) =>
      finish(new Error(`Formatter input failed: ${error.message}`)),
    );
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit)
        return finish(new Error("Formatter output exceeds limit"));
      if (!settled) chunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit)
        return finish(new Error("Formatter output exceeds limit"));
      if (stderr.length < 2048)
        stderr += chunk.toString("utf8").slice(0, 2048 - stderr.length);
    });
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0)
        return finish(
          new Error(
            `Formatter exited with ${code}: ${redactDiagnostic(stderr.trim())}`,
          ),
        );
      try {
        const parsed = parseWorkerJson(Buffer.concat(chunks).toString("utf8"));
        if (!isFormatterOutput(parsed))
          throw new Error("Invalid formatter response");
        const result = parsed;
        if (
          result.lines
            .map((line) => line.map((span) => span.text).join(""))
            .join("\n") !== result.formatted ||
          result.lines.length !== result.formatted.split("\n").length ||
          (result.applied && result.error) ||
          (!result.applied && (!result.error || result.formatted !== original))
        ) {
          throw new Error("Inconsistent formatter response");
        }
        finish(null, result);
      } catch (error) {
        finish(error);
      }
    });
    child.stdin.end(JSON.stringify({ source: original }));
  });
}

export async function openSource(
  row: { sourcePath?: string; sourceHash?: string } | null | undefined,
  options: SourcePreviewOptions = {},
): Promise<SourcePreview> {
  const preview: SourcePreview = {
    path: typeof row?.sourcePath === "string" ? row.sourcePath : null,
    original: null,
    formatted: null,
    lines: [],
    sha256: null,
    expectedSha256: typeof row?.sourceHash === "string" ? row.sourceHash : null,
    changedSinceRun: null,
    formatter: { applied: false, error: null },
  };
  try {
    if (!preview.path || preview.path.includes("\0"))
      throw new Error("No valid declared source path");
    preview.path = path.resolve(options.cwd || process.cwd(), preview.path);
    const bytes = await readSource(
      preview.path,
      integer(options.maxBytes, 1024 * 1024, 16 * 1024 * 1024),
    );
    preview.sha256 = createHash("sha256").update(bytes).digest("hex");
    preview.changedSinceRun = sourceHashMismatch(
      preview.expectedSha256,
      preview.sha256,
    );
    preview.original = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    preview.formatted = preview.original;
    preview.lines = preview.original
      .split("\n")
      .map((text) => [{ text, tone: "text" }]);
    const result = await formatCopy(preview.original, options);
    preview.formatted = result.formatted;
    preview.lines = result.lines;
    preview.formatter = { applied: result.applied, error: result.error };
  } catch (error) {
    preview.formatter.error =
      error instanceof Error ? error.message : String(error);
  }
  return preview;
}

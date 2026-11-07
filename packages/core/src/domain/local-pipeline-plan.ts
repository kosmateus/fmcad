import type { LocalWorkerPlan } from "../ports/local-pipeline";

export type ImageMode = "trace" | "optimize" | "boundaries";
const camelCase = (key: string): string =>
  key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
export const imageOptions = {
  trace: [
    "blur-sigma",
    "median-size",
    "label-mode-size",
    "filter-speckle",
    "corner-threshold",
    "length-threshold",
    "splice-threshold",
    "max-iterations",
    "path-precision",
    "color-precision",
    "layer-difference",
    "mode",
    "width-mm",
    "mirror-x",
    "trace-scale",
    "trace-detail-area-px2",
  ],
  optimize: [
    "base",
    "search",
    "trials",
    "seed",
    "top-k",
    "regions",
    "min-feature-area",
    "weights",
  ],
  boundaries: [
    "reference-mode",
    "mode",
    "scale",
    "max-gap-width-px",
    "max-overlap-width-px",
    "max-changed-area-px",
    "fit-error-px",
    "corner-angle",
    "width-mm",
    "mirror-x",
  ],
} as const;
const paths: Record<ImageMode, readonly string[]> = {
  trace: ["input", "out", "palette"],
  optimize: ["input", "out", "palette", "reference"],
  boundaries: ["svg", "reference", "palette", "out"],
};
export interface ImageArguments {
  mode: ImageMode;
  flags: Readonly<Record<string, string | true>>;
  file: string | null;
  python: string | undefined;
}
export function parseImageArguments(
  mode: ImageMode,
  args: readonly string[],
): ImageArguments {
  const flags: Record<string, string | true> = {};
  const allowed = [
    ...paths[mode],
    ...imageOptions[mode],
    "python",
    "file",
    "json",
  ];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    const key = flag.slice(2);
    if (!flag.startsWith("--") || !allowed.includes(key))
      throw new Error(`unknown option for image ${mode}: ${flag}`);
    if (Object.hasOwn(flags, key))
      throw new Error(`Duplicate image ${mode} option: ${flag}`);
    if (key === "json") flags[key] = true;
    else {
      const value = args[++i];
      if (!value || /^--|^-[A-Za-z]/.test(value))
        throw new Error(`${flag} requires a value`);
      flags[key] = value;
    }
  }
  return {
    mode,
    flags,
    file: typeof flags["file"] === "string" ? flags["file"] : null,
    python: typeof flags["python"] === "string" ? flags["python"] : undefined,
  };
}
function requestObject(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be a JSON object`);
}
export function planImage(
  arguments_: ImageArguments,
  text = "{}",
): LocalWorkerPlan {
  const { mode, flags, python } = arguments_;
  const request: unknown = JSON.parse(text);
  requestObject(request, `Image ${mode} request`);
  // Retain boundaries' top-level duplicate-token rejection before JSON projection.
  if (mode === "boundaries") {
    const fields = new Set<string>();
    let depth = 0;
    for (const match of text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]]/g)) {
      const token = match[0];
      if (token === "{" || token === "[") depth++;
      else if (token === "}" || token === "]") depth--;
      else if (
        depth === 1 &&
        /^\s*:/.test(text.slice(match.index + token.length))
      ) {
        const field = JSON.parse(token) as string;
        if (fields.has(field))
          throw new Error(`Duplicate image boundaries input: ${field}`);
        fields.add(field);
      }
    }
  }
  const tunables: readonly string[] = imageOptions[mode];
  const allowed = [...paths[mode], ...tunables.map(camelCase)];
  for (const key of Object.keys(request))
    if (!allowed.includes(key))
      throw new Error(`Unknown image ${mode} request field: ${key}`);
  for (const [key, value] of Object.entries(flags)) {
    if (["file", "python", "json"].includes(key)) continue;
    const field = camelCase(key);
    if (Object.hasOwn(request, field))
      throw new Error(`Duplicate image ${mode} input: ${field}`);
    if (typeof value !== "string") throw new Error(`${key} requires a value`);
    if (
      mode === "boundaries" &&
      tunables.includes(key) &&
      !["mode", "reference-mode", "mirror-x"].includes(key)
    ) {
      if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value))
        throw new Error(`${key} requires a number`);
      request[field] = Number(value);
      if (!Number.isFinite(request[field]))
        throw new Error(`${key} requires a finite number`);
    } else
      request[field] =
        tunables.includes(key) &&
        !(mode === "trace" && key === "mode") &&
        !(mode === "boundaries" && ["mode", "reference-mode"].includes(key))
          ? (JSON.parse(value) as unknown)
          : value;
  }
  for (const key of paths[mode]) {
    if (
      ((mode === "trace" && key === "palette") ||
        (mode === "optimize" && key === "reference")) &&
      !Object.hasOwn(request, key)
    )
      continue;
    const value = request[key];
    if (typeof value !== "string" || !value.trim())
      throw new Error(`image ${mode} requires ${key} as a nonempty path`);
  }
  return { worker: `image-${mode}`, python, args: [], request };
}
export function imagePathFields(mode: ImageMode): readonly string[] {
  return paths[mode];
}

export function planReference(
  operation: string,
  data: unknown,
): LocalWorkerPlan {
  if (
    !["reference.layout", "reference.calibrate", "reference.compare"].includes(
      operation,
    )
  )
    throw new Error(`Unknown local reference operation: ${operation}`);
  requestObject(data, "Reference request");
  const { python, ...request } = data;
  if (python !== undefined && (typeof python !== "string" || !python.trim()))
    throw new Error("python must be a local executable");
  return { worker: "reference", python, args: [operation], request };
}

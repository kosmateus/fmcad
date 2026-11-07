import { spawnSync } from "node:child_process";
import { assertPlatformCapability, detectPlatform } from "./platform.js";

export type PythonFeature =
  | "stdlib"
  | "formatter"
  | "reference"
  | "image-trace"
  | "image-optimize"
  | "image-detail"
  | "image-boundaries";
export const PYTHON_REQUIREMENTS: Readonly<
  Record<PythonFeature, readonly string[]>
> = {
  stdlib: [],
  formatter: ["black", "pygments"],
  reference: ["PIL", "numpy", "scipy"],
  "image-trace": ["PIL", "numpy", "vtracer", "cairosvg"],
  "image-optimize": ["PIL", "numpy", "vtracer", "cairosvg", "scipy", "cv2"],
  "image-boundaries": [
    "PIL",
    "numpy",
    "vtracer",
    "cairosvg",
    "scipy",
    "cv2",
    "shapely",
  ],
  "image-detail": ["PIL", "numpy", "vtracer", "cairosvg", "scipy", "shapely"],
};

export interface PythonResolutionOptions {
  readonly pythonPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly feature?: PythonFeature;
}

/** Probe the selected interpreter in isolation before executing user/helper code. No pip. */
export function resolvePython(options: PythonResolutionOptions = {}): string {
  assertPlatformCapability(detectPlatform(), "local");
  const env = options.env ?? process.env;
  const executable = options.pythonPath ?? env["FMCAD_PYTHON"] ?? "python3";
  if (typeof executable !== "string" || !executable.trim())
    throw new Error(
      "Python executable must be a nonempty local path or command",
    );
  const modules = PYTHON_REQUIREMENTS[options.feature ?? "stdlib"];
  const probe = spawnSync(
    executable,
    [
      "-I",
      "-B",
      "-c",
      [
        "import sys, platform, importlib, json, contextlib, io",
        "missing = []",
        "if platform.python_implementation() == 'CPython' and (3, 10) <= sys.version_info[:2] <= (3, 12):",
        "    for name in json.loads(sys.argv[1]):",
        "        try:",
        "            with contextlib.redirect_stdout(io.StringIO()):",
        "                importlib.import_module(name)",
        "        except Exception:",
        "            missing.append(name)",
        "print(json.dumps({'implementation': platform.python_implementation(), 'version': list(sys.version_info[:2]), 'missing': missing}))",
      ].join("\n"),
      JSON.stringify(modules),
    ],
    {
      env,
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 65536,
      windowsHide: true,
    },
  );
  if (probe.error || probe.status !== 0)
    throw new Error(
      `Python unavailable: ${executable}; configure FMCAD_PYTHON with CPython 3.10–3.12`,
    );
  const result: unknown = JSON.parse(probe.stdout);
  if (
    result === null ||
    typeof result !== "object" ||
    !("implementation" in result) ||
    result.implementation !== "CPython" ||
    !("version" in result) ||
    !Array.isArray(result.version) ||
    result.version[0] !== 3 ||
    ![10, 11, 12].includes(Number(result.version[1]))
  ) {
    throw new Error(
      `Unsupported Python: ${executable}; CPython 3.10–3.12 is required`,
    );
  }
  if (!("missing" in result) || !Array.isArray(result.missing))
    throw new Error("Invalid Python dependency probe");
  if (result.missing.length > 0)
    throw new Error(
      `Missing Python dependencies for ${options.feature}: ${result.missing.join(", ")}; install the documented requirements in your selected interpreter (fmcad never runs pip automatically)`,
    );
  return executable;
}

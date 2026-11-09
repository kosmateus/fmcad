import type { CommandDescriptor } from "./library-commands";
import type { CommandManual } from "./library-help-manual";
import path from "node:path";
import { createRequire } from "node:module";
const load = createRequire(__filename);
const { resolveRuntimePaths, resolvePython } = load(
  "../config-platform/index.js",
) as typeof import("../../packages/node-adapters/src/config-platform");
import { createImageCommand } from "../../packages/node-adapters/src/python/image-command";
import { redactDiagnostic } from "@fmcad/core";

const tunables = {
  "blur-sigma": "number [0, 100]; default 0 (disabled)",
  "median-size": "integer 0, 3, 5, 7; default 0 (disabled)",
  "label-mode-size":
    "integer 0, 3, 5, 7; default 0 (disabled); nonzero requires palette",
  "filter-speckle": "integer [0, 65535]; default 4",
  "corner-threshold": "number [0, 180]; default 60",
  "length-threshold": "number [0.01, 1000]; default 4",
  "splice-threshold": "number [0, 180]; default 45",
  "max-iterations": "integer [1, 1000]; default 10",
  "path-precision": "integer [0, 15]; default 4",
  "color-precision": "integer [1, 8]; default 8",
  "layer-difference": "integer [0, 255]; default 0",
  mode: "spline or polygon; default spline",
  "width-mm": "number [1e-9, 1e9]; default 50",
  "mirror-x": "boolean true or false; default false",
  "trace-scale":
    "integer 1 or 2; default 1. Exact nearest-neighbor tracing, normalized source coordinates; scale 2 limited to 30 million working pixels and may greatly increase spline count",
  "trace-detail-area-px2":
    "number [0, 1e9] in source px²; default 0 (off). Opt-in exact SS2 small cutout bundles; requires palette, spline mode, trace-scale 1; ambiguity refuses the candidate",
};
const assets = resolveRuntimePaths({ anchor: __filename }).assets;
const worker = path.join(assets, "image_trace.py");
const requirements = path.join(assets, "image_trace_requirements.txt");
const descriptor: CommandDescriptor = {
  usage:
    "image trace --input PATH --out NEWDIR [--palette JSON] [--python PATH] [tunables] [--json]",
  desc: "LOCAL raster tracing and previews only. No Fusion mutation, --doc, MCP, config or connection required.",
  example:
    "fmcad image trace --input rectangle.png --out rectangle-trace --mode polygon --width-mm 50",
  extra: `Alternative: fmcad image trace --file request.json [additional input flags] [--python PATH] [--json]
All flags require values except --json and help. --palette is a JSON FILE path.
Request keys are input, out, palette and camelCase tunables (e.g. blurSigma, mirrorX).
Flags may supplement --file; duplicate fields or repeated options are errors, not last-wins overrides.
Unknown options/fields are rejected. --python is CLI-only, defaults to python3, and never enters the request.
All paths are CLI-host local, never converted to Fusion/Windows paths. Relative paths, including
values inside request.json, resolve against the invocation cwd, NOT the request file directory.
out must be NEW with an existing parent. Existing outputs are never overwritten; partial failures
are retained. Retry with another NEWDIR. Worker stdout JSON envelope is passed through unchanged;
--json is accepted for consistency (output is always JSON). Errors use stderr and a nonzero exit.

Tunables (validated by the worker):
${Object.entries(tunables)
  .map(([key, spec]) => `  --${key}: ${spec}`)
  .join("\n")}

Preprocessing: raw RGB median (--median-size), then Gaussian blur (--blur-sigma),
then palette classification, then optional integer-label mode filtering (--label-mode-size).
labelModeSize removes isolated spurious third-color pixels without generating new colors;
it is NOT RGB filtering. Nonzero requires a palette with at most 256 labels including background.

Dependencies: use a user-owned venv; nothing is installed automatically.
  python3 -m venv "$HOME/.venvs/fmcad-image"
  "$HOME/.venvs/fmcad-image/bin/python" -m pip install -r ${JSON.stringify(requirements)}
Select that interpreter with --python "$HOME/.venvs/fmcad-image/bin/python".
CairoSVG also requires the system Cairo library.

Outputs: segmented.png, raw_contours.svg, contours.svg, preview.png, overlay.svg, overlay.png, report.json,
sketches/*.json and import_sketches.json. Review overlays and report before any separate import.
With a palette, contours.svg preserves exact declared palette fills by nearest RGB mapping
of traced fills to palette colors or background. Ties prefer background then declaration order.
raw_contours.svg retains the original vtracer output; report.rawToSnappedColors records the mapping.
Snapping does not change geometry or undo merged regions; rendered antialiasing may blend colors.
Spline mode preserves traced cubic Bezier control points via the existing bezier primitive,
not sampled fit splines; raster-to-vector tracing itself is approximate. No solid validation.
Palette example: fmcad image trace --input palette-image.png --out palette-trace --palette palette.json --label-mode-size 3
See docs/IMAGE_TRACE.md for palette schema, preprocessing, scaling and explicit import workflow.`,
};

const traceImage = createImageCommand({
  mode: "trace",
  worker,
  requirements,
  resolvePython: (options) =>
    resolvePython(options as Parameters<typeof resolvePython>[0]),
  redactDiagnostic,
});

const manual: CommandManual = {
  sections: [{ title: "Local Return Contract", text: descriptor.desc }],
  examples: [
    {
      label: "Rectangle preview",
      requires:
        "Existing rectangle.png, new output directory and local Python dependencies.",
      argv: [
        "image",
        "trace",
        "--input",
        "rectangle.png",
        "--out",
        "rectangle-trace",
        "--mode",
        "polygon",
      ],
      output:
        "Unchanged image.trace JSON envelope, local previews and import_sketches.json; no Fusion mutation.",
    },
  ],
  audit: {
    sources: [
      "src/image-trace.js",
      "assets/image_trace.py",
      "docs/IMAGE_TRACE.md",
    ],
    verified: [
      "local routing without configuration",
      "flag-to-worker mapping and JSON stdin",
      "duplicate/unknown options and required paths",
      "stdout envelope passthrough and interpreter failure guidance",
    ],
    tests: ["tests/image-trace.test.js", "tests/image_trace_test.py"],
    gaps: [],
    bugs: [
      "Raster tracing is approximate; exact traced cubic import does not certify CAD profiles or solids. Partial output is retained on failure.",
    ],
  },
};

export { descriptor, traceImage, manual };

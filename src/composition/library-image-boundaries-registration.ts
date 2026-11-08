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
const camelCase = (key: string) =>
  key.replace(/-([a-z])/g, (_match: string, c: string) => c.toUpperCase());

const tunables = {
  "reference-mode": "source|labels; default source",
  mode: "inspect|repair; default inspect",
  scale: "integer [1, 4]; default 2",
  "max-gap-width-px": "finite positive source pixels; default 2",
  "max-overlap-width-px": "finite positive source pixels; default 2",
  "max-changed-area-px": "finite positive source pixel area; default 500",
  "fit-error-px": "finite positive source pixels <= 2; default 0.35",
  "corner-angle": "finite degrees [0, 180]; default 55",
  "width-mm": "finite positive millimeters; default 50",
  "mirror-x": "boolean true|false; default false",
};
const assets = resolveRuntimePaths({ anchor: __filename }).assets;
const worker = path.join(assets, "image_boundaries.py");
const requirements = path.join(assets, "image_boundaries_requirements.txt");
const descriptor: CommandDescriptor = {
  usage:
    "image boundaries --svg PATH --reference PATH --palette JSON --out NEWDIR [--python EXE] [options] [--json]",
  desc: "LOCAL reference-guided boundary inspection/repair and artifacts only. No Fusion document, backend, config or connection.",
  example:
    "fmcad image boundaries --svg traced.svg --reference image.png --palette palette.json --out boundary-audit",
  extra: `Alternative: fmcad image boundaries --file request.json [additional input flags] [--python EXE] [--json]
Required paths: svg, reference, palette, out. --palette is a JSON FILE path.
Request keys: svg, reference, palette, out, ${Object.keys(tunables).map(camelCase).join(", ")}.
--file must contain a JSON object with camelCase fields. Duplicate fields, repeated flags,
unknown fields/options, positional arguments and --doc/backend/global flags are rejected.
Flags supplement --file; they never override its fields. All flags need values except help and --json.
All paths are CLI-host local and resolve against invocation cwd, including request-file values,
NOT the request file directory. No Fusion/Windows path conversion.
--python is CLI-only, defaults to python3, and selects one local executable without a shell.
Worker JSON stdin/stdout passthrough; --json is an optional no-op. Diagnostics use stderr.
Worker stdout is a compact summary with areas, warnings, files and unresolvedReasonCounts
(counts of unresolved components by reason). Full component records, parameters and fitValidation
remain in report.json, located via result.files["report.json"], not in stdout.
Interpreter/worker errors return nonzero. Worker types, ranges and source validation run before output creation.
out must be NEW with an existing parent. No overwrite or cleanup; partial failures are retained.

Options (defaults and strict semantic validation owned by the worker):
${Object.entries(tunables)
  .map(([key, spec]) => `  --${key}: ${spec}`)
  .join("\n")}

inspect maps gaps/overlaps without publishing geometry. repair uses reference-guided width and
total changed-area caps, only nearby expected-class ownership, never global dilation.
Intentional reference holes are protected; pre-existing narrow contour offsets remain
protected_unchanged with a report, not forced to match the reference silhouette.
Significant hole topology checks use 4-connected background and EDT diameter > maxGapWidthPx.
Shared Bezier chains are reused exactly in reverse by adjacent colors, not independently fitted.
Ambiguous ownership, wide defects, area-budget failures or failed integrity checks block publication.
result.status: inspected (audit only), blocked (no repaired geometry published), ready (geometry published).
All three are successful worker envelopes, not process errors. Inspect result.status and warnings.
geometryValidated remains false even for ready; sampledMaskValidated is true only on publication.
These are raster working-resolution and sampled curve checks, NOT analytic/CAD/manufacturing validation.
Original curves are refit within tolerance against the proposed label partition, not original SVG curves;
contours can change globally rather than only near repaired pixels. ready is NOT production-ready certification.
Outputs: report.json, original copies, reference/before/after images and gap/overlap/protected/unresolved maps.
Only when published: repaired.svg, preview/overlay images, sketches/*.json and import_sketches.json.
No sketch batch is executed and no Fusion project is written.

Dependencies: use a user-owned venv; nothing is installed automatically.
  python3 -m venv "$HOME/.venvs/fmcad-image"
  "$HOME/.venvs/fmcad-image/bin/python" -m pip install -r ${JSON.stringify(requirements)}
Select it with --python "$HOME/.venvs/fmcad-image/bin/python".
See docs/IMAGE_BOUNDARIES.md for input restrictions, artifacts and limitations.`,
};

const boundariesImage = createImageCommand({
  mode: "boundaries",
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
      label: "Local boundary audit",
      requires:
        "Existing traced.svg, reference image.png and palette.json; new output directory and local Python dependencies.",
      argv: [
        "image",
        "boundaries",
        "--svg",
        "traced.svg",
        "--reference",
        "image.png",
        "--palette",
        "palette.json",
        "--out",
        "boundary-audit",
      ],
      output:
        "Unchanged image.boundaries worker JSON envelope with result.status inspected, blocked or ready. No CAD mutation; ready is sampled validation only.",
    },
  ],
  audit: {
    sources: [
      "src/image-boundaries.js",
      "assets/image_boundaries.py",
      "assets/image_shared_boundaries.py",
      "docs/IMAGE_BOUNDARIES.md",
    ],
    verified: [
      "local routing without configuration",
      "all flags and camelCase JSON stdin",
      "duplicates, unknown fields and required paths",
      "real-worker type/range rejection before output creation",
      "stdout/status passthrough and local failure guidance",
      "actual worker main compact unresolved reason counts with processing stubbed",
      "worker status and publication contract source review",
    ],
    tests: ["tests/image-boundaries.test.js"],
    gaps: [],
    bugs: [
      "Fake-interpreter CLI tests do not certify image quality or geometry. Raster working-resolution and sampled curve validation only; original curves can be refit globally. blocked publishes no repaired geometry; partial I/O failures are retained.",
    ],
  },
};

export { descriptor, boundariesImage, manual };

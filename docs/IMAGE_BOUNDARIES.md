# Local Image Boundaries

> Restored from the preserved 2026-10-20 diagnostic source snapshot. This is
> documentation of the local image workflow, not a new claim of CAD validation.

`fmcad image boundaries` inspects colored SVG gaps/overlaps against a local
reference, or attempts conservative reference-guided repair. It never opens a
Fusion document, loads connection configuration, selects a backend, uploads,
executes a sketch batch or writes a Fusion project. Inputs are not modified.

## Setup And Examples

Use a user-owned environment; the CLI installs nothing:

```bash
python3 -m venv "$HOME/.venvs/fmcad-image"
"$HOME/.venvs/fmcad-image/bin/python" -m pip install -r /path/to/fmcad/assets/image_boundaries_requirements.txt
fmcad image boundaries --svg traced.svg --reference image.png --palette palette.json --out boundary-audit --python "$HOME/.venvs/fmcad-image/bin/python"
fmcad image boundaries --svg traced.svg --reference labels.png --reference-mode labels --palette palette.json --out boundary-repair --mode repair --fit-error-px .35 --python "$HOME/.venvs/fmcad-image/bin/python"
fmcad image boundaries --file examples/image-boundaries-request.json --out another-audit --python "$HOME/.venvs/fmcad-image/bin/python" --json
fmcad help image boundaries
```

Replace `/path/to/fmcad` with the package location; detailed help prints its
resolved requirements path. `--python` selects a single local executable, not a
shell command, default `python3`. Windows venvs use `Scripts/python.exe`.
Examples require your existing SVG, reference and palette files, with matching
dimensions and declared colors; output names must not already exist.

## Request Contract

| Flag / JSON Field | Type, Range And Default |
| --- | --- |
| `--svg` / `svg` | Required local SVG path |
| `--reference` / `reference` | Required local reference image path |
| `--palette` / `palette` | Required local JSON file path, not inline JSON |
| `--out` / `out` | Required NEW directory with an existing parent |
| `--reference-mode` / `referenceMode` | `source` (default) or `labels` |
| `--mode` / `mode` | `inspect` (default) or `repair` |
| `--scale` / `scale` | Integer 1..4, default 2 |
| `--max-gap-width-px` / `maxGapWidthPx` | Finite positive source pixels, default 2 |
| `--max-overlap-width-px` / `maxOverlapWidthPx` | Finite positive source pixels, default 2 |
| `--max-changed-area-px` / `maxChangedAreaPx` | Finite positive source pixel area, default 500 |
| `--fit-error-px` / `fitErrorPx` | Finite positive source pixels <= 2, default 0.35 |
| `--corner-angle` / `cornerAngle` | Finite degrees 0..180, default 55 |
| `--width-mm` / `widthMm` | Finite positive millimeters, default 50 |
| `--mirror-x` / `mirrorX` | Boolean `true` or `false`, default `false` |

`--file` reads a JSON object using the fields above. Flags can supplement it but
cannot duplicate fields, even with the same value. Repeated flags and duplicate
top-level JSON keys (including escaped spellings) are errors. Unknown fields,
positional arguments, `--doc`, backend and global connection options are errors.
`--file`, `--python` and `--json` are CLI-only, not request fields. All flags take
values except help and `--json`; numeric CLI values accept `.35`, while JSON
files require standard JSON numbers such as `0.35`.

All paths are on the CLI host, relative to **invocation cwd**, including paths
inside request files, **not** relative to the request file's directory. No
Fusion/Windows path conversion occurs. The worker owns defaults and strict
semantic validation, including source validation before creating output.
No overwrite or cleanup occurs. Partial artifacts from runtime/I/O failures
remain for inspection; use a new output directory for a retry.

Palette rules follow [Image Tracing](IMAGE_TRACE.md). `source` composites RGBA
on white and applies palette rules with no preprocessing blur. `labels` requires
an opaque PNG containing exact declared palette/background RGB values. The
reference must have foreground. Palette rule bounds must fit the reference.

SVG dimensions and optional viewBox must match reference pixel edges. The worker
accepts only direct, nonempty paths with declared fills, supported path commands
and transforms, and `nonzero` fill-rule. Groups, external assets, declarations,
entities and unsupported attributes are rejected before rendering. This is a
restricted trace SVG workflow, not an arbitrary SVG editor.

## Repair Policy

`inspect` creates gap/overlap maps and component diagnostics without publishing
geometry. Its component statuses are `repairable`, `unresolved`, or
`protected_unchanged`. `repair` applies eligible mask edits and records
`repaired` instead of `repairable`.

Repairs use the reference's expected class only when it has nearby supporting
geometry. Internal gaps need multiple neighboring foreground colors; overlaps
must already include the expected owner. Width and cumulative changed-area
limits cap edits. Width is a conservative twice-maximum padded distance-transform
estimate divided by scale; defect components are 8-connected. These are image
heuristics, not physical manufacturing clearances. There is no global dilation.

Intentional reference-background holes are protected. Narrow pre-existing
silhouette/contour offsets are reported as `protected_unchanged`, retained in
the proposed mask partition rather than forcibly matched to the reference.
Their differences can therefore remain visible in after-gap maps. The separate
hole-integrity check uses 4-connected background and treats holes with padded
EDT diameter greater than `maxGapWidthPx` as significant. Closing, opening to
the exterior, splitting or merging a significant reference hole blocks
publication. Small holes below this threshold are not equivalently certified.

Ambiguous ownership, wide defects, exhausted area budgets and integrity failures
block repaired geometry publication. Diagnostic `after` maps may still contain
eligible proposed edits when some other defect blocks the whole result; they
are not evidence that geometry was published.

The shared helper fits one Bezier chain for a common boundary and uses that
exact chain in reverse for the adjacent color, rather than independently
fitting both sides. Separate rings are grouped per connected region to retain
holes. Publication checks closed finite L/C contours, sampled fit error and
exact ownership at the raster working resolution.

**Original curves are refit and can change globally, not only near repaired
pixels.** The fit tolerance is measured against the proposed label partition
(including protected pre-existing offsets), not against original SVG curves.
Raster working-resolution and sampled curve validation do not prove analytic
nonintersection, subpixel geometry correctness, valid CAD profiles or production
readiness. `widthMm` scales the reference foreground bounding-box width; sketch
payloads are XY, centered on that box, Y up, with explicit millimeters and
optional X mirroring.

## Results And Artifacts

The worker reads JSON stdin and emits an `image.boundaries` JSON envelope with
a **compact summary** in `result`; the CLI passes it through unchanged without
pretty printing. `--json` is an optional no-op. Diagnostics use stderr. Interpreter,
validation and worker exceptions return nonzero with local dependency guidance.

The summary includes `status`, `out`, gap/overlap/protected/unresolved/changed/
repairable areas, after-gap/overlap areas, `referenceHoleTopology`,
`geometryValidated`, `files`, `warnings`, and `sampledMaskValidated` when present.
`unresolvedReasonCounts` counts unresolved components by reason (falling back
to `unspecified` for an absent/empty reason); protected or repairable components
are not included in those counts. Full `components` records, request `parameters`
and detailed `fitValidation` remain in `report.json`, not stdout. Locate that
report via `result.files["report.json"]`.

| `result.status` | Meaning |
| --- | --- |
| `inspected` | Audit only, even when unresolved defects exist; no repaired geometry |
| `blocked` | Repair could not pass all publication gates; no repaired geometry published |
| `ready` | Repaired geometry artifacts published; **not** production-ready certification |

All three statuses use `success: true` and worker exit code zero. Consumers must
inspect `result.status`, `unresolvedReasonCounts`, warnings and files, plus full
component reasons in the report, not just process success. `geometryValidated`
remains `false`; only published results add `sampledMaskValidated: true` and
full-report `fitValidation`. No CAD validation occurs.

Every completed audit retains `report.json`, `original.svg`,
`original_reference<extension>`, `palette.json`, `reference.png`, `before.png`,
`after.png`, `before_labels.png`, `after_labels.png`, `gaps.png`, `overlaps.png`,
`unresolved.png`, `changed.png`, `protected.png`, `silhouette.png`, `audit.png`,
`after_gaps.png` and `after_overlaps.png`. Before-label images choose the first
palette color at overlaps; use the overlap map to see the ambiguity.

Only published geometry adds `repaired.svg`, `preview.png`, `overlay.svg`,
`overlay.png`, `sketches/*.json` and `import_sketches.json`. Review these locally
before considering any separate explicit CAD import. A low-level publication
I/O failure can leave partial files without a completed report; those files
must not be treated as a `ready` result.

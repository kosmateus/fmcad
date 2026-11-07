# Local Image Optimization

> Restored from the preserved 2026-10-20 diagnostic source snapshot. This is
> documentation of the local image workflow, not a new claim of CAD validation.

`fmcad image optimize` runs a local Python worker for deterministic **bounded
coarse-to-fine search** over image-trace settings. It is not Bayesian optimization
and makes no global-optimality guarantee. No document, config, MCP connection,
CAD operation, upload or save is required or performed.

## Setup And Usage

Use a user-owned environment. Nothing is installed automatically:

```bash
python3 -m venv "$HOME/.venvs/fmcad-image"
"$HOME/.venvs/fmcad-image/bin/python" -m pip install -r /path/to/fmcad/assets/image_optimize_requirements.txt
fmcad image optimize --input image.png --out image-search --palette palette.json --python "$HOME/.venvs/fmcad-image/bin/python" --trials 24 --seed 17 --top-k 3
fmcad image optimize --file request.json --out another-search --python "$HOME/.venvs/fmcad-image/bin/python"
fmcad image optimize --help
fmcad help image optimize
```

Replace `/path/to/fmcad` with the package location; command help prints its
resolved requirements path. `--python` selects one executable, not a shell
command, and defaults to `python3`. On Windows use the venv's `Scripts/python.exe`.

Example `request.json` for the second command:

```json
{"input":"image.png","palette":"palette.json","trials":24,"seed":17,"topK":3,"minFeatureArea":64,"weights":{"overlap":10,"gaps":100,"overlaps":100}}
```

## Request Contract

| Flag / Field | Contract |
| --- | --- |
| `--input` / `input` | Required local image path |
| `--out` / `out` | Required NEW directory with an existing parent |
| `--palette` / `palette` | Required local JSON file path, not inline JSON |
| `--reference` / `reference` | Optional local reference image path |
| `--base` / `base` | JSON object of fixed trace settings |
| `--search` / `search` | JSON object describing the bounded search space |
| `--trials` / `trials` | Integer 2..128, default 24 |
| `--seed` / `seed` | Integer, default 17 |
| `--top-k` / `topK` | Integer 1..10 and <= trials, default 3 |
| `--regions` / `regions` | JSON array of `{name,bounds:[left,top,right,bottom],weight}` |
| `--min-feature-area` / `minFeatureArea` | Positive integer pixel area (>= 1), default 64 |
| `--weights` / `weights` | JSON object of finite nonnegative weights: `boundary=1`, `overlap=10`, `corners=1`, `roughness=1`, `complexity=0.02`, `gaps=100`, `overlaps=100` (defaults) |

Partial weight objects inherit omitted defaults. Singular `overlap` weights
`1 - IoU`; plural `overlaps` weights actual distinct-color overlap area fraction.
They are separate inputs, not aliases. For example:

```bash
fmcad image optimize --input image.png --out weighted-search --palette palette.json --weights '{"overlap":10,"gaps":100,"overlaps":100}' --python "$HOME/.venvs/fmcad-image/bin/python"
```

The worker owns type/range validation, nested settings and search-space rules.
Pass object/array options as quoted JSON strings, e.g. `--base '{}' --search '{}'`
or `--regions '[{"name":"detail","bounds":[10,20,80,100],"weight":2}]'`
(the bounds must be valid for your image). Alternatively put the fields in
`--file request.json`. See [Image Tracing](IMAGE_TRACE.md) for trace tunables,
palette rules and optional local palette-rule bounds.

`traceDetailAreaPx2` is an opt-in trace setting and search axis, for example
`--trials 2 --top-k 2 --search '{"traceDetailAreaPx2":[1024]}'`. The normal baseline
is emitted first with value 0, followed by the adaptive candidate in this one-axis
two-trial search. Default search axes are unchanged. Do not combine an enabled
detail value with `traceScale=2`; those modes are mutually exclusive.
See [small cutout detail](IMAGE_TRACE.md#opt-in-small-cutout-detail) for dependencies,
units and strict refusal conditions. Candidate records retain `traceDetailAudit`,
and parameter/replay files retain the selected value. An unsupported bundle is
a candidate error, not permission to return a baseline SVG as an adaptive result.

Only the fields above are worker inputs. `--file`, `--python` and `--json` are
CLI-only. All flags require values except help and `--json`. Flags supplement
request files; repeated flags and fields duplicated between file and flags are
errors, even when values agree. Unknown flags/fields, positional arguments,
`--doc` and backend/global options are rejected. Numeric flags use JSON syntax.

All paths resolve on the CLI host, against the invocation cwd, **including paths
inside request files**, not the request file directory. No Fusion/Windows path
conversion occurs. Existing outputs are never overwritten. Partial artifacts
are retained on failure; retry with a new output directory, not the old one.

The worker receives JSON on stdin. Its stdout envelope is passed through
unchanged; `--json` is an optional no-op. Stdout is a compact summary with
`result.status`, `best`, `evaluatedTrials`, `eligibleCount`, `regions` (name/best),
`baselineBoundaryMetrics`, `bestBoundaryMetrics`, `files` and
`geometryValidated: false`, not the full report or candidate records.
Compact `best` contains `id`, `path`, `score` and `settings`, a reference to
`best_settings.json` containing reusable parameters. It does not contain inline
`parameters` or a full candidate. Full candidate parameters remain in
`report.json` and candidate records. `best` can be null.
Use the returned report/ranking paths for detailed metrics. Diagnostics use
stderr and interpreter or worker failures return nonzero with a dependency setup hint.

## Review And Reuse

All candidates use the same fixed original/reference for evaluation, not each
candidate's own smoothed input. Inspect ranking metrics, topology eligibility
gates and optional regions diagnostics together with the previews. Exact metric
formulas and search details belong to the worker/report; this
CLI guide does not claim a particular unverified formula or quality threshold.
Regional winners are diagnostics, **not automatically composed CAD geometry**.

### Scoring Masks

Reference and candidate independently retain an original 8-connected color
component only when it contains an 8-connected core of at least `minFeatureArea`
pixels after 3x3 binary opening with a zero border. A retained component is
reconstructed to its **full original mask**, preserving its original contour,
not the opened contour. Boundary, IoU and corner metrics use these masks.
Raw labels and frozen `reference.png` are not modified; reference metric masks
are cached once and never adapted to candidates.

Insignificant components therefore do not dominate fidelity metrics. When
neither side has a retained component, `scoringActive` is false, distances are
zero and IoU is one; that color is excluded from scope fidelity averages.
Significant background participates when active. A missing retained feature
remains active and receives the missing-boundary penalty. Topology eligibility
still uses original labels and its separate opening/counting recipe, not these
reconstructed scoring masks. Narrow real features can also be ignored by these
heuristics; inspect the images as well as the scores. Consult the current
report's `metricDefinition` and weights for exact metric/limit contracts.

### Gap And Overlap Audit

These additional ranking metrics use **independent SVG foreground-color masks**,
not the final composited preview or pruned fidelity masks. Each color is rendered
separately at scale 1 (one source pixel per sample), with alpha >= 128 marking
occupancy. Same-color paths union by alpha compositing without double counting;
their winding rules are not combined, so compound-path holes remain within each
path. Background SVG paths are excluded. Later color painting cannot hide
distinct-color overlap from this audit.

Raw gaps are unpruned fixed-reference foreground pixels with zero color occupancy.
Only internal gaps at reference-foreground EDT depth > 2 pixels enter the gap
score. Depth is computed on the full reference with a one-pixel background border,
then cropped for regions. Intentional reference-background holes are excluded.
Shallower contour-offset gaps are still reported as `contourOffsetGapAreaPx`,
but are not included in the gap score. `gapFraction` equals
`internalGapAreaPx / max(1, referenceForegroundAreaPx)`.

Actual overlap means more than one distinct foreground color occupies a sample,
including samples outside reference foreground. `overlapFraction` equals
`overlapAreaPx / max(1, referenceForegroundAreaPx)`. Each scope's score adds
`weights.gaps * gapFraction` and `weights.overlaps * overlapFraction`; the
singular `weights.overlap` remains the separate IoU fidelity weight.

Both full `report.json` and compact stdout contain `baselineBoundaryMetrics`
and `bestBoundaryMetrics`, keyed by scope (`fullImage` and requested region
names). Baseline metrics describe the first evaluated candidate, or are null
if it has no scope results; best metrics are null without an eligible winner.
Per-candidate scope `boundaryMetrics` remain in the full report. They include
raw/internal/contour-offset gap and overlap areas/fractions, 8-connected
component counts, largest-component areas and approximate inscribed widths.

These are ranking penalties, not repairs or changes to topology eligibility.
**This does not guarantee a subpixel gap-free model.** Scale-1 raster samples
can miss subpixel defects; even zero scored gaps does not imply zero raw gaps,
analytic shared boundaries, valid CAD profiles or manufacturing readiness.

Artifacts include `ranking.json`, `report.json`, `candidates.jsonl`,
`best_settings.json`, `top_candidates.png` and direct `candidate_000/`,
`candidate_001/`, ... subdirectories under the output directory, **not** a
`candidates/` parent folder. Candidate directories hold the trace artifacts;
optional regional sheets are `region_000_top.png`, etc. A report can have
`best: null` with `no_eligible_candidate`: this is **not a ready result**, even
if diagnostic artifacts exist. Do not assume a usable best-settings request in
that case. A score or topology gate does not certify CAD profiles, solids or
manufacturing suitability.

When an eligible best exists, `best_settings.json` omits `out` so it can be
reused with a fresh trace output directory and an explicitly selected interpreter:

```bash
fmcad image trace --file image-search/best_settings.json --out NEW --python "$HOME/.venvs/fmcad-image/bin/python"
```

This remains local tracing only. Review its outputs before any separate,
explicit CAD import. Optimization never imports or composes regional winners.

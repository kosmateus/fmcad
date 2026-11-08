const path = require('node:path');
const { resolveRuntimePaths, resolvePython } = require('./dist/config-platform/index.js');
const { runImagePipeline } = require('./dist/core/application/local-pipeline');
const { createLocalWorker, localPipelineFiles } = require('./dist/python/local-pipeline');
const { redactDiagnostic } = require('./diagnostics');

const tunables = {
  base: 'JSON object of fixed trace settings',
  search: 'JSON object describing the bounded search space',
  trials: 'integer [2, 128]; default 24',
  seed: 'integer; default 17',
  'top-k': 'integer [1, 10], <= trials; default 3',
  regions: 'JSON array of {name, bounds: [left, top, right, bottom], weight}',
  'min-feature-area': 'positive integer pixel area (>= 1); default 64',
  weights: 'JSON object of finite nonnegative weights: boundary=1, overlap=10, corners=1, roughness=1, complexity=0.02, gaps=100, overlaps=100 (defaults)',
};
const assets = resolveRuntimePaths({ anchor: __filename }).assets;
const worker = path.join(assets, 'image_optimize.py');
const requirements = path.join(assets, 'image_optimize_requirements.txt');
const descriptor = {
  usage: 'image optimize --input PATH --out NEWDIR --palette JSON [--python EXE] [options] [--json]',
  desc: 'LOCAL deterministic bounded image-trace search and artifacts only. No CAD, --doc, MCP, config or connection required.',
  example: 'fmcad image optimize --input image.png --out image-search --palette palette.json --trials 24 --python python3',
  extra: `Alternative: fmcad image optimize --file request.json [additional input flags] [--python EXE] [--json]
All flags require values except --json and help. --palette is a JSON FILE path.
Required request paths: input, out, palette. Optional --reference is a local image path.
Request keys: input, out, palette, reference, base, search, trials, seed, topK, regions, minFeatureArea, weights.
--base, --search, --regions and --weights accept JSON strings, or use those fields in --file.
Flags may supplement --file; duplicate fields or repeated options are errors, not last-wins overrides.
Unknown options/fields are rejected. --python is CLI-only, defaults to python3, and never enters the request.
All paths are CLI-host local. Relative paths, including values inside request.json, resolve against
the invocation cwd, NOT the request file directory. No Fusion/Windows path conversion.
out must be NEW with an existing parent. No overwrite or cleanup; partial failures are retained.
Worker stdout JSON envelope is passed through unchanged; --json is an optional no-op.
Diagnostics use stderr and failures return nonzero.

Options (types, ranges and nested settings validated by the worker):
${Object.entries(tunables).map(([key, spec]) => `  --${key}: ${spec}`).join('\n')}

Deterministic BOUNDED coarse-to-fine search, not Bayesian optimization or a global-optimality guarantee.
All candidates are evaluated against the same fixed original/reference, not their own smoothed input.
Review ranking metrics, topology gates and optional regions diagnostics. Regional winners are NOT
automatically composed into CAD. Scores are not CAD or manufacturing certification.
Singular overlap weights 1-IoU; plural overlaps weights actual distinct-color overlap area fraction.
gaps weights internal gap area fraction. SVG foreground colors are rendered independently at
scale 1, alpha >= 128; same-color paths union without double counting, background paths excluded.
Gap scoring uses unpruned reference foreground with EDT depth > 2 pixels; intentional reference
background holes are excluded. Raw gaps and contour offsets are reported, but contour offsets
are not included in the gap score. These ranking penalties do not repair geometry or change topology gates.
This does NOT guarantee a subpixel gap-free model.
Outputs: ranking.json, report.json, candidates.jsonl, best_settings.json, top_candidates.png
and direct candidate_000/, candidate_001/, ... subdirectories (not candidates/).
Stdout is a compact summary; full candidate metrics and scoring-mask policy live in report.json.
Report and stdout include baselineBoundaryMetrics and bestBoundaryMetrics by scope (or null).
Compact best contains id, path, score and settings (a parameter-file reference), not inline
parameters or a full candidate. Full candidates and their parameters remain in report.json.
The report can contain best:null with no_eligible_candidate; this is NOT a ready result.
When an eligible best exists, best_settings.json omits out and can be reused explicitly:
  fmcad image trace --file image-search/best_settings.json --out NEW --python EXE

Dependencies: use a user-owned venv; nothing is installed automatically.
  python3 -m venv "$HOME/.venvs/fmcad-image"
  "$HOME/.venvs/fmcad-image/bin/python" -m pip install -r ${JSON.stringify(requirements)}
Select that interpreter with --python "$HOME/.venvs/fmcad-image/bin/python".
See docs/IMAGE_OPTIMIZE.md for the local workflow and docs/IMAGE_TRACE.md for palette rules.`,
};

async function optimizeImage(args, deps) {
  let setup;
  const process = createLocalWorker({
    redactDiagnostic,
    resolveWorker: () => worker,
    resolvePython: plan => {
      const python = (deps.resolvePython || resolvePython)({ pythonPath: plan.python, feature: 'image-optimize' });
      setup = `Image optimization dependencies: run ${JSON.stringify(python)} -m pip install -r ${JSON.stringify(requirements)} in your user-owned environment. Nothing was installed automatically.\n`;
      return python;
    },
    ...(deps.spawnImageOptimize ? { spawn: deps.spawnImageOptimize } : {}),
    stdout: chunk => deps.stdout.write(chunk),
    stderr: chunk => deps.stderr.write(chunk),
    startError: (error, plan) => new Error(`Cannot start local Python ${JSON.stringify(plan.python)}: ${error.message}. Select an installed interpreter with --python EXE.\n${setup}`),
  });
  const result = await runImagePipeline('optimize', args, localPipelineFiles, process);
  if (result.code !== 0) deps.stderr.write(`image optimize worker failed (${result.signal || result.code}). ${setup}`);
  return result.code === 0 ? 0 : 1;
}

const manual = {
  sections: [{ title: 'Local Return Contract', text: descriptor.desc }],
  examples: [{ label: 'Bounded local search', requires: 'Existing image.png and palette.json, new output directory and local Python dependencies.',
    argv: ['image', 'optimize', '--input', 'image.png', '--out', 'image-search', '--palette', 'palette.json'],
    output: 'Unchanged worker JSON envelope and local search artifacts; inspect best and eligibility before reuse. No CAD mutation.' }],
  audit: {
    sources: ['src/image-optimize.js', 'assets/image_optimize.py', 'docs/IMAGE_OPTIMIZE.md'],
    verified: ['local routing without configuration', 'exact flag mapping and JSON stdin', 'duplicate/unknown fields and required paths', 'stdout passthrough and failure guidance', 'documented weights/request validated before image decoding', 'actual worker main compact best refs and boundary metrics with processing stubbed'],
    tests: ['tests/image-optimize.test.js'], gaps: [],
    bugs: ['Transport tests use a fake interpreter; actual worker schema/summary tests stop before image decoding or stub processing. These tests do not certify image quality. Scale-1 boundary metrics do not guarantee a subpixel gap-free model. Bounded search is not globally optimal or CAD validation. Partial outputs are retained; best may be null.'],
  },
};

module.exports = { descriptor, optimizeImage, manual };

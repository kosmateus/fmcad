'use strict';
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { validateRunIdentity, formatRunOutput } = require('./run');
const application = require('./dist/core/application/review');
const adapters = require('./dist/review');
const { resolveRuntimePaths } = require('./dist/config-platform');

const views = application.REVIEW_VIEWS;
const flags = Object.fromEntries(['--doc', '--doc-id', '--doc-file-id', '--out', '--width', '--height', '--recipes'].map(f => [f, 'value']));
const descriptor = {
  usage: 'review --doc <name> (--doc-id <creationId> | --doc-file-id <cloudId>) --out <new-local-directory> [--width N] [--height N] [--recipes <json-array>]',
  desc: 'Capture default or selected orientation/ROI/detail/section views with identity and restoration evidence. Requires visual review; never CAD acceptance.',
  example: 'fmcad review --doc Model --doc-id DISCOVER_CREATION_ID --out ./review-new',
};

function parseReviewArgs(args) {
  const values = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!Object.hasOwn(flags, flag)) throw new Error('Unknown review option: ' + flag);
    if (Object.hasOwn(values, flag)) throw new Error('Duplicate review option: ' + flag);
    const value = args[++i];
    if (typeof value !== 'string' || !value.trim() || value.startsWith('-')) throw new Error(flag + ' requires a value');
    values[flag] = value;
  }
  if (!values['--doc'] || (!values['--doc-id'] && !values['--doc-file-id'])) throw new Error('review requires --doc and --doc-id or --doc-file-id');
  validateRunIdentity(values, false);
  if (!values['--out']) throw new Error('review requires --out <new-local-directory>');
  if (process.platform !== 'win32' && /^[A-Za-z]:[\\/]|^\\\\/.test(values['--out'])) throw new Error('--out must be a CLI-local path, not a Windows/UNC path');
  const dimension = (flag, fallback) => {
    const value = values[flag] ?? String(fallback);
    if (!/^\d+$/.test(value) || Number(value) < 32 || Number(value) > 4096) throw new Error(flag + ' must be an integer from 32 to 4096');
    return Number(value);
  };
  const width = dimension('--width', 1600), height = dimension('--height', 1200);
  if (width * height > 16000000) throw new Error('review images must not exceed 16 megapixels');
  let recipes;
  if (values['--recipes'] !== undefined) {
    try {
      recipes = JSON.parse(values['--recipes']);
    } catch {
      throw new Error('--recipes must be a JSON array');
    }
    if (!Array.isArray(recipes)) throw new Error('--recipes must be a JSON array');
  }
  return { doc: values['--doc'], docId: values['--doc-id'] ?? null, docFileId: values['--doc-file-id'] ?? null,
    out: path.resolve(values['--out']), width, height, ...(recipes === undefined ? {} : { recipes }) };
}

function buildReviewScript(request) {
  return adapters.prepareReviewArtifact(request, resolveRuntimePaths({ anchor: __filename }).runtime).script;
}

function verifyReport(report, request) {
  const normalized = { ...request, docId: request.docId ?? null, docFileId: request.docFileId ?? null };
  return application.verifyReviewReport(report, normalized);
}

// Same client.callTool contract as docops; caller supplies the existing CLI path mapper.
// A fourth argument supplies streams for offline tests/embedding, not another backend.
async function reviewCmd(client, args, toWindowsPath, io = process) {
  const options = parseReviewArgs(args);
  if (typeof toWindowsPath !== 'function') throw new Error('review requires the CLI Fusion path mapper');
  const fusionOut = ['win32', 'darwin'].includes(process.platform) ? options.out : toWindowsPath(options.out);
  const request = { ...options, fusionOut, requestId: randomUUID() };
  const injected = io.reviewPorts || {};
  const outcome = await application.executeReview(request, {
    artifacts: injected.artifacts || adapters.createReviewArtifactStore(),
    execution: injected.execution || adapters.createReviewExecutionPort(client, formatRunOutput),
    preparation: injected.preparation || adapters.createReviewPreparationPort(
      resolveRuntimePaths({ anchor: __filename }).runtime,
    ),
    sha256: injected.sha256 || adapters.sha256ReviewImage,
  });
  const manifestPath = path.join(options.out, 'manifest.json');
  const stdout = io.stdout || io;
  stdout.write(JSON.stringify({ ...outcome.report, transportStatus: outcome.transport, artifactStatus: outcome.artifacts,
    cadAcceptance: outcome.cadAcceptance, ...(outcome.manifestWritten ? { manifestPath } : {}) }) + '\n');
  return outcome.code;
}

const manual = {
  sections: [
    { title: 'Input Contract', text: 'No positionals. Required --doc is an exact unique open top-level name; --doc-id (creationId) or --doc-file-id (DataFile.id) pins it, both may be supplied and must match. Duplicate names fail even with an ID. Required --out is a new CLI-local directory with an existing parent; relative paths resolve against cwd before the existing WSL path mapper. Existing directories, files and symlinks are rejected. --width/--height are integer pixels, defaults 1600/1200, each 32..4096 and total <=16,000,000. Optional --recipes is a JSON array of 1..32 unique orientation/ROI/detail/section recipes using the ReviewCaptureRecipe contract. No overwrite flag.' },
    { title: 'Return Contract', text: 'One JSON result and manifest.json. Success means every requested recipe PNG was captured and state restoration verified. Without --recipes, the default set remains front, back, left, right, top, bottom, iso-top-left and iso-bottom-right. All use orthographic projection; framing and presentation depend on each recipe. documentIdentity includes creationId/fileId/version/isSaved/isModified; fusionBuild, selected recipes, per-view camera, filenames, bytes and SHA256 are recorded. requiresVisualReview=true always. Exit 1 for capture, restoration, transport, identity or readback failures. Partial images and backend-report.json are retained; missing terminal evidence is unknown, never success.' },
    { title: 'Prerequisites And Safety', text: 'Requires an owned, idle Fusion instance and a uniquely named already-open Design. One backend script invocation; no retry, cloud open, geometry edit or document save. This changes viewport/UI state and is not submitted as readOnly. try/finally restores target and original camera/projection/framing, visual style, component-colour display and original active document with independent error reporting. CLI and Fusion must share the mapped output directory; request.json verifies mapping. Transport timeout does not cancel the backend: inspect durable evidence and current state before further work. Current visibility, sections, selection and graphics determine the image; this does not inspect hidden interiors, generate critical-interface closeups, assess interference or confer CAD/physical acceptance.' },
  ],
  examples: [{ label: 'Pinned open document', argv: ['review', '--doc', 'Model', '--doc-id', 'DISCOVER_CREATION_ID', '--out', './review-new'],
    requires: 'Replace Model and DISCOVER_CREATION_ID with the exact open name and discovered creationId. Own Fusion, finish interactive commands, and choose a fresh mapped destination. This example is not run by help.',
    output: 'manifest.json and eight named PNGs; status captured with requiresVisualReview=true only after capture and restoration succeed.' }],
  audit: { sources: ['src/review.js:parseReviewArgs,buildReviewScript,reviewCmd', 'packages/core/src/application/review', 'packages/node-adapters/src/review', 'runtime/python/fmcad/adapters/fusion/legacy_review.py', 'runtime/python/fmcad/domain/review.py', 'assets/review.py (compatibility fixture)'],
    verified: ['offline argument and destination validation', 'single script dispatch and complete durable/terminal report comparison', 'identity and active-command guards', 'independent restoration and preserved partial failure outputs using SDK stubs', 'primary-owned scratch qualification on Fusion2705.1.25: eight images personally inspected, orthogonal/isometric camera vectors verified, target/original viewport and active document restored'],
    tests: ['tests/review-application.test.js', 'tests/review.test.js', 'tests/review_test.py', 'tests/shot.test.js'],
    gaps: [],
    bugs: ['Live qualification covers Fusion2705.1.25 and the tested mapped filesystem only, not every SDK/build. The viewOrientation getter can return arbitrary after a successful named view; actual camera-vector relationships are checked instead. Current visibility/sections determine the images; capture is not CAD or physical acceptance.'] },
};

module.exports = { reviewCmd, parseReviewArgs, buildReviewScript, verifyReport, views, flags, descriptor, manual };

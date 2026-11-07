const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { cadBundleUnits } = require('../../packages/node-adapters/dist/python/bundle');
const { preparePythonArtifact } = require('../../packages/node-adapters/dist/python/artifact');

const root = path.resolve(__dirname, '../..');
const temporaryRoot = fs.mkdtempSync(path.join('/tmp/opencode', 'fmcad-types-geometry-'));
const outputPath = process.argv[2] ? path.resolve(process.argv[2]) : null;

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function verifyDefinitions(typingRoot) {
  const current = JSON.parse(fs.readFileSync(path.join(typingRoot, 'current.json'), 'utf8'));
  if (typeof current.snapshot !== 'string' || !/^[a-f0-9]{64}$/.test(current.snapshot))
    throw new Error('Invalid published Autodesk definitions pointer');
  const snapshot = path.join(typingRoot, 'snapshots', current.snapshot);
  const manifestBytes = fs.readFileSync(path.join(snapshot, 'manifest.json'));
  if (hash(manifestBytes) !== current.snapshot)
    throw new Error('Published Autodesk definitions manifest hash mismatch');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  for (const [relative, expected] of Object.entries(manifest.files ?? {})) {
    if (typeof expected !== 'string' || hash(fs.readFileSync(path.join(snapshot, relative))) !== expected)
      throw new Error(`Published Autodesk definition hash mismatch: ${relative}`);
  }
  return { current, snapshot };
}

function main() {
  const typingRoot = path.join(root, 'dist/runtime/python/typing');
  const { current, snapshot } = verifyDefinitions(typingRoot);
  const units = cadBundleUnits(root, 'full');
  const artifact = preparePythonArtifact(units);
  const context = { kind: 'cad-v1', deferredFacade: true };
  const inventory = spawnSync('python3', [
    '-I', '-S', path.join(typingRoot, 'checker-project.py'),
  ], {
    input: JSON.stringify({ units: [{ id: 'wire', filename: '<fmcad-artifact>', source: artifact.script, context }] }),
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (inventory.status !== 0) throw new Error(inventory.stderr || `AST inventory exited ${inventory.status}`);
  const inventoryResult = JSON.parse(inventory.stdout);
  const stubs = path.join(temporaryRoot, 'stubs');
  fs.mkdirSync(stubs, { recursive: true });
  fs.cpSync(path.join(snapshot, 'adsk'), path.join(stubs, 'adsk'), { recursive: true });
  fs.copyFileSync(path.join(typingRoot, 'fmcad_context.pyi'), path.join(stubs, 'fmcad_context.pyi'));
  fs.writeFileSync(path.join(stubs, 'fmcad_injected.pyi'),
    'import adsk.core\nfrom fmcad_context import Facade\nFMCAD: Facade\n');
  const locations = [];
  for (const [index, unit] of inventoryResult.units.entries()) {
    const prelude = [];
    if (unit.context.app || unit.context.ui || unit.context.deferredFacade)
      prelude.push('from typing import TYPE_CHECKING', 'if TYPE_CHECKING:');
    if (unit.context.app) prelude.push('    from fmcad_injected import app');
    if (unit.context.ui) prelude.push('    from fmcad_injected import ui');
    if (unit.context.deferredFacade) prelude.push('    from fmcad_injected import FMCAD');
    const lines = unit.source.split('\n');
    lines.splice(unit.insert, 0, ...prelude);
    const filename = `unit-${index}.py`;
    fs.writeFileSync(path.join(temporaryRoot, filename), lines.join('\n'));
    locations.push({ filename, unit, preludeLines: prelude.length });
  }
  fs.writeFileSync(path.join(temporaryRoot, 'pyrightconfig.json'), JSON.stringify({
    include: locations.map((location) => location.filename),
    exclude: ['stubs'], stubPath: 'stubs', extraPaths: [],
    pythonVersion: '3.11', pythonPlatform: 'Linux', typeCheckingMode: 'strict',
    useLibraryCodeForTypes: false,
    reportMissingImports: 'error', reportMissingModuleSource: 'error', reportMissingTypeStubs: 'error',
    reportAny: 'error', reportExplicitAny: 'error', enableTypeIgnoreComments: false,
    reportUnusedImport: 'none', reportUnusedVariable: 'none', reportUnusedFunction: 'none',
  }));
  const engine = require.resolve('basedpyright/index.js');
  const checked = spawnSync(process.execPath, [
    '--max-old-space-size=512', engine, '--outputjson', '--pythonpath',
    path.join(temporaryRoot, 'no-host-python'), '--project', path.join(temporaryRoot, 'pyrightconfig.json'),
  ], { cwd: temporaryRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (![0, 1].includes(checked.status)) throw new Error(checked.stderr || `basedpyright exited ${checked.status}`);
  const report = JSON.parse(checked.stdout);
  const sourceMap = artifact.sourceMap;
  const filenames = new Map(units.map(({ id, filename }) => [id, filename]));
  const byFile = new Map();
  for (const diagnostic of report.generalDiagnostics) {
    const location = locations.find(({ filename }) => path.basename(diagnostic.file) === filename);
    if (!location) throw new Error(`Diagnostic is outside prepared source units: ${diagnostic.file}`);
    const line = diagnostic.range.start.line + 1;
    const originalLine = line > location.unit.insert ? line - location.preludeLines : line;
    let filename = location.unit.filename;
    let sourceLine = originalLine;
    if (filename === '<fmcad-artifact>') {
      const entry = sourceMap.find((item) => item.generatedStartLine <= originalLine && originalLine <= item.generatedEndLine);
      if (!entry) throw new Error(`Cannot map prepared line ${originalLine}`);
      filename = filenames.get(entry.unitId);
      sourceLine = originalLine - entry.generatedStartLine + entry.sourceStartLine;
    }
    const rows = byFile.get(filename) ?? [];
    rows.push({ line: sourceLine, rule: diagnostic.rule, message: diagnostic.message });
    byFile.set(filename, rows);
  }
  const geometry = Object.fromEntries([...byFile.entries()]
    .filter(([filename]) => filename.includes('/geometry_'))
    .map(([filename, diagnostics]) => [filename, diagnostics]));
  const result = {
    checker: report.version,
    context,
    preparedArtifactHash: artifact.artifactHash,
    preparedWireBytes: artifact.bytes.length,
    preparedUnits: artifact.units.length,
    analyzedUnits: report.summary.filesAnalyzed,
    definitionsSnapshot: current.snapshot,
    strictDiagnostics: report.summary,
    geometryDiagnosticCount: Object.values(geometry).reduce((sum, rows) => sum + rows.length, 0),
    geometry,
    dependencyFiles: Object.fromEntries([...byFile.entries()]
      .filter(([filename]) => !filename.includes('/geometry_'))
      .map(([filename, diagnostics]) => [filename, diagnostics.length])),
  };
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
  }
  console.log(JSON.stringify({
    checker: result.checker, preparedArtifactHash: result.preparedArtifactHash,
    preparedWireBytes: result.preparedWireBytes, preparedUnits: result.preparedUnits,
    analyzedUnits: result.analyzedUnits, definitionsSnapshot: result.definitionsSnapshot,
    strictDiagnostics: result.strictDiagnostics,
    geometryDiagnosticCount: result.geometryDiagnosticCount,
    geometry: Object.fromEntries(Object.entries(geometry).map(([filename, rows]) => [filename, rows.length])),
    dependencyFiles: result.dependencyFiles, outputPath,
  }, null, 2));
}

try {
  main();
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

const fs = require('fs');
const path = require('path');
const { pythonValue, preparePythonArtifact } = require('./python');

const OPS = {
  projects: 0,
  project_create: 1,
  project_rename: 2,
  folder_list: 1,
  folder_create: 2,
  folder_rename: 3,
  folder_delete: 2,
  file_rename: 4,
  file_move: 4,
  file_delete: 3,
  file_editability: 0,
  file_editability_list: 0,
  tree: 1,
  param_list: 0,
  param_add: 2,
  param_set: 2,
  param_rename: 2,
  param_delete: 1,
  plane_list: 0,
  plane_add: 4,
  plane_rename: 2,
  plane_delete: 1,
  stats: 0,
  bbox: 0,
  bodies: 0,
  comp_list: 0,
  comp_add: 1,
  rollback: 1,
  units: 1,
  upload: 1,
};

const DOCUMENT_OPS = ['param', 'plane', 'stats', 'bbox', 'bodies', 'comp', 'rollback', 'units'];

function scriptFileForOp(op) {
  if (op === 'stats' || op === 'bbox' || op === 'bodies' || op === 'rollback' || op === 'units') return 'inspect.py';
  if (op === 'comp_list' || op === 'comp_add') return 'component.py';
  if (op === 'upload') return 'upload.py';
  return 'fusion_data_manager.py';
}

function prepareOpScript(op, args) {
  const paths = require('./dist/config-platform').resolveRuntimePaths({ anchor: __filename });
  const family = { 'inspect.py': 'legacy-inspect', 'upload.py': 'legacy-upload' }[scriptFileForOp(op)];
  if (family) {
    const { documentIoFamilyUnits } = require('./dist/python/document-io-manifest');
    const units = documentIoFamilyUnits(paths.runtime, family).map((unit, index, all) => ({ ...unit,
      role: index === all.length - 1 ? 'wrapper' : 'runtime',
      source: unit.source.replace('OP = "help"', () => 'OP = ' + pythonValue(op))
        .replace('ARGS = []', () => 'ARGS = ' + pythonValue(args)) }));
    return preparePythonArtifact(units, { request: { op, args } });
  }
  const file = path.join(paths.assets, scriptFileForOp(op));
  let code = fs.readFileSync(file, 'utf8');
  code = code.replace('OP = "help"', () => 'OP = ' + pythonValue(op));
  code = code.replace('ARGS = []', () => 'ARGS = ' + pythonValue(args));
  return preparePythonArtifact([{ id: 'operation', filename: 'assets/' + scriptFileForOp(op),
    source: code, role: 'wrapper' }], { request: { op, args } });
}

function buildOpScript(op, args) { return prepareOpScript(op, args).script; }

function prepareExportScript(args) {
  const { runtime } = require('./dist/config-platform').resolveRuntimePaths({ anchor: __filename });
  const { documentIoFamilyUnits } = require('./dist/python/document-io-manifest');
  const units = documentIoFamilyUnits(runtime, 'legacy-export').map((unit, index, all) => ({ ...unit,
    role: index === all.length - 1 ? 'wrapper' : 'runtime',
    source: unit.source.replace('OP = "help"', 'OP = "export"')
      .replace('ARGS = []', () => 'ARGS = ' + pythonValue(args)) }));
  return preparePythonArtifact(units, { request: { op: 'export', args } });
}

function buildExportScript(args) { return prepareExportScript(args).script; }

module.exports = { OPS, DOCUMENT_OPS, buildOpScript, buildExportScript, prepareOpScript, prepareExportScript };

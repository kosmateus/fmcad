'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { familyDescriptors, readPackage, checkRows, aggregateStatus, collectSources, envelope, outputDirectory } = require('./drawing-package');

const descriptors = { 'drawing.check': familyDescriptors['drawing.check'] };

function validate(operation, data) {
  if (!descriptors[operation]) return;
  if (data.schemaVersion !== 1) throw new Error(operation + ' schemaVersion must be 1');
  for (const key of ['package', 'out']) if (!Object.hasOwn(data, key)) throw new Error(operation + ' requires ' + key);
}

function execute(operation, data) {
  validate(operation, data);
  const out = outputDirectory(data.out);
  const { report, identity } = readPackage(data.package, 'drawing.package');
  const model = report.result;
  const rows = checkRows(model);
  const sources = collectSources(model);
  const status = aggregateStatus(rows, sources);
  const created = [path.join(out, 'report.json')];
  const result = envelope('drawing.check', {
    schemaVersion: 1, documentIdentity: model.documentIdentity, package: identity, scene: { sha256: model.scene.sha256 },
    checks: rows, statusSummary: status, sourceMap: model.sourceMap,
  }, status, ['Checks recompute from the stored canonical model; package and scene hashes are verified. A passing check never certifies 3D geometry or manufacturing.'], [identity, ...sources], created);
  fs.mkdirSync(out, { recursive: false });
  try { fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(result, null, 2), { flag: 'wx' }); }
  catch (error) { fs.rmSync(out, { recursive: true, force: true }); throw error; }
  return { ...result, reportPath: path.join(out, 'report.json') };
}

module.exports = { descriptors, validate, execute };

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// These are artifacts written by existing fmcad workflows, not generic repo markers.
const markers = [
  ['.cad/logs/fmcad.log', 'file'], ['fmcad.log', 'file'],
  ['.fmcad-batch', 'directory'],
  ['.cad/telemetry/direct', 'directory'],
  ['.cad/telemetry/clients', 'directory'], ['.cad/results', 'directory'],
];

function projectAt(directory) {
  const root = fs.realpathSync(directory);
  if (!fs.statSync(root).isDirectory()) throw new Error(`Project path is not a directory: ${directory}`);
  for (const [name, kind] of markers) {
    try {
      const stat = fs.statSync(path.join(root, name));
      if (kind === 'file' ? stat.isFile() : stat.isDirectory()) return root;
    } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
  }
  return null;
}

function resolveProject({ project, cwd = process.cwd() } = {}) {
  if (project !== undefined) {
    const candidate = path.resolve(cwd, project);
    const root = projectAt(candidate);
    if (!root) throw new Error(`No fmcad project artifacts at ${candidate}. Select an existing project with --project PATH.`);
    return root;
  }
  let current = fs.realpathSync(cwd);
  for (;;) {
    const root = projectAt(current);
    if (root) return root;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

module.exports = { resolveProject, projectAt };

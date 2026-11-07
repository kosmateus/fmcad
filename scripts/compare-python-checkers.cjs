'use strict';
// Development-only comparison. Both engines must already be installed; this
// script performs no downloads, installation, Python execution or SDK calls.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const pyright = process.argv[2];
if (!pyright) throw new Error('Pass the preinstalled Pyright index.js path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fmcad-comparison-'));
try {
  const fixtures = path.resolve(__dirname, '../tests/fixtures/python-checker');
  fs.cpSync(fixtures, directory, { recursive: true });
  fs.writeFileSync(path.join(directory,'adsk/__init__.py'),'');
  fs.writeFileSync(path.join(directory,'pyrightconfig.json'),JSON.stringify({include:['errors.py','unknown.py'],typeCheckingMode:'strict',pythonVersion:'3.11',reportUnusedImport:'none'}));
  for (const engine of [require.resolve('basedpyright/index.js'), path.resolve(pyright)]) {
    const start = performance.now();
    const output = spawnSync(process.execPath,[engine,'--outputjson','--pythonpath',path.join(directory,'no-host-python'),'--project',path.join(directory,'pyrightconfig.json')],{cwd:directory,encoding:'utf8',timeout:30000,maxBuffer:1024*1024,env:{PATH:process.env.PATH,HOME:directory}});
    if (output.error || output.status !== 1) throw new Error(JSON.stringify(output));
    const result = JSON.parse(output.stdout);
    console.log(JSON.stringify({engine:engine.includes('basedpyright')?'basedpyright':'pyright',version:result.version,exit:output.status,elapsedMs:Math.round(performance.now()-start),diagnostics:result.generalDiagnostics.map(d=>({file:path.basename(d.file),line:d.range.start.line+1,rule:d.rule,severity:d.severity}))},null,2));
  }
} finally { fs.rmSync(directory,{recursive:true,force:true}); }

// Offline bundle writer. The single Fusion operator runs the resulting script.
const fs = require('node:fs');
const path = require('node:path');
const { buildCadScript } = require('../../src/cad');

const [doc, destination] = process.argv.slice(2);
if (!doc || !destination || process.argv.length !== 4) throw new Error('Usage: node tests/native/gm06-handoff.js <disposable-document-name> <new-script.py>');
const source = buildCadScript('status', {}, { doc }) + '\nimport time\n' + fs.readFileSync(path.join(__dirname, 'gm06_fixture.py'), 'utf8');
fs.writeFileSync(destination, source, { flag: 'wx' });
console.log(`Wrote native GM06 fixture: ${destination}. Not executed.`);

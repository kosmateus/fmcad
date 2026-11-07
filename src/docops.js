const { executeDocumentCommand } = require('./dist/core/application/documents/commands');
const { documentCommandPorts } = require('./dist/node-adapters/persistence/document-commands');
const { shotCmd } = require('./shot');

function createDocumentService(client, toWindowsPath = value => value) {
  const ports = documentCommandPorts((data, tool) => client.callTool(data, tool), toWindowsPath);
  return { execute: command => executeDocumentCommand(command, ports) };
}
async function run(client, command, toWindowsPath) {
  const out = await createDocumentService(client, toWindowsPath).execute(command);
  process.stdout.write(out.stdout); process.stderr.write(out.stderr); return out.code;
}
function docSearchCmd(client, args) {
  let name = null, project = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project') project = args[++i]; else name = args[i];
  }
  return run(client, { kind: 'search', name, project });
}
const docListCmd = client => run(client, { kind: 'list' });
const docRecentCmd = client => run(client, { kind: 'recent' });
const docOpenCmd = (client, args) => run(client, { kind: 'open', name: args[0] });
const docSaveCmd = client => run(client, { kind: 'save' });
const docCloseCmd = (client, args) => run(client, { kind: 'close', save: args.includes('--save'), discard: args.includes('--discard') });
const undoRedoCmd = (client, which) => run(client, { kind: which });
const licensingCmd = client => run(client, { kind: 'licensing' });
const activeCmd = client => run(client, { kind: 'active' });
function docNewCmd(client, args) {
  let name = '';
  for (let i = 0; i < args.length; i++) if (args[i] === '--name') name = args[++i] || '';
  return run(client, { kind: 'new', name });
}
function fileDownloadCmd(client, args, toWindowsPath) {
  let output = null;
  for (let i = 1; i < args.length; i++) if (args[i] === '--out') output = args[++i] || '';
  return run(client, { kind: 'download', name: args[0], output }, toWindowsPath);
}
module.exports = { createDocumentService, docSearchCmd, docListCmd, docRecentCmd, docOpenCmd, docNewCmd,
  docSaveCmd, docCloseCmd, shotCmd, undoRedoCmd, licensingCmd, activeCmd, fileDownloadCmd };

const { commands, findCommand, OPS_DETAIL, DOC_SUB, SPECIAL: specialDescriptors } = require('./commands');
const { contextualHelp } = require('./help-details');
const { manualHelp } = require('./help-manual');

function detail(cmd, ...sub) {
  const entry = findCommand([cmd, ...sub].filter(Boolean));
  if (!entry) return `No detailed help for "${cmd}". Run "fmcad help" for the full command list.\n`;
  if (require('./i18n').locale() === 'pl') return require('./help-pl').detail(entry);
  const exampleNote = entry.target === 'capabilities.inspect'
    ? 'Searches local catalog text only; the example query is not a Fusion request.\n'
    : entry.kind === 'cad'
    ? 'Illustrative input example: existing names/IDs/tokens require discovery; token/library-ID strings shown here are placeholders, not usable IDs. See worked prerequisites below.\n'
    : 'Example:\n';
  const usage = entry.key === 'tools' ? 'tools [--json]' : entry.usage;
  let text = `Help: ${entry.key}\n\nUsage:\n  fmcad ${usage}\n\n${entry.description}\n\n${exampleNote}  ${entry.example}\n`;
  text += '\n--purpose TEXT: optional command purpose, at most 1000 Unicode characters without controls. Existing operation --description fields keep their original meaning.\n';
  if (entry.extra) text += `\n${entry.extra}\n`;
  if (entry.contract) {
    const contract = entry.contract;
    text += `\nCatalog contract: ${contract.operation}; service=${contract.service.kind}:${contract.service.handler}; SDK=${contract.requirements.sdk}; cloud=${contract.requirements.cloud}; document=${contract.requirements.document ? 'required' : 'optional'}; purpose=optional.\n` +
      `Read-only requested: ${contract.readOnlyRequested}; read-only enforced: ${contract.readOnlyEnforced}. Neither capability nor successful execution certifies geometry or cloud access.\n`;
  }
  if (entry.kind === 'queue' || entry.key === 'console') return text + manualHelp(entry);
  if (entry.kind === 'local') return text + (require('./help-manual').manuals[entry.key] ? manualHelp(entry) : '');
  text += contextualHelp(entry);
  text += manualHelp(entry);
  if (entry.target === 'capabilities.inspect') return text;
  text += '\nBackend: --backend mcp (default) or --backend addin. Settings can also select the backend.\n' +
    'addin targets AutodeskFusionMCP by Frank Hommers, not the official service. No automatic fallback/retry.\n' +
    'Read-only declarations are sent to the selected server; enforcement depends on that server. addin does not provide a sandbox.\n' +
    'addin limitations: licensing, recent documents, undo/redo and electronics require explicit --backend mcp.\n' +
    'WSL: addin defaults to --transport windows-curl for Windows localhost; override with node when appropriate.\n';
  return text;
}

function globalHelp() {
  if (require('./i18n').locale() === 'pl') return `fmcad — interfejs terminalowy Autodesk Fusion\n\nUżycie:\n  fmcad <command> [args...] [flags...]\n  fmcad help <command> [subcommand]\n\nPolecenia:\n${commands.filter(c => c.kind !== 'family').map(c => `  ${c.usage}\n    ${require('./help-pl').description(c)}`).join('\n')}\n\nOpcje wspólne: --purpose TEXT (opcjonalny cel), --config PATH, --backend mcp|addin, --routing queue, --timeout MS.\nKonsola: fmcad console [--project PATH]. Pomoc działa bez projektu, brokera i Fusion.\n`;
  return `fmcad - CLI for the Autodesk Fusion MCP

Usage:
  fmcad <command> [args...] [flags...]
  fmcad help <command> [subcommand]
  fmcad <command> [subcommand] --help

Commands:
${commands.filter((c) => c.kind !== 'family').map((c) => `  ${c.usage}`).join('\n')}

Global flags: --config <path>  --url <url>  --header K:V (repeatable)  --timeout <ms>
Purpose metadata: --purpose TEXT (optional, up to 1000 Unicode characters, no controls).
Backend: --backend <mcp|addin> (default addin); env FMCAD_BACKEND; config backend/backends. The local add-in endpoint is 127.0.0.1:8765; configure the Fusion MCP add-in there, or select mcp and configure its URL.
Transport: --transport <node|windows-curl>  --curl-path <executable>.
Queue: --routing queue; FMCAD_ROUTING or config routing accepts only queue. Ordinary commands use the shared broker.
Queue globals: --client LABEL --request-id ID --queue-timeout MS --expected-revision N --sequence-action begin|continue|end --sequence-id ID.
Queue --timeout bounds active whole-command execution, not waiting.
Queued execution autostarts one shared broker by default. Config queue.autoStart:false selects manual startup; queue.startupTimeoutMs defaults to 60000.
Manual start: fmcad queue serve --backend addin --confirm-ownership true. Help: fmcad help queue serve.
addin uses the independent AutodeskFusionMCP add-in on localhost:8765; WSL defaults to Windows curl.
No automatic fallback or mutation retry. addin has no enforced read-only sandbox.
addin does not emulate licensing, recent documents, undo/redo, or electronics; select mcp explicitly for those.
Help aliases: --help, -h. Run script listing aliases: --list, -l.

Scripts for 'run' resolve from:
  1) ~/.config/fmcad/scripts/<name>.py    (user scripts)
  2) <package>/assets/scripts/<name>.py   (built-in scripts)
A script may declare an 'ARGS = [...]' line; --args '<json>' replaces it.
Alternatively, --args-file <path> reads any JSON value from a local UTF-8 file (relative to cwd).
--args and --args-file are mutually exclusive; files are parsed before backend setup.
`;
}

const SPECIAL = Object.fromEntries(Object.keys(specialDescriptors).map((key) => [key, () => detail(key)]));
module.exports = { detail, globalHelp, OPS_DETAIL, DOC_SUB, SPECIAL };

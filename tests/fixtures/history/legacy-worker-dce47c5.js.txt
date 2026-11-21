'use strict';
// Existing non-CAD command adapters consume the broker's parsed DTO. This is
// formatting/composition, not another argv parser or a physical SDK transport.
async function execute(request, client, onOutcome) {
  const { entry, flags, listing, rawArgs, options: opts } = request.payload;
  const args = [...request.payload.args];
  const cfg = client.server;
  const { redactDiagnostic } = require('../diagnostics');
  const print = text => process.stdout.write(text);
  const windowsPath = value => {
    if (/^[A-Za-z]:[\\/]|^\\\\/.test(value)) return value;
    const platform = require('../dist/config-platform');
    return platform.toWindowsPath(require('node:path').resolve(value), platform.detectPlatform());
  };
  if (listing) {
    for (const script of require('../run').listScripts({ config: opts.config })) print(`${script.name} (${script.dir})\n`);
    return 0;
  }
  if (entry.kind === 'help') { print(require('../help').globalHelp()); return 0; }
  if (entry.kind === 'tools' || entry.kind === 'doctor') {
    if (entry.kind === 'doctor') {
      print(`CONFIG url=${new URL(cfg.url).origin}/[endpoint-redacted] tool=${cfg.tool} timeoutMs=${cfg.timeoutMs}\n`);
      print(`BACKEND name=${cfg.backend || 'mcp'} transport=${cfg.transport || 'node'}\n`);
      if (client.capabilities) print('CAPABILITIES ' + JSON.stringify(client.capabilities) + '\n');
    }
    const tools = await client.listTools();
    if (entry.kind === 'tools') {
      if (flags['--json']) print(JSON.stringify(tools, null, 2) + '\n');
      else for (const tool of tools) print(tool.name + '\n');
    } else {
      const reported = value => typeof value === 'string' && value.trim() ? redactDiagnostic(value, cfg) : 'not reported';
      print('SERVER ' + JSON.stringify({ name: reported(client.serverInfo?.name), version: reported(client.serverInfo?.version),
        protocolVersion: reported(client.negotiatedProtocolVersion) }) + '\n');
      print(`MCP_OK tools=${tools.length} (${tools.map(tool => tool.name).join(', ')})\n`);
    }
    return 0;
  }
  if (entry.kind === 'docops') {
    return require('../docops')[entry.target](client, entry.targetArg || rawArgs, entry.pathMapper ? windowsPath : undefined);
  }
  if (entry.kind === 'review') {
    require('../review').parseReviewArgs(rawArgs);
    return require('../review').reviewCmd(client, rawArgs, windowsPath, { stdout: process.stdout });
  }
  let script, callArgs;
  const operations = require('../ops');
  switch (entry.kind) {
    case 'call': callArgs = JSON.parse(args[1]); break;
    case 'op':
      if (entry.target === 'param_add') while (args.length < 4) args.push('');
      script = operations.buildOpScript(entry.target, entry.requiresDoc ? args.concat(flags['--doc']) : args);
      break;
    case 'upload': script = operations.buildOpScript(entry.target, [windowsPath(args[0]), flags['--project'] || '', flags['--folder'] || '']); break;
    case 'export': {
      const path = require('node:path');
      const name = String(flags['--doc']).replace(/[^A-Za-z0-9_.-]+/g, '_');
      script = operations.buildExportScript([entry.target, flags['--body'] || '', windowsPath(flags['--out'] || path.join(process.cwd(), name + '.' + entry.target)), flags['--doc']]);
      break;
    }
    default: throw new Error(`Unsupported queued command service: ${entry.kind}`);
  }
  if (flags['--readonly'] && cfg.backend === 'addin') process.stderr.write('WARNING: addin does not enforce a read-only sandbox; --readonly is a declaration only.\n');
  const out = entry.kind === 'call' ? await client.callTool(callArgs, args[0])
    : await client.callTool({ featureType: 'script', object: { script, ...(entry.readOnly || flags['--readonly'] ? { readOnly: true } : {}) } });
  if (out.data) onOutcome(out.data);
  print(out.text + '\n');
  if (out.stderr && !out.failed) process.stderr.write(redactDiagnostic(out.stderr, cfg));
  return out.failed ? 1 : 0;
}
module.exports = { execute };

'use strict';
const { resolveProject } = require('./console-project');
const descriptor = {
  usage: 'console [--project PATH] [--config PATH]',
  desc: 'Open the terminal console for a local fmcad project. It reads broker state and retained historical observations without starting a broker or contacting Fusion. Requires an interactive terminal. diagnostic is a compatibility alias.',
  example: 'fmcad console --project "/path/to/project"',
  extra: 'Without --project, discover the nearest ancestor containing fmcad workflow artifacts. Outside a project, enter a path interactively or continue without context. q, Ctrl+C and SIGTERM restore the terminal; closing the console does not resume or stop a broker. Settings select EN/PL for the console and all independent command help. --purpose TEXT attaches optional invocation intent.',
};
function parse(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!['--project', '--config'].includes(key) || options[key.slice(2)] !== undefined) throw new Error(`Invalid or duplicate console option: ${key}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    options[key.slice(2)] = value;
  }
  return options;
}
async function consoleCommand(argv, deps) {
  const options = parse(argv);
  const project = resolveProject({ ...options, cwd: deps.cwd || process.cwd() });
  const stdin = deps.stdin || process.stdin;
  if (!stdin.isTTY || !deps.stdout.isTTY || process.env.TERM === 'dumb') throw new Error(require('./i18n').t('terminal'));
  const launch = deps.launchConsole || launchConsole;
  return launch({ project, config: options.config, stdin, stdout: deps.stdout, loadConfig: deps.loadConfig,
    signals: deps.signals || process, cwd: deps.cwd || process.cwd() });
}
function launchConsole(options) { return require('./console-app').launchConsole(options); }
module.exports = { descriptor, parse, consoleCommand, launchConsole };

'use strict';
// Transitional source-tree launchers/fixtures copy src as their runtime boundary.
// Stage compiler output there rather than requiring private workspace resolution.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
if (process.argv.includes('--identity-only')) {
  writeRuntimeIdentity();
  return;
}
fs.cpSync(path.join(root, 'packages/core/dist'), path.join(root, 'src/dist/core'), {
  recursive: true,
  filter: source => !source.endsWith('.tsbuildinfo'),
});
fs.rmSync(path.join(root, 'src/dist/core/tsconfig.tsbuildinfo'), { force: true });
fs.cpSync(path.join(root, 'packages/node-adapters/dist/console'), path.join(root, 'src/dist/node-adapters/console'), {
  recursive: true,
});
fs.cpSync(path.join(root, 'packages/node-adapters/dist/persistence'), path.join(root, 'src/dist/node-adapters/persistence'), {
  recursive: true,
});
// In the source-tree compatibility layout, persistence sits one directory
// deeper than the staged node-adapters workspace. Point its shared Python
// literal encoder at the one canonical staged adapter, not a duplicate copy.
for (const name of fs.readdirSync(path.join(root, 'src/dist/node-adapters/persistence'))) {
  if (!name.endsWith('.js')) continue;
  const file = path.join(root, 'src/dist/node-adapters/persistence', name);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll('require("../python/', 'require("../../python/'));
}
fs.cpSync(path.join(root, 'packages/node-adapters/dist/config-platform'), path.join(root, 'src/dist/config-platform'), {
  recursive: true,
  filter: source => !source.endsWith('.tsbuildinfo'),
});
fs.cpSync(path.join(root, 'packages/node-adapters/dist/fusion-transport'), path.join(root, 'src/dist/fusion-transport'), {
  recursive: true,
  filter: source => !source.endsWith('.tsbuildinfo'),
});
fs.cpSync(path.join(root, 'packages/node-adapters/dist/telemetry'), path.join(root, 'src/dist/node-adapters/telemetry'), {
  recursive: true,
  filter: source => !source.endsWith('.tsbuildinfo'),
});
fs.cpSync(path.join(root, 'packages/node-adapters/dist/python'), path.join(root, 'src/dist/python'), {
  recursive: true,
  filter: source => !source.endsWith('.tsbuildinfo'),
});
for (const name of fs.readdirSync(path.join(root, 'src/dist/python'))) {
  if (!name.endsWith('.js')) continue;
  const file = path.join(root, 'src/dist/python', name);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll('require("@fmcad/core")', 'require("../core")'));
}
fs.cpSync(path.join(root, 'packages/node-adapters/dist/review'), path.join(root, 'src/dist/review'), {
  recursive: true,
  filter: source => !source.endsWith('.tsbuildinfo'),
});
fs.cpSync(path.join(root, 'packages/node-adapters/dist/execution'), path.join(root, 'src/dist/node-adapters/execution'), {
  recursive: true,
  filter: source => !source.endsWith('.tsbuildinfo'),
});
fs.cpSync(path.join(root, 'packages/node-adapters/dist/broker-ipc'), path.join(root, 'src/dist/node-adapters/broker-ipc'), {
  recursive: true,
  filter: source => !source.endsWith('.tsbuildinfo'),
});
for (const name of fs.readdirSync(path.join(root, 'src/dist/node-adapters/broker-ipc'))) {
  if (!name.endsWith('.js')) continue;
  const file = path.join(root, 'src/dist/node-adapters/broker-ipc', name);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8')
    .replaceAll('require("@fmcad/core")', 'require("../../core")'));
}
// Close the private workspace import in this transitional staged layout.
for (const name of fs.readdirSync(path.join(root, 'src/dist/node-adapters/execution'))) {
  if (!name.endsWith('.js')) continue;
  const file = path.join(root, 'src/dist/node-adapters/execution', name);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8')
    .replaceAll('require("@fmcad/core")', 'require("../../core")')
    .replaceAll('require("../python/', 'require("../../python/'));
}

// The installed console uses these adapters without private workspace packages.
fs.cpSync(path.join(root, 'packages/node-adapters/dist/control-center'), path.join(root, 'src/dist/node-adapters/control-center'), { recursive: true });
for (const name of ['control-center', 'telemetry', 'persistence']) {
  const rewrite = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) rewrite(file);
      else if (entry.isFile() && entry.name.endsWith('.js')) {
        const core = path.relative(directory, path.join(root, 'src/dist/core')).split(path.sep).join('/');
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll('require("@fmcad/core")', `require("${core}")`));
      }
    }
  };
  rewrite(path.join(root, 'src/dist/node-adapters', name));
}

// Public library declarations close over the staged core, never repository TS
// sources or private workspace package names. Source-tree entrypoints and npm
// consumers share this same generated boundary and declaration providers.
for (const name of ['api', 'composition', 'entrypoints']) {
  const source = path.join(root, 'dist/library-build/src', name);
  const target = path.join(root, 'src/dist', name);
  fs.mkdirSync(target, { recursive: true });
  for (const file of fs.readdirSync(source)) {
    if (!/\.(js|d\.ts)$/.test(file)) continue;
    fs.writeFileSync(path.join(target, file), fs.readFileSync(path.join(source, file), 'utf8')
      .replaceAll('../../packages/core/src', '../core')
      .replaceAll('../../packages/control-center/src', '../control-center')
      .replaceAll('../../packages/node-adapters/src', '../node-adapters')
      .replace(/require\("\.\.\/(catalog|queue-[^"/]+)([^"\n]*)"\)/g, 'require("../../$1$2")'));
  }
}
// Stage the private CLI parser/application submodules emitted by the strict TS build.
fs.cpSync(path.join(root, 'dist/library-build/src/entrypoints/cli'), path.join(root, 'src/dist/entrypoints/cli'), { recursive: true });
// The trusted service composition imports compiled private Control Center
// modules from the installed root runtime; no workspace links are published.
for (const name of ['contracts', 'resources', 'server']) {
  fs.cpSync(path.join(root, `packages/control-center/dist/${name}`), path.join(root, `src/dist/control-center/${name}`), {
    recursive: true,
    filter: source => !source.endsWith('.tsbuildinfo'),
  });
}
// Close the server workspace's package-private Core import in the installed
// layout while preserving its source TypeScript workspace boundary.
for (const directory of ['server', 'resources']) {
  const visit = target => {
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      const file = path.join(target, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.endsWith('.js')) {
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8')
          .replaceAll('require("@fmcad/core")', 'require("../../core")'));
      }
    }
  };
  visit(path.join(root, `src/dist/control-center/${directory}`));
}
// Preserve the transitional relative require layout inside the installed dist.
// Nothing in this step removes unrelated dist outputs (typing refresh, etc.).
const runtimeFilter = source => !source.includes('__pycache__') && !/\.py[co]$/.test(source) && !source.endsWith('.tsbuildinfo') &&
  (!/\.(?:ts|tsx|mts|cts)$/.test(source) || /\.d\.(?:ts|mts|cts)$/.test(source)) &&
  !source.startsWith(path.join(root, 'src/api'));
for (const name of ['src', 'assets', 'bin']) {
  fs.cpSync(path.join(root, name), path.join(root, 'dist', name), { recursive: true, filter: runtimeFilter });
}
// A previous staged build may have copied hand-maintained TypeScript before
// the runtime filter changed. Keep declarations, but never ship TS sources.
function removeTypeScriptSources(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) removeTypeScriptSources(file);
    else if (/\.(?:ts|tsx|mts|cts)$/.test(entry.name) && !/\.d\.(?:ts|mts|cts)$/.test(entry.name)) {
      fs.rmSync(file);
    }
  }
}
removeTypeScriptSources(path.join(root, 'dist/src'));
fs.cpSync(path.join(root, 'runtime/python'), path.join(root, 'dist/runtime/python'), {
  recursive: true, filter: runtimeFilter,
});
// npm bin-links removes CR from the shebang on installation. Emit those exact
// bytes up front so the installed executable fingerprint remains reproducible.
for (const name of ['fmcad.js', 'fmcad-mcp.js']) {
  const file = path.join(root, 'dist/bin', name);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^(#![^\n]*)\r\n/, (_, line) => line.replace(/\r$/, '') + '\n'));
}
fs.mkdirSync(path.join(root, 'dist/scripts'), { recursive: true });
for (const name of ['console-source-format.py', 'console-source-requirements.txt']) {
  fs.copyFileSync(path.join(root, 'scripts', name), path.join(root, 'dist/scripts', name));
}
const { name, version, engines } = require('../package.json');
fs.writeFileSync(path.join(root, 'dist/package.json'), JSON.stringify({ name, version, engines, fmcadRuntimeLayout: 1 }, null, 2) + '\n');
writeRuntimeIdentity();

function writeRuntimeIdentity() {
  const { resolveRuntimePaths, runtimeBuildIdentity, resolveChildEntrypoint } = require('../packages/node-adapters/dist/config-platform/runtime-paths.js');
  const paths = resolveRuntimePaths({ anchor: path.join(root, 'dist/src/queue-worker.js') });
  const entrypoints = Object.fromEntries(['queue-worker', 'queue-autostart-worker', 'queue-broker'].map(name =>
    [name, path.relative(paths.installation, resolveChildEntrypoint(paths, name)).split(path.sep).join('/')]));
  fs.writeFileSync(path.join(root, 'dist/runtime-build.json'), JSON.stringify({
    version: 1, algorithm: 'sha256', fingerprint: runtimeBuildIdentity(paths), entrypoints,
  }, null, 2) + '\n');
}

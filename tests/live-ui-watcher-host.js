const fs = require('node:fs/promises');
const ui = require('../src/ui');

async function run() {
  const argument = process.argv[2];
  if (!argument) throw new Error('Request JSON or @request-file is required');
  const input = argument.startsWith('@')
    ? JSON.parse(await fs.readFile(argument.slice(1), 'utf8'))
    : JSON.parse(argument);
  if (input.mode === 'status') {
    const result = await ui.watcherStatus(input.request, { stateDir: input.stateDir });
    if (input.resultFile) await fs.writeFile(input.resultFile, JSON.stringify(result));
    process.stdout.write(JSON.stringify(result) + '\n');
    return 0;
  }
  if (input.mode === 'continue') {
    const result = await ui.resumePendingWatcher(input.request, { stateDir: input.stateDir });
    if (input.resultFile) await fs.writeFile(input.resultFile, JSON.stringify(result));
    process.stdout.write(JSON.stringify(result) + '\n');
    return result.actionSubmitted === true ? 0 : 1;
  }
  if (input.mode === 'continue') {
    const result = await ui.resumePendingWatcher(input.request, { stateDir: input.stateDir });
    if (input.resultFile) await fs.writeFile(input.resultFile, JSON.stringify(result));
    process.stdout.write(JSON.stringify(result) + '\n');
    return result.actionSubmitted === true ? 0 : 1;
  }
  const dependencies = { stateDir: input.stateDir, qualifiedProfiles: input.qualifiedProfiles,
    probeSdk: async () => input.probe };
  const watcher = await ui.armWatcher(null, input.request, dependencies);
  if (watcher.status !== 'armed') {
    await fs.writeFile(input.readyFile, JSON.stringify({ status: watcher.status,
      unavailableEvidence: watcher.unavailableEvidence ?? [] }));
    return 1;
  }
  await fs.writeFile(input.readyFile, JSON.stringify({ status: 'armed', requestId: watcher.requestId }));
  let signalled = false;
  const signal = setInterval(async () => {
    if (signalled) return;
    try {
      await fs.access(input.commandDoneFile);
      signalled = true;
      clearInterval(signal);
      await watcher.complete();
    } catch (_) {}
  }, 50);
  const result = await watcher.completion;
  clearInterval(signal);
  const disarm = await watcher.disarm();
  await fs.writeFile(input.resultFile, JSON.stringify({ result, disarm }));
  return 0;
}

run().then(code => { process.exitCode = code; }, error => {
  process.stderr.write(error.stack || String(error));
  process.exitCode = 1;
});

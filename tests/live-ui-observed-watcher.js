const fs = require('node:fs/promises');
const ui = require('../src/ui');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const input = JSON.parse(process.argv[2]);
  const data = input.request;
  const context = { doc: data.target.name, docId: data.target.creationId, docFileId: data.target.fileId };
  const dependencies = { stateDir: input.stateDir, qualifiedProfiles: input.qualifiedProfiles,
    probeSdk: async () => input.probe };
  const started = Date.now();
  await fs.writeFile(input.readyFile, JSON.stringify({ status: 'armed', requestId: data.requestId }));
  while (Date.now() - started < input.timeBudgetMs) {
    const host = await ui.inspectHostSnapshot({ requestId: data.requestId, lease: data.lease,
      expectedIdentity: data.target, processId: input.probe.processId,
      expectedProcessStartTicks: input.processStartTicks,
      expectedMainWindowHandle: input.mainWindowHandle, timeBudgetMs: 5000, maxControls: 256 });
    const visibleSaveDialog = (host.windows ?? []).some(window =>
      window.controls.some(control => control.isModal &&
        (String(window.className).includes('Nu::QTPLM360LabelDescriptionDialog') ||
         String(control.className).includes('Nu::QTPLM360LabelDescriptionDialog') ||
         control.parentPath?.some(part => part.includes('Nu::QTPLM360LabelDescriptionDialog')))));
    if (visibleSaveDialog && !host.truncated) {
      const inspected = await ui.execute(null, 'ui.inspect', data, context, dependencies);
      const selected = (inspected.windows ?? []).flatMap(window => window.controls)
        .filter(control => control.controlType === 'Button' && control.name === input.controlName &&
          control.parentPath?.some(part => part.includes('Nu::QTPLM360LabelDescriptionDialog')) &&
          control.enabled && !control.offscreen && control.invokeAvailable);
      if (!inspected.identityVerified || !inspected.observationId || selected.length !== 1) {
        const result = { status: 'blocked', actionSubmitted: false,
          unavailableEvidence: ['exact authorized save dialog or unique observed button not verified'] };
        await fs.writeFile(input.resultFile, JSON.stringify({ inspectedStatus: inspected.status, result }));
        return 1;
      }
      const response = { ...data, action: 'confirm', observationId: inspected.observationId,
        selectionMode: 'observedControl', controlRef: selected[0].controlRef };
      ui.validate('ui.respond', response);
      const result = await ui.execute(null, 'ui.respond', response, context, dependencies);
      await fs.writeFile(input.resultFile, JSON.stringify({ inspectedStatus: inspected.status, result }));
      return result.status === 'actionSubmitted' ? 0 : 1;
    }
    try {
      await fs.access(input.commandDoneFile);
      await fs.writeFile(input.resultFile, JSON.stringify({ status: 'nothingToDo', actionSubmitted: false,
        limitation: 'The owner reported a completed operation with no save dialog.' }));
      return 0;
    } catch (_) {}
    await sleep(250);
  }
  await fs.writeFile(input.resultFile, JSON.stringify({ status: 'unknown', actionSubmitted: null,
    limitation: 'Save dialog was not observed within the bounded window. No action was replayed.' }));
  return 1;
}

main().then(code => { process.exitCode = code; }, error => {
  process.stderr.write(String(error.stack || error) + '\n');
  process.exitCode = 1;
});

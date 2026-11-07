const ui = require('../src/ui');

async function main() {
  const request = JSON.parse(process.argv[2]);
  const snapshot = await ui.inspectHostSnapshot(request);
  process.stdout.write(JSON.stringify({ status: snapshot.status,
    processId: snapshot.processId, processStartTicks: snapshot.processStartTicks,
    mainWindowHandle: snapshot.mainWindowHandle, osBuild: snapshot.osBuild,
    locale: snapshot.locale, truncated: snapshot.truncated,
    windows: (snapshot.windows ?? []).map(window => ({ handle: window.handle,
      ownerHandle: window.ownerHandle, className: window.className, title: window.title,
      isMain: window.isMain, isModal: window.isModal,
      controls: window.controls.filter(control => control.isModal || ['Button', 'Text'].includes(control.controlType) ||
        /QDialog|MessageBox/i.test(control.className) || /Dialog|MessageBox/i.test(control.automationId))
        .map(control => ({ controlRef: control.controlRef,
        controlType: control.controlType, className: control.className,
        automationId: control.automationId, name: control.name,
        enabled: control.enabled, offscreen: control.offscreen,
        invokeAvailable: control.invokeAvailable, isModal: control.isModal })) })),
    unavailableEvidence: snapshot.unavailableEvidence ?? [] }));
}

main().catch(error => {
  process.stderr.write(String(error.message || error) + '\n');
  process.exitCode = 1;
});

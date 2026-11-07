const ui = require('../src/ui');

async function main() {
  const input = JSON.parse(process.argv[2]);
  const data = input.request;
  const context = { doc: data.target.name, docId: data.target.creationId, docFileId: data.target.fileId };
  const dependencies = { stateDir: input.stateDir, qualifiedProfiles: input.qualifiedProfiles,
    probeSdk: async () => input.probe };
  ui.validate('ui.inspect', data);
  const inspected = await ui.execute(null, 'ui.inspect', data, context, dependencies);
  const profiles = inspected.profiles.filter(profile => profile.profileId === input.profileId && profile.qualified);
  if (!inspected.identityVerified || !inspected.observationId || profiles.length !== 1) {
    const candidates = ui.profileCandidates({ windows: inspected.windows ?? [],
      osBuild: inspected.process?.osBuild, locale: inspected.process?.locale },
    input.probe, data.intent, dependencies.qualifiedProfiles);
    process.stdout.write(JSON.stringify({ state: 'blocked', inspectedStatus: inspected.status,
      identityVerified: inspected.identityVerified, profileCandidates: inspected.profiles,
      matchedProfiles: candidates,
      buttons: (inspected.windows ?? []).flatMap(window => window.controls).filter(control => control.controlType === 'Button').map(control => ({
        name: control.name, automationId: control.automationId, className: control.className,
        containerKey: control.containerKey, parentPath: control.parentPath,
      })),
      unavailableEvidence: inspected.unavailableEvidence }));
    return 1;
  }
  const response = { ...data, action: 'confirm', observationId: inspected.observationId };
  if (input.selectionMode === 'observedControl') {
    const named = (inspected.windows ?? []).flatMap(window => window.controls)
      .filter(control => control.controlType === 'Button' && control.name === input.controlName);
    if (named.length !== 1) {
      process.stdout.write(JSON.stringify({ state: 'blocked', inspectedStatus: inspected.status,
        candidateRefs: named.map(control => control.controlRef), reason: 'exact observed control was not unique' }));
      return 1;
    }
    response.selectionMode = 'observedControl';
    response.controlName = named[0].name;
    response.controlType = 'Button';
    response.containerRef = named[0].containerRef;
  } else {
    response.profileId = input.profileId;
    response.selectionMode = 'profile';
  }
  ui.validate('ui.respond', response);
  const result = await ui.execute(null, 'ui.respond', response, context, dependencies);
  process.stdout.write(JSON.stringify({ state: 'complete', inspectedStatus: inspected.status,
    profile: profiles[0], result }));
  return result.status === 'actionSubmitted' ? 0 : 1;
}

main().catch(error => {
  process.stderr.write(String(error.stack || error) + '\n');
  process.exitCode = 1;
});

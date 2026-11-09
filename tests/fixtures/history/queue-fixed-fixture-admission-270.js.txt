'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual: same } = require('node:util');
const { readJson } = require('./queue-instance');
const { validateFixtureGrant } = require('./queue-native-fixture-grant');
const { resolveRuntimePaths } = require('./dist/config-platform');
const fail = message => { throw Object.assign(new Error(message), { code: 'NATIVE_FIXTURE_SCOPE_REQUIRED' }); };

// `original` is supplied only by the immutable-runtime evidence reader, never
// decoded from a client invocation. Normal live admission always uses defaults.
function fixedFixtureAdmission(epoch, request, grant, original = {}) {
  const fixture = validateFixtureGrant(grant, original.identity || readJson(path.join(epoch.root, 'instance.json')));
  if (!fixture || fixture.kind !== 'fixed-run-v1') fail('An explicit source-pinned fixed fixture grant is required');
  const service = require('./cad-service');
  let payload;
  try { payload = service.decodeInvocation(request.payload); } catch { fail('A validated versioned fixed run invocation is required'); }
  const run = payload.request;
  const installation = original.installation || resolveRuntimePaths({ anchor: __filename }).installation;
  const script = path.join(installation, fixture.script);
  if (request.kind !== 'command' || payload.kind !== 'run' || payload.output !== undefined ||
      !run || run.name !== script || fs.realpathSync(run.name) !== script ||
      run.doc !== epoch.document.name || run.identity?.docId !== epoch.document.creationId ||
      Object.keys(run.identity).some(key => !['docId', 'readOnly'].includes(key)) || run.identity.readOnly === true ||
      run.helperVersion !== fixture.helperVersion || run.hasArgs !== true ||
      !Array.isArray(run.readOnlyOperations) || run.readOnlyOperations.length ||
      !Array.isArray(request.inputFiles) || request.inputFiles.length !== 1 || request.inputFiles[0].path !== script ||
      request.inputFiles[0].sha256 !== fixture.scriptSha256 || !same(request.argv, service.policyArguments(payload)))
    fail('Only the exact registered source, cad-v1 helper, document pin and source snapshot are admitted; no outputs or other inputs');
  const args = run.args;
  if (!args || typeof args !== 'object' || Array.isArray(args) ||
      Object.keys(args).sort().join(',') !== 'approved,creationId,expectedFusionVersion,fixturePrefix' ||
      args.approved !== true || args.creationId !== epoch.document.creationId || args.expectedFusionVersion !== epoch.currentInstance.version ||
      typeof args.fixturePrefix !== 'string' || !/^[A-Z][A-Z0-9]{7,31}$/.test(args.fixturePrefix))
    fail('Fixed fixture arguments cannot change source behavior or target another document/process version');
}

module.exports = { fixedFixtureAdmission };

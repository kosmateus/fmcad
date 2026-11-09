#!/usr/bin/env python3
"""Generate command/evidence manifests without starting Fusion or a broker."""
import argparse
import hashlib
import json
import shlex
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def native_obligations(profile, inventory_ids):
    if profile.get('required') is not True or profile.get('qualification') != 'pending':
        raise ValueError('Native qualification profile must remain required and pending')
    obligations = []
    for case in profile.get('cases', []):
        if case.get('id') not in inventory_ids:
            raise ValueError(f"Native case is absent from the live inventory: {case.get('id')}")
        if case.get('disposition') not in ('migration-pending', 'native-only'):
            raise ValueError(f"Native case has a nonblocking disposition: {case.get('id')}")
        argv = shlex.split(case.get('command', ''))
        if not argv or argv[0] != 'node' or argv.count('--run') != 1:
            raise ValueError(f"Native case is not an explicit Node --run command: {case.get('id')}")
        if any(token in {'|', '||', '&&', ';', '>', '>>', '<'} for token in argv):
            raise ValueError(f"Native case contains shell control syntax: {case.get('id')}")
        ready = case.get('runnerStatus') in ('owned-handoff-source-ready', 'owned-handoff-ready')
        obligations.append({
            'id': case['id'], 'source': case['source'],
            'status': 'NOTRUN', 'disposition': case['disposition'],
            'obligation': case['obligation'], 'argv': argv,
            'prerequisites': case['prerequisites'],
            'runnerStatus': case.get('runnerStatus', 'migration-required'),
            'qualification': case.get('qualification', 'not-run'),
            'runnableAfterOfflineGate': ready,
            'cleanupRecovery': (
                'The registered owned runner preserves creation receipts, document/file identities, durable intents, restoration and uncertainty-aware deferred cleanup; preserve its original report and recovery manifest.'
                if ready else
                'PENDING-MIGRATION: supply exact owned creation/file/version receipts and restoration proof before execution.'
            ),
        })
    return obligations


def integration_manifest():
    path = ROOT / 'tests/scenarios/native-integration-cases.json'
    manifest = json.loads(path.read_text())
    if manifest.get('schemaVersion') != 1 or manifest.get('qualification') != 'not-run':
        raise ValueError('Retained integration assertions must remain explicitly unqualified')
    ids = set()
    for case in manifest['cases']:
        if case['id'] in ids:
            raise ValueError(f"Duplicate retained integration case: {case['id']}")
        ids.add(case['id'])
        source = (ROOT / case['source']).resolve()
        if not source.is_relative_to(ROOT) or hashlib.sha256(source.read_bytes()).hexdigest() != case['sourceSha256']:
            raise ValueError(f"Retained integration assertions changed after review: {case['source']}")
    return {'path': str(path.relative_to(ROOT)), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
            'caseCount': len(ids), 'qualification': 'NOTRUN', 'cases': manifest['cases']}


def native_fixture_obligations(profile):
    expected = {
        'native-integration': 'tests/scenarios/native-integration-cases.json',
        'iw74-parameter-test': 'tests/native/iw7.4_parameter_test.py',
    }
    cases = profile.get('cases', [])
    if len(cases) != len(expected) or {case.get('id') for case in cases} != set(expected):
        raise ValueError('Native fixture profile must retain every reviewed fixture family')
    for case in cases:
        if case.get('source') != expected[case['id']]:
            raise ValueError(f"Native fixture source changed: {case['id']}")
        sources = [('source', 'sourceSha256')]
        if case['id'] == 'iw74-parameter-test':
            if case.get('continuationSource') != 'tests/native/iw7.4_parameter_failures.py':
                raise ValueError('Native parameter failure/restoration continuation is required')
            sources.append(('continuationSource', 'continuationSourceSha256'))
        for path_key, hash_key in sources:
            source = (ROOT / case[path_key]).resolve()
            if not source.is_relative_to(ROOT) or hashlib.sha256(source.read_bytes()).hexdigest() != case.get(hash_key):
                raise ValueError(f"Native fixture changed after review: {case[path_key]}")
    obligations = native_obligations(profile, set(expected))
    for obligation, case in zip(obligations, cases):
        obligation['sourceSha256'] = case['sourceSha256']
        if 'continuationSource' in case:
            obligation['continuationSource'] = case['continuationSource']
            obligation['continuationSourceSha256'] = case['continuationSourceSha256']
    return obligations


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project-id', required=True)
    parser.add_argument('--folder-id', required=True)
    parser.add_argument('--runtime-root', help='Exact installed package root for installed-runtime native probes')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    for value in (args.project_id, args.folder_id):
        if not value.strip() or value.startswith('--'):
            parser.error('Fixture identifiers must be nonempty values, not options')
    folder = {'projectId': args.project_id, 'folderId': args.folder_id}
    # Construct the existing scenario objects; never invoke their run methods.
    program = '''
const assert = require('node:assert/strict');
const folder = JSON.parse(process.argv[1]);
const root = './dist/tests/scenarios/';
const {parse, scenariosFor} = require(root + 'cli.js');
const profiles = require('./tests/live-required-profiles.json').profiles;
const rows = profiles['required-model'].cases;
const suites = rows.map(row => {
 const copies = row.ownerCopies;
 assert.ok(Number.isSafeInteger(copies) && copies > 0, row.id + ' owner copies');
 const command = ['node', root+'cli.js', '--backend','fusion','--profile','broker','--suite',row.id,'--project-id',folder.projectId,'--folder-id',folder.folderId,'--owners',String(copies),'--run'];
 const options = parse([...command.slice(2),'--protocol','mcp','--concurrency','10']);
 const scenarios = scenariosFor(options);
 assert.ok(row.minimumOwnerFixtures >= 10, row.id + ' required owner population');
 assert.ok(scenarios.length >= row.minimumOwnerFixtures, row.id + ' actual owned fixture population');
 assert.equal(new Set(scenarios.map(s=>s.id)).size, scenarios.length, row.id + ' duplicate scenario ownership');
 for (const protocol of ['mcp','addin']) for (const concurrency of [1,2,10]) parse([...command.slice(2),'--protocol',protocol,'--concurrency',String(concurrency)]);
 return {suite:row.id, kind:'shared-model-and-native', command, protocols:['mcp','addin'], variants:[{id:'default',environment:{}}], requiredEnvironment:[], ownerCopies:copies, actualScenarioOwners:scenarios.length,actualOwnerFixtures:scenarios.filter(s=>s.lifecycle !== 'read-only').length, cases: scenarios.map(s=>({id:s.id,requires:s.requires,scope:s.scope ?? 'owned-document',lifecycle:s.lifecycle ?? 'owned-document',status:'NOTRUN'}))};
});
const readyNative = [...profiles['native-qualification'].cases, ...profiles['native-fixtures'].cases].filter(row => ['owned-handoff-source-ready','owned-handoff-ready'].includes(row.runnerStatus) && row.command.includes('dist/tests/scenarios/cli.js'));
for (const row of readyNative.map(row => ({...row,command:row.command.split(' ').map(token => ({PROJECT:folder.projectId,FOLDER:folder.folderId,PROTOCOL:row.protocols?.[0] ?? 'mcp',CONCURRENCY:'10'})[token] ?? token)}))) {
 const options = parse(row.command.slice(2));
 const scenarios = scenariosFor(options);
 assert.ok(scenarios.length > 0, row.id + ' native factory must register actual assertions');
 assert.equal(new Set(scenarios.map(s=>s.id)).size,scenarios.length,row.id + ' duplicate native ownership');
 // Keep a single protocol/concurrency pair in each executable argv.
 const command = row.command.filter((token,index,all) => !['--protocol','--concurrency'].includes(token) && !['--protocol','--concurrency'].includes(all[index-1]));
 const protocols = row.protocols ?? ['mcp','addin'];
 assert.ok(protocols.length && protocols.every(protocol=>['mcp','addin'].includes(protocol)),row.id + ' explicit native protocols');
 for (const protocol of protocols) for (const concurrency of [1,2,10]) parse([...command.slice(2),'--protocol',protocol,'--concurrency',String(concurrency)]);
 suites.push({suite:row.id,kind:'native-only',command,protocols,variants:row.variants ?? [{id:'default',environment:{}}],requiredEnvironment:row.requiredEnvironment ?? [],ownerCopies:options.owners,actualScenarioOwners:scenarios.length,actualOwnerFixtures:scenarios.filter(s=>s.lifecycle !== 'read-only').length,cases:scenarios.map(s=>({id:s.id,requires:s.requires,scope:s.scope ?? 'owned-document',lifecycle:s.lifecycle ?? 'owned-document',status:'NOTRUN'}))});
}
process.stdout.write(JSON.stringify(suites));'''
    suites = json.loads(subprocess.check_output(['node', '-e', program, json.dumps(folder)], cwd=ROOT, text=True))
    inventory_path = ROOT / 'tests/live-suite-inventory.json'
    inventory = json.loads(inventory_path.read_text())
    inventory_ids = {row['id'] for row in inventory['entries']}
    profiles_path = ROOT / 'tests/live-required-profiles.json'
    profiles = json.loads(profiles_path.read_text())
    if profiles.get('nativeExecution') != 'deferred-until-offline-complete':
        raise ValueError('Native execution must remain deferred until offline completion')
    required_model = profiles['profiles']['required-model']
    required_ids = [row['id'] for row in required_model['cases']]
    suite_ids = [row['suite'] for row in suites if row['kind'] == 'shared-model-and-native']
    if required_model.get('required') is not True or required_ids != suite_ids:
        raise ValueError(f'Required model profile differs from scenario suites: {required_ids} != {suite_ids}')
    obligations = native_obligations(profiles['profiles']['native-qualification'], inventory_ids)
    fixture_obligations = native_fixture_obligations(profiles['profiles']['native-fixtures'])
    retained_integration = integration_manifest()
    diagnostics = profiles['profiles']['diagnostics']
    if diagnostics.get('required') is not False:
        raise ValueError('Diagnostics must not substitute for required qualification cases')
    commands = []
    for suite in suites:
        for variant in suite['variants']:
            environment = dict(variant['environment'])
            for name in suite['requiredEnvironment']:
                if name != 'FMCAD_LIVE_RUNTIME_ROOT':
                    raise ValueError(f'Unresolved native environment requirement: {name}')
                environment[name] = args.runtime_root or '<exact-installed-runtime-root>'
            for protocol in suite['protocols']:
                for concurrency in (1, 2, 10):
                    commands.append({
                    'id': f"{suite['suite']}-{variant['id']}-{protocol}-{concurrency}",
                    'kind': suite['kind'],
                    'variant': variant['id'], 'environment': environment,
                    'status': 'NOTRUN', 'protocol': protocol, 'concurrency': concurrency,
                    'argv': suite['command'] + ['--protocol', protocol, '--concurrency', str(concurrency)],
                    'cases': suite['cases'], 'ownerCopies': suite['ownerCopies'],
                    'actualOwnerFixtures': suite['actualOwnerFixtures'],
                    'actualScenarioOwners': suite['actualScenarioOwners'],
                    })
    report = {
        'schemaVersion': 3,
        'sourceSha': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
        'workingTreeStatus': subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True).splitlines(),
        'offlineAcceptance': 'INCOMPLETE', 'nativeQualification': 'NOTRUN',
        'executionGate': 'Do not run until A–F completion, full CI on the integrated SHA, installed-package acceptance and real Fusion access are evidenced.',
        'scope': 'All required shared model families, retained native live assertions, 251 integration cases and original IW7.4 parameter/restoration fixtures. Source readiness is not native qualification.',
        'fixtureFolder': folder, 'defaultConcurrency': 10,
        'liveInventorySha256': hashlib.sha256(inventory_path.read_bytes()).hexdigest(),
        'requiredProfilesSha256': hashlib.sha256(profiles_path.read_bytes()).hexdigest(),
        'commands': commands,
        'nativeObligations': obligations,
        'nativeFixtureObligations': fixture_obligations,
        'retainedIntegrationAssertions': retained_integration,
        'diagnosticCases': diagnostics['cases'],
        'remainingInventory': inventory['entries'],
        'remainingOwner': 'G and package owners: complete exact-commit offline execution, installed acceptance and CI before dispatch. Native operators then retain every required assertion, ownership and restoration receipt.',
        'requiredEvidence': ['integrated SHA', 'Fusion build/API version', 'installed runtime build/source hashes', 'scenario inputs and assertion outcomes', 'run/client/request IDs', 'creation/file/version identities', 'physical RPC and mutation counts', 'original receipts and primary errors', 'cleanup errors and recovery manifests', 'before/after document and folder inventory', 'active-document restoration', 'native exports and screenshots where required'],
        'cleanup': {
            'policy': 'Keep original reports and receipts. Read original outcomes; never replay an uncertain mutation. Recovered cleanup does not pass unexecuted assertions.',
            'argvTemplate': ['node', 'dist/tests/scenarios/cli.js', '--backend', 'fusion', '--profile', 'broker', '--protocol', '<original-protocol>', '--cleanup', '<original-recovery-manifest>', '--run'],
            'unsettled': 'Stop and preserve ownership. Do not delete by name, change file version, clear another document, or start a replacement scenario.',
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'commands': len(commands), 'nativeObligations': len(obligations),
                      'nativeFixtureObligations': len(fixture_obligations),
                      'diagnosticCases': len(diagnostics['cases']), 'status': 'NOTRUN',
                      'offlineAcceptance': 'INCOMPLETE'}))


if __name__ == '__main__':
    main()

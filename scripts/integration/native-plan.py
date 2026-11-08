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
        if not argv or argv[0] != 'node' or argv[-1] != '--run':
            raise ValueError(f"Native case is not an explicit Node --run command: {case.get('id')}")
        if any(token in {'|', '||', '&&', ';', '>', '>>', '<'} for token in argv):
            raise ValueError(f"Native case contains shell control syntax: {case.get('id')}")
        obligations.append({
            'id': case['id'], 'source': case['source'],
            'status': 'NOTRUN', 'disposition': case['disposition'],
            'obligation': case['obligation'], 'argv': argv,
            'prerequisites': case['prerequisites'],
            'cleanupRecovery': 'PENDING-MIGRATION: supply exact owned creation/file/version receipts and restoration proof before execution.',
        })
    return obligations


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project-id', required=True)
    parser.add_argument('--folder-id', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    for value in (args.project_id, args.folder_id):
        if not value.strip() or value.startswith('--'):
            parser.error('Fixture identifiers must be nonempty values, not options')
    folder = {'projectId': args.project_id, 'folderId': args.folder_id}
    # Construct the existing scenario objects; never invoke their run methods.
    program = '''
const folder = JSON.parse(process.argv[1]);
const root = './dist/tests/scenarios/';
const rows = [
 ['foundation', 'cases', 'foundationScenarios'], ['saved', 'cases', 'savedScenarios'],
 ['parameters', 'parameter-cases', 'parameterScenarios'], ['documents', 'document-cases', 'documentScenarios'],
 ['cloud', 'cloud-cases', 'cloudScenarios'], ['boxes', 'box-cases', 'boxScenarios'],
 ['attributes', 'attribute-cases', 'attributeScenarios'], ['sketches', 'sketch-cases', 'sketchScenarios'],
];
const {parse} = require(root + 'cli.js');
process.stdout.write(JSON.stringify(rows.map(([suite, file, name]) => {
 const scenarios = suite === 'foundation' ? require(root+file+'.js')[name](10) : require(root+file+'.js')[name](folder,10);
 const command = ['node', root+'cli.js', '--backend','fusion','--profile','broker','--suite',suite,'--project-id',folder.projectId,'--folder-id',folder.folderId,'--owners','10','--run'];
 for (const protocol of ['mcp','addin']) for (const concurrency of [1,2,10]) parse([...command.slice(2),'--protocol',protocol,'--concurrency',String(concurrency)]);
 return {suite, command, cases: scenarios.map(s=>({id:s.id,requires:s.requires,status:'NOTRUN'}))};
})));'''
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
    suite_ids = [row['suite'] for row in suites]
    if required_model.get('required') is not True or required_ids != suite_ids:
        raise ValueError(f'Required model profile differs from scenario suites: {required_ids} != {suite_ids}')
    obligations = native_obligations(profiles['profiles']['native-qualification'], inventory_ids)
    diagnostics = profiles['profiles']['diagnostics']
    if diagnostics.get('required') is not False:
        raise ValueError('Diagnostics must not substitute for required qualification cases')
    commands = []
    for suite in suites:
        for protocol in ('mcp', 'addin'):
            for concurrency in (1, 2, 10):
                commands.append({
                    'id': f"{suite['suite']}-{protocol}-{concurrency}",
                    'status': 'NOTRUN', 'protocol': protocol, 'concurrency': concurrency,
                    'argv': suite['command'] + ['--protocol', protocol, '--concurrency', str(concurrency)],
                    'cases': suite['cases'],
                })
    report = {
        'schemaVersion': 2,
        'sourceSha': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
        'workingTreeStatus': subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True).splitlines(),
        'offlineAcceptance': 'INCOMPLETE', 'nativeQualification': 'NOTRUN',
        'executionGate': 'Do not run until A–F completion, full CI on the integrated SHA, installed-package acceptance and real Fusion access are evidenced.',
        'scope': 'Merged required model profile plus every retained native obligation. Per-assertion semantic mapping and legacy lifecycle migration remain incomplete.',
        'fixtureFolder': folder, 'defaultConcurrency': 10,
        'liveInventorySha256': hashlib.sha256(inventory_path.read_bytes()).hexdigest(),
        'requiredProfilesSha256': hashlib.sha256(profiles_path.read_bytes()).hexdigest(),
        'commands': commands,
        'nativeObligations': obligations,
        'diagnosticCases': diagnostics['cases'],
        'remainingInventory': inventory['entries'],
        'remainingOwner': 'B/G: map every static assertion semantically, migrate retained native lifecycle/cleanup, and prove global UI restoration before qualification.',
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
                      'diagnosticCases': len(diagnostics['cases']), 'status': 'NOTRUN',
                      'offlineAcceptance': 'INCOMPLETE'}))


if __name__ == '__main__':
    main()

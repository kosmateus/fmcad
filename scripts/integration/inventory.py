#!/usr/bin/env python3
"""Produce a review inventory; owner routing is triage, never completion evidence."""
from __future__ import annotations
import argparse
import json
import re
import subprocess
from pathlib import Path
from coverage import ROOT, audit, tracked


def owner(path: str) -> str:
    name = Path(path).name.replace('_', '-')
    if path.startswith(('tests/integration/', 'tests/native/', 'tests/scenarios/', 'tests/support/fusion-simulator/')) or name.startswith('live-'):
        return 'B'
    if 'control-center' in path or name.startswith(('console-', 'project-history', 'project-logger', 'project-responses')):
        return 'F'
    if name.startswith(('data-import', 'references-refresh', 'externalization', 'drawing', 'document-publication', 'document-save', 'document-persistence', 'document-io', 'python-document-io', 'file-editability')):
        return 'D'
    if name.startswith(('queue-', 'atomic-', 'epoch-', 'closed-epoch', 'dead-epoch', 'settled-epoch', 'saved-', 'scratch-', 'isolated-', 'successor-', 'instance-', 'fusion-reset', 'execution-', 'stage-', 'audit-response', 'python-admission', 'python-checker', 'python-context', 'recovery-', 'phased-', 'normal-epoch', 'broker-composition', 'offline-timeout', 'observation-ports', 'cad-worker', 'build-preflight', 'local-build', 'idle-build')):
        return 'A'
    if 'opencode' in path or '/entrypoints/' in path or '/api/' in path or '/catalog/' in path or name.startswith(('mcp-', 'cli-', 'backend-', 'client', 'config', 'command', 'help', 'manual-', 'library-', 'image-', 'reference.', 'reference-', 'review', 'shot', 'ui.', 'engineering-', 'host-workers', 'server-', 'registry')):
        return 'E'
    if path.startswith(('runtime/python/fmcad/', 'assets/cad/')) or name.startswith(('sketch', 'curve', 'datum', 'surface', 'entity', 'selection', 'brep-', 'fastener', 'spring', 'seal', 'thread', 'cam.', 'feature-', 'geometry', 'appearance', 'assembly', 'measure', 'model.', 'pose.', 'animation', 'mechanism', 'interference', 'containment', 'optics', 'shape-', 'sheetmetal', 'manufacturing', 'marking', 'explode', 'route3d', 'fpc-pcb', 'presentation', 'semantic-', 'regional-', 'section-', 'param-', 'style-', 'inspection', 'python-geometry', 'python-assembly')):
        return 'C'
    return 'G'


def runtime_inventory(root: Path, files: list[str]) -> list[dict]:
    rows = []
    for path in files:
        if not path.startswith(('src/', 'packages/', 'runtime/python/fmcad/', 'assets/cad/')) or not re.search(r'\.(?:[cm]?[jt]s|py)$', path):
            continue
        if '/test' in path or '/scripts/' in path:
            continue
        text = (root / path).read_text()
        shim = bool(re.fullmatch(r"\s*(?:['\"]use strict['\"];?\s*)?(?://[^\n]*\n\s*)*module\.exports\s*=\s*require\([^\n]+\);?\s*", text))
        rows.append({'path': path, 'owner': owner(path), 'sourceForm': 'literal-commonjs-shim' if shim else 'requires-semantic-review', 'disposition': 'owner-review-required', 'nextAction': 'Link canonical implementation, installed consumers, effects/readback and negative evidence before retirement or acceptance.'})
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    files = tracked(ROOT)
    registration = audit(ROOT, files)
    # Read the existing public registry after the pinned build. This does not
    # call Fusion, mutate documents, or manufacture independent route metadata.
    js = "const {commands}=require('./src/commands');const {manuals}=require('./src/help-manual');process.stdout.write(JSON.stringify(commands.filter(c=>c.kind!=='family').map(c=>({route:c.key,aliases:c.aliases||[],operation:c.target||null,kind:c.kind,audit:manuals[c.kind==='cad'?c.target:c.key]?.audit}))))"
    routes = json.loads(subprocess.check_output(['node', '-e', js], cwd=ROOT, text=True))
    registered = {r['path'] for r in registration['tests'] if r['workflows']}
    for route in routes:
        route['owner'] = 'E'
        route['disposition'] = 'route-metadata-not-behavioral-acceptance'
        route['registeredEvidence'] = [p for p in route.get('audit', {}).get('tests', []) if re.split(r'[: ]', p)[0] in registered]
    report = {
        'schemaVersion': 1,
        'sourceSha': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
        'workingTreeStatus': subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True).splitlines(),
        'limitations': ['Owner labels route reviews under the seven plans; G owns ambiguous triage.', 'Literal shims are candidates, not approved deletions.', 'Public audit references are metadata, not effects/readback proof.', 'B owns assertion-level scenario disposition; file registration cannot establish it.'],
        'runtime': runtime_inventory(ROOT, files),
        'publicRoutes': routes,
        'registration': registration,
        'liveInventory': json.loads((ROOT / 'tests/live-suite-inventory.json').read_text()),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'runtimeFiles': len(report['runtime']), 'publicRoutes': len(routes), 'testSources': len(registration['tests']), 'registrationGaps': len(registration['gaps'])}))


if __name__ == '__main__':
    main()

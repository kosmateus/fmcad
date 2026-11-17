"""Protect byte-pinned Python source oracles from checkout EOL conversion."""
import hashlib
import json
from pathlib import Path
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[1]


def frozen_hashes():
    result = {}

    def add(path, digest):
        relative = str(path)
        if relative in result and result[relative] != digest:
            raise AssertionError(f'Conflicting frozen source hashes: {relative}')
        result[relative] = digest

    modeling = ROOT / 'tests/fixtures/modeling-python-history'
    for entry in json.loads((modeling / 'manifest.json').read_text()).values():
        add(Path('tests/fixtures/modeling-python-history') / entry['fixture'], entry['sha256'])

    workflows = ROOT / 'tests/fixtures/file-workflows'
    workflow_manifest = json.loads((workflows / 'manifest.json').read_text())
    workflow_names = {
        'baseline-externalization-planning.py.txt',
        'before-externalization-planning.py.txt',
        'baseline-reference-occurrence.py.txt',
        'before-reference-occurrence.py.txt',
    }
    found_workflows = set()
    for entry in workflow_manifest:
        if entry['file'] in workflow_names:
            add(Path('tests/fixtures/file-workflows') / entry['file'], entry['sha256'])
            found_workflows.add(entry['file'])
    if found_workflows != workflow_names:
        raise AssertionError('Missing a pinned file-workflow source')

    history = ROOT / 'tests/fixtures/history'
    history_manifest = json.loads((history / 'manifest.json').read_text())
    inspect = next(entry for entry in history_manifest if entry['file'] == 'inspect-a262.py.txt')
    add(Path('tests/fixtures/history') / inspect['file'], inspect['sha256'])
    cloud = history / 'cloud-9dc58fd.py.txt'
    add(Path('tests/fixtures/history') / cloud.name,
        json.loads(cloud.with_suffix('.json').read_text())['sha256'])

    profiles = json.loads((ROOT / 'tests/live-required-profiles.json').read_text())
    native = next(
        entry for entry in profiles['profiles']['native-fixtures']['cases']
        if entry['id'] == 'iw74-parameter-test'
    )
    add(Path(native['source']), native['sourceSha256'])
    add(Path(native['continuationSource']), native['continuationSourceSha256'])
    return result


def require_frozen_bytes(content, expected, label):
    actual = hashlib.sha256(content).hexdigest()
    if actual != expected:
        raise AssertionError(f'{label}: SHA-256 mismatch: expected {expected}, got {actual}')
    return actual


class FrozenFixtureIntegrityTests(unittest.TestCase):
    def test_pinned_sources_keep_lf_checkout_and_recorded_hashes(self):
        pins = frozen_hashes()
        paths = sorted(pins)
        mixed_path = 'tests/fixtures/modeling-python-history/interference.py'
        lf_paths = [path for path in paths if path != mixed_path]
        attributes = subprocess.run(
            ['git', 'check-attr', 'eol', '--', *lf_paths],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        self.assertEqual(
            attributes.stdout.splitlines(),
            [f'{path}: eol: lf' for path in lf_paths],
        )
        mixed_attributes = subprocess.run(
            ['git', 'check-attr', 'text', 'eol', '--', mixed_path],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        self.assertEqual(
            mixed_attributes.stdout.splitlines(),
            [f'{mixed_path}: text: unset', f'{mixed_path}: eol: unspecified'],
        )
        for path, expected in pins.items():
            with self.subTest(path=path):
                require_frozen_bytes((ROOT / path).read_bytes(), expected, path)
        status = subprocess.run(
            ['git', 'status', '--porcelain', '--', *paths],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        self.assertEqual(status.stdout, '')

    def test_crlf_fixture_and_stale_hash_are_rejected(self):
        path = 'tests/native/iw7.4_parameter_test.py'
        content = (ROOT / path).read_bytes()
        expected = frozen_hashes()[path]
        self.assertNotIn(b'\r\n', content)
        with self.assertRaisesRegex(AssertionError, 'SHA-256 mismatch'):
            require_frozen_bytes(content.replace(b'\n', b'\r\n'), expected, path)

        stale = ('0' if expected[0] != '0' else '1') + expected[1:]
        with self.assertRaisesRegex(AssertionError, 'SHA-256 mismatch'):
            require_frozen_bytes(content, stale, path)


if __name__ == '__main__':
    unittest.main()

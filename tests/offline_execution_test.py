import inspect
import ast
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

REPO = Path(__file__).resolve().parents[1]
sys.path.append(str(REPO / 'assets'))
from offline_execution import call_offline, group_running, process_snapshot, run_offline, timeout_seconds

ARTIFACTS = Path(os.environ.get('TMPDIR', str(REPO / '.test-artifacts')))
ARTIFACTS.mkdir(exist_ok=True)
FAKE = REPO / 'tests/helpers/offline_fake.py'

_FIXTURES = None
ROOT = None


def setUpModule():
    # Created lazily (not at import/discovery time): a module-scope TemporaryDirectory
    # plus unittest.addModuleCleanup is drained by the first module transition of a
    # shared discover run, deleting the fixture before these tests execute.
    global _FIXTURES, ROOT
    _FIXTURES = tempfile.TemporaryDirectory(prefix='offline-timeout-', dir=ARTIFACTS)
    ROOT = Path(_FIXTURES.name)


def tearDownModule():
    global _FIXTURES, ROOT
    if _FIXTURES is not None:
        _FIXTURES.cleanup()
    _FIXTURES = None
    ROOT = None


class OfflineTests(unittest.TestCase):
    def setUp(self):
        # Existing diagnostics assertions explicitly exercise retention mode.
        self.enterContext(patch.dict(os.environ, FMCAD_OFFLINE_DEBUG='true'))

    def test_changed_python_sources_parse_without_running_image_or_cad_code(self):
        sources = [REPO / 'assets' / name for name in
                   ('offline_execution.py', 'offline_worker.py')]
        for source in sources:
            ast.parse(source.read_text(), filename=str(source))

    def test_proc_scan_tolerates_process_disappearing_with_esrch(self):
        vanished = Mock()
        vanished.read_text.side_effect = ProcessLookupError(3, 'No such process')
        owned = Mock()
        owned.parent.name = '23'
        owned.read_text.return_value = '23 (owned worker) ' + ' '.join(['S', '1', '23'] + ['0'] * 16 + ['98765'])
        with patch.object(Path, 'glob', return_value=[vanished, owned]):
            self.assertTrue(group_running(23))
            self.assertEqual(process_snapshot(), {23: ('S', 1, '98765')})

    def test_proc_scan_does_not_treat_access_denied_as_a_dead_process(self):
        inaccessible = Mock()
        inaccessible.read_text.side_effect = PermissionError('denied')
        with patch.object(Path, 'glob', return_value=[inaccessible]):
            with self.assertRaises(PermissionError):
                group_running(23)
            with self.assertRaises(PermissionError):
                process_snapshot()

    def run_fake(self, mode, timeout=.25):
        return run_offline([sys.executable, '-B', str(FAKE), mode],
                           log_parent=ROOT, stage=mode, timeout=timeout)

    def assert_stopped(self, pid):
        # A dead orphan can remain a zombie until the host's init reaps it.
        status = Path(f'/proc/{pid}/stat')
        deadline = time.monotonic() + .5
        while time.monotonic() < deadline:
            try:
                if status.read_text().split(') ')[1].startswith('Z'):
                    return
            except FileNotFoundError:
                return
            time.sleep(.01)
        self.fail(f'Owned descendant {pid} still executing after SIGKILL')

    def test_success_and_failure_retain_streams_and_timestamps(self):
        for mode, code in [('success', 0), ('fail', 7)]:
            result = self.run_fake(mode)
            self.assertEqual(result.returncode, code)
            folder = Path(result.log_directory)
            self.assertIn('retained diagnostic', result.stderr)
            events = [json.loads(line) for line in (folder / 'events.jsonl').read_text().splitlines()]
            self.assertEqual(events[0]['status'], 'started')
            self.assertIn('timestamp', events[-1])
            self.assertGreater(events[-1]['elapsedSeconds'], 0)
            self.assertEqual((folder / 'stdout.txt').read_text(), result.stdout)

    def test_timeout_kills_stubborn_descendant_and_retains_logs(self):
        result = self.run_fake('tree')
        self.assertEqual(result.returncode, 124)
        for line in result.stdout.splitlines():
            if line.startswith(('pid=', 'descendant=')):
                self.assert_stopped(int(line.split('=')[1]))

    def test_leader_exit_does_not_leave_descendant_or_wait_for_pipe_eof(self):
        result = self.run_fake('leader-exit', timeout=2)
        self.assertEqual(result.returncode, 0)
        self.assert_stopped(int(result.stdout.split('descendant=')[1].splitlines()[0]))

    def test_invalid_and_expired_budgets_start_nothing(self):
        self.assertEqual(timeout_seconds('0'), 0)
        for value in ('-1', 'nan', 'inf'):
            with self.assertRaises(ValueError):
                timeout_seconds(value)
        before = set(ROOT.iterdir())
        with patch.dict(os.environ, FMCAD_OFFLINE_DEADLINE_MONOTONIC=str(time.monotonic()-1)):
            with self.assertRaises(TimeoutError):
                self.run_fake('success')
        self.assertEqual(set(ROOT.iterdir()), before)

    def test_callable_worker_json_handoff(self):
        with patch.dict(os.environ, FMCAD_OFFLINE_TIMEOUT_MS='500'):
            self.assertEqual(call_offline('json', 'loads', ['{"ok":true}'], log_parent=ROOT), {'ok': True})

    def test_process_outside_owned_group_is_not_signalled(self):
        with (ROOT / 'sentinel.stdout').open('x') as out, (ROOT / 'sentinel.stderr').open('x') as err:
            sentinel = subprocess.Popen([sys.executable, '-B', str(FAKE), 'wait'],
                                        stdout=out, stderr=err, start_new_session=True)
            try:
                self.assertEqual(self.run_fake('tree').returncode, 124)
                self.assertIsNone(sentinel.poll())
            finally:
                sentinel.kill()
                sentinel.wait(timeout=1)

    def test_nested_pipeline_inherits_remaining_deadline(self):
        code = ('import sys;sys.path.append(' + repr(str(REPO / 'assets')) + ');'
                'from offline_execution import run_offline;'
                'run_offline(' + repr([sys.executable, '-B', str(FAKE), 'tree']) + ','
                'log_parent=' + repr(str(ROOT)) + ',stage="nested",timeout=5)')
        result = run_offline([sys.executable, '-B', '-c', code], log_parent=ROOT,
                             stage='pipeline', timeout=.3)
        self.assertEqual(result.returncode, 124)
        nested = []
        for folder in ROOT.glob('execution-*'):
            rows = [json.loads(line) for line in (folder / 'events.jsonl').read_text().splitlines()]
            if rows[0]['stage'] == 'nested':
                nested = rows
                self.assertLess(rows[0]['timeoutSeconds'], .3)
                for line in (folder / 'stdout.txt').read_text().splitlines():
                    if line.startswith(('pid=', 'descendant=')):
                        self.assert_stopped(int(line.split('=')[1]))
        self.assertTrue(nested)

    def test_supervisor_sigterm_cleans_only_its_new_group(self):
        code = ('import sys;sys.path.append(' + repr(str(REPO / 'assets')) + ');'
                'from offline_execution import run_offline;'
                'run_offline(' + repr([sys.executable, '-B', str(FAKE), 'tree']) + ','
                'log_parent=' + repr(str(ROOT)) + ',stage="interrupt",timeout=5)')
        with (ROOT / 'interrupt.stdout').open('x') as out, (ROOT / 'interrupt.stderr').open('x') as err:
            process = subprocess.Popen([sys.executable, '-B', '-c', code], stdout=out, stderr=err)
            try:
                time.sleep(.2)
                process.send_signal(signal.SIGTERM)
                process.wait(timeout=3)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=1)
        events = []
        for folder in ROOT.glob('execution-*'):
            rows = [json.loads(line) for line in (folder / 'events.jsonl').read_text().splitlines()]
            if rows[0]['stage'] == 'interrupt':
                events = rows
                for line in (folder / 'stdout.txt').read_text().splitlines():
                    if line.startswith(('pid=', 'descendant=')):
                        self.assert_stopped(int(line.split('=')[1]))
        self.assertEqual(events[-1]['status'], 'interrupted')


if __name__ == '__main__':
    print('Fresh synthetic fixtures (removed after tests): ' + str(ROOT), flush=True)
    unittest.main()

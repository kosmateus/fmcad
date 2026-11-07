"""Isolated supervisors only: never touches shared services or Fusion."""
import inspect
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ASSETS = Path(__file__).resolve().parents[1] / 'assets'
sys.path.append(str(ASSETS))
import offline_execution as offline
from generated_cleanup import collect, identity


class HostWorkerCleanupTests(unittest.TestCase):
    def test_internal_callable_stdout_is_one_json_to_eof(self):
        with tempfile.TemporaryDirectory(dir='/tmp/opencode') as root:
            for module, function, args in [('os', '_exit', [0]), ('builtins', 'print', ['{}'])]:
                with self.assertRaises(json.JSONDecodeError):
                    offline.call_offline(module, function, args, log_parent=root)
            with self.assertRaises(RuntimeError):
                offline.call_offline('builtins', 'float', ['nan'], log_parent=root)
            with self.assertRaises(ValueError):
                offline.call_offline('json', 'dumps', [float('inf')], log_parent=root)

    def test_internal_worker_rejects_nonfinite_and_extra_json(self):
        for request in [dict(module='math', function='sqrt', args=[-1], kwargs={}),
                        dict(module='builtins', function='float', args=['nan'], kwargs={})]:
            result = subprocess.run([sys.executable, '-B', str(ASSETS / 'offline_worker.py')],
                                    input=json.dumps(request), capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, '')
            self.assertNotIn('adsk', result.stderr)
        result = subprocess.run([sys.executable, '-B', str(ASSETS / 'offline_worker.py')],
                                input='{} {}', capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)

    def test_success_does_not_collect_replaced_log_or_unknown_file(self):
        with tempfile.TemporaryDirectory(dir='/tmp/opencode') as root:
            # Replace a declared diagnostic after its producer opened it. Cleanup
            # must compare with the created inode, not inventory the replacement.
            code = """import os,pathlib,time
folder=next(pathlib.Path(os.environ['LOG_ROOT']).glob('execution-*'))
(folder/'stdout.txt').unlink()
(folder/'stdout.txt').write_text('foreign replacement')
(folder/'unknown.txt').write_text('sentinel')
print('{}')
"""
            with patch.dict(os.environ, LOG_ROOT=root, FMCAD_OFFLINE_DEBUG='false'):
                result = offline.run_offline([sys.executable, '-B', '-c', code], log_parent=root,
                                             stage='owned-cleanup', timeout=2)
            self.assertEqual(result.returncode, 0)
            folder = Path(result.log_directory)
            self.assertEqual((folder / 'stdout.txt').read_text(), 'foreign replacement')
            self.assertEqual((folder / 'unknown.txt').read_text(), 'sentinel')

    def test_cleanup_retains_symlinks_hardlinks_changed_and_foreign_files(self):
        with tempfile.TemporaryDirectory(dir='/tmp/opencode') as root:
            root = Path(root)
            owned = root / 'owned'; owned.write_text('original')
            inventory = {str(owned): identity(owned)}
            owned.write_text('changed bytes')
            foreign = root / 'foreign'; foreign.write_text('sentinel')
            link = root / 'link'; link.symlink_to(foreign)
            inventory[str(link)] = identity(link)
            hard = root / 'hard'; os.link(foreign, hard)
            inventory[str(hard)] = identity(hard)
            _, freed = collect(inventory, [root])
            self.assertEqual(freed, 0)
            self.assertTrue(all(path.exists() for path in [owned, foreign, link, hard]))

    def test_supervisor_limit_and_non_linux_fail_closed(self):
        with tempfile.TemporaryDirectory(dir='/tmp/opencode') as root:
            result = offline.run_offline([sys.executable, '-B', '-c', "print('x'*10000)"],
                                         log_parent=root, stage='limit', timeout=2, max_output_bytes=100)
            self.assertEqual(result.returncode, 125)
            self.assertEqual(result.stdout, '')
            with patch.object(sys, 'platform', 'darwin'):
                with self.assertRaisesRegex(RuntimeError, 'Linux/WSL'):
                    offline.run_offline([sys.executable], log_parent=root, stage='not-started')


if __name__ == '__main__':
    unittest.main()

import contextlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'assets'))
import offline_execution
from helpers.offline_fake_transport import attach_pipes


class OfflineProgressTests(unittest.TestCase):
    def test_supervisor_marks_only_heartbeat_and_forwards_old_child_streams(self):
        now = 0
        detail = json.dumps(dict(stage='prepare.partition', status='running', completed=3, total=8))
        child_stderr = detail + '\nimage.optimize: 1/2 candidate_000 baseline\n'
        child_stdout = '{"success":true}\n'
        child = Mock(pid=12345, returncode=0)
        child.poll.side_effect = lambda: None if now < 20 else 0

        def spawn(command, **kwargs):
            return attach_pipes(self, child, kwargs, child_stdout.encode(), child_stderr.encode())

        def sleep(seconds):
            nonlocal now
            now += 10

        with tempfile.TemporaryDirectory(prefix='offline-progress-', dir=os.environ.get('TMPDIR', tempfile.gettempdir())) as root, \
             patch.dict(os.environ, {'FMCAD_PROGRESS_EVENTS': '1'}), \
             patch('offline_execution.subprocess.Popen', side_effect=spawn), \
             patch('offline_execution.time.monotonic', side_effect=lambda: now), \
             patch('offline_execution.time.sleep', side_effect=sleep), \
             patch('offline_execution.process_snapshot', return_value={}), \
             patch('offline_execution.os.killpg', side_effect=ProcessLookupError), \
             patch('offline_execution.group_running', return_value=False), \
             contextlib.redirect_stderr(io.StringIO()) as stderr:
            with patch.dict(os.environ):
                os.environ.pop('FMCAD_OFFLINE_DEADLINE_MONOTONIC', None)
                result = offline_execution.run_offline(['synthetic-child'], log_parent=root,
                                                       stage='prepare', timeout=0, debug=True)
            events = [json.loads(line) for line in
                      (Path(result.log_directory) / 'events.jsonl').read_text().splitlines()]
            self.assertEqual([row['status'] for row in events], ['started', 'running', 'completed'])
            self.assertNotIn('supervisorHeartbeat', events[0])
            self.assertIs(events[1]['supervisorHeartbeat'], True)
            self.assertEqual(events[1]['elapsedSeconds'], 10)
            self.assertNotIn('supervisorHeartbeat', events[2])
            self.assertEqual(result.returncode, 0)
            self.assertEqual(result.stdout, child_stdout)
            self.assertEqual(result.stderr, child_stderr)
            forwarded = stderr.getvalue().splitlines()
            self.assertEqual(forwarded[1:3], child_stderr.splitlines())
            self.assertEqual(json.loads(forwarded[3]), events[1])


if __name__ == '__main__':
    unittest.main()

import contextlib
import io
import json
import time
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'assets'))
from diagnostics import DiagnosticStream, redact_diagnostic
from offline_execution import run_offline


class DiagnosticTests(unittest.TestCase):
    def test_pretty_json_credentials_preserve_ordinary_fields_in_all_feed_sizes(self):
        for value in ('"sëcret,with,commas"', '123.5', 'null'):
            for separator in (' ', '\n    ', '\n\n    '):
                source = ('{\n  "password":' + separator + value + ',\n'
                          '  "value": "ordinary",\n  "token": "CAD-token",\n'
                          '  "entityToken": "CAD-entity"\n}\n')
                expected = dict(password='[REDACTED]', value='ordinary', token='CAD-token', entityToken='CAD-entity')
                with self.subTest(value=value, separator=separator):
                    self.assertEqual(json.loads(redact_diagnostic(source)), expected)
                    for fragmented in (False, True):
                        output = []
                        stream = DiagnosticStream(output.append)
                        if fragmented:
                            for byte in source.encode('utf-8'):
                                stream.feed(bytes([byte]))
                            stream.feed(b'', final=True)
                        else:
                            stream.feed(source.encode('utf-8'), final=True)
                        self.assertEqual(json.loads(''.join(output)), expected)
                        self.assertNotIn('sëcret', ''.join(output))

    def test_raw_comma_headers_and_folded_values_have_no_suffix_leak(self):
        for name in ('Cookie', 'Authorization', 'secret'):
            for separator in (' ', '\n  ', '\n'):
                source = (name + ':' + separator + 'first-private, suffix-private\n'
                          '\tfolded-private, folded-suffix\nordinary evidence\n')
                with self.subTest(name=name, separator=separator):
                    output = []
                    stream = DiagnosticStream(output.append)
                    for byte in source.encode():
                        stream.feed(bytes([byte]))
                    stream.feed(b'', final=True)
                    for text in (redact_diagnostic(source), ''.join(output)):
                        for secret in ('first-private', 'suffix-private', 'folded-private', 'folded-suffix'):
                            self.assertNotIn(secret, text)
                        self.assertIn('ordinary evidence', text)

    def test_patterns_leave_cad_tokens_and_json_intact(self):
        value = dict(Authorization='Bearer hidden-secret', entityToken='CAD-token',
                     token='CAD-token', ref='?token=CAD-token',
                     message='https://user:password@host/?api_key=url-secret&doc=123')
        text = redact_diagnostic(json.dumps(value))
        for secret in ('hidden-secret', 'password', 'url-secret'):
            self.assertNotIn(secret, text)
        result = json.loads(text)
        for key in ('entityToken', 'token', 'ref'):
            self.assertEqual(result[key], value[key])
        self.assertEqual(json.loads(redact_diagnostic(json.dumps(dict(message='Authorization: Bearer hidden-secret'))))['message'], 'Authorization: [REDACTED]')
        self.assertNotIn('fragment-secret', redact_diagnostic('https://host/#access_token=fragment-secret'))
        credentials = {name: 'private-"escaped' for name in
                       ('access_token', 'refresh_token', 'client_secret', 'password', 'api_key', 'secret')}
        redacted = redact_diagnostic(json.dumps(credentials))
        self.assertNotIn('private-', redacted)
        self.assertEqual(set(json.loads(redacted).values()), {'[REDACTED]'})

    def run_child(self, folder, ending, debug=False):
        script = ("import sys,time;print('EARLY_EVIDENCE');"
                  "print('Authorization: Bearer hidden-secret');print('x'*20000);"
                  "print('LAST_EVIDENCE');sys.stdout.flush();"
                  "print('https://user:password@host/?token=url-secret',file=sys.stderr,flush=True);" + ending)
        return run_offline([sys.executable, '-B', '-c', script], log_parent=folder,
                           stage='diagnostic-test', timeout=.3, debug=debug)

    def test_real_failure_timeout_retention_and_success_cleanup(self):
        with tempfile.TemporaryDirectory(prefix='diagnostics-') as directory:
            folder = Path(directory)
            historical = folder / 'historical-error.log'
            historical.write_text('Authorization: historical-user-file')
            for ending, code in [('sys.exit(7)', 7), ('time.sleep(10)', 124), ('sys.exit(0)', 0)]:
                result = self.run_child(folder, ending)
                self.assertEqual(result.returncode, code)
                self.assertIn('hidden-secret', result.stdout)  # transport data is not redacted
                self.assertNotIn('url-secret', result.stderr)
                logs = Path(result.log_directory)
                if code == 0:
                    self.assertFalse(logs.exists())
                    continue
                self.assertFalse((logs / 'active.json').exists())
                text = (logs / 'stdout.txt').read_text()
                self.assertIn('EARLY_EVIDENCE', text)
                self.assertIn('LAST_EVIDENCE', text)
                self.assertGreater(len(text), 20000)
                self.assertNotIn('hidden-secret', text)
                self.assertNotIn('url-secret', (logs / 'stderr.txt').read_text())
                events = [json.loads(line) for line in (logs / 'events.jsonl').read_text().splitlines()]
                self.assertEqual(events[-1]['cleanup'], 'confirmed')
            self.assertEqual(historical.read_text(), 'Authorization: historical-user-file')

    def test_no_post_exit_sanitization_rewrite(self):
        original = Path.open
        def open_stream(path, *args, **kwargs):
            if path.name == 'stdout.txt.sanitized':
                raise OSError('synthetic write failure')
            return original(path, *args, **kwargs)
        with tempfile.TemporaryDirectory(prefix='diagnostics-') as directory, \
                patch.object(Path, 'open', open_stream), contextlib.redirect_stderr(io.StringIO()) as stderr:
            result = self.run_child(directory, 'sys.exit(7)')
            self.assertEqual(result.returncode, 7)
            self.assertNotIn('may contain credentials', stderr.getvalue())
            self.assertIn('LAST_EVIDENCE', (Path(result.log_directory) / 'stdout.txt').read_text())

    def test_unconfirmed_cleanup_retains_checkpoint_and_sanitized_capture(self):
        with tempfile.TemporaryDirectory(prefix='diagnostics-') as directory, \
                patch('offline_execution.group_running', return_value=True), \
                contextlib.redirect_stderr(io.StringIO()) as stderr:
            with self.assertRaisesRegex(RuntimeError, 'descendants still running'):
                self.run_child(directory, 'sys.stdout.write(\'{"secret":"partial-private\');sys.stdout.flush();sys.exit(7)', debug=True)
            logs, = Path(directory).iterdir()
            self.assertTrue((logs / 'active.json').exists())
            self.assertNotIn('hidden-secret', (logs / 'stdout.txt').read_text())
            self.assertNotIn('url-secret', (logs / 'stderr.txt').read_text())
            self.assertNotIn('hidden-secret', stderr.getvalue())
            self.assertNotIn('partial-private', (logs / 'stdout.txt').read_text())
            self.assertIn('[REDACTED]', (logs / 'stdout.txt').read_text())
            events = [json.loads(line) for line in (logs / 'events.jsonl').read_text().splitlines()]
            self.assertEqual(events[-1]['cleanup'], 'unconfirmed')

    def test_fragmented_credentials_never_reach_disk_during_real_child_sleep(self):
        payload = ('{"access_token":"access-private", "refresh_token":"refresh-private",'
                   '"client_secret":"client-private", "password":"pass-private",'
                   '"api_key":"api-private", "secret":"sëcret-private",'
                   '"token":"CAD-token", "entityToken":"CAD-entity", "signature":"CAD-signature"}\n'
                   'Authorization: Bearer header-private\n\tfolded-private\n'
                   'https://user:url-private@host/?token=query-private\n')
        secrets = ['access-private', 'refresh-private', 'client-private', 'pass-private',
                   'api-private', 'sëcret-private', 'header-private', 'folded-private',
                   'url-private', 'query-private']
        code = ('import os,sys,time\n'
                'data=sys.stdin.buffer.read()\n'
                'for byte in data:\n'
                ' os.write(1,bytes([byte])); os.write(2,bytes([byte])); time.sleep(.001)\n'
                'os.write(2,b"SLEEPING\\n"); time.sleep(.3)\n')
        with tempfile.TemporaryDirectory(prefix='diagnostics-live-') as directory:
            stop = threading.Event()
            leaks = []
            observed = []
            def inspect_live():
                while not stop.wait(.005):
                    for path in Path(directory).glob('execution-*/*'):
                        text = path.read_text()
                        leaks.extend(secret for secret in secrets if secret in text)
                        if path.name == 'stderr.txt' and 'SLEEPING' in text:
                            observed.append(True)
            observer = threading.Thread(target=inspect_live)
            observer.start()
            try:
                result = run_offline([sys.executable, '-B', '-c', code], input_text=payload,
                                     log_parent=directory, stage='fragmented', timeout=5, debug=True)
            finally:
                stop.set()
                observer.join(timeout=1)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(result.stdout, payload)
            self.assertTrue(observed, 'must inspect captures while the child sleeps')
            self.assertEqual(leaks, [])
            for path in Path(result.log_directory).iterdir():
                for secret in secrets:
                    self.assertNotIn(secret, path.read_text())
            self.assertIn('CAD-entity', result.stderr)

    def test_large_raw_handoff_and_stdout_have_no_output_cap(self):
        payload = json.dumps(dict(secret='private-input', entityToken='CAD-' + 'x'*300000))
        with tempfile.TemporaryDirectory(prefix='diagnostics-handoff-') as directory:
            result = run_offline([sys.executable, '-B', '-c',
                                  'import sys;sys.stdout.buffer.write(sys.stdin.buffer.read())'],
                                 input_text=payload, log_parent=directory, stage='handoff', timeout=5, debug=True)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(result.stdout, payload)
            for name in ('stdin.txt', 'stdout.txt'):
                self.assertNotIn('private-input', (Path(result.log_directory) / name).read_text())

    def test_incremental_utf8_partial_json_and_header_continuations(self):
        output = []
        stream = DiagnosticStream(output.append)
        text = 'Authorization:\n Bearer private\n folded-private\n{"secret":"sëcret'
        for byte in text.encode():
            stream.feed(bytes([byte]))
        self.assertNotIn('sëcret', ''.join(output))
        stream.feed(b'', final=True)
        self.assertNotIn('private', ''.join(output))
        self.assertNotIn('sëcret', ''.join(output))

    def test_busy_output_and_unread_stdin_do_not_starve_timeout(self):
        with tempfile.TemporaryDirectory(prefix='diagnostics-busy-') as directory:
            started = time.monotonic()
            result = run_offline([sys.executable, '-B', '-c',
                                  'import os\nwhile True: os.write(1,b"{\\"secret\\":\\"busy-private\\"}\\n"*1000)'],
                                 input_text='x'*200000, log_parent=directory, stage='busy', timeout=.2, debug=True)
            self.assertEqual(result.returncode, 124)
            self.assertLess(time.monotonic()-started, 3)
            self.assertNotIn('busy-private', (Path(result.log_directory) / 'stdout.txt').read_text())


if __name__ == '__main__':
    unittest.main()

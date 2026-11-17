"""No SDK and no execution of submitted Python: codec/AST boundary regressions."""
import ast
import base64
import hashlib
import json
import random
from pathlib import Path
import subprocess
import sys
import unittest
import zlib

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'runtime/python/typing'))
import source_codec as codec


class SourceCodecTest(unittest.TestCase):
    def source(self):
        # Unicode, CRLF and a top-level failure must survive byte-for-byte;
        # extraction must not execute even the first line.
        return "raise RuntimeError('must not execute offline')\r\n" + "# żółw 🐢\r\n" * 65000

    def test_exact_bytes_and_no_exec(self):
        source = self.source()
        encoded = codec.encode_source(source)
        self.assertGreater(len(source.encode('utf-8')), 512 * 1024)
        self.assertLess(codec._json_string_bytes(encoded), codec._json_string_bytes(source))
        self.assertEqual(codec.decoded_envelope(encoded, ast.parse(encoded)), source)
        result = subprocess.run(
            [sys.executable, '-I', '-S', '-B', str(ROOT / 'runtime/python/entrypoints/source_units.py')],
            input=json.dumps({'source': encoded}), text=True, capture_output=True, check=True)
        extracted = json.loads(result.stdout)
        self.assertEqual(extracted['source'], encoded)
        self.assertEqual(extracted['units'][0]['source'], source)

    def test_small_source_and_unmarked_dynamic_compile_remain_unchanged(self):
        source = "exec(compile(context, '<dynamic>', 'exec'))\n"
        self.assertEqual(codec.encode_source(source), source)
        self.assertIsNone(codec.decoded_envelope(source, ast.parse(source)))

    def test_source_units_accepts_header_like_embedded_python(self):
        source = codec.HEADER + "exec('pass')\n" + '# padding\n' * 200
        result = subprocess.run(
            [sys.executable, '-I', '-S', '-B', str(ROOT / 'runtime/python/entrypoints/source_units.py')],
            input=json.dumps({'source': source, 'encodeNative': True}),
            text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        extracted = json.loads(result.stdout)
        self.assertNotEqual(extracted['source'], source)
        self.assertEqual(extracted['units'][0]['filename'], codec.FILENAME)
        self.assertEqual(extracted['units'][0]['source'], source)

    def test_source_units_extracts_native_envelope_with_addin_entrypoint(self):
        source = "def run(_context: str) -> None:\n    pass\n" + '# padding\n' * 200
        entrypoint = ROOT / 'runtime/python/entrypoints/source_units.py'
        encoded_result = subprocess.run(
            [sys.executable, '-I', '-S', '-B', str(entrypoint)],
            input=json.dumps({'source': source, 'encodeNative': True}),
            text=True, capture_output=True, check=True)
        encoded = json.loads(encoded_result.stdout)['source']
        script = encoded + '\n\nrun("")\n'
        result = subprocess.run(
            [sys.executable, '-I', '-S', '-B', str(entrypoint)],
            input=json.dumps({'source': script}), text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        extracted = json.loads(result.stdout)
        self.assertEqual(extracted['source'], script)
        self.assertEqual(extracted['units'][0]['filename'], codec.FILENAME)
        self.assertEqual(extracted['units'][0]['source'], source)

    def test_source_units_rejects_addin_entrypoint_missing_from_decoded_source(self):
        source = 'pass\n' + '# padding\n' * 500
        entrypoint = ROOT / 'runtime/python/entrypoints/source_units.py'
        encoded_result = subprocess.run(
            [sys.executable, '-I', '-S', '-B', str(entrypoint)],
            input=json.dumps({'source': source, 'encodeNative': True}),
            text=True, capture_output=True, check=True)
        encoded = json.loads(encoded_result.stdout)['source']
        self.assertNotEqual(encoded, source)
        result = subprocess.run(
            [sys.executable, '-I', '-S', '-B', str(entrypoint)],
            input=json.dumps({'source': encoded + '\nrun("")\n'}),
            text=True, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('ADDIN source envelope has no run entrypoint', result.stderr)

    def test_compressible_source_below_previous_threshold_uses_smaller_json(self):
        source = '# padding\n' * 25999 + '# padding'
        self.assertEqual(len(source.encode('utf-8')), 259999)
        self.assertLess(len(source.encode('utf-8')), 512 * 1024)
        encoded = codec.encode_source(source)
        self.assertTrue(encoded != source, 'beneficial sub-threshold input should be encoded')
        self.assertLess(codec._json_string_bytes(encoded), codec._json_string_bytes(source))
        self.assertTrue(codec.decoded_envelope(encoded, ast.parse(encoded)) == source,
                        'the selected envelope must round-trip exactly')

    def test_equal_json_cost_keeps_plain_source(self):
        randomizer = random.Random(731)
        filler = ''.join(randomizer.choices(
            'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', k=529996))
        source = '# repeated padding\n' * 164 + '# ' + filler
        data = source.encode('utf-8')
        candidate = codec.envelope(
            base64.b64encode(zlib.compress(data, 9)).decode('ascii'),
            len(data), hashlib.sha256(data).hexdigest())
        self.assertGreater(len(data), 512 * 1024)
        self.assertEqual(codec._json_string_bytes(candidate), codec._json_string_bytes(source))
        self.assertTrue(codec.encode_source(source) == source, 'ties must keep the plain source')

    def test_json_string_cost_matches_javascript_json_stringify(self):
        values = [
            'żółw 🐢',
            'quotes: " and backslash: \\',
            '\x00\x01\x07\x08\x09\x0a\x0b\x0c\x0d\x1f',
            '\x7f\u2028\u2029',
        ]
        script = (
            "const fs = require('node:fs'); "
            "const values = JSON.parse(fs.readFileSync(0, 'utf8')); "
            "process.stdout.write(JSON.stringify(values.map(value => "
            "Buffer.byteLength(JSON.stringify(value)))));"
        )
        result = subprocess.run(
            ['node', '-e', script], input=json.dumps(values), text=True,
            capture_output=True, check=True)
        javascript_costs = json.loads(result.stdout)
        self.assertEqual([codec._json_string_bytes(value) for value in values], javascript_costs)
        with self.assertRaises(UnicodeEncodeError):
            codec.encode_source('\ud800')

    def test_encoding_never_expands_incompressible_source(self):
        randomizer = random.Random(0)
        source = '# ' + ''.join(randomizer.choices(
            'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', k=600000))
        self.assertTrue(codec.encode_source(source) == source, 'incompressible input should stay plain')
        with self.assertRaises(ValueError):
            codec.decode_payload('A' * (24 * 1024 * 1024 + 1), 0, '0' * 64)

    def test_template_changes_and_extra_statements_are_not_exempted(self):
        encoded = codec.encode_source(self.source())
        for changed in [encoded + '\npass\n', encoded.replace('size + 1', 'size + 2'),
                        encoded.replace("'exec'), globals()", "'eval'), globals()")]:
            with self.subTest(source=changed[:80]), self.assertRaises(ValueError):
                codec.decoded_envelope(changed, ast.parse(changed))

    def test_strict_stream_size_digest_and_utf8(self):
        data = b'print("unchanged")\n'
        packed = zlib.compress(data)
        digest = hashlib.sha256(data).hexdigest()
        cases = [
            (base64.b64encode(packed).decode(), len(data) - 1, digest),
            (base64.b64encode(packed).decode(), len(data) + 1, digest),
            (base64.b64encode(packed).decode(), len(data), '0' * 64),
            (base64.b64encode(packed + b'x').decode(), len(data), digest),
            (base64.b64encode(packed + packed).decode(), len(data), digest),
            (base64.b64encode(packed[:-1]).decode(), len(data), digest),
            ('!invalid!', len(data), digest),
            (base64.b64encode(packed).decode(), True, digest),
            (base64.b64encode(packed).decode(), codec.MAX_SOURCE_BYTES + 1, digest),
            (base64.b64encode(zlib.compress(b'x' * 1000000)).decode(), 1, digest),
            (base64.b64encode(zlib.compress(b'\xff')).decode(), 1, hashlib.sha256(b'\xff').hexdigest()),
        ]
        for args in cases:
            with self.subTest(size=args[1]), self.assertRaises((ValueError, zlib.error)):
                codec.decoded_envelope(codec.envelope(*args), ast.parse(codec.envelope(*args)))

    def test_decoded_limit_accepts_above_ten_mib_and_rejects_above_sixteen(self):
        source = '# padding\n' * (11 * 1024 * 1024 // 10)
        encoded = codec.encode_source(source)
        self.assertEqual(codec.decoded_envelope(encoded, ast.parse(encoded)), source)
        with self.assertRaises(ValueError):
            codec.encode_source('x' * (codec.MAX_SOURCE_BYTES + 1))


if __name__ == '__main__':
    unittest.main()

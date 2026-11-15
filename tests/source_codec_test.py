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
        self.assertLess(len(encoded.encode()), len(source.encode()))
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

    def test_encoding_never_expands_incompressible_source(self):
        randomizer = random.Random(0)
        source = '# ' + ''.join(randomizer.choices(
            'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', k=600000))
        self.assertEqual(codec.encode_source(source), source)
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

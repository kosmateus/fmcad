"""Native handoff contract stubs only; no Fusion/kernel acceptance claim."""
import ast
import math
from pathlib import Path
import types
import unittest

ROOT = Path(__file__).resolve().parents[1]


class Matrix:
    def __init__(self):
        self.cells = [[1., 0., 0.], [0., 1., 0.], [0., 0., 1.]]

    @staticmethod
    def create():
        return Matrix()

    def getCell(self, r, c):
        return self.cells[r][c]

    def setCell(self, r, c, value):
        self.cells[r][c] = value
        return True

    def asArray(self):
        return sum(self.cells, [])


def fields(data, required, optional=()):
    if not isinstance(data, dict) or set(required) - data.keys() or data.keys() - set(required) - set(optional):
        raise ValueError('Invalid fields')


class ReferenceNativeTest(unittest.TestCase):
    def setUp(self):
        self.ns = {'math': math, '_cad_fields': fields, '_cad_type': lambda c: c.kind,
                   '_cad_require_result': lambda result, message: self.assertTrue(result),
                   'adsk': types.SimpleNamespace(core=types.SimpleNamespace(Matrix2D=Matrix))}
        tree = ast.parse((ROOT / 'assets/cad/io.py').read_text())
        function = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == '_io_reference_image')
        exec(compile(ast.Module(body=[function], type_ignores=[]), 'io.py', 'exec'), self.ns)
        exec(compile((ROOT / 'assets/cad/reference.py').read_text(), 'reference.py', 'exec'), self.ns)
        self.canvas = types.SimpleNamespace(kind='Canvas', transform=Matrix())
        self.ctx = types.SimpleNamespace(resolve=lambda r: self.canvas, ref=lambda c: {'token': 'canvas'},
                                         length=lambda s: float(s.split()[0]) / 10,
                                         angle=lambda s: math.radians(float(s.split()[0])))
        self.data = {'mode': 'calibrate', 'ref': {'token': 'canvas'}, 'segment': [['0 mm', '0 mm'], ['25 mm', '0 mm']],
                     'length': '100 mm', 'anchor': ['10 mm', '20 mm'], 'angle': '90 deg'}

    def call(self, data):
        return self.ns['_io_reference_image'](self.ctx, data)

    def test_legacy_calibration_and_inspection(self):
        result = self.call(self.data)
        self.assertEqual(result['calibration']['scaleFactor'], 4)
        actual = self.call({'mode': 'inspect', 'ref': 'canvas'})
        self.assertEqual(actual['transform'], result['transform'])
        self.assertFalse(actual['metricVerification'])
        self.assertEqual(actual['status'], 'notEvaluated')

    def test_provenance_and_open_source_guard(self):
        provenance = {'path': 'original.png', 'sha256': 'a' * 64, 'status': 'OPEN', 'uncertainty': '2 mm'}
        before = self.canvas.transform.asArray()
        result = self.call({**self.data, 'source': provenance})
        self.assertEqual(result['status'], 'blocked')
        self.assertEqual(self.canvas.transform.asArray(), before)
        provenance['status'] = 'ESTIMATED'
        result = self.call({**self.data, 'source': provenance})
        self.assertEqual(result['provenance'], provenance)
        self.assertEqual(result['calibration']['scaleFactor'], 4)
        self.assertFalse(result['metricVerification'])

    def test_wrong_entity_and_invalid_source_do_not_mutate(self):
        for status, sha in [('WRONG', 'a' * 64), ('DERIVED', 'a' * 64), ('CONFIRMED', 'bad')]:
            with self.assertRaises(ValueError):
                self.call({**self.data, 'source': {'path': 'x', 'sha256': sha, 'status': status, 'uncertainty': '1 mm'}})
        self.canvas.kind = 'Body'
        with self.assertRaisesRegex(ValueError, 'Canvas'):
            self.call({'mode': 'inspect', 'ref': 'body'})
        self.assertEqual(self.canvas.transform.asArray(), Matrix().asArray())


if __name__ == '__main__':
    unittest.main()

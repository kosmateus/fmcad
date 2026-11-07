"""Pure in-memory export contract tests; no Fusion or filesystem writes/cleanup."""
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import Mock, patch
from python_test_support import load_legacy_core


class STLOptions:
    def __init__(self):
        self.unitType = None
        self.meshRefinement = 1  # SDK medium default, simulated.
        self._deviation = 0.01
        self.assignments = []

    @property
    def surfaceDeviation(self):
        return self._deviation

    @surfaceDeviation.setter
    def surfaceDeviation(self, value):
        self.assignments.append(value)
        self._deviation = value
        self.meshRefinement = 3  # SDK setter selects custom, simulated.


class MeshToleranceTests(unittest.TestCase):
    def setUp(self):
        adsk = types.ModuleType('adsk')
        adsk.core = types.ModuleType('adsk.core')
        adsk.fusion = types.ModuleType('adsk.fusion')
        adsk.fusion.DistanceUnits = types.SimpleNamespace(
            MillimeterDistanceUnits=1, CentimeterDistanceUnits=2, InchDistanceUnits=3)
        self.module = types.ModuleType('mesh_under_test')
        root = Path(__file__).resolve().parents[1]
        with patch.dict(sys.modules, {'adsk': adsk, 'adsk.core': adsk.core, 'adsk.fusion': adsk.fusion}):
            load_legacy_core(self.module.__dict__, root)
            for name in ('io',):
                source = root / 'assets/cad' / (name + '.py')
                exec(compile(source.read_text(), str(source), 'exec'), self.module.__dict__)
        self.options = STLOptions()
        self.manager = types.SimpleNamespace(
            createSTLExportOptions=Mock(return_value=self.options),
            createC3MFExportOptions=Mock(return_value=self.options), execute=Mock(return_value=True))
        # Stub only the SDK units evaluator; exercise the real ctx.length/_expression.
        values = {'0.005 mm': 0.0005, '0.0005 cm': 0.0005, 'tol': 0.0005,
                  '0 mm': 0, '-1 mm': -0.1, 'nan mm': float('nan')}
        units = types.SimpleNamespace(
            isValidExpression=lambda expression, unit: unit == 'cm' and expression in values,
            evaluateExpression=Mock(side_effect=lambda expression, unit: values[expression]))
        self.ctx = object.__new__(self.module.CadContext)
        self.ctx.design = types.SimpleNamespace(exportManager=self.manager, unitsManager=units)
        self.ctx.component = types.SimpleNamespace(objectType='adsk::fusion::Component')
        self.module._io_path = lambda ctx, data, **kwargs: Path(data['path'])
        self.file_row = {'path': '/virtual/part.stl', 'exists': True, 'bytes': 10,
                         'pathHost': 'machine running Fusion', 'geometryVerified': False}
        self.module._io_file = lambda path: dict(self.file_row)

    def call(self, **data):
        return self.module._io_export(self.ctx, dict(path='/virtual/part.stl', units='mm', **data), 'mesh')

    def test_explicit_cm_conversion_and_observed_settings(self):
        for expression in ('0.005 mm', '0.0005 cm', 'tol'):
            with self.subTest(expression=expression):
                result = self.call(surfaceDeviation=expression)
                self.assertAlmostEqual(self.options.assignments[-1], 0.0005)
                self.assertEqual(self.options.unitType, 1)
                self.assertEqual(result, dict(self.file_row, tessellation={
                    'surfaceDeviation': expression, 'surfaceDeviationCm': 0.0005, 'meshRefinement': 3}))
        self.assertEqual(self.manager.execute.call_count, 3)

    def test_default_unchanged_for_both_formats(self):
        self.assertEqual(self.call(), self.file_row)
        self.module._io_export(self.ctx, {'path': '/virtual/part.3mf'}, 'mesh')
        self.assertEqual(self.options.assignments, [])
        self.assertEqual(self.options.meshRefinement, 1)
        self.assertEqual(self.manager.execute.call_count, 2)

    def test_tolerance_cm_is_independent_of_output_units(self):
        for unit, enum_value in (('mm', 1), ('cm', 2), ('in', 3)):
            with self.subTest(unit=unit):
                self.module._io_export(self.ctx, {'path': '/virtual/part.stl',
                    'units': unit, 'surfaceDeviation': '0.005 mm'}, 'mesh')
                self.assertAlmostEqual(self.options.surfaceDeviation, 0.0005)
                self.assertEqual(self.options.unitType, enum_value)

    def test_invalid_inputs_rejected_before_options_or_export(self):
        cases = [dict(path='/virtual/part.stl', units='mm', surfaceDeviation=value)
                 for value in ('0 mm', '-1 mm', '1 deg', '0.005', 0.005, '', None, 'nan mm')]
        cases += [dict(path='/virtual/part.3mf', surfaceDeviation='0.005 mm'),
                  dict(path='/virtual/part.stl', units='bad', surfaceDeviation='0.005 mm'),
                  dict(path='/virtual/part.stl', surfaceDeviation='0.005 mm')]
        for data in cases:
            with self.subTest(data=data), self.assertRaises(ValueError):
                self.module._io_export(self.ctx, data, 'mesh')
        self.manager.createSTLExportOptions.assert_not_called()
        self.manager.createC3MFExportOptions.assert_not_called()
        self.manager.execute.assert_not_called()
        self.assertEqual(self.options.assignments, [])

    def test_parts_rejects_tolerance(self):
        with self.assertRaises(ValueError):
            self.module._io_parts(self.ctx, {'parts': [{'ref': 'root', 'format': 'mesh',
                'path': '/virtual/part.stl', 'units': 'mm', 'surfaceDeviation': '0.005 mm'}]})
        self.manager.createSTLExportOptions.assert_not_called()
        self.manager.execute.assert_not_called()

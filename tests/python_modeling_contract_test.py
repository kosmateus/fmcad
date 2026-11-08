"""Historical, SDK-free measurement policy contracts; not native qualification."""
import builtins
import hashlib
import json
import math
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / 'tests/fixtures/modeling-history'


def load(source, filename):
    namespace = {'_cad_cast': lambda expected, value: value}
    exec(compile(source, filename, 'exec'), namespace)
    return namespace


def outcome(function, value, dimension, data):
    try:
        return ('value', function(value, dimension, data))
    except Exception as error:
        return ('error', type(error).__name__, str(error))


class MeasurementPolicyContracts(unittest.TestCase):
    def test_units_errors_and_zero_match_both_historical_implementations(self):
        current = load((ROOT / 'runtime/python/fmcad/domain/measure.py').read_text(), 'measure-domain')
        references = json.loads((FIXTURES / 'measurement-manifest.json').read_text())
        for reference in references:
            content = (FIXTURES / reference['fixture']).read_bytes()
            self.assertEqual(hashlib.sha256(content).hexdigest(), reference['sha256'])
            historical = load(content.decode(), reference['fixture'])
            for dimension, units in historical['_MEASURE_UNITS'].items():
                for unit in (None, *units, 'unsupported'):
                    for value in (0, -0.0, 1.25, -2.5, math.inf, -math.inf, math.nan, None):
                        data = {} if unit is None else {'units': unit}
                        with self.subTest(revision=reference['revision'], dimension=dimension, unit=unit, value=value):
                            self.assertEqual(outcome(current['_measure_value'], value, dimension, data),
                                             outcome(historical['_measure_value'], value, dimension, data))
                            self.assertEqual(data, {} if unit is None else {'units': unit})
        self.assertEqual(current['_measure_value'](0, 'volume', {}),
                         {'value': 0.0, 'units': 'mm3', 'dimension': 'volume'})
        self.assertEqual(current['_measure_value'](2, 'volume', {} )['value'], 2000)
        self.assertEqual(current['_measure_value'](2, 'length', {} )['value'], 20)
        self.assertAlmostEqual(current['_measure_value'](math.pi, 'angle', {})['value'], 180)

    def test_measurement_policy_import_has_no_sdk_or_host_dependency(self):
        original = builtins.__import__
        def pure_import(name, *args, **kwargs):
            if name != 'math':
                raise AssertionError('Unexpected measurement policy dependency: ' + name)
            return original(name, *args, **kwargs)
        with patch('builtins.__import__', pure_import):
            namespace = load((ROOT / 'runtime/python/fmcad/domain/measure.py').read_text(), 'measure-domain')
            self.assertEqual(namespace['_measure_value'](1, 'mass', {'units': 'g'})['value'], 1000)

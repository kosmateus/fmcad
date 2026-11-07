"""FAKE helpers only: diagnostic evidence separation and stop-after-restore guards."""
import math
from pathlib import Path
import runpy
import sys
import types
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'assets/native-qualification/drive-precision.py'


class Facade:
    def __init__(self, mode):
        self.mode, self.angle, self.writes, self.report = mode, 0, [], None
        self.doc = types.SimpleNamespace(name='FAKE', creationId='fake-precision')
        self.root = types.SimpleNamespace(**{key: types.SimpleNamespace(count=0)
            for key in ('bRepBodies', 'sketches', 'allOccurrences')})
        self.design = types.SimpleNamespace(timeline=types.SimpleNamespace(count=0))

    def emit(self, report):
        assert self.report is None
        self.report = report

    def call(self, op, data):
        if op == 'document.status':
            return {'creationId': self.doc.creationId, 'saved': False, 'modified': False}
        if op == 'component.create':
            return {'occurrence': {'name': data['name'], 'kind': 'occurrence'}}
        if op == 'assembly.ground':
            return {'grounded': True}
        if op == 'joint.revolute':
            return {'joint': {'kind': 'AsBuiltJoint', 'name': data['name']}}
        if op == 'joint.inspect':
            return {'motionType': 'RevoluteJointMotion', 'units': 'cm/rad', 'rotationValue': self.angle}
        if op == 'snapshot':
            return {'occurrences': [{'ref': {'name': 'FAKE_Rotor:1'}, 'transform': [self.angle] + [0]*15}]}
        assert op == 'joint.drive', op
        requested = float(data['rotation'].split()[0])
        self.writes.append(requested)
        if requested == 0 and self.mode == 'restore-unknown':
            raise RuntimeError('Synthetic restore error')
        quantize = lambda value: math.radians(round(math.degrees(value), 1))
        evaluated = quantize(requested) if self.mode == 'evaluation-rounding' else requested
        before = quantize(evaluated) if self.mode == 'setter-rounding' else evaluated
        after = quantize(before) if self.mode == 'capture-rounding' else before
        if requested == 0 and self.mode == 'restore-fail':
            after = .1
        self.angle = after
        return {'coordinateReadback': {'evaluated': {'rotationValue': evaluated},
            'beforeCapture': {'rotationValue': before}}, 'rotationValue': after}


class PrecisionFixtureTests(unittest.TestCase):
    def execute(self, mode):
        namespace = runpy.run_path(str(SOURCE))
        facade = Facade(mode)
        adsk, core = types.ModuleType('adsk'), types.ModuleType('adsk.core')
        adsk.core = core
        core.Application = types.SimpleNamespace(get=lambda: types.SimpleNamespace(version='fake-build'))
        namespace['run'].__globals__.update(FMCAD=facade, ARGS={'approved': True,
            'creationId': facade.doc.creationId, 'expectedFusionVersion': 'fake-build', 'fixturePrefix': 'NQPRECISION'})
        with patch.dict(sys.modules, {'adsk': adsk, 'adsk.core': core}):
            report = namespace['run']('')
        self.assertIs(report, facade.report)
        self.assertFalse(report['nativeQualified'])
        self.assertFalse(report['arbitraryAnglePrecisionQualified'])
        return facade, report

    def test_distinct_stage_evidence_without_reclassifying_quantization_as_pass(self):
        for mode in ('normal', 'evaluation-rounding', 'setter-rounding', 'capture-rounding'):
            with self.subTest(mode=mode):
                facade, report = self.execute(mode)
                self.assertTrue(report['diagnosticComplete'])
                self.assertEqual(len(facade.writes), 6)
                self.assertTrue(all(t['restore']['status'] == 'pass' for t in report['trials']))
                first = report['trials'][0]
                rounded = math.radians(2.9)
                self.assertEqual(first['evaluatedRadians'], rounded if mode == 'evaluation-rounding' else .05)
                self.assertEqual(first['beforeCaptureRadians'], rounded if mode in ('evaluation-rounding', 'setter-rounding') else .05)
                self.assertEqual(first['afterCaptureRadians'], .05 if mode == 'normal' else rounded)
                self.assertEqual(first['independentJointReadback']['rotationValue'], first['afterCaptureRadians'])

    def test_unproven_restore_stops_after_first_trial_without_second_write_to_target(self):
        for mode, expected in [('restore-fail', 'fail'), ('restore-unknown', 'unknown')]:
            with self.subTest(mode=mode):
                facade, report = self.execute(mode)
                self.assertFalse(report['diagnosticComplete'])
                self.assertEqual(facade.writes, [.05, 0])
                self.assertEqual(len(report['trials']), 1)
                self.assertEqual(report['trials'][0]['restore']['status'], expected)


if __name__ == '__main__':
    unittest.main()

"""Offline evidence only: these fake ports do not qualify Fusion solver behavior."""
import math
from pathlib import Path
from types import SimpleNamespace
import unittest


ROOT = Path(__file__).resolve().parents[1]
NS = {}
for UNIT in ('domain', 'application', 'adapters/fusion'):
    exec(compile((ROOT / 'runtime/python/fmcad' / UNIT / 'native_drive.py').read_text(),
                 UNIT + '/native_drive.py', 'exec'), NS)


def plan(**changes):
    data = {'schemaVersion': 1, 'confirm': True, 'driver': 'driver', 'waypoints': [0, .2, .4, .6],
            'followers': [{'joint': 'follower', 'coordinate': 'rotation', 'ratio': -2,
                           'phase': .3, 'tolerance': 1e-6}]}
    data.update(changes)
    return NS['_native_drive_plan'](data)


class FakePort:
    def __init__(self, ratio=-2, phase=.3, disconnected=False):
        self.driver, self.follower = 0, phase
        self.ratio, self.phase, self.disconnected = ratio, phase, disconnected
        self.writes, self.reads = [], 0
        self.fail_at = self.cancel_at = self.budget_at = None
        self.restore_failure = self.read_failure = self.transform_failure = False
        self.guard_failure = False
        self.clock_calls = 0

    def guard(self):
        if self.guard_failure and self.writes:
            raise ValueError('document changed')

    def drive_driver(self, value):
        self.writes.append(('driver', value))
        if self.restore_failure and len(self.writes) > 1 and value == 0:
            raise RuntimeError('restore setter failed')
        self.driver = value
        if not self.disconnected:
            self.follower = self.ratio * value + self.phase
        if len(self.writes) == self.fail_at:
            raise RuntimeError('setter changed pose then failed')

    def read(self):
        self.reads += 1
        if self.read_failure and self.reads > 2:
            raise RuntimeError('read failed')
        wrap = lambda v: (v + math.pi) % (2 * math.pi) - math.pi
        return {'joints': {'driver': {'rotation': wrap(self.driver)},
                           'follower:0': {'rotation': wrap(self.follower)}},
                'transforms': {'0': {'x': self.driver}, '1': {'x': self.follower +
                    (1 if self.transform_failure and self.writes and self.driver == 0 else 0)}}}

    def cancelled(self):
        return self.cancel_at is not None and len(self.writes) >= self.cancel_at

    def clock(self):
        self.clock_calls += 1
        if self.clock_calls == 1:
            return 0
        return 20 if self.budget_at is not None and len(self.writes) >= self.budget_at else 0


class NativeDriveTest(unittest.TestCase):
    def run_port(self, port=None, **changes):
        port = port or FakePort()
        result = NS['_native_drive_run'](plan(**changes), port)
        self.assertTrue(all(key == 'driver' for key, _ in port.writes))
        return result

    def test_coupled_and_independent_restore(self):
        port = FakePort()
        result = self.run_port(port)
        self.assertTrue(result['passed'])
        self.assertEqual(result['capture'], result['restore']['readback'])
        self.assertEqual(port.reads, 6)
        self.assertFalse(result['nativeCapability']['qualified'])
        self.assertEqual(result['nativeCapability']['status'], 'unknown')
        self.assertEqual(result['nativeCapability']['motionLinkCreation'], 'separate-operation-not-run')

    def test_quantized_setter_retains_off_grid_failure_and_strict_grid_coupling_checks(self):
        class QuantizedPort(FakePort):
            def drive_driver(self, value):
                super().drive_driver(math.radians(round(math.degrees(value), 1)))

        def evaluate(step, expected_ratio=1, expected_phase=0, disconnected=False):
            return self.run_port(QuantizedPort(ratio=1, phase=0, disconnected=disconnected),
                waypoints=[index * step for index in range(5)], driverTolerance=1e-6,
                restoreTolerance=1e-6, followers=[{'joint': 'follower', 'coordinate': 'rotation',
                    'ratio': expected_ratio, 'phase': expected_phase, 'tolerance': 1e-5}])

        old = evaluate(.05)
        self.assertEqual(old['actualSolver']['status'], 'fail')
        self.assertAlmostEqual(old['actualSolver']['samples'][-1]['driverResidual'], .0007128639793478331)
        self.assertEqual(old['restore']['status'], 'pass')
        step = math.pi / 180
        good = evaluate(step)
        self.assertEqual(good['status'], 'pass')
        self.assertEqual(good['restore']['status'], 'pass')
        for result in (evaluate(step, disconnected=True), evaluate(step / 2, expected_ratio=2),
                       evaluate(step, expected_phase=.2)):
            self.assertEqual(result['status'], 'fail')
            self.assertEqual(result['actualSolver']['status'], 'fail')
            self.assertEqual(result['restore']['status'], 'pass')

    def test_disconnected_wrong_ratio_and_phase_have_same_math_track(self):
        good = self.run_port()
        for port in (FakePort(disconnected=True), FakePort(ratio=-1), FakePort(phase=.6)):
            with self.subTest(port=vars(port)):
                result = self.run_port(port)
                self.assertEqual(result['commandedMathTrack'], good['commandedMathTrack'])
                self.assertEqual(result['actualSolver']['status'], 'fail')
                self.assertFalse(result['passed'])
                self.assertEqual(result['restore']['status'], 'pass')

    def test_measured_multi_revolution_lift_not_expected_anchor(self):
        points = [i * .2 for i in range(51)]
        result = self.run_port(waypoints=points)
        self.assertTrue(result['passed'])
        self.assertAlmostEqual(result['actualSolver']['samples'][-1]['unwrappedPhase']['follower:0'], -19.7)

    def test_slide_follower(self):
        class SlidePort(FakePort):
            def read(self):
                row = super().read()
                row['joints']['follower:0'] = {'slide': self.follower}
                return row
        result = self.run_port(SlidePort(), followers=[{'joint': 'follower', 'coordinate': 'slide',
                                    'ratio': -2, 'phase': .3, 'tolerance': 1e-6}])
        self.assertTrue(result['passed'])

    def test_error_after_write_restores(self):
        port = FakePort()
        port.fail_at = 3
        result = self.run_port(port)
        self.assertEqual(result['outcome'], 'error')
        self.assertEqual(result['restore']['status'], 'pass')
        self.assertEqual(port.driver, 0)

    def test_cancel_and_budget_also_after_last_sample(self):
        for kind in ('cancel_at', 'budget_at'):
            for count in (0, 2, 4):
                port = FakePort()
                setattr(port, kind, count)
                result = self.run_port(port)
                self.assertFalse(result['passed'])
                self.assertEqual(result['outcome'], 'cancelled' if kind == 'cancel_at' else 'budget-exceeded')
                self.assertEqual(result['restore']['status'], 'pass')
                self.assertEqual(port.writes[-1], ('driver', 0))

    def test_restore_failure_readback_still_runs(self):
        port = FakePort()
        port.restore_failure = True
        result = self.run_port(port, waypoints=[.2, .4])
        self.assertEqual(result['restore']['status'], 'fail')
        self.assertIsNotNone(result['restore']['readback'])
        self.assertTrue(any('differs' in e for e in result['restore']['errors']))

    def test_transform_only_restore_failure(self):
        port = FakePort()
        port.transform_failure = True
        result = self.run_port(port)
        self.assertEqual(result['restore']['status'], 'fail')
        self.assertTrue(any('transforms' in e for e in result['restore']['errors']))

    def test_readback_unknown_not_setter_success(self):
        port = FakePort()
        port.read_failure = True
        result = self.run_port(port)
        self.assertEqual(result['restore']['status'], 'unknown')
        self.assertFalse(result['passed'])

    def test_document_change_refuses_cleanup_write(self):
        port = FakePort()
        port.guard_failure = True
        result = self.run_port(port)
        self.assertEqual(len(port.writes), 1)
        self.assertEqual(result['restore']['status'], 'unknown')

    def test_capture_failure_never_writes(self):
        port = FakePort()
        def fail():
            raise RuntimeError('capture failed')
        port.read = fail
        with self.assertRaises(RuntimeError):
            self.run_port(port)
        self.assertEqual(port.writes, [])

    def test_initial_step_preflight_never_writes(self):
        port = FakePort()
        with self.assertRaisesRegex(ValueError, 'initial'):
            self.run_port(port, waypoints=[2, 2.2])
        self.assertEqual(port.writes, [])

    def test_ambiguous_actual_phase_is_unknown(self):
        result = self.run_port(FakePort(ratio=12))
        self.assertEqual(result['outcome'], 'error')
        self.assertEqual(result['actualSolver']['status'], 'unknown')

    def test_invalid_plans(self):
        for changes in ({'schemaVersion': 2}, {'confirm': False}, {'waypoints': [0]}, {'waypoints': [0, 2]},
                        {'waypoints': [0, 0]}, {'waypoints': [0, float('nan')]},
                        {'budgetSeconds': 31}, {'followers': []}, {'unexpected': True},
                        {'driverTolerance': .01, 'waypoints': [0, .001]},
                        {'followers': [{'joint': 'follower', 'coordinate': 'rotation', 'ratio': -2,
                                        'phase': .3, 'tolerance': 100}]}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                plan(**changes)

    def test_pure_units_have_no_sdk_imports(self):
        import ast
        for unit in ('domain', 'application'):
            tree = ast.parse((ROOT / 'runtime/python/fmcad' / unit / 'native_drive.py').read_text())
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    self.assertEqual([a.name for a in node.names], ['math'])
                if isinstance(node, ast.ImportFrom):
                    self.assertEqual(node.module, 'typing')
                    self.assertTrue(all(alias.name in ('TYPE_CHECKING', 'Literal', 'TypedDict', 'Protocol', 'cast')
                                        for alias in node.names))

    def test_scratch_helper_is_inert_and_consent_gated(self):
        namespace = {}
        source = (ROOT / 'scripts/qualify_native_drive.py').read_text()
        exec(compile(source, 'qualify_native_drive.py', 'exec'), namespace)
        with self.assertRaisesRegex(ValueError, 'consent'):
            namespace['prepare_native_drive_scratch'](object())
        with self.assertRaisesRegex(ValueError, 'consent'):
            namespace['qualify_native_drive_case'](object(), 'd', 'f', 1, 0)


class FusionAdapterTest(unittest.TestCase):
    def setUp(self):
        self.port = FakePort()
        self.calls = []
        self.owner = object()
        self.occurrences = [SimpleNamespace(component=self.owner, isReferencedComponent=False) for _ in range(2)]
        for i, occurrence in enumerate(self.occurrences):
            occurrence.transform2 = SimpleNamespace(asArray=lambda i=i: [float(i)] * 16)
        limits = SimpleNamespace(isMinimumValueEnabled=False, isMaximumValueEnabled=False)
        self.joints = {}
        for key, value in (('driver', 0), ('follower', .3)):
            self.joints[key] = SimpleNamespace(isValid=True, isSuppressed=False, assemblyContext=None,
                jointMotion=SimpleNamespace(rotationValue=value, rotationLimits=limits),
                occurrenceOne=self.occurrences[0], occurrenceTwo=self.occurrences[1])
        doc = SimpleNamespace(creationId='scratch', name='FMCAD_NATIVE_DRIVE_scratch', isValid=True)
        self.ctx = SimpleNamespace(doc=doc, app=SimpleNamespace(activeDocument=doc,
            userInterface=SimpleNamespace(activeWorkspace=object(), activeCommand='SelectCommand')),
            design=SimpleNamespace(allComponents=[self.owner]),
            root=SimpleNamespace(allOccurrences=self.occurrences), resolve=self.joints.__getitem__,
            require_confirm=lambda data: None, ref=lambda value: 'ref:' + str(id(value)))
        def call(operation, data):
            self.calls.append((operation, data))
            value = float(data['rotation'].split()[0])
            self.joints['driver'].jointMotion.rotationValue = value
            # Deliberately disconnected follower; do not fake native coupling.
            return {'rotationValue': 999}  # Setter echo must not be evidence.
        self.ctx.call = call
        self.ns = dict(NS, _cad_type=lambda obj: 'Joint', _cad_owner=lambda obj: self.owner,
                       _cad_items=list, _assembly_capture_ready=lambda ctx: None)
        # Class methods resolve globals in their defining namespace.
        exec((ROOT / 'runtime/python/fmcad/adapters/fusion/native_drive.py').read_text(), self.ns)

    def test_adapter_reads_native_not_setter_echo_and_never_sets_follower(self):
        result = self.ns['mechanism_drive_test'](self.ctx, plan())
        self.assertFalse(result['passed'])
        self.assertEqual(result['restore']['status'], 'pass')
        self.assertEqual(result['actualSolver']['samples'][-1]['actual']['joints']['follower:0']['rotation'], .3)
        self.assertTrue(all(op == 'joint.drive' and row['joint'] == 'driver' for op, row in self.calls))
        self.assertEqual(len(result['capture']['transforms']), 2)

    def test_adapter_guards_before_any_write(self):
        for change in ('document', 'command', 'suppressed', 'proxy', 'limits', 'duplicate'):
            with self.subTest(change=change):
                self.setUp()
                if change == 'document':
                    self.ctx.app.activeDocument = object()
                elif change == 'command':
                    self.ctx.app.userInterface.activeCommand = 'UserEdit'
                elif change == 'suppressed':
                    self.joints['follower'].isSuppressed = True
                elif change == 'proxy':
                    self.joints['driver'].assemblyContext = object()
                elif change == 'limits':
                    limits = self.joints['driver'].jointMotion.rotationLimits
                    limits.isMaximumValueEnabled, limits.maximumValue = True, .1
                elif change == 'duplicate':
                    self.joints['follower'] = self.joints['driver']
                with self.assertRaises(ValueError):
                    self.ns['mechanism_drive_test'](self.ctx, plan())
                self.assertEqual(self.calls, [])

    def test_adapter_explicit_local_cancel_callback(self):
        port = self.ns['_NativeDriveFusionPort'](self.ctx, plan(), cancelled=lambda: True)
        result = self.ns['_native_drive_run'](plan(), port)
        self.assertEqual(result['outcome'], 'cancelled')
        self.assertEqual(len(self.calls), 1)  # cleanup only


if __name__ == '__main__':
    unittest.main()

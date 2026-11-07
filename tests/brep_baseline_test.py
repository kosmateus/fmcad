"""Offline only: no native kernel or durable SDK qualification."""
import importlib.util
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[1]


def load(relative):
    spec = importlib.util.spec_from_file_location('baseline_test_module', ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


domain = load('runtime/python/fmcad/domain/brep_baseline.py')
adapter = load('runtime/python/fmcad/adapters/fusion/brep_baseline.py')
POSE = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
TOL = {'volume': '0 cm^3', 'length': '0 cm', 'angle': '0 rad'}
SPECS = [{'role': 'housing', 'body': 'a'}, {'role': 'shaft', 'body': 'b'}]


class FakePort:
    def __init__(self):
        self.version = '1'
        self.missing = False
        self.instance = 'native:root'
        self.geometry = True
        self.pose = True
        self.failure = False
        self.difference = None
        self.allowed = 100
        self.calls = []

    def source(self):
        return {'document': 'scratch', 'version': self.version}

    def identity(self, ref):
        if self.missing:
            raise LookupError('missing')
        return {'body': ref, 'instance': self.instance}

    def snapshot(self, ref, frame):
        return SimpleNamespace(body=ref, transform=POSE)

    def budget(self):
        self.allowed -= 1
        if self.allowed < 0:
            raise TimeoutError('SDK work budget exhausted')

    def compare(self, snapshot, ref, frame, tolerances):
        self.calls.append(ref)
        if self.failure:
            raise RuntimeError('kernel Boolean failed')
        a_minus_b, b_minus_a = self.difference or ((0, 0) if self.geometry else (1, 1))
        volume_equal = a_minus_b == 0 and b_minus_a == 0
        return {'poseEqual': self.pose,
                'aMinusB': {'value': a_minus_b},
                'bMinusA': {'value': b_minus_a}, 'volumeEqual': volume_equal}


class BaselineTests(unittest.TestCase):
    def setUp(self):
        self.port = FakePort()
        self.service = domain.BrepBaselineService(self.port, 'session-one')
        self.ref = self.service.capture(SPECS, 'native')['baseline']

    def test_manybody_inspect_compare_and_immutable_manifest(self):
        result = self.service.compare(self.ref, list(reversed(SPECS)), TOL)
        self.assertEqual(result['status'], 'pass')
        self.assertEqual(self.port.calls, ['a', 'b'])
        view = self.service.inspect(self.ref)
        view['manifest']['bodies'][0]['pose'][0] = 999
        self.assertEqual(self.service.inspect(self.ref)['manifest']['bodies'][0]['pose'][0], 1)

    def test_session_is_not_durable(self):
        other = domain.BrepBaselineService(self.port, 'session-two')
        self.assertEqual(other.inspect(self.ref)['status'], 'missing')

    def test_pose_only_failure(self):
        self.port.pose = False
        result = self.service.compare(self.ref, SPECS, TOL)
        self.assertEqual(result['status'], 'fail')
        self.assertTrue(result['geometryEqual'])
        self.assertFalse(result['poseEqual'])

    def test_equal_volume_different_shape_is_not_equivalence(self):
        # Fake Boolean transcript represents equal-volume disjoint shape pieces.
        self.port.geometry = False
        result = self.service.compare(self.ref, SPECS, TOL)
        self.assertEqual(result['status'], 'fail')
        self.assertEqual(result['bodies'][0]['aMinusB']['value'], 1)
        self.assertEqual(result['bodies'][0]['bMinusA']['value'], 1)

    def test_each_boolean_direction_is_required_independently(self):
        self.port.difference = (0, 1)
        result = self.service.compare(self.ref, SPECS, TOL)
        self.assertEqual(result['status'], 'fail')
        self.assertEqual(result['bodies'][0]['aMinusB']['value'], 0)
        self.assertEqual(result['bodies'][0]['bMinusA']['value'], 1)

    def test_kernel_failure_unknown(self):
        self.port.failure = True
        result = self.service.compare(self.ref, SPECS, TOL)
        self.assertEqual(result['status'], 'unknown')
        self.assertFalse(result['passed'])

    def test_stale_version(self):
        self.port.version = '2'
        self.assertEqual(self.service.compare(self.ref, SPECS, TOL)['status'], 'stale')
        self.assertEqual(self.port.calls, [])

    def test_stale_instance(self):
        self.port.instance = 'occurrence:other'
        self.assertEqual(self.service.compare(self.ref, SPECS, TOL)['status'], 'stale')

    def test_missing_body(self):
        self.port.missing = True
        self.assertEqual(self.service.compare(self.ref, SPECS, TOL)['status'], 'missing')

    def test_role_coverage(self):
        self.assertEqual(self.service.compare(self.ref, SPECS[:1], TOL)['status'], 'missing')
        with self.assertRaises(ValueError):
            self.service.capture(SPECS + SPECS, 'native')

    def test_budget_is_not_retried(self):
        self.port.allowed = 0
        with self.assertRaises(TimeoutError):
            self.service.compare(self.ref, SPECS, TOL)
        self.assertEqual(self.port.calls, [])

    def test_explicit_tolerances(self):
        for tolerances in ({}, {'volume': 0, 'length': 0, 'angle': 0}):
            with self.assertRaises(ValueError):
                self.service.compare(self.ref, SPECS, tolerances)

    def test_adapter_routes_existing_comparator(self):
        calls = []
        ctx = SimpleNamespace(_expression=lambda expression, units, unitless=False: (expression, 0))
        port = adapter.FusionBrepBaselinePort(ctx, {
            '_measure_compare_bodies': lambda *args: calls.append(args) or 'result'
        }, self.port.source, self.port.identity, self.port.budget)
        self.assertEqual(port.compare('snapshot', 'ref', 'native', TOL), 'result')
        self.assertEqual(calls[0], (ctx, 'snapshot', 'ref', 'native', '0 cm^3', '0 cm', '0 rad'))
        ctx._expression = lambda *args: (None, float('nan'))
        with self.assertRaises(ValueError):
            port.compare('snapshot', 'ref', 'native', TOL)
        self.assertEqual(port.publish({}, [])['status'], 'unsupported')

    def test_exact_serializer_feature_detection_no_mesh_fallback(self):
        serializer = adapter.FusionExactBrepSerializer(SimpleNamespace())
        self.assertFalse(serializer.supported())
        with self.assertRaises(NotImplementedError):
            serializer.export([], 'owned.smt')
        obsolete_name = adapter.FusionExactBrepSerializer(SimpleNamespace(
            exportToFile=lambda *args: True,
            importFromFile=lambda *args: []))
        self.assertFalse(obsolete_name.supported())
        documented_api = adapter.FusionExactBrepSerializer(SimpleNamespace(
            exportToFile=lambda *args: True,
            createFromFile=lambda *args: []))
        self.assertTrue(documented_api.supported())

    def test_serializer_native_contract_fake_only(self):
        calls = []
        body = SimpleNamespace(isSolid=True, isValid=True)
        manager = SimpleNamespace(
            exportToFile=lambda bodies, path: calls.append((bodies, path)) or True,
            createFromFile=lambda path: [body])
        serializer = adapter.FusionExactBrepSerializer(manager)
        manifest = self.service.inspect(self.ref)['manifest']
        manifest['bodies'] = manifest['bodies'][:1]
        serializer.export([SimpleNamespace(body=body)], 'owned.smt')
        restored = serializer.restore(manifest, 'owned.smt', lambda *args: args)
        self.assertIs(restored[0][0], body)
        body.isValid = False
        with self.assertRaises(RuntimeError):
            serializer.restore(manifest, 'owned.smt', lambda *args: args)
        manager.exportToFile = lambda *args: False
        with self.assertRaises(RuntimeError):
            serializer.export([], 'owned.smt')

    def test_durable_bridge_single_body_files_and_fresh_service_fake_only(self):
        class Host:
            def __init__(self):
                self.files = {}
                self.paths = []
                self.record = None

            @contextmanager
            def stage(self):
                path = 'host-owned-%d.smt' % len(self.paths)
                self.paths.append(path)
                yield path

            def read_stage(self, path):
                return self.files[path]

            def write_stage(self, path, payload):
                self.files[path] = payload

            def read(self, reference):
                return self.record

        host = Host()
        exported = []

        def export(bodies, path):
            self.assertEqual(len(bodies), 1)
            exported.extend(bodies)
            host.files[path] = ('fake-exact:' + bodies[0]).encode()
            return True

        manager = SimpleNamespace(exportToFile=export, createFromFile=lambda path: [
            SimpleNamespace(isValid=True, isSolid=True, payload=host.files[path])])
        artifacts = adapter.FusionBrepBaselineArtifacts(
            adapter.FusionExactBrepSerializer(manager), host,
            lambda body, frame, pose: SimpleNamespace(body=body, transform=pose), self.port.budget)
        self.port.publish = artifacts.publish
        self.port.restore = artifacts.restore
        captured = self.service.capture(SPECS, 'native', 'durable')
        self.assertEqual(captured['status'], 'pass')
        self.assertEqual(captured['stagedPayloadCount'], 2)
        self.assertEqual(exported, ['a', 'b'])
        self.assertEqual([host.files[path] for path in host.paths], [b'fake-exact:a', b'fake-exact:b'])
        host.record = {'manifest': captured['manifest'],
                       'exactBodies': [host.files[path] for path in host.paths]}
        fresh = domain.BrepBaselineService(self.port, 'fresh-sdk-session')
        self.assertEqual(fresh.compare({'scope': 'durable', 'id': 'owned'}, SPECS, TOL)['status'], 'pass')

    def test_missing_exact_serializer_reports_unsupported(self):
        def unsupported(*args):
            raise NotImplementedError('no exact serializer')
        self.port.publish = unsupported
        result = self.service.capture(SPECS, 'native', 'durable')
        self.assertEqual(result['status'], 'unsupported')
        self.assertFalse(result['passed'])

    def test_native_driver_refuses_without_explicit_consent(self):
        native = load('tests/native/brep_baseline_fixture.py')
        fixture = SimpleNamespace(identity=lambda: {'file': 'scratch'}, is_owned_scratch=lambda: True)
        with self.assertRaises(PermissionError):
            native.capture_phase(self.service, fixture, expected={'file': 'scratch'})
        with self.assertRaises(PermissionError):
            native.capture_phase(self.service, fixture, consent=True, expected={'file': 'other'})


if __name__ == '__main__':
    unittest.main()

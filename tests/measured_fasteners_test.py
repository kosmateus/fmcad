"""Synthetic offline checks for measured fasteners; not native Fusion qualification."""
import copy
import json
import math
from pathlib import Path
import types
import unittest

import sequence_test


ROOT = Path(__file__).resolve().parents[1]
NAMESPACE = {}
for source in ('domain/measured_fasteners.py', 'application/measured_fasteners.py',
               'adapters/fusion/measured_fasteners.py'):
    path = ROOT / 'runtime/python/fmcad' / source
    exec(compile(path.read_text(), str(path), 'exec'), NAMESPACE)


with (ROOT / 'tests/fixtures/measured-fasteners/native-axial-fixture.json').open() as stream:
    AXIAL_FIXTURE = json.load(stream)
with (ROOT / 'tests/fixtures/measured-fasteners/native-document-spec.json').open() as stream:
    NATIVE_DOCUMENT_SPEC = json.load(stream)


def _reading(value, path, frame):
    if value is None:
        return {'status': 'missing', 'sourceVersion': 1, 'frame': frame,
                'reason': 'Synthetic fixture omitted this read.'}
    return {'status': 'measured', 'value': value, 'sourceVersion': 1,
            'provenance': {'source': 'synthetic fixture geometry', 'sourceRef': 'fixture:' + path,
                           'sourceVersion': 1, 'frame': frame,
                           'coverage': 'synthetic selected axial datum'}}


def _materialize(raw=None):
    raw = copy.deepcopy(raw or AXIAL_FIXTURE)
    frame = raw['frame']
    result = {'schemaVersion': 1, 'sourceVersion': 1, 'frame': frame,
              'tolerance': raw['tolerance'], 'screw': {}, 'receptacle': {}, 'layers': []}
    for component in ('screw', 'receptacle'):
        source = raw[component]
        target = result[component]
        for key, value in source.items():
            if key == 'kind':
                target[key] = value
            elif key == 'axis':
                target[key] = {'origin': _reading(value['origin'], component + '.axis.origin', frame),
                               'direction': _reading(value['direction'], component + '.axis.direction', frame)}
            else:
                target[key] = _reading(value, component + '.' + key, frame)
    for index, layer in enumerate(raw['layers']):
        result['layers'].append({'id': layer['id'],
                                 'start': _reading(layer['start'], 'layers.%d.start' % index, frame),
                                 'end': _reading(layer['end'], 'layers.%d.end' % index, frame)})
    return result


class FixturePorts:
    def __init__(self, native):
        self.native = native
        self.tool_requests = []

    def measure_native(self, request):
        return self.native

    def declared_fastener(self, operation, request):
        return {'schemaVersion': 1, 'status': 'pass', 'operation': operation,
                'frame': {'space': 'component', 'component': {'kind': 'component', 'name': 'root'}},
                'units': {'length': 'mm', 'angle': 'rad'}, 'engagement': {'value': 5, 'units': 'mm'}}

    def tool_access(self, request):
        self.tool_requests.append(request)
        return {'complete': True, 'result': {'reachable': False, 'blockers': ['native:wall']},
                'nativeObstacleEvidence': [{'name': 'wall', 'status': 'measured'}],
                'declaredObstacleEvidence': []}


def _call(native, extra=None, ports=None):
    request = {'schemaVersion': 1, 'mode': 'native', 'native': {'fixture': 'native-axial-fixture'}}
    request.update(extra or {})
    ports = ports or FixturePorts(native)
    return NAMESPACE['measured_fasteners_check'](request, ports), ports


def _rotate_fixture(raw, rotation, translation):
    """Rotate/translate all positions and direction vectors like an occurrence proxy."""
    result = copy.deepcopy(raw)

    def transform(vector, point):
        rotated = [sum(rotation[i][j] * vector[j] for j in range(3)) for i in range(3)]
        if point:
            rotated = [rotated[i] + translation[i] for i in range(3)]
        return rotated

    for component in ('screw', 'receptacle'):
        axis = result[component]['axis']
        axis['origin'] = transform(axis['origin'], True)
        axis['direction'] = transform(axis['direction'], False)
        for key, value in list(result[component].items()):
            if key not in ('kind', 'axis'):
                result[component][key] = transform(value, True)
    for layer in result['layers']:
        layer['start'] = transform(layer['start'], True)
        layer['end'] = transform(layer['end'], True)
    return result


def _fixture_request(native):
    return {'schemaVersion': 1, 'mode': 'native', 'native': native}


class MeasuredFastenerDomainTests(unittest.TestCase):
    def test_native_qualification_fixture_is_prepared_but_not_executed(self):
        self.assertIn('specification-only', NATIVE_DOCUMENT_SPEC['execution'])
        self.assertEqual(set(NATIVE_DOCUMENT_SPEC['cases']),
                         {'baseline', 'rotatedOccurrence', 'blindHoleBottoming',
                          'shortBoltDeepReceptacle', 'misalignedAxes', 'toolObstacle', 'missingNativeRead'})
        self.assertGreaterEqual(len(NATIVE_DOCUMENT_SPEC['restoreRequirements']), 3)

    def test_baseline_has_actual_overlap_and_provenance(self):
        result, _ = _call(_materialize())
        measured = result['nativeMeasurements']
        self.assertEqual(result['status'], 'pass')
        self.assertAlmostEqual(measured['measurements']['actualEngagement']['value'], 5.0)
        self.assertAlmostEqual(measured['measurements']['protrusion']['value'], 5.0)
        self.assertAlmostEqual(measured['measurements']['bottoming']['clearance']['value'], 3.0)
        for metric in measured['measurements'].values():
            if isinstance(metric, dict) and metric.get('status') == 'measured' and 'value' in metric:
                self.assertTrue(metric['provenance'])
                self.assertTrue(all(row['sourceRef'] and row['sourceVersion'] == 1 for row in metric['provenance']))
        self.assertEqual(measured['measurements']['screwThreadInterval']['status'], 'measured')
        self.assertEqual(measured['measurements']['layerAxialIntervals'][0]['status'], 'measured')

    def test_rotated_instance_is_measured_in_its_assembly_frame(self):
        rotation = ((0, 0, 1), (0, 1, 0), (-1, 0, 0))
        raw = _rotate_fixture(AXIAL_FIXTURE, rotation, [27.0, -4.0, 9.0])
        native = _materialize(raw)
        result, _ = _call(native)
        measured = result['nativeMeasurements']
        self.assertEqual(measured['frame']['space'], 'assembly')
        self.assertAlmostEqual(measured['measurements']['actualEngagement']['value'], 5.0)
        self.assertAlmostEqual(measured['measurements']['axisOffset']['value'], 0.0)
        self.assertEqual(measured['measurements']['actualEngagement']['provenance'][0]['frame'], native['frame'])

    def test_blind_hole_bottoming_fails_while_declared_stack_stays_separate(self):
        raw = copy.deepcopy(AXIAL_FIXTURE)
        raw['receptacle']['bottom'] = [0, 0, 8]
        native = _materialize(raw)
        request = {'declaredEvidence': {'operation': 'fastener.check', 'schemaVersion': 1,
                                        'frame': 'component',
                                        'screw': {'length': '12 mm', 'threadLength': '10 mm'},
                                        'stack': [{'thickness': '5 mm'}],
                                        'minimumEngagement': '4 mm',
                                        'receptacle': {'kind': 'insert', 'depth': '8 mm'}}}
        result, _ = _call(native, request)
        self.assertEqual(result['status'], 'fail')
        self.assertEqual(result['declaredEvidence']['status'], 'reported')
        self.assertEqual(result['declaredEvidence']['result']['status'], 'pass')
        self.assertEqual(result['declaredEvidence']['result']['frame']['space'], 'component')
        self.assertEqual(result['declaredEvidence']['result']['units']['length'], 'mm')
        self.assertEqual(result['nativeMeasurements']['frame']['space'], 'assembly')
        self.assertTrue(result['nativeMeasurements']['measurements']['bottoming']['bottomed'])

    def test_short_deep_bolt_fails_real_engagement_despite_declared_pass(self):
        raw = copy.deepcopy(AXIAL_FIXTURE)
        raw['screw']['tip'] = [0, 0, 8]
        raw['screw']['threadEnd'] = [0, 0, 8]
        native = _materialize(raw)
        request = {'declaredEvidence': {'operation': 'fastener.check', 'schemaVersion': 1,
                                        'frame': 'component',
                                        'screw': {'length': '12 mm', 'threadLength': '10 mm'},
                                        'stack': [{'thickness': '5 mm'}],
                                        'minimumEngagement': '4 mm'}}
        result, _ = _call(native, request)
        self.assertEqual(result['declaredEvidence']['result']['status'], 'pass')
        self.assertEqual(result['nativeMeasurements']['measurements']['actualEngagement']['value'], 3.0)
        self.assertEqual(result['status'], 'fail')

    def test_axis_misalignment_exceeds_the_declared_tolerance(self):
        raw = copy.deepcopy(AXIAL_FIXTURE)
        raw['receptacle']['axis']['origin'] = [0.2, 0, 0]
        result, _ = _call(_materialize(raw))
        alignment = next(row for row in result['checks'] if row['check'] == 'alignment')
        self.assertEqual(alignment['status'], 'fail')
        self.assertAlmostEqual(alignment['axisOffset']['value'], 0.2)
        self.assertEqual(result['status'], 'fail')

    def test_missing_native_thread_read_is_unknown_not_declared_fallback(self):
        native = _materialize()
        native['receptacle']['threadEnd'] = {'status': 'missing', 'sourceVersion': 1,
                                              'frame': native['frame'], 'reason': 'fixture omitted read'}
        request = {'declaredEvidence': {'operation': 'fastener.check', 'schemaVersion': 1,
                                        'frame': 'component',
                                        'screw': {'length': '12 mm', 'threadLength': '10 mm'},
                                        'stack': [{'thickness': '5 mm'}]}}
        result, _ = _call(native, request)
        self.assertEqual(result['nativeMeasurements']['measurements']['actualEngagement']['status'], 'notEvaluated')
        self.assertIn('receptacle.threadEnd', result['nativeMeasurements']['coverage']['missingMeasurements'])
        self.assertEqual(result['declaredEvidence']['result']['status'], 'pass')
        self.assertEqual(result['status'], 'unknown')

    def test_tool_obstacle_is_delegated_and_reported_as_native_evidence(self):
        native = _materialize()
        request = {'toolAccess': {'nativeObstacles': [{'name': 'wall', 'body': 'body-ref'}]}}
        result, ports = _call(native, request)
        self.assertEqual(result['status'], 'fail')
        self.assertEqual(result['toolAccess']['status'], 'fail')
        self.assertEqual(ports.tool_requests, [request['toolAccess']])
        self.assertEqual(result['toolAccess']['nativeObstacleEvidence'][0]['status'], 'measured')

    def test_unsupported_schema_and_unqualified_tolerance_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'schemaVersion:1'):
            _call({'schemaVersion': 2})
        native = _materialize()
        del native['tolerance']['axisOffsetMm']
        with self.assertRaisesRegex(ValueError, 'axisOffsetMm'):
            NAMESPACE['_measured_fasteners_evaluate'](native)


class FakePoint:
    def __init__(self, xyz):
        self.x, self.y, self.z = xyz


class FakeGeometry:
    def __init__(self, origin, direction=None):
        if direction is None:
            self.x, self.y, self.z = origin
        else:
            self.origin = FakePoint(origin)
            self.direction = FakePoint(direction)


class FakeEntity:
    def __init__(self, kind, name, geometry=None, bounds=None):
        self.kind, self.name, self.geometry = kind, name, geometry
        self.boundingBox = bounds


class FakeContext:
    def __init__(self, entities):
        self.entities = entities
        self.frame = {'space': 'assembly', 'component': {'kind': 'component', 'name': 'root'}}
        self.doc = types.SimpleNamespace(name='SyntheticFastener', creationId='synthetic-document')

    def resolve(self, reference):
        return self.entities[reference]

    def ref(self, entity):
        return {'kind': entity.kind, 'name': entity.name}

    def length(self, expression):
        value, unit = expression.split()
        return float(value) / (10.0 if unit == 'mm' else 1.0)

    def point(self, coordinates):
        return [self.length(value) for value in coordinates]

    def angle(self, expression):
        value, unit = expression.split()
        return math.radians(float(value)) if unit == 'deg' else float(value)


def _axis(name, origin=(0, 0, 0), direction=(0, 0, 1)):
    return FakeEntity('axis', name, FakeGeometry(origin, direction))


def _point(name, z, x=0.0, y=0.0):
    return FakeEntity('point', name, FakeGeometry((x, y, z)))


def _native_refs():
    return {'schemaVersion': 1,
            'frame': {'space': 'assembly', 'component': {'kind': 'component', 'name': 'root'}},
            'tolerance': {'axisOffset': '0.05 mm', 'axisAngle': '1 deg', 'minimumEngagement': '4 mm'},
            'screw': {'axis': 'screw-axis', 'headBearing': 'head', 'tip': 'tip',
                      'threadStart': 'screw-thread-start', 'threadEnd': 'screw-thread-end'},
            'receptacle': {'kind': 'blind', 'axis': 'hole-axis',
                           'threadStart': 'hole-thread-start', 'threadEnd': 'hole-thread-end', 'bottom': 'bottom'},
            'layers': [{'id': 'bracket', 'start': 'layer-start', 'end': 'layer-end'}]}


def _fake_adapter_environment(entities, access_result=None):
    ctx = FakeContext(entities)
    calls = []
    NAMESPACE['_cad_kind'] = lambda entity: entity.kind
    NAMESPACE['_measure_geometry'] = lambda entity: entity.geometry
    NAMESPACE['_measure_space'] = lambda unused_ctx, unused_entities: ctx.frame
    NAMESPACE['_measure_frame'] = lambda unused_ctx, unused_entity, requested: ctx.frame if requested == ctx.frame else (_ for _ in ()).throw(ValueError('frame mismatch'))
    NAMESPACE['_measure_temporary_body'] = lambda unused_ctx, ref, unused_frame: types.SimpleNamespace(body=ctx.resolve(ref))

    def tool_access(unused_ctx, data):
        calls.append(data)
        return {'status': 'pass' if access_result is not False else 'fail',
                'reachable': access_result is not False,
                'blockers': [] if access_result is not False else ['native:wall']}

    NAMESPACE['tool_access'] = tool_access
    NAMESPACE['_fastener_stack'] = lambda unused_ctx, unused_data: {'status': 'pass'}
    NAMESPACE['_fastener_check'] = lambda unused_ctx, unused_data: {'status': 'pass'}
    return ctx, calls


class MeasuredFastenerAdapterTests(unittest.TestCase):
    def setUp(self):
        entities = {'screw-axis': _axis('screw-axis'), 'hole-axis': _axis('hole-axis'),
                    'head': _point('head', 0), 'tip': _point('tip', 1),
                    'screw-thread-start': _point('screw-thread-start', 0.4),
                    'screw-thread-end': _point('screw-thread-end', 1),
                    'hole-thread-start': _point('hole-thread-start', 0.5),
                    'hole-thread-end': _point('hole-thread-end', 1.3), 'bottom': _point('bottom', 1.3),
                    'layer-start': _point('layer-start', 0), 'layer-end': _point('layer-end', 0.5),
                    'entry': _point('entry', 2), 'body': FakeEntity('body', 'wall', bounds=types.SimpleNamespace(
                        minPoint=FakePoint((-0.1, -0.1, 0.7)), maxPoint=FakePoint((0.1, 0.1, 0.9))))}
        entry_axis = FakeEntity('axis', 'entry-axis', FakeGeometry((0, 0, 0), (0, 0, -1)))
        entities['entry-axis'] = entry_axis
        self.ctx, self.access_calls = _fake_adapter_environment(entities, access_result=False)

    def test_fusion_reader_attaches_frame_and_source_version_to_each_native_read(self):
        request = {'schemaVersion': 1, 'mode': 'native', 'native': _native_refs()}
        result = NAMESPACE['measured_fasteners_check_operation'](self.ctx, request)
        self.assertEqual(result['status'], 'pass')
        reading = result['nativeMeasurements']['measurements']['actualEngagement']['provenance'][0]
        self.assertEqual(reading['sourceVersion'], 1)
        self.assertEqual(reading['frame'], self.ctx.frame)
        self.assertEqual(reading['sourceRef']['kind'], 'point')
        self.assertEqual(reading['documentIdentity']['creationId'], 'synthetic-document')

    def test_fixed_fixture_consumes_real_metric_leaf_provenance_not_nested_measurement_records(self):
        import runpy
        fixture = runpy.run_path(str(ROOT / 'assets/native-qualification/measured-fasteners.py'))
        validate = fixture['_fastener_provenance']
        result = NAMESPACE['measured_fasteners_check_operation'](self.ctx, {'schemaVersion': 1, 'mode': 'native', 'native': _native_refs()})
        native = result['nativeMeasurements']
        metric = native['measurements']['actualEngagement']
        self.assertNotIn('provenance', metric['provenance'][0])
        self.assertTrue(validate(metric, native['frame'], 'synthetic-document'))
        self.assertFalse(validate(metric, native['frame'], 'foreign-document'))
        missing = copy.deepcopy(metric)
        del missing['provenance'][0]['sourceRef']
        self.assertFalse(validate(missing, native['frame'], 'synthetic-document'))
        nested = copy.deepcopy(metric)
        nested['provenance'] = [{'provenance': value} for value in nested['provenance']]
        self.assertFalse(validate(nested, native['frame'], 'synthetic-document'))

    def test_complete_fixed_program_report_uses_real_evaluator_for_all_five_native_cases(self):
        import runpy
        from unittest.mock import patch
        namespace = runpy.run_path(str(ROOT / 'assets/native-qualification/measured-fasteners.py'))
        entities = {}
        ctx, _ = _fake_adapter_environment(entities)
        ctx.resolve = lambda reference: entities[reference['name'] if isinstance(reference, dict) else reference]

        class Facade:
            def __init__(self):
                self.doc = ctx.doc
                self.root = types.SimpleNamespace(bRepBodies=types.SimpleNamespace(count=0),
                    sketches=types.SimpleNamespace(count=0), allOccurrences=types.SimpleNamespace(count=0))
                self.design = types.SimpleNamespace(timeline=types.SimpleNamespace(count=0))
                self.report = None
                self.measurement_calls = 0

            def call(self, operation, data):
                if operation == 'document.status':
                    return {'name': ctx.doc.name, 'creationId': ctx.doc.creationId, 'saved': False,
                            'modified': bool(entities), 'fileId': None}
                if operation == 'datum.point':
                    values = [ctx.length(value) for value in data['point']]
                    entity = FakeEntity('point', data['name'], FakeGeometry(values))
                elif operation == 'datum.axis':
                    first = ctx.resolve(data['point1']).geometry
                    second = ctx.resolve(data['point2']).geometry
                    origin = [first.x, first.y, first.z]
                    delta = [second.x-first.x, second.y-first.y, second.z-first.z]
                    norm = math.sqrt(sum(value*value for value in delta))
                    entity = _axis(data['name'], origin, [value/norm for value in delta])
                else:
                    self.assert_operation(operation)
                    self.measurement_calls += 1
                    return NAMESPACE['measured_fasteners_check_operation'](ctx, data)
                entities[data['name']] = entity
                self.design.timeline.count += 1
                return ctx.ref(entity)

            def assert_operation(self, operation):
                if operation != 'fastener.measured-check':
                    raise AssertionError('Unexpected operation ' + operation)

            def emit(self, report):
                if self.report is not None:
                    raise AssertionError('Only one report is permitted')
                self.report = report

        facade = Facade()
        adsk = types.ModuleType('adsk')
        core = types.ModuleType('adsk.core')
        adsk.core = core
        core.Application = types.SimpleNamespace(get=lambda: types.SimpleNamespace(version='fake-build'))
        namespace['run'].__globals__.update(FMCAD=facade, ARGS={'approved': True, 'creationId': ctx.doc.creationId,
            'expectedFusionVersion': 'fake-build', 'fixturePrefix': 'NQREGRESSION'})
        with patch.dict('sys.modules', {'adsk': adsk, 'adsk.core': core}):
            report = namespace['run']('')
        self.assertIs(report, facade.report)
        self.assertEqual(facade.measurement_calls, 5)
        self.assertEqual(report['nativeCasesStatus'], 'pass')
        self.assertEqual(len(report['cases']), 8)
        self.assertTrue(all(case['status'] == 'pass' for case in report['cases'].values()))
        self.assertEqual(report['cases']['baseline-native-engagement']['result']['nativeMeasurements']['measurements']['actualEngagement']['value'], 5)
        self.assertEqual(report['timelineCountBefore'], report['timelineCountAfter'])

    def test_fusion_reader_projects_a_rotated_occurrence_in_its_assembly_frame(self):
        def world(point):
            return ((point[2] + 27) / 10.0, (point[1] - 4) / 10.0, (-point[0] + 9) / 10.0)

        entities = {
            'screw-axis': _axis('screw-axis', world([0, 0, 0]), (1, 0, 0)),
            'hole-axis': _axis('hole-axis', world([0, 0, 0]), (1, 0, 0)),
            'head': FakeEntity('point', 'head', FakeGeometry(world([0, 0, 0]))),
            'tip': FakeEntity('point', 'tip', FakeGeometry(world([0, 0, 10]))),
            'screw-thread-start': FakeEntity('point', 'screw-thread-start', FakeGeometry(world([0, 0, 4]))),
            'screw-thread-end': FakeEntity('point', 'screw-thread-end', FakeGeometry(world([0, 0, 10]))),
            'hole-thread-start': FakeEntity('point', 'hole-thread-start', FakeGeometry(world([0, 0, 5]))),
            'hole-thread-end': FakeEntity('point', 'hole-thread-end', FakeGeometry(world([0, 0, 13]))),
            'bottom': FakeEntity('point', 'bottom', FakeGeometry(world([0, 0, 13]))),
            'layer-start': FakeEntity('point', 'layer-start', FakeGeometry(world([0, 0, 0]))),
            'layer-end': FakeEntity('point', 'layer-end', FakeGeometry(world([0, 0, 5]))),
        }
        ctx, _ = _fake_adapter_environment(entities)
        result = NAMESPACE['measured_fasteners_check_operation'](
            ctx, {'schemaVersion': 1, 'mode': 'native', 'native': _native_refs()})
        measurements = result['nativeMeasurements']['measurements']
        self.assertEqual(result['status'], 'pass')
        self.assertEqual(result['frame'], ctx.frame)
        self.assertAlmostEqual(measurements['actualEngagement']['value'], 5.0)
        self.assertAlmostEqual(measurements['protrusion']['value'], 5.0)
        self.assertAlmostEqual(measurements['axisOffset']['value'], 0.0)
        self.assertAlmostEqual(measurements['axisAngle']['value'], 0.0)

    def test_native_and_declared_tool_obstacles_pass_through_existing_tool_access(self):
        refs = _native_refs()
        tool_request = {'tool': {'diameter': '4 mm', 'length': '30 mm'},
                        'target': {'origin': 'head', 'axis': 'screw-axis', 'engagementDepth': '0 mm'},
                        'entry': {'origin': 'entry', 'direction': 'entry-axis'},
                        'nativeObstacles': [{'name': 'wall', 'body': 'body'}],
                        'declaredObstacles': [{'name': 'fixture', 'point': ['0 mm', '0 mm', '15 mm'], 'radius': '1 mm'}],
                        'minimumClearance': '0 mm', 'samples': 10}
        request = {'schemaVersion': 1, 'mode': 'native', 'native': refs, 'toolAccess': tool_request}
        sequence_tool_access = sequence_test.HANDLERS['tool.access']

        def measured_tool_access(ctx, data):
            self.access_calls.append(copy.deepcopy(data))
            return sequence_tool_access(ctx, data)

        NAMESPACE['tool_access'] = measured_tool_access
        result = NAMESPACE['measured_fasteners_check_operation'](self.ctx, request)
        self.assertEqual(result['toolAccess']['status'], 'fail')
        access_request = self.access_calls[0]
        self.assertEqual([row['name'] for row in access_request['obstacles']], ['native:wall', 'declared:fixture'])
        self.assertEqual(access_request['obstacles'][0]['box']['min'], ['-1 mm', '-1 mm', '7 mm'])
        self.assertEqual(len(result['toolAccess']['nativeObstacleEvidence']), 1)
        self.assertEqual(len(result['toolAccess']['declaredObstacleEvidence']), 1)
        self.assertIn('axis-aligned bounds', result['toolAccess']['coverage'])

    def test_declared_obstacles_without_native_obstacle_coverage_cannot_pass(self):
        refs = _native_refs()
        sequence_tool_access = sequence_test.HANDLERS['tool.access']

        def measured_tool_access(ctx, data):
            self.access_calls.append(copy.deepcopy(data))
            return sequence_tool_access(ctx, data)

        NAMESPACE['tool_access'] = measured_tool_access
        tool_request = {'tool': {'diameter': '4 mm', 'length': '30 mm'},
                        'target': {'origin': 'head', 'axis': 'screw-axis'},
                        'entry': {'origin': 'entry', 'direction': 'entry-axis'},
                        'declaredObstacles': [{'name': 'fixture', 'point': ['0 mm', '0 mm', '50 mm'], 'radius': '1 mm'}]}
        result = NAMESPACE['measured_fasteners_check_operation'](
            self.ctx, {'schemaVersion': 1, 'mode': 'native', 'native': refs, 'toolAccess': tool_request})
        self.assertEqual(result['toolAccess']['result']['reachable'], True)
        self.assertEqual(result['toolAccess']['status'], 'unknown')
        self.assertFalse(result['toolAccess']['nativeObstacleEvidence'])
        self.assertEqual(result['toolAccess']['declaredObstacleEvidence'][0]['status'], 'declared')
        self.assertIn('no exhaustive scene obstacle enumeration', result['toolAccess']['coverage'])

    def test_unavailable_native_tool_entry_is_not_treated_as_accessible(self):
        refs = _native_refs()
        tool_request = {'tool': {'diameter': '4 mm', 'length': '30 mm'},
                        'target': {'origin': 'head', 'axis': 'screw-axis'},
                        'entry': {'origin': 'missing-entry', 'direction': 'entry-axis'}}
        result = NAMESPACE['measured_fasteners_check_operation'](
            self.ctx, {'schemaVersion': 1, 'mode': 'native', 'native': refs, 'toolAccess': tool_request})
        self.assertEqual(result['toolAccess']['status'], 'unknown')
        self.assertFalse(self.access_calls)

    def test_no_resolved_geometry_reports_unverified_frame_and_unknown_measurements(self):
        refs = _native_refs()
        refs['screw'] = dict(refs['screw'], axis='missing-screw-axis', headBearing='missing-head',
                             tip='missing-tip', threadStart='missing-start', threadEnd='missing-end')
        refs['receptacle'] = dict(refs['receptacle'], axis='missing-hole-axis',
                                  threadStart='missing-hole-start', threadEnd='missing-hole-end',
                                  bottom='missing-bottom')
        refs['layers'] = [{'id': 'bracket', 'start': 'missing-layer-start', 'end': 'missing-layer-end'}]
        result = NAMESPACE['measured_fasteners_check_operation'](
            self.ctx, {'schemaVersion': 1, 'mode': 'native', 'native': refs})
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(result['nativeMeasurements']['coverage']['frameStatus'], 'unverified')
        self.assertEqual(result['nativeMeasurements']['measurements']['actualEngagement']['status'], 'notEvaluated')


if __name__ == '__main__':
    unittest.main()

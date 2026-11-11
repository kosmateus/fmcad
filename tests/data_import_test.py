"""Offline adapter integration and state-failure tests. No Fusion kernel proof."""
import copy
import json
import math
from pathlib import Path
import subprocess
import types
import unittest
from unittest.mock import patch

from assembly_test import namespace
from core_test import Attributes, Items, Parameters, Units, Point

ROOT = Path(__file__).resolve().parents[1]
NS = types.SimpleNamespace


def plan(operation, records=None, **kwargs):
    data = dict(version=1, owner='fixture', revision='r1', **({'records': records} if records is not None else {}))
    data.update(kwargs)
    program = "const d=require('./src/data-import'); console.log(JSON.stringify(d.prepare(process.argv[1],JSON.parse(process.argv[2]))))"
    result = subprocess.run(['node', '-e', program, operation, json.dumps(data)], cwd=ROOT, capture_output=True, text=True)
    if result.returncode:
        raise AssertionError(result.stderr)
    return json.loads(result.stdout)


def pose(x='0 mm', frame='parent', rotation=None):
    return dict(frame=frame, translation=[x, '0 mm', '0 mm'], rotation=rotation or [1, 0, 0, 0, 1, 0, 0, 0, 1])


def item(name, **kwargs):
    value = dict(id=name, name=name, kind='part', parent=None, quantity=1, placement=pose(), status='CONFIRMED', source='Fixture')
    value.update(kwargs)
    return value


class Matrix:
    def __init__(self, values=None):
        self.values = values or [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.]

    @staticmethod
    def create():
        return Matrix()

    def setWithArray(self, values):
        self.values = list(values)
        return True

    def asArray(self):
        return self.values


class Component:
    serial = 0

    def __init__(self, ctx, name):
        Component.serial += 1
        self.entityToken = 'component-' + str(Component.serial)
        self.name, self.ctx = name, ctx
        self.objectType = 'adsk::fusion::Component'
        self.attributes = Attributes()
        self.occurrences = Occurrences(ctx, self)
        for key in ('joints', 'asBuiltJoints', 'rigidGroups', 'bRepBodies', 'sketches', 'features'):
            setattr(self, key, Items())

    @property
    def allOccurrences(self):
        rows = []
        def visit(component, parent=None):
            for native in component.occurrences.items:
                occurrence = native.createForAssemblyContext(parent) if parent else native
                rows.append(occurrence)
                visit(native.component, occurrence)
        visit(self)
        return Items(rows)


class Occurrence:
    serial = 0

    def __init__(self, ctx, component, parent_component, matrix, native=None, parent=None):
        Occurrence.serial += 1
        self.ctx, self.component, self._parentComponent = ctx, component, parent_component
        self._token = native._token if native else 'occurrence-' + str(Occurrence.serial)
        self.nativeObject, self.assemblyContext = native, parent
        self._transform = matrix
        self.attributes = native.attributes if native else Attributes()
        self.isReferencedComponent = self._grounded = self.isGroundToParent = False
        self.objectType = 'adsk::fusion::Occurrence'

    @property
    def isGrounded(self):
        if self._parentComponent != self.ctx.root and self.assemblyContext is None:
            raise RuntimeError('isGrounded requires a root-qualified proxy for subcomponents')
        return self._grounded

    @isGrounded.setter
    def isGrounded(self, value):
        self._grounded = value

    @property
    def entityToken(self):
        if self._parentComponent != self.ctx.root and self.assemblyContext is None:
            raise RuntimeError('Tokens require a root-qualified occurrence proxy')
        return self._token

    @property
    def name(self):
        return self.component.name + ':' + self._token.split('-')[-1]

    @property
    def fullPathName(self):
        return (self.assemblyContext.fullPathName + '+' if self.assemblyContext else '') + self.name

    @property
    def transform2(self):
        return self.nativeObject.transform2 if self.nativeObject else self._transform

    @transform2.setter
    def transform2(self, value):
        if self.ctx.fail_transform:
            raise RuntimeError('injected transform setter')
        self.ctx.writes.append('transform')
        self._transform = value

    def createForAssemblyContext(self, parent):
        return Occurrence(self.ctx, self.component, self._parentComponent, self._transform, native=self, parent=parent)

    def deleteMe(self):
        self.ctx.writes.append('delete')
        self._parentComponent.occurrences.items.remove(self)
        return True


class Occurrences(Items):
    def __init__(self, ctx, component):
        super().__init__()
        self.ctx, self.component = ctx, component

    def addExistingComponent(self, component, matrix):
        if self.ctx.fail_add:
            raise RuntimeError('injected add failure')
        self.ctx.writes.append('add')
        occurrence = Occurrence(self.ctx, component, self.component, matrix)
        self.items.append(occurrence)
        return occurrence

    def addNewComponent(self, matrix):
        component = Component(self.ctx, 'new')
        self.ctx.design.allComponents.items.append(component)
        return self.addExistingComponent(component, matrix)


class Context:
    def __init__(self):
        self.ns = namespace()
        for name in ('io', 'data_import'):
            exec(compile((ROOT / f'assets/cad/{name}.py').read_text(), name, 'exec'), self.ns)
        self.ns['adsk'].core.Matrix3D = Matrix
        self.ns['adsk'].core.ValueInput = NS(createByString=lambda v: v)
        self.created, self.writes, self.identity_checks = [], [], 0
        self.fail_add = self.fail_transform = self.fail_import = False
        self.root = self.component = Component(self, 'root')
        self.occurrence = None
        units = Units()
        parameters = Parameters(units)
        units.parameters = parameters
        self.design = NS(allComponents=Items([self.root]), designType=0, allParameters=parameters, userParameters=parameters, unitsManager=units, materials=Items())
        self.doc = NS(creationId='creation-fixture', name='fixture', dataFile=NS(id='cloud-fixture'))
        self.app = NS(importManager=NS(createSTEPImportOptions=lambda p: NS(path=p)), materialLibraries=Items())

    def assert_identity(self):
        self.identity_checks += 1

    def ref(self, entity):
        value = dict(token=entity.entityToken, kind=entity.objectType.split('::')[-1].lower(), name=entity.name)
        if isinstance(entity, Occurrence):
            value['path'] = entity.fullPathName
        return value

    def resolve(self, ref, kind=None):
        rows = self.root.allOccurrences.items + self.design.allComponents.items
        if isinstance(ref, str):
            matches = [e for e in rows if e.name == ref or getattr(e, 'fullPathName', None) == ref]
        else:
            matches = [e for e in rows if e.entityToken == ref['token'] and (not ref.get('path') or getattr(e, 'fullPathName', None) == ref['path'])]
        return self.ns['_cad_unique'](matches, 'fixture reference')

    def _expression(self, expression, unit, unitless=False):
        if not self.design.unitsManager.isValidExpression(expression, unit):
            raise ValueError('Invalid expression')
        return expression, self.design.unitsManager.evaluateExpression(expression, unit)

    def call(self, operation, data):
        if operation == 'import.file':
            if self.fail_import:
                raise RuntimeError('injected import failure')
            self.writes.append('import')
            self.component.bRepBodies.items.append(NS(entityToken='body-' + self.component.entityToken, name='imported', volume=1., faces=Items(), edges=Items(),
                                                     boundingBox=NS(minPoint=Point(0, 0, 0), maxPoint=Point(1, 1, 1))))
            return {}
        return self.ns['CAD_HANDLERS'][operation](self, data)


class DataImportTests(unittest.TestCase):
    def setUp(self):
        self.ctx = Context()

    def invoke(self, p):
        result = self.ctx.call(p['operation'], p)
        self.assertNotIn('error', result, result)
        return result

    def test_catalog_shared_nested_occurrences_and_persistent_ledger(self):
        p = plan('catalog.import', [item('assembly', quantity=2, kind='assembly', placement=pose('10 mm')), item('child', parent='assembly', quantity=3, placement=pose('2 mm'))])
        r = self.invoke(p)
        self.assertEqual(len(r['instances']), 8)
        self.assertEqual(len(r['idMap']['child']['occurrences']), 6)
        self.assertEqual(self.ctx.design.allComponents.count, 3)
        child = self.ctx.resolve(r['idMap']['child']['definition'])
        assembly = self.ctx.resolve(r['idMap']['assembly']['definition'])
        self.assertEqual(assembly.occurrences.count, 3)  # Not six duplicated native children.
        child_world = self.ctx.ns['_di_world'](self.ctx.resolve(r['idMap']['child']['occurrences'][-1]))
        self.assertAlmostEqual(child_world[3], 1.2)
        metadata = self.ctx.ns['_di_get'](child, 'item')
        self.assertEqual(metadata['item']['parent'], 'assembly')
        self.assertGreaterEqual(self.ctx.identity_checks, 2)
        self.assertEqual(self.ctx.call('assembly.parts', {})['parts'][1]['catalog']['id'], 'child')

    def test_catalog_reuse_and_user_changes_preflight(self):
        p = plan('catalog.import', [item('part')])
        r = self.invoke(p)
        p['onExisting'] = 'reuse'
        writes = len(self.ctx.writes)
        self.assertTrue(self.invoke(p)['reused'])
        self.assertEqual(len(self.ctx.writes), writes)
        occurrence = self.ctx.resolve(r['instances'][0]['occurrence'])
        occurrence._transform.values[3] = 7
        result = self.ctx.call('catalog.import', p)
        self.assertEqual(result['status'], 'blocked')
        self.assertIn('state conflict', result['error'])
        self.assertEqual(len(self.ctx.writes), writes)

    def test_imported_local_occurrence_snapshot_never_reads_unqualified_token(self):
        parent = self.ctx.root.occurrences.addNewComponent(Matrix()).component
        child = parent.occurrences.addNewComponent(Matrix())
        child.component.name = 'Imported STEP content'
        snapshot = self.ctx.ns['_di_geometry_state'](parent)
        self.assertNotIn('token', snapshot['importedOccurrences'][0])
        self.assertTrue(self.ctx.ns['_di_geometry_matches'](self.ctx, parent, snapshot))
        child.component.name = 'External rename'
        with self.assertRaises(ValueError):
            self.ctx.ns['_di_geometry_matches'](self.ctx, parent, snapshot)

    def test_nested_ground_to_parent_refuses_before_placement(self):
        result = self.invoke(plan('catalog.import', [item('assembly', kind='assembly'), item('child', parent='assembly')]))
        ref = result['idMap']['child']['occurrences'][0]
        occurrence = self.ctx.resolve(ref)
        occurrence.nativeObject.isGroundToParent = True
        writes = list(self.ctx.writes)
        p = plan('placement.import', [dict(id='child', occurrence=ref, placement=pose('2 mm'))])
        self.assertIn('grounded', self.ctx.call('placement.import', p)['error'])
        self.assertEqual(self.ctx.writes, writes)

    def test_parameter_import_reuses_expression_preflight_and_stores_provenance(self):
        p = plan('param.import', [dict(name='double', expression='2 * width', unit='mm', status='ESTIMATED'), dict(name='width', expression='4 mm', unit='mm', status='CONFIRMED')])
        r = self.invoke(p)
        self.assertEqual(self.ctx.design.userParameters.writes, ['width', 'double'])
        self.assertEqual(r['associativity'], 'nativeExpression')
        width = self.ctx.design.userParameters.itemByName('width')
        self.assertEqual(self.ctx.ns['_di_get'](width, 'parameter')['revision'], 'r1')
        self.assertIn('ESTIMATED', self.ctx.design.userParameters.itemByName('double').attributes.itemByName('fmcad.parameter', 'metadata').value)

    def test_late_bad_expression_does_not_create_first_parameter(self):
        p = plan('param.import', [dict(name='good', expression='4 mm', unit='mm'), dict(name='bad', expression='missing * 2', unit='mm')])
        r = self.ctx.call('param.import', p)
        self.assertIn('error', r)
        self.assertEqual(self.ctx.design.userParameters.count, 0)

    def test_parameter_update_does_not_adopt_unowned_or_modified_values(self):
        self.ctx.design.userParameters.add('foreign', '1 mm', 'mm', '')
        p = plan('param.import', [dict(name='foreign', expression='2 mm', unit='mm')], onExisting='update', expectedRevision='r0')
        r = self.ctx.call('param.import', p)
        self.assertIn('unowned', r['error'])
        self.assertEqual(self.ctx.design.userParameters.itemByName('foreign').expression, '1 mm')

    def test_model_missing_in_last_record_prevents_any_catalog_mutation(self):
        p = plan('catalog.import', [item('first'), item('last', model=dict(path='absent.step', representation='vendor', status='OPEN'))])
        r = self.ctx.call('catalog.import', p)
        self.assertIn('Missing model', r['error'])
        self.assertEqual(self.ctx.writes, [])

    def test_missing_placement_never_creates_origin_geometry(self):
        row = item('last')
        del row['placement']
        p = plan('catalog.import', [item('first'), row])
        r = self.ctx.call('catalog.import', p)
        self.assertIn('Missing placement', r['error'])
        self.assertEqual(self.ctx.writes, [])

    def test_nested_pose_requires_all_shared_paths_and_changes_parent_local_matrix(self):
        imported = self.invoke(plan('catalog.import', [item('assembly', quantity=2, kind='assembly'), item('child', parent='assembly')]))
        refs = imported['idMap']['child']['occurrences']
        rows = [dict(id=str(i), occurrence=ref, placement=pose('20 mm'), status='CONFIRMED') for i, ref in enumerate(refs)]
        p = plan('placement.import', rows[:1])
        before = list(self.ctx.writes)
        self.assertIn('every affected path', self.ctx.call('placement.import', p)['error'])
        self.assertEqual(before, self.ctx.writes)
        r = self.invoke(plan('placement.import', rows))
        self.assertTrue(all(abs(row['actual'][3] - 2) < 1e-12 for row in r['poses']))

    def test_parent_and_child_root_targets_use_final_parent_pose(self):
        r = self.invoke(plan('catalog.import', [item('assembly', kind='assembly'), item('child', parent='assembly')]))
        a, b = r['instances']
        rows = [dict(id='b', occurrence=b['occurrence'], placement=pose('30 mm', 'root')), dict(id='a', occurrence=a['occurrence'], placement=pose('10 mm', 'root'))]
        result = self.invoke(plan('placement.import', rows))
        actual = {r['id']: r['actual'][3] for r in result['poses']}
        self.assertAlmostEqual(actual['b'], 3)
        self.assertAlmostEqual(actual['a'], 1)
        self.assertAlmostEqual(self.ctx.resolve(b['occurrence']).transform2.asArray()[3], 2)

    def test_placement_check_is_readonly_and_reports_actual_error(self):
        r = self.invoke(plan('catalog.import', [item('part')]))
        rows = [dict(id='part', occurrence=r['instances'][0]['occurrence'], placement=pose('20 mm', 'root'))]
        before = list(self.ctx.writes)
        result = self.invoke(plan('placement.check', rows))
        self.assertEqual(result['status'], 'fail')
        self.assertEqual(result['poses'][0]['distance'], 2)
        self.assertEqual(before, self.ctx.writes)

    def test_named_datum_uses_stored_component_local_frame(self):
        r = self.invoke(plan('catalog.import', [item('part')]))
        datum = dict(component=self.ctx.ref(self.ctx.root), matrix=Matrix().asArray(), space='component local', lengthUnits='cm')
        datum['matrix'][3] = 4
        self.ctx.root.attributes.add('fmcad.frames', 'mount', json.dumps(datum))
        rows = [dict(id='part', occurrence=r['instances'][0]['occurrence'], placement=pose('20 mm', dict(datum='mount', component='root')))]
        result = self.invoke(plan('placement.import', rows))
        self.assertAlmostEqual(result['poses'][0]['actual'][3], 6)

    def test_catalog_check_compares_requested_pose_not_only_stored_manifest(self):
        self.invoke(plan('catalog.import', [item('part')]))
        result = self.invoke(plan('catalog.check', [item('part', placement=pose('20 mm'))]))
        self.assertEqual(result['status'], 'fail')
        self.assertTrue(any('Requested pose' in d.get('reason', '') for d in result['differences']))

    def test_budget_expiration_returns_partial_refs_without_retry(self):
        p = plan('catalog.import', [item('a'), item('b')])
        checks = 0
        def budget(plan):
            nonlocal checks
            checks += 1
            if checks == 4:
                raise TimeoutError('injected budget exhausted')
        with patch.dict(self.ctx.ns, {'_di_budget': budget}):
            r = self.ctx.call('catalog.import', p)
        self.assertEqual(r['status'], 'fail')
        self.assertTrue(r['created'])
        self.assertEqual(self.ctx.root.occurrences.count, 1)

    def test_grounded_late_row_blocks_all_pose_mutation(self):
        r = self.invoke(plan('catalog.import', [item('a'), item('b')]))
        rows = [dict(id=row['id'], occurrence=row['occurrence'], placement=pose('20 mm')) for row in r['instances']]
        self.ctx.resolve(rows[-1]['occurrence']).isGrounded = True
        before = list(self.ctx.writes)
        result = self.ctx.call('placement.import', plan('placement.import', rows))
        self.assertIn('grounded', result['error'])
        self.assertEqual(before, self.ctx.writes)

    def test_cots_datum_alignment_all_occurrences_and_import_failure_retains_old(self):
        records = [item('sensor', kind='purchased', quantity=2)]
        imported = self.invoke(plan('catalog.import', records))
        request = dict(expectedRevision='r1', target='sensor', occurrencePolicy='all',
                       model=dict(path='fixture.step', representation='envelope', status='ESTIMATED'),
                       datumMap=[dict(name='mount', old=pose('10 mm', 'component'), new=pose('2 mm', 'component'))],
                       impacts={k: dict(status='unknown', items=[]) for k in ('matingParts', 'routings', 'refs', 'mass')}, acceptInvalidation=True)
        p = plan('cots.replace', revision='r2', **request)
        with patch.dict(self.ctx.ns, {'_di_model_preflight': lambda *args: None}):
            p['result']['model']['fusionPath'] = 'fixture.step'
            self.ctx.fail_import = True
            r = self.ctx.call('cots.replace', p)
            self.assertEqual(r['status'], 'fail')
            self.assertNotIn('delete', self.ctx.writes)
            for ref in imported['idMap']['sensor']['occurrences']:
                self.assertIsNotNone(self.ctx.resolve(ref))
        # A fresh context is necessary: no blind replay of the failed mutation.
        self.ctx = Context()
        self.invoke(plan('catalog.import', records))
        with patch.dict(self.ctx.ns, {'_di_model_preflight': lambda *args: None}):
            result = self.invoke(p)
        self.assertEqual(len(result['replacements']), 2)
        self.assertEqual(self.ctx.root.occurrences.count, 2)
        self.assertTrue(all(abs(o.transform2.asArray()[3] - .8) < 1e-12 for o in self.ctx.root.occurrences.items))
        self.assertIsNone(result['mass'])
        self.assertIn('geometry refs', result['invalidated'])

    def test_cots_selected_preserves_physical_child_world_pose_without_duplicating_purchase(self):
        records = [item('board', kind='pcba', quantity=2, purchaseQuantity=2, contents=[dict(id='module', quantity=1)], placement=pose('30 mm')),
                   item('module', parent='board', allocation=dict(owner='board', quantity=2), placement=pose('5 mm'))]
        imported = self.invoke(plan('catalog.import', records))
        original = imported['idMap']['board']['occurrences']
        request = dict(expectedRevision='r1', target='board', occurrencePolicy='selected', occurrences=[original[0]], childrenPolicy='preserve',
                       model=dict(path='fixture.step', representation='envelope', status='ESTIMATED', includedItems=[]),
                       datumMap=[dict(name='mount', old=pose('10 mm', 'component'), new=pose('2 mm', 'component'))],
                       impacts={k: dict(status='unknown', items=[]) for k in ('matingParts', 'routings', 'refs', 'mass')}, acceptInvalidation=True)
        p = plan('cots.replace', revision='r2', **request)
        p['result']['model']['fusionPath'] = 'fixture.step'
        with patch.dict(self.ctx.ns, {'_di_model_preflight': lambda *args: None}):
            result = self.invoke(p)
        self.assertEqual(len(result['replacements']), 1)
        self.assertEqual(len(result['childMap']), 1)
        self.assertAlmostEqual(result['childMap'][0]['worldMatrix'][3], 3.5)
        self.assertAlmostEqual(self.ctx.resolve(original[1]).transform2.asArray()[3], 3)
        self.assertEqual(len([o for o in self.ctx.root.allOccurrences.items if o.component.name == 'module']), 2)


if __name__ == '__main__':
    unittest.main()

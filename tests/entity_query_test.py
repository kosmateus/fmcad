"""Offline GM03 behavior/oracle tests; SDK objects only are doubled, not the resolver."""
import json
import sys
from pathlib import Path
import types
import unittest
from unittest.mock import patch

import core_test as fixture

ROOT = Path(__file__).resolve().parents[1]
Items, Entity, Point = fixture.Items, fixture.Entity, fixture.Point


def matrix(values):
    return types.SimpleNamespace(objectType='adsk::core::Matrix3D', asArray=lambda: list(values))


def box(low, high):
    return types.SimpleNamespace(objectType='adsk::core::BoundingBox3D', minPoint=Point(*low), maxPoint=Point(*high))


class QueryTests(unittest.TestCase):
    register = fixture.CoreTests.register
    body = fixture.CoreTests.body
    occurrence = fixture.CoreTests.occurrence

    def setUp(self):
        fixture.CoreTests.setUp(self)
        self.doc.creationId = 'creation-test'
        self.doc.dataFile.id = 'file-test'
        self.doc.dataFile.versionNumber = 7
        self.a = self.body('A')
        self.a.boundingBox = box((0, 0, 0), (2, 3, 4))
        self.a.volume, self.a.area = 24, 52
        self.e1 = self.edge(self.a, 'short', 0.01, 0.2, (0, 0, -1))
        self.e2 = self.edge(self.a, 'long', 2, 0.2, (0, 0, 1))
        self.e3 = self.edge(self.a, 'other', 3, 0.5, (1, 0, 0))

    def edge(self, body, name, length, radius, axis):
        edge = Entity('BRepEdge', name, body.parentComponent)
        edge.body, edge.length, edge.faces = body, length, Items()
        edge.geometry = types.SimpleNamespace(objectType='adsk::core::Circle3D', center=Point(1, 0, 0), normal=Point(*axis), radius=radius)
        edge.boundingBox = box((1 - radius, -radius, 0), (1 + radius, radius, 0))
        body.edges.items.append(edge)
        self.register(edge)
        return edge

    def query(self, **data):
        result = self.ctx.call('entity.find', {'schemaVersion': 1, 'kind': 'edge', **data})
        json.dumps(result, allow_nan=False)
        return result

    def test_short_edge_intervals_antiparallel_axes_and_rejected_diagnostics(self):
        result = self.query(filters={'length': {'max': '0.1 mm'}, 'radius': {'min': '2 mm', 'max': '2 mm'}, 'axis': [0, 0, 3]}, expect=1)
        self.assertEqual(result['refs'], [self.ctx.ref(self.e1)])
        self.assertEqual(result['statistics']['length']['mean'], 0.01)
        self.assertEqual(result['statistics']['length']['units'], 'cm')
        self.assertEqual(result['candidateCount'], 3)
        self.assertEqual(result['rejected'][0]['reasons'], ['length'])
        self.assertEqual(result['documentIdentity']['version'], 7)
        self.assertEqual(result['associativity'], 'snapshot')

    def test_geometry_frame_metadata_survives_query_filters_without_mutation(self):
        before = (list(self.a.edges.items), self.e1.geometry.radius,
                  self.e1.geometry.normal.z, self.a.attributes.writes, list(self.ctx.created))
        for frame in ('component', 'root'):
            result = self.query(frame=frame, filters={'geometry': 'circle'}, expect=3)
            self.assertTrue(result['success'])
            self.assertEqual(result['affected'], [])
            self.assertEqual(result['documentIdentity']['creationId'], 'creation-test')
            self.assertEqual(result['documentIdentity']['fileId'], 'file-test')
            for row in result['entities']:
                self.assertEqual(row['geometry']['frame'], {'kind': frame, 'ref': self.ctx.ref(self.root)})
                self.assertEqual(row['geometry']['frame'], row['frame'])
                self.assertEqual(row['geometry']['lengthUnits'], 'cm')
                self.assertEqual(row['geometry']['angleUnits'], 'rad')
        self.assertEqual((list(self.a.edges.items), self.e1.geometry.radius,
                          self.e1.geometry.normal.z, self.a.attributes.writes, list(self.ctx.created)), before)

    def test_zero_multiple_expected_count_and_no_first_match(self):
        all_rows = self.query(expect=1)
        self.assertFalse(all_rows['success'])
        self.assertEqual(len(all_rows['ambiguous']), 3)
        self.assertEqual(all_rows['count'], 3)
        for expected, success in [(0, True), ({'max': 1}, True), ({'min': 1}, False)]:
            result = self.query(filters={'length': '99 mm'}, expect=expected)
            self.assertEqual(result['success'], success)
            self.assertIsNone(result['statistics']['length']['sum'])
        with self.assertRaisesRegex(ValueError, 'found 3'):
            self.query(unique=True)
        self.assertTrue(self.query(expect={'min': 2, 'max': 3})['success'])

    def test_body_feature_scope_and_topology_invalidation(self):
        foreign = self.body('B')
        self.edge(foreign, 'foreign', 0.01, 0.2, (0, 0, 1))
        feature = Entity('FilletFeature', 'Round', self.root)
        face = Entity('BRepFace', 'rounded', self.root)
        face.body, face.edges, face.vertices = self.a, Items([self.e1, self.e2]), Items()
        feature.faces, feature.bodies = Items([face]), Items([self.a])
        self.root.features.items.append(feature)
        self.register(feature)
        self.assertEqual(self.query(scope={'body': 'A'})['count'], 3)
        self.assertEqual(self.query(scope={'feature': 'Round'})['count'], 2)
        self.assertEqual(self.query(kind='body', scope={'feature': 'Round'})['refs'], [self.ctx.ref(self.a)])
        self.assertEqual(self.query(kind='face', scope={'feature': 'Round'})['count'], 1)
        self.e1.isValid = False
        self.a.edges.items.remove(self.e1)
        face.edges.items.remove(self.e1)
        self.tokens[self.e1.entityToken] = []
        self.assertEqual(self.query(scope={'feature': 'Round'})['refs'], [self.ctx.ref(self.e2)])
        self.assertFalse(self.query(scope={'body': 'A'}, filters={'length': {'max': '1 mm'}}, expect=1)['success'])
        with self.assertRaisesRegex(ValueError, 'found 0'):
            self.ctx.call('entity.inspect', {'ref': self.ctx.ref(self.e1), 'schemaVersion': 1})
        self.tokens[self.e2.entityToken] = [self.e2, self.e3]
        with self.assertRaisesRegex(ValueError, 'found 2'):
            self.ctx.resolve(self.ctx.ref(self.e2))

    def test_bbox_inside_intersection_signed_levels_and_body_position(self):
        result = self.query(kind='body', filters={'bbox': {'min': ['0 cm'] * 3, 'max': ['2 cm', '3 cm', '4 cm']},
                                                   'level': {'axis': 'z', 'at': 'max', 'value': '4 cm'},
                                                   'position': ['1 cm', '1.5 cm', '2 cm']}, expect=1)
        self.assertTrue(result['success'])
        for mode, count in [('inside', 0), ('intersects', 1)]:
            self.assertEqual(self.query(kind='body', filters={'bbox': {'min': ['1 cm'] * 3, 'max': ['5 cm'] * 3, 'mode': mode}})['count'], count)
        self.a.boundingBox = box((-2, -3, -4), (0, 0, 0))
        for at, expected in [('min', '-4 cm'), ('max', '0 cm'), ('center', '-2 cm')]:
            self.assertEqual(self.query(kind='body', filters={'level': {'axis': 'z', 'at': at, 'value': {'min': expected, 'max': expected}}})['count'], 1)

    def test_adjacency_faces_edges_vertices_and_explicit_refs(self):
        face = Entity('BRepFace', 'side', self.root)
        face.body, face.edges, face.vertices = self.a, Items([self.e1, self.e2]), Items()
        face.geometry = types.SimpleNamespace(objectType='adsk::core::Cylinder', origin=Point(0, 0, 0), axis=Point(0, 0, 1), radius=0.2)
        self.a.faces.items.append(face)
        self.e1.faces.items.append(face)
        self.e2.faces.items.append(face)
        self.register(face)
        vertex = Entity('BRepVertex', 'endpoint', self.root)
        vertex.body, vertex.edges, vertex.faces = self.a, Items([self.e1]), Items([face])
        self.e1.startVertex = self.e1.endVertex = vertex
        self.e2.startVertex = self.e2.endVertex = None
        self.e3.startVertex = self.e3.endVertex = None
        self.register(vertex)
        self.assertEqual(self.query(filters={'adjacency': {'kind': 'face', 'filters': {'geometry': 'cylinder'}, 'expect': 1}})['count'], 2)
        self.assertEqual(self.query(filters={'adjacency': {'kind': 'edge', 'refs': [self.ctx.ref(self.e1)], 'expect': 1}})['refs'], [self.ctx.ref(self.e2)])
        self.assertEqual(self.query(filters={'adjacency': {'kind': 'vertex', 'refs': [self.ctx.ref(vertex)]}})['refs'], [self.ctx.ref(self.e1)])
        self.assertEqual(self.query(filters={'adjacency': {'kind': 'body', 'refs': [self.ctx.ref(self.a)]}})['count'], 3)
        self.assertEqual(self.query(filters={'adjacency': {'kind': 'face', 'expect': 0}})['refs'], [self.ctx.ref(self.e3)])

    def instances(self):
        # Parent Rz(90), translation (10,0,0); child translation (2,0,0).
        parent_component = fixture.component('Subassembly')
        self.design.allComponents.items.append(parent_component)
        parent = self.occurrence('Sub:1')
        parent.component = parent_component
        parent.transform2 = matrix([0,-1,0,10, 1,0,0,0, 0,0,1,0, 0,0,0,1])
        first = self.occurrence('Sub:1+Part:1')
        native = Entity('Occurrence', 'Part:1')
        native.component = self.child
        native.fullPathName = 'Part:1'
        native.transform2 = matrix([1,0,0,2, 0,1,0,0, 0,0,1,0, 0,0,0,1])
        first.nativeObject = native
        # SDK root-qualified proxies expose the actual root transform.
        first.transform2 = matrix([0,-1,0,10, 1,0,0,2, 0,0,1,0, 0,0,0,1])
        second = self.occurrence('Part:2')
        second.transform2 = matrix([1,0,0,-10, 0,1,0,0, 0,0,1,0, 0,0,0,1])
        body = self.body('Child', self.child)
        edge = self.edge(body, 'child-edge', 0.1, 0.2, (1,0,0))
        return first, second, body, edge

    def test_nested_repeated_instances_root_frames_and_inverse(self):
        first, second, body, edge = self.instances()
        result = self.query(component='Part', instances=True, frame='root', expect=2, groupBy=['occurrence'])
        centers = [row['geometry']['center'] for row in result['entities']]
        self.assertEqual(centers, [[10,3,0], [-9,0,0]])
        self.assertEqual([row['occurrencePath'] for row in result['entities']], ['Sub:1+Part:1', 'Part:2'])
        self.assertEqual(result['entities'][0]['geometry']['normal'], [0,1,0])
        self.assertEqual(result['entities'][0]['boundingBox']['min'], [9.8,2.8,0])
        self.assertEqual(len(result['groups']), 2)
        scoped = self.query(occurrence=first.fullPathName, frame='component')
        self.assertEqual(scoped['entities'][0]['geometry']['center'], [1,0,0])
        inverse = self.query(occurrence=first.fullPathName, frame={'occurrence': first.fullPathName})
        self.assertEqual(inverse['entities'][0]['geometry']['center'], [1,0,0])
        other = self.query(occurrence=first.fullPathName, frame={'occurrence': second.fullPathName})
        self.assertEqual(other['entities'][0]['geometry']['center'], [20,3,0])
        self.assertEqual(self.query(occurrence='Sub:1', instances=True, frame='root')['count'], 1)
        with self.assertRaisesRegex(ValueError, 'explicit occurrence'):
            self.query(component='Part', frame='root')
        # Reusing a result preserves its full root-context occurrence path.
        row = result['entities'][0]
        inspected = self.ctx.call('entity.inspect', {'ref': row, 'frame': 'root'})
        self.assertEqual(inspected['geometry']['center'], [10,3,0])

    def test_nested_occurrence_override_is_not_reconstructed_from_native_pose(self):
        first, second, body, edge = self.instances()
        first.transform2 = matrix([0,-1,0,20, 1,0,0,2, 0,0,1,0, 0,0,0,1])
        result = self.query(occurrence=first.fullPathName, frame='root')
        self.assertEqual(result['entities'][0]['geometry']['center'], [20,3,0])
        self.assertEqual(first.nativeObject.transform2.asArray()[3], 2)
        result = self.query(occurrence=first.fullPathName, frame={'occurrence': first.fullPathName})
        self.assertEqual(result['entities'][0]['geometry']['center'], [1,0,0])

    def test_attribute_predicates_keep_native_proxy_and_occurrence_owners_distinct(self):
        first, second, body, edge = self.instances()
        body.attributes.add('fixture.roles', 'definition', 'native-part')
        first.attributes.add('fixture.roles', 'site', 'north')
        second.attributes.add('fixture.roles', 'site', 'south')
        native_proxy = body.createForAssemblyContext

        class Attributes:
            def __init__(self):
                self.values = {}
            def add(self, group, name, value):
                item = types.SimpleNamespace(value=value)
                self.values[group, name] = item
                return item
            def itemByName(self, group, name):
                return self.values.get((group, name))

        proxy_mode = {'missingNativeObject': False}
        def create_context_proxy(occurrence):
            proxy = native_proxy(occurrence)
            proxy.attributes = Attributes()
            proxy.attributes.add('fixture.roles', 'view',
                                 'north-view' if occurrence == first else 'south-view')
            if proxy_mode['missingNativeObject'] and occurrence == first:
                proxy.nativeObject = None
            return proxy

        body.createForAssemblyContext = create_context_proxy
        native = self.query(kind='body', component='Part', instances=True,
            filters={'attributes':[{'group':'fixture.roles','name':'definition',
                                    'value':'native-part','owner':'native'}]}, expect=2,
            groupBy=['occurrence'])
        self.assertEqual(native['count'], 2)
        self.assertEqual([row['occurrencePath'] for row in native['entities']],
                         ['Sub:1+Part:1', 'Part:2'])

        contextual_proxy = self.query(kind='body', component='Part', instances=True,
            filters={'attributes':[{'group':'fixture.roles','name':'view',
                                    'value':'north-view','owner':'proxy'}]}, expect=1)
        self.assertEqual(contextual_proxy['entities'][0]['occurrencePath'], 'Sub:1+Part:1')
        no_native_fallback = self.query(kind='body', component='Part', instances=True,
            filters={'attributes':[{'group':'fixture.roles','name':'view',
                                    'value':'north-view','owner':'native'}]}, expect=0)
        self.assertEqual(no_native_fallback['count'], 0)
        no_proxy_fallback = self.query(kind='body', component='Part', instances=True,
            filters={'attributes':[{'group':'fixture.roles','name':'definition',
                                    'value':'native-part','owner':'proxy'}]}, expect=0)
        self.assertEqual(no_proxy_fallback['count'], 0)
        conjunction = self.query(kind='body', component='Part', instances=True,
            filters={'attributes':[
                {'group':'fixture.roles','name':'definition','value':'native-part','owner':'native'},
                {'group':'fixture.roles','name':'site','value':'north','owner':'occurrence'}]}, expect=1)
        self.assertEqual(conjunction['entities'][0]['occurrencePath'], 'Sub:1+Part:1')

        occurrence_value = self.query(kind='body', component='Part', instances=True,
            filters={'attributes':[{'group':'fixture.roles','name':'site',
                                    'value':'south','owner':'occurrence'}]}, expect=1)
        self.assertEqual(occurrence_value['entities'][0]['occurrencePath'], 'Part:2')
        missing = self.query(kind='body', component='Part', instances=True,
            filters={'attributes':[{'group':'fixture.roles','name':'absent',
                                    'value':'anything','owner':'native'}]}, expect=0)
        self.assertEqual(missing['rejected'][0]['reasons'], ['attribute missing: fixture.roles/absent'])
        proxy_mode['missingNativeObject'] = True
        no_native_proxy_fallback = self.query(kind='body', component='Part', instances=True,
            filters={'attributes':[{'group':'fixture.roles','name':'view',
                                    'value':'north-view','owner':'native'}]}, expect=0)
        self.assertEqual(no_native_proxy_fallback['count'], 0)
        with self.assertRaisesRegex(ValueError, 'proxy and occurrence attribute predicates require'):
            self.query(kind='body', component='Part', filters={'attributes':[{
                'group':'fixture.roles','name':'site','value':'north','owner':'occurrence'}]})
        with self.assertRaisesRegex(ValueError, 'not valid for component'):
            self.query(kind='component', instances=True, filters={'attributes':[{
                'group':'fixture.roles','name':'site','value':'north','owner':'occurrence'}]})

    def test_attribute_selection_includes_hidden_physical_bodies(self):
        hidden = self.body('HiddenPhysicalBody')
        hidden.isVisible = False
        hidden.attributes.add('fixture.roles', 'physical', 'hidden-solid')
        result = self.query(kind='body', component='root',
            filters={'attributes':[{'group':'fixture.roles','name':'physical',
                                    'value':'hidden-solid','owner':'native'}]}, expect=1)
        self.assertEqual(result['refs'], [self.ctx.ref(hidden)])
        self.assertEqual(result['candidateCount'], 2)
        hidden.attributes.add('fixture.roles', 'empty-string', '')
        self.assertEqual(self.query(kind='body', component='root', filters={'attributes':[
            {'group':'fixture.roles','name':'empty-string','value':'','owner':'native'}]}, expect=1)['count'], 1)

    def test_owned_native_attribute_fixture_compiles_without_execution(self):
        for filename in ('native.py', 'measure_consumer.py', 'cardinality.py', 'nested_repeated.py'):
            source = ROOT / 'tests/fixtures/recipe-reduction/entity-attributes' / filename
            compile(source.read_text(), str(source), 'exec')

    def test_attribute_query_rejects_conflicting_occurrence_and_component_context(self):
        parent = fixture.component('OtherParent')
        self.design.allComponents.items.append(parent)
        other = self.occurrence('OtherParent:1')
        other.component = parent
        with self.assertRaisesRegex(ValueError, 'contexts disagree'):
            self.query(kind='body', component='Part', occurrence=other.fullPathName,
                filters={'attributes':[{'group':'fixture.roles','name':'flag',
                                        'value':'on','owner':'occurrence'}]})
        with self.assertRaisesRegex(ValueError, 'scope must be an object'):
            self.query(kind='body', scope=[], filters={'attributes':[{
                'group':'fixture.roles','name':'flag','value':'on','owner':'occurrence'}]})

    def test_named_datum_and_sketch_xz_yz_frames(self):
        self.ctx.call('datum.frame', {'name':'local', 'origin':['10 mm','0 mm','0 mm'], 'xAxis':[0,1,0], 'yAxis':[-1,0,0]})
        result = self.query(frame={'datum':'local'})
        self.assertEqual(result['entities'][0]['geometry']['center'], [0,0,0])
        self.e1.geometry.center = Point(1,2,3)
        for name, transform, expected in [('XZ', lambda p: Point(p.x,-p.z,p.y), [1,3,-2]),
                                           ('YZ', lambda p: Point(p.z,p.x,p.y), [2,3,1])]:
            sketch = Entity('Sketch', 'Sketch' + name, self.root)
            sketch.sketchToModelSpace = transform
            self.root.sketches.items.append(sketch)
            self.register(sketch)
            result = self.query(filters={'name':'short'}, frame={'sketch': sketch.name})
            self.assertEqual(result['entities'][0]['geometry']['center'], expected)

    def test_rigid_frame_guards_and_no_implicit_definition_placement(self):
        first, second, body, edge = self.instances()
        for bad in ([2,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1],
                    [-1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1],
                    [1,0.5,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]):
            second.transform2 = matrix(bad)
            with self.assertRaisesRegex(ValueError, 'non-rigid'):
                self.query(occurrence='Part:2', frame='root')
        with self.assertRaisesRegex(ValueError, 'Unknown named datum'):
            self.query(frame={'datum':'missing'})

    def test_local_frames_of_repeated_definition_and_empty_scope_validation(self):
        first, second, body, edge = self.instances()
        self.assertEqual(self.query(component='Part', frame={'component':'Part'})['entities'][0]['geometry']['center'], [1,0,0])
        self.child.attributes.add(self.core._CAD_FRAME_GROUP, 'Mount', json.dumps({'matrix':[1,0,0,1, 0,1,0,0, 0,0,1,0, 0,0,0,1]}))
        self.assertEqual(self.query(component='Part', frame={'component':'Part','datum':'Mount'})['entities'][0]['geometry']['center'], [0,0,0])
        self.assertEqual(self.query(kind='component', scope={'component':'Part'})['count'], 1)
        self.assertEqual(self.query(kind='occurrence', scope={'component':'Part'})['count'], 2)
        self.assertEqual(self.query(kind='occurrence', scope={'occurrence':first.fullPathName})['count'], 1)
        self.child.bRepBodies.items.clear()
        for bad in ({'frame':'bad'}, {'frame':{}}, {'frame':{'datum':'missing'}}, {'kind':'invalid','instances':True}):
            with self.assertRaises(ValueError):
                self.query(component='Part', **bad)

    def test_sketch_and_profile_bounds_and_centroid_use_sketch_basis(self):
        sketch = Entity('Sketch', 'YZSection', self.root)
        sketch.sketchToModelSpace = lambda p: Point(5 + p.z, p.x, p.y)
        sketch.boundingBox = box((0,0,0),(2,3,0))
        sketch.sketchPoints, sketch.profiles = Items(), Items()
        self.root.sketches.items.append(sketch)
        self.register(sketch)
        profile = Entity('Profile')
        profile.parentSketch, profile.profileLoops = sketch, Items([object()])
        profile.boundingBox = box((0,0,0),(2,3,0))
        profile.areaProperties = lambda: types.SimpleNamespace(area=6, centroid=Point(1,1.5,0))
        sketch.profiles.items.append(profile)
        for kind in ('sketch','profile'):
            row = self.query(kind=kind, frame='root')['entities'][0]
            self.assertEqual(row['boundingBox']['min'], [5,0,0])
            self.assertEqual(row['boundingBox']['max'], [5,2,3])
            if kind == 'profile':
                self.assertEqual(row['centroid']['xyz'], [5,1,1.5])
                self.assertEqual(row['centroid']['frame']['kind'], 'root')

    def test_same_kind_face_and_vertex_adjacency_share_actual_boundary(self):
        f1, f2 = Entity('BRepFace','f1',self.root), Entity('BRepFace','f2',self.root)
        v1, v2 = Entity('BRepVertex','v1',self.root), Entity('BRepVertex','v2',self.root)
        for face in (f1,f2):
            face.body, face.edges, face.vertices = self.a, Items([self.e1]), Items([v1,v2])
        self.e1.faces = Items([f1,f2])
        self.e1.startVertex, self.e1.endVertex = v1,v2
        for vertex in (v1,v2):
            vertex.body, vertex.edges = self.a, Items([self.e1])
        self.a.faces, self.a.vertices = Items([f1,f2]), Items([v1,v2])
        self.assertEqual(self.query(kind='face',filters={'adjacency':{'kind':'face','expect':1}})['count'],2)
        self.assertEqual(self.query(kind='vertex',filters={'adjacency':{'kind':'vertex','expect':1}})['count'],2)
        self.e1.attributes.add('fixture.roles', 'edgeRole', 'bearing')
        self.assertEqual(self.query(kind='face', scope={'body':'A'}, filters={'adjacency':{
            'kind':'edge', 'filters':{'attributes':[{'group':'fixture.roles','name':'edgeRole',
                'value':'bearing','owner':'native'}]}, 'expect':1}}, expect=2)['count'], 2)

    def test_numeric_boundaries_and_missing_fields_do_not_acquire_zero(self):
        self.assertEqual(self.query(filters={'length':{'min':'2 cm'},'tolerance':'0 mm'})['count'],2)
        self.assertEqual(self.query(filters={'axis':[0,0,1],'angleTolerance':'90 deg'})['count'],3)
        self.e1.geometry = None
        del self.e1.length
        row = self.query(filters={'name':'short'})
        self.assertEqual(row['statistics']['length']['missing'],1)
        self.assertIsNone(row['statistics']['length']['min'])
        self.assertEqual(self.query(filters={'name':'short','length':'0 cm'})['count'],0)

    def test_shared_reference_queries_execute_measure_check_and_assign_handlers(self):
        for filename in ('measure.py','io.py'):
            exec(compile((ROOT/'assets/cad'/filename).read_text(), filename, 'exec'), self.core.__dict__)
        self.e1.attributes.add('fixture.roles', 'measurement', 'short')
        reference = {'query':{'kind':'edge','filters':{'length':{'max':'0.1 mm'},
            'attributes':[{'group':'fixture.roles','name':'measurement','value':'short','owner':'native'}]}}}
        length = self.ctx.call('measure.length', {'ref':reference,'units':'mm'})
        self.assertEqual(length['value'],0.1)
        self.assertEqual(length['ref'], self.ctx.ref(self.e1))
        check = self.ctx.call('check', {'measurement':{'operation':'measure.length','data':{'ref':reference,'units':'mm'}},
                                       'expected':'0.1 mm','tolerance':'0.001 mm'})
        self.assertTrue(check['passed'])
        style = types.SimpleNamespace(id='style-test', name='Test finish')
        self.design.appearances = Items([style])
        self.a.appearance = None
        self.a.attributes.add('fixture.roles', 'appearance', 'apply')
        assigned = self.ctx.call('appearance.assign', {'refs':[{'query':{'kind':'body','filters':{
            'name':'A','attributes':[{'group':'fixture.roles','name':'appearance','value':'apply','owner':'native'}]}}}], 'id':'style-test'})
        self.assertEqual(assigned['assigned'],[self.ctx.ref(self.a)])
        self.assertIs(self.a.appearance,style)
        self.assertEqual(self.query(scope={'component':'root','body':{'query':{'filters':{'name':'A'}}}})['count'],3)
        with self.assertRaisesRegex(ValueError, 'not both'):
            self.query(scope={'component':'root','body':{'query':{'component':'root','filters':{'name':'A'}}}})
        with self.assertRaisesRegex(ValueError, 'found 3'):
            self.ctx.resolve({'query':{'kind':'edge','expect':3}})
        with self.assertRaisesRegex(ValueError, 'conflicts'):
            self.ctx.resolve(reference,'body')
        nested = {'query':{'kind':'body'}}
        for _ in range(17):
            nested = {'query':{'scope':{'body':nested},'kind':'body'}}
        with self.assertRaisesRegex(ValueError, 'nesting exceeds'):
            self.ctx.resolve(nested)
        self.assertEqual(self.ctx._entity_reference_depth,0)
        self.assertIs(self.ctx.resolve(reference),self.e1)

    def test_groups_all_variants_and_missing_statistics(self):
        result = self.query(groupBy=['kind','geometry','component','occurrence','body','radius','length','axis','level'])
        self.assertEqual(len(result['groups']), 3)
        same_axis = self.query(filters={'radius':'2 mm'}, groupBy=['axis'])
        self.assertEqual(same_axis['groups'][0]['count'], 2)
        self.assertEqual(result['statistics']['radius']['count'], 3)
        self.assertAlmostEqual(result['statistics']['length']['sum'], 5.01)
        self.assertEqual(result['statistics']['volume']['missing'], 3)
        self.assertIsNone(result['statistics']['volume']['mean'])
        body = self.ctx.call('entity.stats', {'kind':'body','groupBy':['body'],'expect':1})
        self.assertEqual(body['statistics']['volume']['sum'], 24)
        self.assertEqual(body['statistics']['area']['units'], 'cm^2')

    def test_all_geometry_type_variants_and_position_distance_oracles(self):
        for public, sdk_types in self.core._ENTITY_TYPES.items():
            for sdk_type in sdk_types:
                self.e1.geometry = types.SimpleNamespace(objectType='adsk::core::' + sdk_type)
                if sdk_type == 'Line3D':
                    self.e1.geometry.startPoint, self.e1.geometry.endPoint = Point(1,0,0), Point(2,0,0)
                if sdk_type == 'Point3D':
                    self.e1.geometry = Point(1,0,0)
                result = self.query(filters={'name':'short','geometry':public}, expect=1)
                self.assertTrue(result['success'], public)
        for sdk_type, props, point in [
                ('Plane', {'origin':Point(0,0,0),'normal':Point(0,0,-1)}, ['20 cm','30 cm','0 cm']),
                ('Cylinder', {'origin':Point(0,0,0),'axis':Point(0,0,-1)}, ['0 cm','0 cm','99 cm']),
                ('InfiniteLine3D', {'origin':Point(0,0,0),'direction':Point(0,0,1)}, ['0 cm','0 cm','-99 cm'])]:
            self.e1.geometry = types.SimpleNamespace(objectType='adsk::core::'+sdk_type, **props)
            self.assertTrue(self.query(filters={'name':'short','position':point}, expect=1)['success'])
            self.assertFalse(self.query(filters={'name':'short','position':['1 cm','1 cm','1 cm']}, expect=1)['success'])

    def test_preflight_bad_variants_and_identity_guard(self):
        cases = [ {'expect':True}, {'expect':{'min':2,'max':1}}, {'expect':{}}, {'schemaVersion':True},
                  {'instances':'true'}, {'unique':True,'expect':1}, {'scope':{'body':'A','feature':'Round'}},
                  {'scope':{'body':'A'},'component':'root'}, {'filters':{'length':{'min':'2 cm','max':'1 cm'}}},
                  {'filters':{'radius':'-1 mm'}}, {'filters':{'length':'3 deg'}}, {'filters':{'axis':[0,0,0]}},
                  {'filters':{'angleTolerance':'91 deg'}}, {'filters':{'tolerance':'-1 mm'}},
                  {'filters':{'bbox':{'min':['2 cm']*3,'max':['1 cm']*3}}},
                  {'filters':{'level':{'axis':'q','value':'1 mm'}}},
                  {'filters':{'adjacency':{'kind':'face','filters':{'adjacency':{'kind':'edge'}}}}},
                  {'filters':{'adjacency':{'kind':'feature'}}}, {'groupBy':['radius','radius']}, {'frame':'magic'} ]
        for data in cases:
            with self.subTest(data=data), self.assertRaises((ValueError, TypeError)):
                self.query(**data)
        self.ctx.doc_id = 'different'
        with self.assertRaisesRegex(ValueError, 'mismatch'):
            self.query()

    def test_query_model_integration_real_resolver_and_sdk_collection(self):
        # Load only model functions in the already isolated core namespace. Feature
        # collection doubles record the actual SDK edge set; no resolver is patched.
        trace = []
        states = types.SimpleNamespace(ErrorFeatureHealthState=2)
        self.core.adsk.fusion.FeatureHealthStates = states
        self.core.adsk.fusion.SketchCurve = types.SimpleNamespace(cast=lambda e: None)
        self.core.adsk.fusion.BRepEdge = types.SimpleNamespace(cast=lambda e: e if e.objectType.endswith('BRepEdge') else None)
        adsk = self.core.adsk
        with patch.dict(sys.modules, {'adsk':adsk, 'adsk.core':adsk.core, 'adsk.fusion':adsk.fusion}):
            exec(compile((ROOT/'assets/cad/model.py').read_text(), 'model.py', 'exec'), self.core.__dict__)

        class Collection:
            def createInput(inner):
                trace.append('input')
                def edges(selected, dimension, chain):
                    trace.append(([e.entityToken for e in selected.items], dimension, chain))
                    return object()
                return types.SimpleNamespace(edgeSetInputs=types.SimpleNamespace(addConstantRadiusEdgeSet=edges),
                    chamferEdgeSets=types.SimpleNamespace(addEqualDistanceChamferEdgeSet=edges))
            createInput2 = createInput
            def add(inner, inp):
                trace.append('add')
                created = Entity('FilletFeature','Round',self.root)
                created.bodies, created.healthState, created.errorOrWarningMessage = Items([self.a]), 0, ''
                # Simulate kernel topology replacement to prove resolvedQuery was
                # captured before mutation and the next query enumerates afresh.
                self.a.edges.items.remove(self.e1)
                self.e1.isValid = False
                return created

        self.root.features = types.SimpleNamespace(filletFeatures=Collection(), chamferFeatures=Collection())
        for mode, dimension in [('fillet','radius'),('chamfer','distance')]:
            self.e1.isValid = True
            if self.e1 not in self.a.edges.items:
                self.a.edges.items.insert(0, self.e1)
            trace.clear()
            data = {'query':{'scope':{'body':'A'},'filters':{'length':{'max':'0.1 mm'}},'expect':1},dimension:'0.05 mm','tangentChain':False}
            result = self.ctx.call('model.'+mode, data)
            self.assertEqual(trace, ['input', ([self.e1.entityToken], '0.05 mm', False), 'add'])
            self.assertEqual(result['resolvedQuery']['refs'], [self.ctx.ref(self.e1)])
            self.assertEqual(result['selectionAssociativity'], 'snapshot')
            self.assertEqual(result['resolvedQuery']['entities'][0]['length']['value'], 0.01)
            trace.clear()
            with self.assertRaisesRegex(ValueError, 'accepted nonempty'):
                self.ctx.call('model.'+mode, data)
            self.assertEqual(trace, [])
        for bad in ({'query':{},'radius':'1 mm'}, {'query':{'expect':3},'edges':[self.ctx.ref(self.e2)],'radius':'1 mm'},
                    {'query':{'kind':'face','expect':1},'radius':'1 mm'}, {'query':{'expect':2},'radius':'1 deg'}):
            with self.assertRaises(ValueError):
                self.ctx.call('model.fillet', bad)
            self.assertEqual(trace, [])
        first, second, body, edge = self.instances()
        for scope in ({'component':'Part'}, {'occurrence':first.fullPathName}):
            with self.assertRaisesRegex(ValueError, 'native input geometry'):
                self.ctx.call('model.fillet', {'query':{'scope':scope,'expect':1},'radius':'1 mm'})
            self.assertEqual(trace, [])
        def partial_failure(inp):
            trace.append('kernel partial change')
            raise RuntimeError('kernel failed after edit')
        self.root.features.filletFeatures.add = partial_failure
        with self.assertRaisesRegex(RuntimeError, 'kernel failed after edit'):
            self.ctx.call('model.fillet', {'query':{'expect':2},'radius':'1 mm'})
        self.assertEqual(trace.count('input'),1)
        self.assertEqual(trace.count('kernel partial change'),1)


if __name__ == '__main__':
    unittest.main()

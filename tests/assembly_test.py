"""Offline contract/API-shape tests; Fusion solver and kernel are not simulated."""
import json
import math
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
NS = types.SimpleNamespace


class Collection:
    def __init__(self, values=()):
        self.values = list(values)

    @property
    def count(self):
        return len(self.values)

    def item(self, index):
        return self.values[index]


class Attributes:
    def __init__(self):
        self.values = {}

    def itemByName(self, group, name):
        return self.values.get((group, name))

    def add(self, group, name, value):
        result = NS(value=value)
        self.values[group, name] = result
        return result


class Entity:
    serial = 0

    def __init__(self, kind, name='entity', **properties):
        Entity.serial += 1
        self.objectType = 'adsk::fusion::' + kind
        self.entityToken = str(Entity.serial)
        self.name = name
        self.assemblyContext = None
        self.attributes = Attributes()
        self.__dict__.update(properties)


class Matrix:
    def __init__(self):
        self.values = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

    def asArray(self):
        values = list(self.values)
        if hasattr(self, 'translation'):
            values[3], values[7], values[11] = self.translation.x, self.translation.y, self.translation.z
        return values

    def setWithArray(self, values):
        self.values = list(values)
        self.translation = NS(x=values[3], y=values[7], z=values[11])
        return True

    @staticmethod
    def create():
        return Matrix()

    def setToRotation(self, angle, axis, point):
        self.rotation = (angle, axis, point)
        return True

    def copy(self):
        result = Matrix()
        result.__dict__.update(self.__dict__)
        return result


def namespace():
    adsk = types.ModuleType('adsk')
    adsk.core = types.ModuleType('adsk.core')
    adsk.fusion = types.ModuleType('adsk.fusion')
    point = NS(create=lambda x, y, z: NS(x=x, y=y, z=z))
    adsk.core.Point3D = adsk.core.Vector3D = point
    adsk.core.ValueInput = NS(createByString=lambda value: ('value', value))
    adsk.core.Matrix3D = Matrix
    adsk.fusion.DesignTypes = NS(ParametricDesignType=1, DirectDesignType=0)
    adsk.fusion.FeatureHealthStates = NS(HealthyFeatureHealthState=0, WarningFeatureHealthState=1,
        ErrorFeatureHealthState=2, SuppressedFeatureHealthState=3, UnknownFeatureHealthState=5)
    adsk.fusion.JointDirections = NS(XAxisJointDirection='X', YAxisJointDirection='Y', ZAxisJointDirection='Z')
    adsk.fusion.JointGeometry = NS(createByPoint=lambda point: ('jointGeometry', point))
    ns = {}
    with patch.dict(sys.modules, {'adsk': adsk, 'adsk.core': adsk.core, 'adsk.fusion': adsk.fusion}):
        values = ROOT / 'runtime/python/fmcad/domain/values.py'
        exec(compile(values.read_text(), str(values), 'exec'), ns)
        for name in ('core', 'measure', 'assembly', 'entity', 'datum', 'io', 'feature'):
            exec(compile((ROOT / f'assets/cad/{name}.py').read_text(), name + '.py', 'exec'), ns)
    return ns


class DatumInput:
    def __init__(self):
        self.creationOccurrence = None

    def __getattr__(self, name):
        if name not in ('setByOffset', 'setByThreePoints', 'setByThreePlanes', 'setByTwoPoints'):
            raise AttributeError(name)

        def define(*args):
            self.definition = (name, args)
            return True

        return define


class Datums(Collection):
    def __init__(self, kind, owner):
        super().__init__()
        self.kind, self.owner = kind, owner

    def createInput(self):
        return DatumInput()

    def add(self, inp):
        entity = Entity(self.kind, self.kind + str(len(self.values)), parentComponent=self.owner)
        entity.input = inp
        self.values.append(entity)
        return entity


class SketchLines:
    def __init__(self, sketch):
        self.sketch = sketch
        self.lines = []

    def addByTwoPoints(self, start, end):
        line = Entity('SketchLine')
        line.parentSketch = self.sketch
        line.startSketchPoint = NS(geometry=start)
        line.endSketchPoint = NS(geometry=end)
        line.geometry = NS(objectType='adsk::core::Line3D', startPoint=start, endPoint=end,
                           direction=NS(x=end.x - start.x, y=end.y - start.y, z=end.z - start.z))
        self.lines.append(line)
        return line


class Sketches(Collection):
    def __init__(self, owner):
        super().__init__()
        self.owner = owner

    def addWithoutEdges(self, plane):
        sketch = Entity('Sketch', 'Sketch' + str(len(self.values)), parentComponent=self.owner)
        sketch.sketchCurves = NS(sketchLines=SketchLines(sketch))
        self.values.append(sketch)
        return sketch


class Occurrence(Entity):
    def __init__(self, ctx, component):
        super().__init__('Occurrence', component.name + ':1', component=component,
                         isReferencedComponent=False, isGrounded=False)
        self.ctx = ctx
        self._transform = Matrix()
        self.fullPathName = self.name

    @property
    def transform2(self):
        return self._transform

    @transform2.setter
    def transform2(self, value):
        self.ctx.trace.append('transform')
        self._transform = value
        self.ctx.design.snapshots.hasPendingSnapshot = True

    def moveToComponent(self, target):
        self.ctx.trace.append(('reparent', target))
        return self


class Occurrences(Collection):
    def __init__(self, ctx, owner=None):
        super().__init__()
        self.ctx = ctx
        self.owner = owner

    def addExistingComponent(self, component, matrix):
        self.ctx.trace.append('linked')
        occurrence = Occurrence(self.ctx, component)
        occurrence._transform = matrix
        self.values.append(occurrence)
        if self.owner is not None:
            parents = [p for p in self.ctx.root.allOccurrences.values if p.component == self.owner]
            for parent in parents:
                proxy = Occurrence(self.ctx, component)
                proxy.nativeObject = occurrence
                proxy.assemblyContext = parent
                proxy.fullPathName = parent.fullPathName + '+' + occurrence.name
                self.ctx.root.allOccurrences.values.append(proxy)
        return occurrence

    def addNewComponent(self, matrix):
        component = self.ctx.new_component('New')
        return self.addExistingComponent(component, matrix)

    def addNewComponentCopy(self, component, matrix):
        self.ctx.trace.append('independent')
        return self.addExistingComponent(self.ctx.new_component(component.name + ' copy'), matrix)


class JointInput:
    def __init__(self, one, two, geometry):
        self.one, self.two, self.geometry = one, two, geometry

    def motion(self, mode):
        self.mode = mode
        self.jointMotion = Entity(mode + 'JointMotion')
        for axis in (('rotation',) if mode == 'Revolute' else ('slide',) if mode == 'Slider' else
                     ('rotation', 'slide') if mode == 'Cylindrical' else ()):
            setattr(self.jointMotion, axis + 'Value', 0)
            setattr(self.jointMotion, axis + 'Limits', Limits())
        return True

    def setAsRigidJointMotion(self):
        return self.motion('Rigid')

    def setAsRevoluteJointMotion(self, axis, entity=None):
        self.axis, self.axisEntity = axis, entity
        return self.motion('Revolute')

    def setAsSliderJointMotion(self, axis, entity=None):
        self.axis, self.axisEntity = axis, entity
        return self.motion('Slider')

    def setAsCylindricalJointMotion(self, axis, entity=None):
        self.axis, self.axisEntity = axis, entity
        return self.motion('Cylindrical')


class JointOriginInput:
    def __init__(self, geometry):
        self.geometry = geometry
        self.zAxisEntity = None


class JointOrigin(Entity):
    def __init__(self, owner):
        super().__init__('JointOrigin', 'JointOrigin' + str(Entity.serial), parentComponent=owner)
        self.zAxisEntity = None

    def createForAssemblyContext(self, occurrence):
        return NS(origin=self, occurrence=occurrence, zAxisEntity=self.zAxisEntity,
                  xAxisEntity=getattr(self, 'xAxisEntity', None))


class JointOrigins(Collection):
    def __init__(self, owner):
        super().__init__()
        self.owner = owner

    def createInput(self, geometry):
        return JointOriginInput(geometry)

    def add(self, inp):
        origin = JointOrigin(self.owner)
        origin.zAxisEntity = inp.zAxisEntity
        origin.xAxisEntity = getattr(inp, 'xAxisEntity', None)
        self.values.append(origin)
        return origin


class Joints(Collection):
    def __init__(self, ctx):
        super().__init__()
        self.ctx = ctx

    def createInput(self, one, two):
        result = JointInput(one, two, None)
        self.ctx.last_regular_input = result
        return result

    def add(self, inp):
        self.ctx.trace.append(('joint', inp.mode, 'origins'))
        # Native add creates a separate motion and does not transfer input limits.
        created = JointInput(inp.one, inp.two, None)
        created.motion(inp.mode)
        joint = Entity('Joint', occurrenceOne=inp.one.occurrence, occurrenceTwo=inp.two.occurrence,
                       jointMotion=created.jointMotion, isSuppressed=False, parentComponent=self.ctx.root,
                       geometryOneTransform=Matrix(), geometryTwoTransform=Matrix(), healthState=0,
                       creationInput=inp)
        # Simulate Fusion orienting the motion axis along the pinned JointOrigin
        # Z axis. Fusion orients that Z axis OPPOSITE to the zAxisEntity sketch
        # line direction, so the read-back vector is -line.direction.
        line = getattr(inp.one, 'zAxisEntity', None)
        if line is not None and getattr(line, 'geometry', None) is not None:
            direction = line.geometry.direction
            vector = NS(x=-direction.x, y=-direction.y, z=-direction.z)
            if inp.mode == 'Revolute':
                joint.jointMotion.rotationAxisVector = vector
            elif inp.mode == 'Slider':
                joint.jointMotion.slideDirectionVector = vector
            elif inp.mode == 'Cylindrical':
                joint.jointMotion.rotationAxisVector = vector
                joint.jointMotion.slideDirectionVector = vector
        self.values.append(joint)
        for path, translation in getattr(self.ctx, 'joint_moves', {}).items():
            occurrence = next(o for o in self.ctx.root.allOccurrences.values if o.fullPathName == path)
            occurrence._transform.translation = NS(x=translation[0], y=translation[1], z=translation[2])
        return joint


class Limits:
    def __init__(self):
        self.minimumValue, self.maximumValue, self.restValue = -10, 10, 0
        self.isMinimumValueEnabled = self.isMaximumValueEnabled = True
        self.isRestValueEnabled = False
        self.writes = []
        self.fail = None
        self.persistent_failure = False

    def __setattr__(self, name, value):
        if 'writes' in self.__dict__ and name in (
                'minimumValue', 'maximumValue', 'restValue',
                'isMinimumValueEnabled', 'isMaximumValueEnabled', 'isRestValueEnabled'):
            self.writes.append((name, value))
            if self.fail == name:
                if not self.persistent_failure:
                    self.fail = None
                raise RuntimeError('injected setter failure')
        object.__setattr__(self, name, value)


class Context:
    def __init__(self):
        self.ns = namespace()
        self.trace, self.created, self.entities = [], [], {}
        self.design = NS(allComponents=Collection(), allParameters=Collection(), designType=1,
                         timeline=Collection())
        self.design.timeline.markerPosition = 0
        self.design.snapshots = NS(hasPendingSnapshot=False, add=self.snapshot)
        self.design.computeAll = self.compute
        self.root = self.component = self.new_component('Root')
        self.root.occurrences = Occurrences(self)
        self.root.allOccurrences = self.root.occurrences
        self.root.asBuiltJoints = Collection()
        self.root.asBuiltJoints.createInput, self.root.asBuiltJoints.add = JointInput, self.add_joint
        self.root.rigidGroups = NS(add=self.add_group)
        self.occurrence = None
        self.doc = NS(name='Assembly test', creationId='assembly-test', dataFile=None)
        self.entities['origin'] = Entity('ConstructionPoint', parentComponent=self.root)
        self.root.originConstructionPoint = self.entities['origin']
        for name in ('A', 'B'):
            component = self.new_component(name)
            self.entities[name] = component
            occurrence = self.root.occurrences.addExistingComponent(component, Matrix())
            self.entities[name + ':1'] = occurrence
        self.trace.clear()

    def new_component(self, name):
        component = Entity('Component', name, bRepBodies=Collection(), features=Collection(),
                           occurrences=Collection(), allOccurrences=Collection(),
                           constructionPlanes=Datums('ConstructionPlane', None),
                           constructionAxes=Datums('ConstructionAxis', None),
                           constructionPoints=Datums('ConstructionPoint', None),
                           sketches=Sketches(None))
        component.constructionPlanes.owner = component
        component.constructionAxes.owner = component
        component.constructionPoints.owner = component
        component.sketches.owner = component
        component.jointOrigins = JointOrigins(component)
        component.joints = Joints(self)
        for plane_name, normal in (('xYConstructionPlane', (0, 0, 1)), ('xZConstructionPlane', (0, -1, 0)),
                                   ('yZConstructionPlane', (1, 0, 0))):
            plane = Entity('ConstructionPlane', plane_name, parentComponent=component)
            plane.geometry = NS(objectType='adsk::core::Plane',
                                origin=NS(x=0, y=0, z=0), normal=NS(**dict(zip(('x', 'y', 'z'), normal))))
            setattr(component, plane_name, plane)
        self.design.allComponents.values.append(component)
        return component

    def snapshot(self):
        self.trace.append('snapshot')
        self.design.snapshots.hasPendingSnapshot = False
        return Entity('Snapshot')

    def compute(self):
        self.trace.append('compute')
        return True

    def add_joint(self, inp):
        self.trace.append(('joint', inp.mode, inp.geometry))
        # Native add creates a separate motion and does not transfer input numeric limits.
        created = JointInput(inp.one, inp.two, inp.geometry)
        created.motion(inp.mode)
        geometry = None if inp.geometry is None else NS(origin=NS(x=0, y=0, z=0),
            primaryAxisVector=NS(x=0, y=0, z=1), secondaryAxisVector=NS(x=1, y=0, z=0), thirdAxisVector=NS(x=0, y=1, z=0))
        joint = Entity('AsBuiltJoint', occurrenceOne=inp.one, occurrenceTwo=inp.two, geometry=geometry,
                       jointMotion=created.jointMotion, isSuppressed=False, parentComponent=self.root)
        joint.timelineObject = NS(rollTo=lambda before: True)
        self.root.asBuiltJoints.values.append(joint)
        return joint

    def assert_identity(self):
        pass

    def _scope(self, data):
        return self.ns['CadContext']._scope(self, data)

    def add_group(self, occurrences, include_children):
        self.trace.append(('group', occurrences, include_children))
        return Entity('RigidGroup')

    def resolve(self, ref, kind=None):
        key = ref if isinstance(ref, str) else ref.get('token', ref.get('name'))
        entity = self.root if key == 'root' else self.entities.get(key)
        if entity is None or isinstance(entity, list):
            raise ValueError('missing or ambiguous reference')
        if kind and self.ns['_cad_kind'](entity) != kind:
            raise ValueError('wrong entity kind')
        return entity

    def ref(self, entity):
        self.entities[entity.entityToken] = entity
        return {'token': entity.entityToken, 'kind': self.ns['_cad_kind'](entity), 'name': entity.name}

    def _proxy(self, entity, occurrence):
        return entity

    def value(self, expression):
        cleaned = expression.replace('(', '').replace(')', '')
        if cleaned.startswith('--'):
            cleaned = cleaned[2:]
        self._expression(cleaned, 'cm')
        return expression

    def describe(self, entity):
        return dict(self.ref(entity), isSuppressed=getattr(entity, 'isSuppressed', None))

    def _expression(self, expression, units, unitless=False):
        if not isinstance(expression, str):
            raise ValueError('expression required')
        if unitless:
            return expression, float(expression)
        number, unit = expression.split()
        factors = {'cm': {'mm': .1, 'cm': 1}, 'rad': {'deg': math.pi / 180, 'rad': 1}}
        if unit not in factors[units]:
            raise ValueError('incompatible units')
        return expression, float(number) * factors[units][unit]

    def length(self, expression):
        return self._expression(expression, 'cm')[1]

    def angle(self, expression):
        return self._expression(expression, 'rad')[1]

    def point(self, values):
        if not isinstance(values, list) or len(values) != 3:
            raise ValueError('three expressions required')
        return NS(**dict(zip(('x', 'y', 'z'), map(self.length, values))))

    def collection(self, entities):
        return Collection(entities)

    def require_confirm(self, data):
        if data.get('confirm') is not True:
            raise ValueError('confirmation required')

    def call(self, op, data):
        return self.ns['CAD_HANDLERS'][op](self, data)


class AssemblyTests(unittest.TestCase):
    def setUp(self):
        self.ctx = Context()

    def test_catalog_and_compilation(self):
        catalog = json.loads((ROOT / 'src/catalog/assembly.json').read_text())
        handlers = self.ctx.ns['CAD_HANDLERS']
        self.assertEqual(len(catalog), 28)
        for op, entry in catalog.items():
            self.assertIn(op, handlers)
            self.assertEqual(set(entry), {'summary', 'required', 'example', 'readOnly', 'limitations', 'inputs'})
            self.assertTrue(set(entry['required']) <= entry['example'].keys())
            self.assertTrue(set(entry['example']) <= entry['inputs'].keys())
        compile((ROOT / 'assets/cad/assembly.py').read_text(), 'assembly.py', 'exec')

    def test_create_inspect_rename_parts(self):
        result = self.ctx.call('component.create', {'name': 'C'})
        component = self.ctx.resolve(result['component'])
        self.assertIn(result['component'], self.ctx.created)
        self.ctx.call('component.rename', {'component': result['component'], 'name': 'Renamed'})
        self.assertEqual(component.name, 'Renamed')
        self.assertEqual(self.ctx.call('component.inspect', {'component': result['component']})['bodies'], [])
        self.assertEqual(len(self.ctx.call('assembly.parts', {})['parts']), 3)

    def test_explicit_copy_modes(self):
        for mode in ('linked', 'independent'):
            result = self.ctx.call('occurrence.duplicate', {'occurrence': 'A:1', 'copyMode': mode})
            component = self.ctx.resolve(result['component'])
            self.assertEqual(component == self.ctx.entities['A'], mode == 'linked')
        self.assertIn('independent', self.ctx.trace)
        self.ctx.call('occurrence.add', {'component': 'B', 'copyMode': 'linked'})

    def test_invalid_copy_preflight(self):
        for data in ({'component': 'A'}, {'component': 'A', 'copyMode': 'maybe'},
                     {'component': 'A', 'copyMode': 'linked', 'name': 'Oops'},
                     {'component': 'root', 'copyMode': 'linked'},
                     {'component': 'A', 'copyMode': 'independent', 'placement': {'axis': [0, 0, 0], 'angle': '5 deg'}}):
            with self.assertRaises(ValueError):
                self.ctx.call('occurrence.add', data)
        self.assertEqual(self.ctx.trace, [])

    def test_nested_copy_requires_explicit_space_and_policy_before_mutation(self):
        parent = self.ctx.entities['A:1']
        repeated_parent = Occurrence(self.ctx, self.ctx.entities['A'])
        repeated_parent.fullPathName = 'A:2'
        self.ctx.root.allOccurrences.values.append(repeated_parent)
        nested = Occurrence(self.ctx, self.ctx.entities['B'])
        nested.fullPathName = parent.fullPathName + '+B:1'
        nested.assemblyContext = parent
        parent.component.occurrences.values.append(nested)
        self.ctx.root.allOccurrences.values.append(nested)
        parent.component.occurrences = Occurrences(self.ctx, parent.component)
        with self.assertRaisesRegex(ValueError, 'placementSpace'):
            self.ctx.call('occurrence.add', {'component': 'B', 'copyMode': 'linked',
                                             'destination': 'A:1', 'placement': {}})
        with self.assertRaisesRegex(ValueError, 'allInstances'):
            self.ctx.call('occurrence.add', {'component': 'B', 'copyMode': 'linked',
                                             'destination': 'A:1', 'placementSpace': 'parent',
                                             'placement': {}})
        self.assertEqual(self.ctx.trace, [])

    def test_placement_space_is_rejected_without_nested_placement(self):
        with self.assertRaisesRegex(ValueError, 'only valid'):
            self.ctx.call('occurrence.add', {'component': 'B', 'copyMode': 'linked',
                                             'placementSpace': 'parent'})
        with self.assertRaisesRegex(ValueError, 'root or parent'):
            self.ctx.call('occurrence.add', {'component': 'B', 'copyMode': 'linked',
                                             'destination': 'A:1', 'placement': {}})
        self.assertEqual(self.ctx.trace, [])

    def test_invalid_nested_policy_and_space_options_reject_early(self):
        for data in (
                {'component': 'B', 'copyMode': 'linked', 'sharedParentPolicy': 'clone'},
                {'component': 'B', 'copyMode': 'linked', 'placementSpace': 'world'},
                {'occurrence': 'A:1', 'target': 'B:1', 'confirm': True, 'sharedParentPolicy': 'error'}):
            operation = 'component.reparent' if 'target' in data else 'occurrence.add'
            with self.subTest(data=data), self.assertRaisesRegex(ValueError, 'must be'):
                self.ctx.call(operation, data)
        self.assertEqual(self.ctx.trace, [])

    def test_external_component_and_occurrence_refs_reject_before_add_or_duplicate(self):
        external_component = self.ctx.new_component('ExternalDefinition')
        external_occurrence = Occurrence(self.ctx, external_component)
        external_occurrence.name = 'ExternalDefinition:1'
        external_occurrence.fullPathName = external_occurrence.name
        external_occurrence.isReferencedComponent = True
        self.ctx.root.occurrences.values.append(external_occurrence)
        external_component_ref = self.ctx.ref(external_component)
        external_occurrence_ref = self.ctx.ref(external_occurrence)
        for operation, data in (
                ('occurrence.add', {'component': external_component_ref, 'copyMode': 'linked'}),
                ('occurrence.duplicate', {'occurrence': external_occurrence_ref, 'copyMode': 'linked'})):
            with self.subTest(operation=operation), self.assertRaisesRegex(ValueError, 'External'):
                self.ctx.call(operation, data)
        self.assertEqual(self.ctx.trace, [])

    def test_root_destination_and_legacy_add_keep_root_semantics(self):
        result = self.ctx.call('occurrence.add', {'component': 'B', 'copyMode': 'linked',
                                                 'destination': 'root'})
        self.assertEqual(result['copyMode'], 'linked')
        self.assertEqual(self.ctx.trace, ['linked'])

    def test_nested_linked_add_uses_selected_parent_collection(self):
        parent = self.ctx.entities['A:1']
        parent.component.occurrences = Occurrences(self.ctx, parent.component)
        result = self.ctx.call('occurrence.add', {'component': 'B', 'copyMode': 'linked',
                                                 'destination': parent.fullPathName,
                                                 'placementSpace': 'parent', 'placement': {}})
        self.assertEqual(self.ctx.trace, ['linked'])
        self.assertEqual(result['component'], self.ctx.ref(self.ctx.entities['B']))

    def test_destination_cycle_and_ambiguous_nested_context_reject_before_mutation(self):
        parent = self.ctx.entities['A:1']
        with self.assertRaisesRegex(ValueError, 'cycle'):
            self.ctx.call('occurrence.add', {'component': 'A', 'copyMode': 'linked',
                                             'destination': parent.fullPathName})
        proxy = Occurrence(self.ctx, self.ctx.entities['B'])
        proxy.fullPathName = 'A:1+B:1'
        proxy.assemblyContext = parent
        self.ctx.entities['nested-proxy'] = proxy
        duplicate = Occurrence(self.ctx, self.ctx.entities['B'])
        duplicate.fullPathName = proxy.fullPathName
        self.ctx.root.allOccurrences.values.extend([proxy, duplicate])
        with self.assertRaisesRegex(ValueError, 'expected one match'):
            self.ctx.call('occurrence.add', {'component': 'B', 'copyMode': 'linked',
                                             'destination': 'nested-proxy'})
        self.assertEqual(self.ctx.trace, [])

    def test_explicit_root_context_proxy_is_resolved_by_exact_path(self):
        parent = self.ctx.entities['A:1']
        proxy = Occurrence(self.ctx, self.ctx.entities['A'])
        proxy.fullPathName = parent.fullPathName + '+B:1'
        proxy.assemblyContext = parent
        self.ctx.root.allOccurrences.values.append(proxy)
        self.ctx.entities['root-proxy'] = proxy
        self.assertIs(self.ctx.ns['_assembly_root_occurrence'](self.ctx, 'root-proxy'), proxy)

    def test_nested_duplicate_converts_world_pose_to_parent_local(self):
        parent = self.ctx.entities['A:1']
        parent.transform2.setWithArray([1, 0, 0, 2, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
        parent.component.occurrences = Occurrences(self.ctx, parent.component)
        source = self.ctx.entities['B:1']
        source.transform2.setWithArray([1, 0, 0, 5, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
        result = self.ctx.call('occurrence.duplicate', {'occurrence': 'B:1', 'copyMode': 'linked',
                                                       'destination': parent.fullPathName})
        self.assertEqual(result['copyMode'], 'linked')
        inserted = parent.component.occurrences.values[-1]
        self.assertEqual(inserted.transform2.asArray()[3], 3)

    def test_reparent_repeated_target_requires_all_instances(self):
        target = Occurrence(self.ctx, self.ctx.entities['B'])
        target.fullPathName = 'B:2'
        self.ctx.root.allOccurrences.values.append(target)
        with self.assertRaisesRegex(ValueError, 'allInstances'):
            self.ctx.call('component.reparent', {'occurrence': 'A:1', 'target': 'B:1', 'confirm': True})
        self.assertEqual(self.ctx.trace, [])

    def test_reparent_all_instances_reports_every_predicted_path(self):
        target = Occurrence(self.ctx, self.ctx.entities['B'])
        target.fullPathName = 'B:2'
        self.ctx.root.allOccurrences.values.append(target)
        result = self.ctx.call('component.reparent', {'occurrence': 'A:1', 'target': 'B:1',
                                                      'confirm': True,
                                                      'sharedParentPolicy': 'allInstances'})
        self.assertEqual(result['affectedPaths'], ['B:1+A:1', 'B:2+A:1'])

    def test_reparent_pose_readback_detects_unknown_effect(self):
        occurrence = self.ctx.entities['A:1']
        occurrence.transform2.translation = NS(x=0, y=0, z=0)
        occurrence.moveToComponent = lambda target: setattr(occurrence.transform2.translation, 'x', 9) or occurrence
        with self.assertRaisesRegex(RuntimeError, 'world pose readback'):
            self.ctx.call('component.reparent', {'occurrence': 'A:1', 'target': 'B:1', 'confirm': True})

    def test_transform_capture_and_align(self):
        result = self.ctx.call('occurrence.transform', {'occurrence': 'A:1', 'placement': {
            'translation': ['10 mm', '0 mm', '0 mm'], 'axis': [0, 0, 1], 'angle': '90 deg'}})
        self.assertEqual(self.ctx.trace, ['transform', 'snapshot'])
        self.assertIsNotNone(result['snapshot'])
        self.assertFalse(result['parametricExpressions'])
        self.assertEqual(self.ctx.entities['A:1'].transform2.translation.x, 1)
        self.ctx.call('occurrence.align', {'occurrence': 'B:1', 'target': 'A:1'})
        self.assertEqual(self.ctx.entities['B:1'].transform2.translation.x, 1)

    def test_pending_transform_is_not_captured(self):
        self.ctx.design.snapshots.hasPendingSnapshot = True
        with self.assertRaisesRegex(ValueError, 'pending'):
            self.ctx.call('occurrence.transform', {'occurrence': 'A:1', 'placement': {}})
        self.assertEqual(self.ctx.trace, [])

    def test_direct_transform_does_not_capture(self):
        self.ctx.design.designType = 0
        self.ctx.call('occurrence.transform', {'occurrence': 'A:1', 'placement': {}})
        self.assertEqual(self.ctx.trace, ['transform'])

    def test_grounded_external_nested_ambiguous_rejected(self):
        occurrence = self.ctx.entities['A:1']
        for prop in ('isGrounded', 'isReferencedComponent'):
            setattr(occurrence, prop, True)
            with self.assertRaises(ValueError):
                self.ctx.call('occurrence.transform', {'occurrence': 'A:1', 'placement': {}})
            setattr(occurrence, prop, False)
        self.ctx.entities['ambiguous'] = [occurrence, self.ctx.entities['B:1']]
        self.ctx.entities['nested'] = Occurrence(self.ctx, self.ctx.entities['A'])
        for ref in ('ambiguous', 'nested'):
            with self.assertRaises(ValueError):
                self.ctx.call('assembly.ground', {'occurrence': ref})
        self.assertEqual(self.ctx.trace, [])

    def test_reparent_cycle_and_success(self):
        with self.assertRaises(ValueError):
            self.ctx.call('component.reparent', {'occurrence': 'A:1', 'target': 'A:1', 'confirm': True})
        self.assertEqual(self.ctx.trace, [])
        self.ctx.call('component.reparent', {'occurrence': 'A:1', 'target': 'B:1', 'confirm': True})
        self.assertEqual(self.ctx.trace[0][0], 'reparent')

    def test_from_bodies_preflight_and_move(self):
        body = Entity('BRepBody', parentComponent=self.ctx.root)
        body.moveToComponent = lambda target: self.ctx.trace.append('moveBody') or body
        ref = self.ctx.ref(body)
        with self.assertRaises(ValueError):
            self.ctx.call('component.from_bodies', {'name': 'C', 'bodies': [ref, ref], 'confirm': True})
        self.assertEqual(self.ctx.trace, [])
        result = self.ctx.call('component.from_bodies', {'name': 'C', 'bodies': [ref], 'confirm': True})
        self.assertEqual(result['bodies'], [ref])
        self.assertIn('moveBody', self.ctx.trace)

    def test_real_joint_modes(self):
        for mode in ('rigid', 'revolute', 'slider', 'cylindrical'):
            data = {'name': mode, 'occurrenceOne': 'A:1', 'occurrenceTwo': 'B:1'}
            if mode != 'rigid':
                data.update(point='origin', axis='Z')
            result = self.ctx.call('joint.' + mode, data)
            joint = self.ctx.resolve(result['joint'])
            self.assertEqual(joint.jointMotion.objectType, 'adsk::fusion::' + mode.capitalize() + 'JointMotion')
            self.assertTrue(result['asBuilt'])
            inspected = self.ctx.call('joint.inspect', {'joint': result['joint']})
            self.assertEqual(len(inspected['occurrences']), 2)
            self.assertEqual(inspected['joint']['kind'], 'AsBuiltJoint')
            self.assertEqual(inspected['motionType'], mode.capitalize() + 'JointMotion')
            self.assertEqual(inspected['units'], 'cm/rad')
            if mode == 'revolute':
                self.assertEqual(inspected['rotationValue'], 0)

    def _regular_joint_data(self, name='Regular', pose_policy='preserve', origin_mode='ref'):
        refs = []
        for component_name, suffix in (('A', 'one'), ('B', 'two')):
            component = self.ctx.entities[component_name]
            if origin_mode == 'ref':
                origin = JointOrigin(component)
                component.jointOrigins.values.append(origin)
                refs.append({'ref': self.ctx.ref(origin)})
            else:
                point = Entity('ConstructionPoint', suffix + '_point', parentComponent=component)
                x_axis = Entity('ConstructionAxis', suffix + '_x', parentComponent=component)
                z_axis = Entity('ConstructionAxis', suffix + '_z', parentComponent=component)
                for key, value in ((suffix + '_point', point), (suffix + '_x', x_axis), (suffix + '_z', z_axis)):
                    self.ctx.entities[key] = value
                refs.append({'point': suffix + '_point', 'xAxis': suffix + '_x', 'zAxis': suffix + '_z'})
        return {'name': name, 'mode': 'regular', 'occurrenceOne': 'A:1', 'occurrenceTwo': 'B:1',
                'confirm': True, 'originOne': refs[0], 'originTwo': refs[1], 'posePolicy': pose_policy,
                'linearTolerance': '0.01 mm', 'angularTolerance': '0.01 deg'}

    def test_regular_joint_reference_origins_and_asbuilt_legacy(self):
        before = {o.fullPathName: list(o.transform2.asArray()) for o in self.ctx.root.allOccurrences.values}
        data = self._regular_joint_data()
        data.update(angle='90 deg', offset='2 mm', isFlipped=True)
        result = self.ctx.call('joint.rigid', data)
        self.assertFalse(result['asBuilt'])
        self.assertEqual(result['mode'], 'regular')
        self.assertEqual(result['type'], 'rigid')
        self.assertEqual(result['posePolicy'], 'preserve')
        self.assertEqual(result['requested'], {'angle': '90 deg', 'offset': '2 mm', 'isFlipped': True})
        joint = self.ctx.resolve(result['joint'])
        self.assertEqual(joint.creationInput.angle, ('value', '90 deg'))
        self.assertEqual(joint.creationInput.offset, ('value', '2 mm'))
        self.assertTrue(joint.creationInput.isFlipped)
        after = {o.fullPathName: list(o.transform2.asArray()) for o in self.ctx.root.allOccurrences.values}
        self.assertEqual(after, before)
        legacy = self.ctx.call('joint.rigid', {'name': 'AsBuiltDefault', 'occurrenceOne': 'A:1', 'occurrenceTwo': 'B:1'})
        explicit = self.ctx.call('joint.rigid', {'name': 'AsBuiltExplicit', 'mode': 'asBuilt',
            'occurrenceOne': 'A:1', 'occurrenceTwo': 'B:1'})
        self.assertTrue(legacy['asBuilt'])
        self.assertTrue(explicit['asBuilt'])
        self.assertEqual(len(self.ctx.root.asBuiltJoints.values), 2)
        defaults = self.ctx.call('joint.rigid', self._regular_joint_data('RegularDefaults'))
        self.assertEqual(defaults['requested'], {'angle': '0 deg', 'offset': '0 mm', 'isFlipped': False})

    def test_regular_joint_native_geometry_origins_and_move_second_subtree(self):
        child_component = self.ctx.new_component('Child')
        nested = Occurrence(self.ctx, child_component)
        nested.fullPathName = 'B:1+Child:1'
        self.ctx.root.allOccurrences.values.append(nested)
        self.ctx.joint_moves = {'B:1': (1.0, 0.0, 0.0), 'B:1+Child:1': (1.0, 0.0, 0.0)}
        data = self._regular_joint_data('MoveB', 'moveSecond', 'tuple')
        data.update(angle='45 deg', offset='3 mm', isFlipped=False)
        result = self.ctx.call('joint.rigid', data)
        self.assertFalse(result['asBuilt'])
        self.assertEqual([o['name'] for o in result['requestedOccurrences']], ['A:1', 'B:1'])
        self.assertEqual(self.ctx.entities['A:1'].transform2.asArray()[3], 0)
        self.assertEqual(self.ctx.entities['B:1'].transform2.asArray()[3], 1)
        self.assertEqual(nested.transform2.asArray()[3], 1)
        self.assertEqual(result['poses'][-1]['path'], 'B:1+Child:1')
        self.assertTrue(result['poses'][-1]['allowedMove'])
        self.assertEqual(len(self.ctx.entities['A'].jointOrigins.values), 1)
        self.assertEqual(len(self.ctx.entities['B'].jointOrigins.values), 1)

    def test_regular_joint_three_angle_offset_flip_variants(self):
        cases = (('preserve', '0 deg', '0 mm', False),
                 ('preserve', '25 deg', '1 mm', True),
                 ('moveSecond', '-15 deg', '-2 mm', False))
        for index, (policy, angle, offset, flipped) in enumerate(cases):
            with self.subTest(index=index, policy=policy, angle=angle, offset=offset, flipped=flipped):
                self.ctx = Context()
                if policy == 'moveSecond':
                    self.ctx.joint_moves = {'B:1': (0.25, 0.0, 0.0)}
                data = self._regular_joint_data('Variant' + str(index), policy)
                data.update(angle=angle, offset=offset, isFlipped=flipped)
                result = self.ctx.call('joint.rigid', data)
                self.assertEqual(result['requested'], {'angle': angle, 'offset': offset, 'isFlipped': flipped})
                self.assertEqual(result['posePolicy'], policy)
                self.assertFalse(result['asBuilt'])
                if policy == 'moveSecond':
                    self.assertEqual(self.ctx.entities['A:1'].transform2.asArray()[3], 0)
                    self.assertEqual(self.ctx.entities['B:1'].transform2.asArray()[3], .25)

    def test_regular_joint_pose_policy_rejects_non_subtree_motion(self):
        self.ctx.joint_moves = {'A:1': (1.0, 0.0, 0.0)}
        with self.assertRaisesRegex(RuntimeError, 'pose policy was violated'):
            self.ctx.call('joint.rigid', self._regular_joint_data('BadMove', 'moveSecond'))
        self.assertEqual(len(self.ctx.root.joints.values), 1)
        self.assertEqual(len(self.ctx.root.asBuiltJoints.values), 0)

    def test_regular_joint_preflight_guards_before_origin_or_joint_creation(self):
        base = self._regular_joint_data()
        origin_counts = (len(self.ctx.entities['A'].jointOrigins.values),
                         len(self.ctx.entities['B'].jointOrigins.values))
        cases = []
        for update in ({'confirm': False}, {'groundingPolicy': 'unground'},
                       {'posePolicy': 'move'}, {'linearTolerance': '0 mm'},
                       {'angularTolerance': '-1 deg'}, {'rotationAxisVector': [0, 0, 1]}):
            cases.append(dict(base, **update))
        for data in cases:
            with self.subTest(data=data), self.assertRaises((ValueError, TypeError)):
                self.ctx.call('joint.rigid', data)
        self.ctx.entities['B:1'].isGroundToParent = True
        with self.assertRaisesRegex(ValueError, 'rejects grounded'):
            self.ctx.call('joint.rigid', dict(base, name='GroundReject'))
        self.ctx.entities['B:1'].isGroundToParent = False
        self.ctx.entities['ambiguous-occurrence'] = [self.ctx.entities['A:1'], self.ctx.entities['B:1']]
        with self.assertRaises(ValueError):
            self.ctx.call('joint.rigid', dict(base, occurrenceOne='ambiguous-occurrence', name='Ambiguous'))
        self.ctx.entities['nested'] = Occurrence(self.ctx, self.ctx.entities['A'])
        self.ctx.entities['nested'].fullPathName = 'A:1+Child:1'
        self.ctx.root.allOccurrences.values.append(self.ctx.entities['nested'])
        with self.assertRaisesRegex(ValueError, 'ancestor'):
            self.ctx.call('joint.rigid', dict(base, occurrenceTwo='nested', name='Ancestor'))
        existing = Entity('AsBuiltJoint', 'AlreadyThere', parentComponent=self.ctx.root)
        self.ctx.root.asBuiltJoints.values.append(existing)
        with self.assertRaisesRegex(ValueError, 'name already exists'):
            self.ctx.call('joint.rigid', dict(base, name='AlreadyThere'))
        foreign = Entity('ConstructionPoint', 'foreign', parentComponent=self.ctx.root)
        self.ctx.entities['foreign'] = foreign
        wrong_scope = dict(self._regular_joint_data('WrongScope', 'preserve', 'tuple'), originOne={
            'point': 'foreign', 'xAxis': 'one_x', 'zAxis': 'one_z'})
        with self.assertRaisesRegex(ValueError, 'matching input component'):
            self.ctx.call('joint.rigid', wrong_scope)
        self.assertEqual(len(self.ctx.root.joints.values), 0)
        self.assertEqual((len(self.ctx.entities['A'].jointOrigins.values),
                          len(self.ctx.entities['B'].jointOrigins.values)), origin_counts)

    def test_joint_invalid_before_add(self):
        for data in ({'name': 'J', 'occurrenceOne': 'A:1', 'occurrenceTwo': 'A:1', 'point': 'origin', 'axis': 'Z'},
                     {'name': 'J', 'occurrenceOne': 'A:1', 'occurrenceTwo': 'B:1', 'point': 'origin', 'axis': 'bad'}):
            with self.assertRaises(ValueError):
                self.ctx.call('joint.revolute', data)
        self.assertEqual(self.ctx.trace, [])

    def test_api_failures_propagate(self):
        self.ctx.root.asBuiltJoints.add = lambda inp: None
        with self.assertRaisesRegex(RuntimeError, 'Create as-built joint'):
            self.ctx.call('joint.rigid', {'name': 'J', 'occurrenceOne': 'A:1', 'occurrenceTwo': 'B:1'})
        self.ctx.design.computeAll = lambda: False
        with self.assertRaisesRegex(RuntimeError, 'Recompute design'):
            self.ctx.call('history.recompute', {})
        self.ctx.design.snapshots.add = lambda: None
        with self.assertRaisesRegex(RuntimeError, 'Capture assembly position'):
            self.ctx.call('occurrence.transform', {'occurrence': 'A:1', 'placement': {}})
        self.assertTrue(self.ctx.design.snapshots.hasPendingSnapshot)

    def test_joint_drive_edit_and_limits(self):
        ref = self.ctx.call('joint.cylindrical', {'name': 'J', 'occurrenceOne': 'A:1',
            'occurrenceTwo': 'B:1', 'point': 'origin', 'axis': 'Z'})['joint']
        joint = self.ctx.resolve(ref)
        with self.assertRaises(ValueError):
            self.ctx.call('joint.drive', {'joint': ref, 'rotation': '1 deg', 'slide': '1000 mm'})
        self.assertEqual(joint.jointMotion.rotationValue, 0)
        result = self.ctx.call('joint.drive', {'joint': ref, 'rotation': '90 deg', 'slide': '5 mm'})
        self.assertAlmostEqual(result['rotationValue'], math.pi / 2)
        self.assertEqual(result['slideValue'], .5)
        self.ctx.call('joint.edit', {'joint': ref, 'name': 'Driven', 'suppressed': True})
        self.assertEqual(joint.name, 'Driven')
        self.assertTrue(joint.isSuppressed)

    def test_joint_drive_reports_evaluated_setter_and_post_capture_values_separately(self):
        ref = self.joint('revolute')
        motion = self.ctx.resolve(ref).jointMotion

        def quantizing_capture(unused_ctx, unused_parametric):
            motion.rotationValue = math.radians(round(math.degrees(motion.rotationValue), 1))
            return None

        self.ctx.ns['_assembly_capture'] = quantizing_capture
        result = self.ctx.call('joint.drive', {'joint': ref, 'rotation': '0.05 rad'})
        evidence = result['coordinateReadback']
        self.assertEqual(evidence['evaluated']['rotationValue'], .05)
        self.assertEqual(evidence['beforeCapture']['rotationValue'], .05)
        self.assertAlmostEqual(result['rotationValue'], math.radians(2.9))
        self.assertNotEqual(evidence['beforeCapture']['rotationValue'], result['rotationValue'])
        self.assertFalse(result['parametricExpressions'])

    def test_ground_and_group(self):
        for op, value in (('ground', True), ('unground', False)):
            self.assertEqual(self.ctx.call('assembly.' + op, {'occurrence': 'A:1'})['grounded'], value)
        with self.assertRaises(ValueError):
            self.ctx.call('assembly.rigid_group', {'occurrences': ['A:1', 'A:1']})
        self.ctx.call('assembly.rigid_group', {'occurrences': ['A:1', 'B:1'], 'includeChildren': True})
        self.assertTrue(self.ctx.trace[-1][2])

    def joint(self, mode='cylindrical', **extra):
        data = dict(name='J' + str(self.ctx.root.asBuiltJoints.count), occurrenceOne='A:1', occurrenceTwo='B:1')
        if mode != 'rigid':
            data.update(point='origin', axis='Z')
        return self.ctx.call('joint.' + mode, dict(data, **extra))['joint']

    def test_limits_readonly_and_creation(self):
        for mode, axis, unit in (('revolute', 'rotation', 'deg'), ('slider', 'slide', 'mm'),
                                 ('cylindrical', 'slide', 'mm')):
            ref = self.joint(mode, confirm=True, limits={axis: {
                'minimumValue': '0 ' + unit, 'maximumValue': '90 ' + unit,
                'restValue': '20 ' + unit, 'isRestValueEnabled': True}})
            motion = self.ctx.resolve(ref).jointMotion
            limits = getattr(motion, axis + 'Limits')
            limits.writes.clear()
            self.ctx.trace.clear()
            self.ctx.design.snapshots.hasPendingSnapshot = True
            result = self.ctx.call('joint.inspect', {'joint': ref})
            self.assertEqual(result['limits'][axis]['maximumValue'], getattr(limits, 'maximumValue'))
            self.assertTrue(result['limits'][axis]['isRestValueEnabled'])
            self.assertEqual(result['limits'][axis]['units'], 'rad' if axis == 'rotation' else 'cm')
            self.assertFalse(result['parametricExpressions'])
            self.assertEqual(limits.writes, [])
            self.assertEqual(self.ctx.trace, [])
            self.ctx.design.snapshots.hasPendingSnapshot = False

    def test_limit_changes_drive_uses_actual_limits(self):
        ref = self.joint()
        result = self.ctx.call('joint.limits', {'joint': ref, 'confirm': True, 'limits': {
            'rotation': {'minimumValue': '-30 deg', 'maximumValue': '30 deg'},
            'slide': {'minimumValue': '0 mm', 'maximumValue': '20 mm', 'restValue': '5 mm',
                      'isRestValueEnabled': True}}})
        self.assertAlmostEqual(result['limits']['rotation']['maximumValue'], math.pi / 6)
        moved = self.ctx.call('joint.drive', {'joint': ref, 'rotation': '20 deg', 'slide': '10 mm'})
        self.assertAlmostEqual(moved['rotationValue'], math.pi / 9)
        self.assertEqual(moved['slideValue'], 1)
        for values in ({'rotation': '31 deg'}, {'rotation': '0 deg', 'slide': '21 mm'},
                       {'slide': '-1 mm'}, {'rotation': 'nan deg'}):
            with self.assertRaises(ValueError):
                self.ctx.call('joint.drive', dict(joint=ref, **values))
        self.assertEqual(self.ctx.call('joint.inspect', {'joint': ref})['slideValue'], 1)
        self.assertAlmostEqual(self.ctx.resolve(ref).jointMotion.rotationValue, math.pi / 9)
        result = self.ctx.call('joint.limits', {'joint': ref, 'confirm': True, 'limits': {
            'slide': {'isMaximumValueEnabled': False, 'isRestValueEnabled': False}}})
        self.assertFalse(result['limits']['slide']['isMaximumValueEnabled'])
        self.assertEqual(result['limits']['slide']['maximumValue'], 2)
        self.assertEqual(self.ctx.call('joint.drive', {'joint': ref, 'slide': '21 mm'})['slideValue'], 2.1)

    def test_limits_all_prevalidated(self):
        ref = self.joint()
        motion = self.ctx.resolve(ref).jointMotion
        invalid = [None, {}, {'other': {}}, {'rotation': {}}, {'rotation': {'unknown': True}},
                   {'rotation': {'maximumValue': 'nan deg'}}, {'slide': {'maximumValue': 'inf mm'}},
                   {'slide': {'minimumValue': '20 cm'}}, {'slide': {'restValue': '11 cm'}},
                   {'rotation': {'minimumValue': 2}}, {'slide': {'maximumValue': '2 deg'}},
                   {'slide': {'maximumValue': '2'}}, {'slide': {'isRestValueEnabled': 1}},
                   {'rotation': {'maximumValue': '30 deg'}, 'slide': {'minimumValue': '20 cm'}}]
        for limits in invalid:
            with self.subTest(limits=limits), self.assertRaises((ValueError, TypeError)):
                self.ctx.call('joint.limits', {'joint': ref, 'confirm': True, 'limits': limits})
        for confirm in (None, False, 1):
            with self.assertRaises(ValueError):
                self.ctx.call('joint.limits', {'joint': ref, 'confirm': confirm,
                                             'limits': {'slide': {'maximumValue': '20 mm'}}})
        self.ctx.design.snapshots.hasPendingSnapshot = True
        with self.assertRaisesRegex(ValueError, 'pending'):
            self.ctx.call('joint.limits', {'joint': ref, 'confirm': True,
                                         'limits': {'slide': {'maximumValue': '20 mm'}}})
        self.assertEqual(motion.rotationLimits.writes, [])
        self.assertEqual(motion.slideLimits.writes, [])

    def test_irrelevant_limits_and_creation_preflight(self):
        for mode, axis in (('revolute', 'slide'), ('slider', 'rotation'), ('rigid', 'rotation')):
            ref = self.joint(mode)
            with self.assertRaises(ValueError):
                self.ctx.call('joint.limits', {'joint': ref, 'confirm': True,
                                             'limits': {axis: {'isMinimumValueEnabled': False}}})
            self.ctx.trace.clear()
            with self.assertRaises(ValueError):
                self.joint(mode, confirm=True, limits={axis: {'isMinimumValueEnabled': False}})
            self.assertEqual(self.ctx.trace, [])
        with self.assertRaises(ValueError):
            self.joint('revolute', limits={'rotation': {'maximumValue': '30 deg'}})

    def test_limits_rollback_both_axes_and_flags(self):
        ref = self.joint()
        motion = self.ctx.resolve(ref).jointMotion
        motion.rotationLimits.isMinimumValueEnabled = False
        motion.slideLimits.isRestValueEnabled = True
        before = self.ctx.call('joint.inspect', {'joint': ref})['limits']
        motion.slideLimits.fail = 'maximumValue'
        with self.assertRaises(RuntimeError) as caught:
            self.ctx.call('joint.limits', {'joint': ref, 'confirm': True, 'limits': {
                'rotation': {'maximumValue': '30 deg'}, 'slide': {'maximumValue': '20 mm'}}})
        metadata = json.loads(str(caught.exception).split(': ', 1)[1])
        self.assertTrue(metadata['rollback']['restored'])
        self.assertEqual(metadata['limits'], before)
        self.assertEqual(self.ctx.call('joint.inspect', {'joint': ref})['limits'], before)
        motion.slideLimits.fail = 'maximumValue'
        motion.slideLimits.persistent_failure = True
        with self.assertRaises(RuntimeError) as caught:
            self.ctx.call('joint.limits', {'joint': ref, 'confirm': True,
                                         'limits': {'slide': {'maximumValue': '20 mm'}}})
        metadata = json.loads(str(caught.exception).split(': ', 1)[1])
        self.assertFalse(metadata['rollback']['restored'])
        self.assertTrue(metadata['rollback']['errors'])
        self.assertEqual(metadata['limits'], before)

    def test_identity_native_nested_and_root_origin(self):
        self.ctx.component = self.ctx.entities['A']
        self.ctx.entities['origin'] = Entity('ConstructionPoint', parentComponent=self.ctx.component)
        ref = self.joint('revolute')
        self.assertIs(self.ctx.trace[-1][2][1], self.ctx.root.originConstructionPoint)
        joint = self.ctx.resolve(ref)
        joint.parentComponent = self.ctx.entities['A']
        result = self.ctx.call('joint.limits', {'joint': ref, 'confirm': True,
            'limits': {'rotation': {'maximumValue': '30 deg'}}})
        self.assertIn('affects all instances', result['scope'])
        joint.assemblyContext = self.ctx.entities['A:1']
        self.assertEqual(self.ctx.call('joint.inspect', {'joint': ref})['scope'], 'occurrence proxy')
        for op, extra in (('limits', {'confirm': True, 'limits': {'rotation': {'maximumValue': '30 deg'}}}),
                          ('drive', {'rotation': '1 deg'}), ('edit', {'name': 'new'})):
            with self.assertRaisesRegex(ValueError, 'native joint'):
                self.ctx.call('joint.' + op, dict(joint=ref, **extra))
        joint.assemblyContext = None
        self.ctx.entities['A:1'].isReferencedComponent = True
        with self.assertRaisesRegex(ValueError, 'External'):
            self.ctx.call('joint.drive', {'joint': ref, 'rotation': '1 deg'})
        joint.occurrenceTwo = None
        self.assertIsNone(self.ctx.call('joint.inspect', {'joint': ref})['occurrences'][1])

    def test_custom_vector_guard(self):
        for axis in ([0, 0, 1], {'vector': [1, 0, 0]}, 'Custom'):
            with self.assertRaisesRegex(ValueError, 'custom vectors are unsupported'):
                self.joint('revolute', axis=axis)
        self.assertEqual(self.ctx.trace, [])

    def test_creation_limits_apply_to_created_motion_not_input(self):
        inputs = []
        def add(inp):
            inputs.append(inp)
            return self.ctx.add_joint(inp)
        self.ctx.root.asBuiltJoints.add = add
        ref = self.joint('slider', confirm=True, limits={'slide': {'maximumValue': '20 mm'}})
        self.assertEqual(inputs[0].jointMotion.slideLimits.writes, [])
        self.assertEqual(self.ctx.resolve(ref).jointMotion.slideLimits.maximumValue, 2)
        self.assertIsNot(inputs[0].jointMotion, self.ctx.resolve(ref).jointMotion)

    def test_creation_limit_failure_retains_created_reference(self):
        def add(inp):
            joint = self.ctx.add_joint(inp)
            joint.jointMotion.slideLimits.fail = 'maximumValue'
            return joint
        self.ctx.root.asBuiltJoints.add = add
        with self.assertRaises(RuntimeError) as caught:
            self.joint('slider', confirm=True, limits={'slide': {'maximumValue': '20 mm'}})
        metadata = json.loads(str(caught.exception).split(': ', 1)[1])
        self.assertTrue(metadata['createdJointRetained'])
        self.assertFalse(metadata['atomic'])
        self.assertIn(self.ctx.resolve(metadata['joint']), [self.ctx.resolve(r) for r in self.ctx.created])

    def test_creation_zeroed_native_limits_all_axes(self):
        def add(inp):
            joint = self.ctx.add_joint(inp)
            for limits in (getattr(joint.jointMotion, a + 'Limits', None) for a in ('rotation', 'slide')):
                if limits is not None:
                    for p in self.ctx.ns['_ASSEMBLY_LIMIT_VALUES']:
                        setattr(limits, p, 0)
                    for p in self.ctx.ns['_ASSEMBLY_LIMIT_FLAGS']:
                        setattr(limits, p, False)
            return joint
        self.ctx.root.asBuiltJoints.add = add
        for mode, axes in (('revolute', ('rotation',)), ('slider', ('slide',)),
                           ('cylindrical', ('rotation', 'slide'))):
            spec = {a: dict(minimumValue='-1 rad' if a == 'rotation' else '-1 cm',
                            maximumValue='2 rad' if a == 'rotation' else '2 cm',
                            restValue='0.2 rad' if a == 'rotation' else '0.2 cm',
                            isMinimumValueEnabled=True, isMaximumValueEnabled=True,
                            isRestValueEnabled=True) for a in axes}
            ref = self.joint(mode, confirm=True, limits=spec)
            actual = self.ctx.call('joint.inspect', {'joint': ref})['limits']
            for a in axes:
                self.assertEqual([actual[a][p] for p in self.ctx.ns['_ASSEMBLY_LIMIT_VALUES']], [-1, 2, .2])
                self.assertTrue(all(actual[a][p] for p in self.ctx.ns['_ASSEMBLY_LIMIT_FLAGS']))

    def test_invalid_creation_limits_reject_before_add(self):
        with self.assertRaisesRegex(ValueError, 'minimumValue'):
            self.joint(confirm=True, limits={'rotation': {'maximumValue': '30 deg'},
                                             'slide': {'minimumValue': '20 cm'}})
        self.assertEqual(self.ctx.trace, [])
        self.assertEqual(self.ctx.created, [])

    def test_drive_returns_actual_not_requested_value(self):
        class AdjustedMotion(Entity):
            @property
            def slideValue(self):
                return self.actual

            @slideValue.setter
            def slideValue(self, value):
                self.actual = value / 2

        ref = self.joint('slider')
        self.ctx.resolve(ref).jointMotion = AdjustedMotion('SliderJointMotion', actual=0, slideLimits=Limits())
        result = self.ctx.call('joint.drive', {'joint': ref, 'slide': '10 mm'})
        self.assertEqual(result['slideValue'], .5)
        self.assertEqual(self.ctx.call('joint.inspect', {'joint': ref})['slideValue'], .5)

    def test_existing_joint_and_foreign_identity(self):
        ref = self.joint('revolute')
        joint = self.ctx.resolve(ref)
        joint.objectType = 'adsk::fusion::Joint'
        ref = self.ctx.ref(joint)
        self.ctx.call('joint.limits', {'joint': ref, 'confirm': True,
            'limits': {'rotation': {'maximumValue': '30 deg', 'isMaximumValueEnabled': False}}})
        self.assertFalse(joint.jointMotion.rotationLimits.isMaximumValueEnabled)
        joint.parentComponent = Entity('Component', 'Foreign')
        with self.assertRaisesRegex(ValueError, 'this design'):
            self.ctx.call('joint.drive', {'joint': ref, 'rotation': '0 deg'})

    def test_limit_flag_write_failure_restores_remaining_flags(self):
        ref = self.joint('slider')
        motion = self.ctx.resolve(ref).jointMotion
        before = self.ctx.call('joint.inspect', {'joint': ref})['limits']
        motion.slideLimits.fail = 'isMaximumValueEnabled'
        with self.assertRaises(RuntimeError) as caught:
            self.ctx.call('joint.limits', {'joint': ref, 'confirm': True,
                'limits': {'slide': {'maximumValue': '20 mm'}}})
        metadata = json.loads(str(caught.exception).split(': ', 1)[1])
        self.assertTrue(metadata['rollback']['restored'])
        self.assertEqual(metadata['limits'], before)

    def feature(self):
        feature = Entity('ExtrudeFeature', 'Extrude', isSuppressed=False)
        parameter = NS(name='d1', expression='2 mm', unit='cm', createdBy=feature)
        self.ctx.component.features.values.append(feature)
        self.ctx.design.allParameters.values.append(parameter)
        return feature, parameter, self.ctx.ref(feature)

    def test_preview_read_only_edit_and_ownership(self):
        feature, parameter, ref = self.feature()
        result = self.ctx.call('change.preview', {'feature': ref, 'name': 'Preview', 'parameters': {'d1': '5 mm'}})
        self.assertFalse(result['applied'])
        self.assertEqual(parameter.expression, '2 mm')
        self.assertEqual(feature.name, 'Extrude')
        self.assertEqual(self.ctx.trace, [])
        for parameters in ({'d1': '1 deg'}, {'foreign': '5 mm'}, {'d1': 5}):
            with self.assertRaises(ValueError):
                self.ctx.call('feature.edit', {'feature': ref, 'name': 'Wrong', 'parameters': parameters})
        self.assertEqual(feature.name, 'Extrude')
        self.ctx.call('feature.edit', {'feature': ref, 'parameters': {'d1': '5 mm'}})
        self.assertEqual(parameter.expression, '5 mm')

    def test_feature_list_inspect_suppress(self):
        feature, parameter, ref = self.feature()
        self.assertEqual(len(self.ctx.call('feature.list', {})['features']), 1)
        self.assertEqual(self.ctx.call('feature.inspect', {'feature': ref})['parameters'][0]['name'], 'd1')
        for op, value in (('suppress', True), ('unsuppress', False)):
            self.ctx.call('feature.' + op, {'feature': ref})
            self.assertEqual(feature.isSuppressed, value)
        self.ctx.design.designType = 0
        with self.assertRaises(ValueError):
            self.ctx.call('feature.suppress', {'feature': ref})

    def test_history_read_only_and_recompute(self):
        self.ctx.design.timeline.values.append(NS(name='Broken', healthState=2, errorOrWarningMessage='bad profile'))
        result = self.ctx.call('history.check', {})
        self.assertFalse(result['healthy'])
        self.assertEqual(result['timeline'][0]['message'], 'bad profile')
        self.assertEqual(self.ctx.trace, [])
        self.assertTrue(self.ctx.call('history.recompute', {})['recomputed'])
        self.assertEqual(self.ctx.trace, ['compute'])

    def test_history_check_recurses_groups_and_scopes_to_exact_owner(self):
        root_feature = Entity('ExtrudeFeature', 'RootFeature', parentComponent=self.ctx.root,
            healthState=0, errorOrWarningMessage='', isSuppressed=False, isRolledBack=False)
        child_feature = Entity('ExtrudeFeature', 'ChildFeature', parentComponent=self.ctx.entities['A'],
            healthState=2, errorOrWarningMessage='child broken', isSuppressed=False, isRolledBack=False)
        group = NS(name='RootGroup', isGroup=True, healthState=0, errorOrWarningMessage='',
            isSuppressed=False, isRolledBack=False, count=2)
        nested = NS(name='NestedGroup', isGroup=True, healthState=0, errorOrWarningMessage='',
            isSuppressed=False, isRolledBack=False, count=1)
        group.item = lambda index: (root_feature, nested)[index]
        nested.item = lambda index: child_feature
        self.ctx.design.timeline.values[:] = [root_feature, group]

        root_result = self.ctx.call('history.check', {})
        self.assertFalse(root_result['healthy'])
        self.assertTrue(root_result['recursive'])
        self.assertTrue(any(row.get('duplicate') for row in root_result['timeline']))
        self.assertTrue(any(row.get('name') == 'ChildFeature' for row in root_result['timeline']))

        root_owner_result = self.ctx.call('history.check', {'scope': {'component': 'root'}})
        self.assertTrue(root_owner_result['healthy'])

        component_result = self.ctx.call('history.check', {'scope': {'component': 'A'}})
        self.assertFalse(component_result['healthy'])
        self.assertEqual(component_result['scope']['component']['name'], 'A')
        self.assertTrue(any(row.get('name') == 'ChildFeature' for row in component_result['timeline']))

        group_result = self.ctx.call('history.check', {'scope': {'group': '1'}, 'recursive': False})
        self.assertEqual(group_result['status'], 'unknown')
        self.assertFalse(group_result['healthy'])
        self.assertEqual(group_result['coverage']['unvisitedChildren'], 2)

    def test_history_check_only_allows_explicit_suppressed_refs(self):
        suppressed = Entity('ExtrudeFeature', 'Suppressed', parentComponent=self.ctx.root,
            healthState=3, errorOrWarningMessage='', isSuppressed=True, isRolledBack=False)
        self.ctx.design.timeline.values[:] = [suppressed]
        self.assertFalse(self.ctx.call('history.check', {})['healthy'])
        allowed = self.ctx.call('history.check', {'allowSuppressed': [self.ctx.ref(suppressed)]})
        self.assertTrue(allowed['healthy'])
        self.assertTrue(allowed['timeline'][0]['suppressedAllowed'])

    def test_recursive_history_accepts_healthy_group_with_nonfeature_unknown_state(self):
        child = Entity('ExtrudeFeature', 'HealthyChild', parentComponent=self.ctx.root,
            healthState=0, errorOrWarningMessage='', isSuppressed=False, isRolledBack=False)
        group = NS(name='HealthyGroup', isGroup=True, healthState=5, errorOrWarningMessage='',
            isSuppressed=False, isRolledBack=False, count=1)
        group.item = lambda index: child
        self.ctx.design.timeline.values[:] = [group]
        result = self.ctx.call('history.check', {})
        self.assertTrue(result['healthy'])
        self.assertEqual(result['status'], 'pass')
        self.assertEqual(result['timeline'][0]['state'], 'unknown')
        self.assertEqual(result['coverage']['unknownLeaves'], 0)

    def test_history_check_never_hides_suppressed_group_container(self):
        child = Entity('ExtrudeFeature', 'HealthyChild', parentComponent=self.ctx.root,
            healthState=0, errorOrWarningMessage='', isSuppressed=False, isRolledBack=False)
        group = NS(name='SuppressedGroup', isGroup=True, healthState=3, errorOrWarningMessage='',
            isSuppressed=True, isRolledBack=False, count=1)
        group.item = lambda index: child
        self.ctx.design.timeline.values[:] = [group]
        result = self.ctx.call('history.check', {})
        self.assertFalse(result['healthy'])
        self.assertEqual(result['status'], 'fail')
        self.assertTrue(result['timeline'][0]['suppressed'])

    def test_dependencies_partial(self):
        self.assertEqual(self.ctx.call('feature.dependencies', {})['coverage'], 'partial')
        self.assertEqual(self.ctx.trace, [])


if __name__ == '__main__':
    unittest.main()

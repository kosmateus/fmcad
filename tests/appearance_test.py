"""Offline GM29 contracts: appearances, materials, textures, attributes, reports."""
import json
import math
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch
from python_test_support import load_legacy_core

ROOT = Path(__file__).resolve().parents[1]


class Items:
    def __init__(self, values=()):
        self.values = list(values)

    @property
    def count(self):
        return len(self.values)

    def item(self, index):
        return self.values[index]


class Color:
    def __init__(self, r=0, g=0, b=0, a=255):
        self.red, self.green, self.blue, self.opacity = r, g, b, a

    @staticmethod
    def create(*rgba):
        return Color(*rgba)


class Prop:
    def __init__(self, prop_id, name, value, units='', read_only=False):
        self.id, self.name, self._value = prop_id, name, value
        self.units, self.isReadOnly = units, read_only
        self.hasConnectedTexture, self.hasLimits = False, False

    @property
    def value(self):
        return self._value

    @value.setter
    def value(self, v):
        if self.isReadOnly:
            raise RuntimeError('read-only property')
        self._value = v


class FloatProp(Prop):
    pass


class ColorProp(Prop):
    pass


class BoolProp(Prop):
    pass


class ChoiceProp(Prop):
    pass


class Props:
    def __init__(self, props=()):
        self.props = list(props)

    @property
    def count(self):
        return len(self.props)

    def item(self, index):
        return self.props[index]

    def itemById(self, prop_id):
        return next((p for p in self.props if p.id == prop_id), None)

    def itemByName(self, name):
        return next((p for p in self.props if p.name == name), None)


class Style:
    def __init__(self, style_id, name, kind='appearance', props=(), parent=None):
        self.id, self.name, self.parent = style_id, name, parent
        self.description = ''
        if kind == 'appearance':
            self.appearanceProperties = Props(props)
            self.colorTexture = self.normalTexture = self.roughnessTexture = ''
        else:
            self.materialProperties = Props(props)
        self.appearance = None


class Body:
    def __init__(self, name, component):
        self.objectType = 'adsk::fusion::BRepBody'
        self.name = self.entityToken = name
        self.parentComponent = component
        self.nativeObject = self.assemblyContext = None
        self.isTransient = False
        self.appearance = None
        self.material = None
        self.faces = Items()


class Face:
    def __init__(self, name, body):
        self.objectType = 'adsk::fusion::BRepFace'
        self.name = self.entityToken = name
        self.body = body
        self.parentComponent = body.parentComponent
        self.nativeObject = self.assemblyContext = None


class Occurrence:
    def __init__(self, name, component):
        self.objectType = 'adsk::fusion::Occurrence'
        self.name = self.entityToken = name
        self.fullPathName = name
        self.component = component
        self.nativeObject = self.assemblyContext = None
        self.appearance = None


def _adsk():
    adsk = types.ModuleType('adsk')
    adsk.core = types.ModuleType('adsk.core')
    adsk.fusion = types.ModuleType('adsk.fusion')
    adsk.core.AppearanceSurfaceTypes = types.SimpleNamespace(
        OpaqueAppearanceSurface='opaque', MetalAppearanceSurface='metal', TransparentAppearanceSurface='transparent')
    adsk.core.AppearanceSourceTypes = types.SimpleNamespace(
        MaterialAppearanceSource=0, BodyAppearanceSource=1, OccurrenceAppearanceSource=2,
        FaceAppearanceSource=3, OverrideAppearanceSource=4)
    adsk.core.Color = Color
    adsk.core.FloatProperty = types.SimpleNamespace(cast=lambda p: p if isinstance(p, FloatProp) else None)
    adsk.core.IntegerProperty = types.SimpleNamespace(cast=lambda p: None)
    adsk.core.BooleanProperty = types.SimpleNamespace(cast=lambda p: p if isinstance(p, BoolProp) else None)
    adsk.core.StringProperty = types.SimpleNamespace(cast=lambda p: None)
    adsk.core.ColorProperty = types.SimpleNamespace(cast=lambda p: p if isinstance(p, ColorProp) else None)
    adsk.core.ChoiceProperty = types.SimpleNamespace(cast=lambda p: p if isinstance(p, ChoiceProp) else None)
    adsk.core.AppearanceTextureProperty = types.SimpleNamespace(cast=lambda p: None)
    return adsk


def load_module():
    adsk = _adsk()
    module = types.ModuleType('appearance_under_test')
    with patch.dict(sys.modules, {'adsk': adsk, 'adsk.core': adsk.core, 'adsk.fusion': adsk.fusion}):
        load_legacy_core(module.__dict__, ROOT)
        exec(compile((ROOT / 'assets/cad/appearance.py').read_text(), '<appearance>', 'exec'), module.__dict__)
        exec(compile((ROOT / 'assets/cad/texture.py').read_text(), '<texture>', 'exec'), module.__dict__)
        exec(compile((ROOT / 'assets/cad/attributes.py').read_text(), '<attributes>', 'exec'), module.__dict__)
    return adsk, module


def make_context(adsk, module, appearances=(), materials=(), libraries=()):
    ctx = types.SimpleNamespace()
    ctx.doc = types.SimpleNamespace(creationId='test-id', name='Test')
    root = types.SimpleNamespace(objectType='adsk::fusion::Component', name='root', entityToken='root')
    ctx.root = root
    ctx.component = root
    ctx.occurrence = None
    ctx.created = []
    ctx.design = types.SimpleNamespace(rootComponent=root)
    ctx.design.appearances = Items(list(appearances))
    ctx.design.materials = Items(list(materials))
    ctx.app = types.SimpleNamespace(materialLibraries=Items(list(libraries)))
    ctx.entities = {'root': root}
    ctx.assert_identity = lambda: None
    ctx.length = lambda v: float(v.split()[0]) * {'mm': 0.1, 'cm': 1, 'in': 2.54}[v.split()[1]]
    ctx.angle = lambda v: float(v.split()[0]) * {'deg': math.pi / 180, 'rad': 1}[v.split()[1]]
    ctx.point = lambda xyz: types.SimpleNamespace(x=ctx.length(xyz[0]), y=ctx.length(xyz[1]), z=ctx.length(xyz[2]))
    ctx.require_confirm = lambda d: None
    ctx.call = lambda op, d: module.CAD_HANDLERS[op](ctx, d)

    def ref(entity):
        return {'token': getattr(entity, 'entityToken', None), 'kind': module._cad_kind(entity),
                'name': getattr(entity, 'name', None)}

    ctx.ref = ref

    def resolve(ref_, kind=None):
        key = ref_ if isinstance(ref_, str) else ref_.get('token', ref_.get('name'))
        if key not in ctx.entities:
            raise ValueError('Missing ref ' + str(key))
        return ctx.entities[key]

    ctx.resolve = resolve

    def entities(kind):
        result = []
        for value in ctx.entities.values():
            if module._cad_kind(value) == kind:
                result.append(value)
        return result

    ctx._entities = entities
    return ctx


class AppearanceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.adsk, cls.module = load_module()

    def setUp(self) -> None:
        self.adsk = self.__class__.adsk
        self.module = self.__class__.module
        temporary = tempfile.TemporaryDirectory(prefix='fmcad-appearance-')
        self.addCleanup(temporary.cleanup)
        self.folder = Path(temporary.name)

    def texture_props(self):
        return [FloatProp('texture_RealWorldScaleX', 'RealWorldScaleX', 1.0),
                FloatProp('texture_RealWorldScaleY', 'RealWorldScaleY', 1.0),
                ColorProp('surface_normal', 'Normal', Color(128, 128, 255)),
                FloatProp('surface_roughness', 'Roughness', 0.5)]

    def appearance(self, style_id='appearance-id', name='Paint', props=None, parent=None):
        return Style(style_id, name, 'appearance', props if props is not None else self.texture_props(), parent)

    def material(self, style_id='material-id', name='ABS', density=1.05):
        return Style(style_id, name, 'material', [FloatProp('density', 'Density', density, 'g/cm^3')])

    def call(self, op, **data):
        return self.ctx.call(op, data)

    def test_create_copies_and_reports_actual_id_without_assuming_uniqueness(self):
        local = self.appearance()
        ctx = make_context(self.adsk, self.module, appearances=[local])
        ctx.design.appearances.addByCopy = lambda source, name: Style('actual-copy', name, 'appearance', self.texture_props())
        self.ctx = ctx
        result = self.call('appearance.create', name='Custom', id=local.id)
        self.assertEqual(result['id'], 'actual-copy')
        self.assertEqual(result['created']['id'], 'actual-copy')
        self.assertEqual(result['copiedFrom'], 'appearance-id')
        self.assertIsInstance(result['properties'], list)

    def test_create_rejects_duplicate_name(self):
        local = self.appearance()
        ctx = make_context(self.adsk, self.module, appearances=[local])
        self.ctx = ctx
        with self.assertRaisesRegex(ValueError, 'already exists'):
            self.call('appearance.create', name='Paint', id=local.id)

    def test_edit_typed_property_and_read_only_rejection(self):
        rough = FloatProp('surface_roughness', 'Roughness', 0.5)
        locked = FloatProp('locked', 'Locked', 1.0, read_only=True)
        local = self.appearance(props=[rough, locked])
        ctx = make_context(self.adsk, self.module, appearances=[local])
        self.ctx = ctx
        result = self.call('appearance.edit', id=local.id, properties=[{'id': 'surface_roughness', 'value': 0.9}])
        self.assertEqual(result['status'], 'pass')
        self.assertEqual(result['propertyChanges'][0]['after']['value'], 0.9)
        with self.assertRaisesRegex(ValueError, 'read-only'):
            self.call('appearance.edit', id=local.id, properties=[{'id': 'locked', 'value': 2.0}])

    def test_edit_rejects_library_resource(self):
        # A library appearance lives in the library collection, not in
        # design.appearances; edit resolves only design-local members, so a
        # library-only id yields no match.
        lib = types.SimpleNamespace(id='loaded-library', name='Loaded',
                                    appearances=Items(), materials=Items())
        foreign = self.appearance('foreign-id', 'Foreign')
        foreign.parent = lib
        lib.appearances = Items([foreign])
        ctx = make_context(self.adsk, self.module, appearances=[], libraries=[lib])
        self.ctx = ctx
        with self.assertRaisesRegex(ValueError, 'no match'):
            self.call('appearance.edit', id='foreign-id', name='Changed')

    def test_design_local_detection_uses_membership_not_parent(self):
        # A copy made via addByCopy can still report a library-typed parent. The
        # design-local guard must use membership in design.appearances, not parent,
        # otherwise edit/texture/projection refuse with "targets design-local only".
        library = types.SimpleNamespace(id='loaded-library', name='Loaded',
                                        appearances=Items(), materials=Items())
        local = self.appearance('Prism-144', 'FreshCopy')
        local.parent = library  # library-typed parent, but the item is design-local
        ctx = make_context(self.adsk, self.module, appearances=[local], libraries=[library])
        self.ctx = ctx
        result = self.call('appearance.edit', id='Prism-144', name='Renamed')
        self.assertEqual(result['status'], 'pass')
        self.assertEqual(result['resolution']['selected']['name'], 'FreshCopy')

    def test_style_resolve_reduces_to_design_local_members(self):
        # A mixed candidate list: a library entry (not in design.appearances) and a
        # design-local copy sharing the id. The reduction must keep only the
        # design-local member, never the library entry.
        library = types.SimpleNamespace(id='loaded-library', name='Loaded',
                                        appearances=Items(), materials=Items())
        lib_copy = self.appearance('PrismOpaque', 'LibraryBacked')
        lib_copy.parent = library
        local = self.appearance('PrismOpaque', 'DesignCopy')
        local.parent = library  # unreliable parent, but the item IS design-local
        ctx = make_context(self.adsk, self.module, appearances=[local], libraries=[library])
        self.ctx = ctx
        selected, resolution = self.module._cad_style_resolve(
            [lib_copy, local], 'appearance ID', ctx.design.appearances, 'PrismOpaque')
        self.assertIs(selected, local)
        self.assertEqual(resolution['precedence'], 'design-local')
        self.assertIn('LibraryBacked', [c['name'] for c in resolution['candidates']])

    def test_material_create_copy_and_missing_density_not_replaced(self):
        mat = self.material()
        ctx = make_context(self.adsk, self.module, materials=[mat])
        ctx.design.materials.addByCopy = lambda source, name: Style('copied-material', name, 'material',
                                                                    [FloatProp('density', 'Density', 1.05)])
        self.ctx = ctx
        result = self.call('material.create', name='Custom ABS', id=mat.id)
        self.assertEqual(result['id'], 'copied-material')
        # A material without a density property must not silently gain one.
        no_density = Style('no-density', 'Hollow', 'material', [])
        ctx2 = make_context(self.adsk, self.module, materials=[no_density])
        self.ctx = ctx2
        report = self.call('styles.report', refs=[])
        self.assertTrue(any(d['densityMissing'] for d in report['density']))

    def test_texture_channel_and_blocked_bump(self):
        local = self.appearance()
        ctx = make_context(self.adsk, self.module, appearances=[local])
        self.ctx = ctx
        result = self.call('appearance.texture', id=local.id, channel='normal', image='C:/t.png')
        self.assertEqual(result['after']['image'], 'C:/t.png')
        self.assertEqual(local.normalTexture, 'C:/t.png')
        with self.assertRaisesRegex(ValueError, 'bumpmap_Type'):
            self.call('appearance.texture', id=local.id, channel='normal', bump=True)

    def test_projection_set_and_read(self):
        local = self.appearance(props=self.texture_props() + [ChoiceProp('texture_ProjectionType', 'Projection', 'planar')])
        ctx = make_context(self.adsk, self.module, appearances=[local])
        self.ctx = ctx
        result = self.call('appearance.projection', id=local.id, projection='box')
        self.assertEqual(result['status'], 'pass')
        self.assertEqual(result['after'], 'BoxTextureMapProjection')

    def test_texture_scale_lock_applies_both_axes(self):
        local = self.appearance()
        ctx = make_context(self.adsk, self.module, appearances=[local])
        self.ctx = ctx
        result = self.call('appearance.texture', id=local.id, channel='color', scaleX='2 cm', lock=True)
        self.assertEqual(result['scaleLocked'], True)
        self.assertEqual(result['realWorldScale']['scaleX'], result['realWorldScale']['scaleY'])

    def test_assign_map_mismatch(self):
        body = Body('Body', types.SimpleNamespace(objectType='adsk::fusion::Component', name='root', entityToken='root'))
        body.appearance = self.appearance()
        body.parentComponent = body
        ctx = make_context(self.adsk, self.module, appearances=[body.appearance])
        ctx.entities['Body'] = body
        self.ctx = ctx
        result = self.call('appearance.assign-map', refs=['Body'], expected={'Body': 'other-id'})
        self.assertEqual(result['status'], 'fail')
        self.assertEqual(result['mismatchCount'], 1)
        ok = self.call('appearance.assign-map', refs=['Body'], expected={'Body': 'appearance-id'})
        self.assertEqual(ok['status'], 'pass')

    def test_styles_report_duplicate_names(self):
        a1 = self.appearance('id1', 'Dup')
        a2 = self.appearance('id2', 'Dup')
        ctx = make_context(self.adsk, self.module, appearances=[a1, a2])
        self.ctx = ctx
        result = self.call('styles.report', refs=[])
        self.assertEqual(result['status'], 'fail')
        self.assertEqual(result['duplicateNames']['appearance'], {'Dup': ['id1', 'id2']})


class AttributeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.adsk, cls.module = load_module()

    def call(self, op, **data):
        return self.ctx.call(op, data)

    def test_set_get_and_resource_identity(self):
        body = Body('Body', None)
        body.attributes = types.SimpleNamespace()
        stored = {}

        def add(group, name, value):
            stored[(group, name)] = value
            return types.SimpleNamespace(name=name, value=value)

        def item_by_name(group, name):
            if (group, name) not in stored:
                return None
            return types.SimpleNamespace(name=name, value=stored[(group, name)])

        def items_by_group(group):
            return [types.SimpleNamespace(name=n, value=v) for (g, n), v in stored.items() if g == group]

        body.attributes.add = add
        body.attributes.itemByName = item_by_name
        body.attributes.itemsByGroup = items_by_group
        ctx = make_context(self.adsk, self.module)
        ctx.entities['Body'] = body
        self.ctx = ctx
        result = self.call('entity.attribute.set', ref='Body', group='fmcad.meta', name='source', value='STEP')
        self.assertEqual(result['status'], 'pass')
        self.assertEqual(result['resourceIdentity']['kind'], 'body')
        self.assertEqual(result['changed'], True)
        got = self.call('entity.attribute.get', ref='Body', group='fmcad.meta')
        self.assertEqual(got['attributes'], [{'name': 'source', 'value': 'STEP'}])


class HeightmapTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.adsk, cls.module = load_module()

    def call(self, op, **data):
        return self.ctx.call(op, data)

    def test_deterministic_and_distinct_patterns(self):
        ctx = make_context(self.adsk, self.module)
        ctx.require_confirm = lambda d: None
        self.ctx = ctx
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            path = str(Path(tmp) / 'height.png')
            first = self.call('texture.heightmap', path=path, seed=7, pattern='waves')
            second = self.call('texture.heightmap', path=path, seed=7, pattern='waves', overwrite=True, confirm=True)
            self.assertEqual(first['sha256'], second['sha256'])
            self.assertEqual(first['parameters'], second['parameters'])
            noise = self.call('texture.heightmap', path=str(Path(tmp) / 'noise.png'), seed=7, pattern='noise')
            self.assertNotEqual(first['sha256'], noise['sha256'])
            self.assertTrue(Path(path).read_bytes().startswith(b'\x89PNG'))


if __name__ == '__main__':
    unittest.main()

"""Explicit-consent native specimen generator for generic CAD controls.

This is a Fusion-side script, not the offline fixture evaluator. It creates
artifacts only in the exact, empty scratch document named below. It does not
save, publish, close, or automatically clean up that document.
"""
import json
import re


DOC_NAME = 'FmcadGenericControlsScratch'
ARGS = {}
_IDENTITY_FIELDS = ('projectId', 'folderId', 'fileId', 'creationId')
_PREFIX = re.compile(r'^[A-Z0-9]{8,20}$')


def _require(condition, message):
    if not condition:
        raise RuntimeError(message)


def _document_identity():
    identity = FMCAD.call('document.status', {})
    _require(identity.get('name') == DOC_NAME,
             'Native fixture generation requires the dedicated ' + DOC_NAME + ' document')
    for key in _IDENTITY_FIELDS:
        expected = ARGS.get(key)
        _require(isinstance(expected, str) and expected and identity.get(key) == expected,
                 'Native fixture document identity mismatch for ' + key)
    version = ARGS.get('version')
    _require(type(version) is int and identity.get('version') == version,
             'Native fixture document version mismatch')
    _require(identity.get('saved') is True and identity.get('isComplete') is True and
             identity.get('isReadOnly') is False,
             'Native fixture generation requires the exact saved, complete, writable scratch document')
    return {key: identity.get(key) for key in ('name',) + _IDENTITY_FIELDS + ('version',)}


def _fixture_prefix():
    value = ARGS.get('fixturePrefix')
    _require(isinstance(value, str) and _PREFIX.fullmatch(value) is not None,
             'fixturePrefix must be a unique 8-20 character uppercase alphanumeric run ID')
    return value


def _create_component(name, owned, placement=None):
    data = {'name': name}
    if placement is not None:
        data['placement'] = {'translation': placement}
    result = FMCAD.call('component.create', data)
    occurrence = result.get('occurrence')
    _require(isinstance(occurrence, dict) and isinstance(occurrence.get('token'), str),
             'component.create did not return the exact owned occurrence token')
    owned.append({'name': name, 'occurrence': occurrence})
    return result


def _component_name(prefix, family, case_id, part=''):
    suffix = '_' + part if part else ''
    return 'FMCAD_GC_' + prefix + '_' + family + '_' + case_id + suffix


def _call_in_component(operation, data, component):
    FMCAD.call(operation, data, component=component)


def _generate_enclosure(prefix, owned, case_id):
    component = _create_component(_component_name(prefix, 'enclosure', case_id), owned)
    wall = '0.8 mm' if case_id == 'thin-wall' else '2 mm'
    _call_in_component('shape.can', {
        'name': 'GC_' + prefix + '_can_' + case_id,
        'diameter': '30 mm', 'height': '40 mm', 'wallThickness': wall,
        'opening': 'top', 'axis': 'Y',
    }, component['component'])
    sketch = FMCAD.call('sketch.create', {
        'name': 'GC_' + prefix + '_seam_' + case_id + '_sketch', 'plane': 'XY',
    }, component=component['component'])['sketch']
    seam = ([
        {'type': 'line', 'name': 'seam-lower', 'start': ['0 mm', '0 mm', '0 mm'],
         'end': ['0 mm', '19.8 mm', '0 mm']},
        {'type': 'line', 'name': 'seam-upper', 'start': ['0 mm', '20.2 mm', '0 mm'],
         'end': ['0 mm', '40 mm', '0 mm']},
    ] if case_id == 'open-seam' else [
        {'type': 'line', 'name': 'seam', 'start': ['0 mm', '0 mm', '0 mm'],
         'end': ['0 mm', '40 mm', '0 mm']},
    ])
    FMCAD.call('sketch.geometry', {
        'sketch': sketch, 'inferencePolicy': 'explicit', 'geometry': seam,
    }, component=component['component'])


def _generate_shaft_socket(prefix, owned, case_id):
    component = _create_component(_component_name(prefix, 'shaft_socket', case_id), owned)
    bore = '9.9 mm' if case_id == 'interference' else '10.2 mm'
    engagement = '8 mm' if case_id == 'short-engagement' else '12 mm'
    _call_in_component('shape.cylinder', {
        'name': 'GC_' + prefix + '_shaft_' + case_id,
        'radius': '5 mm', 'height': engagement,
    }, component['component'])
    _call_in_component('shape.tube', {
        'name': 'GC_' + prefix + '_socket_' + case_id,
        'outerRadius': '7 mm', 'innerRadius': '(' + bore + ') / 2', 'height': '20 mm',
    }, component['component'])


def _generate_channel(prefix, owned, case_id):
    component = _create_component(_component_name(prefix, 'channel', case_id), owned)
    sketch = FMCAD.call('sketch.create', {
        'name': 'GC_' + prefix + '_channel_' + case_id + '_sketch', 'plane': 'XY',
    }, component=component['component'])['sketch']
    west_start = ['0.2 mm', '0 mm', '0 mm'] if case_id == 'disconnected-west' else ['0 mm', '0 mm', '0 mm']
    branch_clearances = {'inlet': '2 mm', 'east': '0.9 mm' if case_id == 'narrow-east' else '1.8 mm',
                         'west': '1.7 mm'}
    geometry = [
        {'type': 'line', 'name': 'inlet', 'start': ['-20 mm', '0 mm', '0 mm'],
         'end': ['0 mm', '0 mm', '0 mm']},
        {'type': 'line', 'name': 'east', 'start': ['0 mm', '0 mm', '0 mm'],
         'end': ['10 mm', '10 mm', '0 mm']},
        {'type': 'line', 'name': 'west', 'start': west_start,
         'end': ['10 mm', '-10 mm', '0 mm']},
        {'type': 'circle', 'name': 'inlet-section', 'center': ['-20 mm', '0 mm', '0 mm'],
         'radius': '(' + branch_clearances['inlet'] + ') / 2'},
        {'type': 'circle', 'name': 'east-section', 'center': ['10 mm', '10 mm', '0 mm'],
         'radius': '(' + branch_clearances['east'] + ') / 2'},
        {'type': 'circle', 'name': 'west-section', 'center': ['10 mm', '-10 mm', '0 mm'],
         'radius': '(' + branch_clearances['west'] + ') / 2'},
    ]
    FMCAD.call('sketch.geometry', {
        'sketch': sketch, 'inferencePolicy': 'explicit', 'geometry': geometry,
    }, component=component['component'])


def _generate_arc(prefix, owned, case_id):
    component = _create_component(_component_name(prefix, 'arc_sketch', case_id), owned)
    sketch = FMCAD.call('sketch.create', {
        'name': 'GC_' + prefix + '_arc_' + case_id + '_sketch', 'plane': 'XY',
    }, component=component['component'])['sketch']
    center_x = '0.4 mm' if case_id == 'offset-center' else '0 mm'
    radius = '10.1 mm' if case_id == 'wrong-radius' else '10 mm'
    FMCAD.call('sketch.geometry', {
        'sketch': sketch, 'inferencePolicy': 'explicit',
        'geometry': [{'type': 'arc', 'name': 'arc', 'center': [center_x, '0 mm', '0 mm'],
                      'start': ['(' + center_x + ') + (' + radius + ')', '0 mm', '0 mm'],
                      'sweep': '180 deg'}],
    }, component=component['component'])


def _generate_gear_pair(prefix, owned, case_id):
    module_b = '1.25 mm' if case_id == 'module-mismatch' else '1 mm'
    center_x = '31 mm' if case_id == 'over-spaced' else '30 mm'
    for part, module, translation in (
            ('a', '1 mm', ['0 mm', '0 mm', '0 mm']),
            ('b', module_b, [center_x, '0 mm', '0 mm'])):
        component = _create_component(
            _component_name(prefix, 'gear', case_id, part), owned, placement=translation)
        _call_in_component('shape.gear', {
            'name': 'GC_' + prefix + '_gear_' + case_id + '_' + part,
            'module': module, 'teeth': 20 if part == 'a' else 40, 'faceWidth': '3 mm',
        }, component['component'])


def _generate_all(prefix, owned):
    recipes = (
        ('nominal', _generate_enclosure), ('thin-wall', _generate_enclosure),
        ('open-seam', _generate_enclosure),
        ('nominal', _generate_shaft_socket), ('interference', _generate_shaft_socket),
        ('short-engagement', _generate_shaft_socket),
        ('nominal', _generate_channel), ('disconnected-west', _generate_channel),
        ('narrow-east', _generate_channel),
        ('nominal', _generate_arc), ('offset-center', _generate_arc),
        ('wrong-radius', _generate_arc),
        ('nominal', _generate_gear_pair), ('over-spaced', _generate_gear_pair),
        ('module-mismatch', _generate_gear_pair),
    )
    for case_id, recipe in recipes:
        recipe(prefix, owned, case_id)


def _assert_empty_scratch_root():
    root = FMCAD.call('component.inspect', {'component': 'root'})
    _require(root.get('bodies') == [] and root.get('occurrences') == [],
             'Native fixture generation requires an empty root component; no model was changed')


def _cleanup_owned(identity):
    _require(ARGS.get('confirmOwnedFixtureCleanup') is True,
             'cleanup requires confirmOwnedFixtureCleanup=true')
    prefix = _fixture_prefix()
    entries = ARGS.get('ownedOccurrences')
    _require(isinstance(entries, list) and entries,
             'cleanup requires the ownedOccurrences ledger returned by this generator')

    resolved = []
    seen_tokens = set()
    for entry in entries:
        _require(isinstance(entry, dict), 'cleanup ledger entries must be objects')
        name = entry.get('name')
        reference = entry.get('occurrence')
        _require(isinstance(name, str) and name.startswith('FMCAD_GC_' + prefix + '_'),
                 'cleanup refused a component outside this fixture run prefix')
        _require(isinstance(reference, dict) and isinstance(reference.get('token'), str),
                 'cleanup requires an exact occurrence token')
        token = reference['token']
        _require(token not in seen_tokens, 'cleanup ledger contains a duplicate occurrence token')
        seen_tokens.add(token)
        occurrence = FMCAD.resolve(reference, 'occurrence')
        _require(getattr(occurrence, 'isValid', False) is True and occurrence.name == name,
                 'cleanup occurrence identity/name changed; no cleanup performed')
        _require(getattr(occurrence, 'isReferencedComponent', True) is False,
                 'cleanup refuses referenced/external occurrences')
        resolved.append((name, occurrence))

    deleted = []
    for name, occurrence in resolved:
        if occurrence.deleteMe() is not True or getattr(occurrence, 'isValid', True) is not False:
            raise RuntimeError('Owned occurrence cleanup did not verify for ' + name +
                               '; already deleted: ' + json.dumps(deleted))
        deleted.append(name)
    _require(_document_identity() == identity, 'Document identity changed during owned fixture cleanup')
    return {'status': 'cleaned', 'identity': identity, 'deletedNames': deleted,
            'deletedCount': len(deleted), 'nativeModelQualification': 'not performed'}


def run(_context):
    identity = _document_identity()
    mode = ARGS.get('mode')
    if mode == 'cleanup':
        return _cleanup_owned(identity)
    _require(mode == 'generate', 'mode must be generate or cleanup')
    _require(ARGS.get('confirmNativeFixtureGeneration') is True,
             'generation requires confirmNativeFixtureGeneration=true after separate user consent')
    _assert_empty_scratch_root()
    prefix = _fixture_prefix()
    owned = []
    try:
        _generate_all(prefix, owned)
    except Exception as error:
        raise RuntimeError('Native fixture generation stopped without rollback. Inspect partial model; '
                           'exact ownedOccurrences ledger: ' + json.dumps(owned) + '; error: ' + str(error)) from error
    return {
        'status': 'generated',
        'identity': identity,
        'fixturePrefix': prefix,
        'nativeModelQualification': 'not performed',
        'automaticCleanup': False,
        'ownedOccurrences': owned,
    }

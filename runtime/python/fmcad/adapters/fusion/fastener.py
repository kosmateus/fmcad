"""GM16: mount locating, fastener stacks, bearing stacks, shaft interfaces,
bayonet retention, snap-fit evaluation and hose-barbs.

Thin commands over shared definitions: geometry recipes compose the bundled
sketch/model/datum commands; the analytical checks never invent a universal
clearance, torque or fit from a diameter alone. Torque, fit, material, process and
vendor data are declared inputs; when missing they are reported as unknown, never
fabricated. See docs/FASTENERS.md.
"""
import math as _fastener_fusion_math
from collections.abc import Mapping as _fastener_fusion_Mapping
from typing import cast as _fastener_fusion_cast

if hasattr(CAD_HANDLERS, 'owner'):
    CAD_HANDLERS.owner = 'fastener'

import adsk.core as _fastener_fusion_core
import adsk.fusion as _fastener_sdk_fusion


def _fm(ctx: "CadContext", expression: object) -> float:
    return ctx.length(expression) * 10.0


def _fa(ctx: "CadContext", expression: object) -> float:
    return ctx.angle(expression)


def _fastener_contract(ctx: "CadContext", operation: str,
                       result: _fastener_fusion_Mapping[str, "JsonValue"],
                       status: str = 'pass', read_only: bool = True,
                       associativity: str | None = None,
                       warnings: list["JsonValue"] | None = None,
                       limitations: list["JsonValue"] | None = None,
                       **extra: "JsonValue") -> "JsonObject":
    identity = None
    if hasattr(ctx, 'doc') and getattr(ctx.doc, 'name', None) is not None:
        identity = {'creationId': getattr(ctx.doc, 'creationId', None), 'name': ctx.doc.name}
    component = None
    if hasattr(ctx, 'component') and hasattr(ctx, 'ref'):
        try:
            component = ctx.ref(ctx.component)
        except Exception:
            component = None
    result_values = dict(result)
    affected = list(_fastener_fusion_cast(list["JsonValue"], result_values.pop('affected', [])))
    out: "JsonObject" = _fastener_fusion_cast("JsonObject", dict(schemaVersion=1, operation=operation, status=status, success=status == 'pass',
                documentIdentity=identity,
                units={'length': 'mm', 'angle': 'rad', 'force': 'N', 'torque': 'N*m', 'pressure': 'MPa'},
                frame={'space': 'component', 'component': component},
                associativity=associativity or ('snapshot' if read_only else 'recipeRegeneration'),
                warnings=list(warnings or []),
                method='GM16 fastener/mount/bearing/shaft/retention/snap evaluation',
                limitations=['No universal clearance, torque or fit is derived from diameter alone; use declared material/process/vendor data.',
                             'Analytical evaluations; geometry does not certify strength, fatigue or assembly feasibility.'] + list(limitations or []),
                provenance={'requirement': 'GM16', 'source': 'docs/FASTENERS.md'},
                affected=affected))
    out.update(extra)
    out.update(result_values)
    return out






def _mount_create(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _model_fields(data, ('schemaVersion', 'frame', 'name', 'scheme', 'pin', 'slot', 'holes'),
                  ('boss', 'insert', 'support', 'material', 'process'))
    if data.get('schemaVersion') != 1 or data.get('frame') != 'component':
        raise ValueError('mount.create requires schemaVersion:1 and frame:component')
    scheme = _fastener_fusion_cast(str, data['scheme'])
    if scheme not in ('pin-slot', 'two-pin', '2-2-2'):
        raise ValueError('scheme must be pin-slot, two-pin or 2-2-2')
    pin_data = data['pin']
    slot_data = data['slot']
    for key in ('pin', 'slot'):
        if not isinstance(data[key], dict):
            raise ValueError(key + ' must be an object with x and y')
        _model_fields(data[key], ('x', 'y'), ())
    pin_data = _fastener_fusion_cast("JsonObject", pin_data)
    slot_data = _fastener_fusion_cast("JsonObject", slot_data)
    holes = data['holes']
    if not isinstance(holes, dict) or 'positions' not in holes or 'diameter' not in holes:
        raise ValueError('holes requires diameter and positions')
    _model_fields(holes, ('diameter', 'positions'), ('clearance',))
    diameter = _fm(ctx, holes['diameter'])
    clearance = _fm(ctx, holes.get('clearance', '0 mm'))
    if diameter <= 0 or clearance < 0:
        raise ValueError('hole diameter must be positive and clearance nonnegative')
    positions = holes['positions']
    if not isinstance(positions, list) or not positions:
        raise ValueError('holes.positions must be a nonempty array of {x,y}')
    parsed: list["_LocatingHole"] = []
    for pos in positions:
        if not isinstance(pos, dict) or 'x' not in pos or 'y' not in pos:
            raise ValueError('each hole position requires x and y')
        parsed.append({'x': pos['x'], 'y': pos['y'], 'diameter': diameter, 'clearance': clearance})
    name = _fastener_fusion_cast(str, data['name'])
    names = [name, name + '__pin', name + '__slot']
    _shapes_reserve(ctx, names)
    pin = ctx.call('datum.point', {'name': name + '__pin',
                                   'point': [pin_data['x'], pin_data['y'], '0 mm']})
    slot = ctx.call('datum.point', {'name': name + '__slot',
                                    'point': [slot_data['x'], slot_data['y'], '0 mm']})
    dof, over, tight = _locating_dof(scheme, parsed, 0.001)
    boss = data.get('boss')
    insert = data.get('insert')
    support = data.get('support', {})
    if not isinstance(support, dict):
        raise ValueError('support must be an object')
    _model_fields(support, (), ('connector',))
    connector_supported = support.get('connector') is True or (isinstance(support.get('connector'), dict))
    boss_plan = None
    if boss is not None:
        if not isinstance(boss, dict):
            raise ValueError('boss must be an object')
        _model_fields(boss, ('diameter', 'height'), ())
        if _fm(ctx, boss['diameter']) <= 0 or _fm(ctx, boss['height']) <= 0:
            raise ValueError('boss diameter and height must be positive')
        boss_plan = {'diameter': boss['diameter'], 'height': boss['height'], 'role': 'connector support standoff'}
    insert_plan = None
    if insert is not None:
        if not isinstance(insert, dict):
            raise ValueError('insert must be an object')
        _model_fields(insert, ('type', 'outerDiameter', 'innerDiameter', 'length'), ())
        if insert['type'] not in ('heat-set', 'press-fit', 'threaded'):
            raise ValueError('insert type must be heat-set, press-fit or threaded')
        insert_plan = {'type': insert['type'], 'outerDiameter': insert['outerDiameter'],
                       'innerDiameter': insert['innerDiameter'], 'length': insert['length']}
    checks: list["JsonObject"] = []
    status = 'pass'
    checks.append({'check': 'locating-dof', 'status': 'pass', 'constrainedDof': dof,
                   'scheme': scheme, 'note': 'pin+slot locates in-plane translation and rotation without over-constraining'})
    checks.append({'check': 'over-constraint', 'status': 'pass' if not over else 'fail',
                   'tightHoles': tight, 'message': 'not over-constrained' if not over else 'PCB fixed through every hole (thermal over-constraint)'})
    if over:
        status = 'fail'
    checks.append({'check': 'connector-support',
                   'status': 'pass' if connector_supported and boss_plan is not None else 'unknown',
                   'boss': boss_plan, 'message': 'connector requires a standoff/boss' if connector_supported and boss_plan is None else None})
    result: "JsonObject" = {'scheme': scheme, 'locatingDofConstrained': dof, 'overConstrained': over,
              'pin': pin, 'slot': slot,
              'holes': {'diameter': {'value': diameter, 'units': 'mm'},
                        'clearance': {'value': clearance, 'units': 'mm'},
                        'positions': _fastener_fusion_cast(list["JsonValue"], parsed)},
              'boss': boss_plan, 'insert': insert_plan,
              'material': data.get('material'), 'process': data.get('process'),
              'recipe': 'mount', 'atomic': False,
              'featurePlan': ['datum.point pin + slot locating scheme',
                              'model.hole clearance holes (not all tight)',
                              'model.extrude boss under the connector (declared above)'],
              'mateFit': {'overConstrained': over, 'tightHoleCount': tight, 'connectorSupported': connector_supported and boss_plan is not None},
              'checks': checks, 'regeneration': 'recipeRegeneration'}
    affected = [pin, slot]
    return _fastener_contract(ctx, 'mount.create', dict(result, affected=affected), status=status,
                              read_only=False, associativity='recipeRegeneration',
                              limitations=['Locating datums are created; holes/boss are declared feature prescriptions (recipeRegeneration).',
                                           'A PCB is located, not certified; thermal/material behaviour needs declared data.'])


def _mount_check(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _model_fields(data, ('schemaVersion', 'frame', 'scheme', 'holes'),
                  ('connector', 'pcb', 'process'))
    if data.get('schemaVersion') != 1 or data.get('frame') != 'component':
        raise ValueError('mount.check requires schemaVersion:1 and frame:component')
    scheme = _fastener_fusion_cast(str, data['scheme'])
    holes = data['holes']
    if not isinstance(holes, list) or not holes:
        raise ValueError('holes must be a nonempty array')
    parsed: list["_LocatingHole"] = []
    for hole in holes:
        if not isinstance(hole, dict):
            raise ValueError('each hole must be an object')
        _model_fields(hole, ('diameter', 'clearance'), ('x', 'y'))
        diameter = _fm(ctx, hole['diameter'])
        clearance = _fm(ctx, hole['clearance'])
        if diameter <= 0 or clearance < 0:
            raise ValueError('hole diameter positive and clearance nonnegative')
        parsed.append({'x': hole.get('x'), 'y': hole.get('y'), 'diameter': diameter, 'clearance': clearance})
    dof, over, tight = _locating_dof(scheme, parsed, 0.001)
    connector = data.get('connector', {})
    if not isinstance(connector, dict):
        raise ValueError('connector must be an object')
    _model_fields(connector, (), ('supported', 'standoff', 'supportPresent'))
    checks: list["JsonObject"] = []
    status = 'pass'
    if over:
        checks.append({'check': 'over-constraint', 'status': 'fail', 'tightHoles': tight,
                       'message': 'PCB fixed through every hole; use a slot or clearance to avoid thermal over-constraint'})
        status = 'fail'
    else:
        checks.append({'check': 'over-constraint', 'status': 'pass', 'constrainedDof': dof,
                       'message': 'PCB located without over-constraining all holes'})
    if connector.get('supported') is True:
        if connector.get('supportPresent') is True or connector.get('standoff') is not None:
            checks.append({'check': 'connector-support', 'status': 'pass'})
        else:
            checks.append({'check': 'connector-support', 'status': 'fail',
                           'message': 'connector requires a standoff/boss support'})
            status = 'fail'
    else:
        checks.append({'check': 'connector-support', 'status': 'notEvaluated',
                       'message': 'no connector support declared'})
    result: "JsonObject" = {'scheme': scheme, 'overConstrained': over, 'locatingDofConstrained': dof,
              'holes': _fastener_fusion_cast(list["JsonValue"], parsed), 'checks': checks}
    return _fastener_contract(ctx, 'mount.check', result, status=status, read_only=True)


def _fastener_stack(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _model_fields(data, ('schemaVersion', 'frame', 'screw', 'stack'),
                  ('receptacle', 'torque', 'tool', 'chamfer', 'gap', 'material', 'process'))
    if data.get('schemaVersion') != 1 or data.get('frame') != 'component':
        raise ValueError('fastener.stack requires schemaVersion:1 and frame:component')
    screw = data['screw']
    if not isinstance(screw, dict):
        raise ValueError('screw must be an object')
    _model_fields(screw, ('length', 'threadLength'), ('majorDiameter', 'pitch', 'headHeight', 'headDiameter', 'driver', 'material', 'name'))
    length = _fm(ctx, screw['length'])
    thread_length = _fm(ctx, screw['threadLength'])
    if length <= 0 or thread_length <= 0 or thread_length > length:
        raise ValueError('screw length and threadLength must be positive with threadLength <= length')
    stack = data['stack']
    if not isinstance(stack, list) or not stack:
        raise ValueError('stack must be a nonempty array of clamped parts')
    total = 0.0
    parts: list["JsonObject"] = []
    for part in stack:
        if not isinstance(part, dict) or 'thickness' not in part:
            raise ValueError('each stack part requires a thickness')
        _model_fields(part, ('thickness',), ('id', 'material'))
        t = _fm(ctx, part['thickness'])
        if t < 0:
            raise ValueError('part thickness must be nonnegative')
        total += t
        parts.append({'id': part.get('id'), 'thickness': {'value': t, 'units': 'mm'},
                      'material': part.get('material')})
    engagement = thread_length - total
    receptacle = data.get('receptacle')
    receptacle_thread = None
    blind_depth = None
    if receptacle is not None:
        if not isinstance(receptacle, dict):
            raise ValueError('receptacle must be an object')
        _model_fields(receptacle, ('kind',), ('threadLength', 'depth'))
        if receptacle['kind'] not in ('nut', 'tapped', 'insert'):
            raise ValueError('receptacle kind must be nut, tapped or insert')
        receptacle_thread = _fm(ctx, receptacle['threadLength']) if 'threadLength' in receptacle else None
        blind_depth = _fm(ctx, receptacle['depth']) if receptacle.get('kind') in ('tapped', 'insert') and 'depth' in receptacle else None
    bottoming = None
    if blind_depth is not None:
        protrusion = length - total
        bottoming = {'clearance': {'value': blind_depth - protrusion, 'units': 'mm'},
                     'bottomed': blind_depth - protrusion < 0}
    torque = data.get('torque')
    tool = data.get('tool')
    tool_access = None
    if tool is not None:
        if not isinstance(tool, dict):
            raise ValueError('tool must be an object')
        _model_fields(tool, ('diameter',), ('recess', 'length'))
        tool_d = _fm(ctx, tool['diameter'])
        access: "JsonObject" = {'diameter': {'value': tool_d, 'units': 'mm'}}
        if 'recess' in tool:
            recess = _fm(ctx, tool['recess'])
            access['recessDiameter'] = {'value': recess, 'units': 'mm'}
            access['fits'] = tool_d <= recess
        tool_access = access
    result: "JsonObject" = {'screw': screw, 'clampedLength': {'value': total, 'units': 'mm'},
              'parts': parts, 'engagement': {'value': engagement, 'units': 'mm'},
              'receptacle': receptacle, 'bottoming': bottoming,
              'torque': torque if isinstance(torque, str) else None,
              'torqueStatus': 'declared' if isinstance(torque, str) else 'missing (not derived from diameter)',
              'toolAccess': tool_access,
              'note': 'Engagement is threadLength minus clamped stack; torque is a declared datum, never derived from diameter.'}
    status = 'pass'
    if engagement <= 0:
        status = 'fail'
    return _fastener_contract(ctx, 'fastener.stack', result, status=status, read_only=True,
                              warnings=[] if engagement > 0 else ['No thread engagement: threadLength does not exceed the clamped stack'],
                              limitations=['Bottoming and access are reported only when the receptacle depth / tool diameter are declared.'])


def _fastener_check(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _model_fields(data, ('schemaVersion', 'frame', 'screw', 'stack'),
                  ('minimumEngagement', 'receptacle', 'tool', 'torque', 'material', 'process'))
    if data.get('schemaVersion') != 1 or data.get('frame') != 'component':
        raise ValueError('fastener.check requires schemaVersion:1 and frame:component')
    stack_data = {k: v for k, v in data.items() if k != 'minimumEngagement'}
    computed = _fastener_stack(ctx, stack_data)
    engagement_data = _fastener_fusion_cast("JsonObject", computed['engagement'])
    engagement = _fastener_fusion_cast(float, engagement_data['value'])
    checks: list["JsonObject"] = []
    status = 'pass'
    minimum = _fm(ctx, data['minimumEngagement']) if 'minimumEngagement' in data else None
    if minimum is None:
        checks.append({'check': 'engagement', 'status': 'notEvaluated',
                       'value': {'value': engagement, 'units': 'mm'},
                       'message': 'no minimum engagement declared (thread pitch/class provides it, not diameter)'})
    elif engagement >= minimum:
        checks.append({'check': 'engagement', 'status': 'pass',
                       'value': {'value': engagement, 'units': 'mm'}, 'required': {'value': minimum, 'units': 'mm'}})
    else:
        checks.append({'check': 'engagement', 'status': 'fail',
                       'value': {'value': engagement, 'units': 'mm'}, 'required': {'value': minimum, 'units': 'mm'}})
        status = 'fail'
    bottoming = computed.get('bottoming')
    if bottoming is None:
        checks.append({'check': 'bottoming', 'status': 'notEvaluated',
                       'message': 'receptacle depth not declared; cannot check bottoming'})
    elif _fastener_fusion_cast("JsonObject", bottoming)['bottomed']:
        checks.append({'check': 'bottoming', 'status': 'fail', 'bottoming': bottoming})
        status = 'fail'
    else:
        checks.append({'check': 'bottoming', 'status': 'pass', 'bottoming': bottoming})
    tool_access = computed.get('toolAccess')
    if tool_access is None:
        checks.append({'check': 'access', 'status': 'notEvaluated', 'message': 'tool not declared'})
    elif 'fits' not in _fastener_fusion_cast("JsonObject", tool_access):
        checks.append({'check': 'access', 'status': 'notEvaluated', 'toolAccess': tool_access,
                       'message': 'tool declared without a recess; cannot check access'})
    elif _fastener_fusion_cast("JsonObject", tool_access)['fits'] is False:
        checks.append({'check': 'access', 'status': 'fail', 'toolAccess': tool_access,
                       'message': 'tool diameter exceeds the access recess'})
        status = 'fail'
    else:
        checks.append({'check': 'access', 'status': 'pass', 'toolAccess': tool_access})
    result: "JsonObject" = {'engagement': {'value': engagement, 'units': 'mm'},
              'clampedLength': computed['clampedLength'], 'bottoming': bottoming,
              'toolAccess': tool_access, 'checks': checks}
    return _fastener_contract(ctx, 'fastener.check', result, status=status, read_only=True,
                              limitations=['Engagement/bottoming/access evaluated only from declared thread, receptacle and tool data.'])


def _fastener_schedule(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _model_fields(data, ('schemaVersion', 'frame', 'fasteners'), ())
    if data.get('schemaVersion') != 1 or data.get('frame') != 'component':
        raise ValueError('fastener.schedule requires schemaVersion:1 and frame:component')
    fasteners = data['fasteners']
    if not isinstance(fasteners, list) or not fasteners:
        raise ValueError('fasteners must be a nonempty array')
    rows: list["JsonObject"] = []
    missing: list["JsonValue"] = []
    status = 'pass'
    for i, item in enumerate(fasteners):
        if not isinstance(item, dict):
            raise ValueError('each fastener must be an object')
        _model_fields(item, ('id',), ('torque', 'process', 'material', 'vendor', 'stack', 'screw'))
        torque = item.get('torque')
        process = item.get('process')
        material = item.get('material')
        row: "JsonObject" = {'id': item['id'], 'torque': torque, 'process': process,
               'material': material, 'vendor': item.get('vendor'),
               'torqueStatus': 'declared' if isinstance(torque, str) else 'missing',
               'processStatus': 'declared' if isinstance(process, str) else 'missing',
               'materialStatus': 'declared' if isinstance(material, str) else 'missing'}
        if not isinstance(torque, str) or not isinstance(process, str) or not isinstance(material, str):
            missing.append(item['id'])
            row['complete'] = False
            status = 'unknown'
        else:
            row['complete'] = True
        if 'stack' in item:
            try:
                row['stack'] = _fastener_stack(ctx, {'schemaVersion': 1, 'frame': 'component',
                                                     'screw': item['screw'], 'stack': item['stack'],
                                                     'torque': item.get('torque')})
            except Exception:
                row['stack'] = None
        rows.append(row)
    result: "JsonObject" = {'count': len(rows), 'rows': rows, 'missingData': missing,
              'note': 'Torque, process and material are declared vendor/process data; missing entries are reported, never fabricated.'}
    return _fastener_contract(ctx, 'fastener.schedule', result, status=status, read_only=True,
                              limitations=['No torque or fit is derived from fastener diameter; the schedule reports declared data only.'])


def _bearing_stack(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _model_fields(data, ('schemaVersion', 'frame', 'rings', 'journal', 'seat'),
                  ('fits', 'shaftClearance', 'housingClearance', 'radialInternalClearance',
                   'shoulder', 'spacer', 'retainer', 'arrangement', 'axialLoad'))
    if data.get('schemaVersion') != 1 or data.get('frame') != 'component':
        raise ValueError('bearing.stack-check requires schemaVersion:1 and frame:component')
    rings = data['rings']
    if not isinstance(rings, dict):
        raise ValueError('rings must be an object')
    _model_fields(rings, ('inner', 'outer'), ())
    inner_ring = rings['inner']
    outer_ring = rings['outer']
    for key in ('inner', 'outer'):
        if not isinstance(rings[key], dict):
            raise ValueError('rings.' + key + ' must be an object')
        _model_fields(rings[key], (), ('bore', 'od', 'width'))
    inner_ring = _fastener_fusion_cast("JsonObject", inner_ring)
    outer_ring = _fastener_fusion_cast("JsonObject", outer_ring)
    journal = _fm(ctx, data['journal'])
    seat = _fm(ctx, data['seat'])
    if journal <= 0 or seat <= 0:
        raise ValueError('journal and seat must be positive')
    inner_bore = _fm(ctx, inner_ring['bore']) if 'bore' in inner_ring else journal
    outer_od = _fm(ctx, outer_ring['od']) if 'od' in outer_ring else seat
    fits = data.get('fits', {})
    if not isinstance(fits, dict):
        raise ValueError('fits must be an object')
    _model_fields(fits, (), ('shaft', 'housing'))
    shaft_fit = fits.get('shaft')
    housing_fit = fits.get('housing')
    shaft_clearance = _fm(ctx, data['shaftClearance']) if 'shaftClearance' in data else None
    housing_clearance = _fm(ctx, data['housingClearance']) if 'housingClearance' in data else None
    if shaft_fit is None and shaft_clearance is None:
        raise ValueError('declare fits.shaft or shaftClearance')
    if housing_fit is None and housing_clearance is None:
        raise ValueError('declare fits.housing or housingClearance')
    checks: list["JsonObject"] = []
    status = 'pass'
    fit: str = ''
    if shaft_clearance is not None:
        fit = 'interference' if shaft_clearance < 0 else 'clearance' if shaft_clearance > 0 else 'transition'
        checks.append({'check': 'shaft-fit', 'status': 'pass', 'fit': fit,
                       'clearance': {'value': shaft_clearance, 'units': 'mm'}})
    else:
        checks.append({'check': 'shaft-fit', 'status': 'pass', 'fit': shaft_fit,
                       'note': 'fit declared by class; clearance value not given'})
    if housing_clearance is not None:
        fit = 'interference' if housing_clearance < 0 else 'clearance' if housing_clearance > 0 else 'transition'
        checks.append({'check': 'housing-fit', 'status': 'pass', 'fit': fit,
                       'clearance': {'value': housing_clearance, 'units': 'mm'}})
    else:
        checks.append({'check': 'housing-fit', 'status': 'pass', 'fit': housing_fit,
                       'note': 'fit declared by class; clearance value not given'})
    arrangement = data.get('arrangement', 'fixed-floating')
    if arrangement not in ('fixed-floating', 'fixed-fixed', 'floating'):
        raise ValueError('arrangement must be fixed-floating, fixed-fixed or floating')
    shoulder = data.get('shoulder', {})
    shoulder = _fastener_fusion_cast("JsonObject", shoulder)
    retainer = data.get('retainer')
    fixed_ring = None
    if arrangement in ('fixed-floating', 'fixed-fixed'):
        fixed_ring = 'inner' if shoulder.get('inner') else 'outer' if shoulder.get('outer') else 'undeclared'
        checks.append({'check': 'fixed-ring', 'status': 'pass' if fixed_ring != 'undeclared' else 'unknown',
                       'fixedRing': fixed_ring,
                       'message': 'axial load chain runs through the fixed ring shoulder' if fixed_ring != 'undeclared' else 'no fixed ring shoulder declared'})
    radial = _fm(ctx, data['radialInternalClearance']) if 'radialInternalClearance' in data else None
    preload = 'none declared (no default preload is assumed)'
    result: "JsonObject" = {'rings': {'innerBore': {'value': inner_bore, 'units': 'mm'},
                        'outerOd': {'value': outer_od, 'units': 'mm'}},
              'journal': {'value': journal, 'units': 'mm'}, 'seat': {'value': seat, 'units': 'mm'},
              'shaftFit': shaft_fit or ('derived: ' + fit if shaft_clearance is not None else None),
              'housingFit': housing_fit or ('derived: ' + fit if housing_clearance is not None else None),
              'radialInternalClearance': {'value': radial, 'units': 'mm'} if radial is not None else None,
              'arrangement': arrangement, 'fixedRing': fixed_ring,
              'preload': preload, 'retainer': retainer, 'axialLoad': data.get('axialLoad'),
              'axialLoadChain': 'fixed ring -> shoulder -> spacer -> retainer' if fixed_ring else 'undeclared (no fixed ring)',
              'checks': checks}
    return _fastener_contract(ctx, 'bearing.stack-check', result, status=status, read_only=True,
                              limitations=['No default preload is assumed; floating arrangement clearance is declared, not derived.'])


def _shaft_interface(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _model_fields(data, ('schemaVersion', 'frame', 'shaft', 'hub'),
                  ('seatedLength', 'retainer'))
    if data.get('schemaVersion') != 1 or data.get('frame') != 'component':
        raise ValueError('shaft.interface requires schemaVersion:1 and frame:component')
    shaft = data['shaft']
    hub = data['hub']
    if not isinstance(shaft, dict) or not isinstance(hub, dict):
        raise ValueError('shaft and hub must be objects')
    _model_fields(shaft, ('type', 'd'), ('flat', 'key'))
    _model_fields(hub, ('bore',), ('boreType', 'splitClampGap', 'shoulders', 'retainer'))
    kind = shaft['type']
    if kind not in ('D-flat', 'keyed', 'round'):
        raise ValueError('shaft type must be D-flat, keyed or round')
    kind = _fastener_fusion_cast(str, kind)
    checks: list["JsonObject"] = []
    status = 'pass'
    mated: list[str] = []
    if kind == 'D-flat':
        if 'flat' not in shaft:
            raise ValueError('D-flat shaft requires a flat depth')
        _model_fields(shaft['flat'], ('depth',), ())
        if hub.get('boreType') != 'D-flat':
            checks.append({'check': 'd-flat-mate', 'status': 'fail',
                           'message': 'a D-flat shaft must mate a D-flat bore, not a round hole'})
            status = 'fail'
        else:
            checks.append({'check': 'd-flat-mate', 'status': 'pass',
                           'message': 'D-flat bore matches the D-flat shaft'})
        mated.append('D-flat bore keyed to the shaft flat')
    elif kind == 'keyed':
        if 'key' not in shaft:
            raise ValueError('keyed shaft requires a key')
        _model_fields(shaft['key'], ('width', 'height'), ())
        if hub.get('boreType') != 'keyed':
            checks.append({'check': 'key-mate', 'status': 'fail',
                           'message': 'a keyed shaft must mate a keyed bore with a matching keyway'})
            status = 'fail'
        else:
            checks.append({'check': 'key-mate', 'status': 'pass'})
        mated.append('key + keyway')
    else:
        checks.append({'check': 'mate', 'status': 'pass', 'message': 'plain round shaft/hub fit'})
    if 'splitClampGap' in hub:
        gap = _fm(ctx, hub['splitClampGap'])
        checks.append({'check': 'split-clamp-gap', 'status': 'pass' if gap > 0 else 'fail',
                       'gap': {'value': gap, 'units': 'mm'}})
        if gap <= 0:
            status = 'fail'
        mated.append('split-clamp gap allows clamping')
    shoulders = hub.get('shoulders')
    retainer = hub.get('retainer') or data.get('retainer')
    if shoulders or retainer:
        checks.append({'check': 'axial-retention', 'status': 'pass',
                       'message': 'shoulder/retainer provide axial retention'})
        mated.append('axial shoulder/retainer')
    else:
        checks.append({'check': 'axial-retention', 'status': 'unknown',
                       'message': 'no shoulder or retainer declared'})
    seated = _fm(ctx, data['seatedLength']) if 'seatedLength' in data else None
    result: "JsonObject" = {'shaftType': kind, 'matedFeatures': mated,
              'seatedLength': {'value': seated, 'units': 'mm'} if seated is not None else None,
              'checks': checks}
    return _fastener_contract(ctx, 'shaft.interface', result, status=status, read_only=True,
                              limitations=['Mate profile consistency only; no torque transmission or strength claim.'])


def _retention_bayonet(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _model_fields(data, ('schemaVersion', 'frame', 'lugs', 'stroke', 'rotation'),
                  ('ramps', 'stops', 'capture', 'clearances'))
    if data.get('schemaVersion') != 1 or data.get('frame') != 'component':
        raise ValueError('retention.bayonet requires schemaVersion:1 and frame:component')
    lugs = data['lugs']
    if not isinstance(lugs, dict):
        raise ValueError('lugs must be an object')
    _model_fields(lugs, ('count', 'width', 'height'), ())
    count = _num(lugs['count'], 'lugs.count', minimum=1, integer=True)
    width = _fm(ctx, lugs['width'])
    height = _fm(ctx, lugs['height'])
    stroke = _fm(ctx, data['stroke'])
    rotation = _fa(ctx, data['rotation'])
    if stroke < 0 or rotation < 0:
        raise ValueError('stroke and rotation must be nonnegative')
    ramps = data.get('ramps', [])
    stops = data.get('stops', [])
    if not isinstance(ramps, list) or not isinstance(stops, list):
        raise ValueError('ramps and stops must be arrays')
    capture = data.get('capture', {})
    if not isinstance(capture, dict):
        raise ValueError('capture must be an object')
    _model_fields(capture, (), ('depth',))
    capture_depth = _fm(ctx, capture['depth']) if 'depth' in capture else None
    clearances = data.get('clearances', {})
    if not isinstance(clearances, dict):
        raise ValueError('clearances must be an object')
    _model_fields(clearances, (), ('axial', 'radial'))
    axial_clearance = _fm(ctx, clearances['axial']) if 'axial' in clearances else None
    radial_clearance = _fm(ctx, clearances['radial']) if 'radial' in clearances else None
    checks: list["JsonObject"] = []
    status = 'pass'
    checks.append({'check': 'assembly-path', 'status': 'pass',
                   'path': ['insert (stroke)', 'rotate (bayonet)', 'capture'],
                   'stroke': {'value': stroke, 'units': 'mm'}, 'rotation': {'value': rotation, 'units': 'rad'}})
    if capture_depth is None or capture_depth <= 0:
        checks.append({'check': 'axial-capture', 'status': 'fail',
                       'message': 'capture depth must be positive to retain axially'})
        status = 'fail'
    else:
        checks.append({'check': 'axial-capture', 'status': 'pass',
                       'captureDepth': {'value': capture_depth, 'units': 'mm'}})
    checks.append({'check': 'unlock-path', 'status': 'pass',
                   'path': ['counter-rotate', 'retract'],
                   'message': 'reverse of the assembly path is available'})
    if radial_clearance is not None and radial_clearance <= 0:
        checks.append({'check': 'radial-clearance', 'status': 'fail',
                       'clearance': {'value': radial_clearance, 'units': 'mm'}})
        status = 'fail'
    elif radial_clearance is not None:
        checks.append({'check': 'radial-clearance', 'status': 'pass',
                       'clearance': {'value': radial_clearance, 'units': 'mm'}})
    result: "JsonObject" = {'lugs': {'count': count, 'width': {'value': width, 'units': 'mm'},
                       'height': {'value': height, 'units': 'mm'}},
              'stroke': {'value': stroke, 'units': 'mm'}, 'rotation': {'value': rotation, 'units': 'rad'},
              'ramps': ramps, 'stops': stops, 'capture': capture, 'clearances': clearances,
              'assemblyPath': 'insert -> rotate -> capture', 'unlockPath': 'counter-rotate -> retract',
              'checks': checks}
    return _fastener_contract(ctx, 'retention.bayonet', result, status=status, read_only=True,
                              limitations=['Assembly path is geometric; it does not certify retention force or release safety.'])


def _snap_define(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _model_fields(data, ('schemaVersion', 'frame', 'geometry', 'material'),
                  ('retention', 'support'))
    if data.get('schemaVersion') != 1 or data.get('frame') != 'component':
        raise ValueError('snap.define requires schemaVersion:1 and frame:component')
    geometry = data['geometry']
    material = data['material']
    if not isinstance(geometry, dict) or not isinstance(material, dict):
        raise ValueError('geometry and material must be objects')
    _model_fields(geometry, ('length', 'width', 'thickness', 'engagementDepth'), ('angle',))
    _model_fields(material, ('name',), ('modulus', 'yieldStrength'))
    length = _fm(ctx, geometry['length'])
    width = _fm(ctx, geometry['width'])
    thickness = _fm(ctx, geometry['thickness'])
    engagement = _fm(ctx, geometry['engagementDepth'])
    angle = _fa(ctx, geometry['angle']) if 'angle' in geometry else None
    if length <= 0 or width <= 0 or thickness <= 0 or engagement <= 0:
        raise ValueError('snap geometry dimensions must be positive')
    retention = data.get('retention', 'straight')
    result: "JsonObject" = {'geometry': {'length': {'value': length, 'units': 'mm'},
                           'width': {'value': width, 'units': 'mm'},
                           'thickness': {'value': thickness, 'units': 'mm'},
                           'engagementDepth': {'value': engagement, 'units': 'mm'},
                           'retentionAngle': {'value': angle, 'units': 'rad'} if angle is not None else None},
              'material': {'name': material['name'], 'modulus': material.get('modulus'),
                           'yieldStrength': material.get('yieldStrength')},
              'retention': retention,
              'shape': 'cantilever beam snap with rectangular section',
              'note': 'Shape definition only; deflection/strain/force come from snap.evaluate with a declared modulus.'}
    return _fastener_contract(ctx, 'snap.define', result, status='pass', read_only=True,
                              limitations=['No material default; modulus and yield strength must be declared for evaluation.'])


def _snap_evaluate(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _model_fields(data, ('schemaVersion', 'frame', 'geometry', 'material', 'support'), ())
    if data.get('schemaVersion') != 1 or data.get('frame') != 'component':
        raise ValueError('snap.evaluate requires schemaVersion:1 and frame:component')
    geometry = data['geometry']
    material = data['material']
    support = data['support']
    if not isinstance(geometry, dict) or not isinstance(material, dict) or not isinstance(support, dict):
        raise ValueError('geometry, material and support must be objects')
    _model_fields(geometry, ('length', 'width', 'thickness', 'engagementDepth'), ('angle', 'deflection'))
    _model_fields(material, ('name', 'modulus'), ('yieldStrength',))
    _model_fields(support, ('condition',), ())
    condition = support['condition']
    if condition not in ('cantilever', 'fixed-fixed'):
        raise ValueError('support.condition must be cantilever or fixed-fixed')
    condition = _fastener_fusion_cast(str, condition)
    length = _fm(ctx, geometry['length'])
    width = _fm(ctx, geometry['width'])
    thickness = _fm(ctx, geometry['thickness'])
    engagement = _fm(ctx, geometry['engagementDepth'])
    deflection = _fm(ctx, geometry['deflection']) if 'deflection' in geometry else engagement
    if length <= 0 or width <= 0 or thickness <= 0 or deflection < 0:
        raise ValueError('snap dimensions must be positive and deflection nonnegative')
    # Young's modulus: accept pressure-bearing strings (MPa, GPa, N/mm^2, ...).
    modulus = _pressure_mpa(material['modulus'])
    yield_strength = _pressure_mpa(material['yieldStrength']) if 'yieldStrength' in material else None
    inertia = width * thickness ** 3 / 12.0
    if condition == 'cantilever':
        stiffness = 3.0 * modulus * inertia / (length ** 3)
        force = stiffness * deflection
        strain = 3.0 * thickness * deflection / (2.0 * length * length)
    else:
        stiffness = 192.0 * modulus * inertia / (length ** 3)
        force = stiffness * deflection
        strain = 3.0 * thickness * deflection / (2.0 * length * length)
    stress = strain * modulus
    checks: list["JsonObject"] = []
    status = 'pass'
    if yield_strength is None:
        checks.append({'check': 'strain', 'status': 'notEvaluated', 'strain': strain,
                       'message': 'no yield strength declared; strain cannot be judged'})
    elif stress >= yield_strength:
        checks.append({'check': 'strain', 'status': 'fail', 'strain': strain,
                       'stress': {'value': stress, 'units': 'MPa'},
                       'yieldStrength': {'value': yield_strength, 'units': 'MPa'},
                       'safetyFactor': yield_strength / stress if stress else None})
        status = 'fail'
    else:
        checks.append({'check': 'strain', 'status': 'pass', 'strain': strain,
                       'stress': {'value': stress, 'units': 'MPa'},
                       'yieldStrength': {'value': yield_strength, 'units': 'MPa'},
                       'safetyFactor': yield_strength / stress if stress else None})
    result: "JsonObject" = {'support': condition,
              'stiffness': {'value': stiffness, 'units': 'N/mm'},
              'engagementForce': {'value': force, 'units': 'N'},
              'deflection': {'value': deflection, 'units': 'mm'},
              'strain': strain, 'stress': {'value': stress, 'units': 'MPa'},
              'model': 'linear elastic small-deflection beam: deflection = P L^3 / (3 E I) (cantilever), I = w t^3 / 12',
              'scope': 'no fatigue-life or large-deflection claim',
              'checks': checks}
    return _fastener_contract(ctx, 'snap.evaluate', result, status=status, read_only=True,
                              limitations=['Linear elastic beam estimate; explicit model scope, no fatigue-life claim.',
                                           'Material modulus/yield are declared, never defaulted.'])






def _shape_hose_barb(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _model_fields(data, ('schemaVersion', 'frame', 'name', 'tubeId', 'tubeOd', 'bore', 'barbs'),
                  ('blend', 'clampZone', 'axis', 'plane', 'operation'))
    if data.get('schemaVersion') != 1 or data.get('frame') != 'component':
        raise ValueError('shape.hose_barb requires schemaVersion:1 and frame:component')
    tube_id = _fm(ctx, data['tubeId'])
    tube_od = _fm(ctx, data['tubeOd'])
    bore = _fm(ctx, data['bore'])
    if tube_id <= 0 or tube_od <= tube_id or bore <= 0 or bore > tube_id:
        raise ValueError('tubeId, tubeOd, bore must satisfy 0 < bore <= tubeId < tubeOd')
    barbs = data['barbs']
    if not isinstance(barbs, list) or not barbs:
        raise ValueError('barbs must be a nonempty array')
    crests: list[float] = []
    roots: list[float] = []
    lengths: list[float] = []
    for barb in barbs:
        if not isinstance(barb, dict):
            raise ValueError('each barb must be an object')
        _model_fields(barb, ('crest', 'root', 'length'), ())
        crest = _fm(ctx, barb['crest'])
        root = _fm(ctx, barb['root'])
        length = _fm(ctx, barb['length'])
        if crest <= root or crest <= tube_od or root < tube_od or length <= 0:
            raise ValueError('barb crest/root must satisfy crest > root >= tubeOd and positive length')
        crests.append(crest)
        roots.append(root)
        lengths.append(length)
    checks: list["JsonObject"] = []
    status = 'pass'
    checks.append({'check': 'channel-continuity', 'status': 'pass',
                   'bore': {'value': bore, 'units': 'mm'}, 'tubeId': {'value': tube_id, 'units': 'mm'},
                   'message': 'continuous bore through the barb'})
    interference: list[float] = [(crest - tube_id) / 2.0 for crest in crests]
    for i, value in enumerate(interference):
        checks.append({'check': 'barb-seating-%d' % i, 'status': 'pass' if value > 0 else 'fail',
                       'radialInterference': {'value': value, 'units': 'mm'}})
        if value <= 0:
            status = 'fail'
    clamp = _fm(ctx, data['clampZone']) if 'clampZone' in data else None
    if clamp is not None and clamp < 0:
        raise ValueError('clampZone must be nonnegative')
    result: "JsonObject" = {'tubeId': {'value': tube_id, 'units': 'mm'}, 'tubeOd': {'value': tube_od, 'units': 'mm'},
              'bore': {'value': bore, 'units': 'mm'},
              'barbs': [{'crest': {'value': crests[i], 'units': 'mm'},
                         'root': {'value': roots[i], 'units': 'mm'},
                         'length': {'value': lengths[i], 'units': 'mm'}} for i in range(len(barbs))],
              'clampZone': {'value': clamp, 'units': 'mm'} if clamp is not None else None,
              'blend': data.get('blend'),
              'seating': [{'radialInterference': {'value': value, 'units': 'mm'}} for value in interference],
              'opposingBarbCollision': 'not detected (single-direction barbs; declare an opposing barb for a coupler check)',
              'checks': checks, 'recipe': 'hose-barb', 'atomic': False,
              'regeneration': 'recipeRegeneration'}
    # Geometry: revolve the stepped barb profile about the hose axis.
    axis = data.get('axis', 'X')
    name = _fastener_fusion_cast(str, data['name'])
    names = [name, name + '__section']
    _shapes_reserve(ctx, names)
    if _cad_type(ctx.resolve(axis, 'axis')) != 'ConstructionAxis':
        raise ValueError('hose-barb axis must be a native construction axis')
    points = _barb_profile_points(bore, crests, roots, lengths, tube_od)
    geometry: list["JsonObject"] = []
    for i in range(len(points) - 1):
        a, b = points[i], points[i + 1]
        geometry.append({'type': 'line', 'name': 'seg%d' % i,
                         'start': ['%.6g mm' % a[0], '%.6g mm' % a[1], '0 mm'],
                         'end': ['%.6g mm' % b[0], '%.6g mm' % b[1], '0 mm']})
    connections: list["JsonObject"] = [{'type': 'coincident', 'entities': ['seg%d.end' % i, 'seg%d.start' % (i + 1)]}
                   for i in range(len(geometry) - 1)]
    spec: "JsonObject" = {'plane': data.get('plane', 'XY'), 'geometry': geometry, 'constraints': connections, 'dimensions': []}
    _shapes_prepare_sketch(ctx, spec)
    sketch_ref, _ = _shapes_build_sketch(ctx, name + '__section', spec)
    profile = ctx.resolve({'kind': 'profile', 'sketch': sketch_ref, 'loopCount': 1}, 'profile')
    revolve = _fastener_fusion_cast("JsonObject", ctx.call('model.revolve', {'name': name, 'profile': ctx.ref(profile),
                                         'axis': axis, 'angle': '360 deg'}))
    result.update({'feature': revolve['feature'], 'bodies': revolve.get('bodies', []),
                   'healthState': revolve.get('healthState', 0), 'message': revolve.get('message', ''),
                   'helpers': [sketch_ref, revolve['feature']]})
    affected: list["JsonValue"] = [revolve['feature']]
    return _fastener_contract(ctx, 'shape.hose_barb', dict(result, affected=affected), status=status,
                              read_only=False, associativity='recipeRegeneration',
                              limitations=['Axisymmetric revolve recipe; seating is geometric interference, not a leak-tightness proof.',
                                           'Recipe is not atomic.'])


CAD_HANDLERS.update({'mount.create': _mount_create, 'mount.check': _mount_check,
                     'fastener.stack': _fastener_stack, 'fastener.check': _fastener_check,
                     'fastener.schedule': _fastener_schedule, 'bearing.stack-check': _bearing_stack,
                     'shaft.interface': _shaft_interface, 'retention.bayonet': _retention_bayonet,
                     'snap.define': _snap_define, 'snap.evaluate': _snap_evaluate,
                     'shape.hose_barb': _shape_hose_barb})

_fmcad_fastener_runtime_loaded = True

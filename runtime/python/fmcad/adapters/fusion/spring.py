"""GM12: helical curve generation, spring recipes and spring engineering evaluations.

``curve helix`` generates a real helical centerline (numeric recipe + NURBS, never a
native Coil) with an optional section sweep. ``shape.helix`` is re-owned here for
generation while the legacy existing-path sweep stays in shapes.py (delegated).
``shape spring`` composes the helix with a wire section; ground/plain ends are
recipe representations only (no native end-coil geometry is cut or generated).
``spring evaluate`` / ``spring configure`` are read-only engineering evaluations.

All spring quantities are computed in mm/N/mm/MPa so the P054 fixture reproduces
exactly; length expressions still enter through the shared Fusion expression context.
"""
import math as _spring_fusion_math
from collections.abc import Mapping as _spring_fusion_Mapping

if hasattr(CAD_HANDLERS, 'owner'):
    CAD_HANDLERS.owner = 'spring'
import re as _spring_fusion_re
from typing import TypedDict as _spring_fusion_TypedDict
from typing import cast as _spring_fusion_cast

import adsk.core as _spring_fusion_core
import adsk.fusion as _spring_sdk_fusion


class _SpringGeometry(_spring_fusion_TypedDict):
    wireDiameter: float
    meanDiameter: float
    activeCoils: float
    totalCoils: float
    freeLength: float
    solidHeight: float
    pitch: float
    endStyle: str
    shearModulus: float
    density: float
    wireLength: float
    mass: float
    stiffness: float | None
    volume: float

_SPRING_LENGTHS_MM = {'mm': 1.0, 'cm': 10.0, 'm': 1000.0, 'in': 25.4, 'ft': 304.8}
_SPRING_PRESSURE_MPA = {'Pa': 1e-6, 'kPa': 1e-3, 'MPa': 1.0, 'GPa': 1e3,
                        'N/mm^2': 1.0, 'N/mm2': 1.0, 'N/m^2': 1e-6,
                        'psi': 0.006894757293168, 'ksi': 6.894757293168}
_SPRING_DENSITY_KGPM3 = {'kg/m^3': 1.0, 'kg/m3': 1.0, 'g/cm^3': 1000.0, 'g/cm3': 1000.0,
                         'kg/mm^3': 1e9, 'kg/mm3': 1e9, 'lb/in^3': 27679.904710203,
                         'lb/in3': 27679.904710203}






def _spring_length(ctx: "CadContext", expression: object) -> float:
    return ctx.length(expression) * 10.0


def _spring_contract(ctx: "CadContext", operation: str,
                     result: _spring_fusion_Mapping[str, "JsonValue"],
                     status: str = 'pass', read_only: bool = False,
                     associativity: str | None = None,
                     warnings: list[str] | None = None,
                     limitations: list[str] | None = None,
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
    affected = list(_spring_fusion_cast(list["JsonValue"], result_values.pop('affected', [])))
    out: "JsonObject" = _spring_fusion_cast("JsonObject", dict(schemaVersion=1, operation=operation, status=status, success=status == 'pass',
                documentIdentity=identity,
                units={'length': 'cm', 'angle': 'rad', 'pressure': 'MPa', 'mass': 'kg', 'stiffness': 'N/mm'},
                frame={'space': 'component', 'component': component},
                associativity=associativity or ('snapshot' if read_only else 'recipeRegeneration'),
                 warnings=list(warnings or []),
                method='GM12 helix/spring generation and engineering evaluation',
                 limitations=['BRep recipe; native Coil is never claimed or substituted.'] + list(limitations or []),
                provenance={'requirement': 'GM12', 'source': 'docs/HELIX_SPRING.md'},
                  affected=affected))
    out.update(extra)
    out.update(result_values)
    return out


def _helix_frame(ctx: "CadContext", data: "JsonObject") -> "_SpringFrame":
    """Return (origin_mm, (ux, uy, uz)) for the helix axis; default is +Z at the origin."""
    axis = data.get('axis')
    if axis is None:
        return (0.0, 0.0, 0.0), ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0))
    if isinstance(axis, dict):
        axis_data = axis
        _model_fields(axis_data, ('direction',), ('origin',))
        origin_values = _spring_fusion_cast(list["JsonValue"], axis_data.get('origin', ['0 mm', '0 mm', '0 mm']))
        origin = tuple(_spring_length(ctx, value) for value in origin_values)
        direction = _cad_direction(axis_data['direction'])
    else:
        entity = ctx.resolve(axis, 'axis')
        geometry = entity.geometry
        origin = (float(geometry.origin.x) * 10.0, float(geometry.origin.y) * 10.0, float(geometry.origin.z) * 10.0)
        direction = _cad_direction([float(geometry.direction.x), float(geometry.direction.y), float(geometry.direction.z)])
    uz = direction
    reference = (0.0, 0.0, 1.0) if abs(uz[2]) < 0.9 else (1.0, 0.0, 0.0)
    ux = [reference[1] * uz[2] - reference[2] * uz[1],
          reference[2] * uz[0] - reference[0] * uz[2],
          reference[0] * uz[1] - reference[1] * uz[0]]
    norm = _spring_fusion_math.hypot(*ux)
    ux = [c / norm for c in ux]
    uy = [uz[1] * ux[2] - uz[2] * ux[1], uz[2] * ux[0] - uz[0] * ux[2], uz[0] * ux[1] - uz[1] * ux[0]]
    return origin, (ux, uy, uz)


def _helix_parameters(ctx: "CadContext", data: "JsonObject") -> "_SpringParameters":
    """Validate the pitch vs turns+height exclusivity and return dimensionless floats."""
    radius = _spring_length(ctx, data['radius'])
    if radius <= 0:
        raise ValueError('radius must be positive')
    hand = data.get('hand', 'right')
    if hand not in ('right', 'left'):
        raise ValueError('hand must be right or left')
    hand = _spring_fusion_cast(str, hand)
    start_phase = ctx.angle(data.get('startPhase', '0 deg'))
    has_pitch, has_turns, has_height = 'pitch' in data, 'turns' in data, 'height' in data
    if has_pitch and has_height:
        raise ValueError('pitch and height are contradictory; height equals pitch times turns')
    if has_pitch:
        pitch = _spring_length(ctx, data['pitch'])
        if pitch <= 0:
            raise ValueError('pitch must be positive')
        turns = _spring_number(data.get('turns', 1), 'turns', minimum=0.0)
        height = pitch * turns
    else:
        if not has_turns or not has_height:
            raise ValueError('Supply pitch, or both turns and height')
        turns = _spring_number(data['turns'], 'turns', minimum=0.0)
        height = _spring_length(ctx, data['height'])
        if height <= 0:
            raise ValueError('height must be positive')
        pitch = height / turns
    return {'radius': radius, 'pitch': pitch, 'turns': turns, 'height': height,
            'hand': hand, 'startPhase': start_phase}








def _helix_model(ctx: "CadContext", data: "JsonObject") -> tuple[
        "_SpringParameters", "_SpringFrame", list[list[float]], "_SpringMetrics"]:
    params = _helix_parameters(ctx, data)
    frame = _helix_frame(ctx, data)
    samples = _helix_world_points(params, frame)
    metrics = _helix_metrics(params)
    return params, frame, samples, metrics


def _helix_curve(ctx: "CadContext", data: "JsonObject", operation: str) -> "JsonObject":
    _model_fields(data, ('schemaVersion', 'frame', 'radius'),
                  ('axis', 'pitch', 'turns', 'height', 'hand', 'startPhase', 'tolerance',
                   'section', 'name', 'operation', 'representation', 'maxSamples'))
    if data.get('schemaVersion') != 1 or data.get('frame') != 'component':
        raise ValueError('GM12 helix generation requires schemaVersion:1 and frame:component')
    representation = data.get('representation', 'recipe')
    if representation not in ('recipe', 'native'):
        raise ValueError('representation must be recipe or native')
    tolerance = _spring_length(ctx, data.get('tolerance', '0.01 mm'))
    if tolerance <= 0:
        raise ValueError('tolerance must be positive')
    max_samples = data.get('maxSamples', 10000)
    if not isinstance(max_samples, int) or not 4 <= max_samples <= 100000:
        raise ValueError('maxSamples must be an integer in 4..100000')
    params, frame, samples, metrics = _helix_model(ctx, data)
    result: "JsonObject" = {'radius': {'value': params['radius'], 'units': 'mm'},
              'pitch': {'value': params['pitch'], 'units': 'mm'},
              'turns': params['turns'], 'height': {'value': params['height'], 'units': 'mm'},
              'hand': params['hand'], 'startPhase': {'value': params['startPhase'], 'units': 'rad'},
              'arcLength': {'value': metrics['arcLength'], 'units': 'mm'},
              'curvature': {'value': metrics['curvature'], 'units': '1/mm'},
              'curvatureRadius': {'value': metrics['curvatureRadius'], 'units': 'mm'},
              'turnLength': {'value': metrics['turnLength'], 'units': 'mm'},
              'samplePoints': [[{'value': v, 'units': 'mm'} for v in p] for p in samples],
              'sampleCount': len(samples), 'tolerance': {'value': tolerance, 'units': 'mm'},
              'representation': representation, 'nativeCoil': False}
    if representation == 'native':
        return _spring_contract(ctx, operation, result, status='blocked', read_only=False,
                                associativity='recipeRegeneration',
                                warnings=['Native Coil/helix path persistence is not exposed by the installed SDK'],
                                limitations=['No persistent expression-driven helical curve feature exists in the public API; '
                                             'native representation is blocked, recipe is returned instead.'])
    swept: "JsonObject | None" = None
    if 'section' in data:
        section = ctx.resolve(data['section'], 'profile')
        swept = {'section': ctx.ref(section), 'sweep': 'recipe', 'pending': True,
                 'note': 'Section sweep requires a persistent 3D helical path; see docs/HELIX_SPRING.md for the native gap.'}
        result['sectionSweep'] = swept
    affected: list["JsonValue"] = [] if swept is None else [swept['section']]
    return _spring_contract(ctx, operation, dict(result, affected=affected), status='pass',
                            read_only=False, associativity='recipeRegeneration',
                            limitations=['Sampled helix plus fitted NURBS recipe; native Coil is not substituted.',
                                         'Native persistent 3D path insertion is a declared gap (see docs).'])


def curve_helix(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    return _helix_curve(ctx, data, 'curve.helix')


def shape_helix(ctx: "CadContext", data: "JsonObject") -> "JsonValue":
    if 'path' in data:
        return _spring_fusion_cast("CadHandler", _shape_helix_legacy)(ctx, data)
    return _helix_curve(ctx, data, 'shape.helix')


def _spring_geometry(ctx: "CadContext", data: "JsonObject") -> _SpringGeometry:
    _model_fields(data, ('schemaVersion', 'frame', 'wireDiameter', 'meanDiameter',
                         'activeCoils', 'totalCoils', 'freeLength'),
                  ('material', 'shearModulus', 'density', 'endStyle', 'transition',
                   'operation', 'section', 'hand', 'name', 'installedLength', 'compressedLength',
                   'deflection', 'guide'))
    if data.get('schemaVersion') != 1 or data.get('frame') != 'component':
        raise ValueError('GM12 spring evaluation requires schemaVersion:1 and frame:component')
    wire = _spring_length(ctx, data['wireDiameter'])
    mean = _spring_length(ctx, data['meanDiameter'])
    if wire <= 0 or mean <= 0 or mean <= wire:
        raise ValueError('wireDiameter and meanDiameter must be positive with meanDiameter > wireDiameter')
    active = _spring_number(data['activeCoils'], 'activeCoils', minimum=0.0)
    total = _spring_number(data['totalCoils'], 'totalCoils', minimum=0.0)
    if total < active:
        raise ValueError('totalCoils must be at least activeCoils')
    free = _spring_length(ctx, data['freeLength'])
    if free <= 0:
        raise ValueError('freeLength must be positive')
    end_style = data.get('endStyle', 'plain')
    if end_style not in ('plain', 'ground', 'open'):
        raise ValueError('endStyle must be plain, ground or open')
    end_style = _spring_fusion_cast(str, end_style)
    shear = _spring_measure(data.get('shearModulus'), _SPRING_PRESSURE_MPA, 'shearModulus', default=79000.0)
    density = _spring_measure(data.get('density'), _SPRING_DENSITY_KGPM3, 'density', default=7850.0)
    radius = mean / 2.0
    solid = total * wire
    if free <= solid:
        raise ValueError('freeLength must exceed solid height (totalCoils * wireDiameter)')
    pitch = (free - wire) / active if active > 0 else 0.0
    params = _spring_fusion_cast("_SpringParameters", {
        'radius': radius, 'pitch': pitch, 'turns': total, 'height': pitch * total,
        'hand': _spring_fusion_cast(str, data.get('hand', 'right')), 'startPhase': 0.0})
    metrics = _helix_metrics(params)
    wire_length = metrics['arcLength']
    cross_section = _spring_fusion_math.pi * wire ** 2 / 4.0
    volume = wire_length * cross_section
    mass = volume * density * 1e-9  # mm^3 -> m^3 -> kg
    stiffness = shear * wire ** 4 / (8.0 * mean ** 3 * active) if active > 0 else None
    return _spring_fusion_cast(_SpringGeometry, {'wireDiameter': wire, 'meanDiameter': mean, 'activeCoils': active, 'totalCoils': total,
            'freeLength': free, 'solidHeight': solid, 'pitch': pitch, 'endStyle': end_style,
            'shearModulus': shear, 'density': density, 'wireLength': wire_length, 'mass': mass,
            'stiffness': stiffness, 'volume': volume})


def shape_spring(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    name = data.get('name')
    if not isinstance(name, str) or not name.strip():
        raise ValueError('shape.spring requires a nonempty name')
    geometry = _spring_geometry(ctx, data)
    made: list["JsonObject"] = []
    helix = _spring_fusion_cast("JsonObject", ctx.call('curve.helix', {'schemaVersion': 1, 'frame': 'component',
                                     'radius': str(geometry['meanDiameter'] / 2.0) + ' mm',
                                     'turns': data['totalCoils'],
                                     'height': str(geometry['pitch'] * geometry['totalCoils']) + ' mm',
                                     'hand': data.get('hand', 'right')}))
    made.append(helix)
    if 'section' in data:
        sweep = _spring_fusion_cast("JsonObject", ctx.call('model.sweep', {'profile': data['section'], 'path': {'curves': [helix], 'chain': 'none'},
                                     'operation': data.get('operation', 'newBody'), 'name': name}))
        made.append(sweep)
    solid_margin = geometry['freeLength'] - geometry['solidHeight']
    result = {'geometry': made,
              'outerDiameter': {'value': geometry['meanDiameter'] + geometry['wireDiameter'], 'units': 'mm'},
              'innerDiameter': {'value': geometry['meanDiameter'] - geometry['wireDiameter'], 'units': 'mm'},
              'wireLength': {'value': geometry['wireLength'], 'units': 'mm'},
              'mass': {'value': geometry['mass'], 'units': 'kg'},
              'volume': {'value': geometry['volume'], 'units': 'mm^3'},
              'solidHeight': {'value': geometry['solidHeight'], 'units': 'mm'},
              'solidHeightMargin': {'value': solid_margin, 'units': 'mm'},
              'pitch': {'value': geometry['pitch'], 'units': 'mm'},
              'stiffness': {'value': geometry['stiffness'], 'units': 'N/mm'} if geometry['stiffness'] is not None else None,
              'endStyle': geometry['endStyle'], 'representation': 'recipe', 'nativeCoil': False,
              'assumptions': ['Stiffness uses active coils; solid height and mass use total coils plus wire diameter.',
                              'Ground/plain end styles are recipe representations only; no native end-coil geometry is cut or generated (declared native Coil gap).',
                              'Shear modulus default is a placeholder unless explicitly supplied.']}
    affected = [m.get('feature') for m in made if m.get('feature') is not None]
    return _spring_contract(ctx, 'shape.spring', dict(result, affected=affected), status='pass',
                            read_only=False, associativity='recipeRegeneration',
                            limitations=['Recipe is not atomic; kernel failures can leave the helix helper.',
                                         'Ground-end geometry and the wire-section sweep require a persistent native 3D helical path, which is a declared gap (see docs/HELIX_SPRING.md).'])


def spring_evaluate(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    geometry = _spring_geometry(ctx, data)
    installed = _spring_length(ctx, data['installedLength']) if 'installedLength' in data else geometry['freeLength']
    compressed = None
    if 'compressedLength' in data:
        compressed = _spring_length(ctx, data['compressedLength'])
    elif 'deflection' in data:
        compressed = geometry['freeLength'] - _spring_length(ctx, data['deflection'])
    k = _spring_fusion_cast(float, geometry['stiffness'])
    forces: list["JsonObject"] = []
    if compressed is not None:
        if compressed < geometry['solidHeight']:
            raise ValueError('compressedLength is below solid height; material volume would change silently')
        forces.append({'state': 'compressed', 'deflection': {'value': geometry['freeLength'] - compressed, 'units': 'mm'},
                       'force': {'value': k * (geometry['freeLength'] - compressed), 'units': 'N'}})
    if installed != geometry['freeLength']:
        forces.append({'state': 'installed', 'deflection': {'value': geometry['freeLength'] - installed, 'units': 'mm'},
                       'force': {'value': k * (geometry['freeLength'] - installed), 'units': 'N'}})
    result = {'stiffness': {'value': k, 'units': 'N/mm'},
              'wireLength': {'value': geometry['wireLength'], 'units': 'mm'},
              'mass': {'value': geometry['mass'], 'units': 'kg'},
              'solidHeight': {'value': geometry['solidHeight'], 'units': 'mm'},
              'solidHeightMargin': {'value': geometry['freeLength'] - geometry['solidHeight'], 'units': 'mm'},
              'freeLength': {'value': geometry['freeLength'], 'units': 'mm'},
              'installedLength': {'value': installed, 'units': 'mm'},
              'compressedLength': {'value': compressed, 'units': 'mm'} if compressed is not None else None,
              'pitch': {'value': geometry['pitch'], 'units': 'mm'},
              'forces': forces,
              'model': {'stiffness': 'G * d^4 / (8 * D^3 * n)', 'activeCoilsUsed': True,
                        'solidHeight': 'totalCoils * wireDiameter', 'notes': 'Linear spring model; no buckling/fatigue. Active coils drive stiffness, total coils drive mass and solid height.'}}
    return _spring_contract(ctx, 'spring.evaluate', result, status='pass', read_only=True)


def spring_configure(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    geometry = _spring_geometry(ctx, data)
    checks: list["JsonObject"] = []
    status = 'pass'
    if 'compressedLength' in data:
        compressed = _spring_length(ctx, data['compressedLength'])
        if compressed < geometry['solidHeight']:
            checks.append({'check': 'material-volume', 'status': 'fail',
                           'message': 'compressedLength below solid height would silently change material volume'})
            status = 'fail'
        else:
            checks.append({'check': 'material-volume', 'status': 'pass',
                           'margin': {'value': compressed - geometry['solidHeight'], 'units': 'mm'}})
    if 'guide' in data:
        guide = data['guide']
        if not isinstance(guide, dict) or not guide.get('diameter'):
            raise ValueError('guide requires a diameter')
        guide_diameter = _spring_length(ctx, guide['diameter'])
        inner = geometry['meanDiameter'] - geometry['wireDiameter']
        outer = geometry['meanDiameter'] + geometry['wireDiameter']
        kind = _spring_fusion_cast(str, guide.get('kind', 'rod'))
        if kind == 'rod':
            clearance = inner - guide_diameter
            checks.append({'check': 'guide-rod', 'status': 'pass' if clearance > 0 else 'fail',
                           'clearance': {'value': clearance, 'units': 'mm'}})
            status = 'fail' if clearance <= 0 else status
        elif kind == 'tube':
            clearance = guide_diameter - outer
            checks.append({'check': 'guide-tube', 'status': 'pass' if clearance > 0 else 'fail',
                           'clearance': {'value': clearance, 'units': 'mm'}})
            status = 'fail' if clearance <= 0 else status
        else:
            raise ValueError('guide kind must be rod or tube')
    if geometry['freeLength'] / geometry['meanDiameter'] > 4.0:
        checks.append({'check': 'slenderness', 'status': 'unknown',
                       'message': 'freeLength/meanDiameter exceeds 4; a guide is recommended (stiffness formula does not certify lateral stability)'})
    result = {'configuredState': {'solidHeight': {'value': geometry['solidHeight'], 'units': 'mm'},
                                  'solidHeightMargin': {'value': geometry['freeLength'] - geometry['solidHeight'], 'units': 'mm'},
                                  'installedLength': {'value': _spring_length(ctx, data['installedLength']), 'units': 'mm'} if 'installedLength' in data else None,
                                  'compressedLength': {'value': _spring_length(ctx, data['compressedLength']), 'units': 'mm'} if 'compressedLength' in data else None},
              'checks': checks}
    return _spring_contract(ctx, 'spring.configure', result, status=status, read_only=True,
                            limitations=['Linear model only; no buckling, fatigue or lateral-stability certification.'])


# Override shape.helix for generation while shapes.py retains the existing-path sweep.
_shape_helix_legacy = CAD_HANDLERS.get('shape.helix')
if _shape_helix_legacy is None:
    def _shape_helix_unavailable(ctx: "CadContext", data: "JsonObject") -> "JsonValue":
        raise ValueError('shape.helix existing-path sweep is unavailable')
    _shape_helix_legacy = _shape_helix_unavailable

CAD_HANDLERS.update({'curve.helix': curve_helix, 'shape.spring': shape_spring,
                     'spring.evaluate': spring_evaluate, 'spring.configure': spring_configure})
CAD_HANDLERS['shape.helix'] = shape_helix

_fmcad_spring_runtime_loaded = True

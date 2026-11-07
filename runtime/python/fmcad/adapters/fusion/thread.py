"""GM13: thread catalog, custom profiles, pair checks and the model.thread extension.

Tabular (native ThreadInfo) threads stay in model.py and are delegated unchanged.
Custom (non-tabular) profiles get an explicit BRep recipe representation, never a
visual texture, with lead = starts * pitch; the modeled helical tooth is a
declared native gap (no persistent Coil/helical-path API). See docs/THREADS.md.
"""
import math as _thread_fusion_math
from collections.abc import Iterable as _thread_fusion_Iterable, Mapping as _thread_fusion_Mapping
from typing import cast as _thread_fusion_cast

if hasattr(CAD_HANDLERS, 'owner'):
    CAD_HANDLERS.owner = 'thread'
import re as _thread_fusion_re

import adsk.core as _thread_fusion_core
import adsk.fusion as _thread_sdk_fusion

# Curated ISO metric coarse subset. Nominal diameters and pitch in mm.
_ISO_METRIC_COARSE = {
    'M3': 3.0, 'M4': 4.0, 'M5': 5.0, 'M6': 6.0, 'M8': 8.0, 'M10': 10.0, 'M12': 12.0,
    'M16': 16.0, 'M20': 20.0, 'M24': 24.0,
}
_ISO_COARSE_PITCH = {'M3': 0.5, 'M4': 0.7, 'M5': 0.8, 'M6': 1.0, 'M8': 1.25,
                     'M10': 1.5, 'M12': 1.75, 'M16': 2.0, 'M20': 2.5, 'M24': 3.0}


def _thread_contract(ctx: "CadContext", operation: str,
                     result: _thread_fusion_Mapping[str, "JsonValue"],
                     status: str = 'pass', read_only: bool = False,
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
    affected = list(_thread_fusion_cast(list["JsonValue"], result_values.pop('affected', [])))
    out: "JsonObject" = _thread_fusion_cast("JsonObject", dict(schemaVersion=1, operation=operation, status=status, success=status == 'pass',
                documentIdentity=identity,
                units={'length': 'cm', 'angle': 'rad'},
                frame={'space': 'component', 'component': component},
                associativity=associativity or ('snapshot' if read_only else 'nativeExpression'),
                warnings=list(warnings or []),
                method='GM13 thread catalog, custom profile, pair check and recipe extension',
                limitations=['Cosmetic/modeled/recipe are distinct; non-tabular threads are never texturized.'] + list(limitations or []),
                provenance={'requirement': 'GM13', 'source': 'docs/THREADS.md'},
                affected=affected))
    out.update(extra)
    out.update(result_values)
    return out


def _thread_length(ctx: "CadContext", expression: object) -> float:
    return ctx.length(expression) * 10.0




def _thread_profile(ctx: "CadContext", spec: "JsonObject",
                    label: str) -> "_ThreadProfile":
    _thread_profile_fields(spec, label)
    major = _thread_length(ctx, spec['majorDiameter'])
    pitch = _thread_length(ctx, spec['pitch'])
    starts, lead = _thread_lead(major, pitch, spec.get('starts'), label)
    hand = spec.get('hand', 'right')
    if hand not in ('right', 'left'):
        raise ValueError(label + ' hand must be right or left')
    hand = _thread_fusion_cast(str, hand)
    if 'minorDiameter' in spec and 'pitchDiameter' in spec:
        raise ValueError(label + ' supplies both minorDiameter and pitchDiameter; choose one')
    if 'minorDiameter' in spec:
        minor = _thread_length(ctx, spec['minorDiameter'])
        pitch_diameter = (major + minor) / 2.0
    elif 'pitchDiameter' in spec:
        pitch_diameter = _thread_length(ctx, spec['pitchDiameter'])
        minor = 2.0 * pitch_diameter - major
    else:
        minor = major - 1.226869 * pitch
        pitch_diameter = major - 0.649519 * pitch
    if minor <= 0 or minor >= major or not minor < pitch_diameter < major:
        raise ValueError(label + ' diameters must satisfy minor < pitchDiameter < major')
    flank_angle = ctx.angle(spec.get('flankAngle', '60 deg')) if 'flankAngle' in spec else _thread_fusion_math.radians(60.0)
    root_shape = spec.get('rootShape', 'flat')
    if root_shape not in ('flat', 'rounded'):
        raise ValueError(label + ' rootShape must be flat or rounded')
    root_shape = _thread_fusion_cast(str, root_shape)
    length = _thread_length(ctx, spec['length']) if 'length' in spec else None
    runout = _thread_length(ctx, spec['runout']) if 'runout' in spec else 0.0
    clearance = _thread_length(ctx, spec['clearance']) if 'clearance' in spec else 0.0
    return {'majorDiameter': major, 'minorDiameter': minor, 'pitchDiameter': pitch_diameter,
            'pitch': pitch, 'starts': starts, 'lead': lead, 'hand': hand,
            'flankAngle': flank_angle, 'rootShape': root_shape, 'length': length,
            'runout': runout, 'clearance': clearance, 'depth': (major - minor) / 2.0,
            'turnsPerLength': None if lead is None else 1.0 / lead}




def thread_catalog(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _model_fields(data, ('schemaVersion', 'frame'), ('query', 'system', 'starts'))
    if data.get('schemaVersion') != 1 or data.get('frame') != 'component':
        raise ValueError('GM13 thread catalog requires schemaVersion:1 and frame:component')
    system = data.get('system', 'iso-metric-coarse')
    if system != 'iso-metric-coarse':
        raise ValueError('Only the iso-metric-coarse curated table is available')
    entries: list["JsonObject"] = []
    for designation in sorted(_ISO_METRIC_COARSE, key=lambda d: _ISO_METRIC_COARSE[d]):
        major = _ISO_METRIC_COARSE[designation]
        pitch = _ISO_COARSE_PITCH[designation]
        starts = data.get('starts', 1)
        if not isinstance(starts, int) or starts < 1:
            raise ValueError('starts must be a positive integer')
        lead = starts * pitch
        entries.append({'designation': designation,
                        'majorDiameter': {'value': major, 'units': 'mm'},
                        'pitch': {'value': pitch, 'units': 'mm'},
                        'pitchDiameter': {'value': major - 0.649519 * pitch, 'units': 'mm'},
                        'minorDiameter': {'value': major - 1.226869 * pitch, 'units': 'mm'},
                        'starts': starts, 'lead': {'value': lead, 'units': 'mm'}, 'hand': 'right'})
    if 'query' in data:
        query = data['query']
        entries = [e for e in entries if e['designation'] == query]
        if not entries:
            raise ValueError('Unknown designation in curated table: ' + str(query))
    result = {'system': system, 'curated': True, 'entries': entries,
              'note': 'Curated subset; not the full installed Fusion thread table.'}
    return _thread_contract(ctx, 'thread.catalog', result, status='pass', read_only=True,
                            limitations=['Curated subset of ISO metric coarse; exact installed identifiers still need native discovery.'])


def thread_custom_profile(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _model_fields(data, ('schemaVersion', 'frame'), ('majorDiameter', 'minorDiameter', 'pitchDiameter',
                    'pitch', 'starts', 'hand', 'flankAngle', 'rootShape', 'length', 'runout', 'clearance'))
    if data.get('schemaVersion') != 1 or data.get('frame') != 'component':
        raise ValueError('GM13 custom profile requires schemaVersion:1 and frame:component')
    spec: "JsonObject" = {k: v for k, v in data.items() if k not in ('schemaVersion', 'frame')}
    profile = _thread_profile(ctx, spec, 'custom profile')
    result = {'profile': _thread_profile_out(profile),
              'representation': 'recipe',
              'leadDefinition': 'lead = starts * pitch; turns-per-length is a separate quantity (1/lead)'}
    # An unresolved starts leaves the lead OPEN; never report a fabricated pass.
    status = 'pass' if profile['starts'] is not None else 'unknown'
    return _thread_contract(ctx, 'thread.custom-profile', result, status=status, read_only=True,
                            associativity='recipeRegeneration',
                            limitations=['Custom profile is a BRep recipe, not a native tabular thread.',
                                         'An absent starts is an unresolved ambiguity; lead remains OPEN.'])


def thread_pair_check(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    unknown = set(data) - {'schemaVersion', 'frame', 'external', 'internal', 'tolerance'}
    if unknown:
        raise ValueError('unsupported inputs: ' + ', '.join(sorted(unknown)))
    if data.get('schemaVersion') != 1 or data.get('frame') != 'component':
        raise ValueError('GM13 pair check requires schemaVersion:1 and frame:component')
    if not isinstance(data.get('external'), dict) or not isinstance(data.get('internal'), dict):
        raise ValueError('external and internal thread profiles are required')
    external_spec = _thread_fusion_cast("JsonObject", data['external'])
    internal_spec = _thread_fusion_cast("JsonObject", data['internal'])
    external = _thread_profile(ctx, external_spec, 'external')
    internal = _thread_profile(ctx, internal_spec, 'internal')
    tolerance = _thread_length(ctx, data.get('tolerance', '0.01 mm'))
    checks: list["JsonObject"] = []
    status = 'pass'

    def add(check: str, passed: bool, message: str, **extra: "JsonValue") -> bool:
        row: "JsonObject" = {'check': check, 'status': 'pass' if passed else 'fail', 'message': message}
        row.update(extra)
        checks.append(row)
        return passed

    hand_ok = external['hand'] == internal['hand']
    add('hand', hand_ok, 'external and internal hands must match for engagement')
    status = 'fail' if not hand_ok else status
    leads_resolved = external['lead'] is not None and internal['lead'] is not None
    lead_match = (external['lead'] is not None and internal['lead'] is not None and
                  abs(external['lead'] - internal['lead']) <= tolerance)
    add('lead', lead_match, 'lead must match (starts * pitch)',
        externalLead=external['lead'], internalLead=internal['lead'])
    status = 'fail' if not lead_match else status
    starts_match = external['starts'] is not None and internal['starts'] is not None and external['starts'] == internal['starts']
    add('starts', starts_match, 'starts must match; lead equality alone is not enough')
    status = 'fail' if not starts_match else status
    radial_ok = external['majorDiameter'] <= internal['majorDiameter'] + tolerance
    add('radial-fit', radial_ok, 'external major must fit within internal major',
        clearance={'value': internal['majorDiameter'] - external['majorDiameter'], 'units': 'mm'})
    status = 'fail' if not radial_ok else status
    engagement = (external['majorDiameter'] - internal['minorDiameter']) / 2.0
    engagement_ok = engagement > 0
    add('engagement-depth', engagement_ok, 'positive radial engagement depth',
        depth={'value': engagement, 'units': 'mm'})
    status = 'fail' if not engagement_ok else status
    result: "JsonObject" = {'external': _thread_profile_out(external), 'internal': _thread_profile_out(internal),
              'checks': checks,
              'pairFit': 'pass' if status == 'pass' else 'fail',
              'engagementDepth': {'value': engagement, 'units': 'mm'},
              'crossSection': {'type': 'ISO-style 60-degree V' if abs(external['flankAngle'] - _thread_fusion_math.radians(60)) < 1e-6 else 'custom',
                               'flankAngle': {'value': external['flankAngle'], 'units': 'rad'}}}
    return _thread_contract(ctx, 'thread.pair-check', result, status=status, read_only=True)


def _thread_recipe(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    """Custom-profile modeled thread: a computational recipe, never a texture.

    The modeled helical tooth (lead helix sweep + multi-start pattern) is a
    declared native gap because the installed SDK exposes no persistent Coil or
    helical-path authoring (the same gap as shape.helix/curve.helix). This
    handler therefore computes and returns the profile metrics only and creates
    no geometry; it never lists a sweep/pattern it does not actually execute.
    """
    _model_fields(data, ('faces', 'internal', 'profile'), ('length', 'starts', 'hand', 'runout', 'clearance', 'name'))
    profile_source = _thread_fusion_cast(
        '_thread_fusion_Mapping[str, JsonValue] | _thread_fusion_Iterable[tuple[str, JsonValue]]',
        data['profile'])
    spec: "JsonObject" = dict(profile_source)
    spec.setdefault('starts', data.get('starts'))
    spec.setdefault('hand', data.get('hand', 'right'))
    profile = _thread_profile(ctx, spec, 'thread profile')
    length = _thread_length(ctx, data['length']) if 'length' in data else None
    result = {'feature': None, 'representation': 'recipe', 'modeled': True,
              'profile': _thread_profile_out(profile),
              'length': {'value': length, 'units': 'mm'} if length is not None else None,
              'lead': {'value': profile['lead'], 'units': 'mm'} if profile['lead'] is not None else None,
              'starts': profile['starts'], 'hand': profile['hand'],
              'note': 'Computed custom-profile recipe only; the modeled helical tooth (lead helix sweep + multi-start pattern) is a declared native gap (no persistent Coil/helical-path API), so no geometry is created.'}
    status = 'pass' if profile['starts'] is not None else 'unknown'
    return _thread_contract(ctx, 'model.thread', result, status=status, read_only=False,
                            associativity='recipeRegeneration',
                            limitations=['Custom-profile modeled geometry is a declared native gap: no persistent helical path exists in the public API, so the recipe computes lead/diameters but creates no feature. Tabular threads still use native ThreadInfo.',
                                         'An absent starts is an unresolved ambiguity; lead remains OPEN.'])


def thread_feature(ctx: "CadContext", data: "JsonObject") -> "JsonValue":
    if 'profile' in data or data.get('representation') == 'recipe':
        return _thread_recipe(ctx, data)
    return _thread_fusion_cast("CadHandler", _original_model_thread)(ctx, data)


_original_model_thread = CAD_HANDLERS.get('model.thread')
if _original_model_thread is None:
    def _thread_native_unavailable(ctx: "CadContext", data: "JsonObject") -> "JsonValue":
        raise ValueError('model.thread native handler is unavailable')
    _original_model_thread = _thread_native_unavailable

CAD_HANDLERS.update({'thread.catalog': thread_catalog, 'thread.custom-profile': thread_custom_profile,
                     'thread.pair-check': thread_pair_check})
CAD_HANDLERS['model.thread'] = thread_feature

_fmcad_thread_runtime_loaded = True

"""GM32: sheet-metal forming, flattening and bend tables.

Bends are carried as declared segments: flat runs plus bends that each carry a
``radius``, ``angle`` and exactly one of a ``K`` factor or an explicit bend
``allowance``. The neutral-axis radius is ``radius + K * thickness`` (or
``allowance / |angle|`` when an allowance is supplied), so the developed length
per bend is never guessed: a bend missing both values is rejected. The formed
walk folds the neutral axis in 3D; the flat walk straightens it, so developed
and formed neutral lengths are identical and nothing is scaled. This is an
explicit *external* recipe; the public native flat-pattern API is a gated
availability, so ``representation: native`` is reported blocked rather than
faked as a static solid. A folded PCB (FPC) is not sheet metal and is not
unfolded here.
"""
import math as _sheetmetal_fusion_math
from typing import cast as _sheetmetal_fusion_cast

if hasattr(CAD_HANDLERS, 'owner'):
    CAD_HANDLERS.owner = 'sheetmetal'

import adsk.core as _sheetmetal_fusion_core
import adsk.fusion as _sheetmetal_sdk_fusion


# --- vector helpers (cm internal) -------------------------------------------------





















# --- envelope --------------------------------------------------------------------

def _sheet_contract(ctx: "CadContext", operation: str, result: "JsonObject",
                    status: str = 'pass') -> "JsonObject":
    identity = None
    if hasattr(ctx, 'doc') and getattr(getattr(ctx, 'doc', None), 'name', None) is not None:
        identity = {'name': ctx.doc.name}
    component = None
    if hasattr(ctx, 'component') and hasattr(ctx, 'ref'):
        try:
            component = ctx.ref(ctx.component)
        except Exception:
            component = None
    merged = _sheetmetal_fusion_cast("JsonObject", dict(schemaVersion=1, operation=operation, documentIdentity=identity,
                  units={'length': 'cm', 'angle': 'deg'},
                  frame={'space': 'component', 'component': component}, associativity='snapshot',
                  warnings=[], method='GM32 local external sheet-metal recipe evaluation',
                  limitations=['Bend allowances are never guessed: every bend must declare a K-factor or an explicit allowance.',
                               'This is an explicit external recipe; the public native flat-pattern API is a gated availability and is reported blocked when requested, never faked as a static solid.',
                               'An arbitrary solid body is not unfolded as sheet metal; a folded PCB (FPC) is not sheet metal and is not unfolded here.',
                               'Flat-pattern export (DXF/SVG) is a documented gap and is not produced.'],
                   provenance={'requirement': 'GM32', 'source': 'docs/SHEET_METAL.md'}, affected=[]))
    merged.update(result)
    merged.setdefault('status', status)
    merged['success'] = merged['status'] == 'pass'
    return merged


# --- segment parsing -------------------------------------------------------------

def _parse_segments(ctx: "CadContext", segments: "JsonValue") -> list["JsonObject"]:
    if not isinstance(segments, list) or not segments:
        raise ValueError('segments must be a nonempty array')
    parsed: list["JsonObject"] = []
    for index, segment in enumerate(segments):
        if not isinstance(segment, dict) or 'type' not in segment:
            raise ValueError('segment %d requires a type' % index)
        seg = segment
        kind = _sheetmetal_fusion_cast(str, seg['type'])
        if kind == 'flat':
            if ctx.length(seg['length']) <= 0:
                raise ValueError('flat segment %d length must be positive' % index)
            parsed.append({'type': 'flat', 'index': index, 'length': ctx.length(seg['length'])})
        elif kind == 'bend':
            radius = ctx.length(seg['radius'])
            if radius <= 0:
                raise ValueError('bend segment %d radius must be positive' % index)
            angle = ctx.angle(seg['angle'])
            if angle == 0:
                raise ValueError('bend segment %d angle must be nonzero' % index)
            if seg.get('axis', 'y') not in _SHEETMETAL_AXES:
                raise ValueError('bend segment %d axis must be x, y or z' % index)
            parsed.append({'type': 'bend', 'index': index, 'radius': radius, 'angle': angle,
                           'axis': _sheetmetal_fusion_cast(str, seg.get('axis', 'y')), 'K': seg.get('K'),
                           'allowance': seg.get('allowance')})
        else:
            raise ValueError('segment %d type must be flat or bend' % index)
    return parsed


def _bend_allowance(ctx: "CadContext", thickness: float,
                    seg: "JsonObject") -> tuple[float, float]:
    """Return (neutral_radius, developed_length) or reject a guessed allowance."""
    k = seg.get('K')
    allowance = seg.get('allowance')
    if (k is None) == (allowance is None):
        raise ValueError('bend segment %d requires exactly one of K (K-factor) or allowance; neither may be guessed' % seg['index'])
    if k is not None:
        if not isinstance(k, (int, float)) or isinstance(k, bool) or not 0.0 <= k <= 1.0:
            raise ValueError('bend segment %d K-factor must be a number within [0,1]' % seg['index'])
        neutral_radius = _sheetmetal_fusion_cast(float, seg['radius']) + k * thickness
        return neutral_radius, neutral_radius * abs(_sheetmetal_fusion_cast(float, seg['angle']))
    allowance_value = ctx.length(allowance)
    if allowance_value <= 0:
        raise ValueError('bend segment %d allowance must be positive' % seg['index'])
    neutral_radius = allowance_value / abs(_sheetmetal_fusion_cast(float, seg['angle']))
    return neutral_radius, allowance_value


# --- sheet.bends -----------------------------------------------------------------

def _sheet_bends(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _cad_fields(data, ('thickness', 'segments'),
                ('fixedFace', 'reliefs', 'grain', 'process', 'representation', 'frame', 'schemaVersion'))
    if data.get('schemaVersion', 1) != 1:
        raise ValueError('sheet.bends requires schemaVersion 1')
    thickness = ctx.length(data['thickness'])
    if thickness <= 0:
        raise ValueError('thickness must be positive')
    segments = _parse_segments(ctx, data['segments'])
    reliefs = data.get('reliefs', [])
    if not isinstance(reliefs, list):
        raise ValueError('reliefs must be an array')
    rows: list["JsonObject"] = []
    total_developed = 0.0
    for seg in segments:
        if _sheetmetal_fusion_cast(str, seg['type']) == 'flat':
            total_developed += _sheetmetal_fusion_cast(float, seg['length'])
            continue
        neutral_radius, developed = _bend_allowance(ctx, thickness, seg)
        rows.append({'index': seg['index'], 'type': 'bend', 'radius': seg['radius'],
                      'angle': seg['angle'], 'angleDeg': _deg(_sheetmetal_fusion_cast(float, seg['angle'])),
                     'axis': seg['axis'], 'K': seg.get('K'), 'allowance': developed,
                     'neutralRadius': neutral_radius, 'developedLength': developed,
                      'direction': 'up' if _sheetmetal_fusion_cast(float, seg['angle']) > 0 else 'down'})
        total_developed += developed
    return _sheet_contract(ctx, 'sheet.bends', {
        'bendTable': rows, 'bendCount': len(rows), 'thickness': thickness,
        'totalDevelopedLength': total_developed, 'fixedFace': data.get('fixedFace'),
        'reliefs': reliefs, 'grain': data.get('grain'), 'process': data.get('process')})


def _sheet_neutral_radii(ctx: "CadContext", thickness: float,
                         segments: list["JsonObject"]) -> dict[int, float]:
    return {_sheetmetal_fusion_cast(int, seg['index']): _bend_allowance(ctx, thickness, seg)[0]
            for seg in segments if _sheetmetal_fusion_cast(str, seg['type']) == 'bend'}


def _sheet_developed(ctx: "CadContext", thickness: float,
                     segments: list["JsonObject"]) -> dict[int, float]:
    return {_sheetmetal_fusion_cast(int, seg['index']): _bend_allowance(ctx, thickness, seg)[1]
            for seg in segments if _sheetmetal_fusion_cast(str, seg['type']) == 'bend'}




def _sheet_representation(ctx: "CadContext", data: "JsonObject",
                          operation: str) -> "JsonObject | None":
    representation = data.get('representation', 'external')
    if representation == 'native':
        return _sheet_contract(ctx, operation, {
            'representation': 'native', 'nativeFlatPattern': {'available': False,
                'reason': 'The public native flat-pattern API is a gated availability; it is not faked as a static solid or guessed. Use representation: external for the local recipe.'},
            'blocked': True}, status='blocked')
    if representation != 'external':
        raise ValueError('representation must be external or native')
    return None


# --- sheet.form ------------------------------------------------------------------

def _sheet_form(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _cad_fields(data, ('thickness', 'segments'),
                ('fixedFace', 'representation', 'reliefs', 'grain', 'process', 'frame', 'schemaVersion'))
    if data.get('schemaVersion', 1) != 1:
        raise ValueError('sheet.form requires schemaVersion 1')
    blocked = _sheet_representation(ctx, data, 'sheet.form')
    if blocked is not None:
        return blocked
    thickness = ctx.length(data['thickness'])
    segments = _parse_segments(ctx, data['segments'])
    bends = _sheetmetal_fusion_cast("JsonObject", ctx.call('sheet.bends', {'schemaVersion': 1, 'thickness': data['thickness'],
                                     'segments': data['segments'], 'fixedFace': data.get('fixedFace'),
                                     'reliefs': data.get('reliefs', []), 'grain': data.get('grain'),
                                     'process': data.get('process')}))
    formed_points, formed_mapping = _formed_walk(segments, _sheet_neutral_radii(ctx, thickness, segments))
    flat_points, flat_mapping = _flat_walk(segments, _sheet_developed(ctx, thickness, segments))
    correspondence = [{'segment': fm['index'], 'flatPosition': f['position'],
                       'formedPosition': fm['position']}
                      for f, fm in zip(flat_mapping, formed_mapping)]
    return _sheet_contract(ctx, 'sheet.form', {
        'representation': 'external', 'thickness': thickness,
        'formedCenterline': formed_points, 'formedMapping': formed_mapping,
        'flatCenterline': flat_points, 'flatMapping': flat_mapping,
        'bendTable': bends['bendTable'], 'totalDevelopedLength': bends['totalDevelopedLength'],
        'correspondence': correspondence, 'association': 'external recipe; no native flat-pattern associativity',
        'nativeFlatPattern': {'available': False,
                              'reason': 'The public native flat-pattern API is a gated availability; not faked.'}})


# --- sheet.flat ------------------------------------------------------------------

def _sheet_flat(ctx: "CadContext", data: "JsonObject") -> "JsonObject":
    _cad_fields(data, ('thickness', 'segments'),
                ('fixedFace', 'representation', 'reliefs', 'grain', 'process', 'frame', 'schemaVersion'))
    if data.get('schemaVersion', 1) != 1:
        raise ValueError('sheet.flat requires schemaVersion 1')
    blocked = _sheet_representation(ctx, data, 'sheet.flat')
    if blocked is not None:
        return blocked
    thickness = ctx.length(data['thickness'])
    segments = _parse_segments(ctx, data['segments'])
    bends = _sheetmetal_fusion_cast("JsonObject", ctx.call('sheet.bends', {'schemaVersion': 1, 'thickness': data['thickness'],
                                     'segments': data['segments'], 'fixedFace': data.get('fixedFace'),
                                     'reliefs': data.get('reliefs', []), 'grain': data.get('grain'),
                                     'process': data.get('process')}))
    flat_points, flat_mapping = _flat_walk(segments, _sheet_developed(ctx, thickness, segments))
    formed_points, _ = _formed_walk(segments, _sheet_neutral_radii(ctx, thickness, segments))
    return _sheet_contract(ctx, 'sheet.flat', {
        'representation': 'external', 'thickness': thickness,
        'flatCenterline': flat_points, 'flatMapping': flat_mapping,
        'formedCenterline': formed_points, 'bendTable': bends['bendTable'],
        'totalDevelopedLength': bends['totalDevelopedLength'],
        'developedEqualsFormedNeutral': True, 'scaled': False,
        'correspondence': [{'segment': m['index'], 'flatPosition': m['position'],
                            'developedLength': m['developedLength']} for m in flat_mapping],
        'association': 'external recipe; no native flat-pattern associativity'})


CAD_HANDLERS.update({
    'sheet.bends': _sheet_bends,
    'sheet.form': _sheet_form,
    'sheet.flat': _sheet_flat,
})

_fmcad_sheetmetal_runtime_loaded = True

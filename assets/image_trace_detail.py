"""Source-owned small cutout bundles. Sampling audits ownership, never creates curves."""
from collections import Counter
import copy
import hashlib
import importlib.util
from pathlib import Path
import re
import xml.etree.ElementTree as ET

import numpy as np
from shapely.geometry import Polygon
from shapely.ops import unary_union


def _module(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


shared = _module('image_shared_boundaries')
MAX_RINGS = 4096
MAX_SEGMENTS = 250000


def _require(condition, message):
    if not condition:
        raise ValueError('Trace detail bundles: ' + message)


def _coefficients(kind, points):
    points = np.asarray(points, dtype=float)
    if kind == 'L':
        return np.array([points[0], points[1] - points[0]])
    return np.array([points[0], 3 * (points[1] - points[0]),
                     3 * (points[0] - 2 * points[1] + points[2]),
                     -points[0] + 3 * points[1] - 3 * points[2] + points[3]])


def _area(segments):
    total = 0.
    for kind, raw in segments:
        coefficients = _coefficients(kind, raw)
        x, y = coefficients[:, 0], coefficients[:, 1]
        cross = np.polynomial.polynomial.polysub(
            np.polynomial.polynomial.polymul(x, np.polynomial.polynomial.polyder(y)),
            np.polynomial.polynomial.polymul(y, np.polynomial.polynomial.polyder(x)))
        total += sum(value / (index + 1) for index, value in enumerate(cross)) / 2
    return total


def _inventory(root, fills, parse_path):
    rows = []
    count = 0
    for pi, element in enumerate(root):
        _require(element.tag.split('}')[-1] == 'path' and
                 not set(element.attrib) - {'d', 'fill', 'transform', 'fill-rule'}, 'unsupported path attributes')
        _require(element.get('fill') in fills, 'unknown source color')
        _require(element.get('fill-rule', 'nonzero') in ('nonzero', 'evenodd'), 'unsupported fill rule')
        for ri, data in enumerate(p for p in re.split(r'(?=[Mm])', element.get('d', '')) if p.strip()):
            _require(data.startswith('M') and data.rstrip().endswith(('Z', 'z')), 'require absolute, closed subpaths')
            segments = parse_path(data, element.get('transform', ''))
            count += len(segments)
            _require(len(rows) < MAX_RINGS and count <= MAX_SEGMENTS, 'source complexity budget exceeded')
            _require(segments and segments[0][1][0] == segments[-1][1][-1], 'open source ring')
            shape = Polygon(shared._sample(segments, .005))
            area = float(_area(segments))
            _require(shape.is_valid and shape.area > 0 and area != 0, 'invalid source ring')
            rows.append(dict(key=(pi, ri), color=element.get('fill'), area=area, shape=shape,
                data=data, transform=element.get('transform', ''), segments=segments))
    return rows


def _paint(rows):
    """Sampled compound-path interiors for ownership checks, not replacement geometry."""
    shells = [r['shape'] for r in rows if r['area'] > 0]
    holes = [r['shape'] for r in rows if r['area'] < 0]
    _require(shells, 'source path has no positive shell')
    assigned = [[] for _ in shells]
    for hole in holes:
        parents = [i for i, shell in enumerate(shells) if shell.contains(hole)]
        _require(len(parents) == 1, 'ambiguous source hole ownership')
        assigned[parents[0]].append(hole.exterior)
    shapes = [Polygon(shell.exterior, inner) for shell, inner in zip(shells, assigned)]
    _require(all(p.is_valid for p in shapes), 'invalid compound-path topology')
    union = unary_union(shapes)
    _require(abs(sum(p.area for p in shapes) - union.area) <= max(1e-8, union.area * 1e-10),
             'overlapping source shells')
    return union


def _serialized(ring, destination, parse_path):
    translation = parse_path('M0 0 L0 0', destination['transform'])[0][1][0]
    def point(p):
        return ' '.join(repr(float(v-t)) for v, t in zip(p, translation))
    segments = ring['segments']
    text = ' '.join(['M ' + point(segments[0][1][0])] +
        [kind + ' ' + ' '.join(point(p) for p in points[1:]) for kind, points in segments] + ['Z'])
    actual = parse_path(text, destination['transform'])
    _require([k for k, _ in actual] == [k for k, _ in segments], 'source segment types changed')
    error = max(float(np.abs(np.asarray(a)-np.asarray(b)).max()) for (_, a), (_, b) in zip(actual, segments))
    _require(error <= 1e-10, 'source controls changed beyond floating serialization')
    return text, error


def replace_bundles(baseline, high, palette, max_area, parse_path):
    """Return a new SVG and provenance; ambiguous input raises, never falls back."""
    fills = [palette['background']] + [c['color'] for c in palette['colors']]
    _require(len(fills) == len(set(fills)), 'duplicate palette colors')
    _require(all(baseline.get(k) == high.get(k) for k in ('width', 'height')), 'source canvas mismatch')
    for root in (baseline, high):
        _require('transform' not in root.attrib, 'unsupported root transform')
        view = root.get('viewBox', f"0 0 {root.get('width')} {root.get('height')}")
        _require([float(v) for v in view.split()] == [0, 0, float(root.get('width')), float(root.get('height'))],
                 'source viewBox mismatch')
    rows = [_inventory(root, fills, parse_path) for root in (baseline, high)]
    holes = [[r for r in records if -max_area <= r['area'] < 0] for records in rows]
    _require(len(holes[0]) == len(holes[1]), 'unmatched small source cutouts')
    for selected in holes:
        for i, a in enumerate(selected):
            for b in selected[i+1:]:
                _require(not a['shape'].intersects(b['shape']), 'nested or touching selected cutouts are unsupported')
    by_path = []
    for records in rows:
        grouped = {}
        for r in records:
            grouped.setdefault(r['key'][0], []).append(r)
        by_path.append(grouped)
    # Check actual high-resolution paint, not just positive shells that might
    # contain holes or be overpainted by an unrelated later path.
    paints = {pi: _paint(records) for pi, records in by_path[1].items()} if holes[0] else {}
    baseline_paints = {pi: _paint(records) for pi, records in by_path[0].items()} if holes[0] else {}
    replacements, removed, touched, used = {}, set(), set(), set()
    bundles = []
    imported_count = 0
    max_control_error = 0.
    for old in holes[0]:
        matches = []
        for new in holes[1]:
            if new['color'] == old['color']:
                iou = old['shape'].intersection(new['shape']).area / old['shape'].union(new['shape']).area
                if iou >= .8:
                    matches.append((new, iou))
        _require(len(matches) == 1, 'ambiguous parent cutout correspondence')
        new, iou = matches[0]
        _require(new['key'] not in used, 'duplicate cutout ownership')
        children = []
        for records, hole in zip(rows, (old, new)):
            selected = [r for r in records if 0 < r['area'] <= max_area * 1.2 and
                r['shape'].intersection(hole['shape']).area / r['shape'].area >= .8]
            _require(selected, 'cutout has no corresponding child paint')
            children.append(selected)
        epsilon = max(1e-8, new['shape'].area * 1e-10)
        union = unary_union([r['shape'] for r in children[1]])
        gap = union.symmetric_difference(new['shape']).area
        overlap = sum(r['shape'].area for r in children[1]) - union.area
        _require(gap <= epsilon and abs(overlap) <= epsilon, 'child/cutout adjacency mismatch')
        for index, selected in enumerate(children):
            for pi in {r['key'][0] for r in selected}:
                _require({r['key'] for r in by_path[index][pi]} == {r['key'] for r in selected if r['key'][0] == pi},
                         'child path crosses bundle boundary or contains nested holes')
        child_paths = {r['key'][0] for r in children[1]}
        _require(all(p.intersection(new['shape']).area <= epsilon for pi, p in paints.items() if pi not in child_paths),
                 'unrelated source paint intersects cutout')
        replaced_paths = {r['key'][0] for r in children[0]} | {old['key'][0]}
        changed_cutout = old['shape'].union(new['shape'])
        _require(all(p.intersection(changed_cutout).area <= epsilon for pi, p in baseline_paints.items()
                     if pi not in replaced_paths), 'unrelated baseline paint intersects cutout')
        parent = by_path[0][old['key'][0]]
        _require(any(r['area'] > 0 and r['shape'].contains(new['shape']) for r in parent),
                 'replacement leaves unchanged parent shell')
        _require(all(r['shape'].intersection(new['shape']).area <= epsilon for r in parent
                     if r['area'] < 0 and r['key'] != old['key']), 'replacement collides with another parent cutout')
        _require({r['color'] for r in children[0]} == {r['color'] for r in children[1]}, 'local material set changed')
        text, error = _serialized(new, old, parse_path)
        replacements[old['key']] = text
        max_control_error = max(max_control_error, error)
        touched.add(old['key']); used.add(new['key'])
        imported_count += len(new['segments'])
        colors = {}
        for r in children[0]:
            colors.setdefault(r['color'], []).append(r)
        for color, old_children in colors.items():
            destination = min(old_children, key=lambda r: r['key'])
            fragments = []
            for r in children[1]:
                if r['color'] != color:
                    continue
                _require(r['key'] not in used, 'source child belongs to multiple bundles')
                text, error = _serialized(r, destination, parse_path)
                fragments.append(text)
                max_control_error = max(max_control_error, error)
                used.add(r['key']); imported_count += len(r['segments'])
            for r in old_children:
                _require(r['key'] not in touched, 'baseline child belongs to multiple bundles')
                replacements[r['key']] = ' '.join(fragments) if r is destination else ''
                touched.add(r['key'])
                if r['key'][0] != destination['key'][0]:
                    removed.add(r['key'][0])
        bundles.append(dict(oldCutout=list(old['key']), newCutout=list(new['key']), color=old['color'],
            oldAreaPx2=old['shape'].area, newAreaPx2=new['shape'].area, matchingIoU=iou,
            oldChildren=[list(r['key']) for r in children[0]], newChildren=[list(r['key']) for r in children[1]],
            cutoutSymmetricDifferencePx2=gap, childOverlapPx2=overlap, adjacencyEpsilonPx2=epsilon))
    _require({r['key'] for r in holes[1]} <= used, 'unmatched high-resolution cutout')
    result = copy.deepcopy(baseline)
    unchanged_paths = unchanged_curves = unchanged_foreground = 0
    for pi, element in enumerate(list(result)):
        records = by_path[0][pi]
        if pi in removed:
            result.remove(element)
        elif any(r['key'] in replacements for r in records):
            text = element.get('d')
            for r in records:
                if r['key'] in replacements:
                    _require(text.count(r['data']) == 1, 'ambiguous subpath text replacement')
                    text = text.replace(r['data'], replacements[r['key']], 1)
            element.set('d', text)
        else:
            _require(element.attrib == baseline[pi].attrib, 'unselected path changed')
            unchanged_paths += 1
        for r in records:
            if r['key'] not in touched:
                _require(pi not in removed and r['data'] in element.get('d') and
                         element.get('transform', '') == r['transform'], 'unselected source subpath changed')
                unchanged_curves += len(r['segments'])
                if r['color'] != palette['background']:
                    unchanged_foreground += len(r['segments'])
    counts = Counter(kind for p in result if p.get('fill') != palette['background']
                     for kind, _ in parse_path(p.get('d'), p.get('transform', '')))
    audit = dict(policyVersion=1, status='applied' if bundles else 'not_needed', maxCutoutAreaSourcePx2=max_area,
        samplingFlatnessPx=.005, sourceScale=2, bundles=bundles, rootPathsAppended=0,
        baselineRingsReplaced=len(touched), ss2RingsImported=len(used),
        intactBaselineSubpaths=len(rows[0])-len(touched), intactBaselinePaths=unchanged_paths,
        baselineCurvesUnchanged=unchanged_curves, baselineForegroundCurvesUnchanged=unchanged_foreground,
        baselineCurvesReplaced=sum(len(r['segments']) for r in rows[0] if r['key'] in touched),
        importedSourceCurves=imported_count, ss2SerializationMaxControlErrorPx=max_control_error,
        pathsBefore=len(baseline), pathsAfter=len(result), foregroundSegments=dict(counts),
        baselineSvgSha256=hashlib.sha256(ET.tostring(baseline, encoding='utf-8', xml_declaration=True)).hexdigest(),
        ss2SvgSha256=hashlib.sha256(ET.tostring(high, encoding='utf-8', xml_declaration=True)).hexdigest(),
        policy='complete source-owned cutout/child replacement; unchanged outer curves; no root append, refit or fallback')
    return result, audit

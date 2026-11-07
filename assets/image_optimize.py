"""Bounded discrete raster-to-spline search, not Bayesian or CAD validation.

All distances use source pixels. The returned metricDefinition documents the
heuristics and weights; these are fidelity proxies, not a universal optimum.
"""
import sys

# Do not let the sibling Fusion script inspect.py shadow stdlib inspect.
if __name__ == '__main__' and not __package__:
    sys.path.pop(0)

import hashlib
import importlib.util
import io
import json
import math
from pathlib import Path
import random
import xml.etree.ElementTree as ET

_spec = importlib.util.spec_from_file_location('_optimize_image_trace', Path(__file__).with_name('image_trace.py'))
trace = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(trace)

SEARCH_KEYS = {'blurSigma', 'medianSize', 'labelModeSize', 'filterSpeckle',
               'cornerThreshold', 'lengthThreshold', 'spliceThreshold', 'traceScale', 'traceDetailAreaPx2'}
DEFAULT_SEARCH = dict(cornerThreshold=[35, 45, 60, 75, 90], lengthThreshold=[2, 4, 6, 8],
                      spliceThreshold=[30, 45, 60], labelModeSize=[0, 3], filterSpeckle=[4, 8, 12])
DEFAULT_WEIGHTS = dict(boundary=1.0, overlap=10.0, corners=1.0, roughness=1.0, complexity=0.02,
                       gaps=100.0, overlaps=100.0)
_boundary_helper = None
METRICS = {
    'gaps': 'gapFraction = internalGapAreaPx / max(1, referenceForegroundAreaPx). Raw gaps are '
            'raw fixed-reference foreground pixels with zero independently rendered foreground colors. '
            'Internal gaps have fixed-reference foreground EDT depth > 2 pixels; contourOffsetGap '
            'is the remainder and is audited separately, not included in gapFraction. Reference '
            'background holes never count as gaps. Depth is computed on the full fixed reference '
            'with one background pixel padded outside the image, then cropped for regions',
    'overlaps': 'overlapFraction = overlapAreaPx / max(1, referenceForegroundAreaPx), including '
                'overlap outside reference foreground. Occupancy counts DISTINCT foreground colors '
                'rendered independently, so later composite painting cannot hide overlap. Each color '
                'is one Cairo render containing separate opaque white paths: same-color paths union '
                'by alpha compositing, without combining their winding rules. Compound-path holes '
                'are preserved within each path. Background paths are excluded',
    'boundaryAudit': 'Conservative scale-1 raster audit, alpha >= 128, one source pixel per sample; '
                     'subpixel defects can escape detection. Every scope reports raw/internal/contour-offset '
                     'gap and overlap areas and fractions, 8-connected component counts, largest component '
                     'area, and largestComponentWidthPx = max(0, 2*max(EDT)-1) on the largest-by-area '
                     'component with exterior padding (approximate inscribed width, not maximum span). '
                     'Audit uses unpruned frozen reference labels, not fidelity metric masks. No repair '
                     'or topology-gate changes; these are additional ranking penalties, not CAD validation',
    'metricMask': 'Reference and candidate independently retain each original 8-connected color component '
                  'only if it contains an 8-connected core of area >= minFeatureArea after 3x3 binary '
                  'opening (zero border). Retained components are reconstructed as their full original '
                  'masks, preserving original contours rather than opened contours. Boundary, IoU and '
                  'corners use these masks; raw labels and frozen reference.png are never modified. '
                  'Reference metric masks are cached once, never adapted to candidates. If neither '
                  'mask has retained components, scoringActive=false, distances are zero and IoU=1. '
                  'Inactive colors are excluded from the scope fidelity averages; a missing retained '
                  'feature remains active and receives the usual missing-boundary penalty. Topology '
                  'gates still use the original labels and their unchanged topology recipe',
    'boundary': '0.7 * symmetric chamfer mean + 0.3 * symmetric chamfer P95, pixels; '
                'pooled distances both directions between 8-neighbor inner boundaries, scipy EDT; '
                'one empty boundary uses image/region diagonal, both empty use zero',
    'overlap': '1 - IoU, dimensionless; both empty masks have IoU 1',
    'corners': 'symmetric mean nearest detected corner distance, pixels; missing set uses diagonal. '
               'OpenCV RETR_LIST contours area >= minFeatureArea, approxPolyDP epsilon '
               'max(1, 0.003 * contour perimeter), interior angle <= 120 degrees',
    'roughness': '100 * (integral curvature^2 ds + sum squared join tangent jumps in radians) / '
                 'included arc length. Cubics sampled at 24 midpoint derivative samples; '
                 'lines have zero curvature. Samples/joins within 3 pixels of same-color fixed '
                 'reference corners excluded. Endpoint zero derivatives use first nonzero control '
                 'polygon direction. Only connected joins, including closed subpaths; background '
                 'paths excluded. Regional membership uses sample/join position. Pixel-space '
                 'heuristic mixes bending energy (1/pixel) and dimensionless jump energy; not scale invariant',
    'complexity': '100 * foreground SVG segment count / max(1, reference foreground boundary pixels); '
                  'regional count uses segment midpoint membership; dimensionless segments per 100 boundary pixels',
    'topology': 'Independent reference/candidate per-color counts after 3x3 binary opening (zero border); '
                'enclosed hole masks also receive 3x3 opening to reject thin inverse-color halos. '
                '8-connected components and enclosed holes counted only if area >= minFeatureArea. '
                'Holes touching image/region edge excluded; regional masks are clipped. Any mismatch '
                'in full image or requested regions is an eligibility failure, not a score penalty',
    'labels': 'Preview RGBA composited on frozen background, nearest declared RGB squared distance; '
              'ties use background then declaration order. Antialiased RGB is assigned to a label, not exact RGB matched',
    'formula': 'Each scope: weighted sum of boundary, overlap, corners (equal mean over scoringActive '
               'colors including background when active; zero if none active) plus roughness, complexity, '
               'gaps=gapFraction and overlaps=overlapFraction. Global = '
               '(fullImage.score + sum(region.weight * region.score)) / (1 + sum(region.weight)). '
               'Rank eligible candidates first, then ascending global score, then evaluation index',
}


def dependencies():
    import numpy as np
    from PIL import Image, ImageDraw
    import cv2
    from scipy import ndimage as ndi
    trace.dependencies()
    return np, Image, ImageDraw, cv2, ndi


def labels_for(image, colors, np):
    pixels = np.asarray(image.convert('RGB'), dtype=np.float32)
    best = np.full(pixels.shape[:2], np.inf, dtype=np.float32)
    labels = np.zeros(pixels.shape[:2], dtype=np.int32)
    for index, color in enumerate(colors):
        distance = ((pixels - color) ** 2).sum(axis=2)
        take = distance < best
        labels[take] = index
        best[take] = distance[take]
    return labels, best


def prepare(request, deps):
    np, Image, _, _, _ = deps
    allowed = {'input', 'out', 'palette', 'reference', 'base', 'search', 'trials', 'seed',
               'topK', 'regions', 'minFeatureArea', 'weights'}
    if not isinstance(request, dict) or set(request) - allowed:
        raise ValueError('Request must be an object with only image.optimize fields')
    if not {'input', 'out', 'palette'} <= set(request):
        raise ValueError('input, out and palette are required absolute paths')
    base = request.get('base', {})
    if not isinstance(base, dict) or set(base) - set(trace.DEFAULTS):
        raise ValueError('base must contain only trace tunables, no paths')
    if base.get('mode', 'spline') != 'spline':
        raise ValueError("mode is frozen to 'spline'")
    trace_request = {k: request[k] for k in ('input', 'out', 'palette')}
    params, paths, palette = trace.validate({**trace_request, 'filterSpeckle': 8, 'pathPrecision': 6, **base})
    options = {}
    for name, default, low, high in [('trials', 24, 2, 128), ('seed', 17, None, None),
                                    ('topK', 3, 1, 10), ('minFeatureArea', 64, 1, None)]:
        value = request.get(name, default)
        if type(value) is not int or (low is not None and value < low) or (high is not None and value > high):
            raise ValueError(name + ' is outside its integer bounds')
        options[name] = value
    if options['topK'] > options['trials']:
        raise ValueError('topK must not exceed trials')
    search = request.get('search', DEFAULT_SEARCH)
    if not isinstance(search, dict) or set(search) - SEARCH_KEYS:
        raise ValueError('search contains a forbidden tunable')
    axes = {}
    for key, values in sorted(search.items()):
        if not isinstance(values, list) or not values:
            raise ValueError('Search axes must be nonempty arrays')
        for value in values:
            if not trace.numeric(value):
                raise ValueError('Search values must be finite numbers')
            trace.validate({**trace_request, **params, key: value})
        axes[key] = sorted(set(values))
    weights = request.get('weights', {})
    if not isinstance(weights, dict) or set(weights) - set(DEFAULT_WEIGHTS):
        raise ValueError('Unknown score weights')
    if any(not trace.numeric(v) or v < 0 for v in weights.values()):
        raise ValueError('Weights must be finite and nonnegative')
    options['weights'] = {**DEFAULT_WEIGHTS, **weights}
    source = paths['input'].read_bytes()
    with Image.open(io.BytesIO(source)) as loaded:
        rgba = loaded.convert('RGBA')
    for rule in palette['rules']:
        if 'bounds' in rule and (rule['bounds'][2] > rgba.width or rule['bounds'][3] > rgba.height):
            raise ValueError('Palette rule bounds exceed input image')
    regions = request.get('regions', [])
    if not isinstance(regions, list):
        raise ValueError('regions must be an array')
    names = set()
    for region in regions:
        if not isinstance(region, dict) or set(region) != {'name', 'bounds', 'weight'}:
            raise ValueError('Regions require name, bounds, weight only')
        name, bounds, weight = region['name'], region['bounds'], region['weight']
        if not isinstance(name, str) or not name.strip() or name in names or name == 'fullImage':
            raise ValueError('Region names must be unique, nonempty and not fullImage')
        names.add(name)
        if (not isinstance(bounds, list) or len(bounds) != 4 or any(type(v) is not int for v in bounds)
                or not 0 <= bounds[0] < bounds[2] <= rgba.width
                or not 0 <= bounds[1] < bounds[3] <= rgba.height):
            raise ValueError('Region bounds must be contained integer pixel edges')
        if not trace.numeric(weight) or weight <= 0:
            raise ValueError('Region weight must be finite and positive')
    colors = np.array([list(bytes.fromhex(c[1:])) for c in
                       [palette['background']] + [c['color'] for c in palette['colors']]], dtype=np.float32)
    if 'reference' in request:
        value = request['reference']
        if not isinstance(value, str) or not Path(value).is_absolute():
            raise ValueError('reference must be an absolute PNG path')
        with Image.open(value) as loaded:
            if loaded.format != 'PNG' or loaded.size != rgba.size:
                raise ValueError('Reference must be a same-size palette-labeled PNG')
            reference_rgba = loaded.convert('RGBA')
        if np.any(np.asarray(reference_rgba)[..., 3] != 255):
            raise ValueError('Reference must be opaque and palette-labeled')
        reference = reference_rgba.convert('RGB')
        labels, distances = labels_for(reference, colors, np)
        if np.any(distances != 0):
            raise ValueError('Reference contains undeclared palette colors')
    else:
        original = Image.alpha_composite(Image.new('RGBA', rgba.size, 'white'), rgba).convert('RGB')
        reference = trace.segment_image(original, palette, np, Image, 0)
        labels, _ = labels_for(reference, colors, np)
    if not np.any(labels):
        raise ValueError('Reference has no foreground')
    options.update(axes=axes, regions=regions)
    return params, paths, palette, source, reference, labels, colors, options


def boundary(mask, ndi):
    return mask & ~ndi.binary_erosion(mask, structure=[[1]*3]*3, border_value=0)


def metric_mask(mask, area, np, ndi):
    """Reconstruct significant opened cores into their original color components."""
    structure = np.ones((3, 3), dtype=bool)
    original, _ = ndi.label(mask, structure=structure)
    opened = ndi.binary_opening(mask, structure=structure)
    cores, _ = ndi.label(opened, structure=structure)
    significant = np.bincount(cores.ravel()) >= area
    significant[0] = False
    retained = np.unique(original[significant[cores]])
    return np.isin(original, retained)


def topology(mask, area, np, ndi):
    opened = ndi.binary_opening(mask, structure=np.ones((3, 3), dtype=bool))
    def count(binary):
        labels, _ = ndi.label(binary, structure=np.ones((3, 3)))
        return int(np.count_nonzero(np.bincount(labels.ravel())[1:] >= area))
    holes = ndi.binary_fill_holes(opened, structure=np.ones((3, 3))) & ~opened
    holes = ndi.binary_opening(holes, structure=np.ones((3, 3)))
    return dict(components=count(opened), holes=count(holes))


def corners(mask, area, np, cv2):
    contours, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    found = []
    for contour in contours:
        if abs(cv2.contourArea(contour)) < area:
            continue
        points = cv2.approxPolyDP(contour, max(1., .003 * cv2.arcLength(contour, True)), True).reshape(-1, 2)
        if len(points) < 3:
            continue
        for index, p in enumerate(points):
            a, b = points[index-1] - p, points[(index+1) % len(points)] - p
            cosine = np.dot(a, b) / max(1e-12, np.linalg.norm(a) * np.linalg.norm(b))
            if math.acos(float(np.clip(cosine, -1, 1))) <= math.radians(120):
                found.append(p)
    return np.asarray(found, dtype=float).reshape(-1, 2)


def fixed_scope(labels, bounds, color_count, area, deps, reference_depth=None):
    np, _, _, cv2, ndi = deps
    l, t, r, b = bounds
    cropped = labels[t:b, l:r]
    if reference_depth is None:
        reference_depth = ndi.distance_transform_edt(np.pad(labels > 0, 1))[1:-1, 1:-1]
    records = []
    for index in range(color_count):
        raw_mask = cropped == index
        mask = metric_mask(raw_mask, area, np, ndi)
        edge = boundary(mask, ndi)
        records.append(dict(mask=mask, boundary=edge, edt=ndi.distance_transform_edt(~edge),
                            corners=corners(mask, area, np, cv2), topology=topology(raw_mask, area, np, ndi)))
    return dict(bounds=bounds, colors=records, diagonal=math.hypot(r-l, b-t),
                foreground=cropped > 0, foregroundDepthPx=reference_depth[t:b, l:r],
                perimeter=sum(int(v['boundary'].sum()) for v in records[1:]))


def color_occupancy(svg_data, size, palette, deps):
    """Whitelist lazily, then raster once per color, keeping paths separate."""
    global _boundary_helper
    if _boundary_helper is None:
        spec = importlib.util.spec_from_file_location('_optimize_image_boundaries',
                                                     Path(__file__).with_name('image_boundaries.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _boundary_helper = module
    np, Image, _, _, _ = deps
    fills = [palette['background']] + [c['color'] for c in palette['colors']]
    paths = _boundary_helper.parse_svg(svg_data, size, fills)
    grouped = {}
    for color_index, attributes in paths:
        if color_index:
            grouped.setdefault(color_index, []).append(attributes)
    width, height = size
    count = np.zeros((height, width), dtype=np.uint32)
    cairo = trace.importlib.import_module('cairosvg')
    for attributes_list in grouped.values():
        root = ET.Element('svg', xmlns=trace.SVG, width=str(width), height=str(height),
                          viewBox=f'0 0 {width} {height}')
        for attributes in attributes_list:
            ET.SubElement(root, 'path', {**attributes, 'fill': '#FFFFFF'})
        rendered = cairo.svg2png(bytestring=ET.tostring(root), output_width=width, output_height=height)
        with Image.open(io.BytesIO(rendered)) as image:
            count += np.asarray(image.convert('RGBA'))[..., 3] >= 128
    return count


def boundary_audit(occupancy, scope, deps):
    np, _, _, _, ndi = deps
    l, t, r, b = scope['bounds']
    count = occupancy[t:b, l:r]
    foreground = scope['foreground']
    raw_gap = foreground & (count == 0)
    internal_gap = raw_gap & (scope['foregroundDepthPx'] > 2)
    masks = dict(rawGap=raw_gap, internalGap=internal_gap,
                 contourOffsetGap=raw_gap & ~internal_gap, overlap=count > 1)
    reference_area = int(foreground.sum())
    denominator = max(1, reference_area)
    report = dict(referenceForegroundAreaPx=reference_area, rasterScale=1, alphaThreshold=128)
    for name, mask in masks.items():
        labeled, components = ndi.label(mask, structure=np.ones((3, 3)))
        areas = np.bincount(labeled.ravel())
        largest_area, width = 0, 0.
        if components:
            index = int(np.argmax(areas[1:])) + 1
            largest_area = int(areas[index])
            ys, xs = np.nonzero(labeled == index)
            largest = labeled[ys.min():ys.max()+1, xs.min():xs.max()+1] == index
            width = max(0., 2 * float(ndi.distance_transform_edt(np.pad(largest, 1)).max()) - 1)
        area = int(mask.sum())
        report[name + 'AreaPx'] = area
        report[name + 'Fraction'] = area / denominator
        report[name] = dict(componentCount=int(components), largestComponentAreaPx=largest_area,
                            largestComponentWidthPx=width)
    report['gapFraction'] = report['internalGapFraction']
    return report


def svg_segments(path, palette):
    paths = []
    for element in ET.parse(path).getroot().iter():
        if element.tag.split('}')[-1] == 'path' and element.get('fill') != palette['background']:
            fill = element.get('fill')
            index = next(i + 1 for i, c in enumerate(palette['colors']) if c['color'] == fill)
            paths.append((index, trace.parse_path(element.get('d', ''), element.get('transform', ''))))
    return paths


def curve_metrics(paths, scope, full_scope, np):
    l, t, r, b = scope['bounds']
    energy = arc_length = 0.
    count = 0
    def inside(p):
        return l <= p[0] < r and t <= p[1] < b
    def supported(p, color):
        fixed = full_scope['colors'][color]['corners']
        return len(fixed) and float(np.min(np.sum((fixed - p)**2, axis=1))) <= 9
    def tangent(points, end):
        pairs = [points[-1] - p for p in points[-2::-1]] if end else [p - points[0] for p in points[1:]]
        return next((v / np.linalg.norm(v) for v in pairs if np.linalg.norm(v) > 1e-10), np.zeros(2))
    for color, segments in paths:
        converted = []
        for kind, raw in segments:
            p = np.asarray(raw, dtype=float)
            converted.append(p)
            if kind == 'C':
                ts = (np.arange(24) + .5) / 24
                u = ts[:, None]
                pos = (1-u)**3*p[0] + 3*(1-u)**2*u*p[1] + 3*(1-u)*u**2*p[2] + u**3*p[3]
                d = 3*(1-u)**2*(p[1]-p[0]) + 6*(1-u)*u*(p[2]-p[1]) + 3*u**2*(p[3]-p[2])
                dd = 6*(1-u)*(p[2]-2*p[1]+p[0]) + 6*u*(p[3]-2*p[2]+p[1])
                speeds = np.linalg.norm(d, axis=1)
                curvature = (d[:, 0]*dd[:, 1] - d[:, 1]*dd[:, 0]) / np.maximum(speeds, 1e-10)**3
                midpoint = (p[0] + 3*p[1] + 3*p[2] + p[3]) / 8
            else:
                pos = p[0] + ((np.arange(24)+.5)/24)[:, None]*(p[1]-p[0])
                speeds = np.full(24, np.linalg.norm(p[1]-p[0]))
                curvature = np.zeros(24)
                midpoint = (p[0] + p[1]) / 2
            count += int(inside(midpoint))
            keep = np.array([inside(q) and not supported(q, color) for q in pos])
            ds = speeds[keep] / 24
            energy += float(np.sum(curvature[keep]**2 * ds))
            arc_length += float(ds.sum())
        # Group connected segments; parse_path preserves separate moves as gaps.
        groups = []
        for p in converted:
            if not groups or not np.allclose(groups[-1][-1][-1], p[0], atol=1e-8, rtol=0):
                groups.append([])
            groups[-1].append(p)
        for group in groups:
            pairs = list(zip(group, group[1:]))
            if np.allclose(group[-1][-1], group[0][0], atol=1e-8, rtol=0):
                pairs.append((group[-1], group[0]))
            for a, c in pairs:
                if inside(c[0]) and not supported(c[0], color):
                    ta, tc = tangent(a, True), tangent(c, False)
                    if np.linalg.norm(ta) and np.linalg.norm(tc):
                        energy += math.acos(float(np.clip(np.dot(ta, tc), -1, 1)))**2
    return dict(roughness=100 * energy / max(1., arc_length),
                complexity=100 * count / max(1, scope['perimeter']),
                segmentCount=count, includedArcLengthPx=arc_length)


def score_scope(labels, paths, scope, full_scope, palette, area, weights, deps, occupancy):
    np, _, _, cv2, ndi = deps
    l, t, r, b = scope['bounds']
    crop = labels[t:b, l:r]
    records, failures = [], []
    for index, fixed in enumerate(scope['colors']):
        raw_mask = crop == index
        mask = metric_mask(raw_mask, area, np, ndi)
        edge = boundary(mask, ndi)
        a, c = fixed['boundary'], edge
        scoring_active = bool(fixed['mask'].any() or mask.any())
        if a.any() and c.any():
            distances = np.concatenate((fixed['edt'][c], ndi.distance_transform_edt(~c)[a]))
            mean, p95 = float(distances.mean()), float(np.percentile(distances, 95))
        else:
            mean = p95 = scope['diagonal'] if a.any() or c.any() else 0.
        union = int((fixed['mask'] | mask).sum())
        iou = float((fixed['mask'] & mask).sum() / union) if union else 1.
        candidate_corners = corners(mask, area, np, cv2)
        ref_corners = fixed['corners']
        if len(ref_corners) and len(candidate_corners):
            distance = np.linalg.norm(ref_corners[:, None, :] - candidate_corners[None, :, :], axis=2)
            corner_score = float(np.concatenate((distance.min(axis=0), distance.min(axis=1))).mean())
        else:
            corner_score = scope['diagonal'] if len(ref_corners) or len(candidate_corners) else 0.
        candidate_topology = topology(raw_mask, area, np, ndi)
        fill = palette['background'] if index == 0 else palette['colors'][index-1]['color']
        if candidate_topology != fixed['topology']:
            failures.append(dict(color=fill, reference=fixed['topology'], candidate=candidate_topology))
        records.append(dict(color=fill, scoringActive=scoring_active,
                            referenceMetricAreaPx=int(fixed['mask'].sum()), candidateMetricAreaPx=int(mask.sum()),
                            chamferMeanPx=mean, chamferP95Px=p95, iou=iou,
                            cornerDisplacementPx=corner_score, referenceCornerCount=len(ref_corners),
                            candidateCornerCount=len(candidate_corners), referenceTopology=fixed['topology'],
                            candidateTopology=candidate_topology))
    curves = curve_metrics(paths, scope, full_scope, np)
    audit = boundary_audit(occupancy, scope, deps)
    active = [v for v in records if v['scoringActive']]
    divisor = max(1, len(active))
    parts = dict(boundary=sum(.7*v['chamferMeanPx'] + .3*v['chamferP95Px'] for v in active)/divisor,
                 overlap=sum(1-v['iou'] for v in active)/divisor,
                 corners=sum(v['cornerDisplacementPx'] for v in active)/divisor,
                 roughness=curves['roughness'], complexity=curves['complexity'],
                 gaps=audit['gapFraction'], overlaps=audit['overlapFraction'])
    weighted = {key: weights[key]*value for key, value in parts.items()}
    score = math.fsum(weighted.values())
    if not math.isfinite(score):
        raise ValueError('Nonfinite candidate score; weights or geometry exceed numerical range')
    return dict(score=score, parts=parts, weightedParts=weighted, colors=records, boundaryMetrics=audit,
                topologyFailures=failures, curveMetrics=curves)


class Search:
    """Seeded maximin coarse sampling followed by one-coordinate local neighbors."""
    def __init__(self, base, axes, seed, trials):
        self.base, self.axes = base, axes
        self.keys = sorted(axes)
        self.rng = random.Random(seed)
        self.seen = set()
        self.history = []
        self.coarse_budget = max(1, math.ceil(trials / 2))
        self.size = math.prod(len(axes[k]) for k in self.keys)

    def signature(self, params):
        return tuple(params[k] for k in self.keys)

    def grid(self, index):
        params = dict(self.base)
        for key in self.keys:
            values = self.axes[key]
            index, digit = divmod(index, len(values))
            params[key] = values[digit]
        return params

    def next(self, best):
        if not self.history:
            params, stage, parent = dict(self.base), 'baseline', None
        else:
            pool, parent = [], None
            if (len(self.history) >= self.coarse_budget and best is not None
                    and all(best['parameters'][key] in self.axes[key] for key in self.keys)):
                for key in self.keys:
                    values = self.axes[key]
                    current = best['parameters'][key]
                    lower = [v for v in values if v < current]
                    upper = [v for v in values if v > current]
                    for value in ([lower[-1]] if lower else []) + ([upper[0]] if upper else []):
                        p = {**best['parameters'], key: value}
                        if self.signature(p) not in self.seen:
                            pool.append(p)
                parent = best['id']
            if pool:
                params, stage = self.rng.choice(pool), 'refine'
            else:
                # Bound memory even for large Cartesian products. The sequential
                # fallback guarantees exhaustion is real, not random collisions.
                indices = (self.rng.sample(range(self.size), min(256, self.size)) if self.size <= sys.maxsize
                           else list(dict.fromkeys(self.rng.randrange(self.size) for _ in range(256))))
                pool = [self.grid(i) for i in indices if self.signature(self.grid(i)) not in self.seen]
                if not pool:
                    for i in range(self.size):
                        p = self.grid(i)
                        if self.signature(p) not in self.seen:
                            pool = [p]
                            break
                if not pool:
                    return None
                def diversity(p):
                    return min(sum(((p[k]-old[k])/max(1e-12, self.axes[k][-1]-self.axes[k][0]))**2
                                   for k in self.keys if len(self.axes[k]) > 1) for old in self.history)
                params = max(pool, key=diversity)
                stage = 'coarse' if len(self.history) < self.coarse_budget else 'explore'
                parent = None
        self.seen.add(self.signature(params))
        self.history.append(params)
        return params, dict(stage=stage, parent=parent, choices={k: params[k] for k in self.keys})


def contact_sheet(records, out, bounds, deps):
    _, Image, ImageDraw, _, _ = deps
    if not records:
        return None
    sheet = Image.new('RGB', (320 * min(3, len(records)), 260 * math.ceil(len(records)/3)), 'white')
    draw = ImageDraw.Draw(sheet)
    for i, record in enumerate(records):
        x, y = (i % 3)*320, (i // 3)*260
        preview = record.get('preview')
        if preview and Path(preview).is_file():
            with Image.open(preview) as im:
                thumb = im.convert('RGBA')
                thumb = Image.alpha_composite(Image.new('RGBA', thumb.size, 'white'), thumb).convert('RGB')
                if bounds:
                    thumb = thumb.crop(bounds)
                thumb.thumbnail((312, 218))
                sheet.paste(thumb, (x, y))
        score = record.get('displayScore', record['score'])
        text = 'error' if score is None else f'{score:.5f}'
        draw.text((x+4, y+224), f"{record['id']} score={text}", fill='black')
        draw.text((x+4, y+240), f"eligible={record['eligible']}", fill='black')
    with out.open('xb') as stream:
        sheet.save(stream, format='PNG')
    return str(out)


def execute(request):
    deps = dependencies()
    np, Image, _, _, _ = deps
    params, paths, palette, source, reference, reference_labels, colors, options = prepare(request, deps)
    width, height = reference.size
    scopes = {'fullImage': fixed_scope(reference_labels, [0, 0, width, height], len(colors), options['minFeatureArea'], deps)}
    for region in options['regions']:
        scopes[region['name']] = fixed_scope(reference_labels, region['bounds'], len(colors), options['minFeatureArea'], deps,
                                             reference_depth=scopes['fullImage']['foregroundDepthPx'])
    out = paths['out']
    out.mkdir(exist_ok=False)
    frozen_input = out / ('source' + paths['input'].suffix)
    with frozen_input.open('xb') as stream:
        stream.write(source)
    frozen_palette = out / 'palette.json'
    trace.write_json(frozen_palette, palette)
    palette_hash = hashlib.sha256(frozen_palette.read_bytes()).hexdigest()
    reference_path = out / 'reference.png'
    with reference_path.open('xb') as stream:
        reference.save(stream, format='PNG')
    source_hash = hashlib.sha256(source).hexdigest()
    reference_hash = hashlib.sha256(reference_path.read_bytes()).hexdigest()
    search = Search(params, options['axes'], options['seed'], options['trials'])
    records = []
    best = None
    def rank(record):
        return (not record['eligible'], record['score'] is None,
                record['score'] if record['score'] is not None else 0, record['index'])
    with (out / 'candidates.jsonl').open('x', encoding='utf-8') as log:
        for index in range(options['trials']):
            choice = search.next(best)
            if choice is None:
                break
            candidate_params, selection = choice
            candidate_id = f'candidate_{index:03d}'
            candidate_out = out / candidate_id
            record = dict(id=candidate_id, index=index, parameters=candidate_params, selection=selection,
                          out=str(candidate_out), score=None, eligible=False, failures=[], scopes={},
                          sourceSha256=source_hash, referenceSha256=reference_hash)
            print(f"image.optimize: {index+1}/{options['trials']} {candidate_id} {selection['stage']}", file=sys.stderr, flush=True)
            try:
                traced = trace.execute(dict(candidate_params, input=str(frozen_input),
                                            palette=str(frozen_palette), out=str(candidate_out)))['result']
                if traced['sourceSha256'] != source_hash or traced['palette'] != palette:
                    raise ValueError('Frozen source/palette integrity mismatch')
                record['preview'] = traced['files']['preview']
                record['traceReport'] = traced['files']['report']
                if 'traceDetailAudit' in traced:
                    record['traceDetailAudit'] = traced['traceDetailAudit']
                with Image.open(record['preview']) as image:
                    if image.size != reference.size:
                        raise ValueError('Candidate render dimensions differ from reference')
                    rendered = Image.alpha_composite(Image.new('RGBA', image.size, palette['background']), image.convert('RGBA')).convert('RGB')
                candidate_labels, _ = labels_for(rendered, colors, np)
                curves = svg_segments(traced['files']['contours'], palette)
                occupancy = color_occupancy(Path(traced['files']['contours']).read_bytes(), reference.size, palette, deps)
                for name, scope in scopes.items():
                    measured = score_scope(candidate_labels, curves, scope, scopes['fullImage'], palette,
                                           options['minFeatureArea'], options['weights'], deps, occupancy)
                    record['scopes'][name] = measured
                    record['failures'].extend(dict(scope=name, **failure) for failure in measured['topologyFailures'])
                # Normalize weights first to avoid overflow when region weights are large.
                scale = max([1.] + [r['weight'] for r in options['regions']])
                denominator = 1/scale + sum(r['weight']/scale for r in options['regions'])
                score = math.fsum([record['scopes']['fullImage']['score'] * (1/scale/denominator)] +
                                  [r['weight']/scale/denominator * record['scopes'][r['name']]['score'] for r in options['regions']])
                if not math.isfinite(score):
                    raise ValueError('Nonfinite global score')
                record['score'] = score
                record['eligible'] = not record['failures']
            except Exception as exc:
                record['error'] = dict(type=type(exc).__name__, message=str(exc), partialOutput=str(candidate_out))
                record['failures'].append(dict(reason='candidate_error', **record['error']))
                print(f'image.optimize: {candidate_id}: {type(exc).__name__}: {exc}', file=sys.stderr, flush=True)
            records.append(record)
            log.write(json.dumps(record, allow_nan=False) + '\n')
            log.flush()
            scored = [r for r in records if r['score'] is not None]
            best = min(scored, key=rank) if scored else None
    ranking = sorted(records, key=rank)
    eligible = [r for r in ranking if r['eligible']]
    winner = eligible[0] if eligible else None
    settings = dict(input=str(paths['input']), palette=str(paths['palette']), **winner['parameters']) if winner else None
    trace.write_json(out / 'best_settings.json', settings)
    trace.write_json(out / 'ranking.json', ranking)
    top_sheet = contact_sheet(ranking[:options['topK']], out / 'top_candidates.png', None, deps)
    regional = []
    for index, region in enumerate(options['regions']):
        name = region['name']
        ordered = sorted([r for r in records if name in r['scopes'] and r['score'] is not None],
                         key=lambda r: (not r['eligible'], r['scopes'][name]['score'], r['index']))
        valid = [r for r in ordered if r['eligible']]
        sheet_records = [dict(r, displayScore=r['scopes'][name]['score']) for r in ordered[:options['topK']]]
        regional.append(dict(**region, best=valid[0]['id'] if valid else None,
                             ranking=[dict(id=r['id'], score=r['scopes'][name]['score'], eligible=r['eligible']) for r in ordered],
                             contactSheet=contact_sheet(sheet_records, out / f'region_{index:03d}_top.png', region['bounds'], deps)))
    report = dict(status='completed' if winner else 'no_eligible_candidate', input=str(paths['input']), out=str(out),
                  sourceSha256=source_hash, palette=palette, paletteSha256=palette_hash, background=palette['background'],
                  reference=dict(path=str(reference_path), sha256=reference_hash,
                                 origin=request.get('reference', 'source_rgba_composite_white_palette_rules_no_preprocessing')),
                  frozenInput=str(frozen_input), frozenPalette=str(frozen_palette),
                  imageSize=dict(width=width, height=height), base=params, search=options['axes'],
                  seed=options['seed'], trials=options['trials'], evaluated=len(records), topK=options['topK'],
                  minFeatureArea=options['minFeatureArea'], weights=options['weights'], metricDefinition=METRICS,
                  searchMethod='seeded maximin pool (up to 256 grid draws), then adjacent one-coordinate neighbors of best scored candidate; '
                               'eligibility-first incumbent; diverse exploration when neighbors exhausted; not Bayesian',
                  coarseBudget=search.coarse_budget, stopReason='budget' if len(records) == options['trials'] else 'search_exhausted',
                  best=dict(id=winner['id'], path=winner['out'], score=winner['score'], settings=str(out / 'best_settings.json')) if winner else None,
                  topCandidates=[r['id'] for r in eligible[:options['topK']]], regional=regional,
                  candidates=records, geometryValidated=False,
                  baselineBoundaryMetrics=({name: value['boundaryMetrics'] for name, value in records[0]['scopes'].items()}
                                           if records and records[0]['scopes'] else None),
                  bestBoundaryMetrics=({name: value['boundaryMetrics'] for name, value in winner['scopes'].items()}
                                       if winner else None),
                  dependencies={**{p: trace.importlib.metadata.version(p) for p in ('numpy', 'Pillow', 'vtracer', 'CairoSVG', 'scipy')},
                                'opencv': deps[3].__version__},
                  files=dict(ranking=str(out / 'ranking.json'), candidates=str(out / 'candidates.jsonl'),
                             bestSettings=str(out / 'best_settings.json'), report=str(out / 'report.json'), topCandidates=top_sheet),
                  limitations=['Bounded discrete heuristic, not a universal optimum; no CAD operations or geometry validation.',
                               'Gap/overlap audit is independent distinct-color occupancy at scale 1, alpha >= 128; subpixel defects may be missed. '
                               'Only gaps deeper than 2 reference pixels receive the gaps penalty; all raw and contour-offset gaps remain reported. '
                               'No repair is performed and topology eligibility is unchanged.',
                               'Regional winners are comparisons of the same whole-image candidates, never spliced geometry; winners require global eligibility.',
                               'Topology ignores features below minFeatureArea and those removed by 3x3 opening; narrow real features may be removed too.',
                               'Corner detection and sampled curvature are pixel-scale heuristics; small rounding, cusps between samples and subtle oscillations may escape detection.',
                               'Fidelity averages include only scoringActive colors, including significant background; overlapping regions intentionally receive repeated weight.',
                               'Physical widthMm and mirrorX are fixed tunables, but trace scale still uses each processed foreground bounding box.',
                               'best_settings.json is an image.trace request without out; original input/palette must retain their hashes/content. Frozen copies are retained.',
                               'Individual candidate errors and partial artifacts are retained without retry; first source frame, no EXIF reorientation.'])
    trace.write_json(out / 'report.json', report)
    return dict(success=True, operation='image.optimize', result=report)


def main():
    try:
        raw = sys.stdin.read(32 * 1024 * 1024 + 1)
        if len(raw) > 32 * 1024 * 1024:
            raise ValueError('Worker JSON input exceeds limit')
        result = execute(json.loads(raw))
        report = result['result']
        summary = dict(status=report['status'], best=report['best'], evaluatedTrials=report['evaluated'],
                       eligibleCount=sum(c['eligible'] for c in report['candidates']),
                       regions=[dict(name=r['name'], best=r['best']) for r in report['regional']],
                       baselineBoundaryMetrics=report['baselineBoundaryMetrics'], bestBoundaryMetrics=report['bestBoundaryMetrics'],
                       files=report['files'], geometryValidated=False)
        print(json.dumps(dict(success=True, operation='image.optimize', result=summary), allow_nan=False))
    except Exception as exc:
        print(f'image.optimize: {type(exc).__name__}: {exc}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())

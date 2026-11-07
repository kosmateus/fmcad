"""Pure partition vectorization; coordinates are cell-edge coordinates / scale.

vectorize_shared returns:
  paths: [{label, region, is_hole, segments, chain_refs}]
  chains: [{id, regions: [left_region, right_region], segments}]
  sharedEdges: number of chains incident to two input regions
  diagnostics: counts, requested/used tolerance and sampled fit deviation

Segments are ('L', [p0, p1]) or ('C', [p0, p1, p2, p3]); points are
[x, y] floats in original image pixels (y down). Each path is one closed
ring. Positive signed area denotes a shell; holes have negative area. Group
rings by region, not just palette label. Region IDs start at 1. Left/right
refer to positive/negative cross-product sides in the numerical coordinate
plane (not visual left/right in a y-down display). Background (label 0) is
included; the exterior has region -1 and has no path. chain_refs entries have keys
chain and reversed. Reversal copies controls in exactly the opposite order.

The error and topology checks are sampled, not analytic Bezier guarantees.
Four distinct labels may meet. Diagonal pinches require explicit repair. Raster
stair steps below the requested tolerance need not survive, but significant
corners do. No raster I/O, CAD operations, or global state are used.
"""

import math

import numpy as np
from scipy import ndimage
from shapely import STRtree, linestrings, points as shapely_points
from shapely.errors import GEOSException
from shapely.geometry import LineString, MultiPoint, Polygon, box
from shapely.ops import unary_union


def _unit(v):
    length = np.linalg.norm(v)
    if length < 1e-14:
        raise ValueError('Degenerate boundary tangent')
    return v / length


def _sampled_deviation(a, b):
    """Symmetric vertex/quarter-edge distance to the opposite sampled polyline.

    Spatial indexing avoids GEOS Hausdorff's all-pairs segment work on long
    boundaries. This is still a sampled error, not an analytic curve bound.
    """
    a, b = np.asarray(a), np.asarray(b)
    maximum = 0.
    for source, target in ((a, b), (b, a)):
        tree = STRtree(linestrings(np.stack((target[:-1], target[1:]), axis=1)))
        delta = np.diff(source, axis=0)
        for fraction in (0., 0.25, 0.5, 0.75, 1.):
            queries = shapely_points(source[:-1] + fraction * delta)
            _, distances = tree.query_nearest(queries, return_distance=True, all_matches=False)
            maximum = max(maximum, float(distances.max()))
    return maximum


def _rdp(points, error):
    keep = {0, len(points) - 1}
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        chord = points[b] - points[a]
        norm = float(chord @ chord)
        delta = points[a + 1:b] - points[a]
        t = np.clip(delta @ chord / norm, 0, 1) if norm else np.zeros(len(delta))
        distances = np.linalg.norm(delta - t[:, None] * chord, axis=1)
        k = int(np.argmax(distances))
        if distances[k] > error:
            split = a + 1 + k
            keep.add(split)
            stack.extend(((a, split), (split, b)))
    return sorted(keep)


def _tangent(points, index, window, closed=False):
    if closed:
        n = len(points) - 1
        window = min(window, max(1, n // 4))
        return _unit(points[(index + window) % n] - points[(index - window) % n])
    return _unit(points[min(len(points) - 1, index + window)]
                 - points[max(0, index - window)])


def _cubic_fit(points, start, end, error, window):
    """Schneider-style chord-parameter least squares, recursively split.

    end points backwards into the span. Split tangents are shared. Lines
    are deliberately NOT a recursive fallback for poorly fitting curves.
    """
    result = []
    stack = [(points, start, end, 0)]
    while stack:
        p, t0, t1, depth = stack.pop()
        distances = np.linalg.norm(np.diff(p, axis=0), axis=1)
        u = np.r_[0., np.cumsum(distances)]
        u /= u[-1]
        v = 1 - u
        basis = np.column_stack((v ** 3, 3 * u * v ** 2, 3 * u ** 2 * v, u ** 3))
        a = np.stack((basis[:, 1, None] * t0, basis[:, 2, None] * t1), axis=2)
        residual = p - (basis[:, 0] + basis[:, 1])[:, None] * p[0] \
            - (basis[:, 2] + basis[:, 3])[:, None] * p[-1]
        alpha = np.linalg.lstsq(a.reshape(-1, 2), residual.reshape(-1), rcond=None)[0]
        chord = np.linalg.norm(p[-1] - p[0])
        if np.any(alpha < chord * 1e-6) or np.any(alpha > u.size * distances.max() * 2):
            alpha[:] = chord / 3
        if len(p) == 2:
            # Keep terminal cubic hulls within tolerance of their cell edge,
            # without losing the shared split/seam tangent direction.
            alpha = np.minimum(alpha, error)
        controls = np.array([p[0], p[0] + alpha[0] * t0,
                             p[-1] + alpha[1] * t1, p[-1]])
        deviation = np.linalg.norm(basis @ controls - p, axis=1)
        split = int(np.argmax(deviation))
        acceptable = len(p) <= 2
        # Chord parameters are a fitting heuristic, not a geometric distance.
        # A point may lie on the fitted curve at a different parameter; do not
        # split a geometrically acceptable span merely for that mismatch.
        if not acceptable:
            sampled = _sample([('C', controls.tolist())], error / 16)
            acceptable = _sampled_deviation(p, sampled) <= error
            if not acceptable and deviation[split] <= error:
                split = len(p) // 2
        if acceptable:
            result.append(('C', controls.tolist()))
            continue
        if depth >= 32:
            raise ValueError('Cubic fitting exceeded recursion limit')
        split = min(len(p) - 2, max(1, split))
        if depth >= 8:
            split = max(len(p)//4, min(3*len(p)//4, split))
            split = min(len(p)-2, max(1, split))
        tangent = _tangent(p, split, min(window, split, len(p) - 1 - split))
        stack.append((p[split:], tangent, t1, depth + 1))
        stack.append((p[:split + 1], t0, -tangent, depth + 1))
    return result


def _fit_chain(points, error, scale, corner_angle, domain):
    closed = np.array_equal(points[0], points[-1])
    if domain:
        # Domain edges must stay on the exact rectangular image boundary.
        indices = _rdp(points, 0.)
        return [('L', points[[a, b]].tolist()) for a, b in zip(indices, indices[1:])]
    if closed:
        directions = np.sign(np.diff(points, axis=0))
        turns = np.flatnonzero(np.any(directions != np.roll(directions, 1, axis=0), axis=1)).tolist()
        if len(turns) == 4:
            # Exact cell rectangles are intentional, even below the general
            # corner detector's minimum span of three cells / one image pixel.
            return [('L', points[[a, b]].tolist()) for a, b in zip(turns, turns[1:] + turns[:1])]
    simplified = _rdp(points, max(0.5 / scale, error * 0.8))
    candidates = simplified[:-1] if closed else simplified
    corners = []
    for j, index in enumerate(candidates):
        if not closed and j in (0, len(candidates) - 1):
            continue
        before = points[index] - points[candidates[j - 1]]
        after = points[candidates[(j + 1) % len(candidates)]] - points[index]
        lengths = np.linalg.norm(before), np.linalg.norm(after)
        if min(lengths) < max(3. / scale, 1.):
            continue
        angle = math.degrees(math.acos(float(np.clip(_unit(before) @ _unit(after), -1, 1))))
        if angle >= corner_angle:
            corners.append(index)
    window = max(1, int(math.ceil(scale)))
    if closed and not corners:
        cuts = sorted(set([0, len(points) - 1] +
                          [int((len(points) - 1) * k / 4) for k in (1, 2, 3)]))
        segments = []
        for a, b in zip(cuts, cuts[1:]):
            segments.extend(_cubic_fit(points[a:b + 1], _tangent(points, a, window, True),
                                       -_tangent(points, b, window, True), error, window))
        return segments
    if closed:
        seam = corners[0]
        n = len(points) - 1
        points = np.concatenate((points[seam:n], points[:seam + 1]))
        cuts = sorted((i - seam) % n for i in corners) + [n]
    else:
        cuts = [0] + corners + [len(points) - 1]
    segments = []
    for a, b in zip(cuts, cuts[1:]):
        span = points[a:b + 1]
        chord = span[-1] - span[0]
        length = np.linalg.norm(chord)
        if length >= 1.:
            t = np.clip((span - span[0]) @ chord / length ** 2, 0, 1)
            residual = np.linalg.norm(span - span[0] - t[:, None] * chord, axis=1).max()
            if residual <= error:
                segments.append(('L', span[[0, -1]].tolist()))
                continue
        segments.extend(_cubic_fit(span, _tangent(span, 0, window),
                                   -_tangent(span, len(span) - 1, window), error, window))
    return segments


def _sample(segments, error):
    """Adaptive control-hull flattening; also limit chord sampling spacing."""
    result = [segments[0][1][0]]
    for kind, controls in segments:
        if kind == 'L':
            result.append(controls[-1])
            continue
        stack = [(np.asarray(controls), 0)]
        while stack:
            p, depth = stack.pop()
            chord = p[-1] - p[0]
            if np.linalg.norm(chord) <= 0.25:
                norm = float(chord @ chord)
                t = np.clip((p - p[0]) @ chord / norm, 0, 1) if norm else np.zeros(4)
                flat = np.linalg.norm(p - p[0] - t[:, None] * chord, axis=1).max()
                if flat <= error:
                    result.append(p[-1].tolist())
                    continue
            if depth >= 24:
                raise ValueError('Bezier sampling exceeded subdivision limit')
            q = (p[:-1] + p[1:]) / 2
            r = (q[:-1] + q[1:]) / 2
            middle = (r[0] + r[1]) / 2
            stack.append((np.array([middle, r[1], q[2], p[3]]), depth + 1))
            stack.append((np.array([p[0], q[0], r[0], middle]), depth + 1))
    return result


def _reverse(segments):
    return [(kind, list(reversed(controls))) for kind, controls in reversed(segments)]


def _area(points):
    p = np.asarray(points)
    return float(np.sum(p[:-1, 0] * p[1:, 1] - p[1:, 0] * p[:-1, 1]) / 2)


class _InvalidRegions(ValueError):
    def __init__(self, regions):
        super().__init__('Pinched, touching or self-intersecting region rings')
        self.regions = regions


def _polygons(rings):
    grouped = {}
    for region, points, hole in rings:
        grouped.setdefault(region, ([], []))[int(hole)].append(points)
    polygons = []
    invalid = []
    for region, (shells, holes) in grouped.items():
        if len(shells) != 1:
            raise ValueError('A connected region must have exactly one simple shell')
        polygon = Polygon(shells[0], holes)
        if not polygon.is_valid or polygon.area <= 0:
            invalid.append(region)
        polygons.append(polygon)
    if invalid:
        raise _InvalidRegions(invalid)
    return polygons


def _conflicting_chains(chains, samples, regions):
    """Locate crossings/touches in invalid regions, allowing shared endpoints.

    A defect in one hole must not force the unrelated outer ring (or every
    other hole of the same region) to reproduce finer raster stair steps.
    """
    incident = [i for i, c in enumerate(chains) if any(r in regions for r in c['regions'])]
    lines = [LineString(samples[i]) for i in incident]
    tree = STRtree(lines)
    conflicts = set()
    for j, line in enumerate(lines):
        i = incident[j]
        if not line.is_simple:
            conflicts.add(i)
        for k in tree.query(line, predicate='intersects'):
            if k <= j:
                continue
            other = incident[k]
            endpoints = set(map(tuple, (samples[i][0], samples[i][-1]))) & \
                set(map(tuple, (samples[other][0], samples[other][-1])))
            crossing = line.intersection(lines[k])
            if not crossing.difference(MultiPoint(list(endpoints))).is_empty:
                conflicts.update((i, other))
    return conflicts or set(incident)


def repair_junctions(labels, scale=2, reference=None, protected=None, max_area_px2=4096,
                     allow_component_joins=True, join_groups=None):
    """Deterministic one-cell repairs; never mutate input or protected cells.

    Local/global connectivity tests prevent splitting meaningful components.
    Prefer separation; joining existing diagonal contacts is a recorded second
    choice unless allow_component_joins=False. Single-cell noise removal is
    recorded, never a global filter. Protected component witnesses prevent it.
    join_groups may identify disconnected raster fragments of the SAME source
    region; those joins remain allowed when general component joins are disabled.
    """
    result = labels.copy()
    records = []
    changed = set()
    component_ids = np.zeros(result.shape, np.int32)
    offset = 0
    for color in np.unique(result):
        mask = result == color
        ids, count = ndimage.label(mask)
        component_ids[mask] = ids[mask]+offset
        offset += count
    groups = {}
    if join_groups is not None:
        indices = np.arange(1, offset+1)
        low = ndimage.minimum(np.where(join_groups > 0, join_groups, np.iinfo(np.int32).max),
                              component_ids, indices)
        high = ndimage.maximum(join_groups, component_ids, indices)
        groups = {i:int(a) if a == b and b > 0 else -i
                  for i,a,b in zip(indices, low, high)}
    def ambiguous(a):
        return ((a[:-1, :-1] == a[1:, 1:]) & (a[:-1, :-1] != a[:-1, 1:]) &
                (a[:-1, :-1] != a[1:, :-1])) | ((a[:-1, 1:] == a[1:, :-1]) &
                (a[:-1, 1:] != a[:-1, :-1]) & (a[:-1, 1:] != a[1:, 1:]))
    for iteration in range(16):
        ys, xs = np.nonzero(ambiguous(result))
        if not len(ys):
            return result, dict(changedPixels=records, changedAreaPx2=len(records)/scale**2,
                                maxRepairAreaPx2=max_area_px2, maxDeviationPx=1/scale,
                                removedNoiseCells=sum(r['removedIsolatedCell'] for r in records),
                                policy='one working cell per diagonal ambiguity; no component splits; ' +
                                    ('recorded point-contact joins' if allow_component_joins else
                                     'only same-source-region joins' if join_groups is not None else 'no component joins'))
        progress = False
        for y, x in zip(ys.tolist(), xs.tolist()):
            if not ambiguous(result[y:y+2, x:x+2])[0, 0]:
                continue
            options = []
            for yy, xx in ((y,x), (y,x+1), (y+1,x), (y+1,x+1)):
                if (yy,xx) in changed:
                    continue
                if protected is not None and protected[yy, xx]:
                    continue
                old = int(result[yy,xx])
                patch = np.pad(result[max(0,yy-1):yy+2,max(0,xx-1):xx+2],
                               ((int(yy==0), int(yy==result.shape[0]-1)),
                                (int(xx==0), int(xx==result.shape[1]-1))), constant_values=-1)
                for new in sorted(set(result[y:y+2,x:x+2].flat)-{old}):
                    trial = patch.copy(); trial[1,1] = new
                    # Preserve local 4-connected components of both materials.
                    if ndimage.label(trial == old)[1] > ndimage.label(patch == old)[1]:
                        old_mask = component_ids == component_ids[yy,xx]
                        old_mask[yy,xx] = False
                        if ndimage.label(old_mask)[1] > 1:
                            continue
                    neighbors = [(a,b) for a,b in ((yy-1,xx),(yy+1,xx),(yy,xx-1),(yy,xx+1))
                                 if 0<=a<result.shape[0] and 0<=b<result.shape[1] and result[a,b]==new]
                    receiving = {int(component_ids[a,b]) for a,b in neighbors}
                    if not receiving:
                        continue
                    if not allow_component_joins and len(receiving) > 1 and not (
                            groups and len({groups[i] for i in receiving}) == 1):
                        continue
                    block = result[y:y+2,x:x+2].copy(); block[yy-y,xx-x] = new
                    if ambiguous(block)[0,0]:
                        continue
                    support = int(np.count_nonzero(patch == new))
                    guided = reference is not None and reference[yy,xx] == new
                    remaining = int(ambiguous(trial).sum())
                    options.append((remaining, len(receiving)-1, -int(guided), -support, yy, xx, int(new), old))
            if not options:
                continue
            _, merges, _, _, yy, xx, new, old = min(options)
            if (len(records)+1)/scale**2 > max_area_px2:
                raise ValueError('Junction repair area budget exceeded')
            isolated = not any(0<=a<result.shape[0] and 0<=b<result.shape[1] and result[a,b]==old
                for a,b in ((yy-1,xx),(yy+1,xx),(yy,xx-1),(yy,xx+1)))
            result[yy,xx] = new
            changed.add((yy,xx))
            receiving = {int(component_ids[a,b]) for a,b in
                ((yy-1,xx),(yy+1,xx),(yy,xx-1),(yy,xx+1))
                if 0<=a<result.shape[0] and 0<=b<result.shape[1] and result[a,b]==new}
            if len(receiving)>1:
                component_ids[np.isin(component_ids, list(receiving))] = min(receiving)
            component_ids[yy,xx] = next(component_ids[a,b] for a,b in
                ((yy-1,xx),(yy+1,xx),(yy,xx-1),(yy,xx+1))
                if 0<=a<result.shape[0] and 0<=b<result.shape[1] and result[a,b]==new)
            records.append(dict(x=xx,y=yy,oldLabel=old,newLabel=new,
                                removedIsolatedCell=isolated,joinedPointContactComponents=merges))
            progress = True
        if not progress:
            break
    y, x = np.argwhere(ambiguous(result))[0]
    raise ValueError(f'Unresolved diagonal touching/pinched junction at {x},{y}: '
                     f'{result[max(0,y-1):y+3,max(0,x-1):x+3].tolist()} '
                     f'after {len(records)} repairs')


def vectorize_shared(labels, scale=1, fit_error_px=0.35, corner_angle=55):
    """Fit shared boundaries once. See module docstring for the public schema.

    Nonempty 2-D integer arrays, IDs 0..2**31-1, at most 64 million cells.
    scale and fit_error_px must be finite and positive; corner_angle is a
    turning angle in (0, 180). ValueError means unsupported/invalid input or
    a partition that cannot pass sampled validation in three attempts. Retries
    tighten only offending chains when the failure can be localized; shared
    controls, junctions and corner detection are unchanged. tolerance_used_px
    is the largest chain tolerance; chain_tolerances_px gives each actual bound.
    """
    if not isinstance(labels, np.ndarray) or labels.ndim != 2 or not labels.size:
        raise ValueError('labels must be a nonempty HxW numpy array')
    if labels.size > 64_000_000:
        raise ValueError('labels exceeds the 64 million cell limit')
    if labels.dtype.kind not in 'iu' or labels.min() < 0 or labels.max() > 2 ** 31 - 1:
        raise ValueError('labels must contain integer palette IDs in [0, 2**31-1]')
    for name, value in [('scale', scale), ('fit_error_px', fit_error_px), ('corner_angle', corner_angle)]:
        if isinstance(value, (bool, np.bool_)) or not isinstance(value, (int, float, np.number)) \
                or not np.isrealobj(value):
            raise ValueError(name + ' must be a finite positive number')
        try:
            valid = math.isfinite(value) and value > 0
        except OverflowError:
            valid = False
        if not valid:
            raise ValueError(name + ' must be a finite positive number')
    if corner_angle >= 180:
        raise ValueError('corner_angle must be less than 180 degrees')
    h, w = labels.shape
    regions = np.empty(labels.shape, dtype=np.int32)
    region_labels = []
    # C-level 4-connected labeling; Python loops only over colors and boundaries.
    for palette_id in np.unique(labels):
        mask = labels == palette_id
        components, count = ndimage.label(mask)
        regions[mask] = components[mask] + len(region_labels)
        region_labels.extend([int(palette_id)] * count)
    del mask, components
    stride = w + 1
    y, x = np.nonzero(regions[:-1] != regions[1:])
    horizontal = np.column_stack(((y + 1) * stride + x, (y + 1) * stride + x + 1,
                                  regions[y + 1, x], regions[y, x]))
    y, x = np.nonzero(regions[:, :-1] != regions[:, 1:])
    vertical = np.column_stack((y * stride + x + 1, (y + 1) * stride + x + 1,
                                regions[y, x], regions[y, x + 1]))
    x = np.arange(w)
    y = np.arange(h)
    top = np.column_stack((x, x + 1, regions[0], np.full(w, -1)))
    bottom = np.column_stack((h * stride + x, h * stride + x + 1, np.full(w, -1), regions[-1]))
    left = np.column_stack((y * stride, (y + 1) * stride, np.full(h, -1), regions[:, 0]))
    right = np.column_stack((y * stride + w, (y + 1) * stride + w, regions[:, -1], np.full(h, -1)))
    edges = np.concatenate((horizontal, vertical, top, bottom, left, right)).tolist()
    del regions, horizontal, vertical, top, bottom, left, right
    graph = {}
    for i, (a, b, _, _) in enumerate(edges):
        graph.setdefault(a, []).append(i)
        graph.setdefault(b, []).append(i)
    pairs = [tuple(sorted(edge[2:])) for edge in edges]
    junctions = set()
    for node, incident in graph.items():
        if len(incident) > 3 and len({region_labels[r-1] if r > 0 else -1
                                    for i in incident for r in edges[i][2:]}) != 4:
            raise ValueError('Ambiguous four-way touching/pinched boundary node')
        if len(incident) != 2 or pairs[incident[0]] != pairs[incident[1]]:
            junctions.add(node)
    seen = set()
    chains = []
    for first, edge in enumerate(edges):
        if first in seen:
            continue
        # Reach a chain endpoint first; otherwise this is a closed chain.
        node = edge[0]
        current = first
        walked = set()
        while node not in junctions and current not in walked:
            walked.add(current)
            a, b = edges[current][:2]
            node = b if node == a else a
            if node in junctions:
                break
            current = next(i for i in graph[node] if i != current)
        start = node
        first_edge = current
        nodes = [node]
        incident_regions = None
        while True:
            a, b, l, r = edges[current]
            forward = node == a
            sides = (l, r) if forward else (r, l)
            if incident_regions is None:
                incident_regions = sides
            elif sides != incident_regions:
                raise ValueError('Inconsistent oriented region adjacency')
            seen.add(current)
            node = b if forward else a
            nodes.append(node)
            if node in junctions or node == start:
                break
            current = next(i for i in graph[node] if i != current)
            if current == first_edge:
                raise ValueError('Boundary chain failed to close')
        points = np.array([[n % stride, n // stride] for n in nodes], dtype=float) / scale
        chains.append(dict(nodes=(nodes[0], nodes[-1]), regions=incident_regions, points=points))
    outgoing = {}
    directed = []
    for i, chain in enumerate(chains):
        for reverse, region in enumerate(chain['regions']):
            if region == -1:
                continue
            a, b = chain['nodes'][::(-1 if reverse else 1)]
            key = (region, a)
            if key in outgoing:
                raise ValueError('Ambiguous touching region boundary')
            outgoing[key] = (i, bool(reverse), b)
            directed.append((region, a))
    loops = []
    visited = set()
    for key in directed:
        if key in visited:
            continue
        region, node = key
        refs, points = [], []
        while (region, node) not in visited:
            visited.add((region, node))
            i, reverse, node = outgoing[(region, node)]
            refs.append(dict(chain=i, reversed=reverse))
            raw = chains[i]['points'][::(-1 if reverse else 1)].tolist()
            points.extend(raw if not points else raw[1:])
        if (region, node) != key:
            raise ValueError('Boundary loop joins another loop')
        loops.append(dict(region=region, refs=refs, raw=points, hole=_area(points) < 0))
    _polygons([(loop['region'], loop['raw'], loop['hole']) for loop in loops])
    domain = box(0, 0, w / scale, h / scale)
    failure = ''
    tolerances = [fit_error_px] * len(chains)
    retry_failures = []
    fitted, samples, deviations = [None]*len(chains), [None]*len(chains), [None]*len(chains)
    refit = set(range(len(chains)))
    for attempt in range(3):
        failed_chain = None
        try:
            for i in sorted(refit):
                failed_chain = i
                chain = chains[i]
                tolerance = tolerances[i]
                sample_error = min(tolerance / 16, 1 / (scale * 16))
                segments = _fit_chain(chain['points'], tolerance, scale, corner_angle,
                                      -1 in chain['regions'])
                # Corner rotation of a closed chain changes its seam, not geometry.
                sampled = _sample(segments, sample_error)
                deviation = _sampled_deviation(chain['points'], sampled)
                if deviation > tolerance + 1e-10:
                    raise ValueError('Sampled fit deviation exceeds tolerance')
                fitted[i] = segments
                samples[i] = sampled
                deviations[i] = deviation
            failed_chain = None
            paths, rings = [], []
            for loop in loops:
                segments, points = [], []
                for ref in loop['refs']:
                    i, reverse = ref['chain'], ref['reversed']
                    segments.extend(_reverse(fitted[i]) if reverse else fitted[i])
                    sampled = samples[i][::-1] if reverse else samples[i]
                    points.extend(sampled if not points else sampled[1:])
                if points[0] != points[-1] or (_area(points) < 0) != loop['hole']:
                    raise ValueError('Fitting changed ring closure or orientation')
                region = loop['region']
                rings.append((region, points, loop['hole']))
                paths.append(dict(label=region_labels[region - 1], region=region,
                                  is_hole=loop['hole'], segments=segments, chain_refs=loop['refs']))
            polygons = _polygons(rings)
            union = unary_union(polygons)
            area_epsilon = max(1e-10, domain.area * 1e-12)
            overlap = max(0., sum(p.area for p in polygons) - union.area)
            gap = domain.symmetric_difference(union).area
            if overlap > area_epsilon or gap > area_epsilon:
                raise ValueError('Fitted partition has sampled overlaps or gaps')
            return dict(paths=paths,
                        chains=[dict(id=i, regions=list(chain['regions']), segments=fitted[i])
                                for i, chain in enumerate(chains)],
                        sharedEdges=sum(-1 not in chain['regions'] for chain in chains),
                        diagnostics=dict(requested_fit_error_px=float(fit_error_px),
                                         tolerance_used_px=float(max(tolerances)), attempts=attempt + 1,
                                         chain_tolerances_px=[float(t) for t in tolerances],
                                         retry_failures=retry_failures,
                                         max_sampled_fit_deviation_px=max(deviations, default=0.),
                                         sampling_flatness_px=float(min(max(tolerances) / 16, 1 / (scale * 16))),
                                         error_metric='densified sampled symmetric Hausdorff',
                                         junction_count=len(junctions), chain_count=len(chains),
                                         region_count=len(region_labels), cell_edge_count=len(edges),
                                         sampled_overlap_area_px2=float(overlap),
                                         sampled_gap_area_px2=float(gap)))
        except (ValueError, GEOSException) as exc:
            failure = str(exc)
            if isinstance(exc, _InvalidRegions):
                refit = _conflicting_chains(chains, samples, exc.regions)
            elif failed_chain is not None:
                # Unvisited chains still need their first fit at the requested error.
                refit = {failed_chain}
            else:
                refit = set(range(len(chains)))
            retry_failures.append(dict(reason=failure, chains=sorted(refit)))
            for i in refit:
                tolerances[i] /= 2
            refit.update(i for i, segments in enumerate(fitted) if segments is None)
    raise ValueError('Shared-boundary fitting failed sampled validation after 3 attempts: ' + failure)

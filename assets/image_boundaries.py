"""Local conservative colored-boundary audit. No Fusion or source mutations.

execute(request) returns the image.boundaries envelope. The lazy shared helper
takes working-grid integer labels and returns L/C paths in source pixel edges,
not millimeters. Zero is background; palette declaration order defines 1..N.
"""
import sys

if __name__ == '__main__' and not __package__:
    sys.path.pop(0)  # The sibling inspect.py is not stdlib inspect.

import base64
import hashlib
import importlib.util
import io
import json
import math
from pathlib import Path
import re
import xml.etree.ElementTree as ET

_spec = importlib.util.spec_from_file_location('_boundaries_trace', Path(__file__).with_name('image_trace.py'))
trace = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(trace)

DEFAULTS = dict(referenceMode='source', mode='inspect', scale=2, maxGapWidthPx=2,
                maxOverlapWidthPx=2, maxChangedAreaPx=500, fitErrorPx=.35,
                cornerAngle=55, widthMm=50, mirrorX=False)


def shared_vectorize(labels, **kwargs):
    path = Path(__file__).with_name('image_shared_boundaries.py')
    if not path.is_file():
        raise RuntimeError('Shared boundary helper is unavailable; no independent fallback')
    spec = importlib.util.spec_from_file_location('_boundaries_shared', path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module.vectorize_shared(labels, **kwargs)


def parse_svg(data, size, fills):
    """Whitelist before Cairo sees any XML; retain compound nonzero subpaths."""
    if re.search(br'<!\s*(?:DOCTYPE|ENTITY)', data, re.I):
        raise ValueError('SVG declarations/entities are forbidden')
    root = ET.fromstring(data)
    if root.tag not in ('svg', '{' + trace.SVG + '}svg'):
        raise ValueError('Expected SVG root')
    if set(root.attrib) - {'width', 'height', 'viewBox', 'version'}:
        raise ValueError('Unsupported SVG root attributes')
    for name, expected in zip(('width', 'height'), size):
        value = root.get(name, '')
        if not re.fullmatch(trace.NUMBER + r'(?:px)?', value) or float(value.removesuffix('px')) != expected:
            raise ValueError('SVG dimensions must match reference')
    if 'viewBox' in root.attrib:
        values = re.split(r'[\s,]+', root.get('viewBox').strip())
        if len(values) != 4 or list(map(float, values)) != [0, 0, *size]:
            raise ValueError('SVG viewBox must match reference pixel edges')
    paths = []
    for node in root:
        if node.tag not in ('path', '{' + trace.SVG + '}path') or len(node):
            raise ValueError('Only direct SVG paths are accepted')
        if set(node.attrib) - {'d', 'fill', 'transform', 'fill-rule'}:
            raise ValueError('Unsupported SVG path attributes')
        if node.get('fill-rule', 'nonzero') != 'nonzero':
            raise ValueError('Only nonzero fill-rule is accepted')
        fill = trace.color(node.get('fill'))
        if fill not in fills:
            raise ValueError('SVG contains undeclared palette color')
        segments = trace.parse_path(node.get('d', ''), node.get('transform', ''))
        if not segments:
            raise ValueError('Empty SVG path')
        paths.append((fills.index(fill), dict(node.attrib, fill=fill)))
    return paths


def svg_bytes(paths, size):
    root = ET.Element('svg', xmlns=trace.SVG, width=str(size[0]), height=str(size[1]),
                      viewBox=f'0 0 {size[0]} {size[1]}')
    for _, attributes in paths:
        ET.SubElement(root, 'path', **attributes)
    return ET.tostring(root, encoding='utf-8')


def render_masks(paths, size, scale, count, np, Image, cairo):
    # Render each path separately: UNION is not winding cancellation across paths.
    masks = np.zeros((count, size[1]*scale, size[0]*scale), dtype=bool)
    for label, attributes in paths:
        if label == 0:
            continue
        data = cairo.svg2png(bytestring=svg_bytes([(label, attributes)], size),
                             output_width=size[0]*scale, output_height=size[1]*scale)
        with Image.open(io.BytesIO(data)) as image:
            masks[label] |= np.asarray(image.convert('RGBA'))[..., 3] >= 128
    return masks


def execute(request):
    if not isinstance(request, dict) or set(request) - set(DEFAULTS) - {'svg', 'reference', 'palette', 'out'}:
        raise ValueError('Request must contain only image.boundaries fields')
    paths = {}
    for key in ('svg', 'reference', 'palette', 'out'):
        value = request.get(key)
        if not isinstance(value, str) or not Path(value).is_absolute():
            raise ValueError(key + ' must be an absolute path')
        paths[key] = Path(value)
    p = {k: request.get(k, v) for k, v in DEFAULTS.items()}
    for key in ('maxGapWidthPx', 'maxOverlapWidthPx', 'maxChangedAreaPx', 'fitErrorPx', 'widthMm'):
        if not trace.numeric(p[key]) or p[key] <= 0:
            raise ValueError(key + ' must be finite and positive')
    if p['fitErrorPx'] > 2:
        raise ValueError('fitErrorPx must not exceed 2')
    if not trace.numeric(p['cornerAngle']) or not 0 <= p['cornerAngle'] <= 180:
        raise ValueError('cornerAngle must be in [0, 180]')
    if type(p['scale']) is not int or not 1 <= p['scale'] <= 4:
        raise ValueError('scale must be an integer in [1, 4]')
    if type(p['mirrorX']) is not bool:
        raise ValueError('mirrorX must be boolean')
    if p['mode'] not in ('inspect', 'repair') or p['referenceMode'] not in ('source', 'labels'):
        raise ValueError('Invalid mode or referenceMode')
    _, _, palette = trace.validate(dict(input=request['reference'], palette=request['palette'], out=request['out']))
    import numpy as np
    from PIL import Image
    from scipy import ndimage as ndi
    import cairosvg as cairo

    source = paths['reference'].read_bytes()
    original_svg = paths['svg'].read_bytes()
    palette_bytes = paths['palette'].read_bytes()
    with Image.open(io.BytesIO(source)) as loaded:
        image_format = loaded.format
        rgba = loaded.convert('RGBA')
    size = rgba.size
    for rule in palette['rules']:
        if 'bounds' in rule and (rule['bounds'][2] > size[0] or rule['bounds'][3] > size[1]):
            raise ValueError('Palette rule bounds exceed reference image')
    original = Image.alpha_composite(Image.new('RGBA', size, 'white'), rgba).convert('RGB')
    if p['referenceMode'] == 'labels':
        if image_format != 'PNG' or np.any(np.asarray(rgba)[..., 3] != 255):
            raise ValueError('labels reference must be an opaque exact-palette PNG')
        reference = rgba.convert('RGB')
    else:
        reference = trace.segment_image(original, palette, np, Image, 0)
    fills = [palette['background']] + [c['color'] for c in palette['colors']]
    if len(fills) > 65536:
        raise ValueError('At most 65535 foreground labels are supported by diagnostic label PNGs')
    colors = np.array([list(bytes.fromhex(c[1:])) for c in fills], dtype=np.uint8)
    pixels = np.asarray(reference)
    labels = np.full(pixels.shape[:2], -1, dtype=np.int32)
    for i, rgb in enumerate(colors):
        labels[np.all(pixels == rgb, axis=2)] = i
    if np.any(labels < 0):
        raise ValueError('Reference contains undeclared palette colors')
    if not np.any(labels):
        raise ValueError('Reference has no foreground')
    parsed = parse_svg(original_svg, size, fills)
    scale = p['scale']
    ref = labels.repeat(scale, axis=0).repeat(scale, axis=1)
    masks = render_masks(parsed, size, scale, len(fills), np, Image, cairo)
    coverage = masks.sum(axis=0)
    before = masks.argmax(axis=0).astype(np.int32)
    after = before.copy()
    fg = ref > 0
    gap = fg & (coverage == 0)
    overlap = coverage > 1
    outside = ~fg & (coverage > 0)
    # Zero padding includes the image edge in the protected silhouette margin.
    depth = ndi.distance_transform_edt(np.pad(fg, 1))[1:-1, 1:-1] / scale
    margin = depth <= p['maxGapWidthPx']
    outside_depth = ndi.distance_transform_edt(~fg) / scale if outside.any() else None
    unresolved = np.zeros_like(fg)
    protected = np.zeros_like(fg)
    changed = np.zeros_like(fg)
    records = []
    used = 0.
    distances = [None] + [ndi.distance_transform_edt(~m) / scale if m.any()
                          else None for m in masks[1:]]
    for kind, defect, limit in [('gap', gap, p['maxGapWidthPx']),
                                ('overlap', overlap, p['maxOverlapWidthPx']),
                                ('silhouetteExcess', outside, p['maxGapWidthPx'])]:
        components, number = ndi.label(defect, structure=np.ones((3, 3)))
        for index, bounds in enumerate(ndi.find_objects(components, max_label=number), 1):
            if bounds is None:
                continue
            # Only the gap neighbor test needs a halo. EDT needs one zero cell,
            # added below, regardless of where the component touches the image.
            radius = min(max(fg.shape), max(1, math.ceil(limit*scale))) if kind == 'gap' else 0
            window = tuple(slice(max(0, b.start-radius), min(n, b.stop+radius))
                           for b, n in zip(bounds, fg.shape))
            component = components[window] == index
            local_ref = ref[window]
            area = float(component.sum()) / scale**2
            width = float(2 * ndi.distance_transform_edt(np.pad(component, 1)).max()) / scale
            reason = None
            silhouette = kind == 'silhouetteExcess' or (kind == 'gap' and np.any(component & margin[window]))
            keep_protected = silhouette and width <= limit
            if kind == 'silhouetteExcess' and np.any(outside_depth[window][component] > limit):
                keep_protected = False
                reason = 'silhouette_distance_limit'
            if width > limit:
                reason = 'width_limit'
            elif keep_protected:
                reason = 'preexisting_silhouette_deviation'
            elif reason is None and not np.all(fg[window][component]):
                reason = 'protected_reference_background'
            if reason is None:
                for label in np.unique(local_ref[component]):
                    owned = component & (local_ref == label)
                    supported = (masks[label][window][owned] if kind == 'overlap' else
                                 distances[label][window][owned] <= limit if distances[label] is not None else False)
                    if not np.all(supported):
                        reason = 'ambiguous_reference_ownership'
                        break
                if kind == 'gap' and reason is None:
                    ring = ndi.binary_dilation(component, iterations=radius) & ~component
                    neighbors = [i for i in range(1, len(fills)) if np.any(masks[i][window] & ring)]
                    if len(neighbors) < 2:
                        reason = 'not_an_internal_multicolor_gap'
            if reason is None and used + area > p['maxChangedAreaPx']:
                reason = 'global_area_budget'
            if reason is None:
                used += area
                if p['mode'] == 'repair':
                    after[window][component] = local_ref[component]
                    changed[window][component] = True
            elif keep_protected:
                protected[window] |= component
            else:
                unresolved[window] |= component
            records.append(dict(kind=kind, component=index, areaPx=area, maxWidthPx=width,
                                bboxPx=[bounds[1].start/scale, bounds[0].start/scale,
                                        bounds[1].stop/scale, bounds[0].stop/scale],
                                status='protected_unchanged' if keep_protected else
                                       ('unresolved' if reason else ('repaired' if p['mode'] == 'repair' else 'repairable')),
                                reason=reason))

    # Check enclosed reference-background regions independently of thin contour
    # bands: even a one-cell bridge can split a large intentional hole.
    hole_failures = []
    background, count = ndi.label(~fg)
    exterior = set(np.unique(np.concatenate((background[0], background[-1], background[:, 0], background[:, -1]))))
    proposed_background, _ = ndi.label(after == 0)
    proposed_exterior = set(np.unique(np.concatenate((proposed_background[0], proposed_background[-1],
                                                      proposed_background[:, 0], proposed_background[:, -1]))))
    matched_holes = {}
    significant_holes = 0
    for index, bounds in enumerate(ndi.find_objects(background, max_label=count), 1):
        if bounds is None or index in exterior:
            continue
        hole = background[bounds] == index
        width = float(2 * ndi.distance_transform_edt(np.pad(hole, 1)).max()) / scale
        if width <= p['maxGapWidthPx']:
            continue
        significant_holes += 1
        remaining = set(int(v) for v in np.unique(proposed_background[bounds][hole]) if v)
        reason = None
        if not remaining:
            reason = 'reference_hole_closed'
        elif remaining & proposed_exterior:
            reason = 'reference_hole_opened_to_exterior'
        elif len(remaining) != 1:
            reason = 'reference_hole_split'
        elif next(iter(remaining)) in matched_holes:
            reason = 'reference_holes_merged'
        if reason:
            hole_failures.append(dict(referenceHole=index, reason=reason, maxWidthPx=width,
                                      areaPx=float(hole.sum())/scale**2,
                                      bboxPx=[bounds[1].start/scale, bounds[0].start/scale,
                                              bounds[1].stop/scale, bounds[0].stop/scale]))
        elif remaining:
            matched_holes[next(iter(remaining))] = index

    out = paths['out']
    out.mkdir(exist_ok=False)
    files = {}

    def save_bytes(name, data):
        with (out / name).open('xb') as stream:
            stream.write(data)
        files[name] = str(out / name)

    def save_image(name, image):
        buffer = io.BytesIO()
        image.save(buffer, format='PNG')
        save_bytes(name, buffer.getvalue())

    save_bytes('original.svg', original_svg)
    save_bytes('original_reference' + paths['reference'].suffix, source)
    save_bytes('palette.json', palette_bytes)
    save_image('reference.png', reference)
    for name, array in [('before', before), ('after', after)]:
        save_image(name + '.png', Image.fromarray(colors[array]))
        save_image(name + '_labels.png', Image.fromarray(array.astype(np.uint16)))
    for name, mask in [('gaps', gap), ('overlaps', overlap), ('unresolved', unresolved),
                       ('changed', changed), ('protected', protected), ('silhouette', outside | (gap & margin))]:
        save_image(name + '.png', Image.fromarray(mask.astype(np.uint8)*255))
    audit = colors[ref].copy()
    audit[gap] = [255, 0, 0]
    audit[overlap] = [255, 0, 255]
    audit[unresolved] = [255, 165, 0]
    save_image('audit.png', Image.fromarray(audit))
    after_coverage = coverage.copy()
    after_coverage[changed] = 1
    after_gap = fg & (after_coverage == 0)
    after_overlap = after_coverage > 1
    save_image('after_gaps.png', Image.fromarray(after_gap.astype(np.uint8)*255))
    save_image('after_overlaps.png', Image.fromarray(after_overlap.astype(np.uint8)*255))
    warnings = ['Pixel-scale heuristics, not manufacturing clearances or CAD validation.',
                'Before labels choose first palette color at overlaps; overlaps.png retains ambiguity.',
                'Component width is conservative twice maximum padded EDT / scale; 8-connected components.',
                'Thin pre-existing silhouette differences are protected unchanged, not internal repair failures.',
                'Wide differences and significant reference-hole closure, opening, splitting or merging block publication.',
                'Hole checks use 4-connected background; significant means padded EDT diameter > maxGapWidthPx.',
                'No mask edits outside reference foreground; fitted geometry is checked against the proposed partition, not source contours.']
    report = dict(status='inspected' if p['mode'] == 'inspect' else 'blocked', parameters=p,
                  out=str(out), svg=str(paths['svg']), reference=str(paths['reference']), palette=palette,
                  svgSha256=hashlib.sha256(original_svg).hexdigest(),
                  referenceSha256=hashlib.sha256(source).hexdigest(),
                  paletteSha256=hashlib.sha256(palette_bytes).hexdigest(),
                  imageSize=dict(width=size[0], height=size[1]), components=records,
                  gapAreaPx=float(gap.sum()/scale**2), overlapAreaPx=float(overlap.sum()/scale**2),
                  silhouetteExcessAreaPx=float(outside.sum()/scale**2),
                  protectedDifferenceAreaPx=float(protected.sum()/scale**2),
                  referenceHoleTopology=dict(significantHoleCount=significant_holes, failures=hole_failures),
                  unresolvedAreaPx=float(unresolved.sum()/scale**2), changedAreaPx=float(changed.sum()/scale**2),
                  afterGapAreaPx=float(after_gap.sum()/scale**2),
                  afterOverlapAreaPx=float(after_overlap.sum()/scale**2),
                  repairableAreaPx=used, geometryValidated=False, warnings=warnings, files=files,
                  coordinateContract=dict(helper='vectorize_shared(labels, scale, fit_error_px, corner_angle)',
                                          labels='HxW integers; 0 background, 1..N palette declaration order',
                                          helperOutput='paths of label and L/C segments in source pixel-edge coordinates',
                                          rings='Helper background discarded; separate rings grouped by (label, region), nonzero fill',
                                          sketches='XY, centered reference foreground bbox, Y up, explicit mm; optional mirrorX'))
    if p['mode'] == 'repair' and not unresolved.any() and not hole_failures:
        try:
            network = shared_vectorize(after.copy(), scale=scale, fit_error_px=p['fitErrorPx'], corner_angle=p['cornerAngle'])
            # The shared helper includes background and emits individual rings.
            # Combine only rings of one connected region, so holes remain holes.
            grouped = {}
            for index, path in enumerate(network['paths']):
                if path['label'] == 0:
                    continue
                key = (path['label'], path.get('region', index))
                grouped.setdefault(key, dict(label=path['label'], segments=[]))['segments'].extend(path['segments'])
            network = dict(network, paths=list(grouped.values()))
            repaired_paths, fit_validation = validate_network(network, after, size, scale, p['fitErrorPx'], fills, np, Image, cairo)
            data = svg_bytes(repaired_paths, size)
            # Finish rendering and serialization before publishing any geometry.
            pending = {'repaired.svg': data, 'preview.png': cairo.svg2png(bytestring=data)}
            overlay = ET.fromstring(data)
            buffer = io.BytesIO()
            original.save(buffer, format='PNG')
            overlay.insert(0, ET.Element('{' + trace.SVG + '}image', width=str(size[0]), height=str(size[1]),
                                        href='data:image/png;base64,' + base64.b64encode(buffer.getvalue()).decode('ascii')))
            for node in list(overlay)[1:]:
                node.set('fill', 'none')
                node.set('stroke', '#00FFFF')
                node.set('stroke-width', '.5')
            overlay_data = ET.tostring(overlay)
            pending['overlay.svg'] = overlay_data
            pending['overlay.png'] = cairo.svg2png(bytestring=overlay_data)
            ys, xs = np.nonzero(labels)
            bbox = [int(xs.min()), int(ys.min()), int(xs.max()+1), int(ys.max()+1)]
            run_id = 'boundaries_' + hashlib.sha256(str(out).encode()).hexdigest()[:16]
            operations = []
            for i, path in enumerate(network['paths']):
                name = run_id + f'_{i:04d}'
                geometry = trace.geometry_for(path['segments'], bbox, p['widthMm'], p['mirrorX'])
                filename = f'sketches/{i:04d}.json'
                pending[filename] = json.dumps(dict(sketch=name, geometry=geometry), allow_nan=False).encode('utf-8')
                step = f'sketch_{i:04d}'
                operations.extend([dict(id=step, operation='sketch.create', data=dict(name=name, plane='XY')),
                                   dict(id=f'geometry_{i:04d}', operation='sketch.geometry',
                                        data=dict(sketch={'$ref': step+'.result.sketch'}, geometry=geometry))])
            pending['import_sketches.json'] = json.dumps(dict(runId=run_id, operations=operations), allow_nan=False).encode('utf-8')
            json.dumps(network.get('diagnostics', {}), allow_nan=False)
        except Exception as exc:
            warnings.append('Geometry publication blocked: ' + type(exc).__name__ + ': ' + str(exc))
        else:
            (out / 'sketches').mkdir()
            for name, data in pending.items():
                save_bytes(name, data)
            report.update(status='ready', sharedDiagnostics=network.get('diagnostics', {}),
                          sampledMaskValidated=True, fitValidation=fit_validation, foregroundBbox=bbox,
                          scaleMmPerPixel=p['widthMm']/(bbox[2]-bbox[0]))
    files['report.json'] = str(out / 'report.json')
    trace.write_json(out / 'report.json', report)
    return dict(success=True, operation='image.boundaries', result=report)


def validate_network(network, labels, size, scale, tolerance, fills, np, Image, cairo):
    """Gate publication on closed curves, sampled fit and exact working-grid coverage."""
    from shapely.geometry import MultiLineString
    from shapely import hausdorff_distance
    if not isinstance(network, dict) or not isinstance(network.get('paths'), list) or not network['paths']:
        raise ValueError('Shared helper returned no paths')
    paths, samples = [], {}
    for path in network['paths']:
        label = path['label']
        if type(label) is not int or not 0 < label < len(fills):
            raise ValueError('Invalid shared path label')
        commands, previous, start = [], None, None
        for kind, raw in path['segments']:
            points = np.asarray(raw, dtype=float)
            if kind not in ('L', 'C') or points.shape != ((2 if kind == 'L' else 4), 2) or not np.isfinite(points).all():
                raise ValueError('Invalid shared L/C segment')
            first, last = tuple(points[0]), tuple(points[-1])
            if previous is None or first != previous:
                if previous is not None and previous != start:
                    raise ValueError('Open shared contour')
                start = first
                commands.append(f'M {first[0]:.17g} {first[1]:.17g}')
            commands.append(kind + ' ' + ' '.join(f'{v:.17g}' for v in points[1:].ravel()))
            previous = last
            if previous == start:
                commands.append('Z')
                previous = None
            length = float(np.linalg.norm(np.diff(points, axis=0), axis=1).sum())
            if length > 100*(size[0]+size[1]):
                raise ValueError('Unbounded shared curve')
            # Cubic speed is bounded by three times the control polygon length.
            speed_bound = length * (3 if kind == 'C' else 1)
            t = np.linspace(0, 1, max(2, math.ceil(speed_bound*scale*10)+1))[:, None]
            sampled = ((1-t)*points[0]+t*points[1] if kind == 'L' else
                       (1-t)**3*points[0]+3*(1-t)**2*t*points[1]+3*(1-t)*t**2*points[2]+t**3*points[3])
            samples.setdefault(label, []).append(sampled)
        if previous is not None or not commands:
            raise ValueError('Open or empty shared contour')
        paths.append((label, dict(d=' '.join(commands), fill=fills[label], **{'fill-rule': 'nonzero'})))
    if set(samples) != set(int(v) for v in np.unique(labels) if v):
        raise ValueError('Shared helper lost or invented colors')
    deviations = {}
    for label, curves in samples.items():
        mask = labels == label
        padded = np.pad(mask, 1)
        horizontal = padded[1:, 1:-1] != padded[:-1, 1:-1]
        vertical = padded[1:-1, 1:] != padded[1:-1, :-1]
        edges = []
        for y, x in zip(*np.nonzero(horizontal)):
            edges.append([(x/scale, y/scale), ((x+1)/scale, y/scale)])
        for y, x in zip(*np.nonzero(vertical)):
            edges.append([(x/scale, y/scale), (x/scale, (y+1)/scale)])
        distance = float(hausdorff_distance(MultiLineString(edges), MultiLineString(curves), densify=.25))
        deviations[fills[label]] = distance
        if distance > tolerance + 1e-8:
            raise ValueError(f'Sampled fit exceeds fitErrorPx: {distance:g}')
    masks = render_masks(paths, size, scale, len(fills), np, Image, cairo)
    if np.any(masks.sum(axis=0) > 1) or not np.array_equal(masks.argmax(axis=0), labels):
        raise ValueError('Shared fit changed working-grid ownership, holes, gaps or overlaps')
    return paths, dict(sampledHausdorffPxByColor=deviations, tolerancePx=tolerance,
                       baseline='proposed label partition including protected pre-existing silhouette offsets',
                       curveSampleSpacingBoundPx=.1/scale, gridEdgeDensify=.25,
                       exactWorkingGridOwnership=True,
                       limitation='Sampled raster/curve checks, not analytic geometry or CAD validation')


def main():
    try:
        raw = sys.stdin.read(32 * 1024 * 1024 + 1)
        if len(raw) > 32 * 1024 * 1024:
            raise ValueError('Worker JSON input exceeds limit')
        result = execute(json.loads(raw))
        report = result['result']
        summary = {key: report[key] for key in (
            'status', 'out', 'gapAreaPx', 'overlapAreaPx', 'protectedDifferenceAreaPx',
            'unresolvedAreaPx', 'changedAreaPx', 'repairableAreaPx', 'afterGapAreaPx',
            'afterOverlapAreaPx', 'referenceHoleTopology', 'sampledMaskValidated',
            'geometryValidated', 'files', 'warnings') if key in report}
        reasons = {}
        for component in report.get('components', []):
            if component['status'] == 'unresolved':
                reason = component.get('reason') or 'unspecified'
                reasons[reason] = reasons.get(reason, 0) + 1
        summary['unresolvedReasonCounts'] = reasons
        print(json.dumps(dict(result, result=summary), separators=(',', ':'), allow_nan=False))
    except Exception as exc:
        print(f'image.boundaries: {type(exc).__name__}: {exc}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())

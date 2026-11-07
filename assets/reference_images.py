"""GM05 offline raster evidence. Never imports adsk or modifies input files."""
import hashlib
import io
import json
import math
from pathlib import Path
import re
import sys

if __name__ == '__main__' and not __package__:
    sys.path.pop(0)  # The sibling inspect.py is not stdlib inspect.

import numpy as np
from PIL import Image
from scipy.ndimage import binary_erosion, distance_transform_edt


def fields(value, required, optional=()):
    if not isinstance(value, dict) or set(required) - value.keys() or value.keys() - set(required) - set(optional):
        raise ValueError('Invalid fields; required: %s; optional: %s' % (', '.join(required), ', '.join(optional)))


def number(value, minimum=None):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or (minimum is not None and value < minimum):
        raise ValueError('Expected finite number%s' % ('' if minimum is None else ' >= %s' % minimum))
    return float(value)


def quantity(value, angle=False):
    match = re.fullmatch(r'\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*(mm|cm|m|in|ft|deg|rad)\s*', value) if isinstance(value, str) else None
    factors = {'deg': math.pi / 180, 'rad': 1} if angle else {'mm': 1, 'cm': 10, 'm': 1000, 'in': 25.4, 'ft': 304.8}
    if not match or match[2] not in factors:
        raise ValueError('Expected explicit %s expression; local arithmetic/parameters are not supported' % ('angle' if angle else 'length'))
    return number(float(match[1]) * factors[match[2]])


def point(value, count=2, lengths=False):
    if not isinstance(value, list) or len(value) != count:
        raise ValueError('Expected %s coordinates' % count)
    return np.array([quantity(v) if lengths else number(v) for v in value])


def text(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError('Expected nonempty string')
    return value


def rows(value):
    if not isinstance(value, list) or not value:
        raise ValueError('Expected nonempty array')
    return value


def source(value, image=False):
    fields(value, ['path', 'status'] + (['uncertaintyPx'] if image else []), ['sha256', 'revision', 'derivedFrom'])
    text(value['path'])
    if value['status'] not in ('CONFIRMED', 'ESTIMATED', 'OPEN', 'DERIVED'):
        raise ValueError('Invalid source status')
    if value['status'] == 'DERIVED':
        for parent in rows(value.get('derivedFrom')):
            text(parent)
    elif 'derivedFrom' in value:
        raise ValueError('derivedFrom requires DERIVED status')
    if image:
        number(value['uncertaintyPx'], 0)
    if 'sha256' in value and not re.fullmatch('[0-9a-f]{64}', text(value['sha256'])):
        raise ValueError('Invalid sha256')
    if 'revision' in value:
        text(value['revision'])
    return dict(value)


def camera(value):
    fields(value, ['projection', 'orientation', 'frame'], ['eye', 'target', 'up', 'extents', 'perspectiveAngle'])
    if value['projection'] not in ('perspective', 'orthographic', 'unknown'):
        raise ValueError('Invalid camera projection')
    orientation(value['orientation'])
    text(value['frame'])
    if any(k in value for k in ('eye', 'target', 'up')):
        if not all(k in value for k in ('eye', 'target', 'up')):
            raise ValueError('Camera pose requires eye, target and up')
        direction = point(value['target'], 3, True) - point(value['eye'], 3, True)
        up = point(value['up'], 3)
        if np.linalg.norm(direction) < 1e-12 or np.linalg.norm(np.cross(direction, up)) < 1e-12:
            raise ValueError('Degenerate camera pose')
    if 'extents' in value:
        if value['projection'] != 'orthographic' or np.any(point(value['extents'], lengths=True) <= 0):
            raise ValueError('Positive extents require orthographic projection')
    if 'perspectiveAngle' in value:
        if value['projection'] != 'perspective' or not 0 < quantity(value['perspectiveAngle'], True) < math.pi:
            raise ValueError('Perspective angle must be between 0 and 180 deg')
    return value


def orientation(value):
    if value not in ('front', 'side', 'rear', 'top', 'bottom', 'left', 'right', 'custom'):
        raise ValueError('Invalid view orientation')


def frame(value):
    fields(value, ['name', 'origin', 'xAxis', 'yAxis'])
    text(value['name'])
    origin = point(value['origin'], 3, True)
    x, y = point(value['xAxis'], 3), point(value['yAxis'], 3)
    if not np.allclose([np.linalg.norm(x), np.linalg.norm(y), np.dot(x, y)], [1, 1, 0], atol=1e-9, rtol=0):
        raise ValueError('Frame axes must be orthonormal; scale/shear not allowed')
    return {**value, 'originMm': origin.tolist(), 'zAxis': np.cross(x, y).tolist()}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def raster(filename):
    path = Path(text(filename)).resolve(strict=True)
    data = path.read_bytes()
    with Image.open(io.BytesIO(data)) as image:
        if image.width * image.height > 16_000_000 or getattr(image, 'n_frames', 1) != 1:
            raise ValueError('Single-frame raster limited to 16 megapixels')
        image.load()
        # Raw stored raster coordinates, deliberately no implicit EXIF transpose.
        result = image.convert('RGBA')
    return result, {'path': str(path), 'sha256': digest(data), 'size': list(result.size)}, data


def mapped(matrix, p):
    return (matrix @ np.array([*p, 1]))[:2]


def crop_transform(view, size):
    crop = view['crop']
    if not isinstance(crop, list) or len(crop) != 4 or any(type(v) is not int for v in crop):
        raise ValueError('crop must be integer [x,y,width,height]')
    x, y, w, h = crop
    if x < 0 or y < 0 or w <= 0 or h <= 0 or x + w > size[0] or y + h > size[1]:
        raise ValueError('Crop outside original raster')
    angle = quantity(view['rotation'], True)
    mirror = view.get('mirrorX', False)
    if type(mirror) is not bool:
        raise ValueError('mirrorX must be boolean')
    # Pixel centers are integer coordinates. Positive rotation is clockwise in y-down raster space.
    c, s = math.cos(angle), math.sin(angle)
    rotate = np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])
    local = np.array([[-1 if mirror else 1, 0, w - 1 if mirror else 0], [0, 1, 0], [0, 0, 1]])
    rotate = rotate @ local
    corners = np.array([mapped(rotate, p) for p in [[-.5, -.5], [w - .5, -.5], [-.5, h - .5], [w - .5, h - .5]]])
    lo, hi = corners.min(axis=0), corners.max(axis=0)
    output = tuple(int(math.ceil(v - 1e-9)) for v in hi - lo)
    shift = np.eye(3)
    shift[:2, 2] = -lo - .5
    local = shift @ rotate
    offset = np.array([[1, 0, -x], [0, 1, -y], [0, 0, 1]])
    return local @ offset, local, output


def warp(image, matrix, size, mask=False):
    # Pillow's affine coefficients use pixel-edge coordinates, hence center conjugation.
    inv = np.linalg.inv(matrix)
    inv[:2, 2] += .5 - inv[:2, :2] @ np.array([.5, .5])
    return image.transform(size, Image.Transform.AFFINE, tuple(inv[:2].flat),
                           resample=Image.Resampling.NEAREST if mask else Image.Resampling.BICUBIC)


def output_dir(value):
    path = Path(text(value)).absolute()
    if path.exists() or path.is_symlink() or not path.parent.is_dir():
        raise ValueError('out must be NEW with existing parent')
    return path


def envelope(operation, result, status, warnings, provenance, reference_frame, created):
    return {'schemaVersion': 1, 'success': status not in ('fail', 'blocked'), 'status': status,
            'operation': operation, 'documentIdentity': None, 'result': result, 'created': created,
            'affected': [], 'units': {'length': 'mm', 'image': 'px', 'angle': 'rad'}, 'frame': reference_frame,
            'associativity': 'snapshot', 'warnings': warnings, 'provenance': provenance,
            'method': 'Source-preserving raster similarities and sampled image comparison',
            'limitations': ['No live Fusion validation or native canvas creation.',
                            'Image-space evidence is not orthographic reconstruction or physical geometry acceptance.',
                            'No automatic lens correction, feature matching, per-detail fit or model scaling.'],
            'nativeAcceptance': 'notEvaluated'}


def publish(out, report, images=(), original=None):
    out.mkdir()  # Exclusive claim; nothing is overwritten, including on concurrent calls.
    if original is not None:
        with (out / 'original.bin').open('xb') as stream:
            stream.write(original)
    for name, image in images:
        with (out / name).open('xb') as stream:
            image.save(stream, format='PNG')
    report['reportPath'] = str(out / 'report.json')
    with (out / 'report.json').open('x') as stream:
        json.dump(report, stream, indent=2, allow_nan=False)
    return report


def layout(data):
    fields(data, ['schemaVersion', 'original', 'frame', 'views', 'out'], ['conflicts'])
    out = output_dir(data['out'])
    origin = source(data['original'], True)
    image, identity, original_bytes = raster(origin['path'])
    if 'sha256' in origin and origin['sha256'] != identity['sha256']:
        raise ValueError('Original sha256 mismatch')
    origin.update(identity)
    reference_frame = frame(data['frame'])
    images, views, ids, warnings = [], [], set(), []
    for view in rows(data['views']):
        fields(view, ['id', 'orientation', 'crop', 'rotation', 'camera'], ['mirrorX'])
        name = text(view['id'])
        if not re.fullmatch('[A-Za-z][A-Za-z0-9_-]{0,63}', name) or name in ids:
            raise ValueError('View IDs must be unique safe identifiers')
        ids.add(name)
        orientation(view['orientation'])
        cam = camera(view['camera'])
        if cam['frame'] != reference_frame['name'] or cam['orientation'] != view['orientation']:
            raise ValueError('Camera frame/orientation conflicts with view')
        if cam['projection'] != 'orthographic':
            warnings.append('%s: %s projection; scale is illustrative, not metric reconstruction' % (name, cam['projection']))
        matrix, local, size = crop_transform(view, image.size)
        x, y, w, h = view['crop']
        cropped = warp(image.crop((x, y, x + w, y + h)), local, size)
        filename = name + '.png'
        buffer = io.BytesIO()
        cropped.save(buffer, format='PNG')
        images.append((filename, cropped))
        views.append({**view, 'path': str(out / filename), 'sha256': digest(buffer.getvalue()), 'size': list(size),
                      'originalToView': matrix.tolist(), 'viewToOriginal': np.linalg.inv(matrix).tolist()})
    conflicts = data.get('conflicts', [])
    if not isinstance(conflicts, list):
        raise ValueError('conflicts must be an array')
    for conflict in conflicts:
        fields(conflict, ['views', 'reason', 'source'])
        if any(v not in ids for v in rows(conflict['views'])):
            raise ValueError('Conflict references unknown view')
        text(conflict['reason'])
        source(conflict['source'])
    result = {'original': origin, 'originalCopy': {'path': str(out / 'original.bin'), 'sha256': origin['sha256']},
              'views': views, 'conflicts': conflicts,
              'canvases': {'status': 'notEvaluated', 'representation': 'native-handoff',
                           'instructions': 'Insert each oriented PNG using Insert > Canvas. Use reference image inspect, measure current canvas-plane segment coordinates, then reference image calibrate. Do not send image pixels as plane lengths.'}}
    report = envelope('reference.layout', result, 'unknown' if conflicts or warnings or origin['status'] != 'CONFIRMED' else 'notEvaluated', warnings, [origin], reference_frame, [str(out / n) for n, _ in images] + [str(out / 'original.bin')])
    return publish(out, report, images, original_bytes)


def read_report(filename, operation):
    path = Path(text(filename)).resolve(strict=True)
    raw = path.read_bytes()
    report = json.loads(raw)
    if report.get('schemaVersion') != 1 or report.get('operation') != operation:
        raise ValueError('Wrong reference report kind/version')
    return report, {'path': str(path), 'sha256': digest(raw)}


def verified_layout(filename):
    report, identity = read_report(filename, 'reference.layout')
    for record in [report['result']['original'], report['result']['originalCopy'], *report['result']['views']]:
        if digest(Path(record['path']).read_bytes()) != record['sha256']:
            raise ValueError('Stale source/crop: sha256 mismatch for ' + record['path'])
    return report, identity


def dimension(value):
    fields(value, ['id', 'value', 'uncertainty', 'source'])
    text(value['id'])
    source(value['source'])
    length, uncertainty = quantity(value['value']), quantity(value['uncertainty'])
    if length <= 0 or uncertainty < 0:
        raise ValueError('Dimension must be positive with nonnegative uncertainty')
    return length, uncertainty


def segment(value, view):
    if not isinstance(value, list) or len(value) != 2:
        raise ValueError('segment requires two original-raster points')
    points = [point(p) for p in value]
    x, y, w, h = view['crop']
    for p in points:
        if not (x <= p[0] <= x + w - 1 and y <= p[1] <= y + h - 1):
            raise ValueError('Control point outside view crop')
    transformed = [mapped(np.array(view['originalToView']), p) for p in points]
    if np.linalg.norm(transformed[1] - transformed[0]) <= 1e-12:
        raise ValueError('Zero calibration segment')
    return transformed


def residual(identifier, view_id, measured, expected, tolerance, uncertainty):
    deviation = measured - expected
    return {'id': identifier, 'view': view_id, 'measuredMm': measured, 'expectedMm': expected,
            'deviationMm': deviation, 'uncertaintyMm': uncertainty, 'toleranceMm': tolerance,
            'status': 'fail' if abs(deviation) > tolerance + uncertainty else 'pass'}


def calibrate(data):
    fields(data, ['schemaVersion', 'layout', 'dimension', 'controls', 'tolerance', 'out'], ['checks'])
    out = output_dir(data['out'])
    report, layout_identity = verified_layout(data['layout'])
    views = {v['id']: v for v in report['result']['views']}
    known, uncertainty = dimension(data['dimension'])
    tolerance = quantity(data['tolerance'])
    if tolerance < 0:
        raise ValueError('tolerance must be nonnegative')
    prepared, ids = [], set()
    for control in rows(data['controls']):
        fields(control, ['view', 'segment', 'anchor', 'angle'])
        name = control['view']
        if name not in views or name in ids:
            raise ValueError('One control segment per known view is required')
        ids.add(name)
        p, q = segment(control['segment'], views[name])
        prepared.append((control, p, q, point(control['anchor'], lengths=True), quantity(control['angle'], True)))
    lengths = [float(np.linalg.norm(q - p)) for _, p, q, _, _ in prepared]
    # One scalar across every view; no individual-detail or per-view scale fitting.
    scale = known * sum(lengths) / sum(d * d for d in lengths)
    pixel_uncertainty = report['result']['original']['uncertaintyPx']
    total_uncertainty = uncertainty + 2 * pixel_uncertainty * scale
    calibrations, checks = [], []
    for (control, p, q, anchor, angle), length in zip(prepared, lengths):
        name = control['view']
        theta = angle - math.atan2((q - p)[1], (q - p)[0])
        c, s = scale * math.cos(theta), scale * math.sin(theta)
        matrix = np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])
        matrix[:2, 2] = anchor - mapped(matrix, p)
        check = residual(data['dimension']['id'], name, length * scale, known, tolerance, total_uncertainty)
        checks.append(check)
        calibrations.append({'view': name, 'viewToPlaneMm': matrix.tolist(),
                             'originalToPlaneMm': (matrix @ views[name]['originalToView']).tolist(),
                             'control': control, 'camera': views[name]['camera'], 'check': check})
    extras = data.get('checks', [])
    if not isinstance(extras, list):
        raise ValueError('checks must be an array')
    check_ids = set()
    for check in extras:
        fields(check, ['id', 'view', 'segment', 'dimension'])
        key = (text(check['id']), check['view'])
        if key in check_ids or check['view'] not in ids:
            raise ValueError('Duplicate check or uncalibrated view')
        check_ids.add(key)
        expected, error = dimension(check['dimension'])
        p, q = segment(check['segment'], views[check['view']])
        row = residual(check['id'], check['view'], float(np.linalg.norm(q - p)) * scale,
                       expected, tolerance, error + 2 * pixel_uncertainty * scale)
        row['dimension'] = check['dimension']
        checks.append(row)
    # Equal IDs identify the same cross-view dimension. Report disagreement independently of targets.
    conflicts = list(report['result']['conflicts'])
    for i, a in enumerate(checks):
        for b in checks[i + 1:]:
            if a['id'] == b['id'] and a['view'] != b['view'] and abs(a['measuredMm'] - b['measuredMm']) > 2 * tolerance + a['uncertaintyMm'] + b['uncertaintyMm']:
                conflicts.append({'id': a['id'], 'views': [a['view'], b['view']], 'reason': 'Cross-view dimension residual exceeds combined uncertainty', 'deviationMm': abs(a['measuredMm'] - b['measuredMm'])})
    sources = [report['result']['original'], data['dimension']['source'], *[c['dimension']['source'] for c in extras]]
    unresolved = any(s['status'] != 'CONFIRMED' for s in sources) or any(v['camera']['projection'] != 'orthographic' for v in views.values())
    status = 'blocked' if any(s['status'] == 'OPEN' for s in sources) else 'fail' if conflicts or any(c['status'] == 'fail' for c in checks) else 'unknown' if unresolved else 'pass'
    warnings = list(report['warnings'])
    if unresolved:
        warnings.append('Estimated/derived/open sources and perspective/unknown views cannot establish confirmed dimensions.')
    result = {'layout': layout_identity, 'dimension': data['dimension'], 'scaleMmPerPixel': scale,
              'scaleUncertaintyMmPerPixel': total_uncertainty / min(lengths),
              'calibrations': calibrations, 'checks': checks, 'conflicts': conflicts,
              'metricVerified': False, 'sourceStatus': 'DERIVED', 'sourceStatuses': [s['status'] for s in sources],
              'nativeHandoff': {'status': 'notEvaluated', 'operation': 'reference.image', 'mode': 'calibrate',
                                'instruction': 'Use the SAME dimension and measured current-plane endpoints for every inserted canvas; pixel endpoints must first be mapped/verified by the live operator. Matrix values are reference-plane mm, not Canvas.transform cells.'}}
    return publish(out, envelope('reference.calibrate', result, status, warnings, [layout_identity, *sources], report['frame'], []))


def binary_mask(filename, size):
    image, identity, _ = raster(filename)
    array = np.asarray(image)
    if image.size != tuple(size) or not np.all(array[:, :, 3] == 255) or not np.all(array[:, :, :3] == array[:, :, :1]) or not np.all(np.isin(array[:, :, 0], [0, 255])):
        raise ValueError('Mask must be opaque binary 0/255 with the required raster size')
    return Image.fromarray(array[:, :, 0]), identity


def registration(value):
    if not isinstance(value, list) or len(value) != 3:
        raise ValueError('renderToView must be a 3x3 similarity')
    matrix = np.array([point(row, 3) for row in value])
    a = matrix[:2, :2]
    gram = a.T @ a
    if not np.allclose(matrix[2], [0, 0, 1], atol=1e-12, rtol=0) or np.linalg.det(a) <= 0 or not np.allclose(gram, np.eye(2) * gram[0, 0], atol=1e-9, rtol=1e-9):
        raise ValueError('renderToView permits only explicit positive uniform scale, rotation and translation')
    return matrix


def silhouette(a, b, roi):
    # Keep full boundaries, then restrict samples to ROI: no artificial ROI clipping edges.
    edge_a = (a & ~binary_erosion(a)) & roi
    edge_b = (b & ~binary_erosion(b)) & roi
    if not edge_a.any() or not edge_b.any():
        return {'status': 'unknown', 'reason': 'Empty silhouette boundary in evaluation region', 'rmsPx': None, 'maxPx': None, 'iou': None}
    distances = np.concatenate([distance_transform_edt(~edge_b)[edge_a], distance_transform_edt(~edge_a)[edge_b]])
    union = ((a | b) & roi).sum()
    return {'status': 'notEvaluated', 'sampleCount': int(len(distances)), 'meanPx': float(distances.mean()),
            'rmsPx': float(np.sqrt(np.mean(distances ** 2))), 'maxPx': float(distances.max()),
            'iou': float(((a & b) & roi).sum() / union)}


def compare(data):
    fields(data, ['schemaVersion', 'calibration', 'comparisons', 'out'])
    out = output_dir(data['out'])
    calibration, calibration_identity = read_report(data['calibration'], 'reference.calibrate')
    layout_report, layout_identity = verified_layout(calibration['result']['layout']['path'])
    if layout_identity != calibration['result']['layout']:
        raise ValueError('Stale calibration: layout report hash changed')
    views = {v['id']: v for v in layout_report['result']['views']}
    calibrated = {c['view']: c for c in calibration['result']['calibrations']}
    results, images, provenance, ids = [], [], [calibration_identity], set()
    for item in rows(data['comparisons']):
        fields(item, ['view', 'render', 'camera', 'tolerancePx'], ['renderToView', 'landmarks', 'referenceMask', 'renderMask', 'roiMask'])
        name = item['view']
        if name not in calibrated or name in ids:
            raise ValueError('Comparison requires unique calibrated view')
        ids.add(name)
        view = views[name]
        tolerance = number(item['tolerancePx'], 0)
        cam = camera(item['camera'])
        matching_camera = cam == view['camera']
        render, render_source, _ = raster(item['render'])
        reference_image, _, _ = raster(view['path'])
        transform = registration(item.get('renderToView', np.eye(3).tolist()))
        if 'renderToView' not in item and render.size != reference_image.size:
            raise ValueError('Different raster sizes require explicit renderToView registration')
        aligned = warp(render, transform, reference_image.size)
        coverage = np.asarray(warp(Image.new('L', render.size, 255), transform, reference_image.size, True)) == 255
        roi = np.ones((reference_image.height, reference_image.width), dtype=bool)
        if 'roiMask' in item:
            mask, identity = binary_mask(item['roiMask'], reference_image.size)
            roi = np.asarray(mask) == 255
            provenance.append(identity)
        # Never silently exclude missing render coverage from a comparison.
        covered = bool(roi.any() and np.all(coverage[roi]))
        metrics = []
        landmark_ids = set()
        if 'landmarks' in item:
            for landmark in rows(item['landmarks']):
                fields(landmark, ['id', 'reference', 'render'])
                identifier = text(landmark['id'])
                if identifier in landmark_ids:
                    raise ValueError('Duplicate landmark ID')
                landmark_ids.add(identifier)
                reference_point = point(landmark['reference'])
                x, y, w, h = view['crop']
                if not (x <= reference_point[0] <= x + w - 1 and y <= reference_point[1] <= y + h - 1):
                    raise ValueError('Landmark outside original crop')
                render_point = point(landmark['render'])
                if not (0 <= render_point[0] <= render.width - 1 and 0 <= render_point[1] <= render.height - 1):
                    raise ValueError('Landmark outside render')
                a = mapped(np.array(view['originalToView']), reference_point)
                b = mapped(transform, render_point)
                deviation = float(np.linalg.norm(a - b))
                inside_roi = all(0 <= round(p[0]) < roi.shape[1] and 0 <= round(p[1]) < roi.shape[0] and roi[round(p[1]), round(p[0])] for p in [a, b])
                metrics.append({'id': identifier, 'kind': 'landmark', 'referenceViewPx': a.tolist(), 'renderViewPx': b.tolist(),
                                'deviationPx': deviation, 'status': ('pass' if deviation <= tolerance else 'fail') if inside_roi else 'unknown'})
        if ('referenceMask' in item) != ('renderMask' in item):
            raise ValueError('Silhouette comparison requires both referenceMask and renderMask')
        if 'referenceMask' in item:
            a, source_a = binary_mask(item['referenceMask'], layout_report['result']['original']['size'])
            b, source_b = binary_mask(item['renderMask'], render.size)
            provenance.extend([source_a, source_b])
            x, y, w, h = view['crop']
            _, local, size = crop_transform(view, a.size)
            a = np.asarray(warp(a.crop((x, y, x + w, y + h)), local, size, True)) == 255
            b = np.asarray(warp(b, transform, size, True)) == 255
            metric = silhouette(a, b, roi)
            if metric['maxPx'] is not None:
                metric['status'] = 'pass' if metric['maxPx'] <= tolerance else 'fail'
            metrics.append({'kind': 'silhouette', **metric})
            difference = np.zeros((*a.shape, 4), dtype=np.uint8)
            difference[a & roi] = [255, 0, 0, 255]
            difference[b & roi] = [0, 180, 255, 255]
            difference[a & b & roi] = [255, 255, 255, 255]
            images.append((name + '-silhouette.png', Image.fromarray(difference)))
        metric_frame_valid = matching_camera and cam['projection'] == 'orthographic' and all(k in cam for k in ('eye', 'target', 'up', 'extents')) and calibration['status'] == 'pass'
        for metric in metrics:
            deviation = metric.get('deviationPx', metric.get('maxPx'))
            metric['projectedDeviationMm'] = deviation * calibration['result']['scaleMmPerPixel'] if metric_frame_valid and deviation is not None else None
            metric['physicalStatus'] = 'notEvaluated' if metric_frame_valid else 'unknown'
        status = 'unknown' if not matching_camera or not covered or not metrics else 'fail' if any(m['status'] == 'fail' for m in metrics) else 'unknown' if any(m['status'] == 'unknown' for m in metrics) or not metric_frame_valid else 'pass'
        overlay = Image.blend(reference_image, aligned, .5)
        images.append((name + '-overlay.png', overlay))
        provenance.append(render_source)
        results.append({'view': name, 'status': status, 'cameraMatches': matching_camera, 'camera': cam,
                        'coverageComplete': covered, 'render': render_source, 'renderToView': transform.tolist(),
                        'tolerancePx': tolerance, 'metrics': metrics, 'overlay': str(out / (name + '-overlay.png'))})
    status = 'blocked' if calibration['status'] == 'blocked' else 'fail' if calibration['status'] == 'fail' or any(r['status'] == 'fail' for r in results) else 'unknown' if any(r['status'] == 'unknown' for r in results) else 'pass'
    return publish(out, envelope('reference.compare', {'comparisons': results, 'conflicts': calibration['result']['conflicts'], 'geometryVerified': False}, status,
                                calibration['warnings'] + ['Camera metadata is caller-declared. Comparisons never certify physical geometry.'], provenance,
                                layout_report['frame'], [str(out / name) for name, _ in images]), images)


def no_duplicates(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError('Duplicate JSON field: ' + key)
        value[key] = item
    return value


def main():
    raw = sys.stdin.read(32 * 1024 * 1024 + 1)
    if len(raw) > 32 * 1024 * 1024:
        raise ValueError('Worker JSON input exceeds limit')
    data = json.loads(raw, object_pairs_hook=no_duplicates)
    if not isinstance(data, dict) or type(data.get('schemaVersion')) is not int or data['schemaVersion'] != 1:
        raise ValueError('schemaVersion must be 1')
    operation = sys.argv[1]
    result = {'reference.layout': layout, 'reference.calibrate': calibrate, 'reference.compare': compare}[operation](data)
    print(json.dumps(result, allow_nan=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('%s: %s' % (type(error).__name__, error), file=sys.stderr)
        sys.exit(1)

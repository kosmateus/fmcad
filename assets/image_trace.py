"""Local raster tracing. No Fusion calls; output directories are immutable runs."""

import sys

# assets/inspect.py is a Fusion script, not the standard library inspect module.
if __name__ == '__main__' and not __package__:
    sys.path.pop(0)

import base64
import hashlib
import importlib
import importlib.util
import importlib.metadata
import io
import json
import math
from pathlib import Path
import re
import xml.etree.ElementTree as ET


DEFAULTS = dict(blurSigma=0, medianSize=0, labelModeSize=0, filterSpeckle=4,
                cornerThreshold=60, lengthThreshold=4, spliceThreshold=45,
                maxIterations=10, pathPrecision=4, colorPrecision=8,
                layerDifference=0, mode='spline', widthMm=50, mirrorX=False, traceScale=1,
                traceDetailAreaPx2=0)
# Bounds protect the native unsigned arguments and precision calculations.
RANGES = dict(blurSigma=(0, 100), filterSpeckle=(0, 65535),
              cornerThreshold=(0, 180), lengthThreshold=(0.01, 1000),
              spliceThreshold=(0, 180), maxIterations=(1, 1000),
              pathPrecision=(0, 15), colorPrecision=(1, 8),
              layerDifference=(0, 255), widthMm=(1e-9, 1e9), traceScale=(1, 2), traceDetailAreaPx2=(0, 1e9))
INTEGERS = {'filterSpeckle', 'maxIterations', 'pathPrecision',
            'colorPrecision', 'layerDifference', 'traceScale'}
NUMBER = r'[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?'
TOKEN = re.compile(NUMBER + r'|[A-Za-z]')
SVG = 'http://www.w3.org/2000/svg'


def dependencies():
    modules = {}
    for module, package in [('PIL.Image', 'Pillow'), ('PIL.ImageFilter', 'Pillow'),
                            ('numpy', 'numpy'), ('vtracer', 'vtracer'),
                            ('cairosvg', 'CairoSVG')]:
        try:
            modules[module] = importlib.import_module(module)
        except (ImportError, OSError) as exc:
            raise RuntimeError('Image tracing requires ' + package + '. Install with: '
                               'python -m pip install -r assets/image_trace_requirements.txt; '
                               'CairoSVG also requires the system Cairo library. ' + str(exc)) from exc
    return modules


def color(value):
    if not isinstance(value, str) or not re.fullmatch(r'#[0-9a-fA-F]{6}', value):
        raise ValueError('Colors must be #RRGGBB strings')
    return value.upper()


def numeric(value):
    return type(value) in (int, float) and math.isfinite(value)


def validate(request):
    if not isinstance(request, dict):
        raise ValueError('Request must be a JSON object')
    unknown = set(request) - set(DEFAULTS) - {'input', 'out', 'palette'}
    if unknown:
        raise ValueError('Unknown request fields: ' + ', '.join(sorted(unknown)))
    params = {key: request.get(key, default) for key, default in DEFAULTS.items()}
    for key, (low, high) in RANGES.items():
        value = params[key]
        if not numeric(value) or not low <= value <= high or (key in INTEGERS and type(value) is not int):
            raise ValueError(f'{key} must be {"an integer" if key in INTEGERS else "a number"} in [{low}, {high}]')
    if type(params['medianSize']) is not int or params['medianSize'] not in (0, 3, 5, 7):
        raise ValueError('medianSize must be 0, 3, 5, or 7')
    if type(params['labelModeSize']) is not int or params['labelModeSize'] not in (0, 3, 5, 7):
        raise ValueError('labelModeSize must be 0, 3, 5, or 7')
    if params['labelModeSize'] and 'palette' not in request:
        raise ValueError('Nonzero labelModeSize requires a palette')
    if params['mode'] not in ('spline', 'polygon'):
        raise ValueError('mode must be spline or polygon')
    if type(params['mirrorX']) is not bool:
        raise ValueError('mirrorX must be boolean')
    if params['traceDetailAreaPx2'] and ('palette' not in request or params['traceScale'] != 1 or params['mode'] != 'spline'):
        raise ValueError('traceDetailAreaPx2 requires a palette, traceScale=1 and mode=spline')
    paths = {}
    for key in ('input', 'out', 'palette'):
        if key == 'palette' and key not in request:
            continue
        value = request.get(key)
        if not isinstance(value, str) or not Path(value).is_absolute():
            raise ValueError(key + ' must be an absolute path')
        paths[key] = Path(value)
    if paths['out'].exists() or paths['out'].is_symlink():
        raise ValueError('out must be a NEW directory; refusing to overwrite: ' + str(paths['out']))
    if not paths['out'].parent.is_dir():
        raise ValueError('out parent directory must already exist')
    if not paths['input'].is_file():
        raise ValueError('input must be an existing image file')
    palette = None
    if 'palette' in paths:
        palette = json.loads(paths['palette'].read_text(encoding='utf-8'))
        if not isinstance(palette, dict) or set(palette) != {'background', 'colors', 'rules'}:
            raise ValueError('Palette requires only background, colors, rules')
        palette['background'] = color(palette['background'])
        if not isinstance(palette['colors'], list) or not isinstance(palette['rules'], list):
            raise ValueError('Palette colors and rules must be arrays')
        names, colors = set(), {palette['background']}
        for entry in palette['colors']:
            if not isinstance(entry, dict) or set(entry) != {'name', 'color'}:
                raise ValueError('Palette color requires only name and color')
            name = entry['name']
            if not isinstance(name, str) or not name.strip() or name in names:
                raise ValueError('Palette names must be nonempty and unique')
            entry['color'] = color(entry['color'])
            if entry['color'] in colors:
                raise ValueError('Palette colors must be unique and distinct from background')
            names.add(name)
            colors.add(entry['color'])
        for rule in palette['rules']:
            if (not isinstance(rule, dict) or not {'color', 'ranges'} <= set(rule)
                    or set(rule) - {'color', 'ranges', 'bounds'}):
                raise ValueError('Palette rule requires color and ranges, with optional bounds only')
            if 'bounds' in rule:
                bounds = rule['bounds']
                if (not isinstance(bounds, list) or len(bounds) != 4
                        or not all(type(v) is int for v in bounds)
                        or not (0 <= bounds[0] < bounds[2] and 0 <= bounds[1] < bounds[3])):
                    raise ValueError('Rule bounds must be integer pixel edges [left, top, right, bottom] '
                                     'with 0 <= left < right and 0 <= top < bottom')
            if not isinstance(rule['color'], str) or rule['color'] not in names:
                raise ValueError('Unknown palette rule color')
            if not isinstance(rule['ranges'], dict) or not rule['ranges']:
                raise ValueError('Rule ranges must be a nonempty object')
            for key, bounds in rule['ranges'].items():
                if key not in ('r', 'g', 'b', 'luma', 'hue', 'saturation', 'value'):
                    raise ValueError('Unknown palette range: ' + key)
                high = 360 if key == 'hue' else 255
                if (not isinstance(bounds, list) or len(bounds) != 2 or
                        not all(numeric(v) for v in bounds) or not 0 <= bounds[0] <= bounds[1] <= high):
                    raise ValueError(f'{key} range must satisfy 0 <= min <= max <= {high}')
    if params['labelModeSize'] and len(palette['colors']) > 255:
        raise ValueError('labelModeSize requires at most 256 labels including background (Pillow ModeFilter limit)')
    return params, paths, palette


def parse_path(data, transform=''):
    """Return exact L/C segments, including closure and translated subpaths."""
    tx = ty = 0.0
    if transform:
        match = re.fullmatch(r'\s*translate\(\s*(' + NUMBER + r')(?:[\s,]+(' + NUMBER + r'))?\s*\)\s*', transform)
        if not match:
            raise ValueError('Unsupported SVG transform: ' + transform)
        tx, ty = float(match[1]), float(match[2] or 0)
        if not math.isfinite(tx) or not math.isfinite(ty):
            raise ValueError('Nonfinite SVG translation')
    tokens, end = [], 0
    for match in TOKEN.finditer(data):
        if data[end:match.start()].strip(' \t\r\n,'):
            raise ValueError('Invalid SVG path syntax')
        tokens.append(match[0])
        end = match.end()
    if data[end:].strip(' \t\r\n,'):
        raise ValueError('Invalid SVG path syntax')
    segments, current, start = [], (0., 0.), None
    index, command = 0, None
    while index < len(tokens):
        if tokens[index].isalpha():
            command = tokens[index]
            index += 1
            if command.upper() not in ('M', 'L', 'C', 'Z'):
                raise ValueError('Unsupported SVG path command: ' + command)
            if command.upper() == 'Z':
                if start is None:
                    raise ValueError('SVG close without move')
                if current != start:
                    segments.append(('L', [current, start]))
                current = start
                command = None
                continue
        if command is None:
            raise ValueError('Missing SVG path command')
        count = 6 if command.upper() == 'C' else 2
        values = tokens[index:index + count]
        if len(values) != count or any(v.isalpha() for v in values):
            raise ValueError('Incomplete SVG path command: ' + command)
        values = list(map(float, values))
        if not all(math.isfinite(v) for v in values):
            raise ValueError('Nonfinite SVG coordinates')
        points = [(values[i], values[i + 1]) for i in range(0, count, 2)]
        if command.islower():
            points = [(x + current[0], y + current[1]) for x, y in points]
        if command.upper() == 'M':
            start = points[0]
            command = 'l' if command.islower() else 'L'
        else:
            if start is None:
                raise ValueError('SVG path must start with move')
            segments.append((command.upper(), [current] + points))
        current = points[-1]
        index += count
    return [(kind, [(x + tx, y + ty) for x, y in points]) for kind, points in segments]


def geometry_for(segments, bbox, width_mm, mirror_x=False):
    left, top, right, bottom = bbox
    scale = width_mm / (right - left)

    def point(pair):
        x = (pair[0] - (left + right) / 2) * scale * (-1 if mirror_x else 1)
        y = ((top + bottom) / 2 - pair[1]) * scale
        return [f'{0 if round(v, 12) == 0 else v:.12f} mm' for v in (x, y, 0)]

    return [dict(type='bezier', controlPoints=[point(p) for p in points]) if kind == 'C'
            else dict(type='line', start=point(points[0]), end=point(points[1]))
            for kind, points in segments]


def segment_image(image, palette, np, Image, label_mode_size=0):
    if palette is None:
        return image
    rgb = np.asarray(image).astype(float)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    high, low = rgb.max(axis=2), rgb.min(axis=2)
    delta = high - low
    safe = np.where(delta == 0, 1, delta)
    hue = np.zeros_like(high)
    hue = np.where(high == r, ((g - b) / safe) % 6, hue)
    hue = np.where((high == g) & (high != r), (b - r) / safe + 2, hue)
    hue = np.where((high == b) & (high != r) & (high != g), (r - g) / safe + 4, hue)
    hue = np.where(delta == 0, 0, hue * 60)
    channels = dict(r=r, g=g, b=b, luma=.299*r + .587*g + .114*b,
                    hue=hue, saturation=255 * delta / np.where(high == 0, 1, high), value=high)
    colors = np.array([tuple(bytes.fromhex(fill[1:])) for fill in
                       [palette['background']] + [e['color'] for e in palette['colors']]], dtype=np.uint8)
    color_ids = {e['name']: index + 1 for index, e in enumerate(palette['colors'])}
    labels = np.zeros(high.shape, dtype=np.uint8 if label_mode_size else np.int32)
    assigned = np.zeros(high.shape, dtype=bool)
    for rule in palette['rules']:
        mask = ~assigned
        if 'bounds' in rule:
            left, top, right, bottom = rule['bounds']
            mask[:top] = False
            mask[bottom:] = False
            mask[:, :left] = False
            mask[:, right:] = False
        for channel, (lo, hi) in rule['ranges'].items():
            mask = mask & (channels[channel] >= lo) & (channels[channel] <= hi)
        labels[mask] = color_ids[rule['color']]
        assigned |= mask
    # Separate label regularization after first-match rules, never RGB filtering.
    if label_mode_size:
        ImageFilter = importlib.import_module('PIL.ImageFilter')
        labels = np.asarray(Image.fromarray(labels).filter(ImageFilter.ModeFilter(label_mode_size)))
    return Image.fromarray(colors[labels])


def write_json(path, value):
    with path.open('x', encoding='utf-8') as stream:
        json.dump(value, stream, indent=2, allow_nan=False)
        stream.write('\n')


def normalize_trace_coordinates(root, scale, size):
    """Similarity-transform L/C controls and translations, preserving subpaths."""
    if scale == 1:
        return
    width, height = size
    root.set('width', str(width))
    root.set('height', str(height))
    root.set('viewBox', f'0 0 {width} {height}')
    def coordinate(match):
        value = float(match[0]) / scale
        return str(int(value)) if value.is_integer() else repr(value)
    for element in root:
        for attr in ('d', 'transform'):
            if element.get(attr):
                element.set(attr, re.sub(NUMBER, coordinate, element.get(attr)))


def _traced_paths(root, palette):
    background = palette['background'] if palette else '#FFFFFF'
    traced, mapping = [], {}
    if palette:
        colors = [background] + [entry['color'] for entry in palette['colors']]
        rgb_colors = {fill: bytes.fromhex(fill[1:]) for fill in colors}
    for element in root.iter():
        tag = element.tag.split('}')[-1]
        if tag not in ('svg', 'path'):
            raise ValueError('Unsupported vtracer SVG element: ' + tag)
        if tag == 'svg':
            if 'transform' in element.attrib:
                raise ValueError('Unsupported SVG root transform')
            continue
        if set(element.attrib) - {'d', 'fill', 'transform'}:
            raise ValueError('Unsupported vtracer SVG path attributes')
        fill = color(element.get('fill'))
        if palette:
            if fill not in mapping:
                rgb = bytes.fromhex(fill[1:])
                mapping[fill] = min(colors, key=lambda candidate:
                    sum((a-b)**2 for a,b in zip(rgb, rgb_colors[candidate])))
            fill = mapping[fill]
            element.set('fill', fill)
        segments = parse_path(element.get('d', ''), element.get('transform', ''))
        if fill != background and segments:
            traced.append((fill, segments, element))
    return traced, mapping


def _supersampled_trace(segmented, scale, tunables, deps):
    Image = deps['PIL.Image']
    enlarged = segmented.resize((segmented.width * scale, segmented.height * scale), Image.Resampling.NEAREST)
    buffer = io.BytesIO()
    enlarged.save(buffer, format='PNG')
    return deps['vtracer'].convert_raw_image_to_svg(buffer.getvalue(), img_format='png',
        colormode='color', hierarchical='cutout', **{**tunables, 'length_threshold': tunables['length_threshold'] * scale})


def execute(request):
    params, paths, palette = validate(request)
    deps = dependencies()
    Image, ImageFilter, np = deps['PIL.Image'], deps['PIL.ImageFilter'], deps['numpy']
    source = paths['input'].read_bytes()
    with Image.open(io.BytesIO(source)) as loaded:
        rgba = loaded.convert('RGBA')
    if palette:
        for rule in palette['rules']:
            if 'bounds' in rule and (rule['bounds'][2] > rgba.width or rule['bounds'][3] > rgba.height):
                raise ValueError('Rule bounds must be contained within the input image')
    original = Image.alpha_composite(Image.new('RGBA', rgba.size, 'white'), rgba).convert('RGB')
    processed = original
    if params['medianSize']:
        processed = processed.filter(ImageFilter.MedianFilter(params['medianSize']))
    if params['blurSigma']:
        processed = processed.filter(ImageFilter.GaussianBlur(params['blurSigma']))
    segmented = segment_image(processed, palette, np, Image, params['labelModeSize'])
    trace_scale = params['traceScale']
    working_scale = 2 if params['traceDetailAreaPx2'] else trace_scale
    if working_scale > 1 and segmented.width * segmented.height * working_scale ** 2 > 30_000_000:
        raise ValueError('Upsampled tracing image exceeds 30 million pixels')
    background = palette['background'] if palette else '#FFFFFF'
    pixels = np.asarray(segmented)
    foreground = np.any(pixels != np.array(tuple(bytes.fromhex(background[1:]))), axis=2)
    ys, xs = np.nonzero(foreground)
    if not len(xs):
        raise ValueError('No foreground pixels after processing')
    bbox = [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]
    out = paths['out']
    out.mkdir(exist_ok=False)
    (out / 'sketches').mkdir()
    with (out / 'segmented.png').open('xb') as stream:
        segmented.save(stream, format='PNG')
    tunables = {re.sub(r'([A-Z])', lambda m: '_' + m[1].lower(), key): params[key]
                for key in ('filterSpeckle', 'cornerThreshold', 'lengthThreshold',
                            'spliceThreshold', 'maxIterations', 'pathPrecision',
                            'colorPrecision', 'layerDifference', 'mode')}
    if trace_scale == 1:
        deps['vtracer'].convert_image_to_svg_py(str(out / 'segmented.png'), str(out / 'raw_contours.svg'),
                                              colormode='color', hierarchical='cutout', **tunables)
    else:
        # Upsample only after classification/label filtering. No interpolated
        # shades, altered source/reference, or overlays; one complete trace.
        # Length remains in source pixels; speckle filtering acts on the finer
        # tracing grid so small source fragments have more cluster support.
        raw = _supersampled_trace(segmented, trace_scale, tunables, deps)
        tunables['length_threshold'] *= trace_scale
        with (out / 'raw_contours.svg').open('xb') as stream:
            stream.write(raw.encode('utf-8'))
    svg_bytes = (out / 'raw_contours.svg').read_bytes()
    root = ET.fromstring(svg_bytes)
    normalize_trace_coordinates(root, trace_scale, segmented.size)
    traced, raw_to_snapped = _traced_paths(root, palette)
    detail_audit = None
    if params['traceDetailAreaPx2']:
        spec = importlib.util.spec_from_file_location('_image_trace_detail', Path(__file__).with_name('image_trace_detail.py'))
        detail = importlib.util.module_from_spec(spec)
        try:
            spec.loader.exec_module(detail)
        except ImportError as exc:
            raise RuntimeError('traceDetailAreaPx2 requires assets/image_trace_detail_requirements.txt dependencies') from exc
        high = ET.fromstring(_supersampled_trace(segmented, 2, tunables, deps))
        normalize_trace_coordinates(high, 2, segmented.size)
        _, high_mapping = _traced_paths(high, palette)
        root, detail_audit = detail.replace_bundles(root, high, palette, params['traceDetailAreaPx2'], parse_path)
        detail_audit['ss2RawToSnappedColors'] = high_mapping
        traced, _ = _traced_paths(root, palette)
    if palette or trace_scale != 1:
        svg_bytes = ET.tostring(root, encoding='utf-8', xml_declaration=True)
    with (out / 'contours.svg').open('xb') as stream:
        stream.write(svg_bytes)
    if not traced:
        raise ValueError('Vtracer produced no foreground paths; retained partial output at ' + str(out))
    with (out / 'preview.png').open('xb') as stream:
        stream.write(deps['cairosvg'].svg2png(bytestring=svg_bytes))
    overlay = ET.Element('svg', xmlns=SVG, width=str(original.width), height=str(original.height),
                         viewBox=f'0 0 {original.width} {original.height}')
    buffer = io.BytesIO()
    original.save(buffer, format='PNG')
    ET.SubElement(overlay, 'image', width=str(original.width), height=str(original.height),
                  href='data:image/png;base64,' + base64.b64encode(buffer.getvalue()).decode('ascii'))
    for fill, segments, element in traced:
        ET.SubElement(overlay, 'path', d=element.get('d'), transform=element.get('transform', ''),
                      fill='none', stroke='#00FFFF', **{'stroke-width': '0.75'})
    overlay_bytes = ET.tostring(overlay, encoding='utf-8', xml_declaration=True)
    with (out / 'overlay.svg').open('xb') as stream:
        stream.write(overlay_bytes)
    with (out / 'overlay.png').open('xb') as stream:
        stream.write(deps['cairosvg'].svg2png(bytestring=overlay_bytes))
    run_id = (re.sub('[^A-Za-z0-9_-]', '_', out.name)[:64] or 'trace') + '_' + hashlib.sha256(str(out.resolve()).encode()).hexdigest()[:16]
    names = {entry['color']: entry['name'] for entry in palette['colors']} if palette else {}
    operations, sketch_files, by_color = [], [], {}
    spline_count = line_count = 0
    for index, (fill, segments, element) in enumerate(traced):
        label = names.get(fill, fill)
        name = run_id + '_' + re.sub('[^A-Za-z0-9_-]', '_', label)[:48] + f'_{index:04d}'
        geometry = geometry_for(segments, bbox, params['widthMm'], params['mirrorX'])
        file = f'sketches/{index:04d}.json'
        write_json(out / file, {'sketch': name, 'geometry': geometry})
        sketch_files.append(str(out / file))
        step = f'sketch_{index:04d}'
        operations.extend([{'id': step, 'operation': 'sketch.create', 'data': {'name': name, 'plane': 'XY'}},
                           {'id': f'geometry_{index:04d}', 'operation': 'sketch.geometry',
                            'data': {'sketch': {'$ref': step + '.result.sketch'}, 'geometry': geometry}}])
        spline_count += sum(kind == 'C' for kind, points in segments)
        line_count += sum(kind == 'L' for kind, points in segments)
        entry = by_color.setdefault(fill, {'name': label, 'paths': 0})
        entry['paths'] += 1
    write_json(out / 'import_sketches.json', {'runId': run_id, 'operations': operations})
    with Image.open(out / 'preview.png') as preview:
        rendered = Image.alpha_composite(Image.new('RGBA', preview.size, background), preview.convert('RGBA')).convert('RGB')
        rendered_pixels = np.asarray(rendered)
    iou = {}
    for fill in by_color:
        target = np.array(tuple(bytes.fromhex(fill[1:])))
        a, b = np.all(pixels == target, axis=2), np.all(rendered_pixels == target, axis=2)
        union = int(np.count_nonzero(a | b))
        iou[fill] = float(np.count_nonzero(a & b) / union) if union else None
    report = dict(runId=run_id, input=str(paths['input']), out=str(out), parameters=params,
                  traceSampling=dict(scale=trace_scale, resampling='nearest-neighbor after segmentation',
                      sourceSize=list(segmented.size), workingSize=[segmented.width * trace_scale, segmented.height * trace_scale],
                      lengthThresholdWorkingPx=tunables['length_threshold'], filterSpeckleWorkingPx=tunables['filter_speckle'],
                      rawContourCoordinates='tracing pixels', contourCoordinates='source pixels',
                      policy='complete trace; divide controls/translations by scale, no refitting; scale>1 limited to 30 million pixels'),
                  palette=palette, rawToSnappedColors=raw_to_snapped,
                  sourceSha256=hashlib.sha256(source).hexdigest(),
                  imageSize={'width': original.width, 'height': original.height},
                  background=background, foregroundBbox=bbox, bboxConvention='pixel edges [left, top, right, bottom]',
                  scaleMmPerPixel=params['widthMm'] / (bbox[2] - bbox[0]),
                  splineCount=spline_count, lineCount=line_count, pathCount=len(traced), pathsByColor=by_color,
                  dependencies={package: importlib.metadata.version(package) for package in ('Pillow', 'numpy', 'vtracer', 'CairoSVG')},
                  files={key: str(out / filename) for key, filename in
                         [('segmented', 'segmented.png'), ('contours', 'contours.svg'), ('preview', 'preview.png'),
                          ('overlaySvg', 'overlay.svg'), ('overlay', 'overlay.png'), ('report', 'report.json'),
                          ('importSketches', 'import_sketches.json'), ('rawContours', 'raw_contours.svg')]},
                  sketches=sketch_files, renderedColorIoU=iou,
                  limitations=['Independent colored boundary tessellation may leave gaps or overlaps; no CAD solid validation.',
                                'traceScale>1 preserves exact nearest-neighbor source labels but may greatly increase spline count. '
                                'Length threshold is source-pixel based; speckle threshold remains tracing-grid based. '
                                'raw_contours.svg is in tracing pixels; contours, previews and sketch geometry use normalized source coordinates.',
                               'IoU compares exact rendered colors against segmentation, not source idealness; antialiasing reduces scores.',
                               'Scale uses processed foreground mask pixel bounds, before speckle filtering; curves may extend beyond them.',
                               'With a palette, every traced fill is snapped to the nearest configured RGB color or background; '
                               'ties prefer background then palette declaration order. Geometry is unchanged; snapping does not undo merged regions.',
                               'Only the first image frame is traced; EXIF orientation is not applied.',
                                'Partial outputs are retained on failure; retry requires a new output directory.'])
    if detail_audit is not None:
        report['traceDetailAudit'] = detail_audit
    write_json(out / 'report.json', report)
    return {'success': True, 'operation': 'image.trace', 'result': report}


def main():
    try:
        raw = sys.stdin.read(32 * 1024 * 1024 + 1)
        if len(raw) > 32 * 1024 * 1024:
            raise ValueError('Worker JSON input exceeds limit')
        result = execute(json.loads(raw))
        print(json.dumps(result, allow_nan=False))
    except Exception as exc:
        print(f'image.trace: {type(exc).__name__}: {exc}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())

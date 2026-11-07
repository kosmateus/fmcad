"""Artifacts intentionally persist. No CAD session or cleanup operations."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

try:
    import PIL  # noqa: F401
    import numpy  # noqa: F401
    import vtracer  # noqa: F401
    import cairosvg  # noqa: F401
    _HAVE_RASTER = True
except ImportError:
    _HAVE_RASTER = False


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('image_trace', ROOT / 'assets/image_trace.py')
trace = importlib.util.module_from_spec(spec)
spec.loader.exec_module(trace)


@unittest.skipUnless(_HAVE_RASTER, 'trace tests require Pillow, numpy, vtracer and CairoSVG; use .venv/bin/python')
class ImageTraceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from PIL import Image, ImageDraw
        artifacts = ROOT / '.test-artifacts'
        artifacts.mkdir(exist_ok=True)
        cls.artifacts = Path(tempfile.mkdtemp(prefix='image-trace-', dir=artifacts))
        print('\nRetained image trace artifacts: ' + str(cls.artifacts))
        cls.source = cls.artifacts / 'source.png'
        image = Image.new('RGB', (180, 120), 'white')
        draw = ImageDraw.Draw(image)
        draw.rectangle((10, 20, 65, 95), fill='#111111')
        draw.ellipse((80, 15, 165, 100), fill='#111111')
        draw.rectangle((105, 40, 140, 75), fill='#FF0000')
        with cls.source.open('xb') as stream:
            image.save(stream, format='PNG')
        cls.palette = cls.artifacts / 'palette.json'
        trace.write_json(cls.palette, {'background': '#FFFFFF', 'colors': [
            {'name': 'Black', 'color': '#111111'}, {'name': 'Insert', 'color': '#FF0000'}],
            'rules': [{'color': 'Black', 'ranges': {'luma': [0, 50]}},
                      {'color': 'Insert', 'ranges': {'hue': [0, 10], 'saturation': [200, 255]}}]})

    def request(self, name, **kwargs):
        return dict(input=str(self.source), out=str(self.artifacts / name), **kwargs)

    def test_trace_and_exclusive_output(self):
        request = self.request('traced', palette=str(self.palette))
        result = trace.execute(request)
        self.assertTrue(result['success'])
        self.assertEqual(result['operation'], 'image.trace')
        report = result['result']
        self.assertEqual(report['parameters']['labelModeSize'], 0)
        self.assertGreater(report['splineCount'], 0)
        self.assertEqual(report['foregroundBbox'], [10, 15, 166, 101])
        self.assertNotIn('#FFFFFF', report['pathsByColor'])
        self.assertEqual(report['pathsByColor']['#FF0000']['name'], 'Insert')
        self.assertGreater(report['renderedColorIoU']['#111111'], .85)
        self.assertGreater(report['renderedColorIoU']['#FF0000'], .95)
        svg = trace.ET.parse(report['files']['contours']).getroot()
        rectangle = next(element for element in svg if element.get('transform') == 'translate(10,20)')
        segments = trace.parse_path(rectangle.get('d'), rectangle.get('transform'))
        self.assertEqual([points[-1] for _, points in segments], [(66, 20), (66, 96), (10, 96), (10, 20)])
        # Vtracer represents straight edges as collinear cubics in spline mode.
        for _, points in segments:
            self.assertTrue(len({x for x, y in points}) == 1 or len({y for x, y in points}) == 1)
        for file in report['files'].values():
            self.assertTrue(Path(file).is_file(), file)
        batch = json.loads(Path(report['files']['importSketches']).read_text())
        self.assertEqual(len(batch['operations']), 2 * report['pathCount'])
        for index in range(0, len(batch['operations']), 2):
            create, geometry = batch['operations'][index:index + 2]
            self.assertEqual(create['data']['plane'], 'XY')
            self.assertEqual(geometry['data']['sketch'], {'$ref': create['id'] + '.result.sketch'})
        before = {str(p): p.read_bytes() for p in Path(request['out']).rglob('*') if p.is_file()}
        with self.assertRaisesRegex(ValueError, 'NEW directory'):
            trace.execute(request)
        self.assertEqual(before, {str(p): p.read_bytes() for p in Path(request['out']).rglob('*') if p.is_file()})

    def test_native_polygon(self):
        report = trace.execute(self.request('polygon', mode='polygon'))['result']
        self.assertEqual(report['splineCount'], 0)
        self.assertGreater(report['lineCount'], 0)

    def test_post_trace_palette_snapping(self):
        raw = b'''<svg xmlns="http://www.w3.org/2000/svg" width="180" height="120">
<path fill="#FEFEFE" d="M0 0 L180 0 L180 120 L0 120 Z"/>
<path fill="#141414" d="M0 0 C20 0 20 20 0 20 Z" transform="translate(10,20)"/>
<path fill="#111111" d="M40 20 L60 20 L60 40 L40 40 Z"/>
<path fill="#FE0101" d="M70 20 L90 20 L90 40 L70 40 Z"/>
<path fill="#888888" d="M100 20 L120 20 L120 40 L100 40 Z"/>
</svg>'''

        def converter(image_path, out_path, **kwargs):
            self.assertEqual(Path(out_path).name, 'raw_contours.svg')
            self.assertFalse(Path(out_path).with_name('contours.svg').exists())
            with Path(out_path).open('xb') as stream:
                stream.write(raw)

        deps = trace.dependencies()
        for use_palette in (True, False):
            with self.subTest(palette=use_palette):
                request = self.request('snapping-' + str(use_palette),
                                       **({'palette': str(self.palette)} if use_palette else {}))
                with patch.object(deps['vtracer'], 'convert_image_to_svg_py', side_effect=converter):
                    report = trace.execute(request)['result']
                self.assertEqual(Path(report['files']['rawContours']).read_bytes(), raw)
                normalized = Path(report['files']['contours']).read_bytes()
                original_paths = list(trace.ET.fromstring(raw))
                normalized_paths = list(trace.ET.fromstring(normalized))
                self.assertEqual(len(original_paths), len(normalized_paths))
                for original, output in zip(original_paths, normalized_paths):
                    self.assertEqual({k: v for k, v in original.attrib.items() if k != 'fill'},
                                     {k: v for k, v in output.attrib.items() if k != 'fill'})
                if use_palette:
                    self.assertEqual(report['rawToSnappedColors'], {
                        '#FEFEFE': '#FFFFFF', '#141414': '#111111', '#111111': '#111111',
                        '#FE0101': '#FF0000', '#888888': '#FFFFFF'})
                    self.assertEqual(report['pathsByColor'], {
                        '#111111': {'name': 'Black', 'paths': 2},
                        '#FF0000': {'name': 'Insert', 'paths': 1}})
                    self.assertEqual({p.get('fill') for p in normalized_paths},
                                     {'#FFFFFF', '#111111', '#FF0000'})
                    selected_paths = original_paths[1:4]
                    with deps['PIL.Image'].open(report['files']['preview']) as preview:
                        preview = preview.convert('RGB')
                        self.assertEqual(preview.getpixel((0, 0)), (255, 255, 255))
                        self.assertEqual(preview.getpixel((15, 25)), (17, 17, 17))
                        self.assertEqual(preview.getpixel((75, 25)), (255, 0, 0))
                else:
                    self.assertEqual(normalized, raw)
                    self.assertEqual(report['rawToSnappedColors'], {})
                    self.assertEqual(set(report['pathsByColor']), {p.get('fill') for p in original_paths})
                    selected_paths = original_paths
                self.assertEqual(report['pathCount'], len(selected_paths))
                overlay = trace.ET.parse(report['files']['overlaySvg']).getroot()
                overlay_paths = overlay.findall('{' + trace.SVG + '}path')
                self.assertEqual([p.get('d') for p in overlay_paths], [p.get('d') for p in selected_paths])
                for file, original in zip(report['sketches'], selected_paths):
                    sketch = json.loads(Path(file).read_text())
                    expected = trace.geometry_for(
                        trace.parse_path(original.get('d'), original.get('transform', '')),
                        report['foregroundBbox'], report['parameters']['widthMm'])
                    self.assertEqual(sketch['geometry'], expected)

    def test_adjustments_and_white_composite(self):
        deps = trace.dependencies()
        Image = deps['PIL.Image']
        image = Image.new('RGBA', (40, 40), (0, 0, 0, 0))
        image.paste((0, 0, 0, 255), (10, 10, 30, 30))
        source = self.artifacts / 'alpha.png'
        with source.open('xb') as stream:
            image.save(stream, format='PNG')
        request = self.request('adjusted', blurSigma=.5, medianSize=3, cornerThreshold=80,
                               spliceThreshold=50, lengthThreshold=5, maxIterations=12,
                               filterSpeckle=2, colorPrecision=7, layerDifference=1, pathPrecision=5)
        request['input'] = str(source)
        converter = deps['vtracer'].convert_image_to_svg_py
        with patch.object(deps['vtracer'], 'convert_image_to_svg_py', wraps=converter) as called:
            report = trace.execute(request)['result']
        self.assertEqual(called.call_args.kwargs, dict(colormode='color', hierarchical='cutout',
            mode='spline', filter_speckle=2, corner_threshold=80, length_threshold=5,
            splice_threshold=50, max_iterations=12, path_precision=5, color_precision=7, layer_difference=1))
        with Image.open(report['files']['segmented']) as segmented:
            self.assertEqual(segmented.getpixel((0, 0)), (255, 255, 255))
        self.assertEqual(report['parameters']['medianSize'], 3)
        self.assertEqual(report['parameters']['blurSigma'], .5)

    def test_invalid_before_creation(self):
        invalid = dict(blurSigma=-1, medianSize=2, labelModeSize=2, filterSpeckle=1.5, cornerThreshold=181,
                       lengthThreshold=0, spliceThreshold=-1, maxIterations=0,
                       pathPrecision=16, colorPrecision=9, layerDifference=256,
                       mode='smooth', widthMm=0, mirrorX=1, unknown=True)
        for key, value in invalid.items():
            with self.subTest(key=key):
                request = self.request('invalid-' + key, **{key: value})
                with self.assertRaises(ValueError):
                    trace.execute(request)
                self.assertFalse(Path(request['out']).exists())
        for index, bounds in enumerate(([0, 361], [100, 0], [True, 10])):
            palette = json.loads(self.palette.read_text())
            palette['rules'][0]['ranges'] = {'hue': bounds}
            path = self.artifacts / f'bad-palette-{index}.json'
            trace.write_json(path, palette)
            request = self.request(f'bad-palette-out-{index}', palette=str(path))
            with self.assertRaises(ValueError):
                trace.execute(request)
            self.assertFalse(Path(request['out']).exists())

    def test_parser_and_units(self):
        segments = trace.parse_path('M0 0 L10 0 C10 2 8 10 0 10 Z m2 2 l1 0 0 1 z', 'translate(5,6)')
        self.assertEqual([kind for kind, _ in segments], ['L', 'C', 'L', 'L', 'L', 'L'])
        geometry = trace.geometry_for(segments, [5, 6, 15, 16], 50)
        self.assertEqual(geometry[0]['start'], ['-25.000000000000 mm', '25.000000000000 mm', '0.000000000000 mm'])
        self.assertEqual(geometry[1]['type'], 'bezier')
        self.assertEqual(len(geometry[1]['controlPoints']), 4)
        mirrored = trace.geometry_for(segments, [5, 6, 15, 16], 50, True)
        self.assertEqual(mirrored[0]['start'][0], '25.000000000000 mm')
        for data, transform in [('M0 0 Q1 2 3 4', ''), ('M0 0', 'scale(2)'), ('M0 0 C1 2', ''), ('L1 2', '')]:
            with self.assertRaises(ValueError):
                trace.parse_path(data, transform)

    def test_rule_order_and_hsv(self):
        deps = trace.dependencies()
        image = deps['PIL.Image'].new('RGB', (1, 1), '#FF0000')
        palette = {'background': '#FFFFFF', 'colors': [
            {'name': 'first', 'color': '#111111'}, {'name': 'second', 'color': '#222222'}],
            'rules': [{'color': 'first', 'ranges': {'hue': [0, 1], 'value': [255, 255]}},
                      {'color': 'second', 'ranges': {'r': [0, 255]}},
                      {'color': 'first', 'ranges': {'b': [0, 255]}}]}
        output = trace.segment_image(image, palette, deps['numpy'], deps['PIL.Image'])
        self.assertEqual(output.getpixel((0, 0)), (17, 17, 17))

    def test_label_mode_regularization(self):
        deps = trace.dependencies()
        Image, np = deps['PIL.Image'], deps['numpy']
        palette = {'background': '#FFFFFF', 'colors': [
            {'name': 'Black', 'color': '#111111'}, {'name': 'Gray', 'color': '#808080'}],
            'rules': [{'color': 'Black', 'ranges': {'luma': [0, 50]}},
                      {'color': 'Gray', 'ranges': {'luma': [51, 200]}}]}
        image = Image.new('RGB', (32, 32), 'white')
        image.paste('#111111', (8, 8, 24, 24))
        image.paste('#808080', (7, 8, 8, 24))
        source = self.artifacts / 'label-band.png'
        with source.open('xb') as stream:
            image.save(stream, format='PNG')
        palette_path = self.artifacts / 'label-palette.json'
        trace.write_json(palette_path, palette)
        unchanged = trace.segment_image(image, palette, np, Image)
        self.assertEqual(unchanged.tobytes(), image.tobytes())
        for size in (3, 5, 7):
            filtered = trace.segment_image(image, palette, np, Image, size)
            self.assertLessEqual(set(map(tuple, np.asarray(filtered).reshape(-1, 3))),
                                 {(255, 255, 255), (17, 17, 17), (128, 128, 128)})
        request = dict(input=str(source), out=str(self.artifacts / 'label-mode'),
                       palette=str(palette_path), labelModeSize=3)
        report = trace.execute(request)['result']
        self.assertEqual(report['parameters']['labelModeSize'], 3)
        with Image.open(report['files']['segmented']) as filtered:
            self.assertEqual(set(map(tuple, np.asarray(filtered).reshape(-1, 3))),
                             {(255, 255, 255), (17, 17, 17)})
            # Every original black corner still has black within one pixel.
            for x, y in ((8, 8), (23, 8), (8, 23), (23, 23)):
                self.assertTrue(any(filtered.getpixel((x + dx, y + dy)) == (17, 17, 17)
                                    for dx in (-1, 0, 1) for dy in (-1, 0, 1)))
            self.assertEqual(filtered.crop((9, 9, 23, 23)).getextrema(), ((17, 17),) * 3)

    def test_rule_bounds_targeting(self):
        deps = trace.dependencies()
        Image = deps['PIL.Image']
        image = Image.new('RGB', (6, 5), '#808080')
        image.putpixel((2, 2), (255, 255, 255))
        palette = {'background': '#FFFFFF', 'colors': [
            {'name': 'Local', 'color': '#111111'}, {'name': 'Global', 'color': '#808080'}],
            'rules': [{'color': 'Local', 'ranges': {'luma': [0, 200]}, 'bounds': [1, 1, 4, 4]},
                      {'color': 'Global', 'ranges': {'luma': [0, 200]}}]}
        output = trace.segment_image(image, palette, deps['numpy'], Image)
        for y in range(5):
            for x in range(6):
                expected = ((255, 255, 255) if (x, y) == (2, 2) else
                            (17, 17, 17) if 1 <= x < 4 and 1 <= y < 4 else (128, 128, 128))
                self.assertEqual(output.getpixel((x, y)), expected)
        # Full-image pixel edges are valid and equivalent to omitting bounds.
        palette['rules'][0]['bounds'] = [0, 0, 6, 5]
        bounded = trace.segment_image(image, palette, deps['numpy'], Image)
        del palette['rules'][0]['bounds']
        self.assertEqual(bounded.tobytes(), trace.segment_image(image, palette, deps['numpy'], Image).tobytes())
        palette['rules'][0]['bounds'] = [0, 0, 180, 120]
        path = self.artifacts / 'bounds-full-palette.json'
        trace.write_json(path, palette)
        report = trace.execute(self.request('bounds-full', palette=str(path)))['result']
        self.assertEqual(report['palette']['rules'][0]['bounds'], [0, 0, 180, 120])

    def test_rule_bounds_validation(self):
        invalid = [None, [], [0, 0, 1], [0, 0, 1, 1, 2], [False, 0, 1, 1],
                   [0, 0, 1.0, 1], [-1, 0, 1, 1], [0, -1, 1, 1],
                   [1, 0, 1, 1], [0, 1, 1, 1], [2, 0, 1, 1],
                   [0, 0, 181, 120], [0, 0, 180, 121]]
        for index, bounds in enumerate(invalid):
            with self.subTest(bounds=bounds):
                palette = json.loads(self.palette.read_text())
                palette['rules'][0]['bounds'] = bounds
                path = self.artifacts / f'bounds-invalid-{index}.json'
                trace.write_json(path, palette)
                request = self.request(f'bounds-invalid-out-{index}', palette=str(path))
                with self.assertRaisesRegex(ValueError, 'bounds'):
                    trace.execute(request)
                self.assertFalse(Path(request['out']).exists())

    def test_label_mode_validation(self):
        for size in (3, 5, 7):
            request = self.request(f'label-no-palette-{size}', labelModeSize=size)
            with self.assertRaisesRegex(ValueError, 'requires a palette'):
                trace.execute(request)
            self.assertFalse(Path(request['out']).exists())
        for index, size in enumerate((True, 3.0, -1, 1, 9)):
            request = self.request(f'label-invalid-{index}', palette=str(self.palette), labelModeSize=size)
            with self.assertRaisesRegex(ValueError, 'labelModeSize must be'):
                trace.execute(request)
            self.assertFalse(Path(request['out']).exists())
        palette = {'background': '#FFFFFF', 'colors': [
            {'name': str(i), 'color': f'#{i:06X}'} for i in range(256)], 'rules': []}
        path = self.artifacts / 'label-large-palette.json'
        trace.write_json(path, palette)
        request = self.request('label-too-many', palette=str(path), labelModeSize=3)
        with self.assertRaisesRegex(ValueError, '256 labels'):
            trace.execute(request)
        self.assertFalse(Path(request['out']).exists())
        request['labelModeSize'] = 0
        trace.validate(request)

    def test_palette_unknown_fields(self):
        for index, mutation in enumerate((
                lambda p: p.update(extra=True),
                lambda p: p['colors'][0].update(extra=True),
                lambda p: p['rules'][0].update(extra=True),
                lambda p: p['rules'][0].update(color='unknown'),
                lambda p: p['rules'][0].update(ranges={'unknown': [0, 1]}))):
            palette = json.loads(self.palette.read_text())
            mutation(palette)
            path = self.artifacts / f'unknown-palette-{index}.json'
            trace.write_json(path, palette)
            request = self.request(f'unknown-palette-out-{index}', palette=str(path))
            with self.assertRaises(ValueError):
                trace.execute(request)
            self.assertFalse(Path(request['out']).exists())

    def test_lazy_dependencies(self):
        with patch.object(trace.importlib, 'import_module', side_effect=ImportError('missing')):
            with self.assertRaisesRegex(RuntimeError, 'pip install -r assets/image_trace_requirements.txt'):
                trace.execute(self.request('missing-dependencies'))
        self.assertFalse((self.artifacts / 'missing-dependencies').exists())

    def test_stdio_contract(self):
        command = [sys.executable, '-B', str(ROOT / 'assets/image_trace.py')]
        completed = subprocess.run(command, input=json.dumps(self.request('stdio')),
                                   text=True, capture_output=True, check=False)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(len(completed.stdout.splitlines()), 1)
        self.assertEqual(json.loads(completed.stdout)['operation'], 'image.trace')
        failed = subprocess.run(command, input=json.dumps(self.request('stdio-invalid', widthMm=-1)),
                                text=True, capture_output=True, check=False)
        self.assertNotEqual(failed.returncode, 0)
        self.assertEqual(failed.stdout, '')
        self.assertIn('widthMm', failed.stderr)
        self.assertFalse((self.artifacts / 'stdio-invalid').exists())


if __name__ == '__main__':
    unittest.main()

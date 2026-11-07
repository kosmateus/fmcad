"""Local worker tests. All fixture/output artifacts are retained, never removed."""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

try:
    import numpy as np  # noqa: F401
    import PIL  # noqa: F401
    _HAVE_RASTER = True
except ImportError:
    _HAVE_RASTER = False

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('image_boundaries', ROOT / 'assets/image_boundaries.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


@unittest.skipUnless(_HAVE_RASTER, 'raster tests require numpy and Pillow; use .venv/bin/python')
class ImageBoundariesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import numpy as np
        from PIL import Image
        cls.np, cls.Image = np, Image
        parent = ROOT / '.test-artifacts'
        parent.mkdir(exist_ok=True)
        cls.artifacts = Path(tempfile.mkdtemp(prefix='image-boundaries-', dir=parent))
        print('\nRetained boundary artifacts: ' + str(cls.artifacts))
        cls.fills = ['#FFFFFF', '#FF0000', '#0000FF', '#00FF00', '#FFFF00']
        cls.palette = cls.artifacts / 'palette.json'
        entries = [dict(name=f'color{i}', color=c) for i, c in enumerate(cls.fills[1:], 1)]
        rules = [dict(color=e['name'], ranges={k: [v, v] for k, v in zip('rgb', bytes.fromhex(e['color'][1:]))})
                 for e in entries]
        worker.trace.write_json(cls.palette, dict(background=cls.fills[0], colors=entries, rules=rules))

    def fixture(self, name, defect=None, four=False):
        folder = self.artifacts / name
        folder.mkdir()
        labels = self.np.zeros((32, 40), dtype=self.np.int32)
        labels[4:28, 4:20] = 1
        labels[4:28, 20:36] = 2
        labels[10:14, 8:12] = 0
        red = 'M4 4 L20 4 L20 28 L4 28 Z'
        hole = ' M8 10 L8 14 L12 14 L12 10 Z'
        blue = 'M20 4 L36 4 L36 28 L20 28 Z'
        if defect in ('gap', 'wide'):
            x = 19 if defect == 'gap' else 15
            red = f'M4 4 L20 4 L20 10 L{x} 10 L{x} 22 L20 22 L20 28 L4 28 Z'
        if defect in ('overlap', 'ambiguous'):
            blue = 'M20 4 L36 4 L36 28 L20 28 L20 22 L19 22 L19 10 L20 10 Z'
        if defect == 'ambiguous':
            labels[10:22, 19:20] = 3
        paths = [(1, dict(d=red+hole, fill=self.fills[1])), (2, dict(d=blue, fill=self.fills[2]))]
        if four:
            labels[18:28, 4:20] = 3
            labels[20:28, 20:36] = 4
            paths = [(p['label'], dict(d=self.path_data(p['segments']), fill=self.fills[p['label']]))
                     for p in self.mock_network(labels, scale=1)['paths']]
        if defect == 'duplicate':
            paths.append(paths[0])
        if defect == 'silhouette':
            paths.append((1, dict(d='M3 8 L4 8 L4 20 L3 20 Z', fill=self.fills[1])))
        svg, reference = folder/'input.svg', folder/'reference.png'
        with svg.open('xb') as stream:
            stream.write(worker.svg_bytes(paths, (40, 32)))
        colors = self.np.array([list(bytes.fromhex(c[1:])) for c in self.fills], dtype=self.np.uint8)
        with reference.open('xb') as stream:
            self.Image.fromarray(colors[labels]).save(stream, format='PNG')
        return dict(svg=str(svg), reference=str(reference), palette=str(self.palette),
                    out=str(folder/'out'), referenceMode='labels'), labels

    @staticmethod
    def path_data(segments):
        commands, previous = [], None
        for kind, points in segments:
            if previous is None or previous != points[0]:
                commands.append('M ' + ' '.join(map(str, points[0])))
            commands.append(kind+' '+' '.join(str(v) for point in points[1:] for v in point))
            previous = points[-1]
        return ' '.join(commands)

    def mock_network(self, labels, scale=1, **kwargs):
        # Test-only exact pixel union, with straight cubics to exercise Bezier export.
        from shapely.geometry import box
        from shapely.ops import unary_union
        result = []
        for label in self.np.unique(labels):
            if not label:
                continue
            ys, xs = self.np.nonzero(labels == label)
            shape = unary_union([box(x/scale, y/scale, (x+1)/scale, (y+1)/scale) for y, x in zip(ys, xs)])
            polygons = [shape] if shape.geom_type == 'Polygon' else shape.geoms
            segments = []
            for polygon in polygons:
                for ring in [polygon.exterior, *polygon.interiors]:
                    coords = list(ring.coords)
                    for a, b in zip(coords, coords[1:]):
                        segments.append(('C', [a, tuple((2*x+y)/3 for x, y in zip(a, b)),
                                                tuple((x+2*y)/3 for x, y in zip(a, b)), b]))
            result.append(dict(label=int(label), segments=segments))
        return dict(paths=result, diagnostics=dict(testMock=True))

    def image_array(self, report, name):
        with self.Image.open(report['files'][name]) as image:
            return self.np.asarray(image).copy()

    def test_inspect_hole_gap_and_distinct_color_overlap(self):
        for defect, expected_gap, expected_overlap in [('gap', 12, 0), ('overlap', 0, 12), ('duplicate', 0, 0)]:
            request, labels = self.fixture('inspect-'+defect, defect)
            with patch.object(worker, 'shared_vectorize', side_effect=AssertionError('inspect called helper')):
                report = worker.execute(request)['result']
            self.assertEqual(report['status'], 'inspected')
            self.assertEqual(report['gapAreaPx'], expected_gap)
            self.assertEqual(report['overlapAreaPx'], expected_overlap)
            self.assertEqual(report['changedAreaPx'], 0)
            gaps = self.image_array(report, 'gaps.png')
            self.assertFalse(gaps[20:28, 16:24].any(), 'intentional reference hole is not a gap')
            self.assertFalse((Path(request['out'])/'repaired.svg').exists())

    def test_narrow_gap_and_overlap_repair_protect_hole_and_untouched_pixels(self):
        for defect in ('gap', 'overlap'):
            request, labels = self.fixture('repair-'+defect, defect)
            request.update(mode='repair', widthMm=64, mirrorX=True)
            original_hash = hashlib.sha256(Path(request['svg']).read_bytes()).hexdigest()
            with patch.object(worker, 'shared_vectorize', side_effect=self.mock_network) as helper:
                report = worker.execute(request)['result']
            self.assertEqual(report['status'], 'ready', report['warnings'])
            self.assertEqual(report['changedAreaPx'], 12)
            self.assertFalse(report['geometryValidated'])
            after = self.image_array(report, 'after_labels.png')
            expected = labels.repeat(2, axis=0).repeat(2, axis=1)
            self.np.testing.assert_array_equal(after, expected)
            before = self.image_array(report, 'before_labels.png')
            changed = self.image_array(report, 'changed.png') > 0
            self.np.testing.assert_array_equal(before[~changed], after[~changed])
            self.assertFalse(after[expected == 0].any())
            self.assertEqual(helper.call_args.kwargs, dict(scale=2, fit_error_px=.35, corner_angle=55))
            sketch = json.loads(Path(report['files']['sketches/0000.json']).read_text())
            self.assertTrue(all(g['type'] == 'bezier' for g in sketch['geometry']))
            self.assertEqual(report['svgSha256'], original_hash)
            self.assertEqual(hashlib.sha256(Path(request['svg']).read_bytes()).hexdigest(), original_hash)

    def test_wide_ambiguous_and_budget_block(self):
        for defect in ('wide', 'ambiguous', 'gap'):
            request, _ = self.fixture('blocked-'+defect, defect)
            request['mode'] = 'repair'
            if defect == 'gap':
                request['maxChangedAreaPx'] = 10
            with patch.object(worker, 'shared_vectorize', side_effect=AssertionError('blocked called helper')) as helper:
                report = worker.execute(request)['result']
            helper.assert_not_called()
            self.assertEqual(report['status'], 'blocked')
            self.assertGreater(report['unresolvedAreaPx'], 0)
            self.assertEqual(report['changedAreaPx'], 0)
            self.assertFalse((Path(request['out'])/'import_sketches.json').exists())

    def test_four_colors_preserved(self):
        request, labels = self.fixture('four', four=True)
        with patch.object(worker, 'shared_vectorize', side_effect=self.mock_network):
            report = worker.execute(dict(request, mode='repair'))['result']
        self.assertEqual(report['status'], 'ready', report['warnings'])
        self.assertEqual(set(self.np.unique(self.image_array(report, 'after_labels.png'))), {0, 1, 2, 3, 4})
        self.assertEqual(report['changedAreaPx'], 0)

    def test_missing_and_bad_helper_do_not_publish(self):
        for name, effect in [('missing', RuntimeError('not available')), ('bad', lambda *a, **k: {'paths': []})]:
            request, _ = self.fixture(name)
            with patch.object(worker, 'shared_vectorize', side_effect=effect):
                report = worker.execute(dict(request, mode='repair'))['result']
            self.assertEqual(report['status'], 'blocked')
            self.assertFalse((Path(request['out'])/'repaired.svg').exists())

    def test_invalid_requests_have_no_output(self):
        request, _ = self.fixture('invalid')
        invalid = [dict(scale=True), dict(scale=5), dict(scale=1.5), dict(maxGapWidthPx=0),
                   dict(maxOverlapWidthPx=-1), dict(maxChangedAreaPx=float('inf')), dict(fitErrorPx=2.1),
                   dict(cornerAngle=181), dict(cornerAngle=True), dict(widthMm=0), dict(mirrorX=1),
                   dict(mode='other'), dict(referenceMode='other'), dict(svg='relative'), dict(extra=1)]
        for changes in invalid:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                worker.execute(dict(request, **changes))
            self.assertFalse(Path(request['out']).exists())
        for key in ('svg', 'reference', 'palette', 'out'):
            missing = dict(request)
            missing.pop(key)
            with self.assertRaises(ValueError):
                worker.execute(missing)
            self.assertFalse(Path(request['out']).exists())

    def test_unsafe_svg_and_invalid_labels_rejected_before_creation(self):
        request, _ = self.fixture('unsafe')
        for index, body in enumerate(['<image href="file:///etc/passwd"/>', '<g/>',
                                      '<path d="M0 0 L1 1 Z" fill="#FF0000" style="fill:red"/>',
                                      '<path d="M0 0 Q1 1 2 2 Z" fill="#FF0000"/>',
                                      '<path d="M0 0 L1 1 Z" fill="#FF0000" transform="scale(2)"/>',
                                      '<path d="M0 0 L1 1 Z" fill="#FF0000" fill-rule="evenodd"/>']):
            svg = self.artifacts / f'unsafe-{index}.svg'
            with svg.open('x') as stream:
                stream.write(f'<svg width="40" height="32">{body}</svg>')
            with self.assertRaises(ValueError):
                worker.execute(dict(request, svg=str(svg)))
            self.assertFalse(Path(request['out']).exists())
        bad = self.artifacts/'bad-labels.png'
        with bad.open('xb') as stream:
            self.Image.new('RGB', (40, 32), '#123456').save(stream, format='PNG')
        with self.assertRaisesRegex(ValueError, 'undeclared'):
            worker.execute(dict(request, reference=str(bad)))
        self.assertFalse(Path(request['out']).exists())

    def test_source_classification_and_no_overwrite(self):
        request, _ = self.fixture('source')
        report = worker.execute(dict(request, referenceMode='source'))['result']
        self.assertEqual(report['gapAreaPx'], 0)
        saved = {p: p.read_bytes() for p in Path(request['out']).rglob('*') if p.is_file()}
        with self.assertRaisesRegex(ValueError, 'NEW directory'):
            worker.execute(request)
        self.assertEqual(saved, {p: p.read_bytes() for p in Path(request['out']).rglob('*') if p.is_file()})

    def test_source_transparency_is_composited_white_without_filters(self):
        request, labels = self.fixture('transparent-source')
        with self.Image.open(request['reference']) as image:
            pixels = self.np.asarray(image.convert('RGBA')).copy()
        pixels[labels == 0] = [255, 0, 0, 0]
        source = self.artifacts/'transparent.png'
        with source.open('xb') as stream:
            self.Image.fromarray(pixels).save(stream, format='PNG')
        report = worker.execute(dict(request, reference=str(source), referenceMode='source'))['result']
        self.assertEqual(report['gapAreaPx'], 0)
        self.assertEqual(report['silhouetteExcessAreaPx'], 0)
        actual = self.image_array(report, 'reference.png')
        self.assertTrue(self.np.all(actual[labels == 0] == 255))

    def test_silhouette_missing_and_single_color_hole_are_not_repaired(self):
        for name, cut in [('missing-silhouette', 'M4 8 L4 20 L5 20 L5 8 Z'),
                          ('single-color-hole', 'M14 17 L14 21 L15 21 L15 17 Z')]:
            request, _ = self.fixture(name)
            parsed = worker.parse_svg(Path(request['svg']).read_bytes(), (40, 32), self.fills)
            parsed[0][1]['d'] += ' ' + cut
            svg = self.artifacts/(name+'.svg')
            with svg.open('xb') as stream:
                stream.write(worker.svg_bytes(parsed, (40, 32)))
            with patch.object(worker, 'shared_vectorize', side_effect=self.mock_network):
                report = worker.execute(dict(request, svg=str(svg), mode='repair'))['result']
            self.assertEqual(report['status'], 'ready' if name == 'missing-silhouette' else 'blocked', report['warnings'])
            self.assertEqual(report['changedAreaPx'], 0)
            self.np.testing.assert_array_equal(self.image_array(report, 'before_labels.png'),
                                               self.image_array(report, 'after_labels.png'))

    def test_translation_dimensions_and_entities(self):
        request, _ = self.fixture('translation')
        parsed = worker.parse_svg(Path(request['svg']).read_bytes(), (40, 32), self.fills)
        parsed[0][1]['transform'] = 'translate(0, 0)'
        translated = self.artifacts/'translated.svg'
        with translated.open('xb') as stream:
            stream.write(worker.svg_bytes(parsed, (40, 32)))
        report = worker.execute(dict(request, svg=str(translated)))['result']
        self.assertEqual(report['gapAreaPx'], 0)
        for index, data in enumerate([b'<svg width="41" height="32"/>',
                                      b'<svg width="40" height="32" viewBox="1 0 40 32"/>',
                                      b'<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg width="40" height="32"/>']):
            svg = self.artifacts/f'bad-document-{index}.svg'
            with svg.open('xb') as stream:
                stream.write(data)
            out = self.artifacts/f'bad-document-{index}'
            with self.assertRaises(ValueError):
                worker.execute(dict(request, svg=str(svg), out=str(out)))
            self.assertFalse(out.exists())

    def test_fit_gate_blocks_background_fill_and_color_loss(self):
        for name, corrupt in [('fill-hole', lambda a: a.__setitem__((slice(20, 28), slice(16, 24)), 1)),
                              ('lose-color', lambda a: a.__setitem__(a == 2, 1))]:
            request, _ = self.fixture(name)

            def wrong_network(labels, **kwargs):
                corrupt(labels)
                return self.mock_network(labels, **kwargs)

            with patch.object(worker, 'shared_vectorize', side_effect=wrong_network):
                report = worker.execute(dict(request, mode='repair'))['result']
            self.assertEqual(report['status'], 'blocked')
            self.assertFalse((Path(request['out'])/'repaired.svg').exists())

    def test_protected_offsets_with_internal_repair_export_unchanged(self):
        for real in (False, True):
            if real and not (ROOT/'assets/image_shared_boundaries.py').is_file():
                continue
            request, labels = self.fixture('offset-gap-'+str(real), 'gap')
            parsed = worker.parse_svg(Path(request['svg']).read_bytes(), (40, 32), self.fills)
            parsed.append((1, dict(d='M3 8 L4 8 L4 20 L3 20 Z', fill=self.fills[1])))
            parsed[1][1]['d'] += ' M35 6 L35 26 L36 26 L36 6 Z'
            svg = self.artifacts/('offset-gap-'+str(real)+'.svg')
            with svg.open('xb') as stream:
                stream.write(worker.svg_bytes(parsed, (40, 32)))
            original_helper = worker.shared_vectorize if real else self.mock_network
            with patch.object(worker, 'shared_vectorize', side_effect=original_helper):
                report = worker.execute(dict(request, svg=str(svg), mode='repair'))['result']
            self.assertEqual(report['status'], 'ready', report['warnings'])
            self.assertEqual(report['changedAreaPx'], 12)
            self.assertEqual(report['protectedDifferenceAreaPx'], 32)
            self.assertEqual(report['unresolvedAreaPx'], 0)
            self.assertEqual(report['afterGapAreaPx'], 20, 'protected missing silhouette must remain missing')
            self.assertEqual(report['silhouetteExcessAreaPx'], 12)
            self.assertEqual(report['referenceHoleTopology']['failures'], [])
            self.assertEqual(sum(c['status'] == 'protected_unchanged' for c in report['components']), 2)
            before, after = (self.image_array(report, n+'_labels.png') for n in ('before', 'after'))
            changed = self.image_array(report, 'changed.png') > 0
            protected = self.image_array(report, 'protected.png') > 0
            fg = labels.repeat(2, axis=0).repeat(2, axis=1) > 0
            self.assertFalse(changed[~fg].any())
            self.assertFalse(changed[protected].any())
            self.np.testing.assert_array_equal(before[~changed], after[~changed])
            self.assertFalse(after[20:28, 16:24].any(), 'original hole remains empty')
            self.assertTrue(Path(report['files']['repaired.svg']).is_file())
            self.assertIn('proposed label partition', report['fitValidation']['baseline'])

    def test_closed_split_and_opened_reference_holes_block(self):
        for name, path in [('closed-hole', 'M8 10 L12 10 L12 14 L8 14 Z'),
                           ('split-hole', 'M9.5 10 L10 10 L10 14 L9.5 14 Z'),
                           ('opened-hole', 'M9 4 L9 10 L10 10 L10 4 Z'),
                           ('wide-silhouette', 'M0 8 L4 8 L4 20 L0 20 Z')]:
            request, _ = self.fixture(name)
            parsed = worker.parse_svg(Path(request['svg']).read_bytes(), (40, 32), self.fills)
            if name == 'opened-hole':
                parsed[0][1]['d'] += ' ' + path
            else:
                parsed.append((1, dict(d=path, fill=self.fills[1])))
            svg = self.artifacts/(name+'.svg')
            with svg.open('xb') as stream:
                stream.write(worker.svg_bytes(parsed, (40, 32)))
            with patch.object(worker, 'shared_vectorize') as helper:
                report = worker.execute(dict(request, svg=str(svg), mode='repair'))['result']
            helper.assert_not_called()
            self.assertEqual(report['status'], 'blocked')
            self.assertEqual(report['changedAreaPx'], 0)
            self.np.testing.assert_array_equal(self.image_array(report, 'before_labels.png'),
                                               self.image_array(report, 'after_labels.png'))
            if name != 'wide-silhouette':
                expected = {'closed-hole': 'reference_hole_closed', 'split-hole': 'reference_hole_split',
                            'opened-hole': 'reference_hole_opened_to_exterior'}[name]
                self.assertEqual(report['referenceHoleTopology']['failures'][0]['reason'], expected)
            else:
                self.assertGreater(report['unresolvedAreaPx'], 0)
            self.assertFalse((Path(request['out'])/'repaired.svg').exists())

    def test_serialization_failure_publishes_only_diagnostics(self):
        request, _ = self.fixture('serialization-failure')
        with patch.object(worker, 'shared_vectorize', side_effect=self.mock_network), \
                patch.object(worker.trace, 'geometry_for', side_effect=ValueError('injected export failure')):
            report = worker.execute(dict(request, mode='repair'))['result']
        self.assertEqual(report['status'], 'blocked')
        self.assertIn('injected export failure', report['warnings'][-1])
        for name in ('repaired.svg', 'preview.png', 'overlay.svg', 'overlay.png', 'import_sketches.json', 'sketches'):
            self.assertFalse((Path(request['out'])/name).exists(), name)
        self.assertTrue((Path(request['out'])/'after.png').is_file())

    def test_hole_contour_offset_is_protected_but_merged_holes_block(self):
        for name in ('hole-offset', 'merged-holes'):
            request, labels = self.fixture(name)
            parsed = worker.parse_svg(Path(request['svg']).read_bytes(), (40, 32), self.fills)
            if name == 'hole-offset':
                parsed[0][1]['d'] = 'M4 4 L20 4 L20 28 L4 28 Z M8.5 10.5 L8.5 13.5 L11.5 13.5 L11.5 10.5 Z'
            else:
                labels[10:14, 13:17] = 0
                parsed[0][1]['d'] = 'M4 4 L20 4 L20 28 L4 28 Z M8 10 L8 14 L17 14 L17 10 Z'
                colors = self.np.array([list(bytes.fromhex(c[1:])) for c in self.fills], dtype=self.np.uint8)
                reference = self.artifacts/(name+'.png')
                with reference.open('xb') as stream:
                    self.Image.fromarray(colors[labels]).save(stream, format='PNG')
                request['reference'] = str(reference)
            svg = self.artifacts/(name+'.svg')
            with svg.open('xb') as stream:
                stream.write(worker.svg_bytes(parsed, (40, 32)))
            with patch.object(worker, 'shared_vectorize', side_effect=self.mock_network):
                report = worker.execute(dict(request, svg=str(svg), mode='repair'))['result']
            self.assertEqual(report['changedAreaPx'], 0)
            self.np.testing.assert_array_equal(self.image_array(report, 'before_labels.png'),
                                               self.image_array(report, 'after_labels.png'))
            if name == 'hole-offset':
                self.assertEqual(report['status'], 'ready', report['warnings'])
                self.assertEqual(report['protectedDifferenceAreaPx'], 7)
                self.assertEqual(report['unresolvedAreaPx'], 0)
            else:
                self.assertEqual(report['status'], 'blocked')
                self.assertEqual(report['referenceHoleTopology']['significantHoleCount'], 2)
                self.assertEqual(report['referenceHoleTopology']['failures'][0]['reason'], 'reference_holes_merged')

    def test_six_million_pixel_components_use_local_edt(self):
        from scipy import ndimage as ndi
        np = self.np
        folder = self.artifacts/'local-edt'
        folder.mkdir()
        labels = np.zeros((1000, 1500), dtype=np.int32)
        labels[20:980, 20:750] = 1
        labels[20:980, 750:1480] = 2
        colors = np.array([list(bytes.fromhex(c[1:])) for c in self.fills], dtype=np.uint8)
        reference, svg = folder/'reference.png', folder/'input.svg'
        with reference.open('xb') as stream:
            self.Image.fromarray(colors[labels]).save(stream, format='PNG')
        red = 'M20 20 L750 20 '
        for y in range(50, 950, 3):
            red += f'L750 {y} L749 {y} L749 {y+1} L750 {y+1} '
        red += 'L750 980 L20 980 Z'
        paths = [(1, dict(d=red, fill=self.fills[1])),
                 (2, dict(d='M750 20 L1480 20 L1480 980 L750 980 Z', fill=self.fills[2]))]
        with svg.open('xb') as stream:
            stream.write(worker.svg_bytes(paths, (1500, 1000)))
        shapes = []
        original_edt = ndi.distance_transform_edt

        def measured_edt(array, *args, **kwargs):
            shapes.append(array.shape)
            # Fail fast on regressions instead of executing 300 full-image EDTs.
            self.assertLessEqual(sum(h*w >= 6_000_000 for h, w in shapes), 3)
            return original_edt(array, *args, **kwargs)

        started = time.monotonic()
        with patch.object(ndi, 'distance_transform_edt', side_effect=measured_edt):
            report = worker.execute(dict(svg=str(svg), reference=str(reference), palette=str(self.palette),
                                         out=str(folder/'out'), referenceMode='labels'))['result']
        print(f'6M working pixels, 300 components, retained diagnostics: {time.monotonic()-started:.3f}s')
        self.assertEqual(report['parameters']['scale'], 2)
        self.assertEqual(len(report['components']), 300)
        self.assertEqual(report['gapAreaPx'], 300)
        self.assertEqual(report['repairableAreaPx'], 300)
        self.assertEqual(report['unresolvedAreaPx'], 0)
        self.assertEqual(sum(h*w <= 144 for h, w in shapes), 300)
        self.assertEqual(len(shapes), 303)

    def test_stdin_envelope(self):
        request, _ = self.fixture('stdin', 'wide')
        completed = subprocess.run([sys.executable, str(ROOT/'assets/image_boundaries.py')],
                                   input=json.dumps(request), text=True, capture_output=True)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        result = json.loads(completed.stdout)
        self.assertEqual(set(result), {'success', 'operation', 'result'})
        self.assertEqual(result['operation'], 'image.boundaries')
        self.assertTrue(result['success'])
        self.assertEqual(len(completed.stdout.splitlines()), 1)
        summary = result['result']
        self.assertNotIn('components', summary)
        self.assertEqual(summary['unresolvedReasonCounts'], {'width_limit': 1})
        report = json.loads(Path(summary['files']['report.json']).read_text())
        self.assertEqual(len(report['components']), 1)
        self.assertIn('bboxPx', report['components'][0])
        for key, value in summary.items():
            if key != 'unresolvedReasonCounts':
                self.assertEqual(value, report[key])

    def test_main_groups_many_component_reasons_without_dumping_records(self):
        report = dict(status='blocked', out='/unused', geometryValidated=False,
                      files={'report.json': '/unused/report.json'}, warnings=[],
                      components=[dict(status='unresolved', reason='width_limit', bboxPx=[0, 0, 1, 1])]*3000 +
                                 [dict(status='unresolved', reason='global_area_budget')]*2000 +
                                 [dict(status='protected_unchanged', reason='preexisting_silhouette_deviation')])
        stdout = worker.io.StringIO()
        with patch.object(worker, 'execute', return_value=dict(success=True, operation='image.boundaries', result=report)), \
                patch.object(sys, 'stdin', worker.io.StringIO('{}')), patch.object(sys, 'stdout', stdout):
            self.assertEqual(worker.main(), 0)
        summary = json.loads(stdout.getvalue())['result']
        self.assertEqual(summary['unresolvedReasonCounts'], {'width_limit': 3000, 'global_area_budget': 2000})
        self.assertNotIn('components', summary)
        self.assertLess(len(stdout.getvalue()), 1000)
        self.assertEqual(len(report['components']), 5001, 'Full execute result must not be mutated')

    @unittest.skipUnless((ROOT/'assets/image_shared_boundaries.py').is_file(), 'shared helper not yet available')
    def test_real_helper_hole_and_four_colors(self):
        for name, four, defect in [('real-hole', False, 'gap'), ('real-four', True, None)]:
            request, _ = self.fixture(name, defect, four=four)
            report = worker.execute(dict(request, mode='repair'))['result']
            self.assertEqual(report['status'], 'ready', report['warnings'])
            self.assertTrue(report['sampledMaskValidated'])


if __name__ == '__main__':
    unittest.main()

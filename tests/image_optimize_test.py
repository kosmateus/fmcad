"""Focused optimizer tests; all artifacts persist under the repository, no cleanup."""
import hashlib
import importlib.util
import io
import json
import math
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
    import cv2  # noqa: F401
    import scipy  # noqa: F401
    _HAVE_RASTER = True
except ImportError:
    _HAVE_RASTER = False

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('image_optimize', ROOT / 'assets/image_optimize.py')
opt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(opt)


@unittest.skipUnless(_HAVE_RASTER, 'optimizer tests require numpy, Pillow, cv2 and SciPy; use .venv/bin/python')
class ImageOptimizeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.deps = opt.dependencies()
        cls.np, cls.Image, _, _, _ = cls.deps
        parent = ROOT / '.test-artifacts'
        parent.mkdir(exist_ok=True)
        cls.artifacts = Path(tempfile.mkdtemp(prefix='image-optimize-', dir=parent))
        print('\nRetained optimizer artifacts: ' + str(cls.artifacts))
        cls.palette_data = dict(background='#FFFFFF', colors=[dict(name='Ink', color='#000000')],
                                rules=[dict(color='Ink', ranges={'luma': [0, 127]})])
        cls.palette = cls.artifacts / 'palette.json'
        opt.trace.write_json(cls.palette, cls.palette_data)
        cls.source = cls.artifacts / 'source.png'
        from PIL import ImageDraw
        image = cls.Image.new('RGB', (128, 96), 'white')
        draw = ImageDraw.Draw(image)
        draw.rectangle((15, 15, 110, 80), fill='black')
        draw.ellipse((40, 30, 65, 60), fill='white')
        with cls.source.open('xb') as stream:
            image.save(stream, format='PNG')

    def request(self, name, **kwargs):
        return dict(input=str(self.source), palette=str(self.palette), out=str(self.artifacts / name),
                    **kwargs)

    def scope_score(self, ref, candidate, curves=None):
        scope = opt.fixed_scope(ref, [0, 0, ref.shape[1], ref.shape[0]], 2, 64, self.deps)
        return opt.score_scope(candidate, curves or [], scope, scope, self.palette_data,
                               64, opt.DEFAULT_WEIGHTS, self.deps, (candidate > 0).astype(self.np.uint32))

    def test_fixed_reference_real_search_and_regions(self):
        request = self.request('real-search', trials=6, topK=3,
                               base={'widthMm': 72, 'mirrorX': True},
                               weights={'gaps': 75, 'overlaps': 125},
                               search={'blurSigma': [0, 2, 6], 'cornerThreshold': [35, 90]},
                               regions=[dict(name='hole', bounds=[30, 20, 75, 70], weight=2)])
        report = opt.execute(request)['result']
        self.assertEqual(report['evaluated'], 6)
        self.assertEqual(report['base']['filterSpeckle'], 8)
        self.assertEqual(report['base']['pathPrecision'], 6)
        self.assertEqual(report['weights']['gaps'], 75)
        self.assertEqual(report['weights']['overlaps'], 125)
        self.assertFalse(report['geometryValidated'])
        self.assertEqual(report['reference']['sha256'], hashlib.sha256(Path(report['reference']['path']).read_bytes()).hexdigest())
        source = self.Image.open(self.source).convert('RGB')
        expected = opt.trace.segment_image(source, self.palette_data, self.np, self.Image, 0)
        actual = self.Image.open(report['reference']['path']).convert('RGB')
        self.np.testing.assert_array_equal(self.np.asarray(actual), self.np.asarray(expected))
        hashes, segmented = set(), set()
        for candidate in report['candidates']:
            self.assertNotIn('error', candidate, candidate.get('error'))
            self.assertEqual(candidate['parameters']['widthMm'], 72)
            self.assertTrue(candidate['parameters']['mirrorX'])
            hashes.add(candidate['referenceSha256'])
            segmented.add(hashlib.sha256((Path(candidate['out']) / 'segmented.png').read_bytes()).hexdigest())
            expected_score = (candidate['scopes']['fullImage']['score'] + 2*candidate['scopes']['hole']['score']) / 3
            self.assertAlmostEqual(candidate['score'], expected_score)
        self.assertEqual(len(hashes), 1)
        self.assertGreater(len(segmented), 1, 'Blur must change candidate processing, not the reference')
        self.assertIsNotNone(report['best'])
        winner = next(c for c in report['candidates'] if c['id'] == report['best']['id'])
        self.assertEqual(report['bestBoundaryMetrics'],
                         {name: scope['boundaryMetrics'] for name, scope in winner['scopes'].items()})
        self.assertEqual(report['baselineBoundaryMetrics'],
                         {name: scope['boundaryMetrics'] for name, scope in report['candidates'][0]['scopes'].items()})
        settings = json.loads(Path(report['files']['bestSettings']).read_text())
        self.assertNotIn('out', settings)
        self.assertEqual(settings['input'], str(self.source))
        self.assertEqual(settings['mode'], 'spline')
        self.assertTrue(Path(report['regional'][0]['contactSheet']).is_file())
        self.assertEqual(len(Path(report['files']['candidates']).read_text().splitlines()), 6)
        before = {p: p.read_bytes() for p in Path(request['out']).rglob('*') if p.is_file()}
        with self.assertRaisesRegex(ValueError, 'NEW directory'):
            opt.execute(request)
        self.assertEqual(before, {p: p.read_bytes() for p in Path(request['out']).rglob('*') if p.is_file()})

    def test_sharp_rectangle_beats_rounded_corners(self):
        from PIL import ImageDraw
        ref = self.Image.new('L', (160, 120), 0)
        ImageDraw.Draw(ref).rectangle((20, 20, 140, 100), fill=1)
        rounded = self.Image.new('L', ref.size, 0)
        ImageDraw.Draw(rounded).rounded_rectangle((20, 20, 140, 100), radius=20, fill=1)
        sharp = self.scope_score(self.np.asarray(ref), self.np.asarray(ref))
        soft = self.scope_score(self.np.asarray(ref), self.np.asarray(rounded))
        self.assertEqual(sharp['parts']['corners'], 0)
        self.assertGreater(soft['parts']['corners'], 5)
        self.assertGreater(soft['score'], sharp['score'])

    def test_missing_hole_fails_topology_and_thin_halo_ignored(self):
        np = self.np
        ref = np.zeros((120, 160), dtype=np.int32)
        ref[15:105, 15:145] = 1
        ref[40:75, 55:95] = 0
        candidate = ref.copy()
        candidate[40:75, 55:95] = 1
        result = self.scope_score(ref, candidate)
        self.assertTrue(result['topologyFailures'])
        ink = result['colors'][1]
        self.assertEqual(ink['referenceTopology']['holes'], 1)
        self.assertEqual(ink['candidateTopology']['holes'], 0)
        halo = ref.copy()
        halo[3, 3:155] = 1
        self.assertFalse(self.scope_score(ref, halo)['topologyFailures'])

    def test_jagged_circle_has_svg_derivative_roughness(self):
        from PIL import ImageDraw
        image = self.Image.new('L', (160, 160), 0)
        ImageDraw.Draw(image).ellipse((30, 30, 130, 130), fill=1)
        ref = self.np.asarray(image)
        scope = opt.fixed_scope(ref, [0, 0, 160, 160], 2, 64, self.deps)
        self.assertEqual(len(scope['colors'][1]['corners']), 0)
        k = 50 * .5522847498
        smooth = [('C', [(130, 80), (130, 80+k), (80+k, 130), (80, 130)]),
                  ('C', [(80, 130), (80-k, 130), (30, 80+k), (30, 80)]),
                  ('C', [(30, 80), (30, 80-k), (80-k, 30), (80, 30)]),
                  ('C', [(80, 30), (80+k, 30), (130, 80-k), (130, 80)])]
        points = [(80+(50+(3 if i % 2 else -3))*math.cos(i*math.tau/80),
                   80+(50+(3 if i % 2 else -3))*math.sin(i*math.tau/80)) for i in range(80)]
        jagged = []
        for a, b in zip(points, points[1:] + points[:1]):
            a, b = self.np.array(a), self.np.array(b)
            jagged.append(('C', [a, a+(b-a)/3, a+2*(b-a)/3, b]))
        smooth_score = opt.curve_metrics([(1, smooth)], scope, scope, self.np)
        jagged_score = opt.curve_metrics([(1, jagged)], scope, scope, self.np)
        self.assertGreater(smooth_score['roughness'], 0, 'Cubic bending energy must be measured')
        self.assertGreater(jagged_score['roughness'], smooth_score['roughness']*10)
        self.assertGreater(jagged_score['complexity'], smooth_score['complexity'])

    def test_antialias_nearest_labels_and_absent_color(self):
        np = self.np
        image = self.Image.fromarray(np.array([[[120, 120, 120], [200, 200, 200]]], dtype=np.uint8))
        labels, _ = opt.labels_for(image, np.array([[255]*3, [0]*3]), np)
        self.assertEqual(labels.tolist(), [[1, 0]])
        blank = np.zeros((20, 20), dtype=np.int32)
        scored = self.scope_score(blank, blank)
        self.assertEqual(scored['colors'][1]['iou'], 1)
        self.assertFalse(scored['colors'][1]['scoringActive'])
        self.assertEqual(scored['score'], 0)

    def test_logo_specks_and_thin_bands_are_not_fidelity_features(self):
        np = self.np
        palette = dict(background='#EEEEEE', colors=[dict(name='Black', color='#000000'),
                       dict(name='Red', color='#FF0000'), dict(name='Gray', color='#888888'),
                       dict(name='White', color='#FFFFFF')], rules=[])
        ref = np.ones((150, 230), dtype=np.int32)
        ref[35:115, 100:195] = 2
        ref[8, 8] = 0
        ref[12, 12] = 3
        ref[16, 16] = 4
        ref[22, 25:205] = 3
        ref[26, 25:205] = 4
        ref[30, 25:205] = 0
        cleaned = np.where(np.isin(ref, [0, 3, 4]), 1, ref)
        before = ref.copy()
        scope = opt.fixed_scope(ref, [0, 0, 230, 150], 5, 64, self.deps)
        fixed_masks = [c['mask'].copy() for c in scope['colors']]
        score = opt.score_scope(cleaned, [], scope, scope, palette, 64, opt.DEFAULT_WEIGHTS, self.deps,
                                (cleaned > 0).astype(np.uint32))
        self.assertFalse(score['topologyFailures'])
        # Preserved black contours still include the tiny holes/bands removed by
        # cleaning, but absent insignificant colors must not add diagonal penalties.
        self.assertLess(score['score'], .05 * math.hypot(230, 150),
                        'Irrelevant colors must not trigger diagonal-scale penalties')
        for index in (0, 3, 4):
            color = score['colors'][index]
            self.assertFalse(color['scoringActive'])
            self.assertEqual(color['iou'], 1)
            self.assertEqual(color['chamferMeanPx'], 0)
            self.assertEqual(color['chamferP95Px'], 0)
            self.assertEqual(color['cornerDisplacementPx'], 0)
            self.assertEqual(color['referenceTopology'], dict(components=0, holes=0))
        self.assertTrue(score['colors'][1]['scoringActive'])
        self.assertTrue(score['colors'][2]['scoringActive'])
        missing = cleaned.copy()
        missing[missing == 2] = 1
        failed = opt.score_scope(missing, [], scope, scope, palette, 64, opt.DEFAULT_WEIGHTS, self.deps,
                                 (missing > 0).astype(np.uint32))
        self.assertTrue(any(f['color'] == '#FF0000' for f in failed['topologyFailures']))
        red = failed['colors'][2]
        self.assertTrue(red['scoringActive'])
        self.assertEqual(red['iou'], 0)
        self.assertAlmostEqual(red['chamferMeanPx'], math.hypot(230, 150))
        np.testing.assert_array_equal(ref, before)
        for fixed, before_mask in zip(scope['colors'], fixed_masks):
            np.testing.assert_array_equal(fixed['mask'], before_mask)
        for index, color in enumerate(score['colors']):
            self.assertEqual(color['referenceTopology'], opt.topology(ref == index, 64, np, self.deps[4]))
            self.assertEqual(color['candidateTopology'], opt.topology(cleaned == index, 64, np, self.deps[4]))

    def test_metric_mask_reconstructs_original_contours(self):
        np, _, _, _, ndi = self.deps
        mask = np.zeros((60, 90), dtype=bool)
        mask[10:30, 10:30] = True
        mask[20, 30:55] = True
        mask[45, 5:85] = True
        mask[4, 4] = True
        expected = mask.copy()
        expected[45, :] = False
        expected[4, 4] = False
        result = opt.metric_mask(mask, 64, np, ndi)
        np.testing.assert_array_equal(result, expected)
        self.assertTrue(result[20, 54], 'Retain the full attached contour, not only its opened core')
        thin = np.zeros_like(mask)
        thin[20, 5:85] = True
        self.assertFalse(opt.metric_mask(thin, 64, np, ndi).any())

    def boundary_case(self, reference, body):
        palette = dict(background='#FFFFFF', colors=[dict(name='Black', color='#000000'),
                       dict(name='Red', color='#FF0000')], rules=[])
        size = (reference.shape[1], reference.shape[0])
        svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{size[0]}" height="{size[1]}">'
               + body + '</svg>').encode()
        occupancy = opt.color_occupancy(svg, size, palette, self.deps)
        cairo = opt.trace.importlib.import_module('cairosvg')
        with self.Image.open(io.BytesIO(cairo.svg2png(bytestring=svg))) as im:
            composite = self.Image.alpha_composite(self.Image.new('RGBA', size, 'white'), im.convert('RGBA'))
        labels, _ = opt.labels_for(composite, self.np.array([[255, 255, 255], [0, 0, 0], [255, 0, 0]]), self.np)
        scope = opt.fixed_scope(reference, [0, 0, *size], 3, 64, self.deps)
        scored = opt.score_scope(labels, [], scope, scope, palette, 64, opt.DEFAULT_WEIGHTS, self.deps, occupancy)
        return scored, occupancy, scope, labels

    def test_boundary_audit_excludes_intentional_reference_hole(self):
        reference = self.np.zeros((80, 100), dtype=self.np.int32)
        reference[10:70, 10:90] = 1
        reference[30:50, 35:65] = 0
        scored, occupancy, _, labels = self.boundary_case(reference,
            '<path fill="#000000" d="M10 10 L90 10 L90 70 L10 70 Z M35 30 L35 50 L65 50 L65 30 Z"/>')
        self.np.testing.assert_array_equal(labels, reference)
        self.assertFalse(occupancy[30:50, 35:65].any())
        audit = scored['boundaryMetrics']
        self.assertEqual(audit['rawGapAreaPx'], 0)
        self.assertEqual(audit['internalGapAreaPx'], 0)
        self.assertEqual(audit['overlapAreaPx'], 0)
        self.assertEqual(audit['referenceForegroundAreaPx'], 4200)
        self.assertFalse(scored['topologyFailures'])

    def test_narrow_internal_gap_penalty_and_fixed_regional_depth(self):
        reference = self.np.zeros((80, 100), dtype=self.np.int32)
        reference[10:70, 10:50] = 1
        reference[10:70, 50:90] = 2
        red = '<path fill="#FF0000" d="M50 10 L90 10 L90 70 L50 70 Z"/>'
        clean, _, _, _ = self.boundary_case(reference,
            '<path fill="#000000" d="M10 10 L50 10 L50 70 L10 70 Z"/>' + red)
        gap, occupancy, scope, _ = self.boundary_case(reference,
            '<path fill="#000000" d="M10 10 L49 10 L49 70 L10 70 Z"/>' + red)
        audit = gap['boundaryMetrics']
        self.assertEqual(audit['rawGapAreaPx'], 60)
        self.assertEqual(audit['internalGapAreaPx'], 56)
        self.assertEqual(audit['contourOffsetGapAreaPx'], 4)
        self.assertEqual(audit['internalGap']['componentCount'], 1)
        self.assertEqual(audit['internalGap']['largestComponentWidthPx'], 1)
        self.assertAlmostEqual(audit['gapFraction'], 56/4800)
        self.assertAlmostEqual(gap['weightedParts']['gaps'], 100*56/4800)
        self.assertGreater(gap['score'], clean['score'])
        self.assertFalse(gap['topologyFailures'], 'The new ranking penalty must not invent topology failures')
        region = opt.fixed_scope(reference, [48, 20, 52, 60], 3, 64, self.deps,
                                 reference_depth=scope['foregroundDepthPx'])
        regional = opt.boundary_audit(occupancy, region, self.deps)
        self.assertEqual(regional['rawGapAreaPx'], 40)
        self.assertEqual(regional['internalGapAreaPx'], 40)
        disabled = opt.score_scope(reference, [], scope, scope,
                    dict(background='#FFFFFF', colors=[dict(color='#000000'), dict(color='#FF0000')]),
                    64, {**opt.DEFAULT_WEIGHTS, 'gaps': 0, 'overlaps': 0}, self.deps, occupancy)
        self.assertEqual(disabled['weightedParts']['gaps'], 0)
        self.assertEqual(disabled['boundaryMetrics'], audit, 'Raw audit must remain even when its weights are zero')

    def test_distinct_color_overlap_detected_despite_composite_hiding(self):
        reference = self.np.zeros((80, 100), dtype=self.np.int32)
        reference[10:70, 10:50] = 1
        reference[10:70, 50:90] = 2
        scored, occupancy, _, labels = self.boundary_case(reference,
            '<path fill="#000000" d="M10 10 L60 10 L60 70 L10 70 Z"/>'
            '<path fill="#FF0000" d="M50 10 L90 10 L90 70 L50 70 Z"/>')
        self.np.testing.assert_array_equal(labels, reference)
        self.assertEqual(int(occupancy.max()), 2)
        audit = scored['boundaryMetrics']
        self.assertEqual(audit['overlapAreaPx'], 600)
        self.assertEqual(audit['overlap']['componentCount'], 1)
        self.assertAlmostEqual(audit['overlapFraction'], 600/4800)
        self.assertEqual(scored['parts']['overlap'], 0, 'Composite IoU alone hides this overlap')
        self.assertEqual(scored['parts']['gaps'], 0)
        self.assertAlmostEqual(scored['weightedParts']['overlaps'], 12.5)
        self.assertFalse(scored['topologyFailures'])

    def test_same_color_paths_union_without_winding_cancellation(self):
        reference = self.np.zeros((80, 100), dtype=self.np.int32)
        reference[10:70, 10:90] = 1
        cases = [
            '<path fill="#000000" d="M10 10 L60 10 L60 70 L10 70 Z"/>'
            '<path fill="#000000" d="M40 10 L40 70 L90 70 L90 10 Z"/>',
            '<path fill="#000000" d="M10 10 L90 10 L90 70 L10 70 Z"/>'
            '<path fill="#000000" d="M10 10 L90 10 L90 70 L10 70 Z M35 30 L35 50 L65 50 L65 30 Z"/>'
        ]
        for body in cases:
            with self.subTest(body=body):
                scored, occupancy, _, labels = self.boundary_case(reference, body)
                self.np.testing.assert_array_equal(labels, reference)
                self.np.testing.assert_array_equal(occupancy, reference)
                self.assertEqual(scored['boundaryMetrics']['overlapAreaPx'], 0)
                self.assertEqual(scored['boundaryMetrics']['rawGapAreaPx'], 0)
                self.assertEqual(scored['score'], 0)

    def test_independent_render_rejects_undeclared_fill(self):
        reference = self.np.zeros((80, 100), dtype=self.np.int32)
        with self.assertRaises(ValueError):
            self.boundary_case(reference, '<path fill="#00FF00" d="M10 10 L90 10 L90 70 L10 70 Z"/>')

    def test_seeded_search_budget_and_neighbor_choices(self):
        def run(seed):
            base = {**opt.trace.DEFAULTS, 'filterSpeckle': 8, 'pathPrecision': 6}
            search = opt.Search(base, opt.DEFAULT_SEARCH, seed, 24)
            choices, best = [], None
            for i in range(24):
                item = search.next(best)
                if item is None:
                    break
                p, selection = item
                choices.append(item)
                if best is None or p['cornerThreshold'] < best['parameters']['cornerThreshold']:
                    best = dict(id=str(i), parameters=p)
                if selection['stage'] == 'refine':
                    parent = choices[int(selection['parent'])][0]
                    self.assertEqual(sum(p[k] != parent[k] for k in p), 1)
            return choices
        a, b, c = run(17), run(17), run(18)
        self.assertEqual(a, b)
        self.assertNotEqual(a, c)
        self.assertEqual(len(a), 24)
        self.assertEqual(len({json.dumps(p, sort_keys=True) for p, _ in a}), 24)
        self.assertEqual(a[0][1]['stage'], 'baseline')
        self.assertIn('refine', [s['stage'] for _, s in a])
        small = opt.Search(opt.trace.DEFAULTS, {'blurSigma': [0]}, 17, 128)
        self.assertIsNotNone(small.next(None))
        self.assertIsNone(small.next(None))

    def test_invalid_requests_create_nothing(self):
        changes = [dict(extra=1), dict(input='relative.png'), dict(palette=None),
                   dict(base={'out': '/tmp/forbidden'}), dict(base={'mode': 'polygon'}),
                   dict(base={'medianSize': 2}), dict(search={'widthMm': [20]}),
                   dict(search={'blurSigma': [0, float('nan')]}),
                   dict(search={'medianSize': [0, 2]}), dict(search={'labelModeSize': [3, 4]}),
                   dict(search={'filterSpeckle': [8, 1.5]}), dict(search={'cornerThreshold': [181]}),
                   dict(search={'lengthThreshold': []}), dict(search={'spliceThreshold': [True]}),
                   dict(trials=True), dict(trials=1), dict(trials=129), dict(seed=1.1),
                   dict(trials=2, topK=3), dict(topK=0), dict(topK=11), dict(minFeatureArea=0),
                   dict(weights={'boundary': -1}), dict(weights={'corners': float('inf')}),
                   dict(weights={'gaps': -1}), dict(weights={'overlaps': float('nan')}),
                   dict(weights={'unknown': 1}), dict(regions=[dict(name='bad', bounds=[0, 0, 129, 96], weight=1)]),
                   dict(regions=[dict(name='fullImage', bounds=[0, 0, 10, 10], weight=1)]),
                   dict(regions=[dict(name='bad', bounds=[0, 0, 10, 10], weight=0)]),
                   dict(reference='relative.png')]
        for index, change in enumerate(changes):
            request = {**self.request(f'invalid-{index}'), **change}
            with self.subTest(change=change), self.assertRaises((ValueError, TypeError)):
                opt.execute(request)
            self.assertFalse(Path(request['out']).exists())
        for key in ('input', 'out', 'palette'):
            request = self.request('missing-' + key)
            del request[key]
            with self.assertRaises(ValueError):
                opt.execute(request)
            self.assertFalse((self.artifacts / ('missing-' + key)).exists())

    def test_optional_reference_validation_and_freezing(self):
        good = self.artifacts / 'labeled.png'
        with self.Image.open(self.source) as im, good.open('xb') as stream:
            im.save(stream, format='PNG')
        prepared = opt.prepare(self.request('good-reference', reference=str(good)), self.deps)
        self.assertEqual(prepared[4].size, (128, 96))
        self.assertFalse((self.artifacts / 'good-reference').exists())
        for index, (mode, size, fill) in enumerate([('RGB', (128, 96), '#123456'),
                                                  ('RGBA', (128, 96), (0, 0, 0, 120)),
                                                  ('RGB', (64, 64), 'black')]):
            path = self.artifacts / f'bad-reference-{index}.png'
            with path.open('xb') as stream:
                self.Image.new(mode, size, fill).save(stream, format='PNG')
            request = self.request(f'bad-reference-out-{index}', reference=str(path))
            with self.assertRaises(ValueError):
                opt.execute(request)
            self.assertFalse(Path(request['out']).exists())

    def test_rgba_reference_ignores_all_base_preprocessing(self):
        source = self.artifacts / 'rgba-source.png'
        image = self.Image.new('RGBA', (16, 16), (0, 0, 0, 0))
        image.putpixel((8, 8), (0, 0, 0, 255))
        with source.open('xb') as stream:
            image.save(stream, format='PNG')
        request = {**self.request('rgba-prepare', base=dict(blurSigma=10, medianSize=7, labelModeSize=7,
                                                          filterSpeckle=65535, pathPrecision=3)),
                   'input': str(source)}
        prepared = opt.prepare(request, self.deps)
        labels = prepared[5]
        self.assertEqual(int(labels.sum()), 1)
        self.assertEqual(labels[8, 8], 1)
        self.assertEqual(labels[0, 0], 0, 'Transparent black must composite to white')
        self.assertEqual(prepared[0]['pathPrecision'], 3)
        self.assertFalse(Path(request['out']).exists())

    def test_large_image_smoke(self):
        source = self.artifacts / 'large-source.png'
        with self.Image.open(self.source) as im:
            image = im.resize((1448, 1086), self.Image.Resampling.NEAREST)
        with source.open('xb') as stream:
            image.save(stream, format='PNG')
        request = {**self.request('large-smoke', trials=2, topK=1, search={'blurSigma': [0, 1]}),
                   'input': str(source)}
        started = time.perf_counter()
        report = opt.execute(request)['result']
        print(f'1448x1086, two real candidates plus fixed metrics/artifacts: {time.perf_counter()-started:.3f}s')
        self.assertEqual(report['weights']['gaps'], 100)
        self.assertEqual(report['weights']['overlaps'], 100)
        self.assertEqual(report['evaluated'], 2)
        self.assertIsNotNone(report['best'])
        self.assertTrue(all('error' not in c for c in report['candidates']))

    def test_partial_candidate_error_continues_and_all_fail_status(self):
        original = opt.trace.execute
        count = 0
        def sometimes(request):
            nonlocal count
            count += 1
            if count == 1:
                out = Path(request['out'])
                out.mkdir()
                with (out / 'partial.txt').open('x') as stream:
                    stream.write('retained')
                raise RuntimeError('injected partial failure')
            return original(request)
        with patch.object(opt.trace, 'execute', side_effect=sometimes):
            report = opt.execute(self.request('partial', trials=3, topK=2,
                                             search={'cornerThreshold': [35, 90]}))['result']
        self.assertEqual(report['evaluated'], 3)
        self.assertEqual(report['candidates'][0]['error']['type'], 'RuntimeError')
        self.assertEqual((Path(report['candidates'][0]['out']) / 'partial.txt').read_text(), 'retained')
        self.assertIsNotNone(report['best'])
        with patch.object(opt.trace, 'execute', side_effect=RuntimeError('all fail')):
            result = opt.execute(self.request('all-errors', trials=2, topK=1, search={'blurSigma': [0, 1]}))
        self.assertTrue(result['success'])
        self.assertEqual(result['result']['status'], 'no_eligible_candidate')
        self.assertIsNone(result['result']['best'])
        self.assertIsNone(json.loads(Path(result['result']['files']['bestSettings']).read_text()))

    def test_worker_protocol_and_topology_ineligible_completion(self):
        solid = self.artifacts / 'solid.png'
        from PIL import ImageDraw
        image = self.Image.new('RGB', (128, 96), 'white')
        ImageDraw.Draw(image).rectangle((15, 15, 110, 80), fill='black')
        with solid.open('xb') as stream:
            image.save(stream, format='PNG')
        request = self.request('protocol', trials=2, topK=1, reference=str(self.source), search={'blurSigma': [0, 1]},
                               regions=[dict(name='logo', bounds=[0, 0, 128, 96], weight=1)])
        request['input'] = str(solid)
        completed = subprocess.run([sys.executable, '-B', str(ROOT / 'assets/image_optimize.py')],
                                   input=json.dumps(request), text=True, capture_output=True, cwd=ROOT)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        result = json.loads(completed.stdout)
        self.assertEqual(result['operation'], 'image.optimize')
        self.assertTrue(result['success'])
        self.assertIsNone(result['result']['best'])
        self.assertEqual(result['result']['status'], 'no_eligible_candidate')
        self.assertEqual(set(result['result']), {'status', 'best', 'evaluatedTrials', 'eligibleCount',
                                               'regions', 'files', 'geometryValidated',
                                               'baselineBoundaryMetrics', 'bestBoundaryMetrics'})
        self.assertEqual(result['result']['evaluatedTrials'], 2)
        self.assertEqual(result['result']['eligibleCount'], 0)
        self.assertIsNone(result['result']['bestBoundaryMetrics'])
        self.assertIn('fullImage', result['result']['baselineBoundaryMetrics'])
        self.assertEqual(result['result']['regions'], [dict(name='logo', best=None)])
        full_report = json.loads(Path(result['result']['files']['report']).read_text())
        self.assertTrue(all(c['failures'] and 'error' not in c for c in full_report['candidates']))
        self.assertIn('image.optimize: 1/2', completed.stderr)
        invalid = self.request('invalid-protocol', search={'medianSize': [2]})
        completed = subprocess.run([sys.executable, '-B', str(ROOT / 'assets/image_optimize.py')],
                                   input=json.dumps(invalid), text=True, capture_output=True, cwd=ROOT)
        self.assertNotEqual(completed.returncode, 0)
        self.assertEqual(completed.stdout, '')
        self.assertFalse(Path(invalid['out']).exists())


class SearchGridContractTests(unittest.TestCase):
    def test_outside_grid_baseline_does_not_seed_outside_grid_refinements(self):
        base = dict(traceScale=1, lengthThreshold=4)
        axes = dict(traceScale=[2], lengthThreshold=[1, 2])
        search = opt.Search(base, axes, 17, 4)
        baseline, selection = search.next(None)
        self.assertEqual(baseline, base)
        self.assertEqual(selection['stage'], 'baseline')
        best = dict(id='baseline', parameters=baseline)
        first, _ = search.next(best)
        second, _ = search.next(best)
        self.assertEqual({tuple(p[k] for k in ('traceScale', 'lengthThreshold')) for p in (first, second)},
                         {(2, 1), (2, 2)})
        self.assertIsNone(search.next(best), 'Only the baseline and two declared grid points exist')

    def test_singleton_axis_does_not_hide_real_maximin_distance_in_float_roundoff(self):
        search = opt.Search(dict(traceScale=1, lengthThreshold=4),
                            dict(traceScale=[2], lengthThreshold=[1, 2]), 17, 4)
        baseline, _ = search.next(None)
        candidate, _ = search.next(dict(id='baseline', parameters=baseline))
        self.assertEqual(candidate, dict(traceScale=2, lengthThreshold=1),
                         'Length 1 is farther than length 2; a constant axis contributes no diversity')


if __name__ == '__main__':
    unittest.main()

"""Bounded source-scale tracing regressions; only test-owned temporary files."""
import importlib.util
import inspect
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

try:
    import numpy as np
    from PIL import Image, ImageDraw
    _HAVE_RASTER = True
except ImportError:
    _HAVE_RASTER = False

ROOT = Path(__file__).resolve().parents[1]
def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'assets' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
trace = load('image_trace')
optimize = load('image_optimize')


@unittest.skipUnless(_HAVE_RASTER, 'trace-scale tests require numpy and Pillow; use .venv/bin/python')
class TraceScaleTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='trace-scale-')
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        image = Image.new('RGB', (48, 40), 'white')
        draw = ImageDraw.Draw(image)
        draw.rectangle((4, 4, 43, 35), fill='#111111')
        draw.rectangle((12, 12, 35, 27), fill='#EE3322')
        self.source = self.folder / 'source.png'
        image.save(self.source)
        self.palette = self.folder / 'palette.json'
        trace.write_json(self.palette, dict(background='#FFFFFF', colors=[
            dict(name='dark', color='#111111'), dict(name='red', color='#EE3322')], rules=[
            dict(color='dark', ranges=dict(luma=[0, 40])),
            dict(color='red', ranges=dict(r=[200, 255], g=[0, 100]))]))

    def request(self, name, **kwargs):
        return dict(input=str(self.source), palette=str(self.palette), out=str(self.folder/name), **kwargs)

    def test_default_scale_is_byte_identical_to_explicit_one(self):
        first = trace.execute(self.request('default'))['result']
        second = trace.execute(self.request('one', traceScale=1))['result']
        for name in ('segmented', 'rawContours', 'contours', 'preview'):
            self.assertEqual(Path(first['files'][name]).read_bytes(), Path(second['files'][name]).read_bytes())
        self.assertEqual(first['foregroundBbox'], second['foregroundBbox'])

    def test_similarity_preserves_relative_subpaths_cubic_controls_and_mm(self):
        root = ET.fromstring('<svg width="96" height="80"><path fill="#111111" '
            'transform="translate(8,1e1)" d="M 0 0 C 2 4 6 8 10 0 Z m 20 0 l 4 0 l 0 4 Z"/></svg>')
        old = trace.parse_path(root[0].get('d'), root[0].get('transform'))
        trace.normalize_trace_coordinates(root, 2, (48, 40))
        new = trace.parse_path(root[0].get('d'), root[0].get('transform'))
        self.assertEqual(new, [(kind, [(x/2, y/2) for x, y in points]) for kind, points in old])
        self.assertEqual(trace.geometry_for(old, [0, 0, 96, 80], 50),
                         trace.geometry_for(new, [0, 0, 48, 40], 50))
        self.assertEqual(root.get('viewBox'), '0 0 48 40')
        precise = ET.fromstring('<svg><path d="M 0 0 C 2.1234567890123456 0 4 0 6 0 Z"/></svg>')
        before = trace.parse_path(precise[0].get('d'))
        trace.normalize_trace_coordinates(precise, 2, (48, 40))
        self.assertEqual(trace.parse_path(precise[0].get('d')),
                         [(kind, [(x/2, y/2) for x, y in points]) for kind, points in before])

    def test_nearest_labels_working_units_and_original_artifacts(self):
        source_before = self.source.read_bytes()
        palette_before = self.palette.read_bytes()
        import vtracer
        converter = vtracer.convert_raw_image_to_svg
        def check(data, **kwargs):
            with Image.open(io.BytesIO(data)) as image:
                enlarged = np.asarray(image.convert('RGB'))
            with Image.open(self.source) as image:
                source = np.asarray(image.convert('RGB'))
            np.testing.assert_array_equal(enlarged, source.repeat(2, axis=0).repeat(2, axis=1))
            self.assertEqual(kwargs['length_threshold'], 8)
            self.assertEqual(kwargs['filter_speckle'], 8)
            return converter(data, **kwargs)
        with patch.object(vtracer, 'convert_raw_image_to_svg', side_effect=check) as called:
            report = trace.execute(self.request('two', traceScale=2, filterSpeckle=8))['result']
        called.assert_called_once()
        self.assertEqual(report['foregroundBbox'], [4, 4, 44, 36])
        self.assertEqual(report['scaleMmPerPixel'], 1.25)
        self.assertEqual(report['traceSampling']['workingSize'], [96, 80])
        with Image.open(report['files']['segmented']) as segmented:
            self.assertEqual(segmented.size, (48, 40))
        with Image.open(report['files']['preview']) as preview:
            self.assertEqual(preview.size, (48, 40))
        self.assertEqual(self.source.read_bytes(), source_before)
        self.assertEqual(self.palette.read_bytes(), palette_before)

    def test_no_palette_still_normalizes_contours(self):
        request = self.request('no-palette', traceScale=2)
        request.pop('palette')
        report = trace.execute(request)['result']
        root = ET.parse(report['files']['contours']).getroot()
        self.assertEqual(root.get('viewBox'), '0 0 48 40')
        with Image.open(report['files']['preview']) as image:
            self.assertEqual(image.size, (48, 40))

    def test_invalid_scales_and_budget_fail_before_output(self):
        for scale in (0, 3, 1.5, True, '2'):
            with self.subTest(scale=scale), self.assertRaisesRegex(ValueError, 'traceScale'):
                trace.validate(self.request('invalid', traceScale=scale))
        class Oversized:
            width = height = 3000
        with patch.object(trace, 'segment_image', return_value=Oversized()):
            with self.assertRaisesRegex(ValueError, '30 million'):
                trace.execute(self.request('oversized', traceScale=2))
        self.assertFalse((self.folder/'oversized').exists())

    def test_optimizer_search_and_replay_retain_source_scale(self):
        report = optimize.execute(self.request('optimize', trials=2, topK=2, search={'traceScale': [2]}))['result']
        candidates = report['candidates']
        self.assertEqual([c['parameters']['traceScale'] for c in candidates], [1, 2])
        self.assertEqual(candidates[1]['selection']['choices'], {'traceScale': 2})
        self.assertFalse(any(c.get('error') for c in candidates))
        for candidate in candidates:
            replay = trace.execute(dict(candidate['parameters'], input=report['frozenInput'],
                palette=report['frozenPalette'], out=str(self.folder/('replay-' + candidate['id']))))['result']
            self.assertEqual(Path(replay['files']['contours']).read_bytes(),
                             (Path(candidate['out'])/'contours.svg').read_bytes())
        settings = json.loads(Path(report['files']['bestSettings']).read_text())
        self.assertIn('traceScale', settings)


if __name__ == '__main__':
    unittest.main(verbosity=2)

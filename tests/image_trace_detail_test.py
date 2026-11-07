"""Small, source-owned bundle fixtures; no model session or retained-user edits."""
from collections import Counter
import copy
import importlib.util
import inspect
import json
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

try:
    from PIL import Image, ImageDraw
    import numpy  # noqa: F401
    import shapely  # noqa: F401
    _HAVE_RASTER = True
except ImportError:
    _HAVE_RASTER = False

ROOT = Path(__file__).resolve().parents[1]
def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT/'assets'/(name+'.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
trace = load('image_trace')
detail = load('image_trace_detail') if _HAVE_RASTER else None
optimize = load('image_optimize')
PALETTE = dict(background='#FFFFFF', colors=[dict(name=n, color=c) for n,c in
    [('parent','#111111'),('red','#BB3322'),('pink','#EEAABB')]], rules=[])


def rect(l,t,r,b,hole=False):
    points = [(l,t),(r,t),(r,b),(l,b)]
    if hole:
        points = points[::-1]
    return 'M '+' L '.join(f'{x:g} {y:g}' for x,y in points)+' Z'


def svg(paths):
    root = ET.Element('svg', width='80', height='80')
    for fill, data in paths:
        ET.SubElement(root,'path',fill=fill,d=data)
    return root


def fixture():
    outer, other = rect(0,0,80,80), rect(40,40,60,60,True)
    base = svg([('#111111',outer+' '+rect(10,10,20,20,True)+' '+other),
        ('#BB3322',rect(10,10,15,20)),('#EEAABB',rect(15,10,20,20))])
    high = svg([('#111111',outer+' '+rect(9.75,9.75,20.25,20.25,True)+' '+other),
        ('#BB3322',rect(9.75,9.75,15,20.25)),('#EEAABB',rect(15,9.75,18,20.25)),
        ('#BB3322',rect(18,9.75,19,20.25)),('#EEAABB',rect(19,9.75,20.25,20.25))])
    return base, high


def signatures(root):
    return Counter((p.get('fill'),tuple((kind,tuple(map(tuple,points))) for kind,points in
        trace.parse_path(data,p.get('transform','')))) for p in root
        for data in re.split(r'(?=[Mm])',p.get('d','')) if data.strip())


@unittest.skipUnless(_HAVE_RASTER, 'trace-detail tests require Pillow, numpy and Shapely; use .venv/bin/python')
class BundleTest(unittest.TestCase):
    def apply(self, base, high, area=150):
        before = [ET.tostring(r) for r in (base,high)]
        try:
            return detail.replace_bundles(base,high,PALETTE,area,trace.parse_path)
        finally:
            self.assertEqual(before,[ET.tostring(r) for r in (base,high)])

    def test_dot_bundle_exact_outside_holes_and_source_controls(self):
        base, high = fixture()
        result,audit = self.apply(base,high)
        self.assertEqual(len(result),len(base))
        self.assertEqual(audit['rootPathsAppended'],0)
        self.assertEqual(audit['intactBaselineSubpaths'],2)
        self.assertEqual(audit['ss2RingsImported'],5)
        self.assertEqual(audit['ss2SerializationMaxControlErrorPx'],0)
        self.assertEqual(audit['bundles'][0]['cutoutSymmetricDifferencePx2'],0)
        self.assertEqual(audit['bundles'][0]['childOverlapPx2'],0)
        self.assertIn(rect(0,0,80,80),result[0].get('d'))
        self.assertIn(rect(40,40,60,60,True),result[0].get('d'))
        kept = signatures(result)&signatures(base)
        self.assertEqual(sum(kept.values()),2)
        self.assertFalse((signatures(result)-signatures(base))-signatures(high))
        self.assertEqual(sum(signatures(result).values()),7)

    def test_inner_cutout_with_unselected_ancestor_is_supported(self):
        base = svg([('#111111',rect(0,0,80,80)+' '+rect(10,10,30,30,True)),
            ('#BB3322',rect(10,10,30,30)+' '+rect(15,15,25,25,True)),
            ('#EEAABB',rect(15,15,25,25))])
        result,audit = self.apply(base,copy.deepcopy(base))
        self.assertEqual(result[0].attrib,base[0].attrib)
        self.assertEqual(len(audit['bundles']),1)
        self.assertEqual(signatures(result),signatures(base))
        with self.assertRaisesRegex(ValueError,'nested or touching selected cutouts'):
            self.apply(base,copy.deepcopy(base),500)

    def test_gap_or_overlapping_child_is_refused(self):
        for width in (14.9,15.1):
            base,high = fixture()
            high[1].set('d',rect(9.75,9.75,width,20.25))
            with self.subTest(width=width),self.assertRaisesRegex(ValueError,'adjacency mismatch'):
                self.apply(base,high)

    def test_unknown_color_and_changed_local_material_are_refused(self):
        base,high = fixture()
        high[2].set('fill','#00FF00')
        with self.assertRaisesRegex(ValueError,'unknown source color'):
            self.apply(base,high)
        base,high = fixture()
        for p in high:
            if p.get('fill')=='#EEAABB':
                p.set('fill','#111111')
        with self.assertRaisesRegex(ValueError,'local material set changed'):
            self.apply(base,high)

    def test_unknown_painter_overlay_is_not_mistaken_for_partition(self):
        for side in ('baseline','high'):
            base,high = fixture()
            ET.SubElement(base if side=='baseline' else high,'path',fill='#EEAABB',d=rect(5,5,30,30))
            with self.subTest(side=side),self.assertRaisesRegex(ValueError,'unrelated .*paint intersects'):
                self.apply(base,high)

    def test_mixed_inside_outside_child_path_is_refused(self):
        base,high = fixture()
        base[1].set('d',base[1].get('d')+' '+rect(65,65,70,70))
        with self.assertRaisesRegex(ValueError,'child path crosses bundle boundary'):
            self.apply(base,high)

    def test_unmatched_cutout_and_invalid_hole_ownership_refuse(self):
        base,high = fixture()
        high[0].set('d',rect(0,0,80,80)+' '+rect(40,40,60,60,True))
        with self.assertRaisesRegex(ValueError,'unmatched small source cutouts'):
            self.apply(base,high)
        base,high = fixture()
        high[0].set('d',rect(0,0,18,80)+' '+rect(9.75,9.75,20.25,20.25,True)+' '+rect(40,40,60,60,True))
        with self.assertRaisesRegex(ValueError,'hole ownership'):
            self.apply(base,high)

    def test_open_relative_and_budget_failures_are_explicit(self):
        for data in ('M 10 10 L20 10 L20 20', 'm 10 10 l10 0 l0 10 z'):
            base,high = fixture()
            high[1].set('d',data)
            with self.assertRaisesRegex(ValueError,'absolute, closed'):
                self.apply(base,high)
        with patch.object(detail,'MAX_RINGS',1),self.assertRaisesRegex(ValueError,'complexity budget'):
            self.apply(*fixture())

    def test_no_small_cutouts_is_explicit_noop(self):
        base,high = fixture()
        result,audit = self.apply(base,high,1)
        self.assertEqual(ET.tostring(base),ET.tostring(result))
        self.assertEqual(audit['status'],'not_needed')
        self.assertEqual(audit['bundles'],[])


@unittest.skipUnless(_HAVE_RASTER, 'trace-detail tests require Pillow, numpy and Shapely; use .venv/bin/python')
class IntegrationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='trace-detail-')
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        image = Image.new('RGB',(80,80),'white')
        draw = ImageDraw.Draw(image)
        draw.rectangle((5,5,74,74),fill='#111111')
        draw.rectangle((20,20,39,39),fill='#BB3322')
        self.source = self.folder/'source.png'
        image.save(self.source)
        self.palette = self.folder/'palette.json'
        palette = dict(background='#FFFFFF',colors=PALETTE['colors'][:2],rules=[
            dict(color='parent',ranges={'luma':[0,40]}),dict(color='red',ranges={'r':[150,220],'g':[0,100]})])
        trace.write_json(self.palette,palette)

    def request(self,name,**kwargs):
        return dict(input=str(self.source),palette=str(self.palette),out=str(self.folder/name),**kwargs)

    def test_zero_is_byte_identical_and_does_not_import_detail_dependencies(self):
        plain = trace.execute(self.request('plain'))['result']
        with patch.object(trace.importlib.util,'spec_from_file_location',side_effect=AssertionError('opt-in module imported')):
            disabled = trace.execute(self.request('zero',traceDetailAreaPx2=0))['result']
        for name in ('segmented','rawContours','contours','preview'):
            self.assertEqual(Path(plain['files'][name]).read_bytes(),Path(disabled['files'][name]).read_bytes())
        self.assertNotIn('traceDetailAudit',plain)

    def test_schema_rejects_invalid_or_incompatible_settings(self):
        for value in (-1,True,'1024',float('nan'),float('inf')):
            with self.subTest(value=value),self.assertRaisesRegex(ValueError,'traceDetailAreaPx2'):
                trace.validate(self.request('bad',traceDetailAreaPx2=value))
        for changes in ({'traceScale':2},{'mode':'polygon'}):
            with self.assertRaisesRegex(ValueError,'requires a palette, traceScale=1'):
                trace.validate(self.request('bad',traceDetailAreaPx2=512,**changes))
        req = self.request('bad',traceDetailAreaPx2=512)
        del req['palette']
        with self.assertRaisesRegex(ValueError,'requires a palette'):
            trace.validate(req)

    def test_optimizer_parameter_audit_and_exact_replay(self):
        report = optimize.execute(self.request('optimize',trials=2,topK=2,
            search={'traceDetailAreaPx2':[512]}))['result']
        a,b = report['candidates']
        self.assertEqual([c['parameters']['traceDetailAreaPx2'] for c in (a,b)],[0,512])
        self.assertNotIn('traceDetailAudit',a)
        self.assertEqual(b['traceDetailAudit']['status'],'applied')
        self.assertEqual(b['traceDetailAudit']['rootPathsAppended'],0)
        replay = trace.execute(dict(b['parameters'],input=report['frozenInput'],palette=report['frozenPalette'],
            out=str(self.folder/'replay')))['result']
        self.assertEqual(Path(replay['files']['contours']).read_bytes(),(Path(b['out'])/'contours.svg').read_bytes())
        self.assertEqual(replay['traceDetailAudit'],b['traceDetailAudit'])
        self.assertIn('traceDetailAreaPx2',json.loads(Path(report['files']['bestSettings']).read_text()))

    def test_bundle_error_refuses_candidate_instead_of_emitting_baseline(self):
        original = optimize.trace.importlib.util.spec_from_file_location
        def injected(name,path,*args,**kwargs):
            spec = original(name,path,*args,**kwargs)
            if str(path).endswith('image_trace_detail.py'):
                execute = spec.loader.exec_module
                def load_failure(module):
                    execute(module)
                    def refused(*args,**kwargs):
                        raise ValueError('Trace detail bundles: ambiguous parent cutout correspondence')
                    module.replace_bundles = refused
                spec.loader.exec_module = load_failure
            return spec
        with patch.object(optimize.trace.importlib.util,'spec_from_file_location',side_effect=injected):
            report = optimize.execute(self.request('refused',trials=2,topK=2,
                search={'traceDetailAreaPx2':[512]}))['result']
        bad = report['candidates'][1]
        self.assertFalse(bad['eligible'])
        self.assertIn('ambiguous',bad['error']['message'])
        self.assertFalse((Path(bad['out'])/'contours.svg').exists())


if __name__=='__main__':
    unittest.main(verbosity=2)

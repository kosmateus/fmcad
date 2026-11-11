"""Independent oracle checks for GM35 artifacts. Stdlib only; drives the real
node modules through a subprocess and parses the exported files directly."""
import hashlib
import json
import shutil
from pathlib import Path
import subprocess
import tempfile
import unittest
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which('node')

DRIVER = """
const fs = require('fs');
const d = require('./src/drawing-package');
const c = require('./src/drawing-check');
const e = require('./src/drawing-export');
const request = JSON.parse(process.argv[1]);
const report = d.execute('drawing.package', request);
const check = c.execute('drawing.check', { schemaVersion: 1, package: report.reportPath, out: request.checkOut });
const exported = e.execute('drawing.export', { schemaVersion: 1, package: report.reportPath, formats: ['svg', 'pdf', 'dxf'], out: request.exportOut });
process.stdout.write(JSON.stringify({ status: report.status, check: check.status, export: exported.status,
  reportPath: report.reportPath, files: exported.result.files }));
"""


def sha256(data):
    return hashlib.sha256(data).hexdigest()


@unittest.skipIf(NODE is None, 'node executable required for the GM35 oracle')
class DrawingOracleTest(unittest.TestCase):
    def setUp(self):
        parent = ROOT / '.test-artifacts'
        parent.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix='drawing-oracle-', dir=parent)
        self.root = Path(self.temp.name)
        self.request = {
            'schemaVersion': 1,
            'documentIdentity': {'name': 'Seal Subassembly', 'revision': 'A'},
            'sheet': {'format': 'A3', 'titleBlock': {'drawingNumber': 'CW-100', 'scale': '1:1'}},
            'views': [{'id': 'front', 'kind': 'projection', 'orientation': 'front', 'scale': 1, 'origin': [40, 40],
                       'geometry': [
                           {'id': 'plate', 'kind': 'polyline', 'points': [[0, 0], [60, 0], [60, 40], [0, 40]], 'closed': True},
                           {'id': 'bore', 'kind': 'circle', 'center': [30, 20], 'r': 5},
                           {'id': 'shaft', 'kind': 'circle', 'center': [30, 20], 'r': 3}]}],
            'dimensions': [
                {'id': 'width', 'view': 'front', 'kind': 'linear', 'a': [0, 0], 'b': [60, 0], 'offset': -10,
                 'value': '60 mm', 'tolerance': {'upper': '0.1 mm', 'lower': '-0.1 mm'},
                 'source': {'path': 'specs/seal.json', 'status': 'CONFIRMED'}},
                {'id': 'bore-dia', 'view': 'front', 'kind': 'diameter', 'circle': 'bore', 'value': '10 mm',
                 'source': {'path': 'specs/seal.json', 'status': 'CONFIRMED'}}],
            'items': [{'item': 1, 'partId': 'P020', 'description': 'Housing', 'qty': 1,
                       'source': {'path': 'BOM.csv', 'status': 'CONFIRMED'}}],
            'balloons': [{'id': 'b1', 'view': 'front', 'item': 1, 'at': [70, 55],
                          'anchor': {'entity': 'plate', 'role': 'vertex', 'index': 2}}],
            'fits': [{'id': 'seal-fit', 'view': 'front', 'shaft': 'shaft', 'bore': 'bore',
                      'clearance': {'min': '1.9 mm', 'max': '2.1 mm', 'source': {'path': 'tolerance-strategy.md', 'status': 'CONFIRMED'}}}],
            'out': str(self.root / 'package'), 'checkOut': str(self.root / 'check'), 'exportOut': str(self.root / 'export'),
        }

    def tearDown(self):
        self.temp.cleanup()

    def run_driver(self):
        result = subprocess.run([NODE, '-e', DRIVER, json.dumps(self.request)], cwd=ROOT,
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return json.loads(result.stdout)

    def test_pipeline_status_and_manifest(self):
        output = self.run_driver()
        self.assertEqual(output['status'], 'pass')
        self.assertEqual(output['check'], 'pass')
        self.assertEqual(output['export'], 'pass')
        files = {row['format']: row for row in output['files']}
        self.assertEqual(set(files), {'svg', 'pdf', 'dxf'})
        for row in output['files']:
            content = Path(row['path']).read_bytes()
            self.assertEqual(sha256(content), row['sha256'])
            self.assertEqual(len(content), row['sizeBytes'])

    def test_dxf_entities_match_declared_geometry(self):
        output = self.run_driver()
        content = Path(output['files'][2]['path']).read_bytes().decode('ascii')
        lines = content.split('\r\n')
        self.assertIn('ENTITIES', lines)
        self.assertEqual(lines[-2], 'EOF')
        records = {}
        for kind in ('LINE', 'CIRCLE', 'ARC', 'POLYLINE', 'SOLID', 'TEXT'):
            records[kind] = lines.count(kind)
        self.assertGreater(records['LINE'], 0)
        self.assertEqual(records['CIRCLE'], 3)  # bore, shaft, balloon
        self.assertGreater(records['TEXT'], 0)
        # Bore circle: center [30,20]+origin[40,40] => [70,60], r 5; codes follow 0/8.
        index = lines.index('CIRCLE')
        groups = lines[index + 1:index + 9]
        self.assertEqual(groups[0], '8')  # layer
        self.assertEqual(groups[1], '0')
        self.assertEqual(groups[2], '10')
        self.assertEqual(float(groups[3]), 70)
        self.assertEqual(groups[4], '20')
        self.assertEqual(float(groups[5]), 60)
        self.assertEqual(groups[6], '40')
        self.assertEqual(float(groups[7]), 5)
        self.assertIn('DIA 10', lines)
        self.assertIn('60 +0.1/-0.1', lines)
        self.assertIn('Seal Subassembly', lines)

    def test_svg_has_semantic_metadata_and_geometry(self):
        output = self.run_driver()
        svg = ET.parse(output['files'][0]['path']).getroot()
        self.assertEqual(svg.tag, '{http://www.w3.org/2000/svg}svg')
        metadata = svg.find('{http://www.w3.org/2000/svg}metadata')
        self.assertEqual(metadata.get('id'), 'fmcad-source-map')
        source_map = json.loads(metadata.text)
        self.assertEqual(source_map['sourceMap']['dimensions']['width']['status'], 'CONFIRMED')
        self.assertEqual(source_map['items'][0]['partId'], 'P020')
        texts = [node.text for node in svg.iter('{http://www.w3.org/2000/svg}text')]
        self.assertIn('60 +0.1/-0.1', texts)
        self.assertIn('1', texts)  # balloon number
        paths = list(svg.iter('{http://www.w3.org/2000/svg}path'))
        self.assertGreaterEqual(len(paths), 4)

    def test_pdf_is_structurally_valid_and_dimensioned(self):
        output = self.run_driver()
        content = Path(output['files'][1]['path']).read_bytes().decode('latin1')
        self.assertTrue(content.startswith('%PDF-1.4\n'))
        self.assertTrue(content.rstrip().endswith('%%EOF'))
        self.assertIn('/MediaBox [0 0 1190.55 841.89]', content)
        self.assertIn('(60 +0.1/-0.1) Tj', content)
        self.assertIn('(DIA 10) Tj', content)
        startxref = int(content[content.rindex('startxref') + len('startxref'):].split()[0])
        self.assertTrue(content.startswith('xref', startxref))

    def test_open_source_blocks_package_and_export(self):
        self.request['dimensions'][0]['source']['status'] = 'OPEN'
        del self.request['dimensions'][0]['tolerance']
        output = self.run_driver()
        self.assertEqual(output['status'], 'blocked')
        self.assertEqual(output['export'], 'blocked')


if __name__ == '__main__':
    unittest.main()

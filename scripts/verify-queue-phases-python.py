#!/usr/bin/env python3
"""Run existing SDK-stub regressions against an isolated runtime, without Fusion."""
import argparse
import hashlib
import io
import json
import pathlib
import subprocess
import sys
import types
import unittest

parser = argparse.ArgumentParser()
parser.add_argument('--runtime', required=True, type=pathlib.Path)
parser.add_argument('--out', required=True, type=pathlib.Path)
args = parser.parse_args()
root = pathlib.Path(__file__).resolve().parents[1]
runtime = args.runtime.resolve()
files = ['queue_document_test.py', 'document_save_test.py',
         'document_save_publication_test.py', 'review_test.py', 'document_identity_test.py']


def build_hash():
    result = subprocess.run(['node', '-e', 'console.log(require(process.argv[1]).buildHash(process.argv[2]))',
                             str(root / 'src/queue-instance.js'), str(runtime)],
                            check=True, capture_output=True, text=True)
    return result.stdout.strip()


before = build_hash()
suite = unittest.TestSuite()
sources = []
for filename in files:
    source = root / 'tests' / filename
    module = types.ModuleType('_isolated_' + source.stem)
    # Fixtures derive their asset root from __file__; execute the original test
    # source with that root redirected to the candidate, not the installed SDK.
    module.__file__ = str(runtime / 'tests' / filename)
    sys.modules[module.__name__] = module
    contents = source.read_bytes()
    exec(compile(contents, str(source), 'exec'), module.__dict__)
    suite.addTests(unittest.defaultTestLoader.loadTestsFromModule(module))
    sources.append({'path': str(source), 'sha256': hashlib.sha256(contents).hexdigest()})
stream = io.StringIO()
result = unittest.TextTestRunner(stream=stream, verbosity=2).run(suite)
after = build_hash()
report = {'runtime': str(runtime), 'installedRuntimeTested': runtime == root,
          'tests': result.testsRun, 'failures': len(result.failures), 'errors': len(result.errors),
          'skipped': len(result.skipped), 'verified': result.wasSuccessful() and before == after,
          'beforeBuildHash': before, 'afterBuildHash': after, 'testSources': sources,
          'validationScope': 'Existing Python SDK stubs; candidate assets, no live Fusion or network.',
          'fusionCalls': 0, 'log': stream.getvalue()}
with args.out.open('x', encoding='utf-8') as output:
    json.dump(report, output, indent=2)
print(json.dumps({key: value for key, value in report.items() if key not in ('log', 'testSources')}, indent=2))
sys.exit(0 if report['verified'] else 1)

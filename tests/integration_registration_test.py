"""Protect CI registration against false-green discovery and compile-only paths."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    'integration_coverage', Path(__file__).resolve().parents[1] / 'scripts/integration/coverage.py'
)
coverage = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(coverage)


class RegistrationTests(unittest.TestCase):
    def test_compilation_and_echo_do_not_count_as_execution(self):
        tests = ['tests/a.test.ts', 'tests/b.test.js']
        self.assertEqual(coverage.selected('tsc tests/a.test.ts && echo tests/b.test.js', tests, set(tests)), set())
        self.assertEqual(coverage.selected('node --test tests/b.test.js && echo tests/a.test.ts', tests, set(tests)), {'tests/b.test.js'})

    def test_name_filtered_execution_is_not_full_file_registration(self):
        tests = ['tests/a.test.js']
        self.assertEqual(coverage.selected('node --test --test-name-pattern selected tests/a.test.js', tests, set(tests)), set())

    def test_compiled_tests_map_to_sources_and_globs_do_not_recurse(self):
        tests = ['tests/a.test.ts', 'tests/nested/b.test.ts', 'tests/c.test.mts']
        self.assertEqual(coverage.selected('node --test dist/tests/*.test.js dist/tests/*.test.mjs', tests, set(tests)), {'tests/a.test.ts', 'tests/c.test.mts'})

    def test_python_discovery_requires_importable_subdirectories(self):
        tests = ['tests/a_test.py', 'tests/native/b_test.py', 'tests/types/c_test.py']
        files = set(tests + ['tests/types/__init__.py'])
        self.assertEqual(coverage.selected("python3 -B -m unittest discover -s tests -p '*_test.py'", tests, files), {'tests/a_test.py', 'tests/types/c_test.py'})

    def test_npm_expansion_includes_nested_and_lifecycle_scripts(self):
        scripts = {'test:one': 'npm run test:two', 'pretest:two': 'before', 'test:two': 'node --test tests/a.test.js', 'posttest:two': 'after'}
        expanded = list(coverage.expand('npm run test:one', scripts))
        self.assertIn('node --test tests/a.test.js', expanded)
        self.assertIn('before', expanded)
        self.assertIn('after', expanded)
        with self.assertRaises(ValueError):
            list(coverage.expand('npm run unknown', scripts))
        with self.assertRaises(ValueError):
            list(coverage.expand('npm run loop', {'loop': 'npm run loop'}))

    def test_workflow_commands_ignore_comments_and_parse_blocks(self):
        workflow = '''jobs:
  audit:
    steps:
      # - run: npm run imaginary
      - name: tests/a.test.js
        run: |
          npm run first
          npm run second
      - run: "node --test tests/b.test.js"
'''
        self.assertEqual(coverage.workflow_commands(workflow), ['npm run first\nnpm run second', 'node --test tests/b.test.js'])

    def test_wrapper_and_unreachable_script(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            content = {
                'package.json': json.dumps({'scripts': {'test:ci': 'node --test tests/a.test.js', 'test:unused': 'node --test tests/orphan.test.js'}}),
                '.github/workflows/ci.yml': 'jobs:\n  test:\n    steps:\n      - run: npm run test:ci\n',
                'tests/a.test.js': "require('../dist/tests/a.test.js');",
                'tests/a.test.ts': "// require('../tests/orphan.test.js');\nconst snippet = \"require('../tests/orphan.test.js');\";",
                'tests/orphan.test.js': '',
            }
            for path, text in content.items():
                (root / path).parent.mkdir(parents=True, exist_ok=True)
                (root / path).write_text(text)
            report = coverage.audit(root, list(content))
            self.assertEqual(report['gaps'], ['tests/orphan.test.js'])

    def test_new_orphan_and_removed_sources_fail_but_closed_gaps_are_allowed(self):
        baseline = {'gaps': {'tests/old.test.js': {'owner': 'G', 'reason': 'Pending registration', 'nextAction': 'Verify isolated execution'}}}
        report = {'gaps': ['tests/new.test.js'], 'tests': [{'path': 'tests/new.test.js'}]}
        self.assertEqual(len(coverage.violations(report, baseline)), 2)
        self.assertEqual(coverage.violations({'gaps': [], 'tests': [{'path': 'tests/old.test.js'}]}, baseline), [])


if __name__ == '__main__':
    unittest.main()

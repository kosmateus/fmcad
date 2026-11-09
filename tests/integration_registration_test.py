"""Protect CI registration against false-green discovery and compile-only paths."""
import importlib.util
import copy
import json
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    'integration_coverage', Path(__file__).resolve().parents[1] / 'scripts/integration/coverage.py'
)
coverage = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(coverage)

NATIVE_SPEC = importlib.util.spec_from_file_location(
    'integration_native_plan', Path(__file__).resolve().parents[1] / 'scripts/integration/native-plan.py'
)
native_plan = importlib.util.module_from_spec(NATIVE_SPEC)
NATIVE_SPEC.loader.exec_module(native_plan)


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

    def test_npm_script_arguments_do_not_execute_additional_suites(self):
        scripts = {
            'test:first': 'node --test tests/first.test.js',
            'test:second': 'node --test tests/second.test.js',
        }
        sources = ['tests/first.test.js', 'tests/second.test.js']

        def reached(command):
            return set().union(*(coverage.selected(value, sources, set(sources))
                                 for value in coverage.expand(command, scripts)))

        self.assertEqual(reached('npm run test:first test:second'), {sources[0]})
        self.assertEqual(reached('npm run test:first && npm run test:second'), set(sources))

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

    def test_native_obligations_remain_not_run_and_reject_shell_or_waived_cases(self):
        profile = {'required': True, 'qualification': 'pending', 'cases': [{
            'id': 'owned', 'source': 'tests/live-owned.js', 'disposition': 'migration-pending',
            'obligation': 'Owned mutation and cleanup', 'command': 'node tests/live-owned.js --run',
            'prerequisites': 'Exact owned fixture and recovery receipts',
        }]}
        rows = native_plan.native_obligations(profile, {'owned'})
        self.assertEqual(rows[0]['argv'], ['node', 'tests/live-owned.js', '--run'])
        self.assertEqual(rows[0]['status'], 'NOTRUN')
        profile['cases'][0]['command'] = 'node tests/live-owned.js --run && node replay.js'
        with self.assertRaises(ValueError):
            native_plan.native_obligations(profile, {'owned'})

        profile['cases'][0]['command'] = 'node tests/live-owned.js --run'
        profile['cases'][0]['disposition'] = 'passed'
        with self.assertRaises(ValueError):
            native_plan.native_obligations(profile, {'owned'})

    def test_node_paths_after_python_are_not_execution_and_default_script_has_no_such_tail(self):
        source = 'tests/example.test.ts'
        command = "python3 -B -m unittest discover -s tests -p '*_test.py' dist/tests/example.test.js"
        self.assertEqual(coverage.selected(command, [source], {source}), set())
        scripts = json.loads((coverage.ROOT / 'package.json').read_text())['scripts']
        for segment in scripts['test'].split('&&'):
            if segment.strip().startswith(('python ', 'python3 ')):
                self.assertNotIn('.test.js', segment)

    def test_owned_native_handoff_keeps_explicit_run_and_recovery_gate(self):
        profile = {'required': True, 'qualification': 'pending', 'cases': [{
            'id': 'owned', 'source': 'tests/live-owned.js', 'disposition': 'native-only',
            'obligation': 'Retained native assertions with exact ownership',
            'command': 'node dist/tests/scenarios/cli.js --run --project-id PROJECT --folder-id FOLDER',
            'prerequisites': 'Full offline CI and exact installed runtime',
            'runnerStatus': 'owned-handoff-source-ready', 'qualification': 'not-run',
        }]}
        row = native_plan.native_obligations(profile, {'owned'})[0]
        self.assertEqual(row['status'], 'NOTRUN')
        self.assertEqual(row['qualification'], 'not-run')
        self.assertTrue(row['runnableAfterOfflineGate'])
        self.assertIn('deferred cleanup', row['cleanupRecovery'])
        self.assertEqual(row['argv'][-2:], ['--folder-id', 'FOLDER'])
        profile['cases'][0]['command'] += ' --run'
        with self.assertRaises(ValueError):
            native_plan.native_obligations(profile, {'owned'})

    def test_native_fixture_profile_retains_sources_and_restoration_continuation(self):
        profiles = json.loads((coverage.ROOT / 'tests/live-required-profiles.json').read_text())
        profile = profiles['profiles']['native-fixtures']
        rows = native_plan.native_fixture_obligations(profile)
        self.assertEqual({row['id'] for row in rows}, {'native-integration', 'iw74-parameter-test'})
        self.assertTrue(all(row['status'] == 'NOTRUN' for row in rows))
        changed = copy.deepcopy(profile)
        changed['cases'][0]['sourceSha256'] = '0' * 64
        with self.assertRaises(ValueError):
            native_plan.native_fixture_obligations(changed)
        changed = copy.deepcopy(profile)
        parameter = next(row for row in changed['cases'] if row['id'] == 'iw74-parameter-test')
        parameter.pop('continuationSource')
        with self.assertRaises(ValueError):
            native_plan.native_fixture_obligations(changed)
        changed = copy.deepcopy(profile)
        changed['cases'].pop()
        with self.assertRaises(ValueError):
            native_plan.native_fixture_obligations(changed)


if __name__ == '__main__':
    unittest.main()

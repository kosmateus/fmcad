"""D-11 hardening: detect the recurring `dict(..., **result)` reserved-kwarg collision.

Envelope-building `_*_contract` helpers across assets/cad/*.py share a latent bug:
a `dict(...)` call that passes a reserved key explicitly AND splats a data dict
(`**result`/`**payload`) raises `TypeError: dict() got multiple values for keyword
argument '...'` whenever the splatted dict already contains that key. The reserved
keys are `affected`, `limitations`, `status`, `warnings` (plus `success`/
`associativity`, tracked separately by the families that own them).

This test does not refactor the ~15 copies of `_*_contract`. It (1) proves a static
AST scanner detects the exact risky source shape, (2) pins the current open sites so
a NEW unguarded site turns the suite red, and (3) confirms the recommended merge
pattern renders a payload that already carries the reserved keys without a TypeError.

Recommended pattern (see AGENT_SHARED_NOTES):
    merged = dict(base)
    merged.update(result)
    merged.setdefault('status', status)
    merged['success'] = merged['status'] == 'pass'
"""
import ast
import importlib.util
import pathlib
import types
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
CAD_DIR = ROOT / 'assets' / 'cad'

RESERVED = ('affected', 'limitations', 'status', 'warnings')
DATA_SPLATS = ('result', 'payload')


class RegistryHardeningTest(unittest.TestCase):
    def test_registry_collision_is_rejected_before_second_handler_dispatch(self):
        spec = importlib.util.spec_from_file_location('values', ROOT / 'runtime/python/fmcad/domain/values.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        registry = module.HandlerRegistry()
        calls = []
        registry.owner = 'fixture'
        registry['fixture.read'] = lambda ctx, data: calls.append('first')
        with self.assertRaisesRegex(ValueError, 'Duplicate CAD handler'):
            registry['fixture.read'] = lambda ctx, data: calls.append('second')
        registry.dispatch(None, 'fixture.read', {})
        self.assertEqual(calls, ['first'])


def _flag_reserved(call, popped):
    """Reserved keys passed explicitly that a LATER data splat could override.

    ``dict(a=1, **d)`` raises TypeError when ``d`` contains ``a``; ``dict(**d, a=1)``
    does not. Only an explicit reserved keyword that appears before a data splat,
    and is not popped from that splat source, is a collision risk.
    """
    flagged = set()
    for i, kw in enumerate(call.keywords):
        if kw.arg is None or kw.arg not in RESERVED:
            continue
        for later in call.keywords[i + 1:]:
            if later.arg is None and isinstance(later.value, ast.Name) and later.value.id in DATA_SPLATS:
                if kw.arg not in popped.get(later.value.id, set()):
                    flagged.add(kw.arg)
    return flagged


def _collect_pops(node):
    """Map splat-source name -> set of reserved keys popped from it in this scope."""
    popped = {}
    for sub in ast.walk(node):
        if isinstance(sub, ast.Call) and isinstance(sub.func, ast.Attribute) and sub.func.attr == 'pop':
            if isinstance(sub.func.value, ast.Name) and sub.args:
                first = sub.args[0]
                if isinstance(first, ast.Constant) and isinstance(first.value, str):
                    popped.setdefault(sub.func.value.id, set()).add(first.value)
    return popped


def _dict_calls(func):
    """Yield dict(...) calls directly in `func`, not descending into nested defs."""
    class Finder(ast.NodeVisitor):
        def __init__(self):
            self.calls = []

        def visit_Call(self, call):
            if isinstance(call.func, ast.Name) and call.func.id == 'dict':
                self.calls.append(call)
            self.generic_visit(call)

        def visit_FunctionDef(self, nested):
            pass

        def visit_AsyncFunctionDef(self, nested):
            pass

        def visit_Lambda(self, nested):
            pass

    finder = Finder()
    for statement in func.body:
        finder.visit(statement)
    return finder.calls


def scan_envelope_collisions(directory):
    """Return [{file, line, reserved}] for unguarded reserved-key splat sites."""
    findings = []
    for path in sorted(pathlib.Path(directory).glob('*.py')):
        try:
            tree = ast.parse(path.read_text(encoding='utf-8'), filename=str(path))
        except SyntaxError:
            continue
        for func in (n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))):
            popped = _collect_pops(func)
            for call in _dict_calls(func):
                flagged = _flag_reserved(call, popped)
                if flagged:
                    findings.append({'file': path.name, 'line': call.lineno, 'reserved': sorted(flagged)})
    return findings


def scan_source(source):
    tree = ast.parse(source)
    findings = []
    for func in (n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))):
        popped = _collect_pops(func)
        for call in _dict_calls(func):
            flagged = _flag_reserved(call, popped)
            if flagged:
                findings.append({'line': call.lineno, 'reserved': sorted(flagged)})
    return findings


class ScannerTests(unittest.TestCase):
    def test_flags_explicit_reserved_keyword_followed_by_data_splat(self):
        source = (
            'def _bad_contract(ctx, operation, result):\n'
            "    return dict(schemaVersion=1, operation=operation, status='pass', **result)\n"
        )
        findings = scan_source(source)
        self.assertEqual(len(findings), 1)
        self.assertIn('status', findings[0]['reserved'])

    def test_splat_before_explicit_keyword_is_not_flagged(self):
        source = (
            'def _ok_contract(ctx, operation, result):\n'
            "    return dict(**result, status='pass')\n"
        )
        self.assertEqual(scan_source(source), [])

    def test_popped_reserved_key_is_not_flagged(self):
        source = (
            'def _pop_contract(ctx, operation, result):\n'
            "    return dict(schemaVersion=1, status='pass', warnings=list(result.pop('warnings', [])),\n"
            "                affected=list(result.pop('affected', [])), **result)\n"
        )
        findings = scan_source(source)
        self.assertEqual([f['reserved'] for f in findings], [['status']])

    def test_stepwise_merge_pattern_is_not_flagged(self):
        source = (
            'def _merged_contract(ctx, operation, result):\n'
            "    merged = dict(schemaVersion=1, operation=operation)\n"
            '    merged.update(result)\n'
            "    merged.setdefault('status', 'pass')\n"
            '    return merged\n'
        )
        self.assertEqual(scan_source(source), [])


class ContractHardeningTests(unittest.TestCase):
    # Open D-11 sites still owned by their respective families. Keys here are
    # reserved keys the scanner still flags as unguarded (explicit + **result
    # without a pop). Kept as an allow-list so a NEW unguarded site fails the
    # suite while an unrelated family fixing their own file stays green.
    KNOWN_OPEN = {
        'cam.py': {'affected', 'limitations', 'status', 'warnings'},
        'fastener.py': {'limitations', 'status', 'warnings'},
        'feature.py': {'status'},
        'seal.py': {'limitations', 'status', 'warnings'},
        'spring.py': {'limitations', 'status', 'warnings'},
        'surface.py': {'status'},
        'thread.py': {'limitations', 'status', 'warnings'},
        'sketch.py': {'limitations', 'warnings'},
    }

    def test_no_new_unguarded_reserved_splats(self):
        findings = scan_envelope_collisions(CAD_DIR)
        by_file = {}
        for f in findings:
            by_file.setdefault(f['file'], set()).update(f['reserved'])
        for file_name, reserved in by_file.items():
            self.assertIn(file_name, self.KNOWN_OPEN,
                          'new unguarded reserved-key splat in %s (flags %s)' % (file_name, sorted(reserved)))
            self.assertLessEqual(reserved, self.KNOWN_OPEN[file_name],
                                 '%s now flags unguarded reserved keys %s (allowed %s)' %
                                 (file_name, sorted(reserved - self.KNOWN_OPEN[file_name]), sorted(self.KNOWN_OPEN[file_name])))

    def test_checking_contract_renders_reserved_keys_without_typeerror(self):
        namespace = {'CAD_HANDLERS': {}}
        exec(compile((CAD_DIR / 'checking.py').read_text(encoding='utf-8'), 'checking.py', 'exec'), namespace)
        ctx = types.SimpleNamespace(doc=types.SimpleNamespace(name='fixture'))
        result = {'status': 'pass', 'warnings': ['reserved-warning'],
                  'limitations': ['reserved-limit'], 'affected': [{'token': 't1'}]}
        out = namespace['_checking_contract'](ctx, 'check.set', result, status='fail')
        self.assertEqual(out['status'], 'fail')
        self.assertIn('reserved-warning', out['warnings'])
        self.assertEqual(out['affected'], [{'token': 't1'}])

    def test_recommended_merge_pattern_resolves_reserved_keys(self):
        def recommended(result, status='pass'):
            merged = dict(schemaVersion=1, warnings=[], affected=[])
            merged.update(result)
            merged.setdefault('status', status)
            merged['success'] = merged['status'] == 'pass'
            return merged

        carried = recommended({'status': 'fail', 'warnings': ['w'], 'affected': [{'token': 't'}]}, status='blocked')
        self.assertEqual(carried['status'], 'fail')
        self.assertFalse(carried['success'])
        self.assertEqual(carried['warnings'], ['w'])
        self.assertEqual(carried['affected'], [{'token': 't'}])

        defaulted = recommended({'warnings': ['w']}, status='blocked')
        self.assertEqual(defaulted['status'], 'blocked')
        self.assertFalse(defaulted['success'])


if __name__ == '__main__':
    unittest.main()

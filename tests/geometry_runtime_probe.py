"""Deterministic SDK-double transcript. No Autodesk installation is imported."""
import copy
import json
from pathlib import Path
import sys
import types

import model_test as fake

ROOT = Path(__file__).resolve().parents[1]
FAMILIES = ('model', 'sketch', 'sketch_plan', 'curve', 'datum', 'surface', 'shapes', 'feature')


def probe(source_dir=None):
    ns = {}
    values = ROOT / 'runtime/python/fmcad/domain/values.py'
    exec(compile(values.read_text(), str(values), 'exec'), ns)
    for name in ('core', 'identity', 'entity'):
        path = ROOT / f'assets/cad/{name}.py'
        exec(compile(path.read_text(), str(path), 'exec'), ns)
    for name in FAMILIES:
        if source_dir is not None:
            paths = [Path(source_dir) / f'{name}.py']
        else:
            paths = [ROOT / f'runtime/python/fmcad/{layer}/geometry_{name}.py'
                     for layer in ('domain', 'adapters/fusion', 'application')]
        for path in paths:
            exec(compile(path.read_text(), str(path), 'exec'), ns)

    def clean(value):
        if value is None or isinstance(value, (str, bool, int, float)):
            return value
        if isinstance(value, dict):
            return {key: clean(item) for key, item in value.items() if key != 'token'}
        if isinstance(value, (tuple, list)):
            return [clean(item) for item in value]
        if isinstance(value, fake.Point):
            return [value.x, value.y, value.z]
        if hasattr(value, 'objectType'):
            return {'type': value.objectType, 'name': value.name}
        if isinstance(value, fake.Collection):
            return clean(value.values)
        if isinstance(value, types.SimpleNamespace):
            return clean(vars(value))
        # Anonymous handles returned by the double have no serialized DTO role.
        return {'opaque': type(value).__name__}

    scenarios = [
        ('extrude', 'model.extrude', {'profile': {'kind': 'profile', 'sketch': 'Section', 'index': 0}, 'distance': '5 mm', 'name': 'Probe'}),
        ('sweep', 'model.sweep', {'profile': {'kind': 'profile', 'sketch': 'Section', 'index': 0}, 'path': {'curves': ['line-token']}}),
        ('invalid', 'model.extrude', {'profile': {'kind': 'profile', 'sketch': 'Section', 'index': 0}, 'distance': '5 mm', 'invented': True}),
        ('unsupported', 'shape.helix', {'pitch': '1 mm', 'turns': 3, 'radius': '3 mm'}),
        ('partial', 'shape.slot', {'profile': {'kind': 'profile', 'sketch': 'Section', 'index': 0}, 'thickness': '2 mm'}),
        ('drift', 'datum.transform', {'from': 'root', 'to': 'root'}),
    ]
    transcript = {}
    for name, operation, data in scenarios:
        fake.TRACE.clear()
        ctx = fake.Context()
        if name == 'partial':
            def failed_call(operation, data):
                fake.TRACE.append(('applied-first-step', operation, copy.deepcopy(data)))
                raise RuntimeError('injected SDK failure after first effect; inspect partial changes')
            ctx.call = failed_call
        if name == 'drift':
            def changed():
                fake.TRACE.append(('identity',))
                raise RuntimeError('DOCUMENT_CHANGED')
            ctx.assert_identity = changed
        try:
            result = ns['CAD_HANDLERS'][operation](ctx, data)
            outcome = {'result': clean(result)}
        except Exception as error:
            outcome = {'error': type(error).__name__, 'message': str(error)}
        transcript[name] = dict(outcome, trace=clean(fake.TRACE))
    return transcript


if __name__ == '__main__':
    print(json.dumps(probe(sys.argv[1] if len(sys.argv) > 1 else None), sort_keys=True, indent=2))

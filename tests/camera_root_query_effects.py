"""Compare the erased callback to the query path actually used before projection."""
import json
from pathlib import Path


def verify_root_query_effects(core, bound):
    project = Path(__file__).resolve().parents[1]
    # Same single-candidate source and same Fusion JSON projection as the
    # reviewed public program. All other query/description code is canonical.
    ns = core.__dict__
    exec((project / 'runtime/python/fmcad/adapters/fusion/camera_query_root.py').read_text(), ns)
    exec((project / 'runtime/python/fmcad/adapters/fusion/values.py').read_text(), ns)
    core._cad_json = core.fusion_json
    raw = '{"query":{"kind":"component","scope":{"component":"root"}}}'

    def exercise(projected, failure=None, mode='ok'):
        events = []

        def read(name, value=None):
            events.append(name)
            if len(events) == failure:
                raise RuntimeError('SDK failure: ' + str(name))
            return value

        class Native:
            def __init__(self, label, **properties):
                self.label, self.properties = label, properties

            def __getattr__(self, name):
                if name not in self.properties:
                    raise AttributeError(name)
                return read(self.label + '.' + name, self.properties[name])

            def __eq__(self, other):
                return read(self.label + '==', self is other)

        def valid(x, u):
            result = ((x, u) != ('0.001 mm', 'cm') or mode != 'invalid-units') if u != 'cm/cm' else mode == 'unitless'
            return read(('valid', x, u), result)

        def evaluate(x, u):
            value = {'nan-tolerance': float('nan'), 'negative': -1, 'bad-angle': 2 if u == 'rad' else 0.1}.get(mode, 0.1)
            return read(('evaluate', x, u), value)

        design = Native('design', unitsManager=Native('units', isValidExpression=valid, evaluateExpression=evaluate))
        lo = Native('lo', x={'bad-bounds': float('inf'), 'bad-coordinate': 'bad'}.get(mode, 0), y=1, z=2)
        hi = Native('hi', x=3, y=4, z=5)
        box = Native('box', objectType='adsk::core::BoundingBox3D', minPoint=lo, maxPoint=hi)
        root = Native('root', objectType='adsk::fusion::Component', isValid=mode != 'invalid-root',
                      boundingBox=None if mode == 'null-box' else box)
        file = Native('file', id='f', versionNumber=1)
        doc = Native('doc', name='Doc', creationId='doc-id', dataFile=file if mode != 'unsaved' else None)
        ctx = object.__new__(core.CadContext)
        ctx.root, ctx.component, ctx.design, ctx.doc, ctx.occurrence = root, root, design, doc, None
        ctx.assert_identity = lambda: read('identity')
        try:
            result = bound(design, root, doc, ctx.assert_identity) if projected else ctx.resolve(json.loads(raw))
            outcome = ('ok', result is root)
        except (ValueError, TypeError, RuntimeError) as e:
            outcome = (type(e).__name__, str(e))
        return outcome, events

    expected, trace = exercise(False)
    assert expected == ('ok', True)
    assert exercise(True) == (expected, trace)
    assert trace.count('identity') == 2 and 'box.minPoint' in trace and 'file.versionNumber' in trace
    # Native errors can come from any getter, including the second read of the
    # same property. Removing a read or reordering it must fail this comparison.
    for failure in range(1, len(trace) + 1):
        assert exercise(True, failure) == exercise(False, failure), (failure, trace[failure - 1])
    for mode in ('invalid-units', 'unitless', 'nan-tolerance', 'negative', 'bad-angle',
                 'invalid-root', 'null-box', 'bad-bounds', 'bad-coordinate', 'unsaved'):
        assert exercise(True, mode=mode) == exercise(False, mode=mode), mode
    return len(trace)

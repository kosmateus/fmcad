"""Exercise the actual public chain programs against the SDK fixture."""
import contextlib
import io
import json
import sys
from unittest.mock import patch

from core_test import CoreTests


def check(case, stage, expected):
    fixture = CoreTests()
    fixture.setUp()
    def attr(name, raw):
        fixture.root.attributes.add('fmcad.aliases', name, raw)
    attr('outer', '"changed"' if case == 'stale outer' else request['raw'])
    if stage or case in ('discover','scan fails'):
        attr('inner', '"changed"' if case in ('stale inner','scan fails') else request['inner'])
    if case == 'plain success':
        fixture.child.name = 'inner'
    if case == 'wrong kind':
        fixture.body('inner')
    if case in ('inner conflict', 'outer conflict'):
        fixture.body('inner' if case == 'inner conflict' else 'outer')
    fixture.tokens['part'] = {
        'token missing': [], 'token conflict': [fixture.root, fixture.child]
    }.get(case, [fixture.child])
    sdk = fixture.core.adsk
    space = {}
    with patch.dict(sys.modules, {'adsk':sdk, 'adsk.core':sdk.core, 'adsk.fusion':sdk.fusion}):
        exec(request['programs'][stage], space)
    # Camera behavior is separately covered; reaching its read is success here.
    space['_camera_active_viewport'] = lambda *_: (_ for _ in ()).throw(RuntimeError('camera reached'))
    if case == 'scan fails':
        scan = space['_camera_matching_names']
        def failing_scan(design, root, name):
            if name == 'inner':
                raise ValueError('SDK enumeration failed')
            return scan(design, root, name)
        space['_camera_matching_names'] = failing_scan
    output = io.StringIO()
    try:
        with contextlib.redirect_stdout(output):
            space['run']('')
        result = json.loads(output.getvalue().split('FMCAD_RESULT ')[1])['_cameraAlias']
        actual = ('discovered',result['name'],result['raw'])
    except (ValueError, RuntimeError) as exc:
        actual = str(exc)
    assert actual == expected, (case, actual, expected)


request = json.load(sys.stdin)
stale = 'DOCUMENT_STATE_CHANGED: component alias changed during selection'
check('discover', 0, ('discovered','inner',request['inner']))
check('plain success', 0, 'camera reached')
check('wrong kind', 0, 'component_ref must resolve to a component or occurrence')
check('missing', 0, 'Reference inner: expected one match, found 0')
check('success', 1, 'camera reached')
check('inner conflict', 1, 'Reference inner: expected one match, found 2')
check('outer conflict', 1, 'Reference outer: expected one match, found 2')
check('token missing', 1, 'Entity token: expected one match, found 0')
check('token conflict', 1, 'Entity token: expected one match, found 2')
check('stale outer', 1, stale)
check('stale inner', 1, stale)
check('scan fails', 0, 'SDK enumeration failed')
check('scan fails', 1, 'SDK enumeration failed')

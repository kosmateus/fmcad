"""Executed with the selected, erased callback sources; compare to the original context."""
import json
import sys
import unittest

import core_test as fixture


def main():
    request = json.load(sys.stdin)
    owner = fixture.CoreTests()
    owner.setUp()
    occ = owner.occurrence()
    occ.transform2 = fixture.Matrix.create()
    occ.transform2.values = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    owner.child.entityToken = 'part-token'
    occ.entityToken = 'occ-token'
    owner.register(owner.child, occ)
    owner.body('same')
    owner.profile_sketch(2)
    if request.get('emptyCollections'):
        owner.root.sketches.items.clear()
        owner.root.bRepBodies.items.clear()
    if request.get('instanceBody'):
        owner.body('instance-body', owner.child)
    for name, value in request['attributes'].items():
        owner.root.attributes.add('fmcad.aliases', name, value)
    # The SDK is doubled, neither resolver is. Keep the generated namespace
    # separate: a missing registered dependency cannot use an oracle global.
    namespace = {}
    from unittest.mock import patch
    adsk = owner.core.adsk
    with patch.dict(sys.modules, {'adsk': adsk, 'adsk.core': adsk.core, 'adsk.fusion': adsk.fusion}):
        exec(compile(request['script'], '<camera-alias-registered>', 'exec'), namespace)
    ctx = namespace['CadContext']('Test')
    ctx._camera_alias_bindings = {
        row['name']: (row['raw'], namespace[row['resolverSymbol']]) for row in request['aliasBindings']
    }
    raw = request['raw']

    def outcome(call):
        try:
            return ('ok', call())
        except (TypeError, ValueError, RuntimeError) as exc:
            return (type(exc).__name__, str(exc))

    if request.get('wantedSignal'):
        try:
            namespace[request['resolverSymbol']](ctx, raw)
        except namespace['_CameraAliasRequired'] as signal:
            assert [signal.name, signal.raw] == request['wantedSignal']
        else:
            raise AssertionError('expected a continuation')
        return
    resolve = namespace[request['resolverSymbol']]
    actual = outcome(lambda: resolve(ctx.design, ctx.root, ctx.doc, ctx.assert_identity) if request['rootQuery'] else resolve(ctx, raw))
    if request.get('stale'):
        assert actual == ('RuntimeError', 'DOCUMENT_STATE_CHANGED: component alias changed during selection'), actual
    else:
        canonical = outcome(lambda: owner.ctx.resolve(json.loads(raw)))
        unittest.TestCase().assertEqual(actual, canonical)
        if request.get('status'):
            assert actual[0] == request['status'], actual
        if request['rootQuery']:
            from camera_root_query_effects import verify_root_query_effects
            verify_root_query_effects(owner.core, resolve)


if __name__ == '__main__':
    main()

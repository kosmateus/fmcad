"""Execute actual prepared units against an SDK stub, with no repository reads."""
import json
from pathlib import Path
import sys
import types
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
golden = json.loads((ROOT / 'tests/fixtures/python-assembly-parity.json').read_text())
units = json.load(sys.stdin)
adsk = types.ModuleType('adsk')
adsk.core = types.ModuleType('adsk.core')
adsk.fusion = types.ModuleType('adsk.fusion')
namespace = {}
with patch.dict(sys.modules, {'adsk': adsk, 'adsk.core': adsk.core, 'adsk.fusion': adsk.fusion}), \
        patch.object(Path, 'read_text', side_effect=AssertionError('Bundle attempted repository access')):
    for unit in units:
        exec(compile(unit['source'], unit['filename'], 'exec'), namespace)
registry = namespace['CAD_HANDLERS']
for family, operations in golden['handlers'].items():
    actual = sorted(operation for operation, owner in registry.owners.items() if owner == family)
    assert actual == operations, (family, actual, operations)
    assert all(callable(registry[operation]) for operation in operations)

# Exercise the registered SDK-free sequence planner through the real dispatcher.
result = registry.dispatch(types.SimpleNamespace(), 'assembly.sequence', {
    'parts': ['base', 'lid'], 'dependencies': [['base', 'lid']]})
assert result['order'] == ['base', 'lid']
assert result['disassemblyOrder'] == ['lid', 'base']
try:
    registry.owner = 'unrelated-family'
    registry['pose.save'] = lambda ctx, data: None
except ValueError:
    pass
else:
    raise AssertionError('Handler ownership collision was accepted')
print(json.dumps({'families': list(golden['handlers']), 'handlers': len(registry),
                  'familyHandlers': sum(len(operations) for operations in golden['handlers'].values())}))

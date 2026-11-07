const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { buildCadScript } = require('../src/cad');

test('exhausted host sanitizer stack rejects before model access without removing filtering', () => {
  const script = buildCadScript('audit', {}, { doc: 'Test' });
  const trailer = script.slice(script.lastIndexOf('\ndef run(_context: str):'));
  const source = `import sys
class _NsSanitizedWriter:
    def __init__(self, original): self._original = original
original = sys.stdout
wrapped = original
for _ in range(70): wrapped = _NsSanitizedWriter(wrapped)
sys.stdout = wrapped
${trailer}
try:
    run('')
except RuntimeError as error:
    assert 'FMCAD_MCP_STREAM_EXHAUSTED' in str(error), str(error)
    assert sys.stdout is wrapped
else:
    raise AssertionError('Guard did not reject the exhausted stream')
finally:
    sys.stdout = original
`;
  const result = spawnSync('python3', ['-c', source], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {createHash} = require('node:crypto');
const fs = require('node:fs');
const root = process.env.FMCAD_ADMISSION_CONSUMER_PACKAGE || path.resolve(__dirname, '../..');
const fixture = require(path.join(__dirname, 'python-admission-broker.cjs'));
const {inputFiles} = require(path.join(root, 'dist/src/queue-client'));
test('unknown close remains a failure with retained evidence', async t => {
  const cwd = process.cwd(), state = process.env.XDG_STATE_HOME;
  const f = await fixture({
    diagnostic: text => t.diagnostic(text),
    after: hook => t.after(async () => {
      try { await hook(); } finally {
        assert.equal(process.cwd(), cwd);
        assert.equal(process.env.XDG_STATE_HOME, state);
        assert(require('node:fs').existsSync(f.home));
        console.log('RESTORED_CONTEXT_RETAINED_EVIDENCE', f.home);
      }
    }),
  }, {typedService:true});
  const client = await f.client('isolated-unknown');
  const source = f.script('unknown.py', 'def run(context: str) -> None:\n    print("NO_EXTERNAL_EFFECT")\n');
  let reached;
  const started = new Promise(resolve => { reached = resolve; });
  f.observeProduct(async () => { reached(); await new Promise(() => {}); });
  const argv = ['run', source, '--doc', 'A'];
  const accepted = await client.submit({kind:'command', requestId:'isolated-unknown',
    argv, cwd:f.home, backend:'mcp', timeoutMs:15000, inputFiles:inputFiles(argv,f.home)});
  await started;
  const result = await client.wait(accepted.id);
  assert.equal(result.job.state, 'needs_reconciliation');
  assert.equal(result.job.operationResult.executionOutcome, 'unknown');
  const lockHash = createHash('sha256').update(fs.readFileSync(path.join(f.dir, 'broker.lock'))).digest('hex');
  console.log('RETAINED_BINDING', JSON.stringify({dir:f.dir, jobId:accepted.id, lockHash}));
  await assert.rejects(f.close(), {code:'RECONCILIATION_REQUIRED'});
  console.log('VERIFIED_UNKNOWN_REFUSAL');
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { commands, findCommand } = require('../src/commands');
const { catalog, validateCad } = require('../src/cad');
const { manuals } = require('../src/help-manual');
const { detail } = require('../src/help');
const { parseCadInput } = require('../src/cad-input');

test('every executable/help route has explicit source-audit metadata and published return contract', () => {
  for (const command of commands.filter(c => c.kind !== 'family')) {
    const key = command.kind === 'cad' ? command.target : command.key;
    const manual = manuals[key];
    assert.ok(manual, `Unfinished command: ${key}`);
    assert.ok(manual.audit.sources.length, key);
    assert.ok(manual.audit.verified.length, key);
    assert.ok(manual.audit.tests.length, key);
    assert.equal(manual.audit.testRetirement, undefined, key);
    assert.ok(Array.isArray(manual.audit.gaps), key);
    assert.ok(manual.examples.length, key);
    if (key !== 'help') assert.ok(manual.sections.some(s => /Return Contract/i.test(s.title)), key);
    for (const example of manual.examples) {
      assert.ok(example.label && example.requires && example.output, key);
      if (command.kind === 'cad') {
        let data = example.data;
        if (data === undefined) {
          assert.ok(Array.isArray(example.argv), `${key}: missing data or argv`);
          const route = findCommand(example.argv);
          assert.equal(route, command, `${key}: example must resolve to its owner`);
          data = parseCadInput(example.argv.slice(route.key.split(' ').length), catalog[command.target].inputs).data;
        }
        assert.doesNotThrow(() => validateCad(command.target, data), `${key}: ${example.label}`);
      }
    }
    assert.ok(detail(...command.key.split(' ')).includes(manual.sections[0].text), key);
  }
  assert.deepEqual(commands.filter(c => c.kind === 'cad').map(c => c.target).sort(),
    Object.keys(catalog).filter(operation => !catalog[operation].internalOnly).sort());
});

test('groups list actual registry children and aliases share their owner', () => {
  for (const command of commands) {
    if (command.kind === 'family') {
      const text = detail(...command.key.split(' '));
      const listed = [...text.matchAll(/^  fmcad help (.+?) - /gm)].map(match => match[1]);
      const expected = commands.filter(c => c.kind !== 'family' &&
        [c.key, ...(c.aliases || []), ...(c.kind === 'cad' ? [c.target.replaceAll('.', ' ')] : [])]
          .some(route => route.startsWith(command.key + ' '))).map(c => c.key);
      assert.deepEqual(listed.sort(), expected.sort(), command.key);
    }
    for (const alias of command.aliases || []) {
      assert.equal(findCommand(alias.split(' ')), command, alias);
      assert.equal(detail(...alias.split(' ')), detail(...command.key.split(' ')), alias);
    }
  }
});

test('all referenced test evidence files exist', () => {
  for (const [key, manual] of Object.entries(manuals)) {
    for (const evidence of manual.audit.tests) {
      const file = evidence.split(/[: ]/)[0];
      assert.ok(fs.existsSync(file), `${key}: missing test evidence ${file}`);
    }
  }
});

test('durable command reference and coverage matrix match the actual rendered CLI manuals', () => {
  const result = spawnSync(process.execPath, ['scripts/generate-help-audit.js', '--check'], { encoding: 'utf8' });
  const unfinishedRoutes = commands
    .filter((command) => command.kind !== 'family')
    .map((command) => command.kind === 'cad' ? command.target : command.key)
    .filter((key) => manuals[key]?.audit?.gaps?.length)
    .sort();
  assert.deepEqual(unfinishedRoutes, ['frame.context_audit', 'snapshot.capture_v2', 'snapshot.diff_v2']);
  const coverage = fs.readFileSync('docs/COMMAND_COVERAGE.md', 'utf8');
  const match = coverage.match(/^Unfinished command audits: (\d+)\./m);
  assert.ok(match, 'coverage matrix publishes the unfinished-audit count');
  const unfinished = Number(match[1]);
  assert.equal(unfinished, unfinishedRoutes.length);
  assert.equal(result.status, unfinished ? 1 : 0, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`${unfinished} unfinished audits; generated documentation current\\.`));
  assert.doesNotMatch(result.stderr, /Stale generated documentation/);
});

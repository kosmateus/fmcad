const test = require('node:test');
const assert = require('node:assert/strict');
const { redactDiagnostic } = require('../src/diagnostics');
const { main } = require('../src/cli');

test('diagnostic redaction knows configured credentials, preserves CAD identifiers and JSON', () => {
  const backend = { url: 'https://user:password@host/mcp?custom=private', headers: { 'X-Custom-Auth': 'custom-secret', Host: 'host' } };
  const text = redactDiagnostic(JSON.stringify({ Authorization: 'Bearer auth-secret',
    message: `${backend.url} custom-secret https://a:b@host/?api_key=url-secret&doc=123`,
    entityToken: 'CAD-token', token: 'CAD-token', ref: '?token=CAD-token', host: 'host' }), backend);
  for (const secret of ['auth-secret', 'custom-secret', 'url-secret', 'private', 'password']) assert.ok(!text.includes(secret), text);
  const parsed = JSON.parse(text);
  assert.equal(parsed.entityToken, 'CAD-token');
  assert.equal(parsed.ref, '?token=CAD-token');
  assert.equal(parsed.host, 'host');
  assert.equal(JSON.parse(redactDiagnostic(JSON.stringify({ message: 'Authorization: Bearer hidden-secret' }))).message, 'Authorization: [REDACTED]');
  assert.ok(!redactDiagnostic('https://host/#access_token=fragment-secret').includes('fragment-secret'));
});

test('recognized JSON credentials redact escaped and incomplete values, not CAD tokens/signatures', () => {
  const value = Object.fromEntries(['access_token', 'refresh_token', 'client_secret', 'password', 'api_key', 'secret']
    .map(name => [name, 'private-"escaped']));
  Object.assign(value, { token: 'CAD-token', entityToken: 'CAD-entity', signature: 'CAD-signature' });
  const text = redactDiagnostic(JSON.stringify(value));
  assert.ok(!text.includes('private-'));
  const parsed = JSON.parse(text);
  for (const name of ['token', 'entityToken', 'signature']) assert.equal(parsed[name], value[name]);
  assert.ok(!redactDiagnostic('{"secret":"unfinished-private').includes('unfinished-private'));
});

test('pretty JSON scalar credentials keep commas and ordinary CAD fields', () => {
  for (const value of ['"sëcret,with,commas"', '123.5', 'null']) {
    for (const separator of [' ', '\n    ', '\n\n    ']) {
      const source = '{\n  "password":' + separator + value + ',\n'
        + '  "value": "ordinary",\n  "token": "CAD-token",\n'
        + '  "entityToken": "CAD-entity"\n}\n';
      const text = redactDiagnostic(source);
      assert.deepEqual(JSON.parse(text), {
        password: '[REDACTED]', value: 'ordinary', token: 'CAD-token', entityToken: 'CAD-entity',
      });
      assert.ok(!text.includes('sëcret'));
    }
  }
});

test('raw Cookie Authorization and secret headers redact comma suffixes and folded values', () => {
  for (const name of ['Cookie', 'Authorization', 'secret']) {
    for (const separator of [' ', '\n  ', '\n']) {
      const source = name + ':' + separator + 'first-private, suffix-private\n'
        + '\tfolded-private, folded-suffix\nordinary evidence\n';
      const text = redactDiagnostic(source);
      for (const secret of ['first-private', 'suffix-private', 'folded-private', 'folded-suffix']) {
        assert.ok(!text.includes(secret), text);
      }
      assert.ok(text.includes('ordinary evidence'));
    }
  }
});

test('CLI redacts stderr using injected backend config without changing run stdout', async () => {
  let stdout = '', stderr = '';
  const payload = 'Authorization: Bearer execution-output entityToken=CAD-token';
  const code = await main(['run', 'synthetic'], {
    loadConfig: () => ({ cfg: { backend: 'mcp', url: 'http://host', headers: { 'X-Credential': 'known-secret' } } }),
    buildRunScript: () => 'synthetic',
    McpClient: class { async callTool() { return { text: payload, stderr: 'known-secret Authorization: Bearer hidden-secret\n', failed: false }; } },
    stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } },
    setExitCode: () => {},
  });
  assert.equal(code, 0, stderr);
  assert.equal(stdout, payload + '\n');
  assert.ok(!stderr.includes('known-secret'));
  assert.ok(!stderr.includes('hidden-secret'));
});

test('CLI thrown backend diagnostics use known URL/header redaction', async () => {
  let stderr = '';
  const url = 'https://host/private-path?custom=private-query';
  const code = await main(['run', 'synthetic'], {
    loadConfig: () => ({ cfg: { backend: 'mcp', url, headers: { 'X-Credential': 'known-secret' } } }),
    buildRunScript: () => 'synthetic',
    McpClient: class { async callTool() { throw new Error(`primary failure ${url} known-secret`); } },
    stdout: { write() { assert.fail('No execution result'); } }, stderr: { write: text => { stderr += text; } },
    setExitCode: () => {},
  });
  assert.equal(code, 1);
  assert.match(stderr, /primary failure/);
  for (const secret of ['known-secret', 'private-path', 'private-query']) assert.ok(!stderr.includes(secret), stderr);
});

test('doctor shows only the origin and hides all potentially credential-bearing endpoint details', async () => {
  let stdout = '';
  const code = await main(['doctor'], {
    loadConfig: () => ({ cfg: { backend: 'mcp', url: 'https://user:private-password@host/private-path?access_token=private-token&custom=private-custom#private-fragment', timeoutMs: 1000 } }),
    McpClient: class { async listTools() { return []; } },
    stdout: { write: text => { stdout += text; } }, stderr: { write: text => assert.fail(text) },
    setExitCode: () => {},
  });
  assert.equal(code, 0);
  assert.ok(stdout.includes('https://host/'));
  for (const secret of ['private-password', 'private-token', 'private-path', 'private-custom', 'private-fragment']) assert.ok(!stdout.includes(secret));
  assert.ok(!redactDiagnostic('Mcp-Session-Id: private-session').includes('private-session'));
});

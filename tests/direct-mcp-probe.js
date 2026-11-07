// Standalone, opt-in diagnostic. No fmcad imports; no CAD mutations.
// Usage: node tests/direct-mcp-probe.js URL HOST_HEADER [maximum_calls]
const http = require('node:http');
const https = require('node:https');

const endpoint = new URL(process.argv[2]);
const host = process.argv[3];
const maximum = Number(process.argv[4] || 420);
if (!Number.isInteger(maximum) || maximum < 1 || maximum > 500) {
  throw new Error('maximum_calls must be an integer between 1 and 500');
}
const transport = endpoint.protocol === 'https:' ? https : http;
const agent = new transport.Agent({ keepAlive: true, maxSockets: 1 });
let session;
let nextId = 1;
const results = [];

async function post(method, params, notification = false) {
  const id = notification ? undefined : nextId++;
  const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  const response = await new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      'Content-Length': Buffer.byteLength(body) };
    if (host) headers.Host = host;
    if (session) headers['Mcp-Session-Id'] = session;
    const request = transport.request(endpoint, { method: 'POST', headers, agent }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text }));
    });
    request.setTimeout(20000, () => request.destroy(new Error('Timeout; no automatic retry')));
    request.on('error', reject);
    request.end(body);
  });
  if (response.status < 200 || response.status >= 300) throw new Error('HTTP ' + response.status);
  if (response.headers['mcp-session-id']) session = response.headers['mcp-session-id'];
  if (notification) return null;
  const text = response.text.trim();
  let message;
  if (text.startsWith('{')) message = JSON.parse(text);
  else {
    const messages = text.split(/\r?\n\r?\n/).map(block => block.split(/\r?\n/)
      .filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n'))
      .filter(Boolean).map(data => JSON.parse(data));
    message = messages.find(value => value.id === id);
  }
  if (!message || message.id !== id) throw new Error('Missing matching JSON-RPC response');
  if (message.error) throw new Error(JSON.stringify(message.error));
  return message.result;
}

async function probe(number) {
  const script = `import sys, json

def run(_context: str):
    stream = sys.stdout
    seen = set()
    while type(stream).__name__ == '_NsSanitizedWriter' and id(stream) not in seen and len(seen) < 600:
        seen.add(id(stream))
        stream = object.__getattribute__(stream, '__dict__')['_original']
    print('DIRECT_MCP_PROBE ' + json.dumps({'probe': ${number}, 'depth': len(seen), 'cycle': id(stream) in seen, 'terminal': type(stream).__name__}))
`;
  const raw = await post('tools/call', { name: 'fusion_mcp_execute',
    arguments: { featureType: 'script', object: { script, readOnly: true } } });
  let payload = raw.structuredContent;
  const content = (raw.content || []).filter(item => item.type === 'text').map(item => item.text).join('\n');
  if (!payload) {
    try { payload = JSON.parse(content); }
    catch (_) { payload = { message: content }; }
  }
  if (raw.isError || payload.success === false || payload.error) return { probe: number, failure: 'tool-error', raw };
  const output = typeof payload.message === 'string' ? payload.message : content;
  const line = output.split(/\r?\n/).find(line => line.startsWith('DIRECT_MCP_PROBE '));
  if (!line) return { probe: number, failure: 'missing-print-output', raw };
  const value = JSON.parse(line.slice('DIRECT_MCP_PROBE '.length));
  if (value.probe !== number) return { probe: number, failure: 'mismatched-output', raw };
  return value;
}

async function main() {
  await post('initialize', { protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'standalone-direct-probe', version: '1.0' } });
  await post('notifications/initialized', {}, true);
  for (let number = 1; number <= maximum; number++) {
    const result = await probe(number);
    results.push(result);
    if (number <= 3 || number % 25 === 0 || result.failure) console.log(JSON.stringify(result));
    if (result.failure || result.cycle) break;
  }
  const last = results.at(-1);
  console.log(JSON.stringify({ diagnostic: 'direct MCP only; no fmcad module imports',
    mutation: false, singleSession: true, attempts: results.length,
    first: results[0], lastSuccessful: results.filter(value => !value.failure).at(-1),
    failure: last?.failure ? last : null,
    stoppedAtConfiguredLimit: results.length === maximum && !last?.failure }));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => agent.destroy());

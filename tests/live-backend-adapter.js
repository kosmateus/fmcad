// Opt-in, read-only live soak. Never starts Fusion or a native MCP server.
// Usage: node tests/live-backend-adapter.js [--timeout-ms 60000]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('../src/config');
const { createBackend, disposeBackend } = require('./helpers/live-broker');

const snapshotScript = `import adsk.core, json, sys
def run(_context: str):
    app = adsk.core.Application.get()
    frame = sys._getframe()
    frame_depth = 0
    while frame is not None:
        frame_depth += 1
        frame = frame.f_back
    documents = sorted([{"creationId": d.creationId, "name": d.name,
        "isSaved": d.isSaved, "isModified": d.isModified} for d in app.documents if _fmcad_live_visible(d)],
        key=lambda d: d["creationId"])
    print(json.dumps({"documents": documents,
        "activeCreationId": app.activeDocument.creationId if app.activeDocument else None,
        "stdoutType": type(sys.stdout).__name__, "frameDepth": frame_depth}))
`;

async function main() {
  const args = process.argv.slice(2);
  assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--timeout-ms'),
    'Usage: node tests/live-backend-adapter.js [--timeout-ms 60000]');
  const timeoutMs = args.length ? Number(args[1]) : 60000;
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 2147482647,
    'timeout-ms must be a positive integer at most 2147482647');
  const { cfg } = loadConfig({ backend: 'addin' });
  const client = createBackend({ ...cfg, timeoutMs });
  const reportPath = path.join(__dirname, 'live-backend-adapter-report.json');
  const report = {
    startedAt: new Date().toISOString(), status: 'running', backend: cfg.backend,
    transport: cfg.transport, configuredTimeoutMs: cfg.timeoutMs, timeoutMs,
    readOnlyEnforced: client.capabilities.readOnlyEnforced,
    spinupNativeMCP: false, modelMutationsRequested: false, automaticResubmit: false,
    automaticFallback: client.capabilities.automaticFallback,
    markerTarget: 450, markersCompleted: 0, initializeCount: 0, toolCalls: 0,
    maxResponseFrameBytes: 0, maxStdoutBytes: 0, maxFrameDepth: 0, stages: [],
  };
  let stopReason;
  let sessionSeen = false;
  let clientSession;
  const stop = signal => { stopReason = `${signal}: stop after the in-flight request; no resubmit`; };
  const onInt = () => stop('SIGINT');
  const onTerm = () => stop('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  const save = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');

  // Observe the real transport, including AutoWSL windows-curl; never replace it.
  const post = client._post.bind(client);
  client._post = async (payload, sessionId) => {
    if (stopReason) throw new Error(stopReason);
    if (payload.method === 'initialize') {
      report.initializeCount++;
      assert.equal(report.initializeCount, 1, 'Unexpected session reinitialization');
    } else {
      assert.ok(sessionSeen, 'Request before initialization');
      assert.equal(sessionId, clientSession, 'Client session changed');
    }
    if (payload.method === 'tools/call') {
      assert.equal(payload.params.name, 'execute_python', 'Unexpected tool or native fallback');
      assert.equal(payload.params.arguments.persistent, false);
      report.toolCalls++;
    }
    const response = await post(payload, sessionId);
    report.maxResponseFrameBytes = Math.max(report.maxResponseFrameBytes,
      Buffer.byteLength(response.raw || '', 'utf8'));
    if (payload.method === 'initialize') {
      clientSession = response.sessionId;
      sessionSeen = true;
      report.clientSession = clientSession ?? null;
      report.serverIssuedSessionId = !!clientSession;
    }
    return response;
  };

  async function call(request, tool) {
    if (stopReason) throw new Error(stopReason);
    let timer;
    try {
      // Also bound the whole adapter call (initialization plus execution). On timeout
      // the run exits without another request, even if the pending call settles later.
      const out = process.env.FMCAD_LIVE_ROUTING === 'queue' ? await client.callTool(request, tool) : await Promise.race([
        client.callTool(request, tool),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            stopReason = `Adapter timeout after ${timeoutMs} ms; inspect before retrying`;
            reject(new Error(stopReason));
          }, timeoutMs);
        }),
      ]);
      if (stopReason) throw new Error(stopReason);
      if (typeof out.text === 'string') {
        report.maxStdoutBytes = Math.max(report.maxStdoutBytes, Buffer.byteLength(out.text, 'utf8'));
      }
      return out;
    } finally {
      clearTimeout(timer);
    }
  }

  const script = code => call({ featureType: 'script', object: { readOnly: true, script: code } });
  function success(out, expected) {
    assert.equal(out.failed, false, out.text);
    assert.equal(out.readOnlyRequested, true);
    assert.equal(out.readOnlyEnforced, false);
    if (expected !== undefined) assert.equal(out.text.replace(/\r\n/g, '\n'), expected + '\n');
  }
  async function stage(name, action) {
    const entry = { name, status: 'running', startedAt: new Date().toISOString() };
    report.stages.push(entry);
    save();
    const start = Date.now();
    try {
      await action();
      entry.status = 'passed';
    } catch (error) {
      entry.status = 'failed';
      entry.error = error.stack || String(error);
      throw error;
    } finally {
      entry.durationMs = Date.now() - start;
      save();
      console.log(`${name}: ${entry.status} (${entry.durationMs} ms)`);
    }
  }
  async function snapshot(key) {
    const out = await script(snapshotScript);
    success(out);
    const data = JSON.parse(out.text);
    assert.ok(Array.isArray(data.documents));
    assert.ok(Number.isInteger(data.frameDepth) && data.frameDepth > 0);
    assert.equal(typeof data.stdoutType, 'string');
    report[key] = data;
    report.maxFrameDepth = Math.max(report.maxFrameDepth, data.frameDepth);
  }

  try {
    assert.equal(report.readOnlyEnforced, false);
    assert.equal(report.automaticFallback, false);
    await stage('before', () => snapshot('before'));
    await stage('document.list bridge', async () => {
      const out = await call({ queryType: 'document', operation: 'open' }, 'fusion_mcp_read');
      success(out);
      assert.ok(Array.isArray(out.data?.results), 'Missing bridged document results');
      assert.deepEqual(JSON.parse(out.text), out.data);
      assert.equal(out.data.results.length, report.before.documents.length);
      report.documentList = out.data;
    });
    await stage('450 sequential markers', async () => {
      for (let i = 1; i <= 450; i++) {
        const marker = `ADAPTER_PROBE_${i}`;
        success(await script(`def run(_context: str):\n print("${marker}")`), marker);
        report.markersCompleted = i;
        if (i % 25 === 0) {
          save();
          console.log(`Markers: ${i}/450`);
        }
      }
    });
    await stage('unicode and stderr', async () => {
      const unicode = 'ADAPTER_UNICODE Za\u017c\u00f3\u0142\u0107 \u4e2d\u6587 \ud83d\ude80';
      success(await script(`def run(_context: str):\n print(${JSON.stringify(unicode)})`), unicode);
      const out = await script('import sys\ndef run(_context: str):\n print("ADAPTER_STDOUT")\n print("ADAPTER_STDERR", file=sys.stderr)');
      success(out, 'ADAPTER_STDOUT');
      assert.equal(out.stderr.replace(/\r\n/g, '\n'), 'ADAPTER_STDERR\n');
    });
    await stage('expected Python exception then success', async () => {
      const out = await script('def run(_context: str):\n raise ValueError("ADAPTER_EXPECTED_EXCEPTION")');
      assert.equal(out.failed, true);
      assert.match(out.text, /ValueError/);
      assert.match(out.text, /ADAPTER_EXPECTED_EXCEPTION/);
      report.expectedPythonException = out.text;
      success(await script('def run(_context: str):\n print("ADAPTER_AFTER_EXCEPTION")'), 'ADAPTER_AFTER_EXCEPTION');
    });
    await stage('unsupported operations', async () => {
      report.unsupported = [];
      for (const [tool, request] of [
        ['fusion_mcp_read', { queryType: 'document', operation: 'recent' }],
        ['fusion_mcp_read', { queryType: 'licensing' }],
        ['fusion_mcp_update', { featureType: 'undo' }],
        ['fusion_mcp_update', { featureType: 'redo' }],
      ]) {
        await assert.rejects(call(request, tool), error => {
          assert.match(error.message, /unsupported|unavailable/i);
          assert.match(error.message, /--backend mcp/);
          assert.match(error.message, /no .*fallback/i);
          report.unsupported.push({ tool, request, error: error.message });
          return true;
        });
      }
    });
    await stage('after and unchanged documents', async () => {
      await snapshot('after');
      assert.deepEqual(report.after.documents, report.before.documents);
      assert.equal(report.after.activeCreationId, report.before.activeCreationId);
      assert.equal(report.initializeCount, 1);
      assert.equal(report.markersCompleted, 450);
      report.singleClientSession = true;
    });
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = error.stack || String(error);
    report.safeStop = 'No further requests or automatic retries. Inspect Fusion before rerunning.';
    process.exitCode = 1;
    console.error(report.error);
  } finally {
    disposeBackend(client);
    process.removeListener('SIGINT', onInt);
    process.removeListener('SIGTERM', onTerm);
    report.finishedAt = new Date().toISOString();
    save();
    console.log(`Report: ${reportPath}`);
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

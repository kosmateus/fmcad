'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');
const { resolveRuntimePaths, resolvePython } = require('./dist/config-platform/index.js');
const { sourceHashMismatch } = require('./dist/core');
const { readSource } = require('./dist/node-adapters/console/bounded-read');
const { parseWorkerJson } = require('./dist/python/local-pipeline');
const { redactDiagnostic } = require('./diagnostics');

const HELPER = resolveRuntimePaths({ anchor: __filename }).formatter;
const TONES = new Set(['text', 'accent', 'success', 'warning', 'muted', 'syntaxKeyword', 'syntaxFunction', 'syntaxType', 'syntaxBuiltin', 'syntaxKey']);
const integer = (value, fallback, maximum) => Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;

function formatCopy(original, options) {
  const python = resolvePython({ pythonPath: options.pythonPath, feature: 'formatter' });
  const timeout = integer(options.timeoutMs, 3000, 3000);
  const limit = integer(options.maxOutputBytes, 32 * 1024 * 1024, 64 * 1024 * 1024);
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-I', '-B', HELPER], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let settled = false, size = 0, stderr = '';
    const chunks = [];
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { child.kill('SIGKILL'); reject(error); }
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`Formatter timed out after ${timeout} ms`)), timeout);
    child.on('error', error => finish(new Error(`Formatter unavailable: ${error.message}`)));
    child.stdin.on('error', error => finish(new Error(`Formatter input failed: ${error.message}`)));
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > limit) return finish(new Error('Formatter output exceeds limit'));
      if (!settled) chunks.push(chunk);
    });
    child.stderr.on('data', chunk => {
      size += chunk.length;
      if (size > limit) return finish(new Error('Formatter output exceeds limit'));
      if (stderr.length < 2048) stderr += chunk.toString('utf8').slice(0, 2048 - stderr.length);
    });
    child.on('close', code => {
      if (settled) return;
      if (code !== 0) return finish(new Error(`Formatter exited with ${code}: ${redactDiagnostic(stderr.trim())}`));
      try {
        const result = parseWorkerJson(Buffer.concat(chunks).toString('utf8'));
        if (typeof result.formatted !== 'string' || typeof result.applied !== 'boolean' ||
            !(result.error === null || typeof result.error === 'string') || !Array.isArray(result.lines) ||
            result.lines.length !== result.formatted.split('\n').length ||
            !result.lines.every(line => Array.isArray(line) && line.every(span => span && typeof span.text === 'string' && TONES.has(span.tone)) &&
              line.every(span => !span.text.includes('\n')))) throw new Error('Invalid formatter response');
        if (result.lines.map(line => line.map(span => span.text).join('')).join('\n') !== result.formatted ||
            (result.applied && result.error) || (!result.applied && (!result.error || result.formatted !== original))) {
          throw new Error('Inconsistent formatter response');
        }
        finish(null, result);
      } catch (error) { finish(error); }
    });
    child.stdin.end(JSON.stringify({ source: original }));
  });
}

async function openSource(row, options = {}) {
  const preview = { path: typeof row?.sourcePath === 'string' ? row.sourcePath : null,
    original: null, formatted: null, lines: [], sha256: null,
    expectedSha256: typeof row?.sourceHash === 'string' ? row.sourceHash : null,
    changedSinceRun: null, formatter: { applied: false, error: null } };
  try {
    if (!preview.path || preview.path.includes('\0')) throw new Error('No valid declared source path');
    preview.path = path.resolve(options.cwd || process.cwd(), preview.path);
    const bytes = await readSource(preview.path, integer(options.maxBytes, 1024 * 1024, 16 * 1024 * 1024));
    preview.sha256 = createHash('sha256').update(bytes).digest('hex');
    preview.changedSinceRun = sourceHashMismatch(preview.expectedSha256, preview.sha256);
    preview.original = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    preview.formatted = preview.original;
    preview.lines = preview.original.split('\n').map(text => [{ text, tone: 'text' }]);
    const result = await formatCopy(preview.original, options);
    preview.formatted = result.formatted;
    preview.lines = result.lines;
    preview.formatter = { applied: result.applied, error: result.error };
  } catch (error) { preview.formatter.error = error.message; }
  return preview;
}

// Return every logical line; ui.scroll owns vertical offset. Width is the usable
module.exports = { openSource, readSource };

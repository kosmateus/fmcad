'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCollector } = require('../packages/node-adapters/dist/console/system-data');

test('passive metrics use real counter deltas, retain null when unmeasured, and never call SDK', () => {
  let tick = 0;
  const collector = createCollector({ now: () => tick * 1000, performance: () => tick * 1000,
    os: { platform: () => 'unsupported', hostname: () => 'test', cpus: () => [{ times: { user: tick * 50, nice: 0, sys: 0, idle: tick * 50, irq: 0 } }],
      totalmem: () => 1000, freemem: () => 0, uptime: () => 10, loadavg: () => [0, 0, 0] },
    process: { pid: 10, memoryUsage: () => ({ rss: 0 }), uptime: () => 0, cpuUsage: () => ({ user: tick * 100000, system: 0 }) },
    fs: new Proxy({}, { get() { throw new Error('Unexpected filesystem read'); } }) });
  const first = collector.read({ mode: 'direct' });
  assert.equal(first.host.cpuPercent, null);
  assert.equal(first.host.ramUsedBytes, 1000);
  assert.equal(first.panel.rssBytes, 0);
  assert.equal(first.broker.cpuPercent, null);
  assert.equal(first.locks.status, 'unknown');
  tick++;
  const second = collector.read({ mode: 'direct' });
  assert.equal(second.host.cpuPercent, 50);
  assert.equal(second.panel.cpuPercent, 10);
  assert.equal(second.host.network.rxBytesPerSecond, null);
});

test('broker metrics reject recycled PID/birth pairs instead of measuring a different process', () => {
  const stat = start => '42 (broker with spaces) S ' + Array.from({ length: 19 }, (_, i) => i === 18 ? start : '0').join(' ');
  const collector = createCollector({ os: { platform: () => 'linux', hostname: () => 'test', cpus: () => [],
    totalmem: () => 0, freemem: () => 0, uptime: () => 100, loadavg: () => [0, 0, 0] },
    process: { pid: 10, memoryUsage: () => ({ rss: 0 }), uptime: () => 0, cpuUsage: () => ({ user: 0, system: 0 }) },
    clockTicks: 100, networkInterface: 'eth0',
    fs: { readdirSync: () => [], readFileSync(file) {
      if (file.endsWith('boot_id')) return 'abcdef';
      if (file.endsWith('/stat')) return stat('999');
      return '';
    } } });
  const result = collector.read({ mode: 'broker', broker: { owner: { pid: 42, birth: 'abcdef:1' } } });
  assert.equal(result.broker.alive, false);
  assert.equal(result.broker.rssBytes, null);
  assert.equal(result.broker.cpuPercent, null);
});

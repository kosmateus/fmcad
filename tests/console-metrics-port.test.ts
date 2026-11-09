import { createRequire } from "node:module";
import path from "node:path";
const load = createRequire(
  path.join(process.cwd(), "tests/console-metrics-port.test.js"),
);
import test from "node:test";
import assert from "node:assert/strict";
const { createCollector } = load(
  "../packages/node-adapters/dist/console/system-data",
) as typeof import("../packages/node-adapters/src/console/system-data");
const { baseSnapshot } = load(
  "../packages/core/dist",
) as typeof import("@fmcad/core");
import os from "node:os";
import fs from "node:fs";
const memoryUsage = Object.assign(
  () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
  { rss: () => 0 },
);

test("passive metrics use real counter deltas, retain null when unmeasured, and never call SDK", () => {
  let tick = 0;
  const collector = createCollector({
    now: () => tick * 1000,
    performance: () => tick * 1000,
    os: {
      ...os,
      platform: () => "aix",
      hostname: () => "test",
      cpus: () => [
        {
          model: "fixture",
          speed: 0,
          times: { user: tick * 50, nice: 0, sys: 0, idle: tick * 50, irq: 0 },
        },
      ],
      totalmem: () => 1000,
      freemem: () => 0,
      uptime: () => 10,
      loadavg: () => [0, 0, 0],
    },
    process: {
      pid: 10,
      memoryUsage,
      uptime: () => 0,
      cpuUsage: () => ({ user: tick * 100000, system: 0 }),
    },
    fs: new Proxy(fs, {
      get() {
        throw new Error("Unexpected filesystem read");
      },
    }),
  });
  const first = collector.read(baseSnapshot("direct", "", 0));
  assert.equal(first.host.cpuPercent, null);
  assert.equal(first.host.ramUsedBytes, 1000);
  assert.equal(first.panel.rssBytes, 0);
  assert.equal(first.broker.cpuPercent, null);
  assert.equal(first.locks.status, "unknown");
  tick++;
  const second = collector.read(baseSnapshot("direct", "", 0));
  assert.equal(second.host.cpuPercent, 50);
  assert.equal(second.panel.cpuPercent, 10);
  assert.equal(second.host.network.rxBytesPerSecond, null);
});

test("broker metrics reject recycled PID/birth pairs instead of measuring a different process", () => {
  const stat = (start: string) =>
    "42 (broker with spaces) S " +
    Array.from({ length: 19 }, (_, i) => (i === 18 ? start : "0")).join(" ");
  const collector = createCollector({
    os: {
      ...os,
      platform: () => "linux",
      hostname: () => "test",
      cpus: () => [],
      totalmem: () => 0,
      freemem: () => 0,
      uptime: () => 100,
      loadavg: () => [0, 0, 0],
    },
    process: {
      pid: 10,
      memoryUsage,
      uptime: () => 0,
      cpuUsage: () => ({ user: 0, system: 0 }),
    },
    clockTicks: 100,
    networkInterface: "eth0",
    fs: new Proxy(fs, {
      get(_target, property) {
        if (property === "readdirSync") return () => [];
        if (property !== "readFileSync")
          throw new Error("Unexpected filesystem read");
        return (file: string) => {
          if (file.endsWith("boot_id")) return "abcdef";
          if (file.endsWith("/stat")) return stat("999");
          return "";
        };
      },
    }),
  });
  const result = collector.read({
    ...baseSnapshot("broker", "", 0),
    broker: { owner: { pid: 42, birth: "abcdef:1" } },
  });
  assert.equal(result.broker.alive, false);
  assert.equal(result.broker.rssBytes, null);
  assert.equal(result.broker.cpuPercent, null);
});

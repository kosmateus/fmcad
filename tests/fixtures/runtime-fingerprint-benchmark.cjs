"use strict";
// Read-only diagnostic. Import only the host identity reader, never a broker.
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const runtime = process.argv[2];
const count = Number(process.argv[3] || "10");
if (!path.isAbsolute(runtime || "") || !Number.isSafeInteger(count) || count < 1)
  throw Error("Pass an absolute runtime root and a positive iteration count");
const { buildHash } = require(path.join(runtime, "src/queue-instance.js"));
const started = performance.now();
const calls = [];
const immediate = new Promise((resolve) => setImmediate(() => resolve(performance.now() - started)));
for (let i = 0; i < count; i++) {
  const before = performance.now();
  const identity = buildHash();
  calls.push({ milliseconds: performance.now() - before, identity });
}
immediate.then((eventLoopDelayMs) => {
  console.log(JSON.stringify({
    runtime, count, calls, eventLoopDelayMs,
    totalMs: performance.now() - started,
    cpu: process.cpuUsage(),
    memory: process.memoryUsage(),
  }, null, 2));
});

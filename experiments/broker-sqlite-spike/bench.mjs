import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { fixture, request } from "./fixtures/harness.mjs";

export function stats(samples) {
  const sorted = samples.toSorted((a, b) => a - b);
  const quantile = (q) => sorted[Math.ceil(sorted.length * q) - 1];
  return {
    n: sorted.length,
    p50Ms: quantile(0.5),
    p95Ms: quantile(0.95),
    p99Ms: quantile(0.99),
    maxMs: sorted.at(-1),
  };
}

async function main() {
  const after = [];
  try {
    const f = await fixture((fn) => after.push(fn));
    await f.receiver();
    let broker = await f.broker({ admissionOnly: true });
    const clients = await f.clients();
    const n = 250;
    await f.admin("reset-metrics");
    await sleep(300);
    const idle = (await f.admin("metrics")).eventLoop;
    await f.admin("reset-metrics");
    const start = performance.now();
    const load = await Promise.all(
      clients.map(async (client, worker) => {
        const samples = [];
        let latest;
        for (let i = 0; i < n; i++) {
          const req = request(`${worker}-${i}`, { bytes: "x".repeat(1024), i });
          const sent = performance.now();
          latest = await client.call("submit", { request: req });
          samples.push(performance.now() - sent);
        }
        return { latest, samples };
      }),
    );
    const loadMs = performance.now() - start;
    const measured = await f.admin("metrics");
    assert.equal(measured.transactions.admit.commits, n * clients.length);
    assert.deepEqual(await f.effects(), []);
    const restarts = [];
    for (let i = 0; i < 10; i++) {
      await broker.kill();
      const began = performance.now();
      broker = await f.broker({ admissionOnly: true });
      // Open-and-serve plus read of the last previously acknowledged admission.
      for (const [index, client] of clients.entries()) {
        const { latest } = load[index];
        assert.deepEqual(
          await client.call("status", { requestId: latest.requestId }),
          latest,
        );
      }
      restarts.push(performance.now() - began);
    }
    console.log(
      JSON.stringify(
        {
          runtime: {
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            fsType: f.fsType.toString(16),
          },
          config: {
            clients: clients.length,
            admissionsPerClient: n,
            payloadStringBytes: 1024,
            admissionOnly: true,
          },
          loadMs,
          admission: stats(load.flatMap(({ samples }) => samples)),
          restart: stats(restarts),
          idleEventLoop: idle,
          loadedEventLoop: measured.eventLoop,
          sqlite: measured.settings,
          transactions: measured.transactions,
        },
        null,
        2,
      ),
    );
  } finally {
    for (const cleanup of after) await cleanup();
  }
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1])
  await main();

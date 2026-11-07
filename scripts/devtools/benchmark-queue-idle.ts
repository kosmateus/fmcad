import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { runtimeRequire } from "./runtime.js";

interface QueueStateInstance {
  file: string;
  next(): unknown;
  _commit(change: unknown): unknown;
}

interface QueueStateModule {
  QueueState: new (directory: string) => QueueStateInstance;
}

const { QueueState } = runtimeRequire(
  "../../src/queue-state.js",
) as QueueStateModule;

export interface BenchmarkResult {
  historyJobs: number;
  snapshotBytes: number;
  iterations: number;
  transactions: number;
  elapsedMs: number;
  cpuMs: number;
  meanCheckMs: number;
}

export function benchmarkQueueIdle(directory?: string): BenchmarkResult {
  const ownedDirectory = directory === undefined;
  const stateDirectory =
    directory ?? fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-idle-bench-"));
  const jobs = Object.fromEntries(
    Array.from({ length: 3500 }, (_, index) => {
      const id = `job-${index}`;
      return [
        id,
        {
          id,
          requestId: id,
          clientId: "history",
          kind: "command",
          order: index + 1,
          state: "succeeded",
          hash: "fixture",
          request: {
            requestId: id,
            clientId: "history",
            script: "x".repeat(4096),
          },
        },
      ];
    }),
  );

  try {
    const snapshot = {
      version: 1,
      paused: false,
      revision: 3500,
      epoch: 0,
      blocked: null,
      active: null,
      lease: null,
      jobs,
      lastClient: null,
    };
    fs.writeFileSync(
      path.join(stateDirectory, "queue-state.json"),
      JSON.stringify(snapshot),
    );
    const state = new QueueState(stateDirectory);
    let transactions = 0;
    const commit = state._commit.bind(state);
    state._commit = (change) => {
      transactions++;
      return commit(change);
    };
    const iterations = 30;
    const cpu = process.cpuUsage();
    const started = performance.now();
    for (let index = 0; index < iterations; index++) state.next();
    const elapsedMs = performance.now() - started;
    const used = process.cpuUsage(cpu);
    return {
      historyJobs: 3500,
      snapshotBytes: fs.statSync(state.file).size,
      iterations,
      transactions,
      elapsedMs,
      cpuMs: (used.user + used.system) / 1000,
      meanCheckMs: elapsedMs / iterations,
    };
  } finally {
    if (ownedDirectory)
      fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
}

export function main(args: string[]): void {
  void args;
  console.log(JSON.stringify(benchmarkQueueIdle(), null, 2));
}

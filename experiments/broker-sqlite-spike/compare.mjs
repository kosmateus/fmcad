import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, statfs } from "node:fs/promises";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import {
  setImmediate as yieldTurn,
  setTimeout as sleep,
} from "node:timers/promises";
import { stats } from "./bench.mjs";
import { fixture, request } from "./fixtures/harness.mjs";
import { store } from "./store.mjs";

// Read an immutable source export, never a runtime, active store, or mutable peer build.
const [ref] = process.argv.slice(2);
if (!ref) throw new Error("Usage: npm run compare -- <git-ref>");
const git = (args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const root = git(["rev-parse", "--show-toplevel"]);
const sha = git([
  "rev-parse",
  "--verify",
  "--end-of-options",
  `${ref}^{commit}`,
]);
const cleanup = [];
try {
  const f = await fixture((fn) => cleanup.push(fn)); // local filesystem validation and private directory
  const source = await mkdtemp(join(f.dir, "reference-"));
  const refFiles = [
    "packages/core/src",
    "packages/node-adapters/src/persistence/records.ts",
  ];
  const archive = execFileSync("git", ["archive", sha, ...refFiles], {
    cwd: root,
    maxBuffer: 32 * 1024 * 1024,
  });
  execFileSync("tar", ["-xf", "-", "-C", source], { input: archive });
  const prefix = pathToFileURL(`${source}/`).href;
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (
        context.parentURL?.startsWith(prefix) &&
        specifier.startsWith(".") &&
        !specifier.endsWith(".ts")
      ) {
        return next(`${specifier}.ts`, context);
      }
      return next(specifier, context);
    },
  });
  const { QueueDomain, canonical } = await import(
    new URL("packages/core/src/domain/queue.ts", prefix)
  );
  const { createSnapshotStore } = await import(
    new URL("packages/node-adapters/src/persistence/records.ts", prefix)
  );
  hooks.deregister();
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

  function openReference(dir, accounting) {
    const persistence = createSnapshotStore(dir);
    const original = persistence.restore();
    return new QueueDomain({
      snapshot: original ? JSON.parse(original) : undefined,
      now: Date.now,
      newId: randomUUID,
      hash: digest,
      commit(snapshot) {
        const start = performance.now();
        persistence.commit(JSON.stringify(snapshot));
        accounting.commits++;
        accounting.totalMs += performance.now() - start;
      },
    });
  }
  async function measure(label, seed, prepare) {
    const operation = prepare();
    const input = (i) => request(`same-${i}`, { bytes: "x".repeat(1024), i });
    function add(i) {
      const req = input(i);
      const start = performance.now();
      const admitted = operation.submit(req);
      const latency = performance.now() - start;
      operation.cancel(admitted.id, req.requestId);
      return { hash: admitted.hash, latency };
    }
    for (let i = 0; i < seed; i++) add(i);
    const samples = [];
    const loop = monitorEventLoopDelay({ resolution: 1 });
    loop.enable();
    await sleep(50);
    loop.reset();
    const util = performance.eventLoopUtilization();
    const before = operation.writes();
    for (let i = seed; i < seed + 150; i++) {
      const { hash, latency } = add(i);
      assert.equal(hash, digest(operation.canonical(input(i))));
      samples.push(latency);
      await yieldTurn();
    }
    const after = operation.writes();
    const eventLoop = {
      samples: loop.count,
      p99Ms: loop.percentile(99) / 1e6,
      maxMs: loop.max / 1e6,
      utilization: performance.eventLoopUtilization(util).utilization,
    };
    loop.disable();
    const begin = performance.now();
    operation.reopen(input(seed + 149));
    return {
      label,
      seed,
      admission: stats(samples),
      eventLoop,
      writes: {
        commits: after.commits - before.commits,
        totalMs: after.totalMs - before.totalMs,
      },
      singleSameProcessReopenMs: performance.now() - begin,
    };
  }

  const comparisons = [];
  for (const seed of [0, 512]) {
    const snapshotDir = join(f.dir, `snapshot-${seed}`);
    const accounting = { commits: 0, totalMs: 0 };
    comparisons.push(
      await measure("reference QueueDomain + snapshot", seed, () => {
        const queue = openReference(snapshotDir, accounting);
        let last;
        return {
          canonical: (req) => canonical({ ...req, clientId: "alice" }),
          submit(req) {
            const admitted = queue.submit({ ...req, clientId: "alice" });
            last = admitted.id;
            return { id: last, hash: queue.data.jobs[last].hash };
          },
          cancel: (id) => queue.cancel(id, "alice"),
          writes: () => ({ ...accounting }),
          reopen(req) {
            const restored = openReference(snapshotDir, accounting).status(
              last,
            );
            assert.equal(restored.requestId, req.requestId);
            assert.equal(restored.state, "cancelled");
          },
        };
      }),
    );
    comparisons.push(
      await measure("spike SQLite broker store", seed, () => {
        const path = join(f.dir, `sqlite-${seed}.db`);
        const db = store(path, () => {});
        db.boot();
        let last;
        return {
          canonical: (req) => canonical({ ...req, clientId: "alice" }),
          submit(req) {
            const admitted = db.admit("alice", req);
            last = admitted.id;
            return admitted;
          },
          cancel: (_id, requestId) => db.cancel("alice", requestId),
          writes() {
            return Object.values(db.transactions).reduce(
              (out, entry) => ({
                commits: out.commits + entry.commits,
                totalMs: out.totalMs + entry.totalMs,
              }),
              { commits: 0, totalMs: 0 },
            );
          },
          reopen(req) {
            const reopened = store(path, () => {});
            reopened.boot();
            const restored = reopened.owned("alice", req.requestId);
            assert.equal(restored.id, last);
            assert.equal(restored.state, "not_started");
          },
        };
      }),
    );
  }
  console.log(
    JSON.stringify(
      {
        ref: sha,
        runtime: process.version,
        fsType: (await statfs(f.dir)).type,
        note: "Same inputs and filesystem; differing state/policies, no IPC, no receiver, not whole-broker parity.",
        comparisons,
      },
      null,
      2,
    ),
  );
} finally {
  for (const fn of cleanup) await fn();
}

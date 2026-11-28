import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";

const repo = process.cwd();
const load = createRequire(
  path.join(repo, "tests/retained-worker-freeze.test.ts"),
);
const { inspectMetadataWorkerProcess } = load(
  "../dist/src/dist/composition/queue-epoch-successor-retirement.js",
) as typeof import("../src/composition/queue-epoch-successor-retirement");
const api = load("../src/queue-instance") as {
  processBirth(pid?: number): string | null;
};
const protectedPids = new Set([267219, 33684, 122815]);

type Reference = { path: string; sha256: string };
type Inventory = Array<{ path: string; entries: string[] }>;
type ProcessResult = ReturnType<typeof inspectMetadataWorkerProcess>;
type OwnedChild = {
  child: ChildProcess;
  pid: number;
  birth: string;
  exe: string;
};

interface WorkerFixture {
  base: string;
  runtime: string;
  workerPath: string;
  readyPath: string;
  childPidPath: string;
  portPath: string;
  acceptedPath: string;
  worker: ChildProcess;
  owner: {
    pid: number;
    birth: string;
    nonce: string;
    protocol: number;
  };
  refs: Reference[];
  ownedChildren: OwnedChild[];
  externalCleanups: Array<() => void | Promise<void>>;
}

const workerSource = `
const fs = require("node:fs");
const net = require("node:net");
const readline = require("node:readline");
const { spawn } = require("node:child_process");
let server;
fs.writeFileSync(process.env.FREEZE_READY_PATH, "ready");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (line === "spawn-child") {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    fs.writeFileSync(process.env.FREEZE_CHILD_PATH, String(child.pid));
  }
  if (line === "listen") {
    server = net.createServer(() => {
      fs.writeFileSync(process.env.FREEZE_ACCEPTED_PATH, "accepted");
    });
    server.listen(0, "127.0.0.1", () => {
      fs.writeFileSync(
        process.env.FREEZE_PORT_PATH,
        String(server.address().port),
      );
    });
  }
});
setInterval(() => {}, 1000);
`;

function sha256(file: string) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function references(files: string[]): Reference[] {
  return files.map((file) => ({ path: file, sha256: sha256(file) }));
}

function procStat(pid: number, task = "") {
  const file = task ? `/proc/${pid}/task/${task}/stat` : `/proc/${pid}/stat`;
  const raw = fs.readFileSync(file, "utf8");
  const fields = raw
    .slice(raw.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/);
  return { state: fields[0], ppid: Number(fields[1]) };
}

function threadStates(pid: number) {
  return fs
    .readdirSync(`/proc/${pid}/task`)
    .filter((tid) => /^\d+$/.test(tid))
    .map((tid) => ({ tid, state: procStat(pid, tid).state }));
}

function socketFds(pid: number) {
  return fs.readdirSync(`/proc/${pid}/fd`).flatMap((fd) => {
    try {
      const target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
      return target.startsWith("socket:[") ? [{ fd, target }] : [];
    } catch {
      return [];
    }
  });
}

function assertOnlyStdinSocket(pid: number, socketRows: string[]) {
  const sockets = socketFds(pid);
  assert.deepEqual(
    sockets.map((socket) => socket.fd),
    ["0"],
  );
  const inode = sockets[0]?.target.match(/^socket:\[(\d+)\]$/)?.[1];
  assert.ok(inode);
  assert.equal(socketRows.length, 1);
  assert.equal(socketRows[0]?.trim().split(/\s+/).at(-1), inode);
}

function assertAllThreadsStopped(pid: number) {
  const threads = threadStates(pid);
  assert.ok(threads.length > 0);
  assert.ok(threads.every((thread) => thread.state === "T"));
  return threads;
}

function safeBirth(pid: number) {
  try {
    return api.processBirth(pid);
  } catch {
    return null;
  }
}

function safeExe(pid: number) {
  try {
    return fs.realpathSync(`/proc/${pid}/exe`);
  } catch {
    return null;
  }
}

function identityMatches(owned: OwnedChild) {
  return (
    safeBirth(owned.pid) === owned.birth && safeExe(owned.pid) === owned.exe
  );
}

async function waitUntil(
  predicate: () => boolean,
  description: string,
  timeoutMs = 5000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

async function waitForExit(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await once(child, "exit");
}

function signalOwned(owned: OwnedChild, signal: NodeJS.Signals) {
  if (protectedPids.has(owned.pid) || !identityMatches(owned)) return false;
  process.kill(owned.pid, signal);
  return true;
}

async function cleanOwned(owned: OwnedChild) {
  if (identityMatches(owned)) {
    try {
      if (["T", "t"].includes(procStat(owned.pid).state ?? ""))
        signalOwned(owned, "SIGCONT");
      signalOwned(owned, "SIGKILL");
    } catch {
      // The owned process may have exited between the identity check and read.
    }
  }
  await waitForExit(owned.child);
}

async function startWorker(t: TestContext): Promise<WorkerFixture> {
  const base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "retained-worker-freeze-")),
  );
  const runtime = path.join(base, "runtime");
  const workerPath = path.join(runtime, "src/queue-epoch-successor-worker.js");
  const readyPath = path.join(base, "ready");
  const childPidPath = path.join(base, "child.pid");
  const portPath = path.join(base, "port");
  const acceptedPath = path.join(base, "accepted");
  fs.mkdirSync(path.dirname(workerPath), { recursive: true });
  fs.writeFileSync(workerPath, workerSource);

  const worker = spawn(process.execPath, [workerPath], {
    cwd: base,
    env: {
      ...process.env,
      FREEZE_READY_PATH: readyPath,
      FREEZE_CHILD_PATH: childPidPath,
      FREEZE_PORT_PATH: portPath,
      FREEZE_ACCEPTED_PATH: acceptedPath,
    },
    stdio: ["pipe", "ignore", "ignore"],
  });
  await once(worker, "spawn");
  assert.ok(worker.pid);
  assert.ok(!protectedPids.has(worker.pid));
  await waitUntil(() => fs.existsSync(readyPath), "synthetic worker startup");
  const birth = api.processBirth(worker.pid);
  assert.ok(birth);
  const owner: WorkerFixture["owner"] = {
    pid: worker.pid,
    birth,
    nonce: randomUUID(),
    protocol: 2,
  };
  const owned: OwnedChild = {
    child: worker,
    pid: worker.pid,
    birth,
    exe: fs.realpathSync(process.execPath),
  };
  const fixture: WorkerFixture = {
    base,
    runtime,
    workerPath,
    readyPath,
    childPidPath,
    portPath,
    acceptedPath,
    worker,
    owner,
    refs: references([workerPath]),
    ownedChildren: [owned],
    externalCleanups: [],
  };
  t.after(async () => {
    for (const cleanup of fixture.externalCleanups.reverse()) await cleanup();
    if (fs.existsSync(childPidPath)) {
      const pid = Number(fs.readFileSync(childPidPath, "utf8"));
      if (Number.isSafeInteger(pid) && procParentIs(pid, owner.pid)) {
        const birth = safeBirth(pid);
        const exe = safeExe(pid);
        if (birth && exe) {
          const child = { child: worker, pid, birth, exe };
          signalOwned(child, "SIGKILL");
          await waitUntil(
            () => safeBirth(pid) !== birth,
            "owned descendant exit",
          );
        }
      }
    }
    await cleanOwned(owned);
    fs.rmSync(base, { recursive: true, force: true });
  });
  return fixture;
}

function procParentIs(pid: number, parentPid: number) {
  try {
    return procStat(pid).ppid === parentPid;
  } catch {
    return false;
  }
}

function inspect(
  fixture: WorkerFixture,
  refs = fixture.refs,
  inventory: Inventory = [],
) {
  return inspectMetadataWorkerProcess(
    fixture.owner,
    fixture.runtime,
    refs,
    false,
    fixture.base,
    inventory,
  );
}

function withProof(fixture: WorkerFixture, proof: ProcessResult) {
  assert.ok(proof.interpreter);
  return {
    ...fixture.owner,
    processProof: proof.process,
    interpreterProof: proof.interpreter,
  };
}

function freeze(
  fixture: WorkerFixture,
  proof: ProcessResult,
  refs = fixture.refs,
  inventory: Inventory = [],
) {
  return inspectMetadataWorkerProcess(
    withProof(fixture, proof),
    fixture.runtime,
    refs,
    false,
    fixture.base,
    inventory,
    "freeze",
  );
}

function retireFrozen(
  fixture: WorkerFixture,
  proof: ProcessResult,
  refs = fixture.refs,
  inventory: Inventory = [],
) {
  return inspectMetadataWorkerProcess(
    withProof(fixture, proof),
    fixture.runtime,
    refs,
    true,
    fixture.base,
    inventory,
    "retire-frozen",
  );
}

function assertUnproven(callback: () => unknown) {
  assert.throws(callback, { code: "SDK1_METADATA_RETIREMENT_UNPROVEN" });
}

const linuxOnly = process.platform !== "linux";

test(
  "inspect phase is read-only for an exact owned SDK-free Node process",
  { skip: linuxOnly },
  async (t) => {
    const fixture = await startWorker(t);
    const result = inspect(fixture);
    assert.equal(result.retired, false);
    assert.equal(result.frozen, undefined);
    assert.equal(result.process.pid, fixture.owner.pid);
    assert.equal(result.process.birth, fixture.owner.birth);
    assert.equal(result.process.exe, fs.realpathSync(process.execPath));
    assert.deepEqual(result.process.cmdline, [
      fs.realpathSync(process.execPath),
      fixture.workerPath,
    ]);
    assert.equal(
      result.process.exeSha256,
      sha256(fs.realpathSync(process.execPath)),
    );
    assert.ok(
      Object.values(result.process.childrenByTask).every(
        (rows) => rows.length === 0,
      ),
    );
    assertOnlyStdinSocket(fixture.owner.pid, result.process.socketRows);
    assert.equal(result.interpreter?.path, fs.realpathSync("/usr/bin/python3"));
    assert.notEqual(procStat(fixture.owner.pid).state, "T");
    assert.equal(safeBirth(fixture.owner.pid), fixture.owner.birth);
    t.diagnostic(
      JSON.stringify({
        node: process.version,
        phase: "inspect",
        pid: fixture.owner.pid,
        birth: result.process.birth,
        exe: result.process.exe,
        cmdline: result.process.cmdline,
        childrenByTask: result.process.childrenByTask,
        socketRows: result.process.socketRows,
        retired: result.retired,
        frozen: result.frozen ?? false,
      }),
    );
  },
);

test(
  "exact inspect to freeze to retire-frozen uses observed SIGSTOP and SIGKILL phases",
  { skip: linuxOnly },
  async (t) => {
    const fixture = await startWorker(t);
    const stateDir = path.join(fixture.base, "append-only-state");
    fs.mkdirSync(stateDir);
    fs.writeFileSync(
      path.join(stateDir, "before.json"),
      '{"phase":"before"}\n',
    );
    const inventory = [{ path: stateDir, entries: ["before.json"] }];
    const inspected = inspect(fixture, fixture.refs, inventory);
    assert.notEqual(procStat(fixture.owner.pid).state, "T");

    const frozen = freeze(fixture, inspected, fixture.refs, inventory);
    assert.equal(frozen.frozen, true);
    assert.equal(frozen.retired, false);
    assert.equal(frozen.process.birth, fixture.owner.birth);
    const stopped = assertAllThreadsStopped(fixture.owner.pid);
    assert.ok(
      Object.values(frozen.process.childrenByTask).every(
        (rows) => rows.length === 0,
      ),
    );
    assertOnlyStdinSocket(fixture.owner.pid, frozen.process.socketRows);
    assert.equal(safeBirth(fixture.owner.pid), fixture.owner.birth);

    const exited = once(fixture.worker, "exit");
    const retired = retireFrozen(fixture, frozen, fixture.refs, inventory);
    assert.equal(retired.retired, true);
    const [code, signal] = await exited;
    assert.equal(code, null);
    assert.equal(signal, "SIGKILL");
    t.diagnostic(
      JSON.stringify({
        node: process.version,
        phaseSequence: ["inspect", "freeze", "retire-frozen"],
        pid: fixture.owner.pid,
        birth: fixture.owner.birth,
        frozenThreads: stopped,
        freeze: { frozen: frozen.frozen, retired: frozen.retired },
        retire: { retired: retired.retired, signal },
        inventory: fs.readdirSync(stateDir).sort(),
        sdkRequestsSent: 0,
        productionSignals: 0,
      }),
    );
  },
);

test(
  "stale birth proof for a live PID refuses before any phase signal",
  { skip: linuxOnly },
  async (t) => {
    const fixture = await startWorker(t);
    const staleOwner = {
      ...fixture.owner,
      birth: `${fixture.owner.birth}-stale`,
    };
    assert.throws(
      () =>
        inspectMetadataWorkerProcess(
          staleOwner,
          fixture.runtime,
          fixture.refs,
          false,
          fixture.base,
        ),
      { code: "SDK1_METADATA_RETIREMENT_UNPROVEN" },
    );
    assert.equal(safeBirth(fixture.owner.pid), fixture.owner.birth);
    assert.notEqual(procStat(fixture.owner.pid).state, "T");
    assert.equal(fixture.worker.exitCode, null);
    t.diagnostic(
      JSON.stringify({
        node: process.version,
        staleBirthRejected: true,
        pid: fixture.owner.pid,
        liveBirth: fixture.owner.birth,
        suppliedBirth: staleOwner.birth,
        processStillRunning: true,
      }),
    );
  },
);

test(
  "a process with a different executable is rejected without signaling it",
  { skip: linuxOnly },
  async (t) => {
    const fixture = await startWorker(t);
    const child = spawn(
      "/usr/bin/python3",
      ["-I", "-c", "import time; time.sleep(60)"],
      {
        stdio: "ignore",
      },
    );
    await once(child, "spawn");
    assert.ok(child.pid);
    assert.ok(!protectedPids.has(child.pid));
    const birth = api.processBirth(child.pid);
    assert.ok(birth);
    const exe = safeExe(child.pid);
    assert.ok(exe);
    assert.notEqual(exe, fs.realpathSync(process.execPath));
    const foreign = { child, pid: child.pid, birth, exe };
    fixture.ownedChildren.push(foreign);
    fixture.externalCleanups.push(() => cleanOwned(foreign));
    const foreignOwner = {
      pid: child.pid,
      birth,
      nonce: randomUUID(),
      protocol: 2,
    };

    assertUnproven(() =>
      inspectMetadataWorkerProcess(
        foreignOwner,
        fixture.runtime,
        fixture.refs,
        false,
        fixture.base,
      ),
    );
    assert.equal(safeBirth(child.pid), birth);
    assert.equal(safeExe(child.pid), exe);
    assert.equal(child.exitCode, null);
    t.diagnostic(
      JSON.stringify({
        node: process.version,
        wrongExecutableRejected: true,
        pid: child.pid,
        observedExe: exe,
        expectedNodeExe: fs.realpathSync(process.execPath),
        processStillRunning: true,
      }),
    );
  },
);

test(
  "a child spawned after inspect blocks freeze and remains owned for guarded cleanup",
  { skip: linuxOnly },
  async (t) => {
    const fixture = await startWorker(t);
    const inspected = inspect(fixture);
    fixture.worker.stdin?.write("spawn-child\n");
    await waitUntil(
      () => fs.existsSync(fixture.childPidPath),
      "synthetic worker child spawn",
    );
    const childPid = Number(fs.readFileSync(fixture.childPidPath, "utf8"));
    assert.ok(Number.isSafeInteger(childPid) && childPid > 1);
    assert.ok(!protectedPids.has(childPid));
    assert.equal(procStat(childPid).ppid, fixture.owner.pid);

    assertUnproven(() => freeze(fixture, inspected));
    assert.notEqual(procStat(fixture.owner.pid).state, "T");
    assert.equal(safeBirth(fixture.owner.pid), fixture.owner.birth);
    assert.equal(procStat(childPid).ppid, fixture.owner.pid);
    t.diagnostic(
      JSON.stringify({
        node: process.version,
        childSpawnRejected: true,
        workerPid: fixture.owner.pid,
        childPid,
        workerStillRunning: true,
        sdkRequestsSent: 0,
      }),
    );
  },
);

test(
  "a late loopback client makes freeze refuse before stopping the worker",
  { skip: linuxOnly },
  async (t) => {
    const fixture = await startWorker(t);
    const inspected = inspect(fixture);
    fixture.worker.stdin?.write("listen\n");
    await waitUntil(
      () => fs.existsSync(fixture.portPath),
      "owned loopback listener",
    );
    const port = Number(fs.readFileSync(fixture.portPath, "utf8"));
    const client = net.connect(port, "127.0.0.1");
    fixture.externalCleanups.push(() => {
      client.destroy();
    });
    await once(client, "connect");
    await waitUntil(
      () => fs.existsSync(fixture.acceptedPath),
      "late client acceptance",
    );

    const sockets = socketFds(fixture.owner.pid);
    assert.ok(sockets.length > 0);
    assertUnproven(() => freeze(fixture, inspected));
    assert.notEqual(procStat(fixture.owner.pid).state, "T");
    assert.equal(safeBirth(fixture.owner.pid), fixture.owner.birth);
    assert.equal(fixture.worker.exitCode, null);
    t.diagnostic(
      JSON.stringify({
        node: process.version,
        lateClientRejected: true,
        pid: fixture.owner.pid,
        workerSocketFds: sockets.length,
        processStillRunning: true,
        noFusionHttp: true,
      }),
    );
  },
);

test(
  "changed reference bytes refuse freeze without mutating the owned process",
  { skip: linuxOnly },
  async (t) => {
    const fixture = await startWorker(t);
    const inspected = inspect(fixture);
    fs.appendFileSync(fixture.workerPath, "// changed after inspect\n");
    assert.notEqual(sha256(fixture.workerPath), fixture.refs[0]?.sha256);

    assertUnproven(() => freeze(fixture, inspected));
    assert.notEqual(procStat(fixture.owner.pid).state, "T");
    assert.equal(safeBirth(fixture.owner.pid), fixture.owner.birth);
    assert.equal(fixture.worker.exitCode, null);
    t.diagnostic(
      JSON.stringify({
        node: process.version,
        referenceHashTamperRejected: true,
        pid: fixture.owner.pid,
        processStillRunning: true,
      }),
    );
  },
);

test(
  "partial rollback-pending persistence changes inventory and blocks freeze",
  { skip: linuxOnly },
  async (t) => {
    const fixture = await startWorker(t);
    const stateDir = path.join(fixture.base, "append-only-state");
    fs.mkdirSync(stateDir);
    fs.writeFileSync(
      path.join(stateDir, "before.json"),
      '{"phase":"before"}\n',
    );
    const inventory = [{ path: stateDir, entries: ["before.json"] }];
    const inspected = inspect(fixture, fixture.refs, inventory);
    const pendingPath = path.join(stateDir, "rollback-pending.json");
    fs.writeFileSync(pendingPath, '{"phase":"rollback-pending"}\n');

    assertUnproven(() => freeze(fixture, inspected, fixture.refs, inventory));
    assert.deepEqual(fs.readdirSync(stateDir).sort(), [
      "before.json",
      "rollback-pending.json",
    ]);
    assert.equal(
      fs.readFileSync(pendingPath, "utf8"),
      '{"phase":"rollback-pending"}\n',
    );
    assert.notEqual(procStat(fixture.owner.pid).state, "T");
    assert.equal(safeBirth(fixture.owner.pid), fixture.owner.birth);
    t.diagnostic(
      JSON.stringify({
        node: process.version,
        inventoryChanged: true,
        partialPersistencePreserved: true,
        rollbackPendingPreserved: true,
        freezeEffectPerformed: false,
        pid: fixture.owner.pid,
      }),
    );
  },
);

test(
  "freeze failure after SIGSTOP leaves a suspicious worker stopped and alive",
  { skip: linuxOnly },
  async (t) => {
    const fixture = await startWorker(t);
    const stateDir = path.join(fixture.base, "append-only-state");
    fs.mkdirSync(stateDir);
    fs.writeFileSync(
      path.join(stateDir, "before.json"),
      '{"phase":"before"}\n',
    );
    const inventory = [{ path: stateDir, entries: ["before.json"] }];
    const fillerPath = path.join(fixture.base, "hash-window.bin");
    fs.writeFileSync(fillerPath, "");
    fs.truncateSync(fillerPath, 96 * 1024 * 1024);
    const refs = references([fixture.workerPath, fillerPath]);
    const inspected = inspect(fixture, refs, inventory);
    const readyPath = path.join(fixture.base, "watcher-ready");
    const donePath = path.join(fixture.base, "watcher-done");
    const watcherSource = `
const fs = require("node:fs");
const path = require("node:path");
const pid = Number(process.argv[1]);
const directory = process.argv[2];
const ready = process.argv[3];
const done = process.argv[4];
fs.writeFileSync(ready, "ready\\n");
const deadline = Date.now() + 15000;
while (Date.now() < deadline) {
  try {
    const tasks = fs.readdirSync("/proc/" + pid + "/task");
    const stopped = tasks.length > 0 && tasks.every((tid) => {
      const raw = fs.readFileSync("/proc/" + pid + "/task/" + tid + "/stat", "utf8");
      return raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\\s+/)[0] === "T";
    });
    if (stopped) {
      fs.writeFileSync(path.join(directory, "rollback-pending.json"), '{"phase":"rollback-pending"}');
      fs.writeFileSync(done, "written");
      process.exit(0);
    }
  } catch {}
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
}
fs.writeFileSync(done, "timeout");
process.exit(2);
`;
    const watcher = spawn(
      process.execPath,
      [
        "-e",
        watcherSource,
        String(fixture.owner.pid),
        stateDir,
        readyPath,
        donePath,
      ],
      { stdio: "ignore" },
    );
    await once(watcher, "spawn");
    assert.ok(watcher.pid);
    assert.ok(!protectedPids.has(watcher.pid));
    const watcherBirth = api.processBirth(watcher.pid);
    assert.ok(watcherBirth);
    const watcherOwner = {
      child: watcher,
      pid: watcher.pid,
      birth: watcherBirth,
      exe: fs.realpathSync(process.execPath),
    };
    fixture.externalCleanups.push(() => cleanOwned(watcherOwner));
    await waitUntil(
      () => fs.existsSync(readyPath),
      "stopped-state watcher startup",
    );

    assertUnproven(() => freeze(fixture, inspected, refs, inventory));
    await waitUntil(
      () => fs.existsSync(donePath),
      "post-SIGSTOP inventory mutation",
    );
    assert.equal(fs.readFileSync(donePath, "utf8"), "written");
    await waitForExit(watcher);
    const stopped = assertAllThreadsStopped(fixture.owner.pid);
    assert.equal(safeBirth(fixture.owner.pid), fixture.owner.birth);
    assert.equal(fixture.worker.exitCode, null);
    assert.equal(
      fs.existsSync(path.join(stateDir, "rollback-pending.json")),
      true,
    );
    t.diagnostic(
      JSON.stringify({
        node: process.version,
        freezeRejectedAfterEffect: true,
        postStopInventoryMutationObserved: true,
        allTargetThreadsStopped: true,
        stoppedThreads: stopped,
        targetStillAlive: true,
        automaticSigcontObserved: false,
        automaticSigkillObserved: false,
        cleanupWillOnlySignalOwnedPidBirth: true,
        pid: fixture.owner.pid,
        birth: fixture.owner.birth,
      }),
    );
  },
);

test(
  "already-stopped stale phase refuses without automatic SIGCONT or SIGKILL",
  { skip: linuxOnly },
  async (t) => {
    const fixture = await startWorker(t);
    const inspected = inspect(fixture);
    const owned = fixture.ownedChildren[0];
    assert.ok(owned);
    assert.equal(signalOwned(owned, "SIGSTOP"), true);
    await waitUntil(() => {
      try {
        const threads = threadStates(fixture.owner.pid);
        return (
          threads.length > 0 && threads.every((thread) => thread.state === "T")
        );
      } catch {
        return false;
      }
    }, "test-owned worker SIGSTOP");

    assertUnproven(() => freeze(fixture, inspected));
    const stopped = assertAllThreadsStopped(fixture.owner.pid);
    assert.equal(safeBirth(fixture.owner.pid), fixture.owner.birth);
    assert.equal(fixture.worker.exitCode, null);
    t.diagnostic(
      JSON.stringify({
        node: process.version,
        priorStopRefused: true,
        automaticSigcontObserved: false,
        automaticSigkillObserved: false,
        cleanupWillOnlySignalOwnedPidBirth: true,
        pid: fixture.owner.pid,
        birth: fixture.owner.birth,
        stoppedThreads: stopped,
      }),
    );
  },
);

test(
  "retire-frozen refuses changed evidence and leaves the exact worker stopped",
  { skip: linuxOnly },
  async (t) => {
    const fixture = await startWorker(t);
    const evidencePath = path.join(fixture.base, "phase-proof.json");
    fs.writeFileSync(evidencePath, '{"phase":"inspected"}\n');
    const refs = references([fixture.workerPath, evidencePath]);
    const inspected = inspect(fixture, refs);
    const frozen = freeze(fixture, inspected, refs);
    assert.equal(frozen.frozen, true);
    const stoppedBeforeRefusal = assertAllThreadsStopped(fixture.owner.pid);

    fs.writeFileSync(evidencePath, '{"phase":"partial-persistence"}\n');
    assertUnproven(() => retireFrozen(fixture, frozen, refs));
    const stoppedAfterRefusal = assertAllThreadsStopped(fixture.owner.pid);
    assert.equal(safeBirth(fixture.owner.pid), fixture.owner.birth);
    assert.equal(fixture.worker.exitCode, null);
    assert.equal(
      fs.readFileSync(evidencePath, "utf8"),
      '{"phase":"partial-persistence"}\n',
    );
    t.diagnostic(
      JSON.stringify({
        node: process.version,
        retireFrozenRefused: true,
        suspiciousEvidencePreserved: true,
        allTargetThreadsRemainStopped: true,
        targetStillAlive: true,
        automaticSigcontObserved: false,
        automaticSigkillObserved: false,
        cleanupWillOnlySignalOwnedPidBirth: true,
        pid: fixture.owner.pid,
        birth: fixture.owner.birth,
        stoppedThreadsBefore: stoppedBeforeRefusal,
        stoppedThreadsAfter: stoppedAfterRefusal,
      }),
    );
  },
);

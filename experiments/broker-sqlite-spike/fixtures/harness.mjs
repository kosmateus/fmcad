import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  statfs,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { ask } from "../wire.mjs";

const processFile = new URL("./process.mjs", import.meta.url);

function start(role, config) {
  const child = fork(processFile, [role, JSON.stringify(config)], {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  const events = [];
  const subscriptions = new Set();
  let nextId = 0;
  const wait = (predicate) => {
    const existing = events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const listener = (event) => {
        if (!predicate(event) && event.kind !== "exit") return;
        clearTimeout(timer);
        subscriptions.delete(listener);
        if (predicate(event)) resolve(event);
        else
          reject(
            new Error(`${role} ${child.pid} exited: ${JSON.stringify(event)}`),
          );
      };
      const timer = setTimeout(() => {
        subscriptions.delete(listener);
        reject(
          new Error(
            `Timed out for ${role} ${child.pid}; events: ${events
              .slice(-8)
              .map(
                ({ kind, key, value }) =>
                  `${kind} ${key ?? value?.requestId ?? ""}`,
              )
              .join(", ")}`,
          ),
        );
      }, 6_000);
      subscriptions.add(listener);
      const exit = events.find(({ kind }) => kind === "exit");
      if (exit) listener(exit);
    });
  };
  function publish(event) {
    events.push(event);
    for (const listener of subscriptions) listener(event);
  }
  child.on("message", publish);
  child.on("exit", (code, signal) => publish({ kind: "exit", code, signal }));
  return {
    pid: child.pid,
    events,
    wait,
    at: (key) => wait((event) => event.kind === "gate" && event.key === key),
    release: (release) => child.send({ release }),
    async kill() {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      return wait(({ kind }) => kind === "exit");
    },
    async call(op, args, timeoutMs) {
      const id = ++nextId;
      child.send({ id, op, args, timeoutMs });
      const { error, value } = await wait(
        (event) => event.kind === "reply" && event.id === id,
      );
      if (error) throw Object.assign(new Error(error), { code: error });
      return value;
    },
  };
}

export async function fixture(after) {
  const base = process.env.SPIKE_TMP ?? join(tmpdir(), "fmcad-sqlite-spike");
  await mkdir(base, { recursive: true, mode: 0o700 });
  const { type } = await statfs(base);
  // Overlay, ext4, XFS, btrfs, ZFS and tmpfs only; no DrvFS/9p, CIFS or NFS.
  if (
    process.platform !== "linux" ||
    ![
      0x794c7630, 0xef53, 0x58465342, 0x9123683e, 0x2fc12fc1, 0x1021994,
    ].includes(type >>> 0)
  ) {
    throw new Error(`Use local Linux storage for the spike (statfs: ${type})`);
  }
  const dir = await mkdtemp(join(base, "queue-"));
  const effectsFile = join(dir, "effects.jsonl");
  await writeFile(effectsFile, "");
  const brokerPath = `\0sqlite-broker-${randomUUID()}`;
  const receiverPath = `\0sqlite-receiver-${randomUUID()}`;
  const admin = randomUUID();
  const dispatch = randomUUID();
  const owners = { [randomUUID()]: "alice", [randomUUID()]: "bob" };
  const [alice, bob] = Object.keys(owners);
  const credentials = { alice, bob };
  const common = {
    admin,
    dispatch,
    instance: "fake-local",
    build: "fake-build",
    source: "fake-source",
  };
  const brokerFile = join(dir, "broker.sqlite");
  const processes = [];
  function spawn(role, config) {
    const peer = start(role, config);
    processes.push(peer);
    return peer;
  }
  after(async () => {
    await Promise.all(processes.map((peer) => peer.kill()));
    await rm(dir, { recursive: true });
  });
  const ready = async (peer) => {
    await peer.wait(({ kind }) => kind === "ready");
    return peer;
  };
  const startBroker = (extra) =>
    spawn("broker", {
      ...common,
      socket: brokerPath,
      receiver: receiverPath,
      owners,
      database: brokerFile,
      ...extra,
    });
  return {
    dir,
    brokerPath,
    startBroker,
    broker: (extra) => ready(startBroker(extra)),
    receiver: (extra) =>
      ready(
        spawn("receiver", {
          ...common,
          socket: receiverPath,
          database: join(dir, "receiver.sqlite"),
          effects: effectsFile,
          ...extra,
        }),
      ),
    clients: (names = ["alice", "bob"]) =>
      Promise.all(
        names.map((name) =>
          ready(
            spawn("client", { token: credentials[name], socket: brokerPath }),
          ),
        ),
      ),
    lockWriter: () => ready(spawn("lock", { database: brokerFile })),
    admin: (op, args) => ask(brokerPath, { op, token: admin, ...args }),
    receiverAdmin: (op, args) =>
      ask(receiverPath, { op, secret: admin, ...args }),
    sendReceiver: (op, call) =>
      ask(receiverPath, { op, secret: dispatch, call }),
    effects: async () =>
      (await readFile(effectsFile, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse),
    fsType: type >>> 0,
  };
}

export function request(requestId, payload = { variant: 1 }) {
  return { requestId, kind: "rpc", timeoutMs: 5_000, payload };
}

export async function until(action, predicate) {
  const end = performance.now() + 3_000;
  let value;
  do {
    value = await action();
    if (predicate(value)) return value;
    await sleep(10);
  } while (performance.now() < end);
  throw new Error(`Unexpected final value ${JSON.stringify(value)}`);
}

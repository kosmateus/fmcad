import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createBrokerIpcDispatch } from "../packages/node-adapters/src/broker-ipc/dispatch";

type Auth = { clientId: string; clientToken: string };

test("broker dispatch never publishes another owner's output or grants new authority for a lost epoch", async () => {
  let unavailable = false;
  let published = 0;
  let committed: Record<string, string> = {};
  const owner = { clientId: "owner", clientToken: "owner-token" };
  const observer = { clientId: "observer", clientToken: "observer-token" };
  const never = () => assert.fail("unexpected routing");
  const broker = createBrokerIpcDispatch({}, {
    persistClients: hashes => { committed = hashes; },
    processUnavailable: () => unavailable,
    hasSuccessor: () => false,
    ownsSuccessorCreation: never,
    assertMigrationAdmission: () => {},
    readEpochOwner: () => undefined,
    isHistorical: () => false,
    acceptsLifecycle: () => false,
    lifecycle: never,
    backend: never,
    workerStatus: never,
    command: never,
    readJob: id => ({ id, clientId: owner.clientId }),
    result(caller, job) {
      assert.equal(caller, owner.clientId);
      published++;
      return job?.id;
    },
  });
  await broker.dispatch({ action: "register", ...owner });
  await broker.dispatch({ action: "register", ...observer });
  const detached = broker.clientHashes();
  detached[observer.clientId] = detached[owner.clientId]!;
  const snapshot = committed;
  unavailable = true;
  await assert.rejects(
    broker.dispatch({ action: "submit", clientId: 7 }),
    { code: "EPOCH_PROCESS_UNAVAILABLE" },
  );
  await assert.rejects(
    broker.dispatch({ action: "register", clientId: "new", clientToken: "secret" }),
    { code: "EPOCH_PROCESS_UNAVAILABLE" },
  );
  await broker.dispatch({ action: "register", ...owner });
  assert.equal(committed, snapshot);
  await assert.rejects(
    broker.dispatch({ action: "result", auth: observer, jobId: "original" }),
    { code: "NOT_OWNER" },
  );
  assert.equal(published, 0);
  assert.equal(
    await broker.dispatch({ action: "result", auth: owner, jobId: "original" }),
    "original",
  );
  assert.equal(published, 1);
});

type Broker = { close(): Promise<void> };
type IpcTransport = {
  close(): Promise<void>;
  stopListening(): void;
};
type WireReply =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string } };
type FakeBackend = {
  client: unknown;
  sends: Array<Record<string, unknown>>;
  toolCalls: number;
  holdNextPost(): {
    started: Promise<void>;
    release(): void;
    readonly finished: boolean;
  };
};
type ServerSocketRecord = {
  socket: net.Socket;
  timeoutCalls: number[];
  timeoutActive: boolean;
  timeoutFired: boolean;
  timeoutCallback: (() => void) | undefined;
  deliveredChunks: Buffer[];
};
type SocketHarness = {
  records: ServerSocketRecord[];
  waitForSocket(index: number): Promise<ServerSocketRecord>;
  waitForData(record: ServerSocketRecord, index: number): Promise<Buffer>;
  expire(record: ServerSocketRecord): boolean;
  restore(): void;
};
type Fixture = {
  dir: string;
  broker: Broker;
  fake: FakeBackend;
  owner: Auth;
  other: Auth;
  socketHarness?: SocketHarness;
};
type FixtureOptions = {
  startPaused?: boolean;
  historyJobs?: number;
  serverDataChunks?: (wire: Buffer) => Buffer[];
  manualServerTimeouts?: boolean;
};

const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "package.json"));
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const owner: Auth = { clientId: "ipc-owner-a", clientToken: "ipc-token-a" };
const other: Auth = { clientId: "ipc-owner-b", clientToken: "ipc-token-b" };
const createFakeBackend = load(
  "./tests/fixtures/broker-ipc/fake-backend.cjs",
) as () => FakeBackend;
const { serve } = load("./src/queue-broker") as {
  serve(
    config: { backend: string; timeoutMs: number },
    options: {
      dir: string;
      confirmOwnership: boolean;
      createBackend(): unknown;
      nativePath(file: string): string;
      pollMs: number;
      startPaused?: boolean;
    },
  ): Promise<Broker>;
};
const { listenBrokerIpc } = load(
  "./src/dist/node-adapters/broker-ipc/server",
) as {
  listenBrokerIpc(
    endpoint: string,
    handle: (message: unknown) => Promise<unknown>,
  ): Promise<IpcTransport>;
};
const { queueSocket } = load("./src/queue-connection") as {
  queueSocket(dir: string): string;
};

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function parseReplies(text: string): WireReply[] {
  assert.ok(text.endsWith("\n"), "broker reply is newline terminated");
  const lines = text.slice(0, -1).split("\n");
  assert.ok(
    lines.every((line) => line.length > 0),
    text,
  );
  return lines.map((line) => JSON.parse(line) as WireReply);
}

function parseReply(text: string): WireReply {
  const replies = parseReplies(text);
  assert.equal(replies.length, 1, "one request receives exactly one reply");
  return replies[0]!;
}

function successful(reply: WireReply): Record<string, unknown> {
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return record(reply.result);
}

function expectError(reply: WireReply, code: string, message: string): void {
  assert.deepEqual(reply, { ok: false, error: { code, message } });
}

async function exchangeBytes(
  dir: string,
  fragments: Buffer[],
): Promise<string> {
  let socket: net.Socket | undefined;
  const response = new Promise<string>((resolve, reject) => {
    socket = net.createConnection(queueSocket(dir));
    const chunks: Buffer[] = [];
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      socket?.destroy();
      reject(error);
    };
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.endsWith("\n")) {
        fail(new Error("IPC peer closed before a complete reply"));
        return;
      }
      settled = true;
      resolve(text);
    });
    socket.once("close", () => {
      if (!settled) fail(new Error("IPC peer closed before a reply"));
    });
    socket.once("error", (error) =>
      fail(new Error("IPC peer failed before a reply: " + error.message)),
    );
    socket.once("connect", async () => {
      try {
        for (const fragment of fragments) {
          await new Promise<void>((done, failWrite) =>
            socket!.write(fragment, (error) =>
              error ? failWrite(error) : done(),
            ),
          );
          await new Promise<void>((done) => setImmediate(done));
        }
        socket!.end();
      } catch (error) {
        fail(
          new Error(
            "IPC peer failed before a reply: " +
              (error instanceof Error ? error.message : String(error)),
          ),
        );
      }
    });
  });
  return bounded(response, "Timed out waiting for an IPC reply", 5000, () =>
    socket?.destroy(),
  );
}

function encode(message: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify(message) + "\n");
}

async function exchange(
  dir: string,
  message: Record<string, unknown>,
): Promise<WireReply> {
  return parseReply(await exchangeBytes(dir, [encode(message)]));
}

async function bounded<T>(
  promise: Promise<T>,
  message: string,
  timeoutMs = 5000,
  onTimeout?: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new Error(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function connectSocket(dir: string): Promise<net.Socket> {
  let socket: net.Socket;
  const connected = new Promise<net.Socket>((resolve, reject) => {
    socket = net.createConnection(queueSocket(dir));
    socket.on("error", (error) => reject(error));
    socket.once("connect", () => resolve(socket));
  });
  return bounded(
    connected,
    "Timed out connecting to the IPC server",
    5000,
    () => socket.destroy(),
  );
}

function installSocketHarness(options: {
  serverDataChunks?: (wire: Buffer) => Buffer[];
  manualServerTimeouts?: boolean;
}): SocketHarness {
  const records: ServerSocketRecord[] = [];
  const bySocket = new WeakMap<net.Socket, ServerSocketRecord>();
  const waiters = new Map<number, (record: ServerSocketRecord) => void>();
  const dataWaiters = new Map<
    ServerSocketRecord,
    Map<number, (chunk: Buffer) => void>
  >();
  const originalCreateServer = net.createServer;
  const originalSetTimeout = net.Socket.prototype.setTimeout;
  const recordData = (record: ServerSocketRecord, chunk: Buffer) => {
    const copy = Buffer.from(chunk);
    const index = record.deliveredChunks.push(copy) - 1;
    const waiter = dataWaiters.get(record)?.get(index);
    if (!waiter) return;
    dataWaiters.get(record)?.delete(index);
    waiter(copy);
  };

  net.createServer = ((listener: (socket: net.Socket) => void) =>
    originalCreateServer(
      { allowHalfOpen: Boolean(options.serverDataChunks) },
      (socket: net.Socket) => {
        const record: ServerSocketRecord = {
          socket,
          timeoutCalls: [],
          timeoutActive: false,
          timeoutFired: false,
          timeoutCallback: undefined,
          deliveredChunks: [],
        };
        const index = records.push(record) - 1;
        bySocket.set(socket, record);
        waiters.get(index)?.(record);
        waiters.delete(index);

        if (options.serverDataChunks) {
          const originalOn = socket.on.bind(socket) as (
            event: string | symbol,
            listener: (...args: unknown[]) => void,
          ) => net.Socket;
          let dataListener: ((chunk: Buffer) => void) | undefined;
          const chunks: Buffer[] = [];
          let delivered = false;
          const mutableSocket = socket as unknown as {
            on(
              event: string | symbol,
              listener: (...args: unknown[]) => void,
            ): net.Socket;
          };
          mutableSocket.on = (event, listener) => {
            if (event === "data") {
              dataListener = listener as (chunk: Buffer) => void;
              originalOn("data", (chunk) =>
                chunks.push(Buffer.from(chunk as Buffer)),
              );
              originalOn("end", () => {
                if (delivered) return;
                delivered = true;
                const wire = Buffer.concat(chunks);
                for (const chunk of options.serverDataChunks!(wire)) {
                  dataListener?.(chunk);
                  recordData(record, chunk);
                }
              });
              return socket;
            }
            return originalOn(event, listener);
          };
        }

        listener(socket);
        if (options.manualServerTimeouts && !options.serverDataChunks) {
          socket.on("data", (chunk) => recordData(record, chunk));
        }
      },
    )) as typeof net.createServer;

  if (options.manualServerTimeouts) {
    net.Socket.prototype.setTimeout = function (timeout, callback) {
      const record = bySocket.get(this);
      if (!record) return originalSetTimeout.call(this, timeout, callback);
      record.timeoutCalls.push(timeout);
      if (timeout === 0) {
        record.timeoutActive = false;
        record.timeoutCallback = undefined;
      } else {
        record.timeoutActive = true;
        record.timeoutCallback = callback
          ? () => {
              record.timeoutFired = true;
              callback.call(this);
            }
          : undefined;
      }
      return this;
    };
  }

  return {
    records,
    waitForSocket(index) {
      const existing = records[index];
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => waiters.set(index, resolve));
    },
    waitForData(record, index) {
      const existing = record.deliveredChunks[index];
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => {
        let waiters = dataWaiters.get(record);
        if (!waiters) {
          waiters = new Map();
          dataWaiters.set(record, waiters);
        }
        waiters.set(index, resolve);
      });
    },
    expire(record) {
      if (!record.timeoutActive || !record.timeoutCallback) return false;
      const callback = record.timeoutCallback;
      record.timeoutActive = false;
      record.timeoutCallback = undefined;
      callback();
      return true;
    },
    restore() {
      net.createServer = originalCreateServer;
      net.Socket.prototype.setTimeout = originalSetTimeout;
    },
  };
}

async function fixture(
  t: TestContext,
  options: FixtureOptions = {},
): Promise<Fixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-broker-ipc-"));
  const fake = createFakeBackend();
  let broker: Broker | undefined;
  const {
    historyJobs = 0,
    serverDataChunks,
    manualServerTimeouts,
    ...serveOptions
  } = options;
  const socketHarness =
    serverDataChunks || manualServerTimeouts
      ? installSocketHarness({
          ...(serverDataChunks ? { serverDataChunks } : {}),
          ...(manualServerTimeouts ? { manualServerTimeouts } : {}),
        })
      : undefined;
  if (historyJobs > 0) {
    // Public status intentionally includes retained public job projections.
    // Seed only terminal history to exercise the response cap without starting
    // physical work or depending on a private broker map.
    const description = "x".repeat(1000);
    const jobs = Object.fromEntries(
      Array.from({ length: historyJobs }, (_, index) => {
        const id = `history-${index}`;
        const requestId = `history-request-${index}`;
        return [
          id,
          {
            id,
            requestId,
            clientId: owner.clientId,
            kind: "command",
            description,
            request: {
              requestId,
              clientId: owner.clientId,
              kind: "command",
              timeoutMs: 5000,
              cwd: root,
              argv: ["node", "-e", ""],
              description,
            },
            hash: `history-hash-${index}`,
            order: index + 1,
            state: "succeeded",
            submittedAt: index + 1,
            queueDeadline: null,
            timeoutMs: 5000,
            finishedAt: index + 2,
            code: "EXECUTION_COMPLETE",
            sequenceId: null,
            sequenceState: null,
          },
        ];
      }),
    );
    fs.writeFileSync(
      path.join(dir, "queue-state.json"),
      JSON.stringify({
        version: 1,
        paused: true,
        revision: historyJobs,
        epoch: 0,
        blocked: null,
        active: null,
        lease: null,
        jobs,
        lastClient: null,
      }),
    );
  }
  t.after(async () => {
    try {
      if (broker) await broker.close();
    } finally {
      socketHarness?.restore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  broker = await serve(
    { backend: "mcp", timeoutMs: 5000 },
    {
      dir,
      confirmOwnership: true,
      createBackend: () => fake.client,
      nativePath: (file) => file,
      pollMs: 5,
      ...serveOptions,
    },
  );
  for (const client of [owner, other])
    assert.deepEqual(await exchange(dir, { action: "register", ...client }), {
      ok: true,
      result: { clientId: client.clientId },
    });
  return {
    dir,
    broker,
    fake,
    owner,
    other,
    ...(socketHarness ? { socketHarness } : {}),
  };
}

function rpcRequest(requestId: string, marker: string) {
  return {
    kind: "rpc",
    requestId,
    timeoutMs: 5000,
    payload: {
      jsonrpc: "2.0",
      id: "caller-rpc-id",
      method: "ping",
      params: { marker },
    },
  };
}

async function waitFor<T>(
  read: () => Promise<T | null>,
  message: string,
): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Timed out waiting for " + message);
}

async function ownedResult(
  f: Fixture,
  auth: Auth,
  jobId: string,
): Promise<Record<string, unknown>> {
  return waitFor(async () => {
    const reply = await exchange(f.dir, {
      action: "result",
      auth,
      jobId,
    });
    const result = successful(reply);
    const job = record(result["job"]);
    if (job["state"] === "succeeded") return result;
    assert.ok(
      !["failed", "expired", "needs_reconciliation"].includes(
        String(job["state"]),
      ),
      JSON.stringify(job),
    );
    return null;
  }, "terminal result for " + jobId);
}

test("real serve frames fragmented UTF-8 and keeps lookup owner-scoped without replay", async (t) => {
  const marker = "zażółć 🧪";
  const emoji = Buffer.from("🧪");
  const f = await fixture(t, {
    serverDataChunks(wire) {
      const emojiStart = wire.indexOf(emoji);
      if (emojiStart < 0) return [wire];
      return [
        wire.subarray(0, emojiStart + 2),
        wire.subarray(emojiStart + 2, wire.length - 1),
        wire.subarray(wire.length - 1),
      ];
    },
  });
  const requestId = randomUUID();
  const frame = encode({
    action: "submit",
    auth: f.owner,
    request: rpcRequest(requestId, marker),
  });
  const reply = parseReply(await exchangeBytes(f.dir, [frame]));
  const accepted = successful(reply);
  const jobId = String(accepted["id"]);
  assert.ok(jobId);
  assert.equal(accepted["requestId"], requestId);
  assert.equal(accepted["clientId"], f.owner.clientId);

  const result = await ownedResult(f, f.owner, jobId);
  const job = record(result["job"]);
  assert.equal(job["requestId"], requestId);
  assert.equal(job["clientId"], f.owner.clientId);
  const rpc = record(result["rpc"]);
  const response = JSON.parse(String(rpc["raw"])) as Record<string, unknown>;
  assert.equal(response["id"], "caller-rpc-id");
  assert.deepEqual(record(response["result"])["echo"], { marker });
  assert.equal(f.fake.sends.length, 1);
  assert.deepEqual(record(f.fake.sends[0]!["params"]), { marker });

  const duplicate = successful(
    await exchange(f.dir, {
      action: "submit",
      auth: f.owner,
      request: rpcRequest(requestId, marker),
    }),
  );
  assert.equal(duplicate["id"], jobId);
  const afterDuplicate = successful(
    await exchange(f.dir, { action: "queue-summary", auth: f.owner }),
  );
  assert.equal(afterDuplicate["jobCount"], 1);

  expectError(
    await exchange(f.dir, {
      action: "submit",
      auth: { ...f.owner, clientToken: "wrong-token" },
      request: rpcRequest(randomUUID(), marker),
    }),
    "UNAUTHORIZED",
    "Valid registered client credentials required",
  );
  expectError(
    await exchange(f.dir, {
      action: "result",
      auth: f.other,
      jobId,
    }),
    "NOT_OWNER",
    "Only the submitting client may access this job result",
  );
  const foreignLookup = successful(
    await exchange(f.dir, {
      action: "find-request",
      auth: f.other,
      requestId,
    }),
  );
  assert.equal(foreignLookup["job"], null);
  const ownerLookup = successful(
    await exchange(f.dir, {
      action: "find-request",
      auth: f.owner,
      requestId,
    }),
  );
  assert.equal(record(ownerLookup["job"])["id"], jobId);
  assert.equal(record(ownerLookup["job"])["requestId"], requestId);
  const finalSummary = successful(
    await exchange(f.dir, { action: "queue-summary", auth: f.owner }),
  );
  assert.equal(finalSummary["jobCount"], 1);
  assert.equal(f.fake.sends.length, 1);
});

test("losing the submit acknowledgement during backend work preserves admission without replay", async (t) => {
  const f = await fixture(t);
  const requestId = randomUUID();
  const backend = f.fake.holdNextPost();
  const message = {
    action: "submit",
    auth: f.owner,
    request: rpcRequest(requestId, "lost-ack-during-backend-work"),
  };
  let socket: net.Socket | undefined;
  let receivedReply = false;

  try {
    socket = await connectSocket(f.dir);
    socket.on("data", () => {
      receivedReply = true;
    });
    socket.pause();
    await new Promise<void>((resolve, reject) =>
      socket!.write(encode(message), (error) =>
        error ? reject(error) : resolve(),
      ),
    );

    const found = await waitFor(async () => {
      const reply = await exchange(f.dir, {
        action: "find-request",
        auth: f.owner,
        requestId,
      });
      const result = successful(reply);
      return result["job"] ? record(result["job"]) : null;
    }, "durable owner-scoped admission");
    const jobId = String(found["id"]);
    assert.equal(found["requestId"], requestId);
    assert.equal(found["clientId"], f.owner.clientId);

    await bounded(
      backend.started,
      "Timed out waiting for the admitted backend operation",
    );
    assert.equal(f.fake.sends.length, 1);
    assert.equal(backend.finished, false);
    assert.equal(receivedReply, false, "the client has not consumed the ACK");

    const closed = new Promise<void>((resolve) =>
      socket!.once("close", () => resolve()),
    );
    socket.destroy();
    await bounded(closed, "Timed out waiting for the client disconnect");

    const duringWork = successful(
      await exchange(f.dir, {
        action: "find-request",
        auth: f.owner,
        requestId,
      }),
    );
    const stillAdmitted = record(duringWork["job"]);
    assert.equal(stillAdmitted["id"], jobId);
    assert.equal(stillAdmitted["requestId"], requestId);
    assert.equal(stillAdmitted["clientId"], f.owner.clientId);
    assert.equal(f.fake.sends.length, 1);
    assert.equal(backend.finished, false);

    backend.release();
    const result = await ownedResult(f, f.owner, jobId);
    assert.equal(record(result["job"])["state"], "succeeded");
    assert.equal(backend.finished, true);

    const retry = successful(
      await exchange(f.dir, {
        action: "submit",
        auth: f.owner,
        request: rpcRequest(requestId, "lost-ack-during-backend-work"),
      }),
    );
    assert.equal(retry["id"], jobId);
    const summary = successful(
      await exchange(f.dir, { action: "queue-summary", auth: f.owner }),
    );
    assert.equal(summary["jobCount"], 1);
    assert.equal(f.fake.sends.length, 1);
  } finally {
    backend.release();
    socket?.destroy();
  }
});

test("raw IPC client rejects a peer that closes without an acknowledgement", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-broker-ipc-close-"));
  const server = net.createServer((socket) => socket.destroy());
  t.after(async () => {
    if (server.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(queueSocket(dir), resolve);
  });

  await assert.rejects(
    exchangeBytes(dir, [encode({ action: "register", ...owner })]),
    /IPC peer (?:closed|failed) before a reply/,
  );
});

test("raw IPC returns exact malformed and 16 MiB input errors without admission or sends", async (t) => {
  const f = await fixture(t, {
    serverDataChunks: (wire) => [wire],
  });
  expectError(
    parseReply(await exchangeBytes(f.dir, [Buffer.from("{bad-json\n")])),
    "INVALID_JSON",
    "Invalid JSON request",
  );

  const boundaryMessage = {
    action: "register",
    clientId: "ipc-limit-boundary",
    clientToken: "ipc-limit-token",
  };
  const boundaryJson = Buffer.from(JSON.stringify(boundaryMessage));
  const exactFrame = Buffer.concat([
    boundaryJson,
    Buffer.alloc(MAX_FRAME_BYTES - boundaryJson.length - 1, 0x20),
    Buffer.from("\n"),
  ]);
  assert.equal(exactFrame.length, MAX_FRAME_BYTES);
  assert.deepEqual(parseReply(await exchangeBytes(f.dir, [exactFrame])), {
    ok: true,
    result: { clientId: boundaryMessage.clientId },
  });

  const oversizedFrame = Buffer.concat([
    boundaryJson,
    Buffer.alloc(MAX_FRAME_BYTES - boundaryJson.length, 0x20),
    Buffer.from("\n"),
  ]);
  assert.equal(oversizedFrame.length, MAX_FRAME_BYTES + 1);
  expectError(
    parseReply(await exchangeBytes(f.dir, [oversizedFrame])),
    "MESSAGE_TOO_LARGE",
    "Request exceeds 16 MiB",
  );

  const earlyNewlineMessage = {
    action: "register",
    clientId: "ipc-first-newline-over-limit",
    clientToken: "ipc-first-newline-token",
  };
  const earlyNewlineJson = Buffer.from(JSON.stringify(earlyNewlineMessage));
  const oversizedAfterNewline = Buffer.concat([
    earlyNewlineJson,
    Buffer.from("\n"),
    Buffer.alloc(MAX_FRAME_BYTES - earlyNewlineJson.length, 0x20),
  ]);
  assert.equal(oversizedAfterNewline.length, MAX_FRAME_BYTES + 1);
  assert.ok(oversizedAfterNewline.indexOf(10) < MAX_FRAME_BYTES);
  expectError(
    parseReply(await exchangeBytes(f.dir, [oversizedAfterNewline])),
    "MESSAGE_TOO_LARGE",
    "Request exceeds 16 MiB",
  );
  expectError(
    await exchange(f.dir, {
      action: "queue-summary",
      auth: {
        clientId: earlyNewlineMessage.clientId,
        clientToken: earlyNewlineMessage.clientToken,
      },
    }),
    "UNAUTHORIZED",
    "Valid registered client credentials required",
  );

  const summary = successful(
    await exchange(f.dir, { action: "queue-summary", auth: f.owner }),
  );
  assert.equal(summary["jobCount"], 0);
  assert.equal(f.fake.sends.length, 0);
});

test("raw IPC enforces the frame limit across accumulated chunks", async (t) => {
  const f = await fixture(t, {
    serverDataChunks(wire) {
      if (wire.length < MAX_FRAME_BYTES) return [wire];
      return [
        wire.subarray(0, MAX_FRAME_BYTES - 1),
        wire.subarray(MAX_FRAME_BYTES - 1),
      ];
    },
  });
  const client = {
    clientId: "ipc-cumulative-limit",
    clientToken: "ipc-cumulative-limit-token",
  };
  const json = Buffer.from(JSON.stringify({ action: "register", ...client }));
  const firstChunkLength = MAX_FRAME_BYTES - 1;
  const frame = Buffer.concat([
    json,
    Buffer.alloc(firstChunkLength - json.length, 0x20),
    Buffer.from("\n "),
  ]);
  assert.equal(frame.length, MAX_FRAME_BYTES + 1);
  assert.equal(frame.indexOf(10), MAX_FRAME_BYTES - 1);

  const harness = f.socketHarness!;
  const socketIndex = harness.records.length;
  const accepted = harness.waitForSocket(socketIndex);
  expectError(
    parseReply(await exchangeBytes(f.dir, [frame])),
    "MESSAGE_TOO_LARGE",
    "Request exceeds 16 MiB",
  );
  const serverSocket = await bounded(
    accepted,
    "Timed out waiting for the cumulative-limit socket",
  );
  assert.deepEqual(serverSocket.deliveredChunks, [
    frame.subarray(0, MAX_FRAME_BYTES - 1),
    frame.subarray(MAX_FRAME_BYTES - 1),
  ]);
  expectError(
    await exchange(f.dir, { action: "queue-summary", auth: client }),
    "UNAUTHORIZED",
    "Valid registered client credentials required",
  );
  const summary = successful(
    await exchange(f.dir, { action: "queue-summary", auth: f.owner }),
  );
  assert.equal(summary["jobCount"], 0);
  assert.equal(f.fake.sends.length, 0);
});

test("one socket consumes only its first complete frame", async (t) => {
  const malformed = Buffer.from("{bad-json\n");
  const f = await fixture(t, {
    serverDataChunks(wire) {
      const firstNewline = wire.indexOf(10);
      const secondNewline = wire.indexOf(10, firstNewline + 1);
      if (firstNewline < 0 || secondNewline < 0) return [wire];
      const first = wire.subarray(0, firstNewline + 1);
      if (first.equals(malformed))
        return [first, wire.subarray(firstNewline + 1)];
      return [wire];
    },
  });
  const first = {
    clientId: "ipc-first-frame",
    clientToken: "first-frame-token",
  };
  const second = {
    clientId: "ipc-second-frame",
    clientToken: "second-frame-token",
  };
  const harness = f.socketHarness!;
  const malformedSocketIndex = harness.records.length;
  const malformedSocketAccepted = harness.waitForSocket(malformedSocketIndex);
  const malformedReplies = await exchangeBytes(f.dir, [
    Buffer.concat([malformed, encode({ action: "register", ...second })]),
  ]);
  const malformedSocket = await bounded(
    malformedSocketAccepted,
    "Timed out waiting for the malformed-frame socket",
  );
  const replies = parseReplies(malformedReplies);
  assert.equal(replies.length, 1, malformedReplies);
  expectError(replies[0]!, "INVALID_JSON", "Invalid JSON request");
  assert.deepEqual(malformedSocket.deliveredChunks, [
    malformed,
    encode({ action: "register", ...second }),
  ]);

  expectError(
    await exchange(f.dir, {
      action: "queue-summary",
      auth: second,
    }),
    "UNAUTHORIZED",
    "Valid registered client credentials required",
  );
  expectError(
    await exchange(f.dir, { action: "queue-summary", auth: first }),
    "UNAUTHORIZED",
    "Valid registered client credentials required",
  );
  const summary = successful(
    await exchange(f.dir, { action: "queue-summary", auth: f.owner }),
  );
  assert.equal(summary["jobCount"], 0);
  assert.equal(f.fake.sends.length, 0);

  const validSocketIndex = harness.records.length;
  const validSocketAccepted = harness.waitForSocket(validSocketIndex);
  const twoValidFrames = Buffer.concat([
    encode({ action: "register", ...first }),
    encode({ action: "register", ...second }),
  ]);
  const validReplies = await exchangeBytes(f.dir, [twoValidFrames]);
  const validSocket = await bounded(
    validSocketAccepted,
    "Timed out waiting for the valid-frame socket",
  );
  const validReplyLines = parseReplies(validReplies);
  assert.equal(validReplyLines.length, 1, validReplies);
  assert.deepEqual(validReplyLines[0], {
    ok: true,
    result: { clientId: first.clientId },
  });
  assert.deepEqual(validSocket.deliveredChunks, [twoValidFrames]);
  expectError(
    await exchange(f.dir, { action: "queue-summary", auth: second }),
    "UNAUTHORIZED",
    "Valid registered client credentials required",
  );
  const firstSummary = successful(
    await exchange(f.dir, { action: "queue-summary", auth: first }),
  );
  assert.equal(firstSummary["jobCount"], 0);
  assert.equal(f.fake.sends.length, 0);
});

test("partial-frame timeout expires after parsing", async (t) => {
  const f = await fixture(t, { manualServerTimeouts: true });
  const harness = f.socketHarness!;
  const partialIndex = harness.records.length;
  const partialAccepted = harness.waitForSocket(partialIndex);
  const partialSocket = await connectSocket(f.dir);
  try {
    const partialRecord = await bounded(
      partialAccepted,
      "Timed out waiting for the partial-frame socket",
    );
    let partialReply = Buffer.alloc(0);
    partialSocket.on("data", (chunk) => {
      partialReply = Buffer.concat([partialReply, chunk]);
    });
    const partialClosed = new Promise<void>((resolve) =>
      partialSocket.once("close", () => resolve()),
    );
    const partialProcessed = harness.waitForData(partialRecord, 0);
    await new Promise<void>((resolve, reject) =>
      partialSocket.write(Buffer.from('{"action":"register"'), (error) =>
        error ? reject(error) : resolve(),
      ),
    );
    await bounded(
      partialProcessed,
      "Timed out waiting for the server to process the partial frame",
    );
    assert.deepEqual(partialRecord.timeoutCalls, [30000]);
    assert.equal(partialRecord.timeoutActive, true);
    assert.equal(harness.expire(partialRecord), true);
    await bounded(partialClosed, "Timed out closing the partial-frame socket");
    assert.equal(partialRecord.timeoutFired, true);
    assert.equal(partialReply.length, 0);
  } finally {
    partialSocket.destroy();
  }
});

test("a complete frame disables the timeout before its async handler replies", async (t) => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "fmcad-broker-ipc-handler-"),
  );
  const harness = installSocketHarness({ manualServerTimeouts: true });
  let transport: IpcTransport | undefined;
  let socket: net.Socket | undefined;
  let releaseHandler: (() => void) | undefined;
  try {
    let markHandlerStarted!: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      markHandlerStarted = resolve;
    });
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const handledMessages: unknown[] = [];
    let handlerFinished = false;
    transport = await listenBrokerIpc(queueSocket(dir), async (message) => {
      handledMessages.push(message);
      markHandlerStarted();
      await handlerGate;
      handlerFinished = true;
      return { handled: true };
    });

    const completeIndex = harness.records.length;
    const completeAccepted = harness.waitForSocket(completeIndex);
    socket = await connectSocket(dir);
    const serverSocket = await bounded(
      completeAccepted,
      "Timed out waiting for the public IPC transport socket",
    );
    let replyBytes = Buffer.alloc(0);
    let replyEnded = false;
    const response = new Promise<string>((resolve, reject) => {
      socket!.on("data", (chunk) => {
        replyBytes = Buffer.concat([replyBytes, chunk]);
      });
      socket!.once("end", () => {
        replyEnded = true;
        resolve(replyBytes.toString("utf8"));
      });
      socket!.once("close", () => {
        if (!replyEnded)
          reject(new Error("IPC peer closed before a complete reply"));
      });
      socket!.once("error", reject);
    });
    void response.catch(() => {});

    const request = { action: "delayed-handler" };
    await new Promise<void>((resolve, reject) =>
      socket!.write(encode(request), (error) =>
        error ? reject(error) : resolve(),
      ),
    );
    await bounded(
      handlerStarted,
      "Timed out waiting for the public handler to block",
    );
    assert.deepEqual(handledMessages, [request]);
    assert.equal(handlerFinished, false);
    assert.equal(replyBytes.length, 0, "handler has not replied yet");

    const expiredWhileHandlerBlocked = harness.expire(serverSocket);
    releaseHandler!();
    let responseText: string | undefined;
    let responseError: unknown;
    try {
      responseText = await bounded(
        response,
        "Timed out waiting for the released public handler's reply",
      );
    } catch (error) {
      responseError = error;
    }

    assert.equal(
      expiredWhileHandlerBlocked,
      false,
      "a complete frame must disable the idle timeout before handle returns",
    );
    assert.deepEqual(serverSocket.timeoutCalls, [30000, 0]);
    assert.equal(serverSocket.timeoutActive, false);
    assert.equal(serverSocket.timeoutFired, false);
    assert.equal(handlerFinished, true);
    assert.ifError(responseError);
    assert.ok(responseText);
    assert.deepEqual(successful(parseReply(responseText)), {
      handled: true,
    });
  } finally {
    releaseHandler?.();
    socket?.destroy();
    if (transport)
      await bounded(
        transport.close(),
        "Timed out closing the public IPC transport",
        5000,
        () => transport?.stopListening(),
      );
    harness.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a status response over 16 MiB is replaced exactly without admission or sends", async (t) => {
  const historyJobs = 18_000;
  const f = await fixture(t, { startPaused: true, historyJobs });
  const initial = successful(
    await exchange(f.dir, { action: "queue-summary", auth: f.owner }),
  );
  assert.equal(initial["jobCount"], historyJobs);

  expectError(
    await exchange(f.dir, { action: "status", auth: f.owner }),
    "RESPONSE_TOO_LARGE",
    "Response exceeds 16 MiB; use output file metadata",
  );

  const summary = successful(
    await exchange(f.dir, { action: "queue-summary", auth: f.owner }),
  );
  assert.equal(summary["jobCount"], historyJobs);
  assert.equal(summary["nonterminalJobCount"], 0);
  assert.equal(f.fake.sends.length, 0);
});

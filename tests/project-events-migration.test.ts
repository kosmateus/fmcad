import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { ObservationEvent } from "@fmcad/core";
const runtimeRequire = createRequire(__filename);
const net = runtimeRequire("node:net") as typeof import("node:net");
const Module = runtimeRequire("node:module") as typeof import("node:module") & {
  _nodeModulePaths(directory: string): string[];
};
type Boundary = typeof import("../src/composition/library-project-events");
const root = process.cwd(),
  fixtureDirectory = path.join(root, "tests/fixtures/public-host-baseline");
function historical() {
  const source = fs.readFileSync(
    path.join(fixtureDirectory, "project-logger.cjs.txt"),
    "utf8",
  );
  assert.equal(
    createHash("sha256").update(source).digest("hex"),
    (
      JSON.parse(
        fs.readFileSync(path.join(fixtureDirectory, "provenance.json"), "utf8"),
      ) as Record<string, { sha256: string }>
    )["src/opencode/project-logger.cjs"]!.sha256,
  );
  const filename = path.join(root, "src/opencode/project-logger.cjs"),
    value = new Module(filename, module) as InstanceType<typeof Module> & {
      _compile(source: string, filename: string): void;
    };
  value.filename = filename;
  value.paths = Module._nodeModulePaths(path.dirname(filename));
  value._compile(
    source + "\nObject.assign(module.exports,{ipc,readJson});",
    filename,
  );
  return value.exports as Boundary;
}

test("typed passive event IPC preserves framing, bounds, authentication bytes and all failures", async () => {
  const before = historical(),
    after = runtimeRequire(
      path.join(root, "src/dist/composition/library-project-events"),
    ) as Boundary;
  const original = net.createConnection;
  try {
    for (const scenario of [
      "success",
      "split",
      "denied",
      "null",
      "malformed",
      "oversized",
      "disconnect",
      "error",
      "timeout",
    ]) {
      async function observe(api: Boundary) {
        const calls: unknown[] = [];
        net.createConnection = ((
          options: import("node:net").NetConnectOpts,
        ) => {
          calls.push(["connect", options]);
          const socket = new net.Socket();
          socket.destroy = () => {
            calls.push(["destroy"]);
            return socket;
          };
          socket.write = ((bytes: string | Uint8Array) => {
            calls.push(["write", bytes]);
            queueMicrotask(() => {
              if (scenario === "success")
                socket.emit("data", Buffer.from('{"ok":true,"value":"α"}\n'));
              if (scenario === "split") {
                socket.emit("data", Buffer.from('{"ok":'));
                socket.emit("data", Buffer.from("true}\nignored"));
              }
              if (scenario === "denied")
                socket.emit("data", Buffer.from('{"ok":false}\n'));
              if (scenario === "null")
                socket.emit("data", Buffer.from("null\n"));
              if (scenario === "malformed")
                socket.emit("data", Buffer.from("{broken}\n"));
              if (scenario === "oversized")
                socket.emit("data", Buffer.from("x".repeat(8193)));
              if (scenario === "disconnect") socket.emit("end");
              if (scenario === "error")
                socket.emit(
                  "error",
                  Object.assign(Error("connection unavailable"), {
                    code: "ECONNREFUSED",
                  }),
                );
            });
            return true;
          }) as typeof socket.write;
          queueMicrotask(() => socket.emit("connect"));
          return socket;
        }) as typeof net.createConnection;
        let outcome;
        try {
          outcome = {
            result: await api.ipc(
              { socket: "\0private-observer" },
              {
                method: "observation",
                token: "exact-token",
                event: { name: "event α" },
              },
            ),
          };
        } catch (error) {
          assert(error instanceof Error);
          outcome = {
            error: error.message,
            code: "code" in error ? error.code : undefined,
          };
        }
        return { calls, outcome };
      }
      assert.deepEqual(await observe(after), await observe(before), scenario);
    }
  } finally {
    net.createConnection = original;
  }
});

test("typed passive sink preserves private snapshot guards, event validation, disabling and disposal", async (t) => {
  const before = historical(),
    after = runtimeRequire(
      path.join(root, "src/dist/composition/library-project-events"),
    ) as Boundary;
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "fmcad-event-parity-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const queueDir = path.join(directory, "queue");
  assert.deepEqual(after.locations(queueDir), before.locations(queueDir));
  const state = after.locations(queueDir).stateDir;
  fs.mkdirSync(state, { recursive: true });
  const control = path.join(state, "observer.json");
  fs.writeFileSync(control, '{"token":"owner-token"}');
  assert.deepEqual(after.readJson(control), before.readJson(control));
  const link = path.join(state, "link.json");
  fs.symlinkSync(control, link);
  for (const api of [before, after])
    assert.throws(() => api.readJson(link), { code: "ELOOP" });
  for (const api of [before, after])
    assert.throws(() => api.readJson(state), { code: "INVALID_SNAPSHOT" });
  const { createInvocationContext } = runtimeRequire(
    path.join(root, "src/dist/core"),
  ) as typeof import("@fmcad/core");
  const event: ObservationEvent = {
    version: 1,
    atMs: 1234,
    name: "opencode.session.activity",
    invocation: createInvocationContext({
      instanceId: "fixture",
      source: "opencode",
    }),
    data: { status: "busy" },
  };
  const original = net.createConnection,
    disabled = process.env["FMCAD_PROJECT_LOGS"];
  try {
    async function observe(api: Boundary, disable: boolean) {
      const calls: unknown[] = [];
      process.env["FMCAD_PROJECT_LOGS"] = disable ? "0" : "1";
      net.createConnection = ((options: import("node:net").NetConnectOpts) => {
        calls.push(["connect", options]);
        const socket = new net.Socket();
        socket.destroy = () => {
          calls.push(["destroy"]);
          return socket;
        };
        socket.write = ((text: string) => {
          calls.push(["write", JSON.parse(text)]);
          queueMicrotask(() =>
            socket.emit("data", Buffer.from('{"ok":true}\n')),
          );
          return true;
        }) as typeof socket.write;
        queueMicrotask(() => socket.emit("connect"));
        return socket;
      }) as typeof net.createConnection;
      const sink = api.createEventSink("/project", { queueDir });
      await sink.publish(event);
      await assert.rejects(
        sink.publish({ ...event, version: 2 } as unknown as ObservationEvent),
        /Invalid or oversized observation event/,
      );
      assert(sink.dispose);
      await sink.dispose();
      await sink.publish(event);
      return calls;
    }
    for (const disable of [false, true])
      assert.deepEqual(
        await observe(after, disable),
        await observe(before, disable),
      );
  } finally {
    net.createConnection = original;
    if (disabled === undefined) delete process.env["FMCAD_PROJECT_LOGS"];
    else process.env["FMCAD_PROJECT_LOGS"] = disabled;
  }
});

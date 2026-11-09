import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { EventSink } from "@fmcad/core";
import type { OpenCodePresenceReporter } from "../packages/node-adapters/src/telemetry/opencode-presence";
import type { PresenceV2Host } from "../src/composition/library-opencode-presence";
type Boundary = typeof import("../src/composition/library-opencode-presence");
const runtimeRequire = createRequire(__filename);
const Module = runtimeRequire("node:module") as typeof import("node:module") & {
  _load(name: string, ...args: unknown[]): unknown;
  _nodeModulePaths(directory: string): string[];
};
const root = process.cwd();
const fixtureDirectory = path.join(root, "tests/fixtures/public-host-baseline");
function provenance(key: string): string {
  const values = JSON.parse(
    fs.readFileSync(path.join(fixtureDirectory, "provenance.json"), "utf8"),
  ) as Record<string, { sha256: string }>;
  const value = values[key];
  assert(value && typeof value.sha256 === "string");
  return value.sha256;
}
function loadBoundary(
  historical: boolean,
  trace: unknown[],
  {
    absent = false,
    failTouch = false,
    failClose = false,
    failSink = false,
  } = {},
) {
  const adapter = {
    defaultOpenCodePresenceDirectory: () => "/presence",
    createOpenCodePresence: (
      project: string,
      directory: string,
    ): OpenCodePresenceReporter | null => {
      trace.push(["create", project, directory]);
      return absent
        ? null
        : {
            file: "/presence/owned.json",
            instanceId: "instance:fixture",
            touch: (id, data) => {
              trace.push(["touch", id, data]);
              if (failTouch) throw Error("unavailable");
            },
            event: (value) => trace.push(["event", value]),
            close: async () => {
              trace.push(["close"]);
              if (failClose) throw Error("unavailable");
            },
          };
    },
  };
  const sink: EventSink = {
    async publish(event) {
      trace.push(["publish", event]);
    },
    dispose() {
      trace.push(["dispose"]);
      if (failClose) throw Error("unavailable");
    },
  };
  const logger = {
    createEventSink: (project: string) => {
      trace.push(["sink", project]);
      if (failSink) throw Error("unavailable");
      return sink;
    },
  };
  const original = Module._load;
  Module._load = function (name, ...args) {
    if (name.endsWith("/telemetry/opencode-presence")) return adapter;
    if (
      name.endsWith("/project-logger.cjs") ||
      name === "./library-project-events"
    )
      return logger;
    return original.call(this, name, ...args);
  };
  try {
    let filename, source;
    if (historical) {
      filename = path.join(root, "src/opencode/presence.cjs");
      source = fs.readFileSync(
        path.join(fixtureDirectory, "opencode-presence.cjs.txt"),
        "utf8",
      );
      assert.equal(
        createHash("sha256").update(source).digest("hex"),
        provenance("src/opencode/presence.cjs"),
      );
    } else {
      filename = path.join(
        root,
        "src/dist/composition/library-opencode-presence.js",
      );
      source = fs.readFileSync(filename, "utf8");
    }
    const isolated = new Module(filename, module) as InstanceType<
      typeof Module
    > & { _compile(source: string, filename: string): void };
    isolated.filename = filename;
    isolated.paths = Module._nodeModulePaths(path.dirname(filename));
    isolated._compile(source, filename);
    // The reporter creates its logger lazily; keep the scoped require override
    // active only while the synchronous factory/setup prefix runs.
    return {
      api: isolated.exports as Boundary,
      scoped: <T>(callback: () => T): T => {
        const saved = Module._load;
        Module._load = function (name, ...args) {
          if (
            name.endsWith("/project-logger.cjs") ||
            name === "./library-project-events"
          )
            return logger;
          return saved.call(this, name, ...args);
        };
        try {
          return callback();
        } finally {
          Module._load = saved;
        }
      },
    };
  } finally {
    Module._load = original;
  }
}

test("typed OpenCode reporter preserves passive events, exact ownership and independent cleanup failures", async () => {
  const clock = Date.now;
  Date.now = () => 1800000000000;
  try {
    for (const options of [
      {},
      { absent: true },
      { failTouch: true },
      { failClose: true },
      { failSink: true },
    ]) {
      async function observe(historical: boolean) {
        const trace: unknown[] = [];
        const { api, scoped } = loadBoundary(historical, trace, options);
        const reporter = scoped(() => api.createReporter("/project"));
        if (reporter) {
          assert.equal(reporter.file, "/presence/owned.json");
          reporter.touch("session α", {
            agent: "build\nprivate",
            status: "busy",
            requestId: "request",
            jobId: "job",
            documentId: "document",
            turnId: "turn",
            title: "private title",
          });
          for (const event of [
            null,
            {},
            "invalid",
            {
              type: "session.created",
              properties: {
                info: { id: "session α", documentID: "doc" },
                requestID: "request",
                jobID: "job",
                turnID: "turn",
              },
            },
            {
              type: "session.updated",
              properties: { info: { id: "session α" } },
            },
            {
              type: "session.deleted",
              properties: { info: { id: "session α" } },
            },
            {
              type: "session.status",
              properties: {
                sessionID: "session α",
                status: { type: "busy" },
                documentId: "doc",
              },
            },
            {
              type: "session.idle",
              properties: { sessionID: "session α", turnId: "turn" },
            },
          ])
            reporter.event(event);
          await reporter.close();
        }
        await Promise.resolve();
        return trace;
      }
      assert.deepEqual(
        await observe(false),
        await observe(true),
        JSON.stringify(options),
      );
    }
  } finally {
    Date.now = clock;
  }
});

test("typed retained V1/V2 presence hooks preserve host mapping, local abort and disposal", async () => {
  const clock = Date.now;
  Date.now = () => 1800000000000;
  try {
    for (const version of [1, 2]) {
      async function observe(historical: boolean) {
        const trace: unknown[] = [];
        const { api, scoped } = loadBoundary(historical, trace);
        const event = {
          sessionID: "session",
          agent: "build",
          tool: "fmcad_execute",
          requestID: "request",
          jobID: "job",
          documentID: "doc",
          turnID: "turn",
        };
        if (version === 1) {
          const hooks = await scoped(() =>
            api.setupV1({
              directory: "/project",
              client: {
                session: {
                  get: async (value) => {
                    trace.push(["get", value]);
                    return { data: { title: "title", directory: "/project" } };
                  },
                },
              },
            }),
          );
          trace.push(["hooks", Object.keys(hooks)]);
          for (const key of [
            "chat.message",
            "chat.params",
            "tool.execute.before",
          ] as const) {
            const hook = hooks[key];
            assert(hook);
            await hook(event);
          }
          assert(hooks.event && hooks.dispose);
          await hooks.event({
            event: {
              type: "session.idle",
              properties: { sessionID: "session" },
            },
          });
          await hooks.dispose();
        } else {
          const callbacks: Parameters<PresenceV2Host["tool"]["hook"]>[1][] = [];
          const dispose = await scoped(() =>
            api.setupV2({
              location: { directory: "/project" },
              session: {
                get: async (value) => {
                  trace.push(["get", value]);
                  return { title: "title", directory: "/project" };
                },
                hook: async (name, fn) => {
                  trace.push(["session.hook", name]);
                  callbacks.push(fn);
                },
              },
              tool: {
                hook: async (name, fn) => {
                  trace.push(["tool.hook", name]);
                  callbacks.push(fn);
                },
              },
              event: {
                async *subscribe({ signal }) {
                  trace.push(["subscribe"]);
                  yield {
                    type: "session.idle",
                    properties: { sessionID: "session" },
                  };
                  await new Promise<void>((resolve) =>
                    signal.addEventListener(
                      "abort",
                      () => {
                        trace.push(["abort"]);
                        resolve();
                      },
                      { once: true },
                    ),
                  );
                },
              },
            }),
          );
          for (const callback of callbacks) callback(event);
          await Promise.resolve();
          await dispose();
        }
        await Promise.resolve();
        return trace;
      }
      assert.deepEqual(
        await observe(false),
        await observe(true),
        "host version " + version,
      );
    }
  } finally {
    Date.now = clock;
  }
});

import type { FmcadOptions, FmcadServices } from "../src/api";
import type { Dependencies } from "../packages/opencode-adapter/src/shared/contracts";
interface ToolContext {
  sessionID: string;
  agent: string;
  messageID: string;
  id: string;
  directory: string;
  worktree: string;
  signal: AbortSignal;
  metadata(): void;
  abort?: AbortSignal;
  ask?: (value: unknown) => Promise<void>;
}
interface Definition {
  name: string;
  args?: unknown;
  execute(input: unknown, context: ToolContext): Promise<unknown>;
}
interface TestPlugin {
  id: string;
  server(
    input: unknown,
    options?: unknown,
  ): Promise<{ tool: Record<string, Definition>; dispose(): Promise<void> }>;
  setup(context: unknown): Promise<() => Promise<void>>;
}
import { createRequire } from "node:module";
import type { TestContext } from "node:test";
import { at, record, list, text } from "./integration/offline-cli";
const testRoot = process.cwd();
const runtimeRequire = createRequire(
  testRoot + "/tests/opencode-adapters.test.js",
);
function present<T>(value: T | null | undefined): T {
  assert(value != null);
  return value;
}
import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
const root = path.resolve(testRoot + "/tests", "..");

// An actual npm-packed plugin, outside the repository and its dependency ancestry.
// Only the library port is replaced; host entrypoint, schemas, validation,
// permissions, SDK tool helper and cleanup are the shipped implementation.
async function fixture(
  t: TestContext,
  host: "v1" | "v2",
  { realServices = false, projectDirectory = "/project/session-worktree" } = {},
) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "fmcad-plugin-consumer-"),
  );
  const pkg = path.join(directory, "node_modules/fmcad");
  t.after(() => {
    if (pkg && fs.existsSync(pkg)) {
      for (const entry of fs.readdirSync(pkg, {
        recursive: true,
        withFileTypes: true,
      })) {
        if (entry.isDirectory())
          fs.chmodSync(path.join(entry.parentPath, entry.name), 0o755);
      }
      fs.chmodSync(pkg, 0o755);
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const hostPackage = host === "v1" ? ["@opencode-ai/plugin@1.18.29"] : [];
  const packed = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", directory],
      {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      },
    ),
  )[0];
  fs.writeFileSync(
    path.join(directory, "package.json"),
    '{"private":true,"type":"module"}',
  );
  execFileSync(
    "npm",
    [
      "install",
      "--offline",
      "--prefix",
      directory,
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      path.join(directory, packed.filename),
      ...hostPackage,
    ],
    { cwd: directory, encoding: "utf8" },
  );
  for (const entry of fs.readdirSync(pkg, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (entry.isDirectory())
      fs.chmodSync(path.join(entry.parentPath, entry.name), 0o555);
  }
  fs.chmodSync(pkg, 0o555);
  const localRequire = createRequire(path.join(directory, "consumer.cjs"));
  const composition = localRequire(
    path.join(pkg, "dist/src/dist/composition/opencode.js"),
  ) as { dependencies: () => Dependencies };
  const publicApi = localRequire(
    path.join(pkg, "dist/src/dist/api/index.js"),
  ) as typeof import("../src/api");
  const configuration = localRequire(
    path.join(pkg, "dist/src/config.js"),
  ) as typeof import("../src/composition/library-configuration");
  const calls: unknown[][] = [],
    instances: FmcadOptions[] = [],
    permissions: unknown[] = [],
    events: unknown[] = [];
  let closeCount = 0,
    disposed = 0,
    transforms = 0,
    eventAborted = false,
    rejectPermission: unknown;
  let execute: (...input: unknown[]) => Promise<unknown> = async () => ({
    version: 1,
    jobId: "job-1",
    requestId: "req-1",
    state: "unknown",
    outcome: { state: "unknown" },
    result: null,
  });
  const catalog = publicApi.createCatalogServices();
  composition.dependencies = () => ({
    catalog,
    requestID: () => "req-generated",
    instanceID: "instance-1",
    clientID: (session, agent) => `opencode:${session}:${agent}`,
    config: (cwd, options) => {
      calls.push(["config", cwd, options]);
      if (realServices) {
        const loaded = configuration.loadConfig({ cwd }).cfg;
        return { ...loaded, ...(options["config"] || {}) };
      }
      return {} as FmcadOptions["config"];
    },
    presence: () => ({
      touch: (...value) => events.push(["touch", ...value]),
      event: (value) => events.push(["event", value]),
      close: async () => {
        closeCount++;
      },
    }),
    create: (options) => {
      instances.push(options);
      if (realServices) return publicApi.createFmcad(options);
      const services = {
        start: async () => calls.push(["start"]),
        dispose: async () => {
          disposed++;
        },
        execute: async (...input: unknown[]) => {
          calls.push(["execute", ...input]);
          return execute(...input);
        },
        query: {
          status: async () => ({ active: true }),
          result: async (id: string) => ({ jobId: id, state: "unknown" }),
          request: async (id: string) => ({ requestId: id, state: "unknown" }),
        },
        control: async (request: unknown) => {
          calls.push(["control", request]);
          return { state: "queued_cancelled" };
        },
      };
      return services as unknown as FmcadServices;
    },
  });
  let entrypoint;
  if (host === "v2") {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(pkg, "package.json"), "utf8"),
    );
    assert.equal(manifest.peerDependencies["@opencode/plugin"], ">=2.1.3 <3");
    assert.equal(manifest.engines.opencode, ">=1.18.29 <2 || >=2.1.3 <3");
    entrypoint = path.resolve(pkg, manifest.exports["."].default);
  } else {
    // 1.18.29 shared.ts resolvePackageEntrypoint: ./server, then main.
    const manifest = JSON.parse(
      fs.readFileSync(path.join(pkg, "package.json"), "utf8"),
    );
    entrypoint = path.resolve(
      pkg,
      manifest.exports["./server"].default || manifest.main,
    );
  }
  const namespace = await import(pathToFileURL(entrypoint).href);
  const plugin = namespace.default as TestPlugin;
  assert.deepEqual(Object.keys(namespace), ["default"]);
  assert.equal(plugin.id, "fmcad");
  assert.equal(typeof plugin.server, "function");
  assert.equal(typeof plugin.setup, "function");
  assert.equal(instances.length, 0, "root import must be effect free");
  let cleanup: (() => Promise<void>) | undefined,
    definitions: Record<string, Definition> | undefined,
    v2Context: Record<string, unknown> | undefined;
  const ctx: ToolContext = {
    sessionID: "ses-caller",
    agent: "build",
    messageID: "msg-1",
    id: "call-1",
    directory: projectDirectory,
    worktree: "/project",
    signal: new AbortController().signal,
    metadata() {},
  };
  const authorize = async (value: unknown) => {
    permissions.push(value);
    if (rejectPermission) throw rejectPermission;
  };
  if (host === "v1") {
    await assert.rejects(
      plugin.server({}),
      (error: unknown) => record(error)["code"] === "FMCAD_UNSUPPORTED_HOST",
    );
    // The 1.18.29 object loader's readV1Plugin/applyPlugin selects .server,
    // not the setup property. The actual pinned SDK validates V1 args below.
    const hooks = await plugin.server(
      {
        directory: "/plugin/location",
        project: { id: "project-session" },
        client: { session: { get() {} } },
      },
      { config: { timeoutMs: 5000 } },
    );
    definitions = hooks.tool;
    cleanup = hooks.dispose;
    ctx.abort = ctx.signal;
    ctx.ask = authorize;
  } else {
    const v2 = {
      app: { version: "2.1.3" },
      location: { directory: "/plugin/location" },
      options: { config: { timeoutMs: 5000 } },
      session: {
        async get(
          input: { sessionID: string },
          options: { signal: AbortSignal },
        ) {
          assert.equal(input.sessionID, ctx.sessionID);
          assert.equal(options.signal, ctx.signal);
          return {
            projectID: "project-session",
            location: { directory: "/project/session-worktree" },
          };
        },
      },
      permission: { assert: authorize },
      event: {
        async *subscribe({ signal }: { signal: AbortSignal }) {
          await new Promise<void>((resolve) =>
            signal.addEventListener(
              "abort",
              () => {
                eventAborted = true;
                resolve();
              },
              { once: true },
            ),
          );
        },
      },
      tool: {
        async transform(
          callback: (editor: { add(definition: Definition): void }) => void,
        ) {
          transforms++;
          definitions = {};
          const editor = {
            add(definition: Definition) {
              present(definitions)[definition.name] = definition;
            },
          };
          callback(editor);
          callback(editor);
          assert.equal(
            calls.length,
            0,
            "replaying transform must not start services",
          );
          return {
            async dispose() {
              transforms--;
            },
          };
        },
      },
    };
    v2Context = v2;
    for (const version of ["3.0.0", "2.1.2", "2.0.0", "2.1.3-beta"]) {
      await assert.rejects(
        plugin.setup({ ...v2, app: { version } }),
        (error: unknown) => record(error)["code"] === "FMCAD_UNSUPPORTED_HOST",
      );
    }
    assert.equal(transforms, 0);
    cleanup = await plugin.setup(v2);
    assert.ok(
      !fs.existsSync(path.join(directory, "node_modules/@opencode-ai")),
    );
  }
  const invoke = async (name: string, input: unknown, signal?: AbortSignal) => {
    if (signal) {
      ctx.signal = signal;
      ctx.abort = signal;
    }
    const definition = present(present(definitions)[name]);
    if (host === "v1") {
      const { z } = await import(
        pathToFileURL(path.join(directory, "node_modules/zod/index.js")).href
      );
      input = (
        z as { object(args: unknown): { parse(value: unknown): unknown } }
      )
        .object(definition.args)
        .parse(input);
    }
    const result = await definition.execute(input, ctx);
    return record(
      JSON.parse(text(host === "v1" ? result : at(result, "content"))),
    );
  };
  return {
    directory,
    pkg,
    calls,
    instances,
    permissions,
    events,
    invoke,
    cleanup: present(cleanup),
    plugin,
    deny(value: unknown) {
      rejectPermission = value;
    },
    execute(value: (...args: unknown[]) => Promise<unknown>) {
      execute = value;
    },
    counts: () => ({ closeCount, disposed, transforms, eventAborted }),
    failSetup(error: unknown) {
      return plugin.setup({
        ...v2Context,
        tool: {
          async transform() {
            throw error;
          },
        },
      });
    },
  };
}

for (const host of ["v1", "v2"] as const) {
  test(`packed ${host}: catalog, session context, permission deny, receipts/control and own cleanup`, async (t) => {
    const f = await fixture(t, host);
    const help = await f.invoke("fmcad_help", {});
    assert.equal(help["directory"], "/project/session-worktree");
    assert.ok(list(help["operations"]).length > 10);
    assert.equal(f.calls.length, 0);
    const rejection = Object.assign(new Error("denied"), {
      code: "HOST_PERMISSION_DENIED",
    });
    f.deny(rejection);
    const input = {
      invocation: {
        version: 1,
        kind: "cad",
        operation: "document.status",
        data: {},
        doc: "Model",
        docId: "creation",
        docFileId: "file",
        purpose: "Inspect pinned model",
      },
      requestId: "req-1",
      sequence: { action: "begin", mode: "automatic" },
      queueTimeoutMs: 10000,
      expectedRevision: 7,
    };
    await assert.rejects(
      f.invoke("fmcad_execute", input),
      (error) => error === rejection,
    );
    assert.equal(f.instances.length, 0);
    f.deny(undefined);
    const result = await f.invoke("fmcad_execute", input);
    assert.equal(result["state"], "unknown");
    assert.equal(record(result["outcome"])["state"], "unknown");
    const actions = f.permissions.map(
      (value) => record(value)["action"] || record(value)["permission"],
    );
    assert.deepEqual(actions.slice(-2), [
      "fmcad_execute",
      host === "v2" ? "shell" : "bash",
    ]);
    assert.equal(
      present(f.instances[0]).context.projectDirectory,
      "/project/session-worktree",
    );
    assert.equal(present(f.instances[0]).context.sessionId, "ses-caller");
    assert.equal(present(f.instances[0]).context.projectId, "project-session");
    assert.equal(
      present(f.instances[0]).context.clientId,
      "opencode:ses-caller:build",
    );
    assert.deepEqual(
      present(f.calls.find((value) => value[0] === "execute")).slice(1),
      [
        input.invocation,
        {
          requestId: "req-1",
          sequence: input.sequence,
          queueTimeoutMs: 10000,
          expectedRevision: 7,
        },
      ],
    );
    assert.equal(
      (
        await f.invoke("fmcad_execute", {
          action: "request",
          requestId: "req-1",
        })
      )["state"],
      "unknown",
    );
    assert.equal(
      (await f.invoke("fmcad_execute", { action: "result", jobId: "job-1" }))[
        "state"
      ],
      "unknown",
    );
    await f.invoke("fmcad_execute", { action: "cancel", jobId: "job-1" });
    assert.deepEqual(
      present(f.calls.find((value) => value[0] === "control"))[1],
      {
        version: 1,
        action: "cancel",
        jobId: "job-1",
      },
    );
    await assert.rejects(f.invoke("fmcad_execute", { action: "serve" }));
    const machineError = Object.assign(
      new Error("Lost admission acknowledgement"),
      { code: "QUEUE_IPC_TIMEOUT" },
    );
    f.execute(async () => {
      throw machineError;
    });
    await assert.rejects(
      f.invoke("fmcad_execute", { ...input, requestId: "machine-error" }),
      (error) => error === machineError,
    );
    await assert.rejects(
      f.invoke("fmcad_execute", { invocation: { version: 99 } }),
      (error: unknown) => record(error)["code"] === "FMCAD_INVALID_INPUT",
    );
    const aborted = new AbortController();
    aborted.abort(machineError);
    await assert.rejects(
      f.invoke("fmcad_help", {}, aborted.signal),
      (error) => error === machineError,
    );
    await f.cleanup();
    await f.cleanup();
    assert.equal(f.counts().disposed, 1);
    assert.equal(f.counts().closeCount, 1);
    if (host === "v2") {
      assert.equal(f.counts().transforms, 0);
      assert.equal(f.counts().eventAborted, true);
    }
    const inactive =
      host === "v2" ? "/opencode-adapter/v1/" : "/opencode-adapter/v2/";
    assert.ok(
      !Object.keys(runtimeRequire.cache).some(
        (file) => file.startsWith(f.pkg) && file.includes(inactive),
      ),
      "inactive adapter is not loaded",
    );
  });

  test(`packed ${host}: abort is local only, unknown work is not replayed or cancelled`, async (t) => {
    const f = await fixture(t, host);
    const controller = new AbortController();
    let settle: ((value: unknown) => void) | undefined,
      admitted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    f.execute(
      () =>
        new Promise((resolve) => {
          settle = resolve;
          present(admitted)();
        }),
    );
    const call = f.invoke(
      "fmcad_execute",
      {
        requestId: "stable-request",
        invocation: {
          version: 1,
          kind: "cad",
          operation: "document.status",
          data: {},
          doc: "Model",
        },
      },
      controller.signal,
    );
    await started;
    const cancelled = Object.assign(
      new Error("local aborted; reconcile stable-request"),
      { code: "LOCAL_ABORT" },
    );
    controller.abort(cancelled);
    await assert.rejects(call, (error) => error === cancelled);
    await f.cleanup();
    assert.equal(
      f.counts().disposed,
      1,
      "dispose must not wait for unknown completion",
    );
    assert.equal(f.calls.filter((value) => value[0] === "execute").length, 1);
    assert.equal(f.calls.filter((value) => value[0] === "control").length, 0);
    present(settle)({ state: "unknown", jobId: "accepted" });
  });
}

for (const host of ["v1", "v2"] as const) {
  test(`built ${host}: a stopped broker never falls back to the configured physical endpoint`, async (t) => {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), "fmcad-plugin-stopped-broker-"),
    );
    const project = path.join(home, "project");
    fs.mkdirSync(project);
    let physicalRequests = 0;
    const server = (
      runtimeRequire("node:http") as typeof import("node:http")
    ).createServer((request, response) => {
      physicalRequests++;
      request.resume();
      request.on("end", () => response.end("{}"));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const configPath = path.join(home, "config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        backend: "mcp",
        routing: "queue",
        url: `http://127.0.0.1:${record(present(server.address()))["port"]}/mcp`,
        headers: {},
        timeoutMs: 1000,
        tool: "fusion_mcp_execute",
        transport: "node",
        protocolVersion: "2025-06-18",
        queue: { autoStart: false, autoRecover: false },
      }),
    );
    const names = ["XDG_STATE_HOME", "FMCAD_CONFIG", "FMCAD_ROUTING"];
    const before = Object.fromEntries(
      names.map((name) => [name, process.env[name]]),
    );
    process.env["XDG_STATE_HOME"] = home;
    process.env["FMCAD_CONFIG"] = configPath;
    process.env["FMCAD_ROUTING"] = "queue";
    t.after(async () => {
      for (const name of names) {
        if (before[name] === undefined) delete process.env[name];
        else process.env[name] = before[name];
      }
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(home, { recursive: true, force: true });
    });

    const f = await fixture(t, host, {
      realServices: true,
      projectDirectory: project,
    });
    const input = {
      invocation: {
        version: 1,
        kind: "cad",
        operation: "document.status",
        data: {},
        doc: "Model",
        docId: "creation",
      },
      requestId: `stopped-${host}`,
    };
    await assert.rejects(f.invoke("fmcad_execute", input), (error) => {
      assert.match(
        text(at(error, "message")),
        /ENOENT|ECONNREFUSED|broker|queue/i,
      );
      return true;
    });
    assert.equal(
      f.instances.length,
      1,
      "the adapter delegates only to the public library API",
    );
    await f.cleanup();
    assert.equal(
      physicalRequests,
      0,
      "a stopped broker cannot dispatch directly to the MCP endpoint",
    );
  });
}

test("external root import needs no host SDK and has no service effects", (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "fmcad-plugin-import-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, "package.json"), '{"private":true}');
  const packed = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", directory],
      {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      },
    ),
  )[0];
  execFileSync(
    "npm",
    [
      "install",
      "--offline",
      "--prefix",
      directory,
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      path.join(directory, packed.filename),
    ],
    { cwd: directory, encoding: "utf8" },
  );
  const loader = path.join(directory, "no-effects-loader.mjs");
  fs.writeFileSync(
    loader,
    `
    export async function resolve(specifier, context, nextResolve) {
      if (/opencode|composition|child_process/.test(specifier)) throw new Error('unexpected import ' + specifier);
      return nextResolve(specifier, context);
    }
  `,
  );
  const child = spawnSync(
    process.execPath,
    [
      "--loader",
      loader,
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    const {default: plugin} = await import('fmcad');
    assert.equal(plugin.id,'fmcad');
    assert.equal(typeof plugin.setup,'function');
    assert.equal(typeof plugin.server,'function');
  `,
    ],
    {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, NODE_PATH: "" },
    },
  );
  assert.equal(child.status, 0, child.stderr);
  assert(
    !fs.existsSync(path.join(directory, "node_modules/@opencode-ai/plugin")),
  );
  assert(!fs.existsSync(path.join(directory, "node_modules/@opencode/plugin")));
  const manifest = runtimeRequire("../package.json");
  assert.equal(manifest.devDependencies["@opencode-ai/plugin"], "1.18.29");
  assert.equal(manifest.devDependencies["@opencode/plugin"], "2.1.3");
  assert.equal(
    manifest.peerDependenciesMeta["@opencode-ai/plugin"].optional,
    true,
  );
  assert.equal(manifest.dependencies["@opencode-ai/plugin"], undefined);
  fs.writeFileSync(
    path.join(directory, "consumer.mts"),
    `import plugin from 'fmcad'; const id: string = plugin.id; void id;`,
  );
  const types = spawnSync(
    process.execPath,
    [
      path.join(root, "node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "false",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2023",
      "consumer.mts",
    ],
    { cwd: directory, encoding: "utf8" },
  );
  assert.equal(types.status, 0, types.stderr + types.stdout);
});

test("packed V2 setup failure cleans owned resources and never falls back to V1", async (t) => {
  const f = await fixture(t, "v2");
  const failure = Object.assign(new Error("registration failed"), {
    code: "HOST_REGISTRATION_FAILED",
  });
  await assert.rejects(f.failSetup(failure), (error) => error === failure);
  assert.equal(f.counts().closeCount, 1);
  assert.equal(f.instances.length, 0);
  assert.ok(
    !Object.keys(runtimeRequire.cache).some(
      (file) =>
        file.startsWith(f.pkg) && file.includes("/opencode-adapter/v1/"),
    ),
  );
  await f.cleanup();
  assert.equal(f.counts().closeCount, 2);
});

test("public API sequence options and purpose reach existing submit; invalid/local controls never submit", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-plugin-api-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `
    const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
    const directory = ${JSON.stringify(directory)};
    const config = {
      ...require('./src/dist/core').resolveFmcadConfiguration({ adapter: {routing:'queue'}, environment:{}, file:{}, platformDefaults:{}, acceptedService:null }),
      queue: { autoStart: false, startupTimeoutMs: 45000, client: 'opencode-typed' },
      controlCenter: { port: 5481 },
    };
    fs.writeFileSync(path.join(directory,'broker.lock'),JSON.stringify({protocol:2}));
    fs.writeFileSync(path.join(directory,'queue-state.json'),JSON.stringify({version:1}));
    const brokerConfigHash=require('./src/queue-instance').brokerConfigHash;
    fs.writeFileSync(path.join(directory,'instance.json'),JSON.stringify({buildHash:'same',configHash:brokerConfigHash(config)}));
    const Module = require('node:module'), load = Module._load;
    let submitted = 0;
    Module._load = function(name, parent, ...rest) {
      if (name.endsWith('/queue-connection')) return {queueDirectory:()=>directory};
      if (name.endsWith('/queue-instance')) return {buildHash:()=> 'same',brokerConfigHash};
      if (name.endsWith('/queue-client')) return {QueueClient:class {
        async register() {}
        dispose() {}
        async call(action, value) {
          if(action==='control-status') return {buildHash:'same',unresolved:false,activeOperations:0};
          assert.equal(action,'submit'); submitted++;
          assert.deepEqual(value.request.sequence,{action:'continue',id:'sequence-1',mode:'automatic'});
          assert.equal(value.request.expectedRevision,7);
          assert.equal(value.request.queueTimeoutMs,1234);
          assert.equal(value.request.description,'Inspect pinned model');
          throw Object.assign(new Error('unknown acknowledgement'),{code:'QUEUE_IPC_TIMEOUT'});
        }
      }};
      return load.call(this,name,parent,...rest);
    };
    (async()=>{
      const {createFmcad}=require('fmcad/api');
      const api=createFmcad({version:1,config,context:{clientId:'plugin-test',instanceId:'plugin-instance',source:'opencode',projectDirectory:directory}});
       const input={version:1,kind:'cad',operation:'document.status',doc:'Model',docId:'creation',docFileId:'file',data:{},purpose:'Inspect pinned model'};
      for(const options of [{sequence:{action:'begin',id:'bad'}},{sequence:{action:'continue'}},{expectedRevision:-1},{queueTimeoutMs:0}]) {
        await assert.rejects(api.execute(input,{requestId:'invalid',...options}));
      }
      await assert.rejects(api.execute({...input,preview:true},{requestId:'local',sequence:{action:'begin'}}), /Queue controls/);
      assert.equal(submitted,0);
      await api.start();
      await assert.rejects(api.execute(input,{requestId:'stable',sequence:{action:'continue',id:'sequence-1',mode:'automatic'},expectedRevision:7,queueTimeoutMs:1234}),e=>e.code==='QUEUE_IPC_TIMEOUT');
      assert.equal(submitted,1);
      await api.dispose();
    })().catch(e=>{console.error(e);process.exitCode=1});
  `,
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr);
});

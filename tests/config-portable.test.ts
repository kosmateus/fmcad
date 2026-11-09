import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
const load = createRequire(__filename),
  root = process.cwd();
import test from "node:test";
const {
  loadConfig,
  initConfig,
  writeAcceptedServiceConfiguration,
  acceptedServiceConfigurationPath,
} = load(
  path.join(root, "src/config"),
) as typeof import("../src/composition/library-configuration");

const CONFIG_ENV = [
  "FMCAD_CONFIG",
  "FMCAD_BACKEND",
  "FMCAD_URL",
  "FMCAD_ENDPOINT",
  "FMCAD_HEADERS",
  "FMCAD_TIMEOUT",
  "FMCAD_TIMEOUT_MS",
  "FMCAD_TOOL",
  "FMCAD_TRANSPORT",
  "FMCAD_CURL_PATH",
  "FMCAD_PROTOCOL_VERSION",
  "FMCAD_ROUTING",
  "FMCAD_CONTROL_CENTER_PORT",
  "FMCAD_QUEUE_AUTO_START",
  "FMCAD_QUEUE_AUTO_RECOVER",
  "FMCAD_QUEUE_STARTUP_TIMEOUT_MS",
  "FMCAD_QUEUE_WAIT_TIMEOUT_MS",
  "FMCAD_QUEUE_CLIENT",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "WSL_DISTRO_NAME",
];

function fixture(t: import("node:test").TestContext) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "fmcad-config-portable-"),
  );
  const original = new Map(CONFIG_ENV.map((key) => [key, process.env[key]]));
  for (const key of CONFIG_ENV) delete process.env[key];
  process.env["XDG_CONFIG_HOME"] = path.join(directory, "config-home");
  process.env["XDG_STATE_HOME"] = path.join(directory, "state-home");
  t.after(() => {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function writeConfig(directory: string, value: unknown) {
  const file = path.join(directory, "fmcad.json");
  fs.writeFileSync(
    file,
    typeof value === "string" ? value : JSON.stringify(value),
  );
  return file;
}

test("safe defaults use a local add-in endpoint, shared queue routing, and the common panel port", (t) => {
  const directory = fixture(t);
  const { cfg } = loadConfig();
  assert.equal(cfg.backend, "addin");
  assert.equal(cfg.url, "http://127.0.0.1:8765/mcp");
  assert.deepEqual(cfg.headers, {});
  assert.equal(cfg.routing, "queue");
  assert.deepEqual(cfg.controlCenter, { port: 4748 });
  assert.equal(cfg.url.includes("192.168.1.223"), false);
  assert.equal(Object.hasOwn(cfg.headers, "Host"), false);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test("adapter settings override environment and the selected config file", (t) => {
  const directory = fixture(t);
  const file = writeConfig(directory, {
    backend: "mcp",
    backends: {
      mcp: {
        url: "http://127.0.0.1:27183/mcp",
        timeoutMs: 100,
        headers: { "X-File": "file" },
      },
    },
  });
  process.env["FMCAD_URL"] = "http://127.0.0.1:27184/mcp";
  process.env["FMCAD_TIMEOUT_MS"] = "200";
  process.env["FMCAD_HEADERS"] = '{"X-Environment":"environment"}';
  const { cfg } = loadConfig({
    config: file,
    backend: "mcp",
    url: "http://127.0.0.1:27185/mcp",
    timeoutMs: "300",
    headers: { "X-Adapter": "adapter" },
  });
  assert.equal(cfg.url, "http://127.0.0.1:27185/mcp");
  assert.equal(cfg.timeoutMs, 300);
  assert.deepEqual(cfg.headers, {
    "X-File": "file",
    "X-Environment": "environment",
    "X-Adapter": "adapter",
  });
});

test("environment and FMCAD_CONFIG override the user config path without depending on cwd", (t) => {
  const directory = fixture(t);
  const userFile = path.join(
    process.env["XDG_CONFIG_HOME"]!,
    "fmcad",
    "config.json",
  );
  fs.mkdirSync(path.dirname(userFile), { recursive: true });
  fs.writeFileSync(userFile, JSON.stringify({ backend: "addin" }));
  const explicitFile = writeConfig(directory, {
    backend: "mcp",
    backends: { mcp: { url: "http://127.0.0.1:27183/mcp" } },
  });
  process.env["FMCAD_CONFIG"] = explicitFile;
  assert.equal(loadConfig().path, explicitFile);
  assert.equal(loadConfig().cfg.backend, "mcp");
  const selected = loadConfig({ config: userFile });
  assert.equal(selected.path, userFile);
  assert.equal(selected.cfg.backend, "addin");
});

test("CLI and MCP config resolution use the same explicit file outside OpenCode cwd discovery", (t) => {
  const directory = fixture(t);
  const file = path.join(
    process.env["XDG_CONFIG_HOME"]!,
    "fmcad",
    "shared.json",
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      backend: "mcp",
      routing: "queue",
      controlCenter: { port: 4921 },
      backends: { mcp: { url: "http://127.0.0.1:27183/mcp" } },
    }),
  );
  const environmentConfig = path.relative(
    process.env["XDG_CONFIG_HOME"]!,
    file,
  );
  const cwdA = path.join(directory, "project-a");
  const cwdB = path.join(directory, "project-b");
  fs.mkdirSync(cwdA);
  fs.mkdirSync(cwdB);
  const script = `const { loadConfig } = require(${JSON.stringify(path.join(root, "src/config"))}); const value = loadConfig(); console.log(JSON.stringify({ path: value.path, cfg: value.cfg }));`;
  const options = {
    encoding: "utf8" as const,
    env: {
      ...process.env,
      FMCAD_CONFIG: environmentConfig,
      XDG_STATE_HOME: path.join(directory, "state-home"),
    },
  };
  const cli = spawnSync(process.execPath, ["-e", script], {
    ...options,
    cwd: cwdA,
  });
  const mcp = spawnSync(process.execPath, ["-e", script], {
    ...options,
    cwd: cwdB,
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(mcp.status, 0, mcp.stderr);
  assert.deepEqual(JSON.parse(cli.stdout), JSON.parse(mcp.stdout));
  assert.equal(JSON.parse(cli.stdout).path, file);
  assert.equal(JSON.parse(cli.stdout).cfg.url, "http://127.0.0.1:27183/mcp");
  assert.equal(JSON.parse(cli.stdout).cfg.controlCenter.port, 4921);
});

test("JSONC preserves URL slashes and accepts comments and trailing commas", (t) => {
  const directory = fixture(t);
  const file = writeConfig(
    directory,
    `{
    // The URL is data, not a line comment.
    "backend": "mcp",
    "backends": {
      "mcp": { "url": "http://127.0.0.1:27183/mcp", },
    },
    "controlCenter": { "port": 4748, },
  }`,
  );
  const { cfg } = loadConfig({ config: file });
  assert.equal(cfg.url, "http://127.0.0.1:27183/mcp");
  assert.equal(cfg.controlCenter.port, 4748);
});

test("explicit mcp backend requires its own endpoint and direct routing is rejected offline", (t) => {
  const directory = fixture(t);
  const mcp = writeConfig(directory, { backend: "mcp" });
  assert.throws(() => loadConfig({ config: mcp }), /backends\.mcp\.url/);
  const direct = writeConfig(directory, { routing: "direct" });
  assert.throws(
    () => loadConfig({ config: direct }),
    /routing is fixed to "queue"/,
  );
  assert.throws(
    () => loadConfig({ routing: "direct" }),
    /routing is fixed to "queue"/,
  );
  process.env["FMCAD_ROUTING"] = "direct";
  assert.throws(() => loadConfig(), /routing is fixed to "queue"/);
});

test("strict schema rejects unknown fields and conflicting aliases before any connection", (t) => {
  const directory = fixture(t);
  for (const data of [
    { backend: "addin", unexpected: true },
    {
      backends: {
        addin: {
          url: "http://127.0.0.1:8765/mcp",
          endpoint: "http://127.0.0.1:8766/mcp",
        },
      },
    },
    { controlCenter: { port: 4748, listen: "0.0.0.0" } },
    { console: { language: "pl", unexpected: true } },
  ]) {
    const file = writeConfig(directory, data);
    assert.throws(
      () => loadConfig({ config: file }),
      /not supported|aliases conflict/,
    );
  }
  assert.throws(
    () =>
      loadConfig({
        endpoint: "http://127.0.0.1:8765/mcp",
        url: "http://127.0.0.1:8766/mcp",
      }),
    /aliases conflict/,
  );
  assert.throws(
    () =>
      loadConfig({
        headers: { Authorization: "Bearer secret\nInjected: true" },
      }),
    /valid HTTP header/,
  );
});

test("console preferences persisted in the config file remain accepted and local", (t) => {
  const directory = fixture(t);
  const file = writeConfig(directory, {
    backend: "addin",
    console: { language: "pl", color: "off", frames: "ascii", version: 1 },
  });

  const { cfg } = loadConfig({ config: file });
  assert.equal(cfg.backend, "addin");
  assert.equal(Object.hasOwn(cfg, "console"), false);
  assert.deepEqual(
    (
      load(
        path.join(root, "src/i18n"),
      ) as typeof import("../src/composition/library-i18n")
    ).preferences(file),
    {
      language: "pl",
      color: "off",
      frames: "ascii",
    },
  );
});

test("backend URL validation rejects the Control Center, nonlocal add-ins, URL credentials, and secret queries", (t) => {
  const directory = fixture(t);
  for (const value of [
    {
      backend: "addin",
      backends: { addin: { url: "http://localhost:4748/mcp" } },
    },
    { backend: "addin", backends: { addin: { url: "http://127.1:4748/mcp" } } },
    {
      backend: "addin",
      backends: { addin: { url: "http://2130706433:4748/mcp" } },
    },
    {
      backend: "addin",
      backends: { addin: { url: "http://localhost.:4748/mcp" } },
    },
    {
      backend: "addin",
      backends: { addin: { url: "http://example.com:8765/mcp" } },
    },
    {
      backend: "mcp",
      backends: { mcp: { url: "http://user:password@127.0.0.1:27183/mcp" } },
    },
    {
      backend: "mcp",
      backends: {
        mcp: { url: "http://127.0.0.1:27183/mcp?access_token=very-secret" },
      },
    },
  ]) {
    const file = writeConfig(directory, value);
    assert.throws(
      () => loadConfig({ config: file }),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.doesNotMatch(error.message, /password|very-secret/);
        return /url|endpoint|Control Center|loopback/i.test(error.message);
      },
    );
  }
});

test("shared service port must be an integer and conflicting settings refuse to resolve", (t) => {
  const directory = fixture(t);
  for (const port of [0, -1, 65536, 4748.5, "4748"]) {
    const file = writeConfig(directory, { controlCenter: { port } });
    assert.throws(
      () => loadConfig({ config: file }),
      /controlCenter\.port must be an integer from 1 to 65535/,
    );
  }
  const file = writeConfig(directory, { controlCenter: { port: 5001 } });
  process.env["FMCAD_CONTROL_CENTER_PORT"] = "5002";
  assert.throws(
    () => loadConfig({ config: file }),
    /conflicts between shared-service/,
  );
  delete process.env["FMCAD_CONTROL_CENTER_PORT"];
  assert.throws(
    () => loadConfig({ config: file, controlCenter: { port: 5002 } }),
    /conflicts between shared-service/,
  );
});

test("verified service port is the fallback, and a new client cannot select a second panel port", (t) => {
  const directory = fixture(t);
  writeAcceptedServiceConfiguration({
    version: 1,
    controlCenter: { port: 5391 },
  });
  const acceptedPath = acceptedServiceConfigurationPath();
  assert.equal(fs.statSync(acceptedPath).mode & 0o077, 0);
  const file = writeConfig(directory, { backend: "addin" });
  assert.equal(loadConfig({ config: file }).cfg.controlCenter.port, 5391);
  assert.throws(
    () => loadConfig({ config: file, controlCenter: { port: 4748 } }),
    /last verified fmcad service/,
  );
  assert.throws(
    () =>
      loadConfig({
        config: writeConfig(directory, {
          backend: "mcp",
          backends: { mcp: { url: "http://127.0.0.1:27183/mcp" } },
          controlCenter: { port: 5391 },
        }),
        url: "http://127.0.0.1:5391/mcp",
      }),
    /Control Center/,
  );
});

test("ordinary loading never reads OpenCode config; explicit import maps remote aliases only", (t) => {
  const directory = fixture(t);
  t.mock.method(os, "homedir", () => directory);
  const openCodeFile = path.join(directory, ".opencode", "opencode.jsonc");
  fs.mkdirSync(path.dirname(openCodeFile), { recursive: true });
  fs.writeFileSync(
    openCodeFile,
    '{"mcp":{"servers":{"fusion":{"type":"remote","endpoint":"http://127.0.0.1:27183/mcp","transport":"http","timeout":90000,"headers":{"Authorization":"Bearer private"}}}}}',
  );
  const ownFile = writeConfig(directory, { backend: "addin" });
  assert.equal(loadConfig({ config: ownFile }).cfg.backend, "addin");

  const destination = path.join(directory, "migrated.json");
  const result = initConfig({ fromOpencode: true, config: destination });
  assert.doesNotMatch(result.note, /private/);
  const { cfg } = loadConfig({ config: destination });
  assert.equal(cfg.backend, "mcp");
  assert.equal(cfg.url, "http://127.0.0.1:27183/mcp");
  assert.equal(cfg.timeoutMs, 90000);
  assert.equal(cfg.transport, "node");
  assert.equal(cfg.headers["Authorization"], "Bearer private");
  assert.equal(fs.readFileSync(openCodeFile, "utf8").includes("private"), true);
  assert.equal(fs.statSync(destination).mode & 0o077, 0);
});

test("explicit migration rejects local OpenCode MCP and leaves the destination untouched", (t) => {
  const directory = fixture(t);
  t.mock.method(os, "homedir", () => directory);
  const source = path.join(directory, ".opencode", "opencode.json");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(
    source,
    JSON.stringify({
      mcp: { fusion: { type: "local", command: "node", args: ["private.js"] } },
    }),
  );
  const destination = path.join(directory, "existing.json");
  fs.writeFileSync(destination, "existing");
  assert.throws(
    () => initConfig({ fromOpencode: true, force: true, config: destination }),
    /local\/stdio MCP server/,
  );
  assert.equal(fs.readFileSync(destination, "utf8"), "existing");
});

test("explicit migration maps legacy transport and field aliases without conflating curl and Node", (t) => {
  const directory = fixture(t);
  t.mock.method(os, "homedir", () => directory);
  const source = path.join(directory, ".config", "opencode", "opencode.json");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(
    source,
    JSON.stringify({
      mcp: {
        fusion: {
          type: "remote",
          url: "http://127.0.0.1:27183/mcp",
          transport: "curl",
          timeoutMs: 45000,
          "curl-path": "/test/curl.exe",
        },
      },
    }),
  );
  const destination = path.join(directory, "migrated.json");
  initConfig({ fromOpencode: true, config: destination });
  const { cfg } = loadConfig({ config: destination });
  assert.equal(cfg.url, "http://127.0.0.1:27183/mcp");
  assert.equal(cfg.transport, "windows-curl");
  assert.equal(cfg.curlPath, "/test/curl.exe");
  assert.equal(cfg.timeoutMs, 45000);
});

test("JSONC diagnostics report only a location, never malformed secret fragments", (t) => {
  const directory = fixture(t);
  const secret = "do-not-print-this-secret";
  const file = writeConfig(
    directory,
    `{"headers":{"Authorization":"Bearer ${secret}" oops}}`,
  );
  assert.throws(
    () => loadConfig({ config: file }),
    (error: unknown) => {
      assert(error instanceof Error);
      assert.match(error.message, /Invalid JSONC \(line \d+ column \d+\)/);
      assert.doesNotMatch(error.message, /Authorization|Bearer|do-not-print/);
      return true;
    },
  );
});

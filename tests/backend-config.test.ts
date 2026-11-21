import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { createRequire } from "node:module";
const { loadConfig, initConfig, DEFAULTS } = createRequire(__filename)(
  path.join(process.cwd(), "src/config"),
) as typeof import("../src/composition/library-configuration");

function fixture(t: TestContext, data: unknown = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-backend-"));
  const config = path.join(dir, "config.json");
  const env = { ...process.env };
  for (const key of Object.keys(process.env))
    if (key.startsWith("FMCAD_")) delete process.env[key];
  delete process.env["WSL_DISTRO_NAME"];
  process.env["FMCAD_CONFIG"] = config;
  process.env["XDG_STATE_HOME"] = path.join(dir, "state");
  t.after(() => {
    for (const key of Object.keys(process.env))
      if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.writeFileSync(config, JSON.stringify(data));
  return {
    config,
    dir,
    load: (opts: Record<string, unknown> = {}) =>
      loadConfig({ config, ...opts }).cfg,
  };
}

test("safe addin defaults reject a newly configured native MCP backend", (t) => {
  const f = fixture(t);
  assert.deepEqual(f.load(), {
    backend: "addin",
    ...DEFAULTS,
    routing: "queue",
    queue: {},
    controlCenter: { port: 4748 },
  });
  fs.writeFileSync(
    f.config,
    JSON.stringify({
      backend: "mcp",
      url: "http://legacy.invalid/mcp",
      headers: { Extra: "yes" },
      timeoutMs: 42,
      tool: "legacy",
    }),
  );
  assert.throws(() => f.load(), /backend "mcp" is no longer supported/);
});

test("native MCP profiles and port 27182 are rejected without addin fallback", (t) => {
  const f = fixture(t, {
    backend: "addin",
    backends: {
      mcp: { url: "http://127.0.0.1:27182/mcp" },
    },
  });
  assert.throws(() => f.load(), /backends\.mcp is no longer supported/);
  fs.writeFileSync(
    f.config,
    JSON.stringify({
      backend: "addin",
      backends: { addin: { url: "http://127.0.0.1:27182/mcp" } },
    }),
  );
  assert.throws(() => f.load(), /port 27182/);
  assert.throws(
    () => f.load({ url: "http://127.0.0.1:8765/mcp" }),
    /port 27182/,
  );
  fs.writeFileSync(f.config, JSON.stringify({ backend: "addin" }));
  assert.throws(
    () => f.load({ url: "http://127.0.0.1:27182/mcp" }),
    /port 27182/,
  );
});

test("backend priority is adapter, environment, file, then safe default", (t) => {
  const f = fixture(t, {
    backend: "addin",
    backends: { addin: { url: "http://127.0.0.1:8766/mcp" } },
  });
  assert.equal(f.load().backend, "addin");
  process.env["FMCAD_BACKEND"] = "mcp";
  assert.throws(() => f.load(), /backend "mcp" is no longer supported/);
  assert.throws(
    () => f.load({ backend: "addin" }),
    /backend "mcp" is no longer supported/,
  );
  assert.throws(() => loadConfig(), /backend "mcp" is no longer supported/);
});

test("retired top-level MCP settings are rejected instead of falling back to addin", (t) => {
  const f = fixture(t, {
    backend: "addin",
  });
  for (const setting of [
    { url: "http://native.invalid/mcp" },
    { headers: { Host: "native" } },
    { timeoutMs: 1 },
    { tool: "native" },
    { transport: "invalid" },
    { curlPath: "/native" },
    { protocolVersion: "native" },
  ]) {
    fs.writeFileSync(
      f.config,
      JSON.stringify({ backend: "addin", ...setting }),
    );
    assert.throws(() => f.load(), /retired native MCP setting/);
  }
});

test("addin fields and explicit adapter values follow precedence", (t) => {
  const f = fixture(t, {
    backend: "addin",
    backends: {
      addin: {
        url: "http://127.0.0.1:8766/mcp",
        headers: { Selected: "yes" },
        timeoutMs: 34,
        tool: "addin-tool",
        transport: "windows-curl",
        curlPath: "/selected/curl",
        protocolVersion: "custom",
      },
    },
  });
  assert.equal(f.load().url, "http://127.0.0.1:8766/mcp");
  assert.equal(f.load().headers["Selected"], "yes");
  assert.equal(f.load().timeoutMs, 34);
  assert.equal(f.load().tool, "addin-tool");
  assert.deepEqual(
    f.load({
      backend: "addin",
      url: "http://127.0.0.1:8767/mcp",
      headers: { Selected: "cli" },
      timeoutMs: "56",
      transport: "node",
      curlPath: "/cli/curl",
    }),
    {
      backend: "addin",
      url: "http://127.0.0.1:8767/mcp",
      headers: { Selected: "cli" },
      timeoutMs: 56,
      tool: "addin-tool",
      transport: "node",
      curlPath: "/cli/curl",
      protocolVersion: "custom",
      routing: "queue",
      queue: {},
      controlCenter: { port: 4748 },
    },
  );
  assert.equal(
    f.load({ backend: "addin", "curl-path": "/alias/curl", timeout: "78" })
      .curlPath,
    "/alias/curl",
  );
  assert.equal(f.load({ backend: "addin", timeout: "78" }).timeoutMs, 78);
});

test("WSL addin transport is automatic unless an explicit backend transport is selected", (t) => {
  const f = fixture(t, {
    backend: "addin",
  });
  process.env["WSL_DISTRO_NAME"] = "Test";
  const wsl = process.platform === "linux";
  assert.equal(f.load().transport, wsl ? "windows-curl" : "node");
  assert.equal(
    f.load().curlPath,
    wsl ? "/mnt/c/Windows/System32/curl.exe" : undefined,
  );
  for (const transport of ["node", "windows-curl"]) {
    fs.writeFileSync(
      f.config,
      JSON.stringify({
        backend: "addin",
        backends: {
          addin: { transport, curlPath: "/custom" },
        },
      }),
    );
    assert.equal(f.load().transport, transport);
    assert.equal(f.load().curlPath, "/custom");
  }
  assert.throws(
    () => f.load({ backend: "mcp" }),
    /backend "mcp" is no longer supported/,
  );
});

test("invalid backend, transport, routing, and timeout fail during resolution", (t) => {
  const f = fixture(t);
  assert.throws(() => f.load({ backend: "unknown" }), /backend/);
  process.env["FMCAD_BACKEND"] = "unknown";
  assert.throws(() => f.load(), /backend/);
  delete process.env["FMCAD_BACKEND"];
  for (const data of [
    { backend: "unknown" },
    { backend: "addin", backends: { addin: { transport: "auto" } } },
    {
      backend: "mcp",
      backends: { mcp: { url: "http://127.0.0.1:27183/mcp", timeoutMs: 0 } },
    },
  ]) {
    fs.writeFileSync(f.config, JSON.stringify(data));
    assert.throws(() => f.load(), /backend|transport|timeoutMs/i);
  }
  fs.writeFileSync(f.config, "{}");
  assert.throws(() => f.load({ transport: "auto" }), /transport/);
  assert.throws(() => f.load({ routing: "direct" }), /routing is fixed/);
  for (const timeoutMs of [0, -1, NaN, Infinity, -Infinity, "invalid"]) {
    assert.throws(
      () => f.load({ timeoutMs }),
      /finite number greater than zero/,
    );
  }
  fs.writeFileSync(
    f.config,
    JSON.stringify({ backends: { addin: { timeoutMs: -2 } } }),
  );
  assert.throws(() => f.load({ backend: "addin" }), /timeoutMs/);
});

test("init writes safe addin defaults and rejects native MCP templates", (t) => {
  const f = fixture(t);
  const config = path.join(f.dir, "init", "config.json");
  initConfig({ config });
  const addin = JSON.parse(fs.readFileSync(config, "utf8"));
  assert.deepEqual(addin, {
    backend: "addin",
    routing: "queue",
    controlCenter: {},
  });
  assert.equal(loadConfig({ config }).cfg.tool, "execute_python");
  assert.throws(() => initConfig({ config }), /already exists/);
  const before = fs.readFileSync(config, "utf8");
  assert.throws(
    () => initConfig({ config, backend: "mcp", force: true }),
    /backend "mcp" is no longer supported/,
  );
  assert.equal(fs.readFileSync(config, "utf8"), before);
  assert.throws(
    () =>
      initConfig({ config, backend: "addin", fromOpencode: true, force: true }),
    /--from-opencode is no longer supported/,
  );
  assert.throws(
    () => initConfig({ config, backend: "invalid", force: true }),
    /backend/,
  );
  assert.equal(fs.readFileSync(config, "utf8"), before);
});

"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { main } = require("../../src/cli");
const { pinCommand, inputFiles } = require("../../src/queue-client");
const { prepareRequest } = require("../../src/composition/execution-request");
const { buildHash } = require("../../src/queue-instance");
const {
  cadWorkerPolicyArguments,
} = require("../../src/dist/core/application/cad/worker-command");
const image = Buffer.from("mock screenshot bytes");
const textResult = (value) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
});

function brokerGateway(config, calls, respond) {
  const tools = [
    "fusion_mcp_execute",
    "fusion_mcp_read",
    "fusion_mcp_update",
  ].map((name) => ({ name, inputSchema: { type: "object" } }));
  return {
    boundary: "fmcad-broker",
    server: config,
    capabilities: {
      backend: config.backend,
      automaticFallback: false,
      readOnlyEnforced: false,
    },
    serverInfo: { name: "local-test", version: "1" },
    negotiatedProtocolVersion: "2024-11-05",
    async listTools() {
      calls.push({ method: "tools/list" });
      const override = respond?.({ method: "tools/list", params: {} });
      if (override?.status !== undefined && (override.status < 200 || override.status >= 300))
        throw Object.assign(new Error(`HTTP ${override.status}`), { code: "BROKER_TEST_HTTP_FAILURE" });
      const body = override?.body ?? override;
      if (body?.error) throw Object.assign(new Error(body.error.message || "Broker test list failure"), { code: "BROKER_TEST_RPC_FAILURE" });
      return body?.result?.tools ?? tools;
    },
    async callTool(argumentsValue, toolName = config.tool) {
      const message = {
        method: "tools/call",
        params: { name: toolName, arguments: argumentsValue },
      };
      calls.push(message.params);
      const override = respond?.(message);
      if (override) {
        if (
          override.status !== undefined &&
          (override.status < 200 || override.status >= 300)
        )
          throw Object.assign(new Error(`HTTP ${override.status}`), {
            code: "BROKER_TEST_HTTP_FAILURE",
          });
        const body = override.body ?? override;
        if (body.error)
          throw Object.assign(
            new Error(body.error.message || "Broker test RPC failure"),
            { code: "BROKER_TEST_RPC_FAILURE" },
          );
        const result = body.result ?? body;
        let text = Array.isArray(result.content)
          ? result.content
              .filter((item) => item.type === "text")
              .map((item) => item.text)
              .join("\n")
          : typeof result.text === "string"
            ? result.text
            : JSON.stringify(result);
        let failed = result.isError === true;
        let data = result.structuredContent ?? null;
        try {
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            if (parsed.success === false || parsed.error) failed = true;
            if (typeof parsed.message === "string") text = parsed.message;
            if (!data && parsed.success !== undefined) data = parsed;
          }
        } catch { /* Plain text backend replies remain text. */ }
        if (/^ERROR /m.test(text) || data?.success === false || data?.error || data?.isError) failed = true;
        return { text, failed, ...(data ? { data } : {}) };
      }
      const args = argumentsValue;
      if (args.queryType === "document")
        return {
          text: JSON.stringify({
            success: true,
            results: [
              { name: "Part.txt", id: "local-file-1" },
              { name: "Other", id: "local-file-2" },
            ],
          }),
          failed: false,
        };
      if (args.queryType === "screenshot")
        return {
          text: JSON.stringify({ base64Data: image.toString("base64") }),
          failed: false,
        };
      return { text: "DONE", failed: false };
    },
  };
}

async function fixture(t, respond) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fmcad-legacy-"));
  const configPath = path.join(dir, "config.json");
  const url = "http://127.0.0.1:1/mcp?broker-fixture=1";
  await fs.writeFile(
    configPath,
    JSON.stringify({
      backend: "mcp",
      routing: "queue",
      transport: "node",
      url,
      headers: { "X-Config": "isolated" },
      timeoutMs: 30000,
      queue: { autoStart: false },
    }),
  );
  const requests = [],
    calls = [];
  let stdout = "",
    stderr = "";
  const restorePlatform = require("../fixtures/fake-wsl-platform.cjs")();
  process.env.WSL_DISTRO_NAME = "LegacyTest";
  t.after(restorePlatform);
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  async function run(args, options = {}) {
    stdout = "";
    stderr = "";
    const selectedConfig = options.config || configPath;
    const argv = [
      "--config",
      selectedConfig,
      "--url",
      options.offline ? "http://127.0.0.1:1/mcp" : url,
      "--header",
      "X-Legacy:first:second",
      "--header",
      "X-Other:yes",
      "--timeout",
      "30000",
      ...args,
    ];
    const io = {
      stdout: {
        write(value) {
          stdout += String(value);
        },
      },
      stderr: {
        write(value) {
          stderr += String(value);
        },
      },
    };
    const dependencies = {
      ...io,
      setExitCode() {},
      loadConfig: (value) =>
        require("../../src/config").loadConfig({
          ...value,
          config: selectedConfig,
        }),
      async runQueued(rawArgv, config, parsedOptions) {
        const pinnedArgv = pinCommand(rawArgv, {
          cwd: dir,
          config: selectedConfig,
        });
        const request = {
          requestId: randomUUID(),
          kind: "command",
          argv: pinnedArgv,
          cwd: dir,
          timeoutMs: config.timeoutMs,
          backend: config.backend,
          inputFiles: inputFiles(pinnedArgv, dir, { config: selectedConfig }),
          buildHash: buildHash(),
          ...(parsedOptions.description
            ? { description: parsedOptions.description }
            : {}),
        };
        requests.push({
          action: "submit",
          request: structuredClone(request),
          config: structuredClone(config),
        });
        const prepared = prepareRequest({ request });
        const backend = brokerGateway(config, calls, respond);
        if (prepared.payload?.kind === "legacy-command") {
          const originalOut = process.stdout.write,
            originalErr = process.stderr.write;
          process.stdout.write = (value) => {
            stdout += String(value);
            return true;
          };
          process.stderr.write = (value) => {
            stderr += String(value);
            return true;
          };
          try {
            return await require("../../src/composition/legacy-worker").execute(
              prepared,
              backend,
              () => {},
            );
          } finally {
            process.stdout.write = originalOut;
            process.stderr.write = originalErr;
          }
        }
        return require("../../src/cad-service").execute(
          prepared,
          backend,
          () => {},
          io,
        );
      },
      createFmcad(optionsValue) {
        const backend = brokerGateway(optionsValue.config, calls, respond);
        let ready = false;
        return {
          async start() {
            ready = true;
          },
          async dispose() {
            ready = false;
          },
          async execute(payload, execution) {
            assert.ok(
              ready,
              "typed CLI requests start the shared session first",
            );
            const workerIo = {
              stdout: {
                value: "",
                write(value) {
                  this.value += value;
                },
              },
              stderr: {
                value: "",
                write(value) {
                  this.value += value;
                },
              },
            };
            const code = await require("../../src/cad-service").execute(
              { payload, argv: cadWorkerPolicyArguments(payload) },
              backend,
              () => {},
              workerIo,
            );
            return {
              version: 1,
              requestId: execution.requestId,
              jobId: "test-broker-job",
              state: code ? "failed" : "succeeded",
              result: null,
              output: {
                stdout: workerIo.stdout.value,
                stderr: workerIo.stderr.value,
              },
              outcome: {
                version: 1,
                requestId: null,
                jobId: null,
                acceptance: "accepted",
                executionOutcome: code ? "failed" : "succeeded",
                mayHaveMutated: null,
                validation: {
                  status: "not_checked",
                  source: null,
                  artifactId: null,
                  measurements: {},
                },
                code: null,
              },
            };
          },
          query: {
            async result() {
              throw Error("terminal fake receipt must not be polled");
            },
          },
        };
      },
      initConfig: (value) => require("../../src/config").initConfig({
        ...value,
        config: path.join(dir, "init", "config.json"),
      }),
      listScripts: (value) => require("../../src/run").listScripts(value),
    };
    const previousCwd = process.cwd();
    const previousEnvironment = {
      home: process.env.HOME,
      userProfile: process.env.USERPROFILE,
      configHome: process.env.XDG_CONFIG_HOME,
      fmcad: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key.startsWith('FMCAD_')),
      ),
    };
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    process.env.XDG_CONFIG_HOME = path.join(dir, 'xdg-config');
    for (const key of Object.keys(process.env)) if (key.startsWith('FMCAD_')) delete process.env[key];
    process.env.FMCAD_CONFIG = selectedConfig;
    process.env.FMCAD_BACKEND = 'mcp';
    process.env.FMCAD_ROUTING = 'queue';
    process.chdir(dir);
    let code;
    try {
      code = await main(argv, dependencies);
    } finally {
      process.chdir(previousCwd);
      if (previousEnvironment.home === undefined) delete process.env.HOME;
      else process.env.HOME = previousEnvironment.home;
      if (previousEnvironment.userProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousEnvironment.userProfile;
      if (previousEnvironment.configHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousEnvironment.configHome;
      for (const key of Object.keys(process.env)) if (key.startsWith('FMCAD_')) delete process.env[key];
      Object.assign(process.env, previousEnvironment.fmcad);
    }
    return { code, signal: null, stdout, stderr };
  }
  return { dir, url, config: configPath, requests, run, calls: () => calls };
}

function ok(result) {
  assert.equal(result.signal, null, `CLI killed: ${result.stderr}`);
  assert.equal(result.code, 0, result.stderr || result.stdout);
}
function failed(result) {
  assert.equal(result.signal, null, "CLI must exit normally, not time out");
  assert.notEqual(result.code, 0, `unexpected success: ${result.stdout}`);
}
function scriptConfig(script, names) {
  const result = require("node:child_process").spawnSync(
    "python3",
    [path.join(__dirname, "python_config.py")],
    {
      input: JSON.stringify({ script, names }),
      encoding: "utf8",
      timeout: 5000,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
module.exports = { fixture, ok, failed, scriptConfig, textResult, image };

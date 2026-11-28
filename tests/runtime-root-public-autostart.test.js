"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { createRequire } = require("node:module");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const test = require("node:test");

const repo = path.resolve(__dirname, "..");
const load = createRequire(__filename);
const seedRuntimeRoot = load("./fixtures/runtime-root-public-autostart.cjs");
const releasedProof = load("./fixtures/physical-turn-fixture.cjs");
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};

test(
  "public CLI autostarts the broker with a native runtime root",
  { timeout: 120_000 },
  async (t) => {
    const base = fs.mkdtempSync("/tmp/opencode/root-public-autostart-");
    const stateHome = path.join(base, "state");
    const dataHome = path.join(base, "data");
    const cacheHome = path.join(base, "cache");
    const queueDirectory = path.join(stateHome, "fmcad", "queue");
    fs.mkdirSync(queueDirectory, { recursive: true, mode: 0o700 });
    fs.mkdirSync(dataHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(cacheHome, { recursive: true, mode: 0o700 });

    const queueInstance = load("../src/queue-instance");
    const sourceUnits = load("../src/dist/python/source-units");
    const identity = {
      pid: process.pid,
      birth: queueInstance.processBirth(process.pid),
      version: "offline-native-root-fixture",
      activeCommand: "SelectCommand",
      documents: [],
    };
    let startupProbes = 0;
    let productCalls = 0;
    const endpointErrors = [];
    const server = http.createServer(async (req, res) => {
      try {
        let text = "";
        for await (const chunk of req) text += chunk.toString();
        assert.equal(req.method, "POST");
        if (req.url === "/physical/v1/turn-status") {
          assert.ok(req.headers["x-fmcad-physical-grant"]);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(releasedProof(object(JSON.parse(text)))));
          return;
        }
        assert.equal(req.url, "/mcp");
        const payload = object(JSON.parse(text));
        let result = {};
        if (payload.method === "initialize") {
          result = {
            protocolVersion: "2025-06-18",
            serverInfo: { name: "offline-native-root-fixture", version: "1" },
          };
        } else if (payload.method === "notifications/initialized") {
          res.writeHead(202);
          res.end();
          return;
        } else if (payload.method === "tools/list") {
          result = {
            tools: [
              { name: "execute_python", inputSchema: { type: "object" } },
            ],
          };
        } else {
          assert.equal(payload.method, "tools/call", JSON.stringify(payload));
          const params = object(payload.params);
          assert.equal(params.name, "execute_python");
          const script = object(params.arguments).code;
          assert.equal(typeof script, "string");
          const code = sourceUnits
            .prepareWireArtifact(path.join(repo, "runtime/python"), script)
            .units.map((unit) => unit.source)
            .join("\n");
          const fileMatch = /_qr_path = ("(?:\\.|[^"\\])*")/.exec(code);
          const bindingMatch =
            /_qr_binding_value = _qr_cast\(object, _qr_json.loads\(("(?:\\.|[^"\\])*")\)/.exec(
              code,
            );
          assert.ok(fileMatch && bindingMatch);
          const target = JSON.parse(fileMatch[1]);
          const normalized = target.replaceAll("\\", "/");
          const file =
            normalized.startsWith("//wsl.localhost/") ||
            normalized.startsWith("//wsl$/")
              ? "/" + normalized.split("/").slice(4).join("/")
              : target;
          assert.ok(
            file.startsWith(queueDirectory + path.sep),
            `The probe may only write its own queue fixture receipt: ${target}`,
          );
          const binding = object(JSON.parse(JSON.parse(bindingMatch[1])));
          const probe = code.includes("FMCAD_QUEUE_INSTANCE");
          if (binding.stage === "startup") {
            assert.ok(
              probe,
              "Startup receipt must come from its instance probe",
            );
            startupProbes++;
          }
          const output = {
            success: true,
            stdout: probe
              ? "FMCAD_QUEUE_INSTANCE " + JSON.stringify(identity)
              : "FMCAD_BRIDGE_RESULT " +
                JSON.stringify({
                  success: true,
                  results: [
                    {
                      name: "Offline fixture",
                      id: "file-fixture",
                      creationId: "doc-fixture",
                      isActive: true,
                      isModified: false,
                      isSaved: true,
                    },
                  ],
                }),
            stderr: "",
          };
          queueInstance.durable(file, {
            ...binding,
            terminal: true,
            outcome: "succeeded",
            instance: identity,
            ...(probe
              ? {
                  probeObservation: {
                    schema: "fmcad-instance-probe-v1",
                    identity,
                  },
                }
              : {
                  publicPythonResult: {
                    schema: "fmcad-public-python-result-v1",
                    value: output,
                  },
                }),
          });
          if (!probe) productCalls++;
          result = {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  probe
                    ? output
                    : { success: true, message: JSON.stringify(output) },
                ),
              },
            ],
            isError: false,
          };
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }));
      } catch (error) {
        endpointErrors.push(String(error));
        res.writeHead(500);
        res.end(String(error));
      }
    });
    server.listen(8765, "127.0.0.1");
    await once(server, "listening");
    const url = "http://127.0.0.1:8765/mcp";
    const config = path.join(base, "config.json");
    fs.writeFileSync(
      config,
      JSON.stringify({
        backend: "addin",
        routing: "queue",
        backends: {
          addin: {
            url,
            tool: "execute_python",
            timeoutMs: 5000,
            headers: {},
            transport: "node",
            protocolVersion: "2025-06-18",
          },
        },
        queue: { autoStart: true, autoRecover: true, startupTimeoutMs: 60_000 },
      }),
      { mode: 0o600 },
    );

    t.after(async () => {
      try {
        const marker = object(
          JSON.parse(
            fs.readFileSync(path.join(queueDirectory, "broker.lock"), "utf8"),
          ),
        );
        const pid = Number(marker.pid);
        const birth = String(marker.birth);
        if (queueInstance.processBirth(pid) === birth) {
          process.kill(pid, "SIGTERM");
          await new Promise((resolve) => setTimeout(resolve, 200));
          if (queueInstance.processBirth(pid) === birth)
            process.kill(pid, "SIGKILL");
        }
      } catch {
        // The failed or completed startup may already have released its owner.
      }
      server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
      fs.rmSync(base, { recursive: true, force: true });
    });

    const root = await seedRuntimeRoot({
      repo,
      base,
      store: queueDirectory,
      config,
      endpoint: url,
      clientId: "public-native-root-autostart",
    });

    const env = {
      ...process.env,
      XDG_STATE_HOME: stateHome,
      XDG_DATA_HOME: dataHome,
      XDG_CACHE_HOME: cacheHome,
    };
    for (const name of Object.keys(env))
      if (name.startsWith("FMCAD_")) delete env[name];
    env.FMCAD_CONFIG = config;
    env.FMCAD_BACKEND = "addin";
    assert.equal(env.FMCAD_PHYSICAL_OPERATOR_PROFILE, undefined);
    const child = spawn(
      process.execPath,
      [
        path.join(repo, "dist/bin/fmcad.js"),
        "doc",
        "list",
        "--backend",
        "addin",
        "--client",
        "public-native-root-autostart",
      ],
      {
        cwd: base,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    const [code, signal] = await once(child, "close");
    const queueDiagnostics = fs
      .readdirSync(queueDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => {
        try {
          return `${entry.name}: ${fs.readFileSync(path.join(queueDirectory, entry.name), "utf8")}`;
        } catch {
          return `${entry.name}: <unreadable>`;
        }
      });
    const jobDiagnostics = fs.existsSync(path.join(queueDirectory, "jobs"))
      ? fs
          .readdirSync(path.join(queueDirectory, "jobs"), {
            withFileTypes: true,
          })
          .filter((entry) => entry.isDirectory())
          .flatMap((directory) => {
            const jobDirectory = path.join(
              queueDirectory,
              "jobs",
              directory.name,
            );
            return fs
              .readdirSync(jobDirectory, { withFileTypes: true })
              .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
              .map((entry) => {
                const file = path.join(jobDirectory, entry.name);
                return `${path.relative(queueDirectory, file)}: ${fs.readFileSync(file, "utf8")}`;
              });
          })
      : [];
    assert.equal(
      code,
      0,
      `Public doc list failed (signal=${signal}):\nstdout:\n${stdout}\nstderr:\n${stderr}\nendpoint errors: ${endpointErrors.join(" | ")}\nnative actions: ${fs.readFileSync(root.trace, "utf8")}\nstartup probes: ${startupProbes}; public calls: ${productCalls}\nqueue files:\n${queueDiagnostics.join("\n")}\njob files:\n${jobDiagnostics.join("\n")}`,
    );
    assert.match(stdout, /DOC name=Offline fixture/);
    assert.equal(
      startupProbes,
      1,
      "Public autostart must complete its real broker startup probe",
    );
    assert.equal(productCalls, 1, "The public request must execute once");
    const consumedRoot = object(
      JSON.parse(fs.readFileSync(root.nativeState, "utf8")),
    );
    assert.equal(consumedRoot.state, "consumed");
    assert.equal(typeof consumedRoot.receiptDigest, "string");
    const savedRuntime = object(
      JSON.parse(fs.readFileSync(root.profilePath, "utf8")),
    );
    assert.equal(path.dirname(root.profilePath), queueDirectory);
    assert.equal(savedRuntime.clientId, "public-native-root-autostart");
    assert.equal(
      object(savedRuntime.runtime).endpointURL,
      url,
      "The authenticated runtime config must be persisted in the queue root",
    );
  },
);

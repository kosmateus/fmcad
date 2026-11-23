"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { randomUUID, createHash } = require("node:crypto");
const { createRequire } = require("node:module");

const root = path.resolve(__dirname, "..");
const load = createRequire(path.join(root, "dist/src/queue-broker.js"));
const {
  nativeReceipts,
  decodeNativeProgram,
} = require("./fixtures/native-source-envelope.cjs");
const releasedProof = require("./fixtures/physical-turn-fixture.cjs");
const hash = (text) => createHash("sha256").update(text).digest("hex");

test(
  "public CLI document list and queue exec reach the normal typed worker through isolated IPC",
  { timeout: 120000 },
  async (t) => {
    const home = fs.mkdtempSync("/tmp/opencode/cli-worker-envelope-");
    const keys = ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME"];
    const previous = Object.fromEntries(
      keys.map((key) => [key, process.env[key]]),
    );
    for (const key of keys) process.env[key] = path.join(home, key);
    const config = path.join(home, "config.json");
    fs.writeFileSync(
      config,
      JSON.stringify({
        backend: "addin",
        backends: {
          addin: { url: "http://127.0.0.1:8765/mcp", timeoutMs: 60000 },
        },
        queue: { autoStart: false },
      }),
      { mode: 0o600 },
    );
    const cfg = load("./config").loadConfig({ config }).cfg;
    const { queueDirectory } = load("./queue-connection");
    const dir = queueDirectory();
    const instance = {
      pid: 991,
      birth: "synthetic-cli-envelope",
      version: "fixture",
      activeCommand: "SelectCommand",
      documents: [],
    };
    const document = {
      creationId: randomUUID(),
      name: "Exact CLI fixture",
      isSaved: false,
      isModified: false,
      isActive: true,
    };
    const { createBrokerTransport } = load("./dist/fusion-transport/broker");
    const physical = createBrokerTransport(cfg, {
      version: "test",
      requestTimeout: (server) => server.timeoutMs,
      bridgeSource: () => load("./addin-bridge").addinBridgeSource(),
    });
    let products = 0;
    let physicalRequests = 0;
    const released = new Set();
    physical._post = async (payload) => {
      physicalRequests++;
      if (payload.method === "initialize")
        return {
          status: 200,
          raw: JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: { protocolVersion: "2025-06-18" },
          }),
        };
      if (payload.method === "notifications/initialized")
        return { status: 202, raw: "" };
      if (payload.method === "tools/list")
        return {
          status: 200,
          raw: JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: {
              tools: [
                {
                  name: "execute_python",
                  inputSchema: {
                    type: "object",
                    properties: { code: { type: "string" } },
                    required: ["code"],
                  },
                },
              ],
            },
          }),
        };
      const script =
        payload.params?.arguments?.code ??
        payload.params?.arguments?.object?.script;
      assert.equal(typeof script, "string");
      const receipts = nativeReceipts(script, home, instance);
      const probe = receipts.some((entry) => entry.value.probeObservation);
      if (!probe) products++;
      const stdout = probe
        ? "FMCAD_QUEUE_INSTANCE " + JSON.stringify(instance)
        : decodeNativeProgram(script).includes("FMCAD_SCENARIO ")
          ? "FMCAD_SCENARIO " +
            JSON.stringify({
              active: document.creationId,
              documents: [document],
            }) +
            "\n"
          : "FMCAD_BRIDGE_RESULT " +
            JSON.stringify({ success: true, results: [document] });
      for (const entry of receipts) {
        if (entry.value.publicPythonResult)
          entry.value.publicPythonResult.value.stdout = stdout;
        fs.writeFileSync(entry.file, JSON.stringify(entry.value), {
          mode: 0o600,
        });
      }
      return {
        status: 200,
        raw: JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({ success: true, stdout, stderr: "" }),
              },
            ],
          },
        }),
      };
    };
    let broker;
    t.after(async () => {
      try {
        await broker?.close();
      } finally {
        for (const key of keys) {
          if (previous[key] === undefined) delete process.env[key];
          else process.env[key] = previous[key];
        }
        if (process.env.FMCAD_KEEP_TEST_ARTIFACTS === "1") t.diagnostic(home);
        else fs.rmSync(home, { recursive: true, force: true });
      }
    });
    broker = await load("./queue-broker").serve(cfg, {
      dir,
      confirmOwnership: true,
      pollMs: 5,
      createBackend: () => physical,
      nativePath: (file) => file,
      bindPhysicalTurn(request) {
        return {
          version: 1,
          generation: { epoch: "epoch-cli", instance: "generation-cli" },
          grantDigest: hash("isolated-cli-fixture-grant"),
          physicalRuntime: {
            ...instance,
            source: "fixture-source",
            build: "fixture-build",
          },
          turnId: request.physicalRequestId,
          target: JSON.stringify(request.documentSelector ?? null),
        };
      },
      async withPhysicalTurn(binding, send) {
        try {
          return await send();
        } finally {
          released.add(binding.turnId);
        }
      },
      async physicalTurnQuiescence(binding) {
        return released.has(binding.turnId)
          ? releasedProof(binding)
          : { state: "unknown", binding };
      },
    });
    async function cli(args) {
      const child = spawn(
        process.execPath,
        [path.join(root, "bin/fmcad.js"), ...args],
        {
          cwd: home,
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (bytes) => {
        stdout += bytes;
      });
      child.stderr.on("data", (bytes) => {
        stderr += bytes;
      });
      const code = await new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", resolve);
      });
      return { code, stdout, stderr };
    }
    for (const prefix of [[], ["queue", "exec", "--"]]) {
      await t.test(
        prefix.length ? "queue exec doc list" : "doc list",
        async () => {
          const requestId = randomUUID();
          const flags = [
            "--config",
            config,
            "--client",
            "cli-envelope-" + randomUUID(),
            "--request-id",
            requestId,
          ];
          const result = await cli(
            prefix.length
              ? ["queue", "exec", ...flags, "--", "doc", "list"]
              : [...flags, "doc", "list"],
          );
          assert.equal(result.code, 0, JSON.stringify(result));
          assert.match(result.stderr, /FMCAD_QUEUE_JOB /);
          assert.ok(result.stderr.includes(requestId));
          assert.equal(
            result.stdout,
            `DOC name=${document.name} creationId=${document.creationId} isActive=true isModified=false isSaved=false\nDONE\n`,
          );
          const state = JSON.parse(
            fs.readFileSync(path.join(dir, "queue-state.json"), "utf8"),
          );
          const jobs = Object.values(state.jobs).filter(
            (job) => job.requestId === requestId,
          );
          assert.equal(jobs.length, 1);
          assert.equal(jobs[0].state, "succeeded");
          assert.equal(jobs[0].request.payload.kind, "legacy-command");
        },
      );
    }
    await t.test(
      "queue exec run listing remains a genuine legacy command",
      async () => {
        const requestId = randomUUID();
        const productsBefore = products;
        const result = await cli([
          "queue",
          "exec",
          "--config",
          config,
          "--client",
          "listing-envelope-" + randomUUID(),
          "--request-id",
          requestId,
          "--",
          "run",
          "--list",
        ]);
        assert.equal(result.code, 0, JSON.stringify(result));
        assert.match(result.stderr, /FMCAD_QUEUE_JOB /);
        const state = JSON.parse(
          fs.readFileSync(path.join(dir, "queue-state.json"), "utf8"),
        );
        const job = Object.values(state.jobs).find(
          (job) => job.requestId === requestId,
        );
        assert.equal(job.state, "succeeded");
        assert.equal(job.request.payload.kind, "legacy-command");
        assert.equal(job.request.payload.listing, true);
        assert.equal(products, productsBefore);
      },
    );
    // Exact coordinator:before program from the original feature10 failure,
    // submitted with the existing live helper's public CLI argv, but fresh IDs.
    const coordinatorSource = `DOC_NAME = None
def run(context: str) -> None:
    import adsk.core, json
    app = adsk.core.Application.get()
    print("FMCAD_SCENARIO " + json.dumps(dict(active=app.activeDocument.creationId if app.activeDocument else None, documents=[dict(creationId=d.creationId,name=d.name,saved=d.isSaved,modified=d.isModified,fileId=d.dataFile.id if d.dataFile else None) for d in app.documents])))
`;
    await t.test("feature10 coordinator queue exec run", async () => {
      const filename = path.join(home, "request-before.py");
      fs.writeFileSync(filename, coordinatorSource, { mode: 0o600 });
      const clientId = "scenario:" + randomUUID() + ":coordinator";
      const requestId = clientId + ":before";
      const result = await require("./helpers/live-broker.js").runQueueExec({
        cliPath: path.join(root, "bin/fmcad.js"),
        backend: "addin",
        clientId,
        requestId,
        timeoutMs: 180000,
        argv: ["run", filename],
        cwd: home,
        env: { ...process.env, FMCAD_CONFIG: config },
      });
      assert.equal(result.status, 0, JSON.stringify(result));
      assert.match(result.stderr, /FMCAD_QUEUE_JOB /);
      assert.deepEqual(
        JSON.parse(result.stdout.trim().slice("FMCAD_SCENARIO ".length)),
        {
          active: document.creationId,
          documents: [document],
        },
      );
      const state = JSON.parse(
        fs.readFileSync(path.join(dir, "queue-state.json"), "utf8"),
      );
      const coordinator = Object.values(state.jobs).find(
        (job) => job.requestId === requestId,
      );
      assert.equal(coordinator.state, "succeeded");
      assert.equal(coordinator.clientId, clientId);
      assert.equal(coordinator.request.payload.kind, "run");
      assert.equal(coordinator.request.payload.request.name, filename);
      assert.equal(
        products,
        3,
        "Every public producer must execute exactly once in the normal worker",
      );
      const { QueueClient } = load("./queue-client");
      const stranger = new QueueClient(
        "cli-envelope-stranger-" + randomUUID(),
        {
          cfg,
        },
      );
      try {
        await stranger.register({ autoStart: false });
        await assert.rejects(
          stranger.call("result", { jobId: coordinator.id }),
          "Another client must not obtain the original result",
        );
        await assert.rejects(
          stranger.submit({
            kind: "command",
            requestId: randomUUID(),
            argv: ["doc", "list"],
            cwd: home,
            backend: "addin",
            timeoutMs: 60000,
          }),
          "An argv-only envelope must not become executable worker input",
        );
        await assert.rejects(
          stranger.submit({
            kind: "command",
            requestId: randomUUID(),
            argv: ["cad", "status"],
            payload: {
              version: 1,
              kind: "cad",
              operation: "document.status",
              docId: 123,
            },
            cwd: home,
            backend: "addin",
            timeoutMs: 60000,
          }),
          "Malformed typed document pins must not reach physical dispatch",
        );
      } finally {
        stranger.dispose();
      }
      assert.equal(products, 3);
    });
    await t.test(
      "inconsistent legacy envelopes are denied before job creation or dispatch",
      async () => {
        const { QueueClient } = load("./queue-client");
        const { prepareRequest } = load("./dist/composition/execution-request");
        const client = new QueueClient("legacy-envelope-" + randomUUID(), {
          cfg,
        });
        const wire = (value) => JSON.parse(JSON.stringify(value));
        const canonical = wire(
          prepareRequest({
            request: { cwd: home, argv: ["doc", "list"] },
          }),
        );
        const jobsBefore = Object.keys(
          JSON.parse(
            fs.readFileSync(path.join(dir, "queue-state.json"), "utf8"),
          ).jobs,
        );
        const cases = [
          ["incomplete", { version: 1, kind: "legacy-command" }],
          ["version", { ...canonical.payload, version: 2 }],
          ["unknown field", { ...canonical.payload, ignored: true }],
          [
            "unknown entry field",
            {
              ...canonical.payload,
              entry: { ...canonical.payload.entry, ignored: true },
            },
          ],
          [
            "changed target",
            {
              ...canonical.payload,
              entry: { ...canonical.payload.entry, target: "docCloseCmd" },
            },
          ],
          ["changed args", { ...canonical.payload, args: ["foreign"] }],
          ["changed rawArgs", { ...canonical.payload, rawArgs: ["foreign"] }],
          [
            "changed flags",
            { ...canonical.payload, flags: { "--discard": true } },
          ],
          ["changed options", { ...canonical.payload, options: {} }],
          [
            "missing field",
            (() => {
              const payload = { ...canonical.payload };
              delete payload.listing;
              return payload;
            })(),
          ],
          [
            "argv means CAD",
            canonical.payload,
            [
              "cad",
              "status",
              "--doc",
              "Model",
              "--doc-id",
              document.creationId,
            ],
          ],
        ];
        try {
          await client.register({ autoStart: false });
          const dispatchesBefore = physicalRequests;
          for (const [label, payload, argv = canonical.argv] of cases) {
            const input = {
              kind: "command",
              requestId: randomUUID(),
              cwd: home,
              argv,
              payload,
              backend: "addin",
              timeoutMs: 60000,
            };
            assert.notDeepEqual(
              wire(prepareRequest({ request: input }).payload),
              payload,
              label + " must differ from the real worker's parsed meaning",
            );
            await assert.rejects(
              client.submit(input),
              (error) => error.code === "INVALID_COMMAND_PAYLOAD",
              label + " must be rejected before admission",
            );
            const state = JSON.parse(
              fs.readFileSync(path.join(dir, "queue-state.json"), "utf8"),
            );
            assert.deepEqual(Object.keys(state.jobs), jobsBefore, label);
            assert.equal(products, 3, label + " must not dispatch");
            assert.equal(
              physicalRequests,
              dispatchesBefore,
              label + " must not send even an extra physical probe",
            );
          }
        } finally {
          client.dispose();
        }
      },
    );
    for (const kind of ["CAD", "run"]) {
      await t.test(
        `${kind} advertised as legacy is denied before reading input files`,
        async () => {
          const { QueueClient } = load("./queue-client");
          const { prepareRequest } = load(
            "./dist/composition/execution-request",
          );
          const client = new QueueClient("legacy-file-fence-" + randomUUID(), {
            cfg,
          });
          const inputFile = path.join(
            home,
            "private-input-" + randomUUID() + ".json",
          );
          const argv =
            kind === "CAD"
              ? ["entity", "list", "--doc", "Model", "--file", inputFile]
              : ["run", path.join(home, "absent.py"), "--args-file", inputFile];
          const payload = JSON.parse(
            JSON.stringify(
              prepareRequest({
                request: { cwd: home, argv: ["doc", "list"] },
              }).payload,
            ),
          );
          const jobsBefore = Object.keys(
            JSON.parse(
              fs.readFileSync(path.join(dir, "queue-state.json"), "utf8"),
            ).jobs,
          );
          const dispatchesBefore = physicalRequests;
          const read = fs.readFileSync;
          const reads = [];
          try {
            await client.register({ autoStart: false });
            // Spy at the actual filesystem adapter boundary in the broker
            // process. Never open the private/missing input or a blocking FIFO.
            fs.readFileSync = function (filename, ...args) {
              if (
                typeof filename === "string" &&
                path.resolve(filename) === inputFile
              ) {
                reads.push(filename);
                throw Object.assign(
                  new Error("Request input read before kind rejection"),
                  {
                    code: "TEST_INPUT_READ",
                  },
                );
              }
              return read.call(this, filename, ...args);
            };
            let rejection;
            try {
              await client.submit({
                kind: "command",
                requestId: randomUUID(),
                cwd: home,
                argv,
                payload,
                backend: "addin",
                timeoutMs: 60000,
              });
            } catch (error) {
              rejection = error;
            }
            assert.deepEqual(
              reads,
              [],
              "Pure kind classification must precede input preparation",
            );
            assert.equal(rejection?.code, "INVALID_COMMAND_PAYLOAD");
            const state = JSON.parse(
              read.call(fs, path.join(dir, "queue-state.json"), "utf8"),
            );
            assert.deepEqual(Object.keys(state.jobs), jobsBefore);
            assert.equal(physicalRequests, dispatchesBefore);
          } finally {
            fs.readFileSync = read;
            client.dispose();
          }
        },
      );
    }
  },
);

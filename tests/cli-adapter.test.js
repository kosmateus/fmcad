"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { main, parseFlags, parseCommand } = require("../src/cli");
const { commands, findCommand, legacyCommands } = require("../src/commands");
const { createCatalogServices } = require("../src/dist/api");
const {
  execute,
  receiptExitCode,
} = require("../src/dist/entrypoints/cli/application");
const {
  CliError,
  renderMessage,
} = require("../src/dist/entrypoints/cli/messages");
const config = {
  backend: "addin",
  routing: "queue",
  url: "http://127.0.0.1:8765/mcp",
  headers: {},
  timeoutMs: 180000,
  tool: "execute_python",
  transport: "node",
  protocolVersion: "2025-06-18",
  queue: { autoStart: false },
  controlCenter: { port: 4748 },
};
const context = {
  clientId: "cli-test",
  source: "cli",
  projectDirectory: process.cwd(),
};
function result(state = "succeeded", value = { success: true }) {
  return {
    version: 1,
    state,
    requestId: "request",
    jobId: "job",
    result: value,
    outcome: {
      version: 1,
      requestId: null,
      jobId: null,
      acceptance: "accepted",
      executionOutcome: state === "succeeded" ? "succeeded" : "unknown",
      mayHaveMutated: null,
      validation: { status: "not_checked", reasons: [] },
      code: null,
    },
  };
}
function harness(overrides = {}) {
  const calls = [];
  let stdout = "",
    stderr = "";
  const deps = {
    stdout: {
      write: (text) => {
        stdout += text;
      },
    },
    stderr: {
      write: (text) => {
        stderr += text;
      },
    },
    setExitCode() {},
    loadConfig(options) {
      calls.push(["config", options]);
      return { cfg: config };
    },
    createFmcad(options) {
      calls.push(["factory", options]);
      return {
        async start() {
          calls.push(["start"]);
        },
        async dispose() {
          calls.push(["dispose"]);
        },
        async execute(payload, options) {
          calls.push(["execute", payload, options]);
          return result();
        },
        query: {
          async result(id) {
            calls.push(["result", id]);
            return result();
          },
        },
      };
    },
    ...overrides,
  };
  return {
    calls,
    deps,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}
test("strict parser preserves purpose, flags, headers, negative positionals and terminator", () => {
  const value = parseFlags([
    "--purpose",
    "Inspect Model",
    "param_set",
    "width",
    "-1 mm",
    "--header",
    "X-Trace:a:b",
    "--timeout",
    "250",
    "--doc",
    "Model",
  ]);
  assert.equal(value.opts.description, "Inspect Model");
  assert.deepEqual(value.opts.headers, { "X-Trace": "a:b" });
  assert.equal(value.opts.timeoutMs, 250);
  const parsed = parseCommand(findCommand(value.rest), value.rest.slice(1));
  assert.deepEqual(parsed.args, ["width", "-1 mm"]);
  assert.equal(parsed.flags["--doc"], "Model");
  assert.deepEqual(
    parseCommand(findCommand(["run"]), ["--", "-script.py"]).args,
    ["-script.py"],
  );
});
test("run duplicate pins, args conflicts and invalid outputs reject before configuration or admission", async () => {
  for (const words of [
    ["file.py", "--doc", "Model", "--doc-id", "one", "--doc-id", "two"],
    ["file.py", "--doc-id", "one"],
    ["file.py", "--doc", "Model", "--doc-file-id", "bad pin"],
    ["file.py", "--args", "{}", "--args-file", "unused"],
    ["file.py", "--out-format", "json"],
    ["file.py", "--out", "target", "--pretty", "TRUE"],
    ["--list", "--doc-id", "pin"],
    ["file.py", "--args", "{bad"],
  ]) {
    const h = harness();
    assert.equal(await main(["run", ...words], h.deps), 1, words.join(" "));
    assert.deepEqual(h.calls, []);
    assert.match(h.stderr, /ERROR/);
  }
});
test("every help route remains configuration and library-session independent", async () => {
  for (const words of [
    [],
    ["help"],
    ["--help"],
    ...commands.flatMap((entry) => [
      ["help", ...entry.key.split(" ")],
      [...entry.key.split(" "), "--help"],
    ]),
  ]) {
    const h = harness({
      loadConfig() {
        throw Error("unexpected config");
      },
      createFmcad() {
        throw Error("unexpected session");
      },
    });
    assert.equal(await main(words, h.deps), 0, words.join(" "));
    assert.ok(h.stdout.trim(), words.join(" "));
  }
});
test("real local preview uses shared public application without configuration, broker or SDK", async () => {
  const h = harness({
    createFmcad: undefined,
    loadConfig() {
      throw Error("unexpected config");
    },
  });
  assert.equal(
    await main(
      ["cad", "entity", "list", "--doc", "Model", "--preview", "--json"],
      h.deps,
    ),
    0,
    h.stderr,
  );
  const value = JSON.parse(h.stdout);
  assert.equal(value.state, "input-validated-only");
  assert.equal(value.mutation, false);
  assert.deepEqual(h.calls, []);
});
test("public catalog aliases and CLI map to identical pinned typed input and one admission", async () => {
  const catalog = createCatalogServices();
  const contract = catalog
    .list()
    .find((item) => item.operation === "entity.list");
  const entry = commands.find(
    (item) => item.kind === "cad" && item.target === "entity.list",
  );
  for (const spelling of [entry.key, ...entry.aliases]) {
    const h = harness();
    assert.equal(
      await main(
        [
          ...spelling.split(" "),
          "--doc",
          "Model",
          "--doc-id",
          "creation",
          "--doc-file-id",
          "file",
          "--json",
          "--purpose",
          "inspect",
        ],
        h.deps,
      ),
      0,
      h.stderr,
    );
    const calls = h.calls.filter((value) => value[0] === "execute");
    assert.equal(calls.length, 1);
    const input = calls[0][1];
    assert.equal(input.kind, "cad-command");
    assert.deepEqual(
      input.invocation,
      catalog.validate({
        version: 1,
        kind: "cad",
        operation: contract.operation,
        data: {},
        doc: "Model",
        docId: "creation",
        docFileId: "file",
        purpose: "inspect",
        preview: false,
      }),
    );
    assert.equal(h.calls[0][0], "config");
    assert.equal(h.calls.at(-1)[0], "dispose");
  }
});
test("invalid CAD has same public validation error and no effects", async () => {
  const h = harness();
  assert.equal(
    await main(
      ["cad", "entity", "list", "--doc", "Model", "--data", '{"foreign":1}'],
      h.deps,
    ),
    1,
  );
  assert.deepEqual(h.calls, []);
  let message;
  try {
    createCatalogServices().validateData("entity.list", { foreign: 1 });
  } catch (error) {
    message = error.message;
  }
  assert.ok(message);
  assert.ok(h.stderr.includes(message));
});
test("direct is rejected clearly; queue is compatibility spelling, not a second execution implementation", async () => {
  const h = harness();
  assert.equal(
    await main(
      ["cad", "entity", "list", "--doc", "Model", "--routing", "direct"],
      h.deps,
    ),
    1,
  );
  assert.match(h.stderr, /routing=direct/);
  assert.deepEqual(h.calls, []);
  const q = harness();
  assert.equal(
    await main(
      ["cad", "entity", "list", "--doc", "Model", "--routing", "queue"],
      q.deps,
    ),
    0,
    q.stderr,
  );
  assert.equal(q.calls.filter((call) => call[0] === "execute").length, 1);
  const fileRoute = harness({
    loadConfig() {
      return { cfg: { ...config, routing: "direct" } };
    },
  });
  assert.equal(
    await main(["cad", "entity", "list", "--doc", "Model"], fileRoute.deps),
    1,
  );
  assert.match(fileRoute.stderr, /routing=direct/);
  assert.equal(
    fileRoute.calls.some((call) => call[0] === "factory"),
    false,
  );
});
test("retained legacy families delegate once to existing broker application, never physical client construction", async (t) => {
  t.after(require("./fixtures/fake-wsl-platform.cjs")());
  for (const entry of legacyCommands.filter(
    (entry) => !["help", "family", "init", "run"].includes(entry.kind),
  )) {
    const args =
      entry.key === "plane_add"
        ? ["Plane", "offset", "XY", "10 mm"]
        : entry.kind === "call"
          ? ["tool", "{}"]
          : Array(entry.minArgs).fill("argument");
    if (entry.requiresDoc) args.push("--doc", "Model");
    if (entry.exactlyOne) args.push(entry.exactlyOne[0]);
    let count = 0;
    const h = harness({
      createFmcad() {
        throw Error("legacy must retain its worker");
      },
      async runQueued(argv) {
        count++;
        assert.equal(argv[0], entry.key.split(" ")[0]);
        return 0;
      },
    });
    assert.equal(
      await main([...entry.key.split(" "), ...args], h.deps),
      0,
      `${entry.key}: ${h.stderr}`,
    );
    assert.equal(count, 1);
  }
});
test("unknown and unresolved receipts never become success, replay or cancellation", async () => {
  const payload = {
    version: 1,
    kind: "cad",
    operation: "entity.list",
    data: {},
    doc: "Model",
  };
  for (const state of ["unknown", "needs_reconciliation", "failed"]) {
    const events = [];
    const receipt = await execute(
      payload,
      { config, context },
      {
        createFmcad() {
          return {
            async start() {
              events.push("start");
            },
            async execute() {
              events.push("execute");
              return result(state);
            },
            async dispose() {
              events.push("dispose");
            },
            query: {
              async result() {
                throw Error("must not replay or poll unresolved terminal");
              },
            },
            async control() {
              throw Error("must not cancel");
            },
          };
        },
      },
    );
    assert.equal(receiptExitCode(receipt), 1);
    assert.deepEqual(events, ["start", "execute", "dispose"]);
  }
  assert.equal(
    receiptExitCode({
      ...result(),
      outcome: { ...result().outcome, executionOutcome: "not_started" },
    }),
    1,
  );
  assert.equal(
    receiptExitCode({
      ...result(),
      outcome: { ...result().outcome, acceptance: "rejected" },
    }),
    1,
  );
});
test("run preserves pinned typed request, input hashes, broker controls and exact raw streams", async (t) => {
  const directory = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "cli-run-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, "trusted.py"),
    argsFile = path.join(directory, "args.json"),
    output = path.join(directory, "result.txt");
  fs.writeFileSync(
    source,
    'ARGS = {}\nDOC_NAME = ""\ndef run(context):\n    pass\n',
  );
  fs.writeFileSync(argsFile, '{"text":"Zażółć 🧩"}');
  const captured = [];
  const rawStdout = 'diag\nFMCAD_RESULT {"text":"Zażółć 🧩"}\n\t';
  const rawStderr = "SDK path: C:\\Fusion\\raw.log\n";
  const h = harness({
    createFmcad(options) {
      captured.push(["factory", options]);
      return {
        async start() {
          captured.push(["start"]);
        },
        async dispose() {
          captured.push(["dispose"]);
        },
        async execute(payload, requestOptions) {
          captured.push(["execute", payload, requestOptions]);
          if (payload.kind === "run" && payload.output?.path) {
            const formatRunOutput = require("../src/run").formatRunOutput;
            const publishComplete = require("../src/publish").publishComplete;
            await publishComplete(
              payload.output.path,
              formatRunOutput(
                rawStdout,
                payload.output.format,
                payload.output.pretty,
              ),
            );
          }
          return {
            ...result(),
            requestId: "stable-run",
            output: { stdout: rawStdout, stderr: rawStderr },
          };
        },
      };
    },
  });
  const code = await main(
    [
      "run",
      source,
      "--doc",
      "Model",
      "--doc-id",
      "creation-id",
      "--doc-file-id",
      "file-id",
      "--args-file",
      argsFile,
      "--purpose",
      "Inspect",
      "--request-id",
      "stable-run",
      "--client",
      "cli-test",
      "--sequence-action",
      "begin",
      "--sequence-mode",
      "exclusive",
      "--queue-timeout",
      "2500",
      "--expected-revision",
      "0",
      "--out",
      output,
      "--out-format",
      "json",
      "--pretty",
      "true",
    ],
    h.deps,
  );
  assert.equal(code, 0, h.stderr);
  assert.equal(h.stdout, rawStdout);
  assert.equal(
    h.stderr,
    "FMCAD_QUEUE_REQUEST " +
      JSON.stringify({ requestId: "stable-run", clientId: "cli-test" }) +
      "\n" +
      "FMCAD_QUEUE_JOB " +
      JSON.stringify({ jobId: "job", requestId: "stable-run" }) +
      "\n" +
      "QUEUE job succeeded\n" +
      rawStderr +
      "FMCAD_QUEUE_RESULT " +
      JSON.stringify({
        id: "job",
        requestId: "stable-run",
        state: "succeeded",
        outcome: result().outcome,
      }) +
      "\n",
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), {
    text: "Zażółć 🧩",
  });
  const [, payload, options] = captured.find((value) => value[0] === "execute");
  assert.equal(payload.kind, "run");
  assert.equal(payload.request.doc, "Model");
  assert.deepEqual(payload.request.identity, {
    docId: "creation-id",
    docFileId: "file-id",
    readOnly: false,
  });
  assert.equal(payload.purpose, "Inspect");
  assert.deepEqual(payload.request.args, { text: "Zażółć 🧩" });
  assert.equal(options.requestId, "stable-run");
  assert.equal(options.sequence.mode, "exclusive");
  assert.equal(options.queueTimeoutMs, 2500);
  assert.equal(options.expectedRevision, 0);
  assert.deepEqual(
    options.inputFiles.map((file) => file.path),
    [argsFile],
  );
  assert.ok(
    options.inputFiles.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)),
  );
  assert.equal(captured[0][1].context.documentId, "creation-id");
  assert.ok(captured.some((value) => value[0] === "dispose"));
});
test("accepted receipt is observed until settled and session disposed once; lost admission is not retried", async () => {
  const payload = {
    version: 1,
    kind: "cad",
    operation: "entity.list",
    data: {},
    doc: "Model",
  };
  const events = [];
  const receipt = await execute(
    payload,
    { config, context, requestId: "stable" },
    {
      wait: async () => {},
      createFmcad() {
        return {
          async start() {
            events.push("start");
          },
          async execute(input, options) {
            events.push(["execute", options.requestId]);
            return result("queued", null);
          },
          async dispose() {
            events.push("dispose");
          },
          query: {
            async result(id) {
              events.push(["result", id]);
              return result();
            },
          },
        };
      },
    },
  );
  assert.equal(receiptExitCode(receipt), 0);
  assert.deepEqual(events, [
    "start",
    ["execute", "stable"],
    ["result", "job"],
    "dispose",
  ]);
  let attempts = 0,
    disposed = 0;
  await assert.rejects(
    execute(
      payload,
      { config, context },
      {
        createFmcad() {
          return {
            async start() {},
            async execute() {
              attempts++;
              throw Error("lost acknowledgement");
            },
            async dispose() {
              disposed++;
            },
          };
        },
      },
    ),
    /lost acknowledgement/,
  );
  assert.equal(attempts, 1);
  assert.equal(disposed, 1);
});
test("localization keeps stable message IDs/arguments and never changes opaque values", () => {
  const error = new CliError("unknownOption", {
    command: "run",
    flag: "--foreign",
  });
  assert.equal(error.messageId, "unknownOption");
  assert.deepEqual(error.argumentsValue, { command: "run", flag: "--foreign" });
  assert.match(
    renderMessage(error.messageId, error.argumentsValue, "pl"),
    /run: --foreign/,
  );
  assert.equal(
    renderMessage("unknownCommand", { command: "/private/path.py" }, "pl"),
    "nieznane polecenie: /private/path.py",
  );
});
test("Polish offline capabilities inspect help documents purpose without implying config or backend", () => {
  const directory = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "cli-help-pl-"));
  try {
    const file = path.join(directory, "config.json");
    execFileSync(
      process.execPath,
      [
        "-e",
        `
      const i18n = require('./src/i18n');
      i18n.savePreferences({language:'pl'}, process.env.FMCAD_CONFIG);
      const text = require('./src/help').detail('capabilities', 'inspect');
      if (!text.includes('--purpose')) throw Error('missing --purpose in local inspect help');
      if (!text.includes('nie ładuje konfiguracji') || text.includes('--backend')) throw Error('offline help implies backend/config');
    `,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, FMCAD_CONFIG: file },
        encoding: "utf8",
      },
    );
    assert.equal(
      JSON.parse(fs.readFileSync(file, "utf8")).console.language,
      "pl",
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test("installed-layout executable works from foreign cwd and malformed Fusion configuration for help and preview", (t) => {
  const directory = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "cli-offline-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const badConfig = path.join(directory, "bad.json");
  fs.writeFileSync(badConfig, "{bad");
  for (const words of [
    ["help"],
    ["cad", "entity", "list", "--doc", "Model", "--preview", "--json"],
  ]) {
    const output = execFileSync(
      process.execPath,
      [path.resolve("dist/bin/fmcad.js"), ...words],
      {
        cwd: directory,
        env: {
          ...process.env,
          HOME: directory,
          FMCAD_CONFIG: badConfig,
          FMCAD_BACKEND: "invalid",
        },
        encoding: "utf8",
      },
    );
    assert.ok(output.trim());
  }
  assert.deepEqual(fs.readdirSync(directory), ["bad.json"]);
});

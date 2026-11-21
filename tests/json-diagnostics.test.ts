import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { CliDependencies } from "../src/entrypoints/cli";
import type { FmcadServices, FmcadConfiguration } from "../src/api";
const load = createRequire(__filename),
  root = process.cwd();
const { formatJsonError } = load(
  path.join(root, "src/diagnostics"),
) as typeof import("../packages/core/src/domain/diagnostics");
const { main } = load(
  path.join(root, "src/cli"),
) as typeof import("../src/entrypoints/cli");
const cfg: FmcadConfiguration = {
  backend: "mcp",
  routing: "queue",
  url: "http://host",
  headers: { Authorization: "Bearer opaque-token" },
  timeoutMs: 1000,
  tool: "execute_python",
  transport: "node",
  protocolVersion: "2025-06-18",
  queue: { autoStart: false },
  controlCenter: { port: 4748 },
};
function service(execute: FmcadServices["execute"]): FmcadServices {
  const value: Partial<FmcadServices> = {
    async start() {},
    async dispose() {},
    execute,
  };
  return new Proxy(value, {
    get(target, key) {
      assert(
        Reflect.has(target, key),
        `Unexpected service access: ${String(key)}`,
      );
      return Reflect.get(target, key);
    },
  }) as FmcadServices;
}
function script(folder: string) {
  const file = path.join(folder, "synthetic.py");
  fs.writeFileSync(
    file,
    'ARGS = {}\nDOC_NAME = ""\ndef run(context):\n    pass\n',
  );
  return file;
}
function fixture(t: import("node:test").TestContext) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "json-diagnostics-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
}

function harness(overrides: Partial<CliDependencies> = {}) {
  const h = {
    stdout: "",
    stderr: "",
    exits: [] as number[],
    clients: 0,
    calls: 0,
  };
  const deps: CliDependencies = {
    stdout: {
      write: (text) => {
        h.stdout += text;
      },
    },
    stderr: {
      write: (text) => {
        h.stderr += text;
      },
    },
    setExitCode: (code) => {
      h.exits.push(code);
    },
    createFmcad: () => {
      h.clients++;
      return service(async () => {
        h.calls++;
        assert.fail("Unexpected backend call");
      });
    },
    ...overrides,
  };
  return Object.assign(h, { deps });
}

function failed(h: ReturnType<typeof harness>) {
  assert.deepEqual(h.exits, [1]);
  assert.equal(h.stdout, "");
  assert.equal(h.clients, 0);
  assert.equal(h.calls, 0);
  assert.match(
    h.stderr,
    /(?:Invalid JSONC \(line \d+ column \d+\)|Invalid JSON(?: at position \d+)?(?: \(line \d+ column \d+\))?)\n$/,
  );
}

test("JSON formatter keeps only numeric location metadata across Node parser messages", () => {
  const cases: [string, string][] = [
    [
      "Unexpected token 'o', ...\"opaque-fragment\"... is not valid JSON",
      "Invalid JSON",
    ],
    [
      "Unexpected token s in JSON at position 31",
      "Invalid JSON at position 31",
    ],
    [
      "Expected property name or '}' in JSON at position 42 (line 3 column 7)",
      "Invalid JSON at position 42 (line 3 column 7)",
    ],
    [
      "Bad escaped character in JSON at position 99 (line 2 column 80)",
      "Invalid JSON at position 99 (line 2 column 80)",
    ],
    ["opaque-property at line 3 column 7", "Invalid JSON (line 3 column 7)"],
    ["Unexpected end of JSON input", "Invalid JSON"],
    ['"opaque at position 12" is not valid JSON', "Invalid JSON"],
    ["opaque-property at position opaque-value", "Invalid JSON"],
  ];
  for (const [message, expected] of cases)
    assert.equal(formatJsonError(new SyntaxError(message)), expected);
});

const invalidConfigs = [
  '{"headers":{"Authorization":"Bearer ' +
    "padding".repeat(12) +
    'opaque-tail"oops}}',
  '{"headers":{"Authorization":"Bearer ' +
    "padding".repeat(12) +
    'opaque-\\"tail\\q"}}',
  '{"headers":{"X-Custom-Auth":"opaque-\\u12xz"}}',
  '{"headers":{opaque-private-property:"opaque-value"}}',
];

test("invalid config cannot leak partial/escaped header values before config resolves", async (t) => {
  const folder = fixture(t);
  const config = path.join(folder, "config.json");
  for (const text of invalidConfigs) {
    fs.writeFileSync(config, text);
    const h = harness();
    assert.equal(await main(["tools", "--config", config], h.deps), 1);
    failed(h);
    assert.ok(
      h.stderr.startsWith(`ERROR Cannot parse config ${config}: Invalid JSON`),
    );
    assert.doesNotMatch(h.stderr, /opaque|padding|Authorization|X-Custom/);
    assert.equal(fs.readFileSync(config, "utf8"), text);
    assert.deepEqual(fs.readdirSync(folder), ["config.json"]);
  }
});

test("invalid imported JSONC is safe and forced init does not mutate existing config", async (t) => {
  const folder = fixture(t);
  t.mock.method(os, "homedir", () => folder);
  const source = path.join(folder, ".opencode", "opencode.jsonc");
  fs.mkdirSync(path.dirname(source));
  const config = path.join(folder, "config.json");
  fs.writeFileSync(config, "existing config sentinel");
  for (const text of invalidConfigs) {
    fs.writeFileSync(source, "// imported config\n" + text);
    const h = harness();
    assert.equal(
      await main(
        ["init", "--from-opencode", "--force", "--config", config],
        h.deps,
      ),
      1,
    );
    failed(h);
    assert.ok(
      h.stderr.startsWith(`ERROR Cannot parse ${source}: Invalid JSONC`),
    );
    assert.doesNotMatch(h.stderr, /opaque|padding|Authorization|X-Custom/);
    assert.equal(fs.readFileSync(config, "utf8"), "existing config sentinel");
    assert.equal(
      fs.readFileSync(source, "utf8"),
      "// imported config\n" + text,
    );
    assert.deepEqual(fs.readdirSync(folder).sort(), [
      ".opencode",
      "config.json",
    ]);
  }
});

test("invalid args and args-file suppress unlabeled snippets before config load or backend construction", async (t) => {
  const folder = fixture(t);
  const config = path.join(folder, "config.json");
  const argsFile = path.join(folder, "args.json");
  fs.writeFileSync(config, "untouched config sentinel");
  for (const payload of [
    "opaque-unlabeled-token",
    '["opaque-\\"tail"oops]',
    "{opaque-property:1}",
  ]) {
    fs.writeFileSync(argsFile, payload);
    for (const args of [
      ["--args", payload],
      ["--args-file", argsFile],
    ]) {
      const h = harness({
        loadConfig: () => assert.fail("Must not load config for invalid args"),
      });
      assert.equal(
        await main(["run", "synthetic", "--config", config, ...args], h.deps),
        1,
      );
      failed(h);
      assert.match(h.stderr, /^ERROR Invalid JSON/);
      assert.doesNotMatch(h.stderr, /opaque|unlabeled|property|tail/);
      assert.equal(
        fs.readFileSync(config, "utf8"),
        "untouched config sentinel",
      );
      assert.equal(fs.readFileSync(argsFile, "utf8"), payload);
      assert.deepEqual(fs.readdirSync(folder).sort(), [
        "args.json",
        "config.json",
      ]);
    }
  }
});

test("other direct JSON input routes use the same safe CLI diagnostic", async () => {
  for (const args of [
    ["call", "synthetic", "opaque-unlabeled-token"],
    [
      "entity",
      "list",
      "--data",
      "opaque-unlabeled-token",
      "--doc",
      "Synthetic",
    ],
  ]) {
    const h = harness({
      loadConfig: () => assert.fail("Must not load config for invalid JSON"),
    });
    assert.equal(await main(args, h.deps), 1);
    failed(h);
    assert.match(h.stderr, /^ERROR Invalid JSON/);
  }
});

test("genuine execution errors survive, including unrelated SDK SyntaxErrors", async (t) => {
  const source = script(fixture(t));
  for (const error of [
    new Error("SDK execution failed for opaque entity"),
    new SyntaxError("SDK script has invalid Python syntax"),
  ]) {
    const h = harness({
      loadConfig: () => ({ cfg }),
      createFmcad: () =>
        service(async () => {
          throw error;
        }),
    });
    assert.equal(await main(["run", source], h.deps), 1);
    assert.match(h.stderr, /^FMCAD_QUEUE_REQUEST \{[^\n]+\}\n/);
    assert.equal(
      h.stderr.split("\n").slice(1).join("\n"),
      `ERROR ${error.message}\n`,
    );
    assert.deepEqual(h.exits, [1]);
  }
});

test("valid args and args-file preserve raw execution stdout byte for byte", async (t) => {
  const folder = fixture(t);
  const argsFile = path.join(folder, "args.json");
  const payload = '["opaque-token"]';
  const source = script(folder);
  const raw =
    'Authorization: Bearer opaque-token\n{"entityToken":"opaque-token"}\n';
  fs.writeFileSync(argsFile, payload);
  for (const args of [
    ["--args", payload],
    ["--args-file", argsFile],
  ]) {
    let calls = 0;
    const h = harness({
      loadConfig: () => ({ cfg }),
      createFmcad: () =>
        service(async (input) => {
          calls++;
          assert.equal(input.kind, "run");
          assert(input.kind === "run");
          assert.deepEqual(input.request.args, ["opaque-token"]);
          return {
            version: 1,
            requestId: "raw-output",
            jobId: null,
            state: "succeeded",
            result: null,
            output: { stdout: raw + "\n", stderr: "" },
            outcome: {
              version: 1,
              requestId: null,
              jobId: null,
              acceptance: "accepted",
              executionOutcome: "succeeded",
              mayHaveMutated: null,
              code: null,
              validation: {
                status: "not_checked",
                source: null,
                artifactId: null,
                measurements: {},
              },
            },
          };
        }),
    });
    assert.equal(await main(["run", source, ...args], h.deps), 0);
    assert.equal(calls, 1);
    assert.equal(h.stdout, raw + "\n");
    assert.match(h.stderr, /^FMCAD_QUEUE_REQUEST \{[^\n]+\}\n$/);
    assert.deepEqual(h.exits, []);
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
// Consume staged declarations so test compilation cannot overwrite the runtime facade.
import type { AcceptedCommandRequest } from "../src/dist/composition/execution-request";

const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "package.json"));
type Adapter = typeof import("../src/dist/composition/execution-request");
const current = load("./src/composition/execution-request.js") as Adapter;
const historical = load("./tests/fixtures/historical-module.cjs") as (
  revision: string,
  file: string,
) => unknown;
const previous = historical(
  "f336653148a53d539c60fcba9e3394da49a66105",
  "src/composition/execution-request.js",
) as Adapter;
const hash = (bytes: string) =>
  createHash("sha256").update(bytes).digest("hex");

function fixture(t: { after(fn: () => void): void }) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "request-migration-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(cwd, "owned.py"),
    'ARGS = []\nDOC_NAME = ""\ndef run(_context):\n    print(ARGS)\n',
  );
  fs.writeFileSync(path.join(cwd, "input.json"), '{"kind":"body"}');
  fs.writeFileSync(path.join(cwd, "args.json"), '{"size":10}');
  return cwd;
}

function request(
  cwd: string,
  argv: string[],
): AcceptedCommandRequest & Record<string, unknown> {
  return {
    cwd,
    argv,
    requestId: "request-A",
    clientId: "owner-A",
    buildHash: "accepted-build",
    ownerToken: "accepted-token",
    description: "Inspect the owned model",
    clientContext: { docId: "creation-A", docFileId: "file-A" },
    inputFiles: [
      { path: "input.json", sha256: hash('{"kind":"body"}') },
      { path: "args.json", sha256: hash('{"size":10}') },
    ],
  };
}
function freeze(value: unknown): void {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
}

const successCases: [string, string[]][] = [
  [
    "batch observation shortcut",
    [
      "batch",
      "reconcile",
      "--data",
      "observe",
      "--report-path",
      "./reports/original",
      "--doc",
      "Model",
    ],
  ],
  [
    "batch payload",
    [
      "batch",
      "run",
      "--doc",
      "Model",
      "--doc-id",
      "creation-A",
      "--data",
      JSON.stringify({
        runId: "batch-A",
        operations: [{ id: "inspect", operation: "entity.list", data: {} }],
      }),
    ],
  ],
  [
    "definition payload",
    [
      "definition",
      "instantiate",
      "--doc",
      "Model",
      "--doc-id",
      "creation-A",
      "--data",
      JSON.stringify({
        runId: "definition-A",
        operations: [{ id: "inspect", operation: "entity.list", data: {} }],
      }),
    ],
  ],
  [
    "CAD canonical spelling",
    [
      "entity",
      "list",
      "--doc",
      "Model",
      "--doc-id",
      "creation-A",
      "--doc-file-id",
      "file-A",
      "--file",
      "input.json",
    ],
  ],
  [
    "CAD long alias",
    [
      "cad",
      "entity",
      "list",
      "--doc",
      "Model",
      "--doc-id",
      "creation-A",
      "--data",
      '{"kind":"body"}',
      "--preview",
      "--json",
    ],
  ],
  [
    "CAD direct fields",
    [
      "entity",
      "list",
      "--doc",
      "Model",
      "--kind",
      "body",
      "--input-component",
      "root",
      "--component",
      "root",
      "--project-id",
      "project-A",
    ],
  ],
  [
    "CAD preview without identity",
    ["entity", "list", "--doc", "Model", "--preview"],
  ],
  [
    "run with inline arguments",
    [
      "run",
      "owned.py",
      "--args",
      '{"size":10}',
      "--doc",
      "Model",
      "--doc-id",
      "creation-A",
      "--doc-file-id",
      "file-A",
    ],
  ],
  [
    "run with pinned arguments",
    [
      "run",
      "owned.py",
      "--args-file",
      "args.json",
      "--doc",
      "Model",
      "--doc-id",
      "creation-A",
    ],
  ],
  [
    "helper run",
    [
      "run",
      "owned.py",
      "--helpers",
      "cad-v1",
      "--doc",
      "Model",
      "--doc-id",
      "creation-A",
    ],
  ],
  [
    "readonly run",
    [
      "run",
      "owned.py",
      "--readonly",
      "--doc",
      "Model",
      "--doc-file-id",
      "file-A",
    ],
  ],
  [
    "run output paths",
    [
      "run",
      "owned.py",
      "--config",
      "config.json",
      "--out",
      "result.json",
      "--out-format",
      "json",
      "--pretty",
      "true",
    ],
  ],
  ["run without selectors", ["run", "owned.py"]],
  ["run script listing", ["run", "--list"]],
  ["legacy document command", ["stats", "--doc", "Model"]],
  [
    "legacy tool listing",
    ["tools", "--json", "--header", "X-Test: owned", "--timeout", "1500"],
  ],
  ["legacy help", ["help", "run"]],
];

test("staged runtime request edge preserves historical projections", (t) => {
  const staged = load("./dist/src/composition/execution-request.js") as Adapter;
  const cwd = fixture(t);
  for (const [label, argv] of successCases) {
    const input = request(cwd, argv);
    freeze(input);
    assert.deepEqual(
      staged.prepareRequest({ request: input }),
      previous.prepareRequest({ request: input }),
      label,
    );
  }
});

for (const [label, argv] of successCases) {
  test(`request migration preserves ${label} and the accepted owner`, (t) => {
    const cwd = fixture(t);
    const input = request(cwd, argv);
    const snapshot = structuredClone(input);
    freeze(input);
    const old = previous.prepareRequest({ request: input });
    const result = current.prepareRequest({ request: input });
    assert.deepEqual(result, old);
    assert.equal(
      JSON.stringify(result),
      JSON.stringify(old),
      "Serialized field order is part of the worker contract",
    );
    assert.deepEqual(input, snapshot);
    assert.equal(result.inputFiles, input.inputFiles);
    assert.equal(result["requestId"], "request-A");
    assert.equal(result["clientId"], "owner-A");
    assert.equal(result["ownerToken"], "accepted-token");
    assert.equal(result["clientContext"], input["clientContext"]);
    if (result.payload?.["kind"] === "run") {
      const payload = result.payload as {
        request: { name: string };
        output?: { path: string };
      };
      assert.equal(payload.request.name, path.join(cwd, "owned.py"));
      if (payload.output)
        assert.equal(payload.output.path, path.join(cwd, "result.json"));
    }
  });
}

for (const absolute of [false, true]) {
  for (const family of ["cad", "run"] as const) {
    test(`${family} rejects changed ${absolute ? "absolute" : "relative"} input pins before producing a worker request`, (t) => {
      const cwd = fixture(t);
      const filename = family === "cad" ? "input.json" : "args.json";
      const input = request(
        cwd,
        family === "cad"
          ? ["entity", "list", "--doc", "Model", "--file", filename]
          : ["run", "owned.py", "--args-file", filename],
      );
      if (absolute)
        input.inputFiles = input.inputFiles!.map((pin) => ({
          ...pin,
          path: path.join(cwd, pin.path),
        }));
      const before = structuredClone(input);
      fs.writeFileSync(path.join(cwd, filename), '{"changed":true}');
      for (const api of [previous, current]) {
        assert.throws(() => api.prepareRequest({ request: input }), {
          code: "INPUT_CHANGED",
          message:
            family === "cad"
              ? "Accepted CAD input bytes changed"
              : "Accepted run argument bytes changed",
        });
        assert.deepEqual(input, before);
      }
    });
  }
}

const invalidCases: [string, string[]][] = [
  ["missing required preview document", ["entity", "list", "--preview"]],
  ["unknown command", ["not-a-command"]],
  [
    "duplicate CAD identity",
    ["entity", "list", "--doc-id", "A", "--doc-id", "B"],
  ],
  [
    "duplicate run identity",
    ["run", "owned.py", "--doc", "Model", "--doc-id", "A", "--doc-id", "B"],
  ],
  ["unbound run identity", ["run", "owned.py", "--doc-id", "A"]],
  [
    "unknown helper version",
    [
      "run",
      "owned.py",
      "--helpers",
      "unknown",
      "--doc",
      "Model",
      "--doc-id",
      "A",
    ],
  ],
  [
    "conflicting run arguments",
    ["run", "owned.py", "--args", "[]", "--args-file", "args.json"],
  ],
  ["invalid inline JSON", ["run", "owned.py", "--args", "{broken"]],
  ["missing script", ["run", "missing.py"]],
  ["missing input file", ["entity", "list", "--file", "absent.json"]],
  [
    "invalid output format",
    ["run", "owned.py", "--out", "result.txt", "--out-format", "binary"],
  ],
];
for (const [label, argv] of invalidCases) {
  test(`request migration retains ${label} rejection`, (t) => {
    const input = request(fixture(t), argv);
    freeze(input);
    const observations = [previous, current].map((api) => {
      try {
        api.prepareRequest({ request: input });
      } catch (error) {
        assert.ok(error instanceof Error);
        return {
          name: error.name,
          message: error.message,
          code: "code" in error ? error.code : undefined,
        };
      }
      assert.fail("Invalid input must not produce a worker request");
    });
    assert.deepEqual(observations[1], observations[0]);
  });
}

test("already typed requests retain object identity without reparsing raw metadata", () => {
  for (const kind of ["cad", "cad-command", "run"]) {
    const input = request("/no-such-project", ["not-an-executable-command"]);
    input.payload = { version: 1, kind, retained: "authoritative payload" };
    freeze(input);
    for (const api of [previous, current])
      assert.equal(api.prepareRequest({ request: input }), input);
  }
});

test("legacy projections are rebuilt from accepted argv and keep the original payload untouched", (t) => {
  const input = request(fixture(t), ["stats", "--doc", "Owned model"]);
  input.payload = {
    version: 1,
    kind: "legacy-command",
    stale: "previous projection",
  };
  const oldPayload = input.payload;
  freeze(input);
  const result = current.prepareRequest({ request: input });
  assert.deepEqual(result, previous.prepareRequest({ request: input }));
  assert.equal(input.payload, oldPayload);
  assert.notEqual(result.payload, oldPayload);
  assert.equal(
    (result.payload?.["flags"] as Record<string, unknown>)["--doc"],
    "Owned model",
  );
});

for (const description of [undefined, "", "Accepted purpose"]) {
  test(`request purpose precedence is retained for ${JSON.stringify(description)}`, (t) => {
    const input = request(fixture(t), [
      "entity",
      "list",
      "--doc",
      "Model",
      "--preview",
      "--purpose",
      "Argument purpose",
    ]);
    input.description = description;
    const result = current.prepareRequest({ request: input });
    assert.deepEqual(result, previous.prepareRequest({ request: input }));
    const payload = result.payload as { invocation: { purpose: string } };
    assert.equal(payload.invocation.purpose, description || "Argument purpose");
  });
}

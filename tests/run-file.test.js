// Offline backend doubles only. All fixtures are exclusive-created and retained.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { main } = require("../src/cli");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "run-file-"));
const script = path.join(root, "trusted script.py");
fs.writeFileSync(
  script,
  'ARGS = {}\nDOC_NAME = ""\ndef run(context):\n    pass\n',
  { flag: "wx" },
);

function harness(backend) {
  const calls = [];
  let errors = "";
  return {
    calls,
    get errors() {
      return errors;
    },
    deps: {
      loadConfig: () => {
        calls.push("config");
        return { cfg: { backend } };
      },
      createFmcad: () => ({
        async start() {
          calls.push("start");
        },
        async dispose() {
          calls.push("dispose");
        },
        async execute(payload, options) {
          calls.push({ payload, options });
          return {
            version: 1,
            requestId: options.requestId,
            jobId: null,
            state: "succeeded",
            result: null,
            outcome: {
              version: 1,
              requestId: null,
              jobId: null,
              acceptance: "accepted",
              executionOutcome: "succeeded",
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
      }),
      stdout: { write() {} },
      stderr: {
        write(s) {
          errors += s;
        },
      },
      setExitCode() {},
    },
  };
}

test("file input matches inline encoding for all JSON types and oversized Unicode on both backends", async () => {
  const values = [
    null,
    false,
    0,
    "Zażółć 🐈",
    [],
    {},
    {
      geometry: "🧩ż".repeat(100000),
      flags: [true, null],
      literal: "$&\nARGS = unsafe",
    },
  ];
  for (const [i, value] of values.entries()) {
    const file = path.join(root, `payload ${i}.json`);
    const contents = JSON.stringify(value);
    fs.writeFileSync(file, contents, { flag: "wx" });
    for (const backend of ["mcp", "addin"]) {
      const h = harness(backend);
      assert.equal(
        await main(
          [
            "run",
            script,
            "--args-file",
            path.relative(process.cwd(), file),
            "--doc",
            "Pinned",
            "--readonly",
          ],
          h.deps,
        ),
        0,
        h.errors,
      );
      assert.equal(h.calls[0], "config");
      const call = h.calls.find((entry) => typeof entry === "object");
      assert.equal(call.payload.kind, "run");
      assert.equal(call.payload.request.name, script);
      assert.deepEqual(call.payload.request.args, value);
      assert.equal(call.payload.request.hasArgs, true);
      assert.equal(call.payload.request.doc, "Pinned");
      assert.equal(call.payload.request.identity.readOnly, true);
      assert.ok(call.payload.request.readOnlyOperations.includes("document.status"));
      assert.equal(
        Object.hasOwn(call.payload, "output"),
        false,
        "an unrequested output adapter must not turn a fixed run into a file-capable invocation",
      );
      assert.deepEqual(call.options.inputFiles, [
        {
          path: file,
          sha256: require("node:crypto")
            .createHash("sha256")
            .update(contents)
            .digest("hex"),
        },
      ]);
      assert.deepEqual(
        h.calls.filter((entry) => ["start", "dispose"].includes(entry)),
        ["start", "dispose"],
      );
      assert.equal(fs.readFileSync(file, "utf8"), contents);
    }
  }
});

test("cad-v1 fixed-run CLI payload omits implicit outputs and read-only exceptions", async () => {
  const h = harness("addin");
  const fixture = path.resolve(
    __dirname,
    "../assets/native-qualification/drive-precision.py",
  );
  const args = {
    approved: true,
    creationId: "fixed-owned-id",
    expectedFusionVersion: "2706.1.17",
    fixturePrefix: "NQGM12TEST01",
  };
  assert.equal(
    await main(
      [
        "run",
        fixture,
        "--helpers",
        "cad-v1",
        "--args",
        JSON.stringify(args),
        "--doc",
        "Pinned",
        "--doc-id",
        args.creationId,
      ],
      h.deps,
    ),
    0,
    h.errors,
  );
  const call = h.calls.find((entry) => typeof entry === "object");
  assert.equal(call.payload.kind, "run");
  assert.equal(Object.hasOwn(call.payload, "output"), false);
  assert.deepEqual(call.payload.request.readOnlyOperations, []);
  assert.equal(call.payload.request.helperVersion, "cad-v1");
});

test("invalid file input and conflicts fail before configuration or backend calls", async () => {
  const invalid = path.join(root, "invalid.json");
  fs.writeFileSync(invalid, "{bad", { flag: "wx" });
  const noSlot = path.join(root, "no-slot.py");
  fs.writeFileSync(noSlot, "def run(context):\n    pass\n", { flag: "wx" });
  for (const args of [
    [script, "--args-file"],
    [script, "--args-file", invalid],
    [script, "--args-file", path.join(root, "missing.json")],
    [script, "--args", "{}", "--args-file", invalid],
    [script, "--args-file", invalid, "--args", "{}"],
    [noSlot, "--args-file", path.join(root, "payload 0.json")],
  ]) {
    const h = harness("mcp");
    assert.equal(await main(["run", ...args], h.deps), 1);
    assert.deepEqual(h.calls, []);
    assert.match(h.errors, /ERROR/);
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { prepareIsolatedStdout } from "../packages/node-adapters/src/python/isolated-stdout";
import { createPythonChecker } from "../packages/node-adapters/src/python/checker";
import { resolve } from "node:path";

const harness = String.raw`
import builtins, inspect, io, json, sys, typing
request = json.loads(sys.stdin.read())
native_exec, native_compile, native_print = exec, compile, print
native_base = BaseException
native_stringio = io.StringIO
original_stdout = sys.stdout
buffer = native_stringio()
calls = []
frames = []
def sentinel(*args, **kwargs):
    calls.append("sentinel")
def trace(frame, event, arg):
    if event == "call" and frame.f_code.co_filename == "<isolated-stdout-source>":
        frames.append({
            "hasApp": "app" in frame.f_globals,
            "hasHostRun": frame.f_globals.get("run") is sentinel,
            "builtins": sorted(frame.f_builtins),
        })
    return trace
saved = {}
kind = request.get("tamper")
if kind in ("print", "compile", "exec", "RuntimeError", "TypeError", "len"):
    saved[kind] = builtins.__dict__[kind]
    builtins.__dict__[kind] = sentinel
if kind == "StringIO":
    io.StringIO = sentinel
if kind == "sink-write":
    buffer.write = sentinel
if kind == "sink-subclass":
    class CustomBuffer(native_stringio):
        def write(self, value):
            calls.append("subclass-write")
    buffer = CustomBuffer()
environment = {"__builtins__": builtins.__dict__, "io": io, "inspect": inspect,
               "app": object(), "run": sentinel}
if kind == "builtins-module":
    environment["__builtins__"] = builtins
if kind == "builtins-copy":
    environment["__builtins__"] = builtins.__dict__.copy()
if kind == "missing-inspect":
    del environment["inspect"]
if kind == "wrong-native-name":
    saved["len"] = builtins.len
    builtins.len = builtins.abs
if kind == "module-getattribute":
    class FakeModule:
        def __getattribute__(self, name):
            calls.append("getattribute")
            return sentinel
    environment["io"] = FakeModule()
if kind == "exception-metaclass":
    class Meta(type):
        def __getattribute__(self, name):
            calls.append("metaclass")
            return sentinel
    class FakeError(metaclass=Meta):
        pass
    saved["RuntimeError"] = builtins.RuntimeError
    builtins.RuntimeError = FakeError
error = None
sys.stdout = buffer
sys.settrace(trace)
try:
    native_exec(native_compile(request["script"], "<owned-kernel-test>", "exec"), environment)
except native_base as failure:
    error = failure.__class__.__name__
finally:
    sys.settrace(None)
    sys.stdout = original_stdout
    io.StringIO = native_stringio
    for name, value in saved.items():
        builtins.__dict__[name] = value
native_print(json.dumps({"stdout": native_stringio.getvalue(buffer), "calls": calls,
                        "frames": frames, "error": error,
                        "hostRunPreserved": environment["run"] is sentinel,
                        "hostResultAssigned": "_mcp_result" in environment}))
`;

function execute(source: string, tamper?: string, optimized = false) {
  const prepared = prepareIsolatedStdout(source);
  assert.equal(prepared.status, "prepared", JSON.stringify(prepared));
  if (prepared.status !== "prepared")
    throw new Error("Missing prepared profile");
  assert.equal(
    prepared.sourceSha256,
    createHash("sha256").update(source).digest("hex"),
  );
  assert.equal(
    prepared.programHash,
    createHash("sha256").update(prepared.script).digest("hex"),
  );
  assert.equal(prepared.artifact.script, prepared.script);
  assert.equal(prepared.artifact.sha256, prepared.programHash);
  assert.equal(prepared.artifact.units.length, 2);
  const user = prepared.artifact.units.find((unit) => unit.role === "user");
  assert.equal(user?.source, source);
  assert.equal(user?.sha256, prepared.sourceSha256);
  const result = spawnSync(
    "python3",
    ["-I", "-S", "-B", ...(optimized ? ["-O"] : []), "-c", harness],
    {
      input: JSON.stringify({ script: prepared.script, tamper }),
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as {
    stdout: string;
    calls: string[];
    error: string | null;
    frames: { hasApp: boolean; hasHostRun: boolean; builtins: string[] }[];
    hostRunPreserved: boolean;
    hostResultAssigned: boolean;
  };
}

test("public stdout profile preserves exact historical module print and raw exec semantics", () => {
  const original = 'print("FUSION_ADDIN_STDIO_OK")';
  assert.equal(
    createHash("sha256").update(original).digest("hex"),
    "9591b815b8e3431916dd79ad42900b3675a900116c950d711ac1ab247cb3aa3a",
  );
  const cases = [
    [original, "FUSION_ADDIN_STDIO_OK\n"],
    ['print("żółć", "日本語", sep=" / ", end="!\\n")', "żółć / 日本語!\n"],
    ['print(1 + 2, len("abc"), sorted([3, 1]))', "3 3 [1, 3]\n"],
    [
      'def run(ctx: str):\n print("DO_NOT_AUTOCALL")\nprint("module")',
      "module\n",
    ],
    [
      'def outer(x):\n def inner():\n  print(x)\n return inner\nouter("closure")()',
      "closure\n",
    ],
    [
      'print("import os")\napp="local"\nprint(app)\nprint("a",end="")\nprint("b",flush=True)',
      "import os\nlocal\nab\n",
    ],
  ];
  for (const [source, expected] of cases) {
    assert.ok(source !== undefined);
    const result = execute(source);
    assert.equal(result.stdout, expected);
    assert.equal(result.error, null);
    assert.deepEqual(result.calls, []);
    assert.equal(result.hostRunPreserved, true);
    assert.equal(result.hostResultAssigned, false);
    assert.equal(result.frames[0]?.hasApp, false);
    assert.equal(result.frames[0]?.hasHostRun, false);
    for (const forbidden of [
      "exec",
      "compile",
      "__import__",
      "open",
      "eval",
      "globals",
      "locals",
      "getattr",
    ])
      assert.equal(result.frames[0]?.builtins.includes(forbidden), false);
  }
});

test("original exceptions propagate with partial stdout; sink instance write is bypassed", () => {
  const result = execute('print("partial")\nraise RuntimeError("expected")');
  assert.equal(result.stdout, "partial\n");
  assert.equal(result.error, "RuntimeError");
  const printError = execute('print("partial")\nprint("x", sep=3)');
  assert.equal(printError.stdout, "partial\n");
  assert.equal(printError.error, "TypeError");
  const sink = execute('print("direct C sink")', "sink-write");
  assert.equal(sink.stdout, "direct C sink\n");
  assert.deepEqual(sink.calls, []);
  assert.equal(
    execute('print("module builtins")', "builtins-module").stdout,
    "module builtins\n",
  );
});

test("binding refusals happen before original source without invoking benign sentinels", () => {
  for (const tamper of [
    "print",
    "compile",
    "exec",
    "StringIO",
    "TypeError",
    "module-getattribute",
    "sink-subclass",
    "builtins-copy",
    "missing-inspect",
  ])
    assertDenied(execute('print("ORIGINAL")', tamper));
  for (const tamper of ["RuntimeError", "exception-metaclass"])
    assertDenied(
      execute('print("ORIGINAL")\nraise RuntimeError("expected")', tamper),
    );
  assertDenied(execute('print(len("ORIGINAL"))', "len"));
  assertDenied(execute('print(len("ORIGINAL"))', "wrong-native-name"));
  assertDenied(execute('print("ORIGINAL")', "print", true));
});

function assertDenied(result: ReturnType<typeof execute>) {
  assert.equal(result.stdout, "");
  assert.equal(result.error, "ZeroDivisionError");
  assert.deepEqual(result.calls, []);
  assert.deepEqual(result.frames, []);
}

test("AST inventory rejects all imports, result carriers and unsupported explicit file arguments", () => {
  for (const source of [
    "import sys\nprint('x')",
    "def unused():\n import sys\nprint('x')",
    "def unused():\n from json import dumps\nprint('x')",
    "_mcp_result=1\nprint('x')",
    "print('x', file=None)",
    "import sys\nprint('x', file=sys.stderr)",
    "def run(ctx):\n print(ctx)",
  ]) {
    const result = prepareIsolatedStdout(source);
    assert.equal(result.status, "unsupported", source);
    assert.equal(
      result.sourceSha256,
      createHash("sha256").update(source).digest("hex"),
    );
  }
});

test("normal checker checks the actual wire kernel and exact extracted original unit", async () => {
  const prepared = prepareIsolatedStdout('print("FUSION_ADDIN_STDIO_OK")');
  assert.equal(prepared.status, "prepared");
  if (prepared.status !== "prepared")
    throw new Error("Missing prepared artifact");
  const report = await createPythonChecker({
    typingRoot: resolve("runtime/python/typing"),
  }).check({ artifact: prepared.artifact, context: { kind: "raw" } });
  assert.equal(report.status, "passed", JSON.stringify(report));
  assert.deepEqual(report.diagnostics, []);
  assert.equal(report.provenance.wireHash, prepared.programHash);
  const invalid = prepareIsolatedStdout('value: int = "bad"\nprint(value)');
  assert.equal(invalid.status, "prepared");
  if (invalid.status !== "prepared")
    throw new Error("Missing negative artifact");
  const rejected = await createPythonChecker({
    typingRoot: resolve("runtime/python/typing"),
  }).check({ artifact: invalid.artifact, context: { kind: "raw" } });
  assert.equal(rejected.status, "failed");
  assert.ok(
    rejected.diagnostics.some(
      (diagnostic) =>
        diagnostic.unitId === "embedded:0" &&
        diagnostic.rule === "reportAssignmentType",
    ),
  );
});

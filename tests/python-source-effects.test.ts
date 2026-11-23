import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  readFileSync,
  mkdtempSync,
  rmSync,
  existsSync,
  copyFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { provePythonSourceEffects } from "../packages/node-adapters/src/python/source-effects";
import { adapterReadonlyFence } from "./scenarios/adapter-readonly-fence";

test("public producer proves the exact retained adapter corpus without executing it", (t) => {
  const source = readFileSync(
    "tests/scenarios/native-backend-adapter-cases.ts",
    "utf8",
  );
  const snapshot = source
    .split("export const snapshotScript = `")[1]
    ?.split("`;")[0];
  assert.ok(snapshot);
  const originalCases = [
    snapshot,
    'import sys\ndef run(_context: str):\n print("ADAPTER_STDOUT")\n print("ADAPTER_STDERR", file=sys.stderr)',
    'def run(_context: str):\n raise ValueError("ADAPTER_EXPECTED_EXCEPTION")',
    'def run(_context: str):\n raise RuntimeError("intentional")',
    'def run(_context: str):\n print("żółć 日本語 🧪")',
    'print("FUSION_ADDIN_STDIO_OK")',
    ...Array.from(
      { length: 450 },
      (_, i) => `def run(_context: str):\n print("ADAPTER_PROBE_${i + 1}")`,
    ),
  ];
  const cases = originalCases.flatMap((code) =>
    code.includes("def run(") ? [code, adapterReadonlyFence(code)] : [code],
  );
  for (const code of cases) {
    const result = provePythonSourceEffects(code);
    assert.equal(result.status, "proven", JSON.stringify(result));
    assert.equal(Object.isFrozen(result), true);
    assert.equal(
      result.sourceSha256,
      createHash("sha256").update(code).digest("hex"),
    );
  }
  t.diagnostic(
    JSON.stringify({
      cases: cases.length,
      markers: 450,
      markerForms: ["original", "readonly-fenced"],
      corpus: [
        "tests/scenarios/native-backend-adapter-cases.ts",
        "tests/scenarios/adapter-readonly-fence.ts",
        "tests/scenarios/native-mcp-stdio-cases.ts",
      ],
      sourceDigestInventory: createHash("sha256")
        .update(
          JSON.stringify(
            cases.map((code) =>
              createHash("sha256").update(code).digest("hex"),
            ),
          ),
        )
        .digest("hex"),
    }),
  );
});

test("aliases and closures resolve actual symbols, not spellings or annotations", () => {
  for (const code of [
    "def outer(x):\n def inner():\n  print(x)\n return inner\ndef run(ctx):\n f=outer('safe')\n f()",
    "p=print\ndef say(x):\n p(x)\ndef run(ctx):\n say('safe')",
    "from adsk.core import Application as App\ndef identity(doc):\n return doc.creationId\ndef run(ctx):\n get=App.get\n print(identity(get().activeDocument))",
    "import inspect as i, sys as s\nsize=len\nstack=i.stack\ndef run(ctx):\n print(size(stack()), file=s.stderr)",
  ])
    assert.equal(provePythonSourceEffects(code).status, "proven");
  for (const code of [
    "def run(ctx: str):\n print(ctx)",
    "def run(ctx):\n print=ctx\n print('unsafe')",
    "def run(ctx):\n print('first')\n print=ctx",
    "import adsk.core as c\ndef run(ctx):\n d=c.Application.get().activeDocument\n f=d.close\n f(False)",
    "def outer(x):\n def inner():\n  x()\n return inner\ndef run(ctx):\n outer(ctx)()",
    "def outer(x):\n def inner():\n  x()\n return inner\n x=print\ndef run(ctx):\n outer(ctx)()",
    "def run(ctx):\n x='safe'\n if ctx is None:\n  f=lambda: print(x)\n else:\n  f=lambda: print(x)\n x=ctx\n f()",
    "def run(ctx):\n f=ctx\n try:\n  pass\n except:\n  f=print\n f('unsafe')",
    "def outer(x):\n def inner():\n  x()\n try:\n  return inner\n finally:\n  pass\n x=print\ndef run(ctx):\n outer(ctx)()",
    "def run(ctx):\n f=print\n def inner():\n  f('unsafe')\n if ctx is None:\n  f=ctx\n  inner()",
    "def run(ctx):\n f=ctx\n def inner():\n  f()\n try:\n  1/0\n  f=print\n finally:\n  inner()",
    "import adsk.core as c\ndef identity(doc):\n return doc.creationId\ndef run(ctx: str):\n print(identity(ctx))",
  ])
    assert.equal(provePythonSourceEffects(code).status, "unproven", code);
});

test("unknown effects, definition-time calls, magic and introspection fail closed", () => {
  const bodies = [
    "open('/tmp/effect-proof-must-not-exist','w')",
    "eval('1')",
    "exec('print(1)')",
    "__import__('os')",
    "getattr(c.Application.get(),'activeDocument').close(False)",
    "setattr(c.Application.get().activeDocument,'name','x')",
    "c.Application.get().activeDocument.name='x'",
    "c.Application.get().activeDocument.__dict__['name']='x'",
    "c.Application.get().documents.add(0)",
    "c.Application.get().activeDocument.save('x')",
    "c.Application.get().activeDocument.dataFile.deleteMe()",
    "print(ctx)",
    "str(ctx)",
    "sorted([ctx])",
    "print(json.dumps(ctx))",
    "print(inspect.stack())",
    "print(inspect.stack()[0].frame)",
    "print(type(sys.stdout).__dict__)",
    "print(ctx.__class__)",
    "while True:\n  print('loop')",
  ];
  for (const body of bodies) {
    const code = `import adsk.core as c, json, inspect, sys\ndef run(ctx):\n ${body.replaceAll("\n", "\n ")}`;
    assert.equal(provePythonSourceEffects(code).status, "unproven", code);
  }
  for (const code of [
    "import os\nos.remove('/tmp/no')",
    "import socket\nsocket.socket()",
    "def f(x=open('/tmp/no')):\n pass",
    "def f(x: open('/tmp/no')):\n pass",
    "@print('decorator')\ndef f():\n pass",
    "class Sneaky:\n def __str__(self):\n  open('/tmp/no','w')\ndef run(ctx):\n print(Sneaky())",
    "import json\njson.dumps = print",
    "import adsk.core as c\ndef mutate():\n c.Application.get().activeDocument.close(False)\ndef helper(x=mutate()):\n pass",
    "import adsk.core as c\ndef mutate():\n c.Application.get().activeDocument.close(False)\ndef helper(x: mutate()):\n pass",
    "import sys\ndef run(ctx):\n f=sys._getframe()\n while f is not None:\n  f=f.f_back",
    "print = lambda x: open('/tmp/no','w')\ndef run(ctx):\n print('x')",
    "def run(ctx):\n return run(ctx)",
  ])
    assert.equal(provePythonSourceEffects(code).status, "unproven", code);
});

test("parse errors and excessive inputs are explicit unproven, not execution", () => {
  for (const code of [
    "def broken(",
    "#".repeat(600_000),
    "x=1\n".repeat(4000),
  ]) {
    const result = provePythonSourceEffects(code);
    assert.equal(result.status, "unproven");
    assert.equal(Object.isFrozen(result), true);
    if (result.status === "unproven")
      assert.equal(Object.isFrozen(result.reasons), true);
    assert.equal(
      result.sourceSha256,
      createHash("sha256").update(code).digest("hex"),
    );
  }
});

test("relocated compiled producer is self-contained; caller code never runs; missing parser fails closed", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "source-effects żółć "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const installed = path.join(root, "installed");
  mkdirSync(installed);
  const compiled = path.resolve(
    __dirname,
    "../packages/node-adapters/src/python",
  );
  for (const name of ["source-effects.js", "source-effects-driver.js"])
    copyFileSync(path.join(compiled, name), path.join(installed, name));
  const marker = path.join(root, "caller-was-executed");
  const source = `open(${JSON.stringify(marker)},'w').write('unsafe')`;
  const script = `
    const producer = require(process.argv[1]);
    console.log(JSON.stringify(producer.provePythonSourceEffects(process.argv[2])));
  `;
  for (const executablePath of [process.env["PATH"] ?? "", ""]) {
    const child = spawnSync(
      process.execPath,
      ["-e", script, path.join(installed, "source-effects.js"), source],
      {
        cwd: root,
        env: { PATH: executablePath, HOME: root },
        encoding: "utf8",
        timeout: 5000,
      },
    );
    assert.equal(child.status, 0, child.stderr);
    const result: unknown = JSON.parse(child.stdout);
    assert.ok(result && typeof result === "object" && "status" in result);
    assert.equal(result.status, "unproven");
    assert.equal(existsSync(marker), false);
  }
  const positive = spawnSync(
    process.execPath,
    [
      "-e",
      script,
      path.join(installed, "source-effects.js"),
      "def run(ctx):\n print('relocated')",
    ],
    {
      cwd: root,
      env: { PATH: process.env["PATH"] ?? "", HOME: root },
      encoding: "utf8",
      timeout: 5000,
    },
  );
  assert.equal(positive.status, 0, positive.stderr);
  assert.equal(JSON.parse(positive.stdout).status, "proven");
});

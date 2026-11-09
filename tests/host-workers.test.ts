import { createRequire } from "node:module";
import type { TestContext } from "node:test";
import { record, text } from "./integration/offline-cli";
const testRoot = process.cwd();
const runtimeRequire = createRequire(testRoot + "/tests/host-workers.test.js");
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
const { createLocalWorker, parseWorkerJson } = runtimeRequire(
  "../packages/node-adapters/dist/python/local-pipeline",
) as typeof import("../packages/node-adapters/src/python/local-pipeline");
const { redactDiagnostic } = runtimeRequire(
  "../src/diagnostics",
) as typeof import("@fmcad/core");

function fixture(
  t: TestContext,
  body: string,
  options: Partial<
    import("../packages/node-adapters/src/python/local-pipeline").LocalProcessOptions
  > = {},
) {
  const root = fs.mkdtempSync(path.join(tmpdir(), "fmcad host worker żółć "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const worker = path.join(root, "worker with spaces.py");
  fs.writeFileSync(
    worker,
    "import sys,json,time,os,subprocess\nrequest=json.load(sys.stdin)\n" + body,
  );
  return createLocalWorker({
    resolveWorker: () => worker,
    resolvePython: () => "python3",
    redactDiagnostic,
    ...options,
  });
}
const plan: import("@fmcad/core").LocalWorkerPlan = {
  worker: "image-trace",
  python: undefined,
  args: [],
  request: {},
};

for (const output of [
  "",
  "{} {}",
  "not JSON",
  "NaN",
  '{"x":Infinity}',
  '{"x":1e999}',
]) {
  test(`real subprocess rejects invalid JSON to EOF ${JSON.stringify(output)}`, async (t) => {
    let published = "";
    const worker = fixture(t, `sys.stdout.write(${JSON.stringify(output)})`, {
      stdout: (data) => {
        published += data;
      },
    });
    await assert.rejects(worker.run(plan), /Invalid local worker JSON/);
    assert.equal(published, "", "unvalidated output must not reach CLI stdout");
  });
}

test("real worker preserves Unicode bytes/argv and exit status, redacts diagnostic copies", async (t) => {
  const worker = fixture(
    t,
    'sys.stderr.write("Authorization: Bearer private-value\\n")\nprint(json.dumps({"argv":sys.argv[1:],"input":request},ensure_ascii=False))',
  );
  const result = await worker.run({
    ...plan,
    args: ["space żółć", "$(touch NOT-A-SHELL)"],
    request: { text: "Zażółć" },
  });
  assert.deepEqual(JSON.parse(result.stdout), {
    argv: ["space żółć", "$(touch NOT-A-SHELL)"],
    input: { text: "Zażółć" },
  });
  assert.match(result.stderr, /REDACTED/);
  assert.ok(!result.stderr.includes("private-value"));
  const crash = fixture(t, 'print("failure")\nsys.exit(7)');
  assert.equal((await crash.run(plan)).code, 7);
  assert.throws(() => parseWorkerJson('{"overflow":1e999}'), /Non-finite/);
});

test("deadline and output limit stop owned process group, never an unrelated sentinel", async (t) => {
  const sentinel = spawn(
    "python3",
    ["-B", "-c", "import time;time.sleep(60)"],
    { detached: true, stdio: "ignore" },
  );
  t.after(() => sentinel.kill("SIGKILL"));
  const root = fs.mkdtempSync("/tmp/opencode/fmcad-worker-pid-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pidfile = path.join(root, "pid");
  const worker = fixture(
    t,
    `child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)'])\nopen(${JSON.stringify(pidfile)},'w').write(str(child.pid))\ntime.sleep(60)`,
    { timeoutMs: 300 },
  );
  await assert.rejects(worker.run(plan), /timed out/);
  const pid = Number(fs.readFileSync(pidfile, "utf8"));
  const stat = `/proc/${pid}/stat`;
  // The host init may retain a killed orphan zombie; it must not execute.
  for (
    let i = 0;
    i < 50 &&
    fs.existsSync(stat) &&
    !text(fs.readFileSync(stat, "utf8").split(") ")[1]).startsWith("Z");
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(
    !fs.existsSync(stat) ||
      text(fs.readFileSync(stat, "utf8").split(") ")[1]).startsWith("Z"),
  );
  assert.equal(sentinel.exitCode, null);
  await assert.rejects(
    fixture(t, 'print("x"*10000)', { maxOutputBytes: 100 }).run(plan),
    /output exceeds limit/,
  );
});

test("worker startup and invalid limits fail without shell fallback", async (t) => {
  await assert.rejects(
    fixture(t, 'print("{}")', {
      resolvePython: () => "/no such interpreter",
    }).run(plan),
    /ENOENT/,
  );
  assert.throws(
    () => fixture(t, 'print("{}")', { timeoutMs: NaN }).run(plan),
    /Invalid local worker/,
  );
});

test("escaped pipe writer cannot extend the deadline; cleanup does not claim its session", async (t) => {
  const root = fs.mkdtempSync("/tmp/opencode/fmcad-escaped-writer-");
  const pidfile = path.join(root, "pid");
  t.after(() => {
    if (fs.existsSync(pidfile)) {
      try {
        process.kill(Number(fs.readFileSync(pidfile, "utf8")), "SIGKILL");
      } catch (error) {
        if (record(error)["code"] !== "ESRCH") throw error;
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const worker = fixture(
    t,
    `child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)'],start_new_session=True)\nopen(${JSON.stringify(pidfile)},'w').write(str(child.pid))\nprint('{}',flush=True)`,
    { timeoutMs: 300 },
  );
  const started = Date.now();
  await assert.rejects(worker.run(plan), /timed out/);
  assert.ok(Date.now() - started < 2000);
  process.kill(Number(fs.readFileSync(pidfile, "utf8")), 0);
});

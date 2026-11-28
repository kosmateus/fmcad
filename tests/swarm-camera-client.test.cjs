"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { spawnSync } = require("node:child_process");
const {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const {
  prepareCamera,
  runCamera,
} = require("../scripts/integration/swarm-camera.cjs");
const pin = require("./fixtures/swarm-camera-document.json");
const digest = (s) => createHash("sha256").update(s).digest("hex");
const runPython = (source) =>
  execFileSync(
    "python3",
    ["-I", "-S", "-B", join(__dirname, "fixtures/swarm-camera-python.py")],
    { input: source, encoding: "utf8" },
  );

function runCliFixture(t, phase, override) {
  const dir = mkdtempSync(join(tmpdir(), "camera runner "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cli = join(dir, "capture.cjs"),
    log = join(dir, "calls"),
    evidence = join(dir, "evidence");
  writeFileSync(
    cli,
    `#!/usr/bin/env node
const fs=require("node:fs"), args=process.argv.slice(2);
fs.appendFileSync(process.env.CALLS,JSON.stringify(args)+"\\n");
const first=args[0]==="execute";
const file=first?args[1]:require("node:path").join(process.env.EVIDENCE,args[1]+".json");
const request=JSON.parse(fs.readFileSync(file));
const job={requestId:request.requestId,sourceHash:require("node:crypto").createHash("sha256").update(request.code).digest("hex"),id:"same-job",state:first?"queued":"failed"};
if(args[0]===process.env.PHASE){
  const [key,value]=JSON.parse(process.env.OVERRIDE);
  if(value===null) delete job[key]; else job[key]=value;
  job.state="queued";
}
// A bad intermediate GET followed by a valid one must still stop at the bad GET.
if(fs.readFileSync(process.env.CALLS,"utf8").trim().split("\\n").length>2)process.exit(17);
console.log(JSON.stringify(job));
`,
    { mode: 0o700 },
  );
  const run = spawnSync(
    process.execPath,
    [
      join(__dirname, "../scripts/integration/swarm-camera.cjs"),
      "run",
      join(__dirname, "fixtures/swarm-camera-document.json"),
      evidence,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        SWARM_DIRECTORY: dir,
        SWARM_CLI: cli,
        CALLS: log,
        EVIDENCE: evidence,
        PHASE: phase ?? "",
        OVERRIDE: JSON.stringify(override ?? []),
      },
    },
  );
  assert.equal(run.status, 1);
  const calls = readFileSync(log, "utf8")
    .trimEnd()
    .split("\n")
    .map((s) => JSON.parse(s));
  assert.equal(existsSync(join(evidence, "camera-result.json")), false);
  return { calls, run, evidence, dir };
}

test("runner sends execute and get to the same configured directory without splitting its path", (t) => {
  const {
    calls: [submit, get, ...others],
    run,
    evidence,
    dir,
  } = runCliFixture(t);
  assert.match(run.stderr, /failed; do not resubmit/);
  const { requestId } = JSON.parse(readFileSync(submit[1], "utf8"));
  assert.deepEqual(submit, [
    "execute",
    join(evidence, requestId + ".json"),
    "--directory",
    dir,
  ]);
  assert.deepEqual(get, ["get", requestId, "--directory", dir]);
  assert.equal(others.length, 0);
});

for (const phase of ["execute", "get"]) {
  for (const override of [
    ["requestId", "foreign"],
    ["sourceHash", "wrong"],
    ["id", null],
    ["id", "  "],
    ...(phase === "get" ? [["id", "other-job"]] : []),
  ]) {
    test(`${phase} rejects ${override[0]}=${JSON.stringify(override[1])} before any further poll`, (t) => {
      const { calls, run } = runCliFixture(t, phase, override);
      assert.match(run.stderr, /Mismatched swarm receipt.*do not resubmit/);
      assert.deepEqual(
        calls.map((args) => args[0]),
        phase === "execute" ? ["execute"] : ["execute", "get"],
      );
    });
  }
}

test("fresh pinned raw requests use source definitions, without a legacy broker envelope", () => {
  const plain = prepareCamera(pin);
  const refused = spawnSync(
    "python3",
    [
      "-I",
      "-S",
      "-B",
      join(__dirname, "fixtures/swarm-camera-python.py"),
      "no-design",
    ],
    { input: plain.code, encoding: "utf8" },
  );
  assert.equal(refused.status, 1);
  assert.match(
    refused.stderr,
    /ValueError: Document has no Fusion Design product: Test/,
  );
  assert.doesNotMatch(refused.stdout, /FMCAD_RESULT/);
  assert.doesNotMatch(
    plain.code,
    /class _IdentityData(?:Project|Folder|File)\b/,
  );
  const selector = plain.code.match(
    /class _IdentityDocument\(_IdentityProtocol\):([\s\S]*?)(?=\n    (?:class |from )|\n\S)/,
  );
  assert.deepEqual(
    [...selector[1].matchAll(/def (\w+)\(/g)].map((match) => match[1]),
    ["name", "allDocumentReferences"],
  );
  const saved = { ...pin, fileId: "file-from-test", version: 1 };
  const a = prepareCamera(saved),
    b = prepareCamera(saved);
  assert.notEqual(a.requestId, b.requestId);
  assert.deepEqual(a.document, saved);
  assert.equal(a.code, b.code);
  assert.deepEqual(Object.keys(a).sort(), ["code", "document", "requestId"]);
  assert.doesNotMatch(
    a.code,
    /_qr_native|swarmSourceHash|_camera_matching_names|<fmcad-queue>/,
  );
  assert.throws(() => prepareCamera({ ...pin, version: 1 }), /pin/);
});

test("camera reads and token alias continuations execute through the public host", async () => {
  const ids = new Set();
  const dispatch = async (request) => {
    assert.ok(!ids.has(request.requestId));
    ids.add(request.requestId);
    return {
      id: "job-" + request.requestId,
      requestId: request.requestId,
      sourceHash: digest(request.code),
      state: "succeeded",
      result: { stdout: runPython(request.code) },
    };
  };
  const plain = await runCamera(pin, undefined, dispatch);
  assert.equal(ids.size, 1);
  assert.deepEqual(plain.result.state.extents, [20, 10]);
  assert.equal(plain.result.state.document.creationId, pin.creationId);
  assert.deepEqual(await runCamera(pin, "alias", dispatch), plain);
  assert.equal(ids.size, 3);
});

test("unknown outcomes and mismatched source identities do not start another stage", async () => {
  for (const change of [
    { state: "needs_reconciliation" },
    { sourceHash: "wrong" },
    { requestId: "foreign" },
  ]) {
    let calls = 0;
    await assert.rejects(
      runCamera(pin, "alias", async (request) => {
        calls++;
        return {
          id: "job-" + request.requestId,
          requestId: request.requestId,
          sourceHash: digest(request.code),
          state: "succeeded",
          result: { stdout: "" },
          ...change,
        };
      }),
      /do not resubmit/,
    );
    assert.equal(calls, 1);
  }
});

// Optional cross-repository integration: require the real built swarm checkout.
if (process.env.SWARM_OFFLINE_ROOT)
  test("swarm contract, strict admission and pinned wrapper accept every emitted camera stage", async () => {
    const root = process.env.SWARM_OFFLINE_ROOT;
    const { decodeExecuteRequest } = require(join(root, "dist/contracts"));
    const { preparePinnedPython } = require(join(root, "dist/runtime/python"));
    const admission = require(join(root, "dist/python")).createPythonAdmission({
      typingRoot: join(root, "runtime/python/typing"),
      pythonPlatform: "Windows",
    });
    const dispatch = async (input) => {
      const request = decodeExecuteRequest(input);
      const wrap = preparePinnedPython(request.code, request.document);
      const cert = await admission.check(admission.prepare(wrap.code));
      cert.fence(wrap.code);
      const stdout = runPython(wrap.code);
      return {
        id: "job-" + request.requestId,
        requestId: request.requestId,
        sourceHash: wrap.sourceHash,
        state: "succeeded",
        result: { stdout },
      };
    };
    const p = { ...pin, fileId: "file-from-test", version: 1 };
    const plain = await runCamera(p, undefined, dispatch);
    assert.deepEqual(plain.result.state.extents, [20, 10]);
    assert.deepEqual(await runCamera(pin, undefined, dispatch), plain);
    assert.deepEqual(await runCamera(p, "alias", dispatch), plain);
  });

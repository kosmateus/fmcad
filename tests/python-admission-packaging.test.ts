import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

function installConsumer(directory: string) {
  const tarball = process.env["FMCAD_PACKED_TARBALL"]
    ? path.resolve(process.env["FMCAD_PACKED_TARBALL"])
    : (() => {
        const [packed] = array(
          JSON.parse(
            execFileSync(
              "npm",
              [
                "pack",
                "--ignore-scripts",
                "--json",
                "--pack-destination",
                directory,
              ],
              {
                cwd: path.resolve("."),
                encoding: "utf8",
                maxBuffer: 4 * 1024 * 1024,
              },
            ),
          ),
        );
        return path.join(directory, text(record(packed)["filename"]));
      })();
  fs.writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({ name: "admission-consumer", private: true }),
  );
  execFileSync(
    "npm",
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      tarball,
    ],
    { cwd: directory, encoding: "utf8" },
  );
}

test("installed consumer certifies exact raw Python and rejects errors offline outside checkout", (t) => {
  const directory = fs.mkdtempSync("/tmp/opencode/admission-installed-");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  installConsumer(directory);
  const source = `
    const path=require('node:path'),assert=require('node:assert/strict');
    const root=path.resolve('node_modules/fmcad/dist');
    const {createPythonRpcAdmission,createPythonChecker}=require(path.join(root,'src/python'));
    const runtime=path.join(root,'runtime/python');
    // Pure Python context deliberately needs no SDK producer. SDK contexts are
    // covered by the separate real-definitions checker packaging test.
    const admission=createPythonRpcAdmission({runtime,checker:createPythonChecker({typingRoot:path.join(runtime,'typing')})});
    const raw=code=>({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'execute_python',arguments:{code,persistent:false}}});
    (async()=>{
      await assert.rejects(admission.check(raw('x: int = "bad"')),e=>e.code==='PYTHON_CHECK_REJECTED'&&e.pythonCheck.status==='failed');
      const good=raw('x: int = 1');
      const certificate=await admission.check(good);assert.equal(certificate.report.status,'passed');certificate.fence(good);
      const changed=raw('x: int = 1');const bound=await admission.check(changed);changed.params.arguments.code='x: str = 1';
      assert.throws(()=>bound.fence(changed),{code:'PYTHON_ADMISSION_CHANGED'});
      const {prepareReceiptScript}=require(path.join(root,'src/queue-instance'));
      const sdkAdmission=createPythonRpcAdmission({runtime,checker:createPythonChecker({typingRoot:path.join(runtime,'typing'),
        definitionsRoot:path.join(runtime,'typing'),pythonPlatform:'Windows'})});
      const goodReceipt=prepareReceiptScript('import adsk.core\\np = adsk.core.Point3D.create(0, 0, 0)\\nif p is not None:\\n    print(p.x)',false,path.resolve('never-receipt.json'),{jobId:'installed'},{mapPath:value=>value});
      const checked=await sdkAdmission.check(raw(goodReceipt.script),goodReceipt);
      assert.equal(checked.report.status,'passed');checked.fence(raw(goodReceipt.script));
      const badReceipt=prepareReceiptScript('import adsk.core\\nadsk.core.Point3D.create("bad", 0, 0)',false,path.resolve('never-receipt.json'),{jobId:'installed-bad'},{mapPath:value=>value});
      await assert.rejects(sdkAdmission.check(raw(badReceipt.script),badReceipt),e=>e.code==='PYTHON_CHECK_REJECTED'&&e.pythonCheck.status==='failed');
      assert.equal(require('node:fs').existsSync('never-receipt.json'),false);
      console.log(JSON.stringify({status:'passed',rawPositive:certificate.report.status,receiptPositive:checked.report.status}));
    })().catch(e=>{console.error(e);process.exitCode=1;});
  `;
  const result = record(
    JSON.parse(
      execFileSync(process.execPath, ["-e", source], {
        cwd: directory,
        encoding: "utf8",
        env: {
          PATH: process.env["PATH"],
          HOME: directory,
          npm_config_offline: "true",
          HTTP_PROXY: "http://127.0.0.1:1",
          HTTPS_PROXY: "http://127.0.0.1:1",
        },
      }),
    ),
  );
  assert.deepEqual(result, {
    status: "passed",
    rawPositive: "passed",
    receiptPositive: "passed",
  });
});

test("installed consumer retains real CLI, worker, MCP and public API admission parity", (t) => {
  const directory = fs.mkdtempSync("/tmp/opencode/admission-installed-parity-");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  installConsumer(directory);
  // Run the real CLI/worker/MCP/API parity case from copied test harness files.
  // Every production module and the real checker resolve from the installed
  // tarball; no checkout source or private workspace package is used.
  const copied = path.join(directory, "tests");
  fs.mkdirSync(path.join(copied, "fixtures"), { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, "python-admission-ports.test.js"),
    path.join(copied, "python-admission-ports.test.js"),
  );
  fs.copyFileSync(
    path.resolve("tests/fixtures/python-admission-broker.cjs"),
    path.join(copied, "fixtures/python-admission-broker.cjs"),
  );
  const integration = execFileSync(
    process.execPath,
    [
      "--test",
      "--test-timeout=150000",
      "--test-name-pattern",
      "real CLI/worker, MCP and public API",
      path.join(copied, "python-admission-ports.test.js"),
    ],
    {
      cwd: directory,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      env: {
        PATH: process.env["PATH"],
        HOME: directory,
        FMCAD_ADMISSION_CONSUMER_PACKAGE: path.join(
          directory,
          "node_modules/fmcad",
        ),
        ...(process.env["WSL_DISTRO_NAME"]
          ? { WSL_DISTRO_NAME: process.env["WSL_DISTRO_NAME"] }
          : {}),
        npm_config_offline: "true",
        HTTP_PROXY: "http://127.0.0.1:1",
        HTTPS_PROXY: "http://127.0.0.1:1",
      },
    },
  );
  assert.match(integration, /tests 1\b/);
  assert.match(integration, /pass 1\b/);
  assert.match(integration, /fail 0\b/);
});

test("installed consumer checks the complete cad-v1 helper with retained origins", (t) => {
  const directory = fs.mkdtempSync("/tmp/opencode/admission-installed-helper-");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  installConsumer(directory);
  const source = String.raw`
    const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
    const root=path.resolve('node_modules/fmcad/dist'),runtime=path.join(root,'runtime/python');
    const {prepareRunScript}=require(path.join(root,'src/run'));
    const {prepareReceiptScript}=require(path.join(root,'src/queue-instance'));
    const {createPythonRpcAdmission,createPythonChecker,retainPythonOrigin,pythonArtifactManifest,pythonUnitContexts}=require(path.join(root,'src/python'));
    const sourcePath=path.resolve('helper-stage.py');
    fs.writeFileSync(sourcePath,'ARGS = []\nDOC_NAME = ""\ndef run(context: str) -> None:\n    stage = FMCAD.stage()\n    journal = FMCAD.journalInspect()\n    plan = FMCAD.resumePlan()\n    print(stage, journal, plan)\n');
    const original=prepareRunScript(sourcePath,[],false,'Fixture',{docId:'creation-123'},'cad-v1',[]);
    const receipt=prepareReceiptScript(original.script,true,path.resolve('never-receipt.json'),{jobId:'installed-helper-cad-v1'},{mapPath:value=>value});
    const artifact=retainPythonOrigin(receipt,pythonArtifactManifest(original));
    const contexts=Object.values(pythonUnitContexts(artifact));
    const request={jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'execute_python',arguments:{code:artifact.script,persistent:false}}};
    const admission=createPythonRpcAdmission({runtime,checker:createPythonChecker({typingRoot:path.join(runtime,'typing'),definitionsRoot:path.join(runtime,'typing'),pythonPlatform:'Windows'})});
    const started=Date.now();
    (async()=>{
      const certificate=await admission.check(request,artifact),report=certificate.report;
       assert.equal(original.units.length,154);assert.equal(artifact.context.origin.units.length,154);assert.equal(artifact.context.origin.sourceMap.length,153);
      assert.equal(report.status,'passed',JSON.stringify(report.reasons));assert.equal(report.diagnostics.length,0);
      assert.equal(report.provenance.artifactHash,artifact.artifactHash);assert.equal(report.provenance.wireHash,artifact.sha256);
      assert.equal(report.provenance.definitionsHash,'83dc3697aa61a47ada93c323e2f719c7be3d72091938415f666089a96b159179');
      assert.ok(contexts.some(c=>c.kind==='raw'&&c.entrypoint==='run'));
      assert.ok(contexts.some(c=>c.kind==='cad-v1'&&c.deferredFacade===true&&c.entrypoint==='run-if-present'));
      certificate.fence(request);assert.equal(fs.existsSync('never-receipt.json'),false);
      console.log(JSON.stringify({status:report.status,diagnostics:report.diagnostics.length,units:original.units.length,
        maps:artifact.context.origin.sourceMap.length,sourceBytes:Buffer.byteLength(original.script),sourceHash:original.sha256,
        artifactHash:artifact.artifactHash,finalWireHash:artifact.sha256,analysisHash:report.provenance.analysisHash,
        contexts,elapsedMs:Date.now()-started}));
    })().catch(error=>{console.error(error,error.pythonCheck);process.exitCode=1;});
  `;
  const result = record(
    JSON.parse(
      execFileSync(process.execPath, ["-e", source], {
        cwd: directory,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        env: {
          PATH: process.env["PATH"],
          HOME: directory,
          npm_config_offline: "true",
          HTTP_PROXY: "http://127.0.0.1:1",
          HTTPS_PROXY: "http://127.0.0.1:1",
        },
      }),
    ),
  );
  assert.equal(result["status"], "passed");
  assert.equal(result["units"], 154);
  assert.equal(result["maps"], 153);
  assert.equal(result["diagnostics"], 0);
  assert.ok(
    array(result["contexts"]).some(
      (context) => record(context)["kind"] === "raw",
    ),
  );
  assert.ok(
    array(result["contexts"]).some(
      (context) =>
        record(context)["kind"] === "cad-v1" &&
        record(context)["deferredFacade"],
    ),
  );
});

function record(value: unknown): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}
function text(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}

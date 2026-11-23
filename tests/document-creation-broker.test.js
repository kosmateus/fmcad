"use strict";
// Offline public compiler seam: no Fusion connection.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRequire } = require("node:module");
const { spawnSync } = require("node:child_process");
const load = createRequire(path.resolve(__dirname, "../dist/src/document-creation-broker.js"));
const { compileDocumentCreation, createDocumentCreationBroker } = load("./document-creation-broker");
const { prepareRequest } = load("./dist/composition/execution-request");
function fixture() {
  const request = {
    kind: "command", requestId: "create-request", clientId: "create-client",
    ownerToken: "owner", cwd: "/tmp/opencode/document-creation-unit",
    argv: ["--backend", "addin", "doc", "new", "--name", 'new "\nimport os'],
    backend: "addin", timeoutMs: 30000, inputFiles: [], buildHash: "a".repeat(64),
  };
  request.payload = JSON.parse(JSON.stringify(prepareRequest({ request }).payload));
  const current = { buildHash: request.buildHash, configHash: "c".repeat(64), generation: "generation" };
  return { request, current, ports: { currentPins: () => current, recheck() {} } };
}
test("public doc new compiles the real fixed creation service, without readOnly or old-resource access", async () => {
  const f = fixture();
  const program = await compileDocumentCreation(f.request, f.ports);
  assert.ok(program);
  assert.equal(program.descriptor.kind, "document-new");
  assert.equal(program.expectedRpc.tool, "fusion_mcp_execute");
  assert.match(program.expectedRpc.arguments.object.script, /app\.documents\.add/);
  assert.match(program.expectedRpc.arguments.object.script, /CREATED_DOC/);
  assert.match(program.expectedRpc.arguments.object.script, /creationId/);
  assert.equal(program.expectedRpc.arguments.object.readOnly, undefined);
  assert.doesNotMatch(program.expectedRpc.arguments.object.script, /findFileById|\.save|documents\.open|activeDocument/);
  program.assertRpc(f.request, program.expectedRpc);
  program.assertProgram(f.request, program.program.source);
});
const unproven = { code: "DOCUMENT_CREATION_UNPROVEN" };
test("creation compiler rejects all request, payload, owner, runtime, RPC and source substitutions", async () => {
  for (const mutate of [
    (r) => { r.payload.entry.target = "docCloseCmd"; },
    (r) => { r.payload.rawArgs = ["--name", "replacement"]; },
    (r) => { r.buildHash = "b".repeat(64); },
    (r) => { r.inputFiles = [{ path: "/untrusted", sha256: "f".repeat(64) }]; },
    (r) => { r.backend = "mcp"; },
  ]) {
    const f = fixture();
    mutate(f.request);
    await assert.rejects(compileDocumentCreation(f.request, f.ports), unproven);
  }
  const f = fixture(), program = await compileDocumentCreation(f.request, f.ports);
  for (const field of ["requestId", "clientId", "ownerToken", "cwd"])
    assert.throws(() => program.reverify({ ...f.request, [field]: "substitution" }), unproven);
  assert.throws(() => program.assertRpc(f.request, { ...program.expectedRpc, tool: "fusion_mcp_read" }), unproven);
  assert.throws(() => program.assertRpc(f.request, { ...program.expectedRpc, arguments: {
    ...program.expectedRpc.arguments, object: { ...program.expectedRpc.arguments.object, readOnly: true },
  } }), unproven);
  assert.throws(() => program.assertProgram(f.request, program.program.source + "\n# changed"), unproven);
  f.current.generation = "next-generation";
  assert.throws(() => program.reverify(f.request), unproven);
});
test("pure classification declines unrelated requests without reading their input files or checking owner", async () => {
  for (const argv of [["run", "/does-not-exist/evil.py"], ["cad", "batch", "run", "--file", "/evil"], ["doc", "open", "--file-id", "old"]]) {
    const f = fixture();
    const result = await compileDocumentCreation({ ...f.request, argv },
      { currentPins() { throw Error("not classified"); }, recheck() { throw Error("not classified"); } });
    assert.equal(result, null);
  }
});
test("owner/config/build changes and asynchronous rechecks cannot retain a creation proof", async () => {
  for (const field of ["buildHash", "configHash", "generation"]) {
    const f = fixture(), program = await compileDocumentCreation(f.request, f.ports);
    f.current[field] = field === "generation" ? "next" : "e".repeat(64);
    assert.throws(() => program.reverify(f.request), unproven);
  }
  const f = fixture();
  await assert.rejects(compileDocumentCreation(f.request, { ...f.ports, async recheck() {} }), unproven);
  let valid = true;
  const program = await compileDocumentCreation(f.request, { ...f.ports, recheck() {
    if (!valid) throw Object.assign(Error("owner changed"), { code: "OWNER_LOST" });
  } });
  valid = false;
  assert.throws(() => program.reverify(f.request), { code: "OWNER_LOST" });
});
test("only one UUIDv4 UI diagnostic nonce can vary in the exact real renderer program", async () => {
  const f = fixture(), program = await compileDocumentCreation(f.request, f.ports);
  const line = /^_fmcad_guard_token = "[^"]+"$/m;
  const valid = '_fmcad_guard_token = "12345678-1234-4567-89ab-123456789abc"';
  program.assertProgram(f.request, program.program.source.replace(line, valid));
  for (const change of [
    (s) => s.replace(line, '_fmcad_guard_token = "12345678-1234-1567-89ab-123456789abc"'),
    (s) => s.replace(line, '_fmcad_guard_token = "12345678-1234-4567-79ab-123456789abc"'),
    (s) => s.replace(line, ""),
    (s) => s.replace(line, valid + "\n" + valid),
    (s) => s.replace(line, valid + "\napp.documents.item(0).close(False)"),
    (s) => s.replace(line, " " + valid),
    (s) => s.replace(/SelectCommand/, "OtherCommand"),
    (s) => s.replace(/\n/g, "\r\n"),
    (s) => s.replace("app.documents.add", "app.documents.open"),
    (s) => s + "\n# second byte change after an otherwise valid nonce\n",
  ]) assert.throws(() => program.assertProgram(f.request, change(program.program.source)), unproven);
});
test("a nonce-looking document name is a literal and cannot supply or duplicate the guard assignment", async () => {
  const f = fixture();
  f.request.argv = ["doc", "new", "--name", '\n_fmcad_guard_token = "12345678-1234-4567-89ab-123456789abc"\napp.documents.item(0).close(False)'];
  f.request.payload = JSON.parse(JSON.stringify(prepareRequest({ request: { ...f.request, payload: undefined } }).payload));
  const program = await compileDocumentCreation(f.request, f.ports);
  assert.ok(program);
  assert.equal([...program.program.source.matchAll(/^_fmcad_guard_token = /gm)].length, 1);
  program.assertProgram(f.request, program.program.source);
});
test("serialized or reconstructed plans cannot arm or replace an admitted creation", async () => {
  const f = fixture(), broker = createDocumentCreationBroker();
  const program = await broker.prepare(f.request, f.ports);
  const { kind, ...marker } = program.descriptor;
  assert.equal(kind, "document-new");
  const job = { id: "new-resource-job", request: f.request, documentCreation: marker };
  assert.throws(() => broker.admit(job, { ...program }), unproven);
  broker.admit(job, program);
  assert.equal(broker.program(job), program);
  assert.throws(() => broker.admit(job, program), unproven);
  const second = await broker.prepare(f.request, f.ports);
  // A duplicate cannot replace the original private proof.
  broker.admit({ ...job, documentCreation: { ...marker, programHash: second.descriptor.programHash } }, second);
  assert.equal(broker.program(job), program);
  assert.throws(() => broker.program({ ...job, documentCreation: { ...marker, rpcHash: "f".repeat(64) } }), unproven);
  broker.prune(() => ({ state: "succeeded" }));
  assert.throws(() => broker.program(job), unproven);
});
test("the actual newDocument program allocates exactly one fresh unsaved identity and treats the name as data", async () => {
  const f = fixture(), program = await compileDocumentCreation(f.request, f.ports);
  const result = spawnSync("python3", ["-I", "-B", "-c", `
import sys,json,types,contextlib,io
script=json.load(sys.stdin)["script"]
calls=[]
class NewDocument:
    name="Untitled"
    creationId="fresh-owned-from-sdk"
    isSaved=False
    isModified=False
    def __getattr__(self,key):
        raise AssertionError("Unexpected resource access: "+key)
class Documents:
    def add(self,kind):
        assert kind==42
        calls.append(kind)
        return NewDocument()
app=types.SimpleNamespace(documents=Documents())
core=types.ModuleType("adsk.core")
core.DocumentTypes=types.SimpleNamespace(FusionDesignDocumentType=42)
core.Application=types.SimpleNamespace(get=lambda:app)
adsk=types.ModuleType("adsk");adsk.core=core
sys.modules["adsk"]=adsk;sys.modules["adsk.core"]=core
namespace={};out=io.StringIO()
with contextlib.redirect_stdout(out):
    exec(script,namespace)
    namespace["run"]("")
assert calls==[42]
identity=json.loads(out.getvalue().splitlines()[-1])
assert identity["creationId"]=="fresh-owned-from-sdk"
assert identity["fileId"] is None and identity["isSaved"] is False
print(json.dumps(identity))
`], { input: JSON.stringify({ script: program.expectedRpc.arguments.object.script }), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const identity = JSON.parse(result.stdout);
  assert.equal(identity.name, 'new "\nimport os');
  assert.equal(identity.schema, "fmcad-created-document-v1");
});

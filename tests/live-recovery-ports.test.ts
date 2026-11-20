import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  knownSettlement,
  ownedCleanupSource,
  object,
  parse,
  owned,
  broker,
  result,
  nativeState,
} from "./live-recovery-ports";
import type { Result } from "./live-recovery-ports";

function runMultiDocumentWithFailedCreate(
  failureMode: string,
  cleanupFailureIndex?: number,
) {
  const root = mkdtempSync(path.join(os.tmpdir(), "fmcad-multidocument-sdk0-")),
    runtime = path.join(root, "runtime"),
    runtimeSource = path.join(runtime, "src"),
    runRoot = path.join(root, "run"),
    stateFile = path.join(root, "queue-state.json"),
    runId = "11111111-2222-4333-8444-555555555555";
  mkdirSync(runtimeSource, { recursive: true });
  writeFileSync(
    path.join(runtimeSource, "config.js"),
    "exports.loadConfig = () => ({cfg:{backend:'mcp',queue:{}}});\n",
  );
  writeFileSync(
    path.join(runtimeSource, "queue-instance.js"),
    "exports.buildHash = () => 'sdk0-build'; exports.processBirth = () => 'sdk0-birth';\n",
  );
  writeFileSync(stateFile, JSON.stringify({ closeTargets: [] }));
  writeFileSync(
    path.join(runtimeSource, "queue-client.js"),
    `const fs = require("node:fs");
const path = require("node:path");
const stateFile = process.env.FAKE_QUEUE_STATE;
const readState = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
const writeState = (value) => fs.writeFileSync(stateFile, JSON.stringify(value));
class QueueClient {
  constructor(clientId) { this.auth = {clientId}; this.jobs = new Map(); }
  async register() { return {}; }
  async call(action) {
    if (action === "queue-summary") return {buildHash:"sdk0-build", admissionScope:"normal-multidocument", blocked:null, held:null, control:{unresolved:false, activeOperations:0}};
    if (action === "control-status") return {activeOperations:0};
    throw new Error("Unexpected queue action: " + action);
  }
  async submit(input) {
    const requestId = input.requestId;
    const match = requestId.match(/:(\\d+):([^:]+)$/);
    const index = Number(match[1]);
    const phase = match[2];
    const source = fs.readFileSync(input.argv[1], "utf8");
    const id = phase + "-" + index;
    const clientId = this.auth.clientId;
    const job = {id, requestId, clientId, state:"preparing"};
    let terminalJob = {...job, state:"succeeded"};
    let stdout = "";
    let stderr = "";
    let execution = {sdkSettled:true, mayHaveMutated:true};
    if (phase === "baseline") {
      stdout = "FMCAD_RESULT " + JSON.stringify({active:null, documents:[]}) + "\\n";
      execution = {sdkSettled:true, mayHaveMutated:false};
    } else if (phase === "create" && index === 1) {
      terminalJob = {...job, state:"failed", code:"LOCAL_EXECUTION_FAILED"};
      execution = {sdkSettled:true, mayHaveMutated:process.env.FAKE_CREATE_FAILURE_MODE !== "proven-no-mutation"};
      if (process.env.FAKE_CREATE_FAILURE_MODE === "foreign-receipt") {
        execution = {sdkSettled:true, mayHaveMutated:false};
        terminalJob = {...terminalJob, requestId:requestId + ":foreign"};
      }
      stderr = "original create failure";
    } else if (phase === "create") {
      const nameLine = source.match(/^\\s*d\\.name=(.+)$/m);
      const name = JSON.parse(nameLine[1]);
      stdout = "FMCAD_RESULT " + JSON.stringify({name, creationId:"owned-" + index, saved:false}) + "\\n";
    } else if (phase === "failure-close") {
      const idMatch = source.match(/creationId==(["'][^"']+["'])/);
      if (!idMatch) throw new Error("Close source has no exact creation ID");
      const docId = JSON.parse(idMatch[1]);
      const state = readState();
      state.closeTargets.push({index, creationId:docId});
      writeState(state);
      stdout = "FMCAD_RESULT " + JSON.stringify({closed:true, creationId:docId, alreadyAbsent:false, active:null}) + "\\n";
      if (index === Number(process.env.FAKE_CLEANUP_FAILURE_INDEX)) {
        terminalJob = {...job, state:"failed", code:"LOCAL_EXECUTION_FAILED"};
        execution = {sdkSettled:true, mayHaveMutated:false};
        stderr = "original cleanup failure";
        stdout = "";
      }
    } else {
      throw new Error("Unexpected test phase: " + phase);
    }
    this.jobs.set(id, {job:terminalJob, stdout, stderr, execution});
    return job;
  }
  async wait(id) { return this.jobs.get(id); }
  dispose() {}
}
exports.QueueClient = QueueClient;
exports.inputFiles = () => [];\n`,
  );
  const env = { ...process.env };
  env["FMCAD_LIVE_RUNTIME"] = runtime;
  env["FMCAD_MULTIDOC_RUN_ROOT"] = runRoot;
  env["FMCAD_MULTIDOC_OWNER_COUNT"] = "10";
  env["FMCAD_MULTIDOC_RUN_ID"] = runId;
  env["FAKE_QUEUE_STATE"] = stateFile;
  env["FAKE_CREATE_FAILURE_MODE"] = failureMode;
  env["FAKE_CLEANUP_FAILURE_INDEX"] = String(cleanupFailureIndex ?? -1);
  delete env["FMCAD_MULTIDOC_GROUP_FILE"];
  delete env["FMCAD_MULTIDOC_RESUME_REPORT"];
  try {
    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, "live-normal-multidocument.js"), "--run"],
      { cwd: root, env, encoding: "utf8" },
    );
    return {
      exitCode: result.status,
      report: JSON.parse(
        readFileSync(path.join(runRoot, "report.json"), "utf8"),
      ) as Record<string, unknown>,
      queueState: JSON.parse(readFileSync(stateFile, "utf8")) as {
        closeTargets: { index: number; creationId: string }[];
      },
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("retained recovery parsers reject malformed JSON and preserve original identities", () => {
  for (const value of [null, [], "object", 4])
    assert.throws(() => object(value));
  assert.throws(() => parse("{"));
  assert.throws(() => parse("[]"));
  assert.deepEqual(
    owned({ name: "owned", creationId: "creation", previous: null }),
    { name: "owned", creationId: "creation", previous: null },
  );
  assert.deepEqual(
    owned({ name: "owned", creationId: "creation", previous: "original" }),
    { name: "owned", creationId: "creation", previous: "original" },
  );
  for (const invalid of [
    { name: 3, creationId: "id" },
    { name: "owned", creationId: null },
  ])
    assert.throws(() => owned(invalid));
  assert.deepEqual(
    broker({ buildHash: "build", admissionScope: "normal-multidocument" }),
    { buildHash: "build", admissionScope: "normal-multidocument" },
  );
  for (const invalid of [
    { buildHash: null, admissionScope: "normal" },
    { buildHash: "build", admissionScope: 3 },
  ])
    assert.throws(() => broker(invalid));
  const original = {
    job: {
      id: "job",
      requestId: "original",
      clientId: "owner",
      state: "failed",
    },
    stdout: "original stdout",
    execution: { sdkSettled: true, mayHaveMutated: false },
  };
  assert.equal(result(original), original);
  for (const field of ["id", "requestId", "clientId", "state"])
    assert.throws(() =>
      result({ ...original, job: { ...original.job, [field]: undefined } }),
    );
  assert.throws(() => result({ ...original, stdout: null }));
  assert.throws(() => result({ ...original, execution: [] }));
});

test("native response recovery uses terminal queue wait for its accepted mutation", () => {
  const source = readFileSync(
    path.resolve(__dirname, "../../tests/live-response-recovery.ts"),
    "utf8",
  );
  assert.match(
    source,
    /observer\.wait\(mutationJob\.id,\s*\{\s*signal:\s*AbortSignal\.timeout\(settlementTimeoutMs\)/u,
  );
  assert.doesNotMatch(source, /Date\.now\(\)\s*\+\s*300000/u);
  assert.match(source, /if\s*\(!settled\)\s*report\.cleanupDeferredReason/u);
});

test("retained document inventory parser preserves active identity and rejects malformed rows", () => {
  const original = {
    active: "owned",
    documents: [{ id: "owned", name: "fixture", saved: false, modified: true }],
  };
  assert.equal(nativeState(original), original);
  assert.deepEqual(nativeState({ active: null, documents: [] }), {
    active: null,
    documents: [],
  });
  assert.throws(() => nativeState({ ...original, active: 4 }));
  assert.throws(() => nativeState({ ...original, documents: {} }));
  for (const [field, value] of [
    ["id", 3],
    ["name", null],
    ["saved", "false"],
    ["modified", 0],
  ] as const)
    assert.throws(() =>
      nativeState({
        ...original,
        documents: [{ ...original.documents[0], [field]: value }],
      }),
    );
});

test("cleanup evidence rejects missing, nonterminal and unsettled work", () => {
  const evidence = (state: string, sdkSettled: boolean): Result => ({
    job: { id: "original", requestId: "stable", clientId: "owner", state },
    stdout: "",
    execution: { sdkSettled },
  });
  assert.equal(knownSettlement([]), false);
  assert.equal(knownSettlement([undefined]), false);
  for (const state of ["preparing", "running", "needs_reconciliation"])
    assert.equal(knownSettlement([evidence(state, true)]), false);
  assert.equal(knownSettlement([evidence("succeeded", false)]), false);
  const unknownOriginal = {
    job: {
      id: "original",
      requestId: "stable",
      clientId: "owner",
      state: "needs_reconciliation",
    },
    stdout: "",
    stderr: "SDK outcome requires reconciliation",
  };
  assert.equal(knownSettlement([unknownOriginal]), false);
  assert.equal(
    knownSettlement([
      {
        ...unknownOriginal,
        job: { ...unknownOriginal.job, state: "succeeded" },
      },
    ]),
    false,
  );
  for (const malformed of [
    null,
    false,
    {},
    { job: null },
    { job: { state: "succeeded" }, execution: null },
  ])
    assert.equal(knownSettlement([malformed]), false);
  assert.equal(
    knownSettlement([evidence("failed", true), evidence("succeeded", true)]),
    true,
  );
});

test("owned cleanup Python is exact-ID/name/unsaved guarded and handles null restore without Python null", () => {
  for (const restore of [null, 'previous "quoted" document']) {
    const code = ownedCleanupSource(
      { name: "Owned", creationId: "own-new-id" },
      restore,
      "FMCAD_RESULT ",
    );
    const compiled = spawnSync(
      "python3",
      ["-c", "import ast,sys; ast.parse(sys.stdin.read()); print('COMPILED')"],
      { input: code, encoding: "utf8" },
    );
    assert.equal(compiled.status, 0, compiled.stderr);
    assert.match(code, /creationId=="own-new-id"/);
    assert.match(code, /d\.name=="Owned" and not d\.isSaved/);
    assert.match(code, /assert d\.close\(False\)/);
    assert.doesNotMatch(code, /==null|\.deleteMe\(|\.save\(/);
  }
});

test("owned close restores the original active document in its own SDK turn and receipt", () => {
  const code = ownedCleanupSource(
    { name: "Owned", creationId: "owned" },
    "original",
    "FMCAD_RESULT ",
  );
  const fake = `import json,types
class Doc:
    def __init__(self,id,name): self.creationId=id; self.name=name; self.isSaved=False
    def close(self,save):
        assert not save
        app.documents.remove(self)
        app.activeDocument=peer
        return True
    def activate(self):
        app.activeDocument=self
        return True
owned_doc=Doc('owned','Owned')
original=Doc('original','Original')
peer=Doc('peer','Peer')
app=types.SimpleNamespace(documents=[owned_doc,original,peer],activeDocument=owned_doc)
adsk=types.SimpleNamespace(core=types.SimpleNamespace(Application=types.SimpleNamespace(get=lambda:app)))
`;
  const result = spawnSync("python3", ["-c", fake + code], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    JSON.parse(result.stdout.trim().slice("FMCAD_RESULT ".length)),
    {
      closed: true,
      creationId: "owned",
      alreadyAbsent: false,
      active: "original",
    },
  );
});

test("partial create failure cleans every proven-owned document after a null slot", () => {
  const { exitCode, report, queueState } =
    runMultiDocumentWithFailedCreate("proven-no-mutation");
  const documents = report["documents"] as (Record<string, unknown> | null)[],
    cleanup = report["failureCleanup"] as Record<string, unknown>[];
  const expected = Array.from(
    { length: 9 },
    (_, index) => "owned-" + (index === 0 ? 0 : index + 1),
  );
  assert.equal(exitCode, 1);
  assert.equal(report["status"], "failed");
  assert.match(String(report["error"]), /LOCAL_EXECUTION_FAILED/u);
  assert.equal(documents[1], null);
  assert.deepEqual(
    cleanup.map((receipt) => receipt["creationId"]),
    expected,
  );
  assert.deepEqual(
    queueState.closeTargets.map((target) => target.creationId),
    expected,
  );
  assert.equal(
    new Set(queueState.closeTargets.map((target) => target.creationId)).size,
    9,
  );
});

test("uncertain or foreign failed-create receipts defer cleanup without closing known documents", () => {
  for (const mode of ["may-have-mutated", "foreign-receipt"]) {
    const { exitCode, report, queueState } =
      runMultiDocumentWithFailedCreate(mode);
    assert.equal(exitCode, 1);
    assert.equal(report["status"], "failed");
    assert.ok(String(report["error"]).length > 0);
    if (mode === "foreign-receipt")
      assert.match(String(report["error"]), /identity or settlement differs/u);
    else assert.match(String(report["error"]), /LOCAL_EXECUTION_FAILED/u);
    assert.match(String(report["cleanupDeferredReason"]), /Create slot/u);
    assert.deepEqual(queueState.closeTargets, []);
  }
});

test("cleanup errors are reported while remaining known-owned documents are attempted", () => {
  const { exitCode, report, queueState } = runMultiDocumentWithFailedCreate(
    "proven-no-mutation",
    2,
  );
  const cleanupErrors = report["failureCleanupErrors"] as {
    creationId: string;
    message: string;
  }[];
  assert.equal(exitCode, 1);
  assert.equal(report["status"], "failed");
  assert.match(String(report["error"]), /LOCAL_EXECUTION_FAILED/u);
  assert.deepEqual(
    queueState.closeTargets.map((target) => target.creationId),
    [
      "owned-0",
      "owned-2",
      "owned-3",
      "owned-4",
      "owned-5",
      "owned-6",
      "owned-7",
      "owned-8",
      "owned-9",
    ],
  );
  assert.equal(cleanupErrors.length, 1);
  assert.equal(cleanupErrors[0]?.creationId, "owned-2");
  assert.match(cleanupErrors[0]?.message ?? "", /original cleanup failure/u);
});

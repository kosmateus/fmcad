import type { RecoveryWireTestApi } from "./saved-fixture-test-support";
import { record } from "./integration/offline-cli";
import { createRequire } from "node:module";
import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "package.json"));
const { prepareReceiptScript } = load("./src/queue-instance") as ReturnType<
  typeof import("../packages/node-adapters/src/execution/queue-instance").createQueueInstance
>;

for (const mode of [
  "valid",
  "foreign-file",
  "foreign-project",
  "foreign-folder",
  "version-drift",
  "unsaved",
  "incomplete",
  "linked",
  "missing",
  "duplicate",
  "renamed",
  "invalid",
  "wrong-purpose",
  "mixed-scopes",
])
  test("FAKE SDK: separate saved fixture guard before body: " + mode, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "saved-document-guard-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const body = path.join(dir, "body-ran"),
      receipt = path.join(dir, "receipt.json");
    const expected = {
      name: "OWNED_NEW_FILE",
      creationId: "owned-creation",
      fileId: "new-file",
      projectId: "native-project",
      folderId: "new-folder",
      version: 1,
    };
    const binding: Record<string, unknown> = {
      jobId: "fake-job",
      rpcId: "fake-rpc",
      buildHash: "fake-build",
      purpose:
        mode === "wrong-purpose"
          ? "general-modeling"
          : "saved-fixture-modeling-v1",
      auditExpectedSavedDocument: expected,
    };
    if (mode === "mixed-scopes")
      binding["auditExpectedDocument"] = {
        name: expected.name,
        creationId: expected.creationId,
        fileId: null,
      };
    const prepared = prepareReceiptScript(
      `with open(${JSON.stringify(body)}, 'w') as stream:\n    stream.write('ran')\n`,
      false,
      receipt,
      binding,
      { mapPath: (value) => value },
    );
    const bootstrap =
      `import sys, types\n` +
      `core=types.ModuleType('adsk.core'); adsk=types.ModuleType('adsk'); adsk.core=core\n` +
      `class NativeFile(types.SimpleNamespace):\n    @property\n    def parentProject(self):\n        raise RuntimeError('DataFile.parentProject InternalValidationError')\n` +
      `file=NativeFile(id=${JSON.stringify(mode === "foreign-file" ? "foreign" : expected.fileId)},` +
      `parentFolder=types.SimpleNamespace(id=${JSON.stringify(mode === "foreign-folder" ? "foreign" : expected.folderId)},` +
      `parentProject=types.SimpleNamespace(id=${JSON.stringify(mode === "foreign-project" ? "foreign" : expected.projectId)})),` +
      `versionNumber=${mode === "version-drift" ? 2 : 1},isComplete=${mode === "incomplete" ? "False" : "True"})\n` +
      `doc=types.SimpleNamespace(name=${JSON.stringify(mode === "renamed" ? "RENAMED" : expected.name)},creationId='owned-creation',` +
      `isValid=${mode === "invalid" ? "False" : "True"},isSaved=${mode === "unsaved" ? "False" : "True"},` +
      `dataFile=${mode === "unsaved" ? "None" : "file"},allDocumentReferences=types.SimpleNamespace(count=${mode === "linked" ? 1 : 0}))\n` +
      `rows=${mode === "missing" ? "[]" : mode === "duplicate" ? "[doc,doc]" : "[doc]"}\n` +
      `app=types.SimpleNamespace(version='fake',userInterface=types.SimpleNamespace(activeCommand='SelectCommand'),` +
      `documents=types.SimpleNamespace(count=len(rows),item=lambda i:rows[i]))\n` +
      `core.Application=types.SimpleNamespace(get=lambda:app); sys.modules.update({'adsk':adsk,'adsk.core':core})\n` +
      prepared.script;
    const result = spawnSync("python3", ["-B", "-c", bootstrap], {
      encoding: "utf8",
    });
    const receiptRecord = record(JSON.parse(fs.readFileSync(receipt, "utf8")));
    assert.equal(receiptRecord["terminal"], true);
    assert.equal(fs.existsSync(body), mode === "valid");
    assert.equal(
      receiptRecord["outcome"],
      mode === "valid" ? "succeeded" : "failed",
    );
    if (mode === "valid") assert.equal(result.status, 0, result.stderr);
    else assert.notEqual(result.status, 0);
  });

test(
  "production checker qualifies the separate saved guard with exact file/project/folder/version and SDK0",
  {},
  async (t) => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "saved-document-admission-"),
    );
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const api = load("./src/queue-instance") as ReturnType<
        typeof import("../packages/node-adapters/src/execution/queue-instance").createQueueInstance
      >,
      wire = load("./src/queue-atomic-recovery-audit") as RecoveryWireTestApi;
    const document = {
      name: "OFFLINE_SAVED",
      creationId: "owned-new",
      fileId: "new-file",
      projectId: "native-project",
      folderId: "owned-folder",
      version: 1,
    };
    const instance = {
      pid: process.pid,
      birth: api.processBirth(),
      version: "offline-fixture",
    };
    const artifact = (
      load("./src/cad") as typeof import("../src/composition/cad")
    ).prepareCadScript(
      "document.status",
      {},
      {
        doc: document.name,
        docId: document.creationId,
        docFileId: document.fileId,
        projectId: document.projectId,
      },
    );
    const prepared = wire.prepareRecoveryAuditWire({
      reader: { artifact },
      receipt: path.join(dir, "never-sent.json"),
      instance,
      buildHash: api.buildHash(),
      jobId: "offline-saved-only",
      auditBinding: {
        purpose: "saved-fixture-modeling-v1",
        currentInstance: instance,
        expectedSavedDocument: document,
      },
      payload: {
        jsonrpc: "2.0",
        id: "offline",
        method: "tools/call",
        params: {
          name: "execute_python",
          arguments: {
            code: artifact.script + '\n\nrun("")\n',
            persistent: false,
          },
        },
      },
    });
    const runtime = (
      load(
        "./src/dist/config-platform",
      ) as typeof import("../packages/node-adapters/src/config-platform")
    ).resolveRuntimePaths({ anchor: __filename }).runtime;
    const certificate = await (
      load("./src/queue-admission") as typeof import("../src/queue-admission")
    )
      .createProductionQueueAdmission(runtime)
      .admission.check(prepared.outgoing, prepared.artifact);
    assert.ok(certificate.report);
    assert.equal(certificate.report.status, "passed");
    assert.deepEqual(
      prepared.record.binding["auditExpectedSavedDocument"],
      document,
    );
    assert.equal(prepared.record.binding["auditExpectedDocument"], undefined);
    certificate.fence(prepared.outgoing);
    const changed = structuredClone(prepared.outgoing);
    assert.ok(
      changed.params?.arguments &&
        typeof changed.params.arguments.code === "string",
    );
    changed.params.arguments.code += "\n# changed";
    assert.throws(() => certificate.fence(changed));
    assert.equal(fs.existsSync(path.join(dir, "never-sent.json")), false);
  },
);

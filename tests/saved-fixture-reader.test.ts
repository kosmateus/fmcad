import type { RecoveryWireTestApi } from "./saved-fixture-test-support";
import { createRequire } from "node:module";
import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
// Only these synthetic physical/checker fixtures emulate WSL path spelling.
const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "package.json"));
test.beforeEach((t) => {
  assert.ok("after" in t);
  t.after(
    (load("./tests/fixtures/fake-wsl-platform.cjs") as () => () => void)(),
  );
});
const api = load("./src/queue-instance") as ReturnType<
  typeof import("../packages/node-adapters/src/execution/queue-instance").createQueueInstance
>;
const { prepareSavedFixtureReader, parseSavedFixtureReader } = load(
  "./src/queue-saved-fixture-reader",
) as typeof import("../packages/node-adapters/src/persistence/saved-fixture-reader") &
  typeof import("../packages/core/src/application/cad/saved-fixture-proof");
const canonicalHash = (value: unknown) =>
  (
    load(
      "./src/dist/core/application/cad/json",
    ) as typeof import("../packages/core/src/application/cad/json")
  ).hash(value);

test("FAKE SDK saved publication and retained-file close refuse unsafe states without save/delete", () => {
  const result = spawnSync(
    "python3",
    ["-B", path.join(root, "tests/saved_fixture_test.py")],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || String(result.error));
});

for (const purpose of [
  "saved-fixture-destination-v1",
  "saved-first-save-publication-v1",
  "saved-fixture-retain-v1",
])
  test(
    "production checker qualifies fixed saved fixture administrative source, SDK0: " +
      purpose,
    {},
    async (t) => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "saved-fixture-reader-"),
      );
      t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
      const epochId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
      const document = {
        name: "FMCAD_ISOLATED_" + epochId,
        creationId: "owned-new",
        fileId: null,
      };
      const binding = {
        purpose,
        epochId,
        document,
        currentInstance: {
          pid: process.pid,
          birth: api.processBirth(),
          version: "offline-fixture",
        },
        sdkProofPath: path.join(
          directory,
          purpose.includes("retain")
            ? "sdk-retained.json"
            : purpose.includes("destination")
              ? "sdk-destination.json"
              : "sdk-publication.json",
        ),
        destination: {
          projectId: "native-project",
          projectName: "APPROVED",
          folderName: "APPROVED_NEW_FOLDER",
          folderId: "approved-folder",
        },
        expectedFileId: "new-file",
        savedDocument: {
          name: document.name,
          creationId: document.creationId,
          fileId: "new-file",
          projectId: "native-project",
          folderId: "approved-folder",
          version: 1,
        },
        restoreActiveCreationId: "user-restore",
      };
      const installation = root;
      const reader = prepareSavedFixtureReader(installation, {}, binding, {
        directory,
      });
      const prepared = (
        load("./src/queue-atomic-recovery-audit") as RecoveryWireTestApi
      ).prepareRecoveryAuditWire({
        reader,
        receipt: path.join(directory, "never-sent.json"),
        instance: binding.currentInstance,
        buildHash: api.buildHash(),
        jobId: "offline-saved-administrative",
        auditBinding: binding,
        payload: {
          jsonrpc: "2.0",
          id: "offline",
          method: "tools/call",
          params: {
            name: "execute_python",
            arguments: {
              code: reader.artifact.script + '\n\nrun("")\n',
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
      certificate.fence(prepared.outgoing);
      assert.equal(
        fs.existsSync(path.join(directory, "never-sent.json")),
        false,
      );
      assert.equal(fs.existsSync(binding.sdkProofPath), false);
    },
  );

test("saved reader parser rejects wrong binding, restore identity and extra success fields", () => {
  const binding = {
    purpose: "saved-fixture-retain-v1",
    epochId: "owned-epoch",
    document: { name: "OWNED", creationId: "new-id", fileId: null },
    savedDocument: { fileId: "new-file" },
    restoreActiveCreationId: "original-active",
  };
  const result = {
    version: 1,
    purpose: binding.purpose,
    epochId: binding.epochId,
    document: binding.document,
    savedDocument: binding.savedDocument,
    bindingHash: canonicalHash(binding),
    closed: true,
    saved: true,
    retained: true,
    activeBeforeCloseCreationId: "new-id",
    restoredActiveCreationId: "original-active",
    activeDocumentRestored: true,
  };
  const reply = (value: unknown) => ({
    result: {
      content: [
        { type: "text", text: "FMCAD_RESULT " + JSON.stringify(value) },
      ],
    },
  });
  assert.deepEqual(parseSavedFixtureReader(reply(result), {}, binding), result);
  for (const changes of [
    { bindingHash: "changed" },
    { restoredActiveCreationId: "foreign" },
    { nativeQualified: true },
  ])
    assert.throws(
      () =>
        parseSavedFixtureReader(reply({ ...result, ...changes }), {}, binding),
      { code: "SAVED_FIXTURE_PROOF_INVALID" },
    );
});

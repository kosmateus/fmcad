import type { RecoveryWireTestApi } from "./saved-fixture-test-support";
import { createRequire } from "node:module";
import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
// Only these synthetic physical/checker fixtures emulate WSL path spelling.
const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "package.json"));
test.beforeEach((t) => {
  assert.ok("after" in t);
  t.after(
    (load("./tests/fixtures/fake-wsl-platform.cjs") as () => () => void)(),
  );
});
const { prepareScratchQualification } = load(
  "./src/queue-scratch-qualification",
) as typeof import("../src/queue-scratch-qualification");
const { prepareRecoveryAuditWire } = load(
  "./src/queue-atomic-recovery-audit",
) as RecoveryWireTestApi;
const { createProductionQueueAdmission } = load(
  "./src/queue-admission",
) as typeof import("../src/queue-admission");
const { resolveRuntimePaths } = load(
  "./src/dist/config-platform",
) as typeof import("../packages/node-adapters/src/config-platform");
const { buildHash } = load("./src/queue-instance") as ReturnType<
  typeof import("../packages/node-adapters/src/execution/queue-instance").createQueueInstance
>;

for (const purpose of [
  "isolated-scratch-epoch-v1",
  "isolated-scratch-close-v1",
]) {
  test(
    "real checker validates complete final-byte origin for " + purpose,
    {},
    async (t) => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "scratch-final-wire-"),
      );
      t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
      const epochId = randomUUID();
      const binding = {
        purpose,
        epochId,
        currentInstance: { pid: 123, birth: "expected", version: "2706" },
        forbiddenIds: ["historical-closed"],
        document: {
          name: "FMCAD_ISOLATED_" + epochId,
          creationId: "new-sdk-id",
          fileId: null,
        },
        sdkProofPath: path.join(
          directory,
          purpose.includes("close") ? "sdk-closed.json" : "sdk-qualified.json",
        ),
      };
      const reader = prepareScratchQualification(root, {}, binding, {
        directory,
      });
      const prepared = prepareRecoveryAuditWire({
        reader,
        receipt: path.join(directory, "remote.json"),
        instance: binding.currentInstance,
        buildHash: buildHash(),
        jobId: "historical-holder",
        auditBinding: binding,
        payload: {
          jsonrpc: "2.0",
          id: "caller",
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
      const production = createProductionQueueAdmission(
        resolveRuntimePaths({ anchor: __filename }).runtime,
      );
      const certificate = await production.admission.check(
        prepared.outgoing,
        prepared.artifact,
      );
      assert.ok(certificate.report);
      assert.equal(
        certificate.report.status,
        "passed",
        JSON.stringify(certificate.report),
      );
      assert.equal(certificate.report.provenance.checker, "basedpyright");
      assert.equal(prepared.record.binding["purpose"], purpose);
      assert.deepEqual(
        prepared.record.binding["auditExpectedInstance"],
        binding.currentInstance,
      );
      certificate.fence(prepared.outgoing);
      assert.ok(
        prepared.outgoing.params?.arguments &&
          typeof prepared.outgoing.params.arguments.code === "string",
      );
      prepared.outgoing.params.arguments.code += "\n# unexpected bytes";
      assert.throws(() => certificate.fence(prepared.outgoing));
    },
  );
}

test("legacy capability and forged CLI payload options cannot request scratch authority", async () => {
  const { scratchEpochAction } = load(
    "./src/queue-scratch-control",
  ) as typeof import("../src/queue-scratch-control");
  const calls: string[] = [];
  await assert.rejects(
    scratchEpochAction(
      {
        async call(action) {
          calls.push(action);
          return { features: {} };
        },
      },
      "create-isolated-scratch",
      {},
      "new-build",
    ),
    { code: "EPOCH_UNSUPPORTED" },
  );
  assert.deepEqual(calls, ["queue-summary"]);
  for (const command of ["create-isolated-scratch", "close-isolated-scratch"]) {
    for (const extra of [
      ["--client", "foreign"],
      ["--doc-id", "old"],
      ["--accept-outcome", "aborted"],
      ["--", "run"],
    ])
      await assert.rejects(
        (
          load(
            "./src/queue-cli",
          ) as typeof import("../src/entrypoints/queue-cli")
        ).queueCommand(
          [
            command,
            "--job",
            "target",
            "--observation-job",
            "prior",
            "--request-id",
            "one-scratch",
            ...extra,
          ],
          {
            stdout: process.stdout,
            stderr: process.stderr,
            loadConfig() {
              assert.fail("Bad flags cannot read credentials/config");
            },
          },
        ),
      );
  }
});

const operations: [string, Record<string, unknown>][] = [
  ["sketch.create", { name: "EpochSection", plane: "XY" }],
  [
    "sketch.geometry",
    {
      sketch: "EpochSection",
      geometry: [
        {
          type: "rectangle",
          start: ["0 mm", "0 mm", "0 mm"],
          end: ["10 mm", "6 mm", "0 mm"],
        },
      ],
    },
  ],
  [
    "model.extrude",
    {
      name: "EpochSolid",
      profile: { kind: "profile", sketch: "EpochSection", index: 0 },
      distance: "4 mm",
      operation: "newBody",
    },
  ],
  ["entity.list", { kind: "body" }],
];
for (const [operation, data] of operations)
  test(
    "minimal MCP path has real final-byte production admission: " + operation,
    {},
    async (t) => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "epoch-modeling-wire-"),
      );
      t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
      const epochId = randomUUID(),
        document = {
          name: "FMCAD_ISOLATED_" + epochId,
          creationId: "proven-new-doc",
        };
      const artifact = (
        load("./src/cad") as typeof import("../src/composition/cad")
      ).prepareCadScript(operation, data, {
        doc: document.name,
        docId: document.creationId,
      });
      const binding = {
        purpose: "isolated-epoch-modeling-v1",
        epochId,
        document,
        currentInstance: { pid: 123, birth: "expected", version: "2706" },
      };
      const prepared = prepareRecoveryAuditWire({
        reader: { artifact },
        receipt: path.join(directory, "remote.json"),
        instance: binding.currentInstance,
        buildHash: buildHash(),
        jobId: "new-scratch-job",
        auditBinding: binding,
        payload: {
          jsonrpc: "2.0",
          id: "caller",
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
      const production = createProductionQueueAdmission(
        resolveRuntimePaths({ anchor: __filename }).runtime,
      );
      const certificate = await production.admission.check(
        prepared.outgoing,
        prepared.artifact,
      );
      assert.ok(certificate.report);
      assert.equal(
        certificate.report.status,
        "passed",
        JSON.stringify(certificate.report),
      );
      assert.equal(certificate.report.provenance.checker, "basedpyright");
      certificate.fence(prepared.outgoing);
    },
  );

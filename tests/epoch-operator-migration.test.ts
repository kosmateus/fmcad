import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import ts from "typescript";
import type { EpochUpgradePorts } from "../packages/core/src/application/cad/epoch-upgrade";
const root = process.cwd();
const load = createRequire(path.join(root, "src/queue-instance.js"));
const schema = load(
  "./dist/node-adapters/execution/epoch-operator-evidence",
) as typeof import("../packages/node-adapters/src/execution/epoch-operator-evidence");
const reference = {
  path: "/private/original-evidence",
  sha256: "a".repeat(64),
};
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const original = fs.readFileSync(
  path.join(
    root,
    "tests/fixtures/history/upgrade-epoch-checker-dce47c5.cjs.txt",
  ),
);
const manifest: Array<{ file: string; sha256: string }> = JSON.parse(
  fs.readFileSync(
    path.join(root, "tests/fixtures/history/manifest.json"),
    "utf8",
  ),
);
assert.equal(
  hash(original),
  manifest.find((row) => row.file === "upgrade-epoch-checker-dce47c5.cjs.txt")
    ?.sha256,
);
const typed = ts.transpileModule(
  fs.readFileSync(path.join(root, "scripts/upgrade-epoch-checker.cts"), "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2023,
    },
  },
).outputText;
function snapshot() {
  return {
    state: { jobs: {}, paused: true, controlGeneration: 2, contextEpoch: 1 },
    pointer: {
      root: "/scratch",
      kind: "isolated-fresh-scratch-epoch",
      epochId: "epoch",
      ownerClientId: "owner",
      ownerTokenHash: "owner-hash",
      document: { fileId: null, creationId: "owned" },
      currentInstance: { pid: 8, birth: "boot:fusion" },
      originalInstance: { pid: 7, birth: "boot:historical" },
      historicalSnapshotHash: "history",
      historicalIdentityHash: "identity",
      qualificationEvidence: [reference],
      qualificationReceipt: reference,
    },
    identity: {
      buildHash: "previous",
      instance: { pid: 8, birth: "boot:fusion" },
    },
    owner: { pid: 4, birth: "boot:owner", nonce: "owner-nonce" },
    control: {
      activeOperations: 0,
      activeIds: [],
      instanceId: "owner-nonce",
      buildHash: "previous",
      generation: 2,
      contextEpoch: 1,
      gateClosed: true,
    },
    ownerTokenHash: "owner-hash",
    pointerHash: "pointer",
    rootStateHash: "history",
    rootIdentityHash: "identity",
    selectedLive: true,
    historicalDead: true,
    brokerLive: true,
    grantsHash: "grants",
    evidenceHash: "evidence",
  };
}
async function fixture(
  source: string,
  action: (
    ports: EpochUpgradePorts,
    f: {
      dir: string;
      audit: string;
      approval: ReturnType<typeof schema.operatorApproval>;
      writes: string[];
      calls: unknown[];
    },
  ) => Promise<void>,
  args?: string[],
) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "operator-parity-"));
  try {
    const candidate = path.join(directory, "candidate"),
      dir = path.join(directory, "queue");
    fs.mkdirSync(path.join(candidate, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(candidate, "src/queue-epoch-runtime-upgrade.js"),
      "",
    );
    fs.mkdirSync(dir);
    const approval = schema.operatorApproval({
      version: 1,
      purpose: "quiescent-settled-isolated-epoch-upgrade-v1",
      epochId: "epoch",
      clientId: "owner",
      document: { fileId: null, creationId: "owned" },
      currentInstance: { pid: 8, birth: "boot:fusion" },
      previousBuildHash: "b".repeat(64),
      pointerHash: "pointer",
      buildHash: "c".repeat(64),
      requestId: "original-upgrade",
      candidateRoot: candidate,
      installRoot: path.join(directory, "previous"),
      sourceCommit: "a".repeat(40),
      granteeClientId: "modeler",
      adapterSha256: "e".repeat(64),
      qualification: reference,
      previousQualifiedRuntime: path.join(directory, "previous"),
      ledgerReferences: [reference, reference],
      stateOptions: { idleMs: 60000, leaseMs: 600000 },
    });
    const approvalFile = path.join(directory, "approval.json");
    fs.writeFileSync(approvalFile, JSON.stringify(approval));
    const audit = path.join(
      dir,
      "epoch-runtime-upgrades",
      hash(approval.requestId),
    );
    const calls: unknown[] = [],
      writes: string[] = [];
    const readJson = (file: string): unknown =>
      JSON.parse(fs.readFileSync(file, "utf8"));
    const durable = (file: string, value: unknown, exclusive = false) => {
      writes.push(file);
      fs.writeFileSync(file, JSON.stringify(value), {
        flag: exclusive ? "wx" : "w",
      });
    };
    const publication = (file: string, value: unknown) => {
      if (fs.existsSync(file)) {
        assert.deepEqual(readJson(file), value);
        return;
      }
      durable(file, value, true);
    };
    class QueueClient {
      dir = dir;
      auth = { clientId: "owner", clientToken: "token" };
      async call(action: string, input?: unknown) {
        calls.push({ action, input });
        return {};
      }
      dispose() {
        calls.push("dispose");
      }
    }
    const create = (ports: EpochUpgradePorts) => async () => {
      await action(ports, { dir, audit, approval, writes, calls });
      return { handled: true };
    };
    const dependency = (id: string): unknown => {
      if (id === "node:module") return { createRequire: () => dependency };
      if (id === "node:crypto")
        return { randomUUID: () => "11111111-1111-1111-1111-111111111111" };
      if (id === "node:child_process")
        return {
          spawn(executable: string, argv: string[], options: unknown) {
            calls.push({ executable, argv, options });
            return {
              stdin: {
                on() {},
                end(value: string) {
                  calls.push({ input: JSON.parse(value) as unknown });
                },
              },
              once() {},
              unref() {},
            };
          },
        };
      if (id.endsWith("/src/queue-epoch-runtime-upgrade"))
        return {
          createEpochRuntimeUpgrade: create,
          createSettledEpochRuntimeUpgrade: create,
        };
      if (id.endsWith("/execution/epoch-operator-evidence")) return schema;
      if (id.endsWith("/src/queue-instance"))
        return {
          readJson,
          hash,
          durable,
          processBirth: () => "boot:worker",
          priorProcessAlive: () => false,
          buildHash: () => approval.buildHash,
        };
      if (id.endsWith("/src/queue-atomic-migration-files"))
        return {
          exclusive: publication,
          directory(file: string) {
            assert.equal(fs.statSync(file).isDirectory(), true);
          },
          fileHash(file: string) {
            return { sha256: hash(fs.readFileSync(file)) };
          },
        };
      if (id.endsWith("/src/config"))
        return { loadConfig: () => ({ cfg: {} }) };
      if (id.endsWith("/src/queue-client")) return { QueueClient };
      return load(id);
    };
    const file = path.join(candidate, "scripts/upgrade-epoch-checker.cjs"),
      module: { exports: { main?: () => Promise<void> } } = { exports: {} };
    const script =
      source.replace(/^#![^\n]*\n/, "") + "\nmodule.exports.main = main;";
    const run = vm.runInThisContext(
      "(function(exports,require,module,__filename,__dirname,process,console){\n" +
        script +
        "\n})",
    ) as (...args: unknown[]) => void;
    run(
      module.exports,
      dependency,
      module,
      file,
      path.dirname(file),
      {
        argv: [
          process.execPath,
          file,
          ...(args ?? [
            "--approval",
            approvalFile,
            "--confirm-ownership",
            "true",
          ]),
        ],
        env: {},
        pid: process.pid,
        execPath: process.execPath,
      },
      { log() {} },
    );
    assert.ok(module.exports.main);
    await module.exports.main();
    return {
      calls,
      writes: writes.map((file) => file.slice(directory.length)),
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
test("operational upgrade preserves argument refusals before effects", async () => {
  for (const args of [
    [],
    ["--unknown", "true"],
    ["--approval", "relative", "--confirm-ownership", "true"],
    ["--approval", "/absolute"],
  ]) {
    for (const source of [original.toString("utf8"), typed])
      await assert.rejects(
        fixture(
          source,
          async () => assert.fail("invalid input reached orchestration"),
          args,
        ),
        { code: "INVALID_REQUEST" },
      );
  }
});
test("operational upgrade retains launch intent and never repeats an uncertain child launch", async () => {
  for (const source of [original.toString("utf8"), typed]) {
    await fixture(source, async (ports, f) => {
      await ports.claim();
      await ports.start(f.approval);
      await assert.rejects(ports.start(f.approval), {
        code: "UPGRADE_START_UNKNOWN",
      });
      assert.equal(
        f.calls.filter(
          (value) =>
            typeof value === "object" &&
            value !== null &&
            "executable" in value,
        ).length,
        1,
      );
      assert.equal(
        f.writes.filter((file) => file.endsWith("worker-launch.json")).length,
        1,
      );
      assert.equal(
        JSON.parse(
          fs.readFileSync(path.join(f.audit, "worker-launch.json"), "utf8"),
        ).buildHash,
        f.approval.buildHash,
      );
    });
  }
});
test("operational upgrade resumes only identical identity publication and preserves foreign guards", async () => {
  for (const source of [original.toString("utf8"), typed]) {
    await fixture(source, async (ports, f) => {
      await ports.claim();
      const paused = snapshot();
      paused.pointer.root = path.join(f.dir, "epoch");
      fs.mkdirSync(paused.pointer.root);
      fs.writeFileSync(
        path.join(f.audit, "paused.json"),
        JSON.stringify(paused),
      );
      const file = path.join(paused.pointer.root, "instance.json");
      fs.writeFileSync(file, JSON.stringify(paused.identity));
      const next = { ...paused.identity, buildHash: "next" };
      await ports.writeEpochIdentity(paused.identity, next);
      const writes = f.writes.length;
      await ports.writeEpochIdentity(paused.identity, next);
      assert.equal(f.writes.length, writes);
      await assert.rejects(
        ports.writeEpochIdentity(paused.identity, {
          ...next,
          buildHash: "foreign",
        }),
        { code: "IDENTITY_CHANGED" },
      );
      const guard = path.join(f.dir, "recovery.lock"),
        foreign = { kind: "foreign", nonce: "foreign" };
      fs.writeFileSync(guard, JSON.stringify(foreign));
      await assert.rejects(ports.release(undefined), { code: "GUARD_CHANGED" });
      assert.deepEqual(JSON.parse(fs.readFileSync(guard, "utf8")), foreign);
    });
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import ts from "typescript";
import type { ScratchBinding } from "../src/queue-scratch-qualification";
import type { GrantPorts } from "../src/queue-native-fixture-grant";
type Scratch = typeof import("../src/queue-scratch-qualification");
type Fixture = typeof import("../src/queue-native-fixture-grant");
const root = process.cwd();
const requireRuntime = createRequire(path.join(root, "src/queue-instance.js"));
function modulePair<T>(
  name: string,
  overrides: Record<string, unknown> = {},
): [T, T] {
  const original = fs.readFileSync(
    path.join(root, "tests/fixtures/history", name + "-dce47c5.js.txt"),
  );
  const manifest: Array<{ file: string; sha256: string }> = JSON.parse(
    fs.readFileSync(
      path.join(root, "tests/fixtures/history/manifest.json"),
      "utf8",
    ),
  );
  assert.equal(
    createHash("sha256").update(original).digest("hex"),
    manifest.find((entry) => entry.file === name + "-dce47c5.js.txt")?.sha256,
  );
  const typed = ts.transpileModule(
    fs.readFileSync(path.join(root, "src", name + ".ts"), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2023,
      },
    },
  ).outputText;
  const load = (source: string): T => {
    const file = path.join(root, "src", name + ".js"),
      module = { exports: {} };
    const dependency = (id: string): unknown =>
      id === "node:module"
        ? { createRequire: () => dependency }
        : id in overrides
          ? overrides[id]
          : requireRuntime(id);
    const run = vm.runInThisContext(
      "(function(exports, require, module, __filename, __dirname) {\n" +
        source +
        "\n})",
    ) as (...args: unknown[]) => void;
    run(module.exports, dependency, module, file, path.dirname(file));
    return module.exports as T;
  };
  return [load(original.toString("utf8")), load(typed)];
}
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const canonical = requireRuntime("./dist/core/application/cad/json") as {
  hash(value: unknown): string;
};
const reply = (value: unknown) => ({
  result: {
    content: [{ type: "text", text: "FMCAD_RESULT " + JSON.stringify(value) }],
  },
});

test("scratch preparation retains complete historical artifact and closing/restoration bytes", (t) => {
  const restore = (
    requireRuntime(
      "../tests/fixtures/fake-wsl-platform.cjs",
    ) as () => () => void
  )();
  t.after(restore);
  const [before, after] = modulePair<Scratch>("queue-scratch-qualification");
  for (const close of [false, true]) {
    const directory = path.join(os.tmpdir(), "scratch-byte-parity");
    const binding: ScratchBinding = {
      purpose: close
        ? "isolated-scratch-close-v1"
        : "isolated-scratch-epoch-v1",
      epochId: "żółty-owner",
      sdkProofPath: path.join(
        directory,
        close ? "sdk-closed.json" : "sdk-qualified.json",
      ),
      forbiddenIds: ["foreign-doc"],
      document: { name: "owned", creationId: "owned-id", fileId: null },
      captureActiveDocument: true,
      restoreActiveCreationId: "original-active",
    };
    assert.deepEqual(
      after.prepareScratchQualification(root, {}, binding, { directory }),
      before.prepareScratchQualification(root, {}, binding, { directory }),
    );
    assert.throws(
      () =>
        after.prepareScratchQualification(
          root,
          {},
          { ...binding, sdkProofPath: path.join(directory, "foreign.json") },
          { directory },
        ),
      { code: "SCRATCH_QUALIFICATION_INVALID" },
    );
  }
});

test("scratch parsers preserve identity, historical unknown outcome and independent active-document restoration", () => {
  const pair = modulePair<Scratch>("queue-scratch-qualification");
  const binding: ScratchBinding = {
    purpose: "isolated-scratch-epoch-v1",
    epochId: "owned",
    sdkProofPath: "/owned/sdk-qualified.json",
    forbiddenIds: ["foreign"],
    captureActiveDocument: true,
  };
  const document = {
    name: "FMCAD_ISOLATED_owned",
    creationId: "new",
    fileId: null,
  };
  const qualified = {
    version: 1,
    purpose: binding.purpose,
    epochId: "owned",
    bindingHash: canonical.hash(binding),
    document,
    independent: true,
    empty: true,
    unsaved: true,
    activeCommand: "SelectCommand",
    beforeIdsHash: "a".repeat(64),
    historicalOutcome: "unknown",
    originalModelValidation: "not_performed",
    originalRollbackVerification: "not_performed",
    previousActiveCreationId: "original",
  };
  for (const api of pair) {
    assert.deepEqual(
      api.parseScratchQualification(reply(qualified), {}, binding),
      qualified,
    );
    for (const changed of [
      { ...qualified, document: { ...document, creationId: "foreign" } },
      { ...qualified, previousActiveCreationId: "new" },
      { ...qualified, historicalOutcome: "committed" },
      { ...qualified, independent: false },
      { ...qualified, extra: true },
    ])
      assert.throws(
        () => api.parseScratchQualification(reply(changed), {}, binding),
        { code: "SCRATCH_QUALIFICATION_INVALID" },
      );
    const closeBinding = {
      ...binding,
      purpose: "isolated-scratch-close-v1",
      document,
      restoreActiveCreationId: "original",
    };
    for (const before of ["new", "user-selected"]) {
      const closed = {
        version: 1,
        purpose: closeBinding.purpose,
        document,
        bindingHash: canonical.hash(closeBinding),
        closed: true,
        saved: false,
        historicalOutcome: "unknown",
        originalModelValidation: "not_performed",
        originalRollbackVerification: "not_performed",
        activeBeforeCloseCreationId: before,
        restoredActiveCreationId: before === "new" ? "original" : before,
        activeDocumentRestored: true,
      };
      assert.deepEqual(
        api.parseScratchClose(reply(closed), {}, closeBinding),
        closed,
      );
      assert.throws(
        () =>
          api.parseScratchClose(
            reply({ ...closed, restoredActiveCreationId: "foreign" }),
            {},
            closeBinding,
          ),
        { code: "SCRATCH_QUALIFICATION_INVALID" },
      );
    }
  }
});

test("native fixture grants retain exact contracts, immutable publication and receipt-only reobservation", (t) => {
  const [before, after] = modulePair<Fixture>("queue-native-fixture-grant");
  for (const fixtureId of [
    "regional-geometry-v1",
    "containment-program-v1",
    "data-import-program-v1",
  ])
    assert.deepEqual(
      after.fixtureContract(fixtureId),
      before.fixtureContract(fixtureId),
    );
  const runtime = requireRuntime("./queue-instance") as { buildHash(): string };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grant-migration-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const document = { name: "owned", creationId: "owned-id", fileId: null };
  const proof = {
    status: "complete",
    summary: { independent: true, empty: true, unsaved: true, document },
  };
  const proofPath = path.join(dir, "proof.json");
  fs.writeFileSync(proofPath, JSON.stringify(proof));
  const digest = createHash("sha256")
    .update(fs.readFileSync(proofPath))
    .digest("hex");
  fs.writeFileSync(
    path.join(dir, "instance.json"),
    JSON.stringify({
      buildHash: runtime.buildHash(),
      sourceCommit: "f".repeat(40),
    }),
  );
  const ports: GrantPorts = {
    dir,
    buildHash: runtime.buildHash(),
    state: {
      epoch: {
        root: dir,
        epochId: "epoch",
        kind: "isolated-fresh-scratch-epoch",
        ownerClientId: "owner",
        ownerTokenHash: "a".repeat(64),
        document,
        currentInstance: { pid: 1, birth: "fixture", version: "fixture" },
        originalInstance: { pid: 2, birth: "fixture", version: "fixture" },
        qualificationReceipt: { path: proofPath, sha256: digest },
      },
      assertEpoch() {},
      data: { jobs: {} },
    },
    clients: () => ({ owner: "a".repeat(64), modeler: "b".repeat(64) }),
    assertControl(value) {
      assert.deepEqual(value, { original: true });
    },
    fence() {},
  };
  const message = {
    action: "grant-native-fixture",
    epochId: "epoch",
    grantClientId: "modeler",
    fixtureId: "regional-geometry-v1",
    requestId: "one-original-request",
    control: { original: true },
  };
  const oldResult = before.grantNativeFixture(ports, message, "owner");
  const names = fs.readdirSync(dir).sort();
  const bytes = names.map((name) => fs.readFileSync(path.join(dir, name)));
  assert.deepEqual(
    after.grantNativeFixture(ports, message, "owner"),
    oldResult,
  );
  assert.deepEqual(fs.readdirSync(dir).sort(), names);
  assert.deepEqual(
    names.map((name) => fs.readFileSync(path.join(dir, name))),
    bytes,
  );
  for (const api of [before, after]) {
    assert.throws(() => api.grantNativeFixture(ports, message, "modeler"), {
      code: "NOT_OWNER",
    });
    assert.throws(
      () =>
        api.grantNativeFixture(
          ports,
          { ...message, fixtureId: "data-import-program-v1" },
          "owner",
        ),
      { code: "GRANT_SCOPE_CONFLICT" },
    );
  }
});

test("a matching missing build/source cannot authorize native fixture scope", () => {
  const [before, after] = modulePair<Fixture>("queue-native-fixture-grant");
  const contract = before.fixtureContract("regional-geometry-v1");
  const scope = { version: 1, ...contract };
  assert.deepEqual(
    before.validateFixtureGrant({ nativeFixture: scope }, {}),
    contract,
  );
  assert.throws(
    () => after.validateFixtureGrant({ nativeFixture: scope }, {}),
    { code: "NATIVE_FIXTURE_CHANGED" },
  );
  const identity = { buildHash: "a".repeat(64), sourceCommit: "b".repeat(40) };
  assert.deepEqual(
    after.validateFixtureGrant(
      { nativeFixture: { ...scope, ...identity } },
      identity,
    ),
    contract,
  );
});

test("native fixture CLI pins current generation and makes one grant call without replay", async () => {
  const pair = modulePair<Fixture>("queue-native-fixture-grant");
  const traces: unknown[][] = [];
  for (const api of pair) {
    const calls: unknown[] = [];
    const control = {
      buildHash: hash("build"),
      instanceId: "broker",
      generation: 7,
      contextEpoch: 2,
    };
    await assert.rejects(
      api.nativeFixtureAction(
        {
          async call(action: string, input?: unknown) {
            calls.push({ action, input });
            if (action === "queue-summary") return { control };
            throw new Error("lost original acknowledgement");
          },
        },
        { requestId: "original" },
        control.buildHash,
      ),
      /lost original acknowledgement/,
    );
    assert.equal(calls.length, 2);
    traces.push(calls);
  }
  assert.deepEqual(traces[1], traces[0]);
});

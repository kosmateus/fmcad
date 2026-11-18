import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import vm from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";
import {
  prepareNativeInvocation,
  observeNativeInvocation,
  readNativeInvocation,
  type JsonRecord,
} from "./live-import-receipts";
const root = process.cwd();
const load = createRequire(
  path.join(root, "tests/fixed-native-invocation.test.ts"),
);

/** Execute the actual retained function bytes; only the child process port is synthetic. */
function retainedFunction(filename: string, name: string): string {
  const source = fs.readFileSync(path.join(root, "tests", filename), "utf8");
  const parsed = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const declaration = parsed.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  assert.ok(declaration, name);
  return declaration.getText(parsed);
}

test("fixed GM07 and GM12 public operations retain canonical SDK/document contracts", () => {
  const { catalog } = load(
    "../src/cad",
  ) as typeof import("../src/composition/cad-execution");
  const { contracts } = load(
    "../src/catalog",
  ) as typeof import("../src/composition/library-catalog-registry");
  for (const operation of [
    "sketch.create",
    "sketch.inspect",
    "sketch.profile-file",
    "curve.fit",
    "curve.inspect",
    "curve.offset",
    "curve.offset-edit",
    "curve.helix",
    "shape.spring",
    "spring.evaluate",
    "spring.configure",
  ]) {
    assert.ok(catalog[operation], operation);
    const contract = contracts[operation];
    assert.ok(contract, operation);
    assert.equal(contract.service.kind, "python", operation);
    assert.equal(contract.requirements.sdk, "required", operation);
    assert.equal(contract.requirements.document, true, operation);
  }
});

test("GM07 strict contract carries its selected runtime into the durable invocation", (t) => {
  const runtimeRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "gm07-contract-binding-"),
  );
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const fixtureId = "gm07-curves-program-v1";
  const buildHash = "b".repeat(64);
  const expectedManifestSha256 =
    "aef99573a0ce45f852ea6883f0921e20056961a9d0b44bb8ced7654fd0707bb5";
  const expectedScriptSha256 =
    "aad7f113451db0784b16235de4d77cf7d8af024c3880338728154274616dbe16";
  const script = "assets/native-qualification/gm07-curves.py";
  const manifestPath = path.join(
    runtimeRoot,
    "dist/assets/native-qualification/gm07-curves-program.json",
  );
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  for (const file of ["gm07-curves-program.json", "gm07-curves.py"])
    fs.copyFileSync(
      path.join(root, "assets/native-qualification", file),
      path.join(path.dirname(manifestPath), file),
    );
  fs.mkdirSync(path.join(runtimeRoot, "dist/bin"));
  fs.writeFileSync(
    path.join(runtimeRoot, "dist/bin/fmcad.js"),
    "// offline fixture, never executed\n",
  );
  fs.writeFileSync(
    path.join(runtimeRoot, "dist/runtime-build.json"),
    JSON.stringify({ fingerprint: buildHash }),
  );
  const context = vm.createContext({
    assert,
    fs,
    path,
    crypto,
    fixtureId,
    expectedManifestSha256,
    expectedScriptSha256,
    require: (filename: string) => {
      if (filename === path.join(runtimeRoot, "dist/src/queue-instance.js"))
        return { buildHash: () => buildHash };
      assert.equal(
        filename,
        path.join(runtimeRoot, "dist/src/queue-native-fixture-grant.js"),
      );
      return {
        fixtureContract: () => ({
          fixtureId,
          kind: "fixed-run-v1",
          helperVersion: "cad-v1",
          script,
          manifestSha256: expectedManifestSha256,
          scriptSha256: expectedScriptSha256,
        }),
      };
    },
  });
  const qualify = vm.runInContext(
    "(" + retainedFunction("live-gm07.js", "fixedContract") + ")",
    context,
  ) as (
    runtime: string,
    build: string,
  ) => {
    runtimeRoot: string;
    buildHash: string;
    manifestSha256: string;
    scriptSha256: string;
    scriptPath: string;
    cliPath: string;
  };
  const pinned = qualify(runtimeRoot, buildHash);
  const requestId = "gm07-contract-binding";
  const document = {
    name: "FMCAD_GM07_offline",
    creationId: "12345678-1234-1234-1234-123456789abc",
  };
  const command = [
    pinned.cliPath,
    "run",
    pinned.scriptPath,
    "--doc",
    document.name,
    "--doc-id",
    document.creationId,
    "--request-id",
    requestId,
  ];
  const intent = prepareNativeInvocation(path.join(runtimeRoot, "intents"), {
    requestId,
    clientId: "gm07-offline",
    document,
    runtimeRoot: pinned.runtimeRoot,
    buildHash: pinned.buildHash,
    fixtureId,
    manifestSha256: pinned.manifestSha256,
    scriptSha256: pinned.scriptSha256,
    command,
  });
  assert.equal(
    readNativeInvocation(intent).binding.runtimeRoot,
    fs.realpathSync(runtimeRoot),
  );
  assert.throws(() => qualify(runtimeRoot, "c".repeat(64)), /Build differs/u);
  fs.writeFileSync(
    manifestPath,
    fs.readFileSync(manifestPath, "utf8").replace(/\n/gu, "\r\n"),
  );
  assert.throws(
    () => qualify(runtimeRoot, buildHash),
    /Installed GM07 manifest differs/u,
  );
});

test("GM07 offline check requires the explicitly selected build fingerprint", (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-gm07-pin-"));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const buildHash = "b".repeat(64);
  const operations = [
    "sketch.create",
    "sketch.inspect",
    "sketch.profile-file",
    "curve.fit",
    "curve.inspect",
    "curve.offset",
    "curve.offset-edit",
  ];
  const context = vm.createContext({
    assert,
    childProcess: { spawnSync: () => ({ status: 0, stderr: "" }) },
    fs,
    path,
    process: {
      env: {
        FMCAD_LIVE_RUNTIME_ROOT: runtimeRoot,
        FMCAD_LIVE_BUILD_HASH: "c".repeat(64),
      },
    },
    fixtureId: "gm07-curves-program-v1",
    fixturePrefix: "NQGM07CURVE01",
    expectedRuntimeRoot: runtimeRoot,
    coverageOperations: operations,
    report: { fixedProgram: {} },
    catalog: Object.fromEntries(operations.map((operation) => [operation, {}])),
    contracts: Object.fromEntries(
      operations.map((operation) => [
        operation,
        {
          service: { kind: "python" },
          requirements: { sdk: "required", document: true },
        },
      ]),
    ),
    persist: () => {},
    console: { log: () => {} },
    fixedContract: (root: string, expectedBuild: string) => {
      assert.equal(root, runtimeRoot);
      assert.equal(
        expectedBuild,
        buildHash,
        "Build differs from the offline-qualified candidate",
      );
      return {
        buildHash,
        scriptPath: path.join(runtimeRoot, "gm07-curves.py"),
        contract: { kind: "fixed-run-v1", helperVersion: "cad-v1" },
        manifest: {
          scope: "exact owner-bound pristine unsaved scratch",
          callerCleanupRequired: true,
        },
        manifestSha256: "a".repeat(64),
        scriptSha256: "b".repeat(64),
      };
    },
  });
  for (const name of ["requiredEnv", "runtimePins", "offlineCheck"])
    vm.runInContext(retainedFunction("live-gm07.js", name), context);

  const offlineCheck = vm.runInContext("offlineCheck", context) as () => void;
  assert.throws(
    offlineCheck,
    /Build differs from the offline-qualified candidate/u,
  );
  (context["process"] as { env: Record<string, string> }).env[
    "FMCAD_LIVE_BUILD_HASH"
  ] = buildHash;
  assert.doesNotThrow(offlineCheck);
});

test("GM07 provisions and closes only its exact new unsaved scratch", async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-gm07-run-"));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const scratchName = "FMCAD_GM07_test_owned_scratch";
  const scratchId = "12345678-1234-1234-1234-123456789abc";
  const originalId = "87654321-4321-4321-4321-cba987654321";
  const buildHash = "b".repeat(64);
  const baselineDocument = {
    name: "Existing user document",
    creationId: originalId,
    fileId: null,
    saved: false,
    modified: false,
    active: true,
  };
  const scratch = {
    name: scratchName,
    creationId: scratchId,
    fileId: null,
    saved: false,
    modified: false,
    active: true,
  };
  let stateReads = 0;
  const createdCommands: string[][] = [];
  const fixtureScopes: [string | null, string | null][] = [];
  const cleanupScripts: string[] = [];
  const context = vm.createContext({
    assert,
    fs,
    path,
    process: {
      env: {
        FMCAD_LIVE_RUNTIME_ROOT: runtimeRoot,
        FMCAD_LIVE_BUILD_HASH: buildHash,
        FMCAD_LIVE_CLIENT: "gm07-owned-client",
        FMCAD_LIVE_FUSION_VERSION: "fixture-fusion-version",
      },
    },
    name: scratchName,
    fixtureId: "gm07-curves-program-v1",
    fixedSourceCommit: "source-pinned",
    fixturePrefix: "NQGM07CURVE01",
    identity: undefined,
    restoreDocumentId: undefined,
    baseline: undefined,
    documentCreated: false,
    uncertain: false,
    fixedRunSettled: false,
    failure: undefined,
    blockedReason: undefined,
    report: {
      fixedProgram: {},
      broker: {},
      methodResults: [],
      ownedDocuments: [],
      tests: [],
    },
    reportPath: "test-report.json",
    targetOperations: [],
    coverageOperations: [],
    persist: () => {},
    console: { log: () => {}, error: () => {} },
    fixture: (name: string | null, id: string | null) =>
      fixtureScopes.push([name, id]),
    state: () => {
      stateReads += 1;
      return stateReads === 1
        ? { documents: [baselineDocument], activeCreationId: originalId }
        : {
            documents: [{ ...baselineDocument, active: false }, scratch],
            activeCreationId: scratchId,
          };
    },
    cli: (args: string[]) => {
      createdCommands.push(args);
      return { exitCode: 0 };
    },
    fixedContract: (root: string, expectedBuild: string) => {
      assert.equal(root, runtimeRoot);
      assert.equal(expectedBuild, buildHash);
      return {
        buildHash,
        manifestSha256: "a".repeat(64),
        scriptSha256: "b".repeat(64),
        manifest: {
          scope: "exact owner-bound pristine unsaved scratch",
        },
      };
    },
    runFixedProgram: (
      pinned: { buildHash: string },
      client: string,
      version: string,
    ) => {
      assert.equal(pinned.buildHash, buildHash);
      assert.equal(client, "gm07-owned-client");
      assert.equal(version, "fixture-fusion-version");
      return {
        fusionVersion: version,
        document: { before: scratch, after: scratch },
        designBefore: {},
      };
    },
    runAssertions: () => {},
    lifecycleScript: (script: string, dispatch: boolean) => {
      assert.equal(dispatch, false);
      cleanupScripts.push(script);
      return {
        closedCreationId: scratchId,
        activeCreationId: originalId,
      };
    },
  });
  for (const name of ["requiredEnv", "runtimePins", "closeOwned", "main"])
    vm.runInContext(retainedFunction("live-gm07.js", name), context);

  const main = vm.runInContext("main", context) as () => Promise<void>;
  await main();

  assert.equal(stateReads, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(createdCommands)), [
    ["doc", "new", "--name", scratchName, "--json"],
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(context["identity"])), {
    name: scratchName,
    creationId: scratchId,
  });
  assert.deepEqual(fixtureScopes, [
    [null, null],
    [scratchName, scratchId],
    [null, null],
  ]);
  assert.equal(context["report"].fixtureClosed, true);
  assert.equal(context["report"].cleanup.closedCreationId, scratchId);
  assert.match(
    cleanupScripts[0]!,
    /d\.name == "FMCAD_GM07_test_owned_scratch"/u,
  );
  assert.match(
    cleanupScripts[0]!,
    /d\.creationId == "12345678-1234-1234-1234-123456789abc"/u,
  );
  assert.match(
    cleanupScripts[0]!,
    /doc\.dataFile is None and not doc\.isSaved/u,
  );
  assert.match(cleanupScripts[0]!, /doc\.close\(False\)/u);
  assert.match(cleanupScripts[0]!, /before_others == expected_others/u);
  assert.match(cleanupScripts[0]!, /after_others == expected_others/u);
  assert.match(
    cleanupScripts[0]!,
    /restore_id = "87654321-4321-4321-4321-cba987654321"/u,
  );
  assert.match(cleanupScripts[0]!, /active_id == restore_id/u);
});

for (const family of ["gm07", "gm12"] as const) {
  for (const fault of [
    "spawn-throws",
    "foreign-client",
    "foreign-request",
    "foreign-job",
    "duplicate-job",
    "malformed-terminal",
    "missing-native-result",
  ] as const) {
    test(`${family} fixed invocation persists intent before spawn and rejects ${fault} without replay`, (t) => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "fmcad-fixed-intent-"),
      );
      t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
      const runtimeRoot = path.join(directory, "installed");
      const cliPath = path.join(runtimeRoot, "dist/bin/fmcad.js");
      const relativeScript = "assets/native-qualification/fixed.py";
      const scriptPath = path.join(runtimeRoot, "dist", relativeScript);
      fs.mkdirSync(path.dirname(cliPath), { recursive: true });
      fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
      fs.writeFileSync(cliPath, "// Never executed in this port test\n");
      fs.writeFileSync(scriptPath, "def run(context):\n    pass\n");
      const scriptSha256 = crypto
        .createHash("sha256")
        .update(fs.readFileSync(scriptPath))
        .digest("hex");
      const manifestSha256 = "a".repeat(64),
        buildHash = "b".repeat(64);
      fs.writeFileSync(
        path.join(runtimeRoot, "dist/runtime-build.json"),
        JSON.stringify({ fingerprint: buildHash }),
      );
      const identity = {
        name: "FMCAD_SCENARIO_fixed_owner",
        creationId: "12345678-1234-1234-1234-123456789abc",
      };
      const fixtureId =
        family === "gm07" ? "gm07-curves-program-v1" : "gm12-spring-program-v1";
      const fixture = {
        fixtureId,
        kind: "fixed-run-v1",
        helperVersion: "cad-v1",
        script: relativeScript,
        scriptSha256,
        manifestSha256,
      };
      const report: { commands: JsonRecord[] } = { commands: [] };
      const snapshots: string[] = [];
      let dispatches = 0,
        intentFile = "";
      const context = vm.createContext({
        assert,
        fs,
        path,
        crypto,
        root: directory,
        identity,
        report,
        fixtureId,
        fixturePrefix: "NQGM07CURVE",
        fixedSourceCommit: "source-pinned",
        uncertain: false,
        blockedReason: undefined,
        nativeProgram: undefined,
        process: {
          execPath: process.execPath,
          argv: ["node", "fixture.js", "--run"],
          env: {
            FMCAD_LIVE_CLIENT: "owned-client",
            FMCAD_LIVE_RUNTIME_ROOT: runtimeRoot,
            FMCAD_LIVE_DOC_NAME: identity.name,
            FMCAD_LIVE_DOC_ID: identity.creationId,
            FMCAD_LIVE_FUSION_VERSION: "fixture-version",
          },
        },
        operations: [
          "curve.helix",
          "shape.spring",
          "spring.evaluate",
          "spring.configure",
        ],
        persist: () => snapshots.push(JSON.stringify(report)),
        prepareNativeInvocation,
        observeNativeInvocation,
        isExecutionUnknown: (value: unknown) =>
          value !== null &&
          typeof value === "object" &&
          Reflect.get(value, "state") === "unknown",
        require: (filename: string) => {
          if (filename === path.join(runtimeRoot, "dist/src/queue-instance.js"))
            return { buildHash: () => buildHash };
          assert.equal(
            filename,
            path.join(runtimeRoot, "dist/src/queue-native-fixture-grant.js"),
          );
          return {
            fixtureContract: (id: string) => {
              assert.equal(id, fixtureId);
              return fixture;
            },
          };
        },
        childProcess: {
          spawnSync: (_binary: string, command: string[]) => {
            dispatches++;
            assert.equal(dispatches, 1);
            assert.equal(report.commands.length, 1);
            const row = report.commands[0]!;
            assert.equal(row["status"], "dispatch-intent");
            assert.equal(typeof row["intentFile"], "string");
            intentFile = row["intentFile"] as string;
            const intent = readNativeInvocation(intentFile);
            assert.equal(intent.state, "prepared");
            assert.equal(intent.driver.pid, process.pid);
            assert.ok(intent.driver.birth);
            assert.deepEqual(intent.binding.document, identity);
            assert.deepEqual(intent.binding.command, Array.from(command));
            assert.equal(intent.binding.scriptSha256, scriptSha256);
            assert.equal(intent.binding.manifestSha256, manifestSha256);
            assert.equal(intent.binding.buildHash, buildHash);
            assert.equal(intent.binding.clientId, "owned-client");
            assert.ok(snapshots.at(-1)?.includes('"status":"dispatch-intent"'));
            if (fault === "spawn-throws")
              throw new Error("lost child response");
            const accepted = {
              requestId: intent.binding.requestId,
              jobId: "original-job",
            };
            const terminal = {
              id: fault === "foreign-job" ? "foreign-job" : accepted.jobId,
              requestId:
                fault === "foreign-request"
                  ? "foreign-request"
                  : accepted.requestId,
              clientId:
                fault === "foreign-client" ? "foreign-client" : "owned-client",
              state: "succeeded",
              executionOutcome: "succeeded",
              operationResult: { executionOutcome: "succeeded" },
            };
            const acceptedLine =
              "FMCAD_QUEUE_JOB " + JSON.stringify(accepted) + "\n";
            return {
              status: 0,
              signal: null,
              stdout: "",
              stderr:
                acceptedLine +
                (fault === "duplicate-job" ? acceptedLine : "") +
                "FMCAD_QUEUE_RESULT " +
                (fault === "malformed-terminal"
                  ? "{bad"
                  : JSON.stringify(terminal)) +
                "\n",
            };
          },
        },
      });
      const filename =
        family === "gm07" ? "live-gm07.js" : "live-gm12-spring.js";
      if (family === "gm12")
        vm.runInContext(retainedFunction(filename, "requiredEnv"), context);
      const execute = vm.runInContext(
        "(" + retainedFunction(filename, "runFixedProgram") + ")",
        context,
      ) as (...args: unknown[]) => unknown;
      const pinned = {
        runtimeRoot,
        cliPath,
        scriptPath,
        buildHash,
        manifestSha256,
        scriptSha256,
      };
      assert.throws(
        () =>
          family === "gm07"
            ? execute(pinned, "owned-client", "fixture-version")
            : execute(),
        /lost child|indeterminate|Malformed terminal|unverified|unambiguous result/iu,
      );
      assert.equal(dispatches, 1);
      assert.equal(context["uncertain"], true);
      assert.equal(report.commands[0]?.["status"], "unknown");
      const intent = readNativeInvocation(intentFile);
      assert.equal(
        intent.state,
        fault === "missing-native-result" ? "terminal-observed" : "prepared",
      );
      assert.equal(
        fs.existsSync(scriptPath),
        true,
        "Failure must not remove installed source or the owner's files",
      );
    });
  }
}

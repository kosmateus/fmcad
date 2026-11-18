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
  fixture as scenarioFixture,
  remaining,
} from "./scenarios/test-support";
import { runScenarios, type Scenario } from "./scenarios/runner";
import type { ScenarioBackend, Execution } from "./scenarios/contracts";
import { program } from "./scenarios/programs";
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

for (const fault of ["none", "missing", "foreign", "unsettled"] as const) {
  test(`GM07 retained adapter uses exact receipt-bound lifecycle: ${fault}`, async (t) => {
    const { directory, model, backend } = await scenarioFixture(t);
    const created = await model.execute(
      program(
        "import adsk.core\napp = adsk.core.Application.get()\ndoc = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)\ndoc.name = 'USER_GM07_SENTINEL'",
      ),
    );
    assert.equal(created.success, true);
    const baseline = await remaining(model);
    let dispatches = 0;
    let original: Execution | null = null;
    const pinned = {
      buildHash: "b".repeat(64),
      manifestSha256: "a".repeat(64),
      scriptSha256: "c".repeat(64),
    };
    const report: JsonRecord = { ownedDocuments: [], broker: {} };
    const wrapped: ScenarioBackend = {
      ...backend,
      capabilities: new Set([...backend.capabilities, "original-user-view"]),
      async lookup(owner, requestId) {
        if (requestId.includes(":gm07-source-pinned:")) {
          if (fault === "none") {
            const switched = await model.execute(
              program(
                "import adsk.core\napp = adsk.core.Application.get()\nassert app.documents.item(0).name == 'USER_GM07_SENTINEL'\nassert app.documents.item(0).activate()",
              ),
            );
            assert.equal(switched.success, true);
          }
          return fault === "missing" ? null : original;
        }
        return backend.lookup!(owner, requestId);
      },
    };
    const context = vm.createContext({
      assert,
      report,
      fixtureId: "gm07-curves-program-v1",
      identity: undefined,
      coverageOperations: ["curve.fit"],
      persist() {},
      runAssertions() {
        report["assertionsVerified"] = true;
      },
      runFixedProgram(
        selected: unknown,
        clientId: string,
        version: string,
        requestId: string,
      ) {
        dispatches++;
        assert.equal(selected, pinned);
        assert.equal(version, "offline-fusion");
        assert.match(requestId, /^scenario:.*:gm07-source-pinned:\d+$/u);
        const ledger = JSON.parse(
          fs.readFileSync(
            path.join(
              directory,
              requestId.split(":")[1]!,
              "gm07-source-pinned/report.json",
            ),
            "utf8",
          ),
        ) as { requests: { requestId: string }[] };
        assert.equal(
          ledger.requests.at(-1)?.requestId,
          requestId,
          "intent must be durable before the public run",
        );
        original = {
          requestId,
          state: fault === "unsettled" ? "unknown" : "succeeded",
          sdkSettled: fault !== "unsettled",
          mayHaveMutated: true,
          stdout: "",
          brokerReceipt: {
            requestId,
            jobId: "gm07-original",
            clientId: fault === "foreign" ? "foreign-owner" : clientId,
            state: "succeeded",
            operationResult: {},
          },
        };
        report["nativeRun"] = { jobId: "gm07-original" };
        return {
          fusionVersion: version,
          document: { before: {}, after: {} },
          designBefore: {},
        };
      },
    });
    const scenario = vm.runInContext(
      "(" + retainedFunction("live-gm07.js", "gm07OwnedScenario") + ")",
      context,
    ) as (pins: unknown, version: string, backend: ScenarioBackend) => Scenario;
    const retained = scenario(pinned, "offline-fusion", wrapped);
    assert.ok(retained.requires.includes("original-user-view"));
    // This component simulator has no camera.save. Exercise the actual owned
    // lifecycle/receipt seam here; user-view capture/restore has its own tests
    // and remains mandatory in the unmodified live scenario.
    const [result] = await runScenarios(
      wrapped,
      [
        {
          ...retained,
          requires: retained.requires.filter(
            (value) => value !== "original-user-view",
          ),
        },
      ],
      directory,
      1,
    );
    assert.equal(dispatches, 1, JSON.stringify(result));
    if (fault === "none") {
      assert.equal(result?.status, "passed", JSON.stringify(result));
      assert.equal(result.cleanup, "complete");
      assert.equal(report["assertionsVerified"], true);
      assert.deepEqual(await remaining(model), baseline);
    } else {
      assert.equal(result?.status, "failed");
      assert.equal(result.cleanup, "deferred", JSON.stringify(result));
      assert.equal(report["assertionsVerified"], undefined);
      const after = (await remaining(model)) as { documents: unknown[] };
      assert.equal(
        after.documents.length,
        2,
        "uncertain owned fixture must remain for exact readback",
      );
    }
  });
}

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

test("GM07 main composes the qualified shared lifecycle instead of ad hoc document creation", async () => {
  const pinned = {
    buildHash: "b".repeat(64),
    runtimeRoot: "/qualified/runtime",
  };
  const cfg = {
    backend: "addin",
    routing: "queue",
    url: "http://127.0.0.1:8765/mcp",
  };
  const report: JsonRecord = {
    fixedProgram: {},
    methodResults: [{ operation: "curve.fit", status: "pass" }],
  };
  let disposed = false,
    scenarioCalls = 0;
  const context = vm.createContext({
    assert,
    path,
    root,
    Set,
    report,
    coverageOperations: ["curve.fit"],
    reportPath: "gm07-report.json",
    targetOperations: ["curve.fit"],
    process: { exitCode: undefined },
    console: { log() {}, error() {} },
    persist() {},
    runtimePins: () => ({
      runtimeRoot: pinned.runtimeRoot,
      expectedBuildHash: pinned.buildHash,
    }),
    fixedContract: (runtime: string, build: string) => {
      assert.equal(runtime, pinned.runtimeRoot);
      assert.equal(build, pinned.buildHash);
      return pinned;
    },
    requiredEnv: (name: string) => {
      assert.equal(name, "FMCAD_LIVE_FUSION_VERSION");
      return "offline-fusion";
    },
    gm07OwnedScenario: (value: unknown, version: string) => {
      assert.equal(value, pinned);
      assert.equal(version, "offline-fusion");
      return { id: "gm07-source-pinned" };
    },
    require: (name: string) => {
      if (name === "../dist/tests/scenarios/queue-backend.js")
        return {
          QueueScenarioBackend: class {
            constructor(
              mode: string,
              protocol: string,
              capabilities: Set<string>,
              selectedRoot: string,
              config: unknown,
            ) {
              assert.equal(mode, "fusion");
              assert.equal(protocol, "addin");
              assert.equal(selectedRoot, root);
              assert.equal(config, cfg);
              assert.deepEqual(
                [...capabilities],
                ["documents", "fixture-export", "original-user-view"],
              );
            }
            dispose() {
              disposed = true;
            }
          },
        };
      if (name === "../dist/tests/scenarios/runner.js")
        return {
          async runScenarios(
            _backend: unknown,
            scenarios: { id: string }[],
            output: string,
            concurrency: number,
          ) {
            scenarioCalls++;
            assert.equal(scenarios[0]?.id, "gm07-source-pinned");
            assert.equal(output, "/shared/receipts");
            assert.equal(concurrency, 1);
            return [
              {
                status: "passed",
                cleanup: "complete",
                document: { name: "own", creationId: "own-id" },
                directory: "/shared/receipts/run/gm07-source-pinned",
              },
            ];
          },
        };
      if (name === "../dist/tests/scenarios/artifact-root.js")
        return { scenarioArtifactRoot: () => "/shared/receipts" };
      if (name === "../src/dist/config-platform")
        return { toWindowsPath: (s: string) => s, detectPlatform() {} };
      assert.equal(name, "../src/config");
      return { loadConfig: () => ({ cfg }) };
    },
  });
  await (
    vm.runInContext(
      "(" + retainedFunction("live-gm07.js", "main") + ")",
      context,
    ) as () => Promise<void>
  )();
  assert.equal(scenarioCalls, 1);
  assert.equal(disposed, true);
  assert.equal(report["fixtureClosed"], true);
  assert.deepEqual(
    Array.from(report["remainingOwnedDocuments"] as unknown[]),
    [],
  );
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

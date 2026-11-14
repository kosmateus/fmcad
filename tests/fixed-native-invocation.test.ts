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

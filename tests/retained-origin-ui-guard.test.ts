import type { PreparedPythonArtifact } from "@fmcad/core";
import type { ObjectValue } from "../packages/node-adapters/src/fusion-transport/contracts";
type PythonFacade =
  typeof import("../packages/node-adapters/src/python/artifact") &
    typeof import("../packages/node-adapters/src/python/admission") &
    typeof import("../packages/node-adapters/src/python/checker") &
    typeof import("../packages/node-adapters/src/python/context-binding");
type HistoricalFixture = {
  revision: string;
  sourcePath: string;
  file: string;
  sha256: string;
};
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { at, record, list, text, number } from "./integration/offline-cli";
const testRoot = process.cwd();
const runtimeRequire = createRequire(
  testRoot + "/tests/retained-origin-ui-guard.test.js",
);
function present<T>(value: T | null | undefined): T {
  assert(value != null);
  return value;
}
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
const runtime = path.resolve(testRoot + "/tests", "../dist");
test(
  "retained-origin offset: historical aggregate incompleteness reproduces; verified history and current public bytes pass",
  {},
  async (t) => {
    const temporary = fs.mkdtempSync(
      runtimeRequire("node:path").join(
        runtimeRequire("node:os").tmpdir(),
        "retained-origin-offset-",
      ),
    );
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const py = runtimeRequire(runtime + "/src/python") as PythonFacade,
      api = runtimeRequire(runtime + "/src/queue-instance") as ReturnType<
        typeof import("../packages/node-adapters/src/execution/queue-instance").createQueueInstance
      >;
    const historicalFixture = {
      checkerRevision: "f7082569f9ac8c321e704175cccc6781275a0d0e",
      checkerPath: "packages/node-adapters/src/python/checker.ts",
      checkerHash:
        "c5cce55256c647a6514444df852dbc246131805ac298ac241027213f9db0cf87",
      fixedCheckerRevision: "9a540740389d0be1d6725225253c36825adea5d8",
      fixedCheckerPath: "packages/node-adapters/src/python/checker.ts",
      fixedCheckerHash:
        "4c838dbc2ade8ec60c310f4696e26d34d7d2a2583c26bf8f2e14a0f374c88458",
      helperRevision: "9a540740389d0be1d6725225253c36825adea5d8",
      helperPath: "runtime/python/typing/checker-project.py",
      helperHash:
        "5e7b29f4642685dc3aef960dd8d35ee16713cae44b7a1d20323a1a5df2f617bc",
      retainedStartLine: 13,
      requiredAnalyses: 5,
      definitionsHash:
        "83dc3697aa61a47ada93c323e2f719c7be3d72091938415f666089a96b159179",
      valuesPerUnit: 75010,
      valuesPerLine: 500,
      scriptHash:
        "543ccec0f745e07449e8d15c9f79b33d4ebdb4252fc007e1d3c8326863293b93",
      sourceHashes: [
        "e094184848cf4aea69754b1de1d5903db9b5fa65927cb20c3e379a946aed08af",
        "61c10b807541b571bb6617159f23a058ba79d1018c7d7f135ccf9804835728a8",
        "8be45ca5c2644686ee00ac1fd1f861704b062cc2925f4bec0e71b40bd307fedd",
        "241b3a45e37ca533184f5bb562daf630dc00e412b12a855349f5316797a4390b",
        "a4b1a317fb407047d6dc29bdfada5f22cff58e603618dbcfea1e906d85393be0",
        "5a40ae6afc64f75618beb5a8dd1e0fc536731354a34d0926f765ee0d08c51de0",
      ],
      wrapperSource: "def run(context: str) -> None:\n    return\n",
    } as const;
    const buildHistoricalArtifact = () => {
      const inputs: {
        id: string;
        filename: string;
        role: "runtime" | "wrapper";
        source: string;
      }[] = [];
      for (let unit = 0; unit < 5; unit++) {
        const lines: string[] = [];
        for (
          let offset = 0;
          offset < historicalFixture.valuesPerUnit;
          offset += historicalFixture.valuesPerLine
        )
          lines.push(
            "        " +
              "0,".repeat(
                Math.min(
                  historicalFixture.valuesPerLine,
                  historicalFixture.valuesPerUnit - offset,
                ),
              ),
          );
        inputs.push({
          id: `unit-${unit}`,
          filename: `unit_${unit}.py`,
          role: "runtime",
          source: `def unit_${unit}() -> list[int]:\n    return [\n${lines.join("\n")}\n    ]\n`,
        });
      }
      inputs.push({
        id: "wrapper",
        filename: "wrapper.py",
        role: "wrapper",
        source: historicalFixture.wrapperSource,
      });
      const artifact = py.preparePythonArtifact(inputs, {
        context: { doc: "HISTORICAL_OFFSET_FIXTURE", docId: "offline" },
        request: { operation: "retained-origin-offset" },
      });
      assert.equal(artifact.sha256, historicalFixture.scriptHash);
      assert.deepEqual(
        artifact.units.map((unit) => unit.sha256),
        historicalFixture.sourceHashes,
      );
      return artifact;
    };
    const historicalArtifact = buildHistoricalArtifact();
    const currentArtifact = (
      runtimeRequire(
        runtime + "/src/cad",
      ) as typeof import("../src/composition/cad-execution")
    ).prepareCadScript(
      "sketch.create",
      { name: "RegressionSection", plane: "XY" },
      {
        doc: "QUALIFIED_OFFLINE_FIXTURE",
        docId: "not-an-actual-live-document",
        preview: false,
      },
    );
    const physical = (
      runtimeRequire(
        runtime + "/src/dist/fusion-transport/broker",
      ) as typeof import("../packages/node-adapters/src/fusion-transport/broker")
    ).createBrokerTransport(
      {
        backend: "addin",
        url: "http://NEVER-SEND.invalid",
        timeoutMs: 180000,
      },
      {
        version: "offline-regression",
        requestTimeout: (s) => present(s.timeoutMs),
        bridgeSource: () => assert.fail("No generic bridge"),
      },
    );
    physical._post = () => assert.fail("NO HTTP OR SDK PORT in this test");
    let prepared:
      { payload: ObjectValue; artifact: PreparedPythonArtifact } | undefined;
    physical.preparePost = async (payload, origin) => {
      const params = record(payload["params"]),
        args = record(params["arguments"]);
      const code = text(args["code"]);
      assert.ok(
        code.includes("FMCAD_UI_GUARD"),
        "Actual real add-in transformation must be present",
      );
      const final = py.retainPythonOrigin(
        api.prepareReceiptScript(
          code,
          false,
          path.join(temporary, "never-sent.json"),
          {
            jobId: "offline",
            rpcId: "offline",
            sourceHash: api.hash(code),
            requestHash: api.hash(JSON.stringify(payload)),
            buildHash: "offline",
          },
          { mapPath: (file) => file },
        ),
        present(origin),
      );
      prepared = {
        payload: {
          ...payload,
          params: { ...params, arguments: { ...args, code: final.script } },
        },
        artifact: final,
      };
      return {
        fence() {},
        send() {
          assert.fail("No send");
        },
      };
    };
    const prepareAddinArtifact = async (
      artifact: PreparedPythonArtifact,
    ): Promise<{ payload: ObjectValue; artifact: PreparedPythonArtifact }> => {
      prepared = undefined;
      await physical.prepareCallTool(
        { featureType: "script", object: { script: artifact.script } },
        "fusion_mcp_execute",
        py.pythonArtifactManifest(artifact),
      );
      const accepted = prepared;
      assert.ok(accepted);
      return accepted;
    };
    const historicalAccepted = await prepareAddinArtifact(historicalArtifact);
    const currentAccepted = await prepareAddinArtifact(currentArtifact);
    const basedpyright = path.dirname(
      runtimeRequire.resolve("basedpyright/package.json"),
    );
    const typingRoot = path.join(runtime, "runtime/python/typing");
    const historyRoot = path.join(testRoot, "tests/fixtures/history");
    const historicalHelpers = JSON.parse(
      fs.readFileSync(path.join(historyRoot, "manifest.json"), "utf8"),
    ) as HistoricalFixture[];
    const historicalHelper = historicalHelpers.find(
      (fixture) =>
        fixture.revision === historicalFixture.helperRevision &&
        fixture.sourcePath === historicalFixture.helperPath,
    );
    assert.ok(historicalHelper);
    assert.equal(historicalHelper.sha256, historicalFixture.helperHash);
    const historicalChecker = historicalHelpers.find(
      (fixture) =>
        fixture.revision === historicalFixture.checkerRevision &&
        fixture.sourcePath === historicalFixture.checkerPath,
    );
    assert.ok(historicalChecker);
    assert.equal(historicalChecker.sha256, historicalFixture.checkerHash);
    const fixedHistoricalChecker = historicalHelpers.find(
      (fixture) =>
        fixture.revision === historicalFixture.fixedCheckerRevision &&
        fixture.sourcePath === historicalFixture.fixedCheckerPath,
    );
    assert.ok(fixedHistoricalChecker);
    assert.equal(
      fixedHistoricalChecker.sha256,
      historicalFixture.fixedCheckerHash,
    );
    assert.equal(path.basename(historicalHelper.file), historicalHelper.file);
    const historicalTypingRoot = path.join(temporary, "historical-typing");
    fs.mkdirSync(historicalTypingRoot);
    fs.copyFileSync(
      path.join(typingRoot, "fmcad_context.pyi"),
      path.join(historicalTypingRoot, "fmcad_context.pyi"),
    );
    const legacyHelper = fs.readFileSync(
      path.join(historyRoot, historicalHelper.file),
    );
    assert.equal(
      createHash("sha256").update(legacyHelper).digest("hex"),
      historicalHelper.sha256,
    );
    fs.writeFileSync(
      path.join(historicalTypingRoot, "checker-project.py"),
      legacyHelper,
    );
    const make = (
      factory: typeof import("../packages/node-adapters/src/python/checker").createPythonChecker,
      checkerTypingRoot = typingRoot,
    ) =>
      py.createPythonRpcAdmission({
        runtime: path.join(runtime, "runtime/python"),
        checker: factory({
          typingRoot: checkerTypingRoot,
          definitionsRoot: typingRoot,
          pythonPlatform: "Windows",
          checkerResources: () => py.pythonAdmissionResources([basedpyright]),
        }),
        resources: () =>
          py.pythonAdmissionResources([
            typingRoot,
            checkerTypingRoot,
            basedpyright,
          ]),
      });
    const oldFactory = (
      runtimeRequire("./fixtures/historical-module.cjs") as (
        revision: string,
        source: string,
        runtime: string,
      ) => typeof import("../packages/node-adapters/src/python/checker")
    )(
      historicalFixture.checkerRevision,
      historicalFixture.checkerPath,
      "src/dist/python/checker.js",
    ).createPythonChecker;
    const fixedHistoricalFactory = (
      runtimeRequire("./fixtures/historical-module.cjs") as (
        revision: string,
        source: string,
        runtime: string,
      ) => typeof import("../packages/node-adapters/src/python/checker")
    )(
      historicalFixture.fixedCheckerRevision,
      historicalFixture.fixedCheckerPath,
      "src/dist/python/checker.js",
    ).createPythonChecker;
    const old = make(oldFactory, historicalTypingRoot);
    const fixedHistorical = make(fixedHistoricalFactory, historicalTypingRoot);
    const assertRetainedOriginBytes = (accepted: {
      artifact: PreparedPythonArtifact;
    }) => {
      const origin = record(at(accepted.artifact, "context", "origin"));
      const segment = record(at(origin, "segments", 0));
      const source = accepted.artifact.units.find(
        (unit) => unit.sha256 === text(segment["sha256"]),
      );
      assert.ok(source);
      const retainedBytes = Buffer.from(
        source.source
          .split("\n")
          .slice(number(segment["startLine"]) - 1, number(segment["endLine"]))
          .join("\n"),
        "utf8",
      );
      assert.equal(
        createHash("sha256").update(retainedBytes).digest("hex"),
        text(origin["sha256"]),
      );
      return segment;
    };
    const historySegment = assertRetainedOriginBytes(historicalAccepted);
    assert.equal(
      number(historySegment["startLine"]),
      historicalFixture.retainedStartLine,
    );
    assertRetainedOriginBytes(currentAccepted);
    await assert.rejects(
      old.check(historicalAccepted.payload, historicalAccepted.artifact),
      (error) => {
        const check = record(error)["pythonCheck"];
        const provenance =
          check === undefined ? undefined : record(at(check, "provenance"));
        return (
          check !== undefined &&
          at(check, "status") === "tool_error" &&
          provenance?.["checker"] === "basedpyright" &&
          provenance["checkerVersion"] === "1.40.2" &&
          provenance["definitionsHash"] === historicalFixture.definitionsHash &&
          list(at(check, "reasons")).includes(
            `Aggregate checker completed 1 of ${historicalFixture.requiredAnalyses} required analyses`,
          )
        );
      },
    );
    const historicalCertificate = await fixedHistorical.check(
      historicalAccepted.payload,
      historicalAccepted.artifact,
    );
    const historicalReport = present(historicalCertificate.report);
    assert.equal(historicalReport.status, "passed");
    assert.equal(historicalReport.provenance.checker, "basedpyright");
    assert.equal(historicalReport.provenance.checkerVersion, "1.40.2");
    assert.equal(
      historicalReport.provenance.definitionsHash,
      historicalFixture.definitionsHash,
    );
    historicalCertificate.fence(historicalAccepted.payload);
    const fixed = make(py.createPythonChecker);
    const currentCertificate = await fixed.check(
      currentAccepted.payload,
      currentAccepted.artifact,
    );
    const currentReport = present(currentCertificate.report);
    assert.equal(currentReport.status, "passed");
    assert.equal(currentReport.provenance.checker, "basedpyright");
    assert.equal(currentReport.provenance.checkerVersion, "1.40.2");
    assert.equal(
      currentReport.provenance.definitionsHash,
      historicalFixture.definitionsHash,
    );
    currentCertificate.fence(currentAccepted.payload);
    const altered = structuredClone(currentAccepted.payload);
    const alteredArgs = record(at(altered, "params", "arguments"));
    alteredArgs["code"] = text(alteredArgs["code"]) + "\n# unapproved bytes";
    assert.throws(() => currentCertificate.fence(altered));
    const forged = structuredClone(currentAccepted.artifact);
    const segment = record(at(forged, "context", "origin", "segments", 0));
    segment["startLine"] = number(segment["startLine"]) + 1;
    await assert.rejects(fixed.check(currentAccepted.payload, forged));
    assert.equal(fs.existsSync(path.join(temporary, "never-sent.json")), false);
  },
);

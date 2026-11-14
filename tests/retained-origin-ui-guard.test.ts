import type { PreparedPythonArtifact } from "@fmcad/core";
import type { ObjectValue } from "../packages/node-adapters/src/fusion-transport/contracts";
type PythonFacade =
  typeof import("../packages/node-adapters/src/python/artifact") &
    typeof import("../packages/node-adapters/src/python/admission") &
    typeof import("../packages/node-adapters/src/python/checker") &
    typeof import("../packages/node-adapters/src/python/context-binding");
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
  "real add-in UI guard: legacy source rejects the same final bytes, verified retained-span offset passes all aggregate groups",
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
    const artifact = (
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
    await physical.prepareCallTool(
      { featureType: "script", object: { script: artifact.script } },
      "fusion_mcp_execute",
      py.pythonArtifactManifest(artifact),
    );
    const accepted = present(prepared);
    const basedpyright = path.dirname(
      runtimeRequire.resolve("basedpyright/package.json"),
    );
    const typingRoot = path.join(runtime, "runtime/python/typing");
    const make = (
      factory: typeof import("../packages/node-adapters/src/python/checker").createPythonChecker,
    ) =>
      py.createPythonRpcAdmission({
        runtime: path.join(runtime, "runtime/python"),
        checker: factory({
          typingRoot,
          definitionsRoot: typingRoot,
          pythonPlatform: "Windows",
          checkerResources: () => py.pythonAdmissionResources([basedpyright]),
        }),
        resources: () =>
          py.pythonAdmissionResources([typingRoot, basedpyright]),
      });
    const oldFactory = (
      runtimeRequire("./fixtures/historical-module.cjs") as (
        revision: string,
        source: string,
        runtime: string,
      ) => typeof import("../packages/node-adapters/src/python/checker")
    )(
      "f7082569f9ac8c321e704175cccc6781275a0d0e",
      "packages/node-adapters/src/python/checker.ts",
      "src/dist/python/checker.js",
    ).createPythonChecker;
    const old = make(oldFactory);
    await assert.rejects(
      old.check(accepted.payload, accepted.artifact),
      (error) => {
        const check = record(error)["pythonCheck"];
        return (
          check !== undefined &&
          at(check, "status") === "tool_error" &&
          list(at(check, "reasons")).includes(
            "Aggregate checker completed 1 of 5 required analyses",
          )
        );
      },
    );
    const fixed = make(py.createPythonChecker);
    const certificate = await fixed.check(accepted.payload, accepted.artifact);
    assert.equal(present(certificate.report).status, "passed");
    assert.equal(
      present(certificate.report).provenance.checker,
      "basedpyright",
    );
    certificate.fence(accepted.payload);
    const altered = structuredClone(accepted.payload);
    const alteredArgs = record(at(altered, "params", "arguments"));
    alteredArgs["code"] = text(alteredArgs["code"]) + "\n# unapproved bytes";
    assert.throws(() => certificate.fence(altered));
    const forged = structuredClone(accepted.artifact);
    const segment = record(at(forged, "context", "origin", "segments", 0));
    segment["startLine"] = number(segment["startLine"]) + 1;
    await assert.rejects(fixed.check(accepted.payload, forged));
    assert.equal(fs.existsSync(path.join(temporary, "never-sent.json")), false);
  },
);

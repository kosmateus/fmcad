import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { program } from "./programs";
import {
  featureModeLineProbe,
  featureModePropertiesProbe,
  featureModeHoleInputProbe,
  featureModeProbeSource,
  nativeFeatureModesScenarios,
  nativeFeatureModesCapability,
} from "./native-feature-modes-cases";
import { fixture } from "./test-support";
import { runScenarios } from "./runner";
import type { Execution } from "./contracts";

const root = path.resolve(__dirname, "../../..");
const load = createRequire(path.join(root, "package.json"));
const { prepareRunScript } = load(
  "./src/run",
) as typeof import("../../src/composition/run");
const { prepareCadScript } = load(
  "./src/cad",
) as typeof import("../../src/composition/cad");
const {
  createPythonChecker,
  createPythonRpcAdmission,
  retainPythonOrigin,
  pythonArtifactManifest,
} = load(
  "./src/python",
) as typeof import("../../packages/node-adapters/src/python/checker") &
  typeof import("../../packages/node-adapters/src/python/admission") &
  typeof import("../../packages/node-adapters/src/python/context-binding");
const { prepareReceiptScript } = load("./src/queue-instance") as ReturnType<
  typeof import("../../packages/node-adapters/src/execution/queue-instance").createQueueInstance
>;
const runtime = path.join(root, "dist/runtime/python");
const checker = createPythonChecker({
  typingRoot: path.join(runtime, "typing"),
  definitionsRoot: path.join(runtime, "typing"),
  pythonPlatform: "Windows",
});
const reference = {
  kind: "sketchCurve",
  token: "owned-entity-token",
  component: { kind: "component", name: "OwnedComponent" },
};

test("feature-mode scenario submits CAD through the existing command pipeline", async (t) => {
  const { backend, directory } = await fixture(t, "addin");
  const commands: string[] = [];
  const helperSources: string[] = [];
  const rejected = new Map<string, Execution>();
  const lookup = backend.lookup;
  assert.ok(lookup);
  const reports = await runScenarios(
    {
      ...backend,
      capabilities: new Set([
        ...backend.capabilities,
        nativeFeatureModesCapability,
      ]),
      async execute(request) {
        if (!request.command && request.helpers !== "cad-v1") {
          assert.doesNotMatch(
            request.source,
            /_modeling_compat_source|_fmcad_compat_file/,
          );
          return backend.execute(request);
        }
        if (request.command) commands.push(request.command.operation);
        else helperSources.push(request.source);
        const result: Execution = {
          requestId: request.requestId,
          state: "failed",
          sdkSettled: true,
          mayHaveMutated: false,
          stdout: "",
          error: "Deliberate offline rejection after command preparation",
        };
        rejected.set(request.requestId, result);
        return result;
      },
      lookup: (owner, requestId) =>
        Promise.resolve(rejected.get(requestId) ?? lookup(owner, requestId)),
    },
    nativeFeatureModesScenarios(1),
    directory,
    1,
  );
  assert.equal(reports[0]?.status, "failed");
  assert.ok(
    helperSources.some((source) => source.includes('"component.create"')),
    JSON.stringify(reports),
  );
  assert.equal(
    commands.length,
    0,
    "The initial mutating CAD call must retain its in-turn fence",
  );
});

for (const [name, body] of [
  ["line", featureModeLineProbe(reference)],
  ["feature-properties", featureModePropertiesProbe(reference, "extrude")],
  ["hole-input", featureModeHoleInputProbe(reference, "OwnedComponent")],
] as const) {
  test(`feature-mode ${name} uses the public helper and passes final receipt admission`, async (t) => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "feature-mode-admission-"),
    );
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, "probe.py");
    fs.writeFileSync(
      file,
      featureModeProbeSource(
        { name: "OwnedFixture", creationId: "owned-creation" },
        [],
        body,
      ),
    );
    const original = prepareRunScript(
      file,
      [],
      false,
      "OwnedFixture",
      { docId: "owned-creation" },
      "cad-v1",
      [],
    );
    const receipt = prepareReceiptScript(
      original.script,
      true,
      "/offline/feature-mode.json",
      { jobId: name },
      { mapPath: (value) => value },
    );
    const artifact = retainPythonOrigin(
      receipt,
      pythonArtifactManifest(original),
    );
    const request = {
      jsonrpc: "2.0",
      id: name,
      method: "tools/call",
      params: {
        name: "fusion_mcp_execute",
        arguments: {
          featureType: "script",
          object: { script: artifact.script },
        },
      },
    };
    const admission = createPythonRpcAdmission({ runtime, checker });
    const certificate = await admission
      .check(request, artifact)
      .catch((error: unknown) => {
        assert.fail(JSON.stringify(error));
      });
    assert.equal(certificate.report?.status, "passed");
    certificate.fence(request);
    const changed = structuredClone(request);
    changed.params.arguments.object.script += "\nraise RuntimeError('changed')";
    assert.throws(() => certificate.fence(changed));
  });
}

test("feature-mode component creation uses canonical public preparation", async () => {
  const artifact = prepareCadScript(
    "component.create",
    { name: "OwnedComponent" },
    { doc: "OwnedFixture", docId: "owned-creation" },
  );
  const result = await checker.check({ artifact, context: { kind: "bundle" } });
  assert.equal(result.status, "passed", JSON.stringify(result));
  assert.ok(artifact.units.some((unit) => unit.role === "runtime"));
});

test("public helper admission still rejects dynamic execution", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "feature-mode-negative-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "dynamic.py");
  fs.writeFileSync(file, program("exec(input())"));
  const artifact = prepareRunScript(
    file,
    [],
    false,
    "OwnedFixture",
    { docId: "owned-creation" },
    "cad-v1",
    [],
  );
  const report = await checker.check({ artifact, context: { kind: "bundle" } });
  assert.notEqual(report.status, "passed");
  assert.match(JSON.stringify(report.reasons), /unresolved dynamic exec/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { fixture, remaining } from "./test-support";
import {
  nativeCameraProbeCapability,
  nativeCameraProbeScenarios,
} from "./native-camera-probe-cases";
import { runScenarios } from "./runner";
import { record } from "./contracts";
for (const protocol of ["mcp", "addin"] as const) {
  test(`native camera fit/PNG capability stays unavailable on the model via ${protocol}`, async (t) => {
    const { backend, model, directory } = await fixture(t, protocol);
    const initial = model.executions;
    const scenarios = nativeCameraProbeScenarios(10);
    assert.ok(
      scenarios.every(
        (s) => s.scope === "exclusive-instance" && s.fixture === undefined,
      ),
    );
    const reports = [];
    // Check every owner independently: an exclusive unsupported result correctly
    // stops later scenarios in one run, so that barrier is not a capability proof.
    for (const scenario of scenarios)
      reports.push(...(await runScenarios(backend, [scenario], directory, 10)));
    assert.equal(model.executions, initial);
    assert.equal(reports.length, 10);
    for (const report of reports) {
      assert.equal(report.status, "unsupported");
      assert.equal(report.cleanup, "not-created");
      assert.deepEqual(report.requests, []);
    }
    assert.deepEqual(await remaining(model), { active: null, documents: [] });
  });
  test(`lost native camera dispatch defers the owned unsaved fixture without restore or replay via ${protocol}`, async (t) => {
    const { backend, model, directory } = await fixture(t, protocol);
    let attempts = 0;
    const fault = {
      ...backend,
      // Test-only fault injection at the native boundary. No native camera
      // behavior is simulated or claimed as qualified by this capability.
      capabilities: new Set([
        ...backend.capabilities,
        nativeCameraProbeCapability,
      ]),
      async execute(request: Parameters<typeof backend.execute>[0]) {
        if (
          request.source.includes("root.features.extrudeFeatures.addSimple")
        ) {
          attempts++;
          throw new Error("Lost native camera dispatch reply");
        }
        return backend.execute(request);
      },
    };
    const [report] = await runScenarios(
      fault,
      nativeCameraProbeScenarios(1),
      directory,
      1,
    );
    assert.ok(report);
    assert.equal(report.status, "failed");
    assert.equal(report.cleanup, "deferred");
    assert.match(report.error ?? "", /Lost native camera dispatch reply/);
    assert.equal(attempts, 1);
    assert.deepEqual(
      report.requests.map((r) => r.phase),
      [
        "create",
        "export",
        "observe-camera-baseline",
        "camera-initialize-owned-box",
      ],
    );
    const retained = record(await remaining(model));
    const documents = retained["documents"];
    assert.ok(Array.isArray(documents));
    assert.equal(documents.length, 1);
    assert.equal(
      record(documents[0])["creationId"],
      report.document!.creationId,
    );
    assert.equal(record(documents[0])["saved"], false);
  });
}

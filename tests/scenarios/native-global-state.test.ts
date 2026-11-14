import test from "node:test";
import assert from "node:assert/strict";
import { fixture, remaining } from "./test-support";
import { record } from "./contracts";
import { runScenarios, type Scenario } from "./runner";
import { NativeProbe } from "./native-probe";
import { nativePoseScenarios } from "./native-pose-cases";
import { nativeDesignStylesScenarios } from "./native-design-styles-cases";
import { nativeAnimationScenarios } from "./native-animation-cases";
import { nativeMotionScenarios } from "./native-motion-cases";

for (const protocol of ["mcp", "addin"] as const) {
  test(`native global state families stay unsupported without creating model fixtures via ${protocol}`, async (t) => {
    const { backend, model, directory } = await fixture(t, protocol);
    const before = model.executions;
    const scenarios = [
      ...nativePoseScenarios(10),
      ...nativeDesignStylesScenarios(10),
      ...nativeAnimationScenarios(10),
      ...nativeMotionScenarios(10),
    ];
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
    assert.equal(model.executions, before);
    assert.equal(reports.length, 40);
    for (const report of reports) {
      assert.equal(report.status, "unsupported");
      assert.equal(report.cleanup, "not-created");
      assert.deepEqual(report.requests, []);
    }
    assert.deepEqual(await remaining(model), { active: null, documents: [] });
  });
  for (const mode of ["lost", "missing-result", "foreign-result"] as const) {
    test(`native compiled ${mode} keeps its owned fixture without cleanup or replay via ${protocol}`, async (t) => {
      const { backend, model, directory } = await fixture(t, protocol);
      let attempts = 0,
        ownedId = "";
      const fault = {
        ...backend,
        async execute(request: Parameters<typeof backend.execute>[0]) {
          if (
            request.source.includes(
              "_native_case_results, _native_case_observations",
            )
          ) {
            attempts++;
            if (mode === "lost")
              throw new Error("Lost original native dispatch reply");
            return {
              requestId: request.requestId,
              state: "succeeded" as const,
              sdkSettled: true,
              mayHaveMutated: true,
              stdout:
                "FMCAD_SCENARIO " +
                JSON.stringify({
                  creationId: ownedId,
                  results:
                    mode === "missing-result"
                      ? []
                      : [
                          {
                            success: true,
                            operation: "document.status",
                            document: "foreign-document",
                            result: { saved: false },
                          },
                        ],
                  observations: [],
                  error: null,
                  errorType: null,
                }),
            };
          }
          return backend.execute(request);
        },
      };
      // Fault injection validates only the existing lifecycle; it does not model native behavior.
      const scenario: Scenario = {
        id: "native-compiled-" + mode,
        scope: "exclusive-instance",
        requires: ["documents"],
        async run(session) {
          ownedId = session.document.creationId;
          await new NativeProbe(session, "native-fault", "FAULT ").compiled(
            "document.status",
          );
          assert.fail(
            "The invalid original native result must stop the scenario",
          );
        },
      };
      const [report] = await runScenarios(fault, [scenario], directory, 1);
      assert.ok(report);
      assert.equal(report.status, "failed");
      assert.equal(report.cleanup, "deferred");
      assert.equal(attempts, 1);
      assert.match(
        report.error ?? "",
        mode === "lost"
          ? /Lost original native dispatch/
          : mode === "missing-result"
            ? /Missing or ambiguous production CAD result/
            : /Invalid or foreign native production result/,
      );
      assert.deepEqual(
        report.requests.map((r) => r.phase),
        [
          "create",
          "export",
          "observe-native-fault-guard-0",
          "native-fault-compiled-1",
        ],
      );
      const state = record(await remaining(model));
      const docs = state["documents"];
      assert.ok(Array.isArray(docs));
      assert.equal(docs.length, 1);
      assert.equal(record(docs[0])["creationId"], ownedId);
      assert.equal(record(docs[0])["saved"], false);
    });
  }
}

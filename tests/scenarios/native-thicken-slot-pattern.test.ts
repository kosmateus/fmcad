import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, remaining } from "./test-support";
import { record } from "./contracts";
import {
  nativeComponentHierarchyScenarios,
  nativeComponentHierarchyCapability,
} from "./native-component-hierarchy-cases";
import {
  nativeFeatureModesScenarios,
  nativeFeatureModesCapability,
} from "./native-feature-modes-cases";
import {
  nativeModelingHarness,
  nativeResultUncertain,
} from "./native-modeling-support";
import { nativeCadScenarios, nativeCadCapability } from "./native-cad-cases";
import {
  nativeExtendedScenarios,
  nativeExtendedCapability,
} from "./native-extended-cases";
import {
  nativeSketchOperationsScenarios,
  nativeSketchOperationsCapability,
} from "./native-sketch-operations-cases";
import { marker } from "./programs";
import { runScenarios, resumeCleanup } from "./runner";
import {
  nativeThickenSlotPatternScenarios,
  nativeThickenSlotPatternCapability,
} from "./native-thicken-slot-pattern-cases";

for (const protocol of ["mcp", "addin"] as const)
  test(`exclusive native capability barrier records subsequent owners as not run via ${protocol}`, async (t) => {
    const { backend, model, directory } = await fixture(t, protocol);
    const before = model.executions;
    const reports = await runScenarios(
      backend,
      nativeThickenSlotPatternScenarios(),
      directory,
      10,
    );
    assert.equal(reports.length, 10);
    for (const [index, report] of reports.entries()) {
      assert.equal(report.status, index === 0 ? "unsupported" : "not-run");
      assert.equal(report.cleanup, "not-created");
      assert.deepEqual(report.requests, []);
      assert.match(
        report.error ?? "",
        index === 0
          ? /Missing capabilities:/
          : /exclusive scenario did not establish successful restoration and cleanup/i,
      );
    }
    assert.equal(model.executions, before);
    assert.deepEqual(await remaining(model), { active: null, documents: [] });
  });

const families = [
  {
    name: "cad",
    scenarios: nativeCadScenarios,
    capability: nativeCadCapability,
  },
  {
    name: "extended",
    scenarios: nativeExtendedScenarios,
    capability: nativeExtendedCapability,
  },
  {
    name: "sketch",
    scenarios: nativeSketchOperationsScenarios,
    capability: nativeSketchOperationsCapability,
  },
  {
    name: "thicken-pattern",
    scenarios: nativeThickenSlotPatternScenarios,
    capability: nativeThickenSlotPatternCapability,
  },
  {
    name: "component-hierarchy",
    scenarios: nativeComponentHierarchyScenarios,
    capability: nativeComponentHierarchyCapability,
  },
  {
    name: "feature-modes",
    scenarios: nativeFeatureModesScenarios,
    capability: nativeFeatureModesCapability,
  },
];
for (const family of families)
  for (const protocol of ["mcp", "addin"] as const) {
    test(`${family.name} native capability rejects all ten owners before dispatch via ${protocol}`, async (t) => {
      const { backend, model, directory } = await fixture(t, protocol);
      const before = model.executions;
      const reports = [];
      // Run each owner independently so the exclusive scheduler's stop barrier
      // cannot turn an unexecuted owner into claimed capability evidence.
      for (const scenario of family.scenarios())
        reports.push(
          ...(await runScenarios(backend, [scenario], directory, 10)),
        );
      assert.equal(reports.length, 10);
      assert.equal(
        model.executions,
        before,
        "Unsupported native kernel received SDK work",
      );
      for (const report of reports) {
        assert.equal(report.status, "unsupported");
        assert.match(report.error ?? "", /Missing capabilities:/);
        assert.equal(report.cleanup, "not-created");
        assert.equal(
          report.fixture,
          undefined,
          "The retained workflow must remain unsaved",
        );
        assert.deepEqual(report.requests, []);
      }
      assert.deepEqual(await remaining(model), { active: null, documents: [] });
    });

    if (family.name !== "feature-modes" || protocol === "addin")
      test(`${family.name} metadata uncertainty defers owned cleanup before any CAD/kernel command via ${protocol}`, async (t) => {
        const { backend, model, directory } = await fixture(t, protocol);
        let injected = false;
        let commands = 0;
        const faulted = {
          ...backend,
          // This fault test stops at a real metadata probe. It never models or
          // qualifies thicken, slot-pattern, or any other missing native kernel.
          capabilities: new Set([...backend.capabilities, family.capability]),
          async execute(request: Parameters<typeof backend.execute>[0]) {
            if (request.command) commands++;
            const result = await backend.execute(request);
            if (
              !injected &&
              request.source.includes("version=app.version, documents=docs")
            ) {
              assert.equal(
                request.target,
                undefined,
                "Metadata probe must not activate its target through CLI routing",
              );
              assert.equal(result.state, "succeeded");
              assert.equal(result.sdkSettled, true);
              const lines = result.stdout
                .trim()
                .split(/\r?\n/u)
                .filter((line) => line.startsWith(marker));
              assert.equal(lines.length, 1);
              const value = record(
                JSON.parse(lines[0]!.slice(marker.length)) as unknown,
              );
              value["nested"] = { status: "unknown" };
              injected = true;
              return {
                ...result,
                stdout: marker + JSON.stringify(value) + "\n",
              };
            }
            return result;
          },
        };
        const reports = await runScenarios(
          faulted,
          family.scenarios(2),
          directory,
          10,
        );
        assert.equal(injected, true);
        assert.equal(
          commands,
          0,
          "Uncertain metadata must prevent every geometry mutation",
        );
        assert.equal(reports[0]?.status, "failed");
        assert.equal(reports[0]?.cleanup, "deferred");
        assert.match(
          reports[0]?.cleanupHold?.reason ?? "",
          /unknown\/pending/u,
        );
        assert.equal(
          reports[1]?.status,
          "not-run",
          "Unsettled exclusive work must block the next owner",
        );
        assert.equal(reports[1]?.cleanup, "not-created");
        assert.deepEqual(reports[1]?.requests, []);
        const state = record(await remaining(model));
        assert.ok(Array.isArray(state["documents"]));
        assert.equal(
          state["documents"].length,
          1,
          "The uncertain owned fixture must remain available for inspection",
        );
        const report = reports[0]!;
        assert.equal(
          record(state["documents"][0])["creationId"],
          report.document?.creationId,
        );
        assert.ok(
          !report.requests.some((request) => request.phase === "cleanup"),
        );
        const persisted = record(
          JSON.parse(
            fs.readFileSync(path.join(report.directory, "report.json"), "utf8"),
          ) as unknown,
        );
        assert.deepEqual(persisted["cleanupHold"], report.cleanupHold);
        const count = model.executions;
        await assert.rejects(
          resumeCleanup(backend, path.join(report.directory, "report.json")),
          /case-specific|cleanup hold|uncertainty/iu,
        );
        assert.equal(
          model.executions,
          count,
          "Recovery must not replay the uncertain probe or close its fixture",
        );
      });
  }

for (const protocol of ["mcp", "addin"] as const)
  test(`native modeling helper preserves real owned lifecycle without dispatching any kernel via ${protocol}`, async (t) => {
    const { backend, model, directory } = await fixture(t, protocol);
    let commands = 0;
    const observed = {
      ...backend,
      async execute(request: Parameters<typeof backend.execute>[0]) {
        if (request.command) commands++;
        return backend.execute(request);
      },
    };
    const reports = await runScenarios(
      observed,
      [0, 1].map((index) => ({
        id: "native-helper-lifecycle-" + index,
        requires: ["documents"],
        scope: "exclusive-instance" as const,
        async run(session: import("./runner").ScenarioSession) {
          const harness = await nativeModelingHarness(
            session,
            "tests/live-thicken-slot-pattern.js",
            [],
            [],
          );
          await harness.guard();
        },
      })),
      directory,
      10,
    );
    assert.deepEqual(
      reports.map((row) => [row.status, row.cleanup]),
      [
        ["passed", "complete"],
        ["passed", "complete"],
      ],
    );
    assert.equal(
      commands,
      0,
      "Lifecycle proof must not simulate native geometry",
    );
    assert.deepEqual(await remaining(model), { active: null, documents: [] });
  });

test("retained nested native uncertainty predicate recognizes pending mutations and terminal failures", () => {
  for (const value of [
    { status: "unknown" },
    { executionOutcome: "unknown" },
    { completed: false },
    { status: "started" },
    { status: "running" },
    { status: "pending" },
  ]) {
    assert.equal(nativeResultUncertain({ rows: [{ nested: value }] }), true);
  }
  for (const value of [
    null,
    false,
    0,
    "unknown",
    { status: "failed" },
    { status: "success", completed: true },
    { status: "pass" },
  ]) {
    assert.equal(nativeResultUncertain(value), false);
  }
});

for (const protocol of ["mcp", "addin"] as const)
  for (const mismatch of [
    "name",
    "creationId",
    "saved",
    "fileId",
    "active",
    "foreign-document",
  ] as const) {
    test(`native owner guard defers cleanup after ${mismatch} readback mismatch via ${protocol}`, async (t) => {
      const { backend, model, directory } = await fixture(t, protocol);
      let injected = false,
        commands = 0;
      const faulted = {
        ...backend,
        capabilities: new Set([
          ...backend.capabilities,
          nativeThickenSlotPatternCapability,
        ]),
        async execute(request: Parameters<typeof backend.execute>[0]) {
          if (request.command) commands++;
          const result = await backend.execute(request);
          if (
            !injected &&
            request.source.includes("version=app.version, documents=docs")
          ) {
            assert.equal(result.state, "succeeded");
            const lines = result.stdout
              .trim()
              .split(/\r?\n/u)
              .filter((line) => line.startsWith(marker));
            assert.equal(lines.length, 1);
            const value = record(
              JSON.parse(lines[0]!.slice(marker.length)) as unknown,
            );
            assert.ok(Array.isArray(value["documents"]));
            const documents = value["documents"].map(record);
            const owned = documents.find(
              (doc) => doc["creationId"] === value["creationId"],
            );
            assert.ok(owned);
            if (mismatch === "foreign-document")
              documents.push({
                ...owned,
                name: "unrelated",
                creationId: "foreign-id",
                active: false,
              });
            else
              owned[mismatch] =
                mismatch === "saved"
                  ? true
                  : mismatch === "active"
                    ? false
                    : "foreign-" + mismatch;
            value["documents"] = documents;
            injected = true;
            return { ...result, stdout: marker + JSON.stringify(value) + "\n" };
          }
          return result;
        },
      };
      const reports = await runScenarios(
        faulted,
        nativeThickenSlotPatternScenarios(2),
        directory,
        10,
      );
      const report = reports[0];
      assert.ok(report);
      assert.equal(injected, true);
      assert.equal(
        commands,
        0,
        "An invalid owner readback must stop before every native operation",
      );
      assert.equal(report.status, "failed");
      assert.equal(report.cleanup, "deferred");
      assert.match(
        report.cleanupHold?.reason ?? "",
        /Owned native fixture guard failed/u,
      );
      assert.equal(reports[1]?.status, "not-run");
      assert.ok(
        !report.requests.some((request) => request.phase === "cleanup"),
      );
      const state = record(await remaining(model));
      assert.ok(Array.isArray(state["documents"]));
      assert.equal(state["documents"].length, 1);
      assert.equal(
        record(state["documents"][0])["creationId"],
        report.document?.creationId,
      );
      const executions = model.executions;
      await assert.rejects(
        resumeCleanup(backend, path.join(report.directory, "report.json")),
        /case-specific|cleanup hold|uncertainty/iu,
      );
      assert.equal(
        model.executions,
        executions,
        "A changed owner observation cannot authorize recovery or replay",
      );
    });
  }

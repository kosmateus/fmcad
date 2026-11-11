import { test } from "node:test";
import { fixture, remaining } from "./test-support";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { createBrokerTransport } from "../../packages/node-adapters/src/fusion-transport/broker";
import type { ScenarioBackend, Document } from "./contracts";
import { simulatorEndpoint } from "./simulator";
import { runScenarios, resumeCleanup, type Scenario } from "./runner";
import { foundationScenarios, lifecycle, parameterScenario } from "./cases";
import * as programs from "./programs";

const root = path.resolve(__dirname, "../../..");
const runtimeRequire = createRequire(path.join(root, "package.json"));
for (const protocol of ["mcp", "addin"] as const) {
  test(`shared scenarios and cleanup use actual Python in ${protocol} protocol`, async (t) => {
    const { directory, model, backend } = await fixture(t, protocol);
    const reports = await runScenarios(
      backend,
      foundationScenarios(2),
      directory,
      2,
    );
    assert.ok(
      reports.every((report) => report.status === "passed"),
      JSON.stringify(reports),
    );
    assert.equal(new Set(reports.map((r) => r.document?.creationId)).size, 3);
    for (const report of reports) {
      assert.equal(report.cleanup, "complete");
      assert.equal(
        fs.existsSync(path.join(report.directory, "fixture.f3d")),
        false,
      );
    }
    assert.deepEqual(await remaining(model), { active: null, documents: [] });
  });
}
test(
  "ten owners interleave writes with identical parameter names and preserve a foreign document",
  async (t) => {
    const { directory, model, backend } = await fixture(t);
    const sentinel = await model.execute(
      programs.program(`import adsk.core
app = adsk.core.Application.get()
doc = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
doc.name = 'USER_SENTINEL'`),
    );
    assert.equal(sentinel.success, true);
    const before = await remaining(model);
    let arrived = 0;
    let release: () => void = () => {
      throw new Error("Missing barrier");
    };
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.after(() => release());
    const wrapped: ScenarioBackend = {
      ...backend,
      async execute(request) {
        const response = await backend.execute(request);
        if (request.source.includes("p = design.userParameters.add")) {
          if (++arrived === 10) release();
          await barrier;
          // A competing actor activates a different document before each owner's read.
          const perturbation = await model.execute(
            programs.program(
              "import adsk.core\nassert adsk.core.Application.get().documents.item(0).activate()",
            ),
          );
          assert.equal(perturbation.success, true);
        }
        return response;
      },
    };
    const reports = await runScenarios(
      wrapped,
      Array.from({ length: 10 }, (_, i) => parameterScenario(i)),
      directory,
      10,
    );
    assert.ok(
      reports.every((r) => r.status === "passed"),
      JSON.stringify(reports),
    );
    assert.equal(arrived, 10);
    assert.deepEqual(await remaining(model), before);
  },
);
test("settled operation failure and assertion failure both close documents and remove files", async (t) => {
  const { directory, model, backend } = await fixture(t);
  const scenarios: Scenario[] = [
    {
      id: "operation-failure",
      requires: lifecycle.requires,
      async run(session) {
        await session.execute(
          "fail",
          programs.program("raise ValueError('intentional operation failure')"),
          session.document,
        );
      },
    },
    {
      id: "assertion-failure",
      requires: lifecycle.requires,
      async run() {
        assert.equal(1, 2, "intentional assertion failure");
      },
    },
  ];
  const reports = await runScenarios(backend, scenarios, directory, 2);
  assert.ok(
    reports.every((r) => r.status === "failed" && r.cleanup === "complete"),
    JSON.stringify(reports),
  );
  assert.match(reports[0]?.error ?? "", /intentional operation failure/);
  assert.match(reports[1]?.error ?? "", /intentional assertion failure/);
  assert.deepEqual(await remaining(model), { active: null, documents: [] });
});
test("lost response remains unknown, persists original request and never dispatches cleanup or replay", async (t) => {
  const { directory, model, backend } = await fixture(t);
  let requests = 0;
  const losing: ScenarioBackend = {
    ...backend,
    async execute(request) {
      if (request.owner.scenarioId === "coordinator")
        return backend.execute(request);
      requests++;
      const result = await backend.execute(request);
      if (requests === 3)
        throw new Error("Lost original result after execution");
      return result;
    },
  };
  const [report] = await runScenarios(
    losing,
    [parameterScenario(0)],
    directory,
    1,
  );
  assert.ok(report);
  assert.equal(report.status, "failed");
  assert.equal(report.cleanup, "deferred");
  assert.equal(requests, 3);
  assert.equal(fs.existsSync(path.join(report.directory, "fixture.f3d")), true);
  assert.equal(report.requests.filter((r) => r.phase === "write").length, 1);
  assert.ok(report.requests.at(-1)?.result === undefined);
  assert.deepEqual(
    JSON.parse(
      fs.readFileSync(path.join(report.directory, "report.json"), "utf8"),
    ),
    report,
  );
  assert.ok(
    JSON.stringify(await remaining(model)).includes(
      report.document?.creationId ?? "missing",
    ),
  );
  await assert.rejects(
    resumeCleanup(
      { ...backend, lookup: async () => null },
      path.join(report.directory, "report.json"),
    ),
    /unsettled/,
  );
  const previousExecutions = model.executions;
  const restored = await resumeCleanup(
    backend,
    path.join(report.directory, "report.json"),
  );
  assert.equal(restored.cleanup, "complete");
  assert.equal(
    restored.status,
    "failed",
    "Cleanup recovery cannot certify unexecuted assertions",
  );
  assert.equal(
    model.executions,
    previousExecutions + 2,
    "Guarded cleanup and a final inventory read execute; the original mutation is not replayed",
  );
  assert.equal(
    (await resumeCleanup(backend, path.join(report.directory, "report.json")))
      .cleanup,
    "complete",
  );
  assert.equal(
    model.executions,
    previousExecutions + 3,
    "Completed cleanup is not repeated; only the run inventory is checked again",
  );
  assert.equal(
    fs.existsSync(path.join(report.directory, "fixture.f3d")),
    false,
  );
  assert.deepEqual(await remaining(model), { active: null, documents: [] });
});
test("foreign creation receipt cannot authorize closure of another owner's document", async (t) => {
  const { directory, backend } = await fixture(t);
  let count = 0;
  const corrupt: ScenarioBackend = {
    ...backend,
    async execute(request) {
      if (request.owner.scenarioId === "coordinator")
        return backend.execute(request);
      count++;
      const result = await backend.execute(request);
      return {
        ...result,
        stdout:
          programs.marker +
          JSON.stringify({ creationId: "foreign", name: "foreign" }),
      };
    },
  };
  const [report] = await runScenarios(corrupt, [lifecycle], directory, 1);
  assert.equal(report?.cleanup, "deferred");
  assert.equal(count, 1);
});
test("setup export failure cleans the document; cleanup error does not replace the original assertion", async (t) => {
  const { directory, backend } = await fixture(t);
  const rejectExport: ScenarioBackend = {
    ...backend,
    async execute(request) {
      if (request.source.includes("createFusionArchiveExportOptions"))
        return {
          requestId: request.requestId,
          state: "failed",
          sdkSettled: true,
          mayHaveMutated: false,
          stdout: "",
          error: "export failed",
        };
      return backend.execute(request);
    },
  };
  const [failedSetup] = await runScenarios(
    rejectExport,
    [lifecycle],
    directory,
    1,
  );
  assert.equal(failedSetup?.cleanup, "complete");
  assert.equal(failedSetup.error, "export failed");
  const rejectClose: ScenarioBackend = {
    ...backend,
    async execute(request) {
      if (request.source.includes("doc.close(False)"))
        return {
          requestId: request.requestId,
          state: "failed",
          sdkSettled: true,
          mayHaveMutated: false,
          stdout: "",
          error: "close failed",
        };
      return backend.execute(request);
    },
  };
  const scenario: Scenario = {
    ...lifecycle,
    async run() {
      throw new Error("original assertion");
    },
  };
  const [report] = await runScenarios(rejectClose, [scenario], directory, 1);
  assert.equal(report?.status, "failed");
  assert.equal(report.error, "original assertion");
  assert.equal(report.cleanupError, "close failed");
  assert.equal(report.cleanup, "failed");
});
test("unsupported capability is reported before any request, never counted as passed", async (t) => {
  const { directory, model, backend } = await fixture(t);
  const [report] = await runScenarios(
    backend,
    [{ ...lifecycle, requires: ["native-f3d"] }],
    directory,
  );
  assert.equal(report?.status, "unsupported");
  assert.equal(model.executions, 0);
});

for (const protocol of ["mcp", "addin"] as const) {
  test(
    `${protocol}: a scenario cannot submit another scenario's document, even with valid foreign source`,
    async (t) => {
      const { directory, model, backend } = await fixture(t, protocol);
      let publishTarget!: (target: Document) => void;
      const targetReady = new Promise<Document>((resolve) => {
        publishTarget = resolve;
      });
      let release!: () => void;
      const attempted = new Promise<void>((resolve) => {
        release = resolve;
      });
      t.after(() => release());
      const reports = await runScenarios(
        backend,
        [
          {
            id: "recipient",
            requires: lifecycle.requires,
            async run(session) {
              publishTarget(session.document);
              await attempted;
              const value = await session.execute(
                "read",
                programs.inspect(session.document),
                session.document,
              );
              assert.equal(
                value["count"],
                0,
                "recipient's independent read proves no foreign mutation",
              );
            },
          },
          {
            id: "sender",
            requires: lifecycle.requires,
            async run(session) {
              const target = await targetReady;
              const before = session.report.requests.length;
              try {
                await assert.rejects(
                  session.execute(
                    "wrong-target",
                    programs.parameter(target, 17),
                    target,
                  ),
                  /does not belong to this scenario/,
                );
                assert.equal(
                  session.report.requests.length,
                  before,
                  "rejected before recording or submitting another owner's request",
                );
              } finally {
                release();
              }
            },
          },
        ],
        directory,
        2,
      );
      assert.ok(
        reports.every((r) => r.status === "passed" && r.cleanup === "complete"),
        JSON.stringify(reports),
      );
      assert.deepEqual(await remaining(model), { active: null, documents: [] });
    },
  );

  test(`${protocol}: a lost cleanup reply remains deferred and recovery never closes twice`, async (t) => {
    const { directory, model, backend } = await fixture(t, protocol);
    let closes = 0;
    const losing: ScenarioBackend = {
      ...backend,
      async execute(request) {
        const value = await backend.execute(request);
        if (request.source.includes("doc.close(False)")) {
          closes++;
          throw new Error("lost close reply");
        }
        return value;
      },
    };
    const [report] = await runScenarios(losing, [lifecycle], directory, 1);
    assert.ok(report);
    assert.equal(report.status, "failed");
    assert.equal(report.cleanup, "deferred");
    assert.equal(report.cleanupError, "lost close reply");
    assert.equal(closes, 1);
    assert.equal(
      fs.existsSync(path.join(report.directory, "fixture.f3d")),
      true,
    );
    const executions = model.executions;
    const recovered = await resumeCleanup(
      {
        ...backend,
        async execute(request) {
          assert.equal(
            request.source.includes("doc.close(False)"),
            false,
            "The original close must never be replayed",
          );
          return backend.execute(request);
        },
      },
      path.join(report.directory, "report.json"),
    );
    assert.equal(recovered.cleanup, "complete");
    assert.equal(
      model.executions,
      executions + 1,
      "one final inventory read audits the recovered run; no second SDK close",
    );
    assert.equal(
      fs.existsSync(path.join(report.directory, "fixture.f3d")),
      false,
    );
    assert.deepEqual(await remaining(model), { active: null, documents: [] });
  });
}

test("a returned foreign document identity defers cleanup until the original result is recovered", async (t) => {
  const { directory, model, backend } = await fixture(t);
  let closes = 0;
  const corrupt: ScenarioBackend = {
    ...backend,
    async execute(request) {
      const value = await backend.execute(request);
      if (request.source.includes("doc.close(False)")) closes++;
      if (request.source.includes("p = design.userParameters.add")) {
        return {
          ...value,
          stdout:
            programs.marker +
            JSON.stringify({
              creationId: "another-owner",
              count: 1,
              value: 0.2,
            }),
        };
      }
      return value;
    },
  };
  const [report] = await runScenarios(
    corrupt,
    [parameterScenario(0)],
    directory,
    1,
  );
  assert.ok(report);
  assert.equal(report.cleanup, "deferred");
  assert.equal(closes, 0);
  const recovered = await resumeCleanup(
    backend,
    path.join(report.directory, "report.json"),
  );
  assert.equal(recovered.cleanup, "complete");
  assert.deepEqual(await remaining(model), { active: null, documents: [] });
});

test("creation identity must agree with the durable receipt, not just the generated name", async (t) => {
  const { directory, model, backend } = await fixture(t);
  let closes = 0;
  const corrupt: ScenarioBackend = {
    ...backend,
    async execute(request) {
      const result = await backend.execute(request);
      if (request.source.includes("doc.close(False)")) closes++;
      if (request.source.includes("identity: dict[str, object]")) {
        const value = JSON.parse(
          result.stdout.slice(programs.marker.length),
        ) as Record<string, unknown>;
        value["creationId"] = "foreign-id-with-the-correct-name";
        return { ...result, stdout: programs.marker + JSON.stringify(value) };
      }
      return result;
    },
  };
  const [report] = await runScenarios(corrupt, [lifecycle], directory, 1);
  assert.ok(report);
  assert.equal(report.cleanup, "deferred");
  assert.match(report.error ?? "", /creation identities differ/);
  assert.equal(closes, 0);
  const recovered = await resumeCleanup(
    backend,
    path.join(report.directory, "report.json"),
  );
  assert.equal(recovered.cleanup, "complete");
  assert.deepEqual(await remaining(model), { active: null, documents: [] });
});

for (const corruptReceipt of [false, true]) {
  test(`partially failed setup ${corruptReceipt ? "rejects a foreign" : "uses its bound"} durable receipt`, async (t) => {
    const { directory, model, backend } = await fixture(t);
    let closes = 0;
    const partial: ScenarioBackend = {
      ...backend,
      async execute(request) {
        const result = await backend.execute(request);
        if (request.source.includes("doc.close(False)")) closes++;
        if (request.source.includes("identity: dict[str, object]")) {
          if (corruptReceipt) {
            const file = path.join(request.directory, "creation.json");
            const receipt = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
              string,
              unknown
            >;
            receipt["requestId"] = "another-owner:request";
            fs.writeFileSync(file, JSON.stringify(receipt));
          }
          return {
            ...result,
            state: "failed",
            stdout: "",
            error: "setup failed after document creation",
          };
        }
        return result;
      },
    };
    const [report] = await runScenarios(partial, [lifecycle], directory, 1);
    assert.ok(report);
    assert.equal(report.status, "failed");
    assert.equal(report.error, "setup failed after document creation");
    assert.equal(report.cleanup, corruptReceipt ? "failed" : "complete");
    assert.equal(closes, corruptReceipt ? 0 : 1);
    if (corruptReceipt)
      assert.match(
        report.cleanupError ?? "",
        /does not belong to this scenario request/,
      );
    else
      assert.deepEqual(await remaining(model), { active: null, documents: [] });
  });
}

test("scenario code cannot change its owned identity or impersonate lifecycle phases", async (t) => {
  const { directory, backend } = await fixture(t);
  const scenario: Scenario = {
    ...lifecycle,
    async run(session) {
      assert.throws(
        () => Object.assign(session.document, { creationId: "foreign" }),
        TypeError,
      );
      assert.throws(
        () => Object.assign(session.report.owner, { clientId: "foreign" }),
        TypeError,
      );
      const before = session.report.requests.length;
      for (const phase of ["create", "export", "cleanup"]) {
        await assert.rejects(
          session.execute(phase, programs.inspect(session.document)),
          /Lifecycle phases/,
        );
      }
      assert.equal(session.report.requests.length, before);
    },
  };
  const [report] = await runScenarios(backend, [scenario], directory, 1);
  assert.equal(report?.status, "passed");
  assert.equal(report.cleanup, "complete");
});
test("a forged target id is rejected before changing a foreign document", async (t) => {
  const { directory, model, backend } = await fixture(t);
  const created = await model.execute(
    programs.program(`import adsk.core, json
app = adsk.core.Application.get()
doc = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
doc.name = 'FOREIGN_SENTINEL'
print(json.dumps(dict(id=doc.creationId)))`),
  );
  assert.equal(created.success, true);
  const sentinel = JSON.parse(created.stdout) as { id: string };
  const corrupt: ScenarioBackend = {
    ...backend,
    async execute(request) {
      if (
        request.target &&
        request.source.includes("p = design.userParameters.add")
      )
        return backend.execute({
          ...request,
          source: request.source.replace(
            request.target.creationId,
            sentinel.id,
          ),
        });
      return backend.execute(request);
    },
  };
  const [report] = await runScenarios(
    corrupt,
    [parameterScenario(0)],
    directory,
    1,
  );
  assert.equal(report?.status, "failed");
  assert.equal(report.cleanup, "complete");
  assert.match(report.error ?? "", /Owned document identity changed/);
  const untouched = await model.execute(
    programs.program(`import adsk.core, adsk.fusion
from typing import cast
doc = adsk.core.Application.get().documents.item(0)
assert doc.creationId == ${JSON.stringify(sentinel.id)}
assert cast(adsk.fusion.Design, doc.products.itemByProductType('DesignProductType')).userParameters.count == 0`),
  );
  assert.equal(untouched.success, true, untouched.error);
});
test("cancellation stops new steps while completed setup still receives cleanup", async (t) => {
  const { directory, model, backend } = await fixture(t);
  const controller = new AbortController();
  const scenario: Scenario = {
    ...lifecycle,
    async run(session) {
      controller.abort(new Error("user cancellation"));
      await session.execute(
        "must-not-run",
        programs.inspect(session.document),
        session.document,
      );
    },
  };
  const [report] = await runScenarios(
    backend,
    [scenario],
    directory,
    1,
    controller.signal,
  );
  assert.equal(report?.status, "failed");
  assert.equal(report.cleanup, "complete");
  assert.equal(
    report.requests.some((request) => request.phase === "must-not-run"),
    false,
  );
  assert.deepEqual(await remaining(model), { active: null, documents: [] });
});
test("both physical wire envelopes execute source and return errors without canned success", async (t) => {
  const { model } = await fixture(t);
  const endpoint = await simulatorEndpoint(model);
  t.after(() => endpoint.close());
  for (const protocol of ["mcp", "addin"] as const) {
    const source = programs.program("print('actual source output')");
    const params =
      protocol === "addin"
        ? { name: "execute_python", arguments: { code: source + '\nrun("")' } }
        : {
            name: "fusion_mcp_execute",
            arguments: { featureType: "script", object: { script: source } },
          };
    const response = await fetch(endpoint.url, {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params,
      }),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /actual source output/);
  }
});

for (const protocol of ["mcp", "addin"] as const) {
  test(`${protocol}: production physical adapter executes Python once when its HTTP reply is lost`, async (t) => {
    const { model } = await fixture(t, protocol);
    const endpoint = await simulatorEndpoint(model);
    t.after(() => endpoint.close());
    const factory = runtimeRequire("./src/dist/fusion-transport/broker") as {
      createBrokerTransport: typeof createBrokerTransport;
    };
    const client = factory.createBrokerTransport(
      {
        url: endpoint.url,
        backend: protocol,
        tool: "fusion_mcp_execute",
        timeoutMs: 5000,
      },
      {
        version: "test",
        requestTimeout: () => 5000,
        bridgeSource: () => {
          throw new Error("No CAD bridge in this test");
        },
      },
    );
    const args = {
      featureType: "script",
      object: {
        script: programs.program(`import adsk.core
app = adsk.core.Application.get()
doc = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
doc.name = 'EXECUTED_ONCE'
print('created')`),
      },
    };
    endpoint.loseNextToolResponse();
    const before = model.executions;
    await assert.rejects(
      client.callTool(args),
      /unknown|socket|reset|aborted/i,
    );
    assert.equal(
      model.executions,
      before + 1,
      "Transport must not retry the mutation",
    );
    const result = await client.callTool({
      featureType: "script",
      object: {
        readOnly: true,
        script: programs.program(
          "import adsk.core\nprint(adsk.core.Application.get().documents.count)",
        ),
      },
    });
    assert.equal(result.failed, false);
    assert.equal(result.text.trim(), "1");
  });
}

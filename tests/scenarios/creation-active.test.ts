import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fixture, remaining } from "./test-support";
import { simulatorFolder } from "./simulator";
import { lifecycle } from "./cases";
import { ScenarioSession, runScenarios, resumeCleanup } from "./runner";
import * as programs from "./programs";

for (const protocol of ["mcp", "addin"] as const) {
  test(`creation observes activation before target selection and cleans only its own document via ${protocol}`, async (t) => {
    const { backend, model, directory } = await fixture(t, protocol);
    const runId = randomUUID();
    const protectedSession = new ScenarioSession(
      backend,
      {
        runId,
        scenarioId: "protected",
        clientId: "scenario:" + runId + ":protected",
      },
      path.join(directory, "protected"),
      undefined,
      simulatorFolder,
    );
    await protectedSession.setup();
    try {
      const before = await protectedSession.execute(
        "write",
        programs.parameter(protectedSession.document, 13),
      );
      let creations = 0;
      const faulty = {
        ...backend,
        async execute(request: Parameters<typeof backend.execute>[0]) {
          if (request.source.includes("identity: dict[str, object]")) {
            creations++;
            return backend.execute({
              ...request,
              source: request.source.replace(
                "    identity: dict[str, object] =",
                `    assert [d for d in app.documents if d.creationId == ${JSON.stringify(protectedSession.document.creationId)}][0].activate()\n    identity: dict[str, object] =`,
              ),
            });
          }
          return backend.execute(request);
        },
      };
      const [report] = await runScenarios(
        faulty,
        [{ ...lifecycle, fixture: simulatorFolder }],
        directory,
        1,
      );
      assert.equal(report?.status, "failed");
      assert.match(report?.error ?? "", /not active at creation completion/u);
      assert.equal(report?.cleanup, "complete");
      assert.equal(creations, 1);
      assert.ok(
        !report?.requests.some((request) =>
          ["export", "save", "inspect"].includes(request.phase),
        ),
      );
      assert.deepEqual(
        await protectedSession.execute(
          "read",
          programs.parameter(protectedSession.document),
        ),
        before,
      );
      const current = (await remaining(model)) as {
        active: string;
        documents: { creationId: string }[];
      };
      assert.equal(current.active, protectedSession.document.creationId);
      assert.deepEqual(
        current.documents.map((document) => document.creationId),
        [protectedSession.document.creationId],
      );
    } finally {
      await protectedSession.cleanup();
    }
    assert.deepEqual(await remaining(model), { active: null, documents: [] });
  });

  test(`contradictory activation observations defer cleanup and recover the original creation without replay via ${protocol}`, async (t) => {
    const { backend, model, directory } = await fixture(t, protocol);
    let creations = 0;
    const faulty = {
      ...backend,
      async execute(request: Parameters<typeof backend.execute>[0]) {
        const result = await backend.execute(request);
        if (request.source.includes("identity: dict[str, object]")) {
          creations++;
          const value = JSON.parse(
            result.stdout.slice(programs.marker.length),
          ) as Record<string, unknown>;
          assert.equal(value["activeCreationId"], value["creationId"]);
          value["activeCreationId"] = "foreign-observation";
          return { ...result, stdout: programs.marker + JSON.stringify(value) };
        }
        return result;
      },
    };
    const [report] = await runScenarios(faulty, [lifecycle], directory, 1);
    assert.equal(report?.status, "failed");
    assert.equal(report?.cleanup, "deferred");
    assert.match(report?.error ?? "", /active observations differ/u);
    const recovered = await resumeCleanup(
      backend,
      path.join(report!.directory, "report.json"),
    );
    assert.equal(recovered.status, "failed");
    assert.equal(recovered.cleanup, "complete");
    assert.equal(creations, 1);
    assert.deepEqual(await remaining(model), { active: null, documents: [] });
  });
}

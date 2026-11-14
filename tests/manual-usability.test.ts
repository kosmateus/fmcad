import { createRequire } from "node:module";
import {
  at,
  record,
  list,
  text as stringValue,
} from "./integration/offline-cli";
const testRoot = process.cwd();
const runtimeRequire = createRequire(
  testRoot + "/tests/manual-usability.test.js",
);
function present<T>(value: T | null | undefined): T {
  assert(value != null);
  return value;
}
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const { main } = runtimeRequire(
  "../src/cli",
) as typeof import("../src/entrypoints/cli");
// These are the verifier, not the documentation-only recipe author.
const { catalog, validateCad } = runtimeRequire(
  "../src/cad",
) as typeof import("../src/composition/cad-execution");
const { validateBatch, runBatch } = runtimeRequire(
  "../src/batch",
) as typeof import("../src/composition/batch");

async function help(...command: string[]) {
  let text = "";
  await main(["help", ...command], {
    stdout: {
      write: (value) => {
        text += value;
      },
    },
    loadConfig: () =>
      assert.fail("Documentation exercise must not load a real backend"),
  });
  return text;
}

test("black-box help supplies a complete two-component recipe with no guessed tokens or indices", async () => {
  const text = await help("batch", "run");
  const payloads = [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map(
    (match) => record(JSON.parse(present(match[1]))),
  );
  const recipe = payloads.find(
    (value) => value["runId"] === "documentation-workflow-01",
  );
  assert.ok(recipe, "The actual CLI output must contain the published recipe");
  assert.equal(
    list(present(recipe)["operations"]).filter(
      (step) => at(step, "operation") === "component.create",
    ).length,
    2,
  );
  assert.equal(list(present(recipe)["operations"]).length, 11);
  assert.doesNotMatch(JSON.stringify(recipe), /"token"|"index"/);
  const result = validateBatch(present(recipe), catalog);
  assert.equal(result.success, true, result.errors.join("\n"));
  assert.equal(
    at(
      list(
        at(
          present(result.operations).find(
            (step) => step.operation === "param.apply",
          ),
          "data",
          "parameters",
        ),
      ).find((p) => at(p, "name") === "width"),
      "expression",
    ),
    "40 mm",
  );
  assert.equal(
    present(
      present(result.operations).find(
        (step) => at(step, "operation") === "sketch.dimension",
      ),
    ).data["expression"],
    "width",
  );
  assert.equal(
    present(
      present(result.operations).find(
        (step) => at(step, "operation") === "model.extrude",
      ),
    ).data["distance"],
    "height",
  );
});

test("documentation-only recipe traverses real reference substitution, scopes, failure and replay with mock outputs", async (t) => {
  const text = await help("batch", "run");
  const recipe = [...text.matchAll(/```json\n([\s\S]*?)\n```/g)]
    .map((match) => record(JSON.parse(present(match[1]))))
    .find((value) => value["runId"] === "documentation-workflow-01");
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "fmcad-doc-usability-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  present(recipe)["reportPath"] = path.join(directory, "success");
  const context = {
    doc: "Model",
    component: "root",
    projectId: null,
    preview: false,
  };
  let calls = 0;
  const byOperation: Record<string, Record<string, unknown>> = {};
  const token = (name: unknown) => ({ token: `MOCK_${name}` });
  const execute: Parameters<typeof runBatch>[3] = async (
    _client,
    operation,
    data,
    scope,
  ) => {
    validateCad(operation, data);
    calls++;
    byOperation[operation] = data;
    let result;
    if (operation === "param.apply")
      result = {
        parameters: data["parameters"],
        prevalidated: true,
        atomic: false,
      };
    else if (operation === "component.create")
      result = {
        component: token(data["name"]),
        occurrence: token(data["name"] + ":1"),
        bodies: [],
        atomic: false,
      };
    else {
      assert.deepEqual(
        scope.component,
        token(
          ["shape.box", "entity.inspect"].includes(operation)
            ? "DocBoxPart"
            : "DocRoundPart",
        ),
      );
      if (operation === "sketch.create") result = { sketch: token("Section") };
      if (operation === "sketch.geometry") {
        assert.deepEqual(data["sketch"], token("Section"));
        result = {
          entities: [token("anchor"), token("rim")],
          refs: { anchor: token("anchor"), rim: token("rim") },
        };
      }
      if (operation === "sketch.constrain") {
        assert.deepEqual(data["entities"], [
          token("anchor"),
          { entity: token("rim"), point: "center" },
        ]);
        result = { constraint: token("center-constraint") };
      }
      if (operation === "sketch.dimension") {
        assert.deepEqual(data["entities"], [token("rim")]);
        assert.equal(data["expression"], "width");
        result = {
          dimension: token("diameter"),
          parameter: "d1",
          expression: "width",
        };
      }
      if (operation === "model.extrude") {
        assert.deepEqual(data["profile"], {
          kind: "profile",
          sketch: token("Section"),
        });
        assert.equal(data["distance"], "height");
        result = {
          feature: token("RoundSolid"),
          bodies: [token("round-body")],
          healthState: 0,
          message: "",
        };
      }
      if (operation === "shape.box")
        result = {
          feature: token("BoxSolid"),
          bodies: [token("box-body")],
          healthState: 0,
          message: "",
          helpers: [],
          recipe: "box",
        };
      if (operation === "sketch.check")
        result = {
          sketch: token("Section"),
          isFullyConstrained: true,
          profileCount: 1,
          healthState: 0,
          message: "",
          underconstrained: [],
        };
      if (operation === "entity.inspect") {
        assert.deepEqual(data["ref"], token("box-body"));
        result = data["ref"];
      }
    }
    assert.ok(result, operation);
    return { success: true, operation, document: "Model", result, created: [] };
  };
  const report = await runBatch(
    null,
    present(recipe),
    context,
    execute,
    catalog,
  );
  assert.equal(report.success, true);
  assert.equal(calls, list(present(recipe)["operations"]).length);
  assert.equal(
    at(
      list(at(byOperation, "sketch.geometry", "geometry")).find(
        (entity) => at(entity, "type") === "circle",
      ),
      "radius",
    ),
    "10 mm",
  );
  assert.equal(
    (
      await runBatch(
        null,
        present(recipe),
        context,
        () => assert.fail("Replay must not execute"),
        catalog,
      )
    )["replayed"],
    true,
  );
  present(recipe)["reportPath"] = path.join(directory, "failure");
  const failed = await runBatch(
    null,
    present(recipe),
    context,
    async (...args) => {
      if (args[1] === "sketch.dimension")
        throw new Error("MOCK solver failure after possible partial mutation");
      return execute(...args);
    },
    catalog,
  );
  const failureIndex = list(present(recipe)["operations"]).findIndex(
    (step) => at(step, "operation") === "sketch.dimension",
  );
  assert.equal(at(failed.steps, failureIndex, "status"), "unknown");
  for (const step of list(failed.steps).slice(failureIndex + 1))
    assert.equal(record(step)["status"], "skipped");
  await assert.rejects(
    runBatch(
      null,
      present(recipe),
      context,
      () => assert.fail("No unsafe retry"),
      catalog,
    ),
    /operator inspection/,
  );
});

test("documentation-only sketch-to-solid recipe can be isolated and offline-previewed using published contracts", async () => {
  const text = await help("batch", "run");
  const recipe = [...text.matchAll(/```json\n([\s\S]*?)\n```/g)]
    .map((match) => record(JSON.parse(present(match[1]))))
    .find((value) => value["runId"] === "documentation-workflow-01");
  // Select the documented round-part workflow; do not inspect handlers or construct guessed refs.
  const round = {
    ...recipe,
    runId: "documented-round-only",
    operations: list(present(recipe)["operations"]).filter(
      (step) =>
        !["boxPart", "boxSolid", "boxInspect"].includes(
          stringValue(at(step, "id")),
        ),
    ),
  };
  const validation = validateBatch(round, catalog);
  assert.equal(validation.success, true, validation.errors.join("\n"));
  let output = "";
  assert.equal(
    await main(
      [
        "definition",
        "instantiate",
        "--doc",
        "Model",
        "--data",
        JSON.stringify(round),
        "--preview",
      ],
      {
        stdout: {
          write: (text) => {
            output += text;
          },
        },
        loadConfig: () => assert.fail("Must remain offline"),
      },
    ),
    0,
  );
  const preview = JSON.parse(output);
  assert.equal(preview.mutated, false);
  assert.deepEqual(preview.operations, validation.operations);
});

test("symbolic result-wiring examples are explicitly batch steps, never misleading standalone calls", async () => {
  const text = await help("visibility", "restore");
  assert.match(text, /Batch-step example, NOT a standalone --data payload/);
  const step = [...text.matchAll(/```json\n([\s\S]*?)\n```/g)]
    .map((match) => record(JSON.parse(present(match[1]))))
    .find((value) => value["operation"] === "visibility.restore");
  assert.equal(at(step, "data", "state", "$ref"), "hide.result.restoreState");
  assert.match(
    text.replace(/\s+/g, " "),
    /substitute actual returned JSON values first/,
  );
});

test("help distinguishes outer-only batch validation from GM06 nested preflight", async () => {
  const text = await help("batch", "validate");
  assert.match(text, /unknown nested geometry\/constraint fields/);
  const malformed = {
    runId: "invalid-nested-example",
    operations: [
      {
        id: "geometry",
        operation: "sketch.geometry",
        data: {
          sketch: "Section",
          geometry: [
            { type: "circle", radius: 12, center: [0, 0, 0], colour: "red" },
          ],
        },
      },
    ],
  };
  // This is an intentionally invalid HANDLER payload accepted by the outer-only offline validator.
  const validation = validateBatch(malformed, catalog);
  assert.equal(validation.success, true);
  assert.match(validation.limitations.join("\n"), /nested schemas\/types/);
  assert.doesNotMatch(
    validation.limitations.join("\n"),
    /Use stable document IDs/,
  );
  assert.match(validation.limitations.join("\n"), /doc status/);
  assert.match(
    await help("sketch", "geometry"),
    /checks GM06 nested input shapes/i,
  );
  let output = "",
    errors = "";
  const code = await main(
    [
      "sketch",
      "geometry",
      "--preview",
      "--doc",
      "Model",
      "--data",
      JSON.stringify(present(malformed.operations[0]).data),
    ],
    {
      stdout: {
        write: (text) => {
          output += text;
        },
      },
      stderr: {
        write: (text) => {
          errors += text;
        },
      },
      setExitCode: () => {},
      loadConfig: () => assert.fail("Must remain offline"),
    },
  );
  assert.notEqual(code, 0);
  assert.equal(output, "");
  assert.match(errors, /unsupported inputs: colour/);
  assert.match(await help("tools"), /Usage:\n  fmcad tools \[--json\]/);
  assert.match(
    await help("export"),
    /Legacy export --out requires an absolute WSL path/,
  );
  for (const mode of [null, false, 0, ""])
    assert.equal(validateBatch({ ...malformed, mode }, catalog).success, false);
});

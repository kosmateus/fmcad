import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Scenario, ScenarioSession } from "./runner";
import { number, record, type FixtureFolder } from "./contracts";
import { boxState } from "./box-cases";

const step = (
  id: string,
  operation: string,
  data: Record<string, unknown>,
) => ({ id, operation, data, onExisting: "reuse" });
function rows(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value));
  return value.map(record);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + canonical(record(value)[key]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
function matching(
  session: ScenarioSession,
  output: Record<string, unknown>,
  request: Record<string, unknown>,
): void {
  const expected = { ...request };
  delete expected["reportPath"];
  delete expected["mode"];
  const context = {
    doc: session.document.name,
    docId: session.document.creationId,
    docFileId: session.document.file!.fileId,
    component: "root",
  };
  assert.equal(output["runId"], request["runId"]);
  assert.deepEqual(output["request"], expected);
  assert.deepEqual(output["context"], context);
  assert.equal(
    output["requestHash"],
    createHash("sha256")
      .update(canonical({ request: expected, context }))
      .digest("hex"),
  );
  const directory = String(request["reportPath"]);
  const files = fs
    .readdirSync(directory)
    .filter((name) => /^\d{8}\.json$/u.test(name))
    .sort();
  assert.ok(files.length > 0);
  const last = record(
    JSON.parse(
      fs.readFileSync(path.join(directory, files.at(-1)!), "utf8"),
    ) as unknown,
  );
  assert.equal(last["requestHash"], output["requestHash"]);
  assert.deepEqual(last["steps"], output["steps"]);
  assert.equal(fs.existsSync(path.join(directory, "run.lock")), false);
}
export function transactionScenarios(
  folder: FixtureFolder,
  owners = 2,
): Scenario[] {
  return Array.from({ length: owners }, (_, index): Scenario => ({
    id: "definition-transaction-" + index,
    fixture: folder,
    requires: [
      "documents",
      "saved-fixtures",
      "dimensioned-rectangle",
      "cad-commands",
    ],
    async run(session) {
      const request = {
        runId: "literal",
        reportPath: path.join(session.directory, "literal"),
        parameters: {
          name: "LiteralBox",
          width: "23 mm",
          depth: "11 mm",
          height: "7 mm",
        },
        operations: [
          step("box", "shape.box", {
            name: { $param: "name" },
            width: { $param: "width" },
            depth: { $param: "depth" },
            height: { $param: "height" },
          }),
          step("feature", "entity.inspect", {
            ref: { $ref: "box.result.feature" },
          }),
          step("bounds", "measure.bounds", {
            ref: { $ref: "box.result.bodies.0" },
            units: "mm",
          }),
          step("volume", "measure.volume", {
            ref: { $ref: "box.result.bodies.0" },
            units: "mm3",
          }),
        ],
      };
      const initial = await session.cad(
        "cad-definition",
        "definition.instantiate",
        request,
      );
      assert.equal(initial["success"], true, JSON.stringify(initial));
      matching(session, initial, request);
      const steps = rows(initial["steps"]);
      assert.deepEqual(
        steps.map((row) => row["status"]),
        ["success", "success", "success", "success"],
      );
      assert.deepEqual(record(steps[0]!["request"])["data"], {
        name: "LiteralBox",
        width: "23 mm",
        depth: "11 mm",
        height: "7 mm",
      });
      const created = record(record(steps[0]!["output"])["result"]);
      assert.deepEqual(
        record(record(steps[1]!["request"])["data"])["ref"],
        created["feature"],
      );
      assert.ok(Array.isArray(created["bodies"]));
      assert.deepEqual(
        record(record(steps[2]!["request"])["data"])["ref"],
        created["bodies"][0],
      );
      const bounds = record(record(steps[2]!["output"])["result"]);
      assert.equal(bounds["units"], "mm");
      const size = bounds["size"];
      assert.ok(Array.isArray(size));
      [23, 11, 7].forEach((expected, i) =>
        assert.ok(Math.abs(number(size[i]) - expected) <= 0.001),
      );
      assert.ok(
        Math.abs(
          number(record(record(steps[3]!["output"])["result"])["value"]) - 1771,
        ) <= 0.02,
      );
      const before = await session.execute(
        "before-replay",
        boxState(session.document),
      );
      const replayed = await session.cad(
        "cad-replay",
        "definition.instantiate",
        request,
      );
      assert.equal(replayed["success"], true);
      assert.equal(replayed["replayed"], true);
      matching(session, replayed, request);
      assert.deepEqual(replayed["steps"], initial["steps"]);
      assert.deepEqual(
        await session.execute("after-replay", boxState(session.document)),
        before,
      );
      const changed = structuredClone(request);
      changed.parameters.name = "MustNotExist";
      changed.parameters.width = "31 mm";
      await assert.rejects(
        session.cad("cad-changed-run", "definition.instantiate", changed),
        /Saved request\/context hash differs; replay refused/u,
      );
      assert.deepEqual(
        await session.execute(
          "after-rejected-replay",
          boxState(session.document),
        ),
        before,
      );
      const negative = {
        runId: "negative",
        reportPath: path.join(session.directory, "negative"),
        atomic: false,
        operations: [
          step("check", "check", {
            measurement: {
              operation: "measure.volume",
              data: { ref: created["bodies"][0], units: "mm3" },
            },
            expected: "1 mm^3",
            tolerance: "0.001 mm^3",
          }),
          step("later", "shape.box", {
            name: "SkippedBox",
            width: "5 mm",
            depth: "6 mm",
            height: "7 mm",
          }),
        ],
      };
      const failed = await session.cad("cad-negative", "batch.run", negative);
      assert.equal(failed["success"], false);
      assert.equal(failed["status"], "failed");
      const failedSteps = rows(failed["steps"]);
      assert.equal(
        record(record(failedSteps[0]!["output"])["result"])["passed"],
        false,
      );
      assert.equal(failedSteps[1]!["status"], "skipped");
      assert.equal(failedSteps[1]!["request"], undefined);
      matching(session, failed, negative);
      assert.deepEqual(
        await session.execute("after-negative", boxState(session.document)),
        before,
      );
      for (const [caseIndex, item] of [
        {
          parameters: {},
          width: { $param: "missing" },
          error: /Unknown parameter: missing/u,
        },
        {
          parameters: { width: "3 mm" },
          width: { $param: "width + 1" },
          error: /Unknown parameter: width \+ 1/u,
        },
        {
          parameters: { width: "3 mm" },
          width: { $param: "width", eval: true },
          error: /\$param must be the sole key/u,
        },
      ].entries()) {
        const invalid = await session.cad(
          "cad-invalid-" + caseIndex,
          "definition.instantiate",
          {
            runId: "unsupported_" + caseIndex,
            reportPath: path.join(
              session.directory,
              "unsupported_" + caseIndex,
            ),
            parameters: item.parameters,
            operations: [
              step("box", "shape.box", {
                name: "UnsupportedBox",
                width: item.width,
                depth: "2 mm",
                height: "3 mm",
              }),
            ],
          },
        );
        assert.equal(invalid["success"], false);
        assert.ok(Array.isArray(invalid["errors"]));
        assert.match(invalid["errors"].join("\n"), item.error);
      }
      assert.deepEqual(
        await session.execute("after-invalid", boxState(session.document)),
        before,
      );
      const literal = '__import__("builtins").str(23) + " mm"';
      const noEvalRequest = {
        runId: "no_eval",
        reportPath: path.join(session.directory, "no_eval"),
        parameters: { width: literal },
        operations: [
          step("box", "shape.box", {
            name: "NoEvalBox",
            width: { $param: "width" },
            depth: "2 mm",
            height: "3 mm",
          }),
          step("later", "shape.box", {
            name: "NoEvalLater",
            width: "2 mm",
            depth: "2 mm",
            height: "2 mm",
          }),
        ],
      };
      const preview = await session.cad(
        "cad-literal-preview",
        "definition.instantiate",
        { ...noEvalRequest, mode: "preview" },
      );
      assert.equal(
        record(rows(preview["operations"])[0]!["data"])["width"],
        literal,
      );
      const noEval = await session.cad(
        "cad-literal-rejection",
        "definition.instantiate",
        noEvalRequest,
      );
      assert.equal(noEval["success"], false);
      const noEvalSteps = rows(noEval["steps"]);
      assert.equal(
        record(record(noEvalSteps[0]!["request"])["data"])["width"],
        literal,
      );
      assert.match(
        String(record(noEvalSteps[0]!["error"])["message"]),
        /Invalid or incompatible expression/u,
      );
      assert.equal(noEvalSteps[1]!["status"], "skipped");
      assert.deepEqual(
        await session.execute("after-code-literal", boxState(session.document)),
        before,
      );
      const numericRequest = {
        runId: "numeric",
        reportPath: path.join(session.directory, "numeric"),
        parameters: { width: "18 mm" },
        operations: [
          step("parameters", "param.apply", {
            parameters: [
              {
                name: "test_width",
                expression: { $param: "width" },
                unit: "mm",
              },
              { name: "test_depth", expression: "test_width / 2", unit: "mm" },
              {
                name: "test_height",
                expression: "test_depth + 3 mm",
                unit: "mm",
              },
            ],
          }),
          step("box", "shape.box", {
            name: "ParameterBox",
            width: "test_width",
            depth: "test_depth",
            height: "test_height",
          }),
          step("bounds", "measure.bounds", {
            ref: { $ref: "box.result.bodies.0" },
            units: "mm",
          }),
          step("volume", "measure.volume", {
            ref: { $ref: "box.result.bodies.0" },
            units: "mm3",
          }),
        ],
      };
      const numeric = await session.cad(
        "cad-numeric",
        "definition.instantiate",
        numericRequest,
      );
      assert.equal(numeric["success"], true, JSON.stringify(numeric));
      matching(session, numeric, numericRequest);
      const numericSteps = rows(numeric["steps"]);
      const numericSize = record(record(numericSteps[2]!["output"])["result"])[
        "size"
      ];
      assert.ok(Array.isArray(numericSize));
      [18, 9, 12].forEach((expected, i) =>
        assert.ok(Math.abs(number(numericSize[i]) - expected) <= 0.001),
      );
      assert.ok(
        Math.abs(
          number(
            record(record(numericSteps[3]!["output"])["result"])["value"],
          ) - 1944,
        ) <= 0.02,
      );
    },
  }));
}

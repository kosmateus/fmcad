import assert from "node:assert/strict";
import type { Scenario, ScenarioSession } from "./runner";
import { number, record, text, type FixtureFolder } from "./contracts";
import {
  parameterBatch,
  parameterCommand,
  type ParameterCommand,
} from "./parameter-programs";

export function results(
  value: Record<string, unknown>,
): Record<string, unknown>[] {
  assert.ok(Array.isArray(value["commands"]));
  return value["commands"].map(record);
}
export function parameters(
  value: Record<string, unknown>,
): Record<string, unknown>[] {
  assert.ok(Array.isArray(value["parameters"]));
  return value["parameters"].map(record);
}
function succeeded(value: Record<string, unknown>): void {
  assert.equal(value["error"], null);
  assert.doesNotMatch(text(value["output"]), /^ERROR /m);
  assert.match(text(value["output"]), /\nDONE\n$/);
}
async function command(
  session: ScenarioSession,
  phase: string,
  operation: string,
  args: string[] = [],
) {
  const rows = results(
    await session.execute(
      phase,
      parameterCommand(session.document, operation, args),
    ),
  );
  assert.equal(rows.length, 1);
  succeeded(rows[0]!);
  return rows[0]!;
}
function near(actual: unknown, expected: number): void {
  assert.ok(
    Math.abs(number(actual) - expected) < 1e-9,
    `${actual} != ${expected}`,
  );
}

export function parameterScenarios(folder: FixtureFolder): Scenario[] {
  const common = {
    fixture: folder,
    requires: [
      "documents",
      "fixture-export",
      "saved-fixtures",
      "parameter-crud",
      "parameter-expressions",
    ],
  };
  return [
    {
      ...common,
      id: "parameter-crud",
      async run(session) {
        const added = await command(session, "add", "param_add", [
          "migration_width",
          "10 mm",
          "mm",
          "live migration test",
        ]);
        assert.equal(parameters(added).length, 1);
        assert.match(
          text(added["output"]),
          /CREATED_PARAM name=migration_width expr=10 mm unit=mm/,
        );
        const listed = await command(session, "list", "param_list");
        assert.match(
          text(listed["output"]),
          /PARAM name=migration_width expr=10 mm/,
        );
        const changed = await command(session, "set", "param_set", [
          "migration_width",
          "20 mm",
        ]);
        near(parameters(changed)[0]!["value"], 2);
        const renamed = await command(session, "rename", "param_rename", [
          "migration_width",
          "migration_width_renamed",
        ]);
        assert.equal(
          parameters(renamed)[0]!["name"],
          "migration_width_renamed",
        );
        const deleted = await command(session, "delete", "param_delete", [
          "migration_width_renamed",
        ]);
        assert.deepEqual(parameters(deleted), []);
        const final = await command(session, "final-list", "param_list");
        assert.doesNotMatch(
          text(final["output"]),
          /PARAM name=migration_width/,
        );
      },
    },
    {
      ...common,
      id: "parameter-units",
      async run(session) {
        const cases = [
          ["millimeters", "10 mm", "mm", 1],
          ["centimeters", "2 cm", "cm", 2],
          ["meters", "0.03 m", "m", 3],
          ["inches", "1 in", "in", 2.54],
          ["feet", "1 ft", "ft", 30.48],
          ["yards", "1 yd", "yd", 91.44],
          ["degrees", "180 deg", "deg", Math.PI],
          ["radians", "1 rad", "rad", 1],
          ["count", "2", "", 2],
          ["scientific", "1e-2 m", "mm", 1],
        ] as const;
        const rows = results(
          await session.execute(
            "literal-units",
            parameterBatch(
              session.document,
              cases.map(([name, expression, unit]) => ({
                operation: "param_add",
                args: [name, expression, unit],
              })),
            ),
          ),
        );
        assert.equal(rows.length, cases.length);
        for (const [index, [name, , unit, value]] of cases.entries()) {
          const row = rows[index]!;
          succeeded(row);
          const actual = parameters(row).find((p) => p["name"] === name);
          assert.ok(actual);
          assert.equal(actual["unit"], unit);
          near(actual["value"], value);
          assert.equal(parameters(row).length, index + 1);
        }
      },
    },
    {
      ...common,
      id: "parameter-dependencies",
      async run(session) {
        const steps: ParameterCommand[] = [
          { operation: "param_add", args: ["width", "10 mm"] },
          { operation: "param_add", args: ["height", "width * 2"] },
          { operation: "param_set", args: ["width", "20 mm"] },
          { operation: "param_rename", args: ["width", "baseWidth"] },
          { operation: "param_delete", args: ["baseWidth"] },
          { operation: "param_delete", args: ["height"] },
          { operation: "param_delete", args: ["baseWidth"] },
        ];
        const rows = results(
          await session.execute(
            "dependencies",
            parameterBatch(session.document, steps),
          ),
        );
        assert.equal(rows.length, steps.length);
        rows.forEach((row, index) => {
          if (index !== 4) succeeded(row);
        });
        near(parameters(rows[1]!)[1]!["value"], 2);
        near(parameters(rows[2]!)[1]!["value"], 4);
        assert.match(text(parameters(rows[3]!)[1]!["expression"]), /baseWidth/);
        // Fusion may return false, raise, or return true while retaining a dependency.
        // In all cases the command must not claim deletion; readback must retain both.
        assert.doesNotMatch(text(rows[4]!["output"]), /DELETED_PARAM/);
        assert.ok(
          rows[4]!["error"] !== null ||
            /^ERROR /m.test(text(rows[4]!["output"])),
        );
        assert.deepEqual(parameters(rows[4]!), parameters(rows[3]!));
        assert.deepEqual(parameters(rows[6]!), []);
      },
    },
    {
      ...common,
      id: "parameter-rejections",
      async run(session) {
        const steps: ParameterCommand[] = [
          { operation: "param_add", args: ["width", "10 mm"] },
          { operation: "param_add", args: ["other", "5 mm"] },
          {
            operation: "param_add",
            args: ["width", "999 mm", "cm", "must not overwrite"],
          },
          { operation: "param_set", args: ["missing", "2 mm"] },
          { operation: "param_rename", args: ["missing", "newName"] },
          { operation: "param_delete", args: ["missing"] },
          { operation: "param_set", args: ["width", "width + 1 mm"] },
          { operation: "param_set", args: ["width", "3 deg"] },
          { operation: "param_add", args: ["wrongDimension", "3 deg", "mm"] },
          { operation: "param_add", args: ["broken", "1 +", "mm"] },
          { operation: "param_rename", args: ["width", "other"] },
        ];
        const rows = results(
          await session.execute(
            "rejections",
            parameterBatch(session.document, steps),
          ),
        );
        assert.equal(rows.length, steps.length);
        succeeded(rows[0]!);
        succeeded(rows[1]!);
        succeeded(rows[2]!);
        assert.match(text(rows[2]!["output"]), /EXISTS name=width/);
        for (const row of rows.slice(2))
          assert.deepEqual(parameters(row), parameters(rows[1]!));
        for (const row of rows.slice(3))
          assert.ok(
            row["error"] !== null || /^ERROR /m.test(text(row["output"])),
          );
      },
    },
  ];
}

import assert from "node:assert/strict";
import type { Scenario, ScenarioSession } from "./runner";
import { number, record, text, type FixtureFolder } from "./contracts";
import { documentCommand } from "./document-programs";
import { program, guard, emit } from "./programs";

export function rows(
  value: Record<string, unknown>,
  field: string,
): Record<string, unknown>[] {
  assert.ok(Array.isArray(value[field]));
  return value[field].map(record);
}
function vector(value: unknown): number[] {
  assert.ok(Array.isArray(value));
  assert.equal(value.length, 3);
  return value.map(number);
}
async function command(
  session: ScenarioSession,
  phase: string,
  operation: string,
  args: string[] = [],
  success = true,
) {
  const result = await session.execute(
    phase,
    documentCommand(session.document, operation, args),
  );
  if (success) {
    assert.equal(result["error"], null);
    assert.doesNotMatch(text(result["output"]), /^ERROR /m);
    assert.match(text(result["output"]), /\nDONE\n$/);
  } else
    assert.ok(
      result["error"] !== null || /^ERROR /m.test(text(result["output"])),
    );
  return result;
}

export function documentScenarios(folder: FixtureFolder): Scenario[] {
  const common = {
    fixture: folder,
    requires: [
      "documents",
      "saved-fixtures",
      "fixture-export",
      "construction-planes",
      "component-tree",
      "document-units",
    ],
  };
  return [
    {
      ...common,
      id: "construction-planes",
      async run(session) {
        const offset = await command(session, "offset", "plane_add", [
          "MigrationOffset",
          "offset",
          "XY",
          "10 mm",
        ]);
        assert.equal(rows(offset, "planes").length, 1);
        assert.equal(vector(rows(offset, "planes")[0]!["origin"])[2], 1);
        const listed = await command(session, "list", "plane_list");
        assert.match(text(listed["output"]), /PLANE name=MigrationOffset/);
        const mid = await command(session, "mid", "plane_add", [
          "MigrationMid",
          "mid",
          "XY",
          "MigrationOffset",
        ]);
        const midpoint = rows(mid, "planes").find(
          (p) => p["name"] === "MigrationMid",
        );
        assert.ok(midpoint);
        assert.equal(vector(midpoint["origin"])[2], 0.5);
        const renamed = await command(session, "rename", "plane_rename", [
          "MigrationMid",
          "MigrationMidRenamed",
        ]);
        assert.ok(
          rows(renamed, "planes").some(
            (p) => p["name"] === "MigrationMidRenamed",
          ),
        );
        const renamedList = await command(
          session,
          "renamed-list",
          "plane_list",
        );
        assert.match(
          text(renamedList["output"]),
          /PLANE name=MigrationMidRenamed/,
        );
        const deleted = await command(session, "delete", "plane_delete", [
          "MigrationMidRenamed",
        ]);
        assert.deepEqual(rows(deleted, "planes"), rows(offset, "planes"));
        const deletedList = await command(
          session,
          "deleted-list",
          "plane_list",
        );
        assert.doesNotMatch(
          text(deletedList["output"]),
          /PLANE name=MigrationMid/,
        );
        const angled = await command(session, "angle", "plane_add", [
          "MigrationAngle",
          "angle",
          "XY",
          "X",
          "30 deg",
        ]);
        assert.match(
          text(angled["output"]),
          /CREATED_PLANE name=MigrationAngle/,
        );
        const angleList = await command(session, "angle-list", "plane_list");
        assert.match(text(angleList["output"]), /PLANE name=MigrationAngle/);
        const angle = rows(angled, "planes").find(
          (p) => p["name"] === "MigrationAngle",
        );
        assert.ok(angle);
        const normal = vector(angle["normal"]);
        assert.ok(
          Math.abs(Math.abs(normal[2]!) - Math.cos(Math.PI / 6)) < 1e-9,
        );
        const duplicate = await command(session, "duplicate", "plane_add", [
          "MigrationOffset",
          "offset",
          "XY",
          "999 mm",
        ]);
        assert.match(text(duplicate["output"]), /EXISTS name=MigrationOffset/);
        assert.deepEqual(rows(duplicate, "planes"), rows(angled, "planes"));
        const invalid = await command(
          session,
          "invalid",
          "plane_add",
          ["MissingReference", "offset", "NoSuchPlane", "10 mm"],
          false,
        );
        assert.deepEqual(rows(invalid, "planes"), rows(angled, "planes"));
        const coplanar = await command(
          session,
          "coplanar",
          "plane_add",
          ["Coplanar", "mid", "XY", "XY"],
          false,
        );
        assert.deepEqual(rows(coplanar, "planes"), rows(angled, "planes"));
      },
    },
    {
      ...common,
      id: "component-tree",
      async run(session) {
        const parent = await command(session, "parent", "comp_add", [
          "MigrationComponent",
        ]);
        assert.match(
          text(parent["output"]),
          /CREATED_COMP name=MigrationComponent parent=/,
        );
        assert.equal(rows(parent, "components").length, 2);
        const parentList = await command(session, "parent-list", "comp_list");
        assert.match(
          text(parentList["output"]),
          /COMP name=MigrationComponent parent=/,
        );
        const child = await command(session, "child", "comp_add", [
          "NestedComponent",
          "MigrationComponent",
        ]);
        assert.equal(rows(child, "components").length, 3);
        assert.ok(
          rows(child, "components").some(
            (c) =>
              c["name"] === "NestedComponent" &&
              c["parent"] === "MigrationComponent",
          ),
        );
        const listed = await command(session, "list", "comp_list");
        assert.match(
          text(listed["output"]),
          /COMP name=NestedComponent parent=MigrationComponent/,
        );
        const duplicate = await command(session, "duplicate", "comp_add", [
          "NestedComponent",
        ]);
        assert.match(text(duplicate["output"]), /EXISTS name=NestedComponent/);
        assert.deepEqual(
          rows(duplicate, "components"),
          rows(child, "components"),
        );
        const invalid = await command(
          session,
          "invalid-parent",
          "comp_add",
          ["Rejected", "MissingComponent"],
          false,
        );
        assert.deepEqual(
          rows(invalid, "components"),
          rows(child, "components"),
        );
        // Duplicate component names can arrive from native editing/imports.
        const parents = await session.execute(
          "duplicate-parent-setup",
          program(`${guard(session.document)}
root = design.rootComponent
for index in range(2):
    occurrence = root.occurrences.addNewComponent(adsk.core.Matrix3D.create())
    occurrence.component.name = "AmbiguousParent"
${emit("dict(creationId=doc.creationId, count=sum(1 for c in design.allComponents if c.name == 'AmbiguousParent'))")}
`),
        );
        assert.equal(parents["count"], 2);
        const ambiguousBefore = await command(
          session,
          "ambiguous-before",
          "comp_list",
        );
        for (const [phase, args] of [
          ["ambiguous-parent", ["MustNotExist", "AmbiguousParent"]],
          ["ambiguous-existing", ["AmbiguousParent"]],
        ] as const) {
          const rejected = await command(
            session,
            phase,
            "comp_add",
            [...args],
            false,
          );
          assert.match(String(rejected["error"]), /ambiguous component name/);
          assert.deepEqual(
            rows(rejected, "components"),
            rows(ambiguousBefore, "components"),
          );
          assert.equal(
            rejected["timelineCount"],
            ambiguousBefore["timelineCount"],
          );
          assert.doesNotMatch(
            text(rejected["output"]),
            /CREATED_COMP|EXISTS |DONE/,
          );
        }
        const rootCollision = await session.execute(
          "duplicate-root-name-setup",
          program(`${guard(session.document)}
root = design.rootComponent
occurrence = root.occurrences.addNewComponent(adsk.core.Matrix3D.create())
occurrence.component.name = root.name
${emit("dict(creationId=doc.creationId, count=sum(1 for c in design.allComponents if c.name == root.name))")}
`),
        );
        assert.equal(rootCollision["count"], 2);
        const rootBefore = await command(session, "root-before", "comp_list");
        const rootName = text(rows(rootBefore, "components")[0]!["name"]);
        const rootRejected = await command(
          session,
          "ambiguous-root",
          "comp_add",
          ["MustNotExist", rootName],
          false,
        );
        assert.match(String(rootRejected["error"]), /ambiguous component name/);
        assert.deepEqual(
          rows(rootRejected, "components"),
          rows(rootBefore, "components"),
        );
        assert.equal(
          rootRejected["timelineCount"],
          rootBefore["timelineCount"],
        );
      },
    },
    {
      ...common,
      id: "document-units",
      async run(session) {
        for (const unit of ["cm", "mm", "in"]) {
          const changed = await command(session, "units-" + unit, "units", [
            unit,
          ]);
          assert.equal(changed["units"], unit);
        }
        const invalid = await command(
          session,
          "invalid-unit",
          "units",
          ["unsupported"],
          false,
        );
        assert.equal(invalid["units"], "in");
        const empty = await command(session, "empty-timeline", "rollback", [
          "0",
        ]);
        assert.equal(empty["marker"], 0);
        assert.equal(empty["timelineCount"], 0);
        for (const position of ["-1", "1"]) {
          const rejected = await command(
            session,
            "invalid-marker-" + position,
            "rollback",
            [position],
            false,
          );
          assert.equal(rejected["marker"], 0);
          assert.equal(rejected["timelineCount"], 0);
        }
      },
    },
  ];
}

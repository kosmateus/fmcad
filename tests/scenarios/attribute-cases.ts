import assert from "node:assert/strict";
import type { Scenario, ScenarioSession } from "./runner";
import { record, text, type FixtureFolder } from "./contracts";
import { emit, guard, program } from "./programs";
import { createBox } from "./box-cases";
import { cadCommand, cadSequence } from "./cad-programs";

export async function attributeBody(
  session: ScenarioSession,
): Promise<Record<string, unknown>> {
  await session.execute("create-box", createBox(session.document, 10));
  return attributeBodyRef(session);
}

async function attributeBodyRef(
  session: ScenarioSession,
): Promise<Record<string, unknown>> {
  const state = await session.execute(
    "body-ref",
    program(`${guard(session.document)}
assert design.rootComponent.bRepBodies.count == 1
body = design.rootComponent.bRepBodies.item(0)
${emit("dict(creationId=doc.creationId, ref=dict(kind='body', token=body.entityToken, name=body.name, component=dict(kind='component', name='root')))")}`),
  );
  const ref = record(state["ref"]);
  text(ref["token"]);
  return ref;
}

export async function attribute(
  session: ScenarioSession,
  action: "get" | "set",
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const operation = "entity.attribute." + action;
  const result = await session.execute(
    action + "-attribute",
    cadCommand(session.document, operation, data),
    session.document,
    "cad-v1",
  );
  assert.equal(
    result["error"],
    null,
    text(result["output"] || result["error"] || "Missing output"),
  );
  const value = record(result["result"]);
  assert.equal(value["success"], true);
  assert.equal(value["operation"], operation);
  assert.equal(value["status"], "pass");
  assert.equal(
    record(value["documentIdentity"])["creationId"],
    session.document.creationId,
  );
  return value;
}

export function attributeScenarios(
  folder: FixtureFolder,
  owners = 2,
): Scenario[] {
  return Array.from({ length: owners }, (_, index): Scenario => ({
    id: "attributes-" + index,
    fixture: folder,
    requires: [
      "documents",
      "saved-fixtures",
      "rectangular-extrusion",
      "body-attributes",
      "saved-revisions",
      "saved-reopen",
    ],
    async run(session) {
      const ref = await attributeBody(session);
      const key = { ref, group: "FMCAD_SHARED_ATTRIBUTES", name: "source" };
      const firstValue = "first:" + session.report.owner.scenarioId;
      const secondValue = "second:" + session.report.owner.scenarioId;
      const calls = [
        {
          operation: "entity.attribute.set",
          data: { ...key, value: firstValue },
        },
        {
          operation: "entity.attribute.set",
          data: { ...key, value: secondValue },
        },
        {
          operation: "entity.attribute.set",
          data: { ...key, value: secondValue },
        },
        {
          operation: "entity.attribute.set",
          data: { ...key, group: "OTHER_GROUP", value: "foreign namespace" },
        },
        { operation: "entity.attribute.get", data: key },
        { operation: "entity.attribute.get", data: { ref, group: key.group } },
        { operation: "entity.attribute.get", data: { ...key, name: "absent" } },
        ...[{ value: 4 }, { group: " " }, { name: " " }].flatMap((invalid) => [
          {
            operation: "entity.attribute.set",
            data: { ...key, value: "must not be stored", ...invalid },
            rejection: Object.keys(invalid)[0]!,
          },
          { operation: "entity.attribute.get", data: key },
        ]),
      ];
      const observed = await session.execute(
        "attribute-sequence",
        cadSequence(session.document, calls),
        session.document,
        "cad-v1",
      );
      assert.ok(Array.isArray(observed["rows"]));
      assert.equal(observed["rows"].length, calls.length);
      const values = observed["rows"].map((row, i) => {
        const value = record(row);
        if ("rejection" in calls[i]!) {
          assert.equal(typeof value["error"], "string");
          assert.equal(value["result"], null);
          return null;
        }
        assert.equal(value["error"], null);
        const result = record(value["result"]);
        assert.equal(result["success"], true);
        assert.equal(result["status"], "pass");
        assert.equal(result["operation"], calls[i]!.operation);
        assert.equal(
          record(result["documentIdentity"])["creationId"],
          session.document.creationId,
        );
        assert.equal(record(result["resourceIdentity"])["kind"], "body");
        assert.equal(record(result["resourceIdentity"])["token"], ref["token"]);
        return result;
      });
      assert.equal(values[0]!["changed"], true);
      assert.equal(values[0]!["previousValue"], null);
      assert.equal(values[1]!["changed"], true);
      assert.equal(values[1]!["previousValue"], firstValue);
      assert.equal(values[1]!["value"], secondValue);
      assert.equal(values[2]!["changed"], false);
      assert.equal(values[6]!["count"], 0);
      for (const i of [4, 5, 8, 10, 12]) {
        assert.equal(values[i]!["count"], 1);
        assert.deepEqual(values[i]!["attributes"], [
          { name: "source", value: secondValue },
        ]);
      }
      // Separate SDK read after other scenarios can run; use the token, never an active body.
      const readback = await session.execute(
        "attribute-readback",
        program(`${guard(session.document)}
entities = design.findEntityByToken(${JSON.stringify(ref["token"])})
assert len(entities) == 1
body = cast(adsk.fusion.BRepBody, entities[0])
attribute = body.attributes.itemByName('FMCAD_SHARED_ATTRIBUTES', 'source')
assert attribute is not None
${emit("dict(creationId=doc.creationId, value=attribute.value)")}`),
      );
      assert.equal(readback["value"], secondValue);
      // Attribute persistence is tested through an actual owned save/reopen, not
      // by reading the in-memory object that accepted the write.
      await session.saveRevision();
      const savedFile = session.document.file;
      assert.ok(savedFile);
      await attribute(session, "set", {
        ...key,
        value: "discarded unsaved value",
      });
      await session.reopen();
      assert.deepEqual(session.document.file, savedFile);
      // Entity tokens may change across reopening; reacquire the sole owned body.
      const reopenedRef = await attributeBodyRef(session);
      const persisted = await attribute(session, "get", {
        ref: reopenedRef,
        group: key.group,
      });
      assert.equal(persisted["count"], 1);
      assert.deepEqual(persisted["attributes"], [
        { name: "source", value: secondValue },
      ]);
      const namespace = await attribute(session, "get", {
        ref: reopenedRef,
        group: "OTHER_GROUP",
      });
      assert.equal(namespace["count"], 1);
      assert.deepEqual(namespace["attributes"], [
        { name: "source", value: "foreign namespace" },
      ]);
    },
  }));
}

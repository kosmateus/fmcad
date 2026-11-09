import assert from "node:assert/strict";
import { number, record, type FixtureFolder } from "./contracts";
import type { Scenario } from "./runner";
import { parameterCommand } from "./parameter-programs";
import { inspect, parameter } from "./programs";
import { createBox, boxState } from "./box-cases";

/** Both backends execute this exact saved/discard/reopen body and assertions. */
export function reopenScenarios(folder: FixtureFolder, owners = 2): Scenario[] {
  return Array.from({ length: owners }, (_, index): Scenario => ({
    id: "saved-reopen-" + index,
    fixture: folder,
    requires: [
      "documents",
      "saved-fixtures",
      "saved-reopen",
      "rectangular-extrusion",
    ],
    async run(session) {
      const before = session.document;
      assert.ok(before.file);
      const written = await session.execute(
        "unsaved-parameter",
        parameter(before, 30 + index),
      );
      assert.ok(Math.abs(number(written["value"]) - (30 + index) / 10) <= 1e-9);
      const box = await session.execute(
        "unsaved-box",
        createBox(before, 10 + index),
      );
      assert.equal(box["bodies"], 1);
      await session.reopen();
      assert.notEqual(session.document.creationId, before.creationId);
      assert.equal(session.document.name, before.name);
      assert.deepEqual(session.document.file, before.file);
      const reopened = await session.execute(
        "reopened-parameters",
        inspect(session.document),
      );
      assert.equal(reopened["saved"], true);
      assert.equal(
        reopened["count"],
        0,
        "Unsaved parameter leaked into the saved snapshot",
      );
      const state = await session.execute(
        "reopened-geometry",
        boxState(session.document),
      );
      assert.equal(
        state["bodies"],
        0,
        "Unsaved geometry leaked into the saved snapshot",
      );
      assert.equal(state["timelineCount"], 0);
      const after = await session.execute(
        "new-document-write",
        parameter(session.document, 70 + index),
      );
      assert.ok(Math.abs(number(after["value"]) - (70 + index) / 10) <= 1e-9);
      assert.equal(after["creationId"], session.document.creationId);
    },
  }));
}

export function revisionScenarios(
  folder: FixtureFolder,
  owners = 2,
): Scenario[] {
  return Array.from({ length: owners }, (_, index): Scenario => ({
    id: "saved-revision-" + index,
    fixture: folder,
    requires: [
      "documents",
      "saved-fixtures",
      "saved-reopen",
      "saved-revisions",
      "rectangular-extrusion",
    ],
    async run(session) {
      const initial = session.document;
      assert.ok(initial.file);
      const size = 10 + index;
      await session.execute("saved-parameter", parameter(initial, 30 + index));
      await session.execute("saved-box", createBox(initial, size));
      await session.saveRevision();
      const saved = session.document;
      assert.equal(saved.creationId, initial.creationId);
      assert.equal(saved.file?.fileId, initial.file.fileId);
      assert.equal(saved.file?.version, initial.file.version + 1);
      const changed = await session.execute(
        "discarded-parameter",
        parameterCommand(saved, "param_set", [
          "OwnedCounter",
          `${99 + index} mm`,
        ]),
      );
      const commands = changed["commands"];
      assert.ok(Array.isArray(commands) && commands.length === 1);
      assert.equal(record(commands[0])["error"], null);
      const modified = await session.execute(
        "unsaved-readback",
        parameter(saved),
      );
      assert.ok(
        Math.abs(number(modified["value"]) - (99 + index) / 10) <= 1e-9,
      );
      await session.execute("discarded-box", createBox(saved, 20 + index));
      await session.reopen();
      assert.notEqual(session.document.creationId, saved.creationId);
      assert.deepEqual(session.document.file, saved.file);
      const parameters = await session.execute(
        "persisted-parameter",
        parameter(session.document),
      );
      assert.equal(parameters["count"], 1);
      assert.ok(
        Math.abs(number(parameters["value"]) - (30 + index) / 10) <= 1e-9,
      );
      const state = await session.execute(
        "persisted-geometry",
        boxState(session.document),
      );
      assert.equal(state["bodies"], 1);
      assert.equal(state["timelineCount"], 2);
      const dimensions = state["dimensions"],
        volumes = state["volumes"];
      assert.ok(Array.isArray(dimensions) && Array.isArray(dimensions[0]));
      assert.equal(dimensions.length, 1);
      for (const value of dimensions[0])
        assert.ok(Math.abs(number(value) - size) <= 1e-6);
      assert.ok(Array.isArray(volumes) && volumes.length === 1);
      assert.ok(Math.abs(number(volumes[0]) - size ** 3) <= 1e-6);
    },
  }));
}

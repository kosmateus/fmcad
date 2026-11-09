import assert from "node:assert/strict";
import type { ScenarioSession } from "./runner";
import { gmCommands } from "./gm-command-contract";
import { at } from "../integration/offline-cli";
export const g34_1 = {
  id: "G34-01",
  title:
    "gm34: G34-01 marking.create returns an annotation descriptor with verbatim content",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const doc = session.document.name;
    const out = await fmcad([
      "marking",
      "create",
      "--doc",
      doc,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        marks: [
          {
            id: "level-max",
            kind: "text",
            representation: "annotation",
            content: "MAX 50%",
            position: ["0 mm", "20 mm", "0 mm"],
            dimensions: { height: "3 mm", width: "8 mm" },
            font: "ISO3098",
            source: { item: "tank", level: "max", status: "CONFIRMED" },
          },
        ],
      }),
    ]);
    assert.equal(at(out, "status"), "pass", JSON.stringify(out));
    const mark = at(out, "result", "marks", 0);
    assert.equal(at(mark, "content"), "MAX 50%");
    assert.equal(at(mark, "nativeAcceptance"), "annotation");
    assert.ok(at(mark, "annotation"));
    assert.equal(at(mark, "geometryRecipe"), null);
    assert.equal(at(out, "result", "annotationCount"), 1);
    assert.equal(at(out, "result", "geometryRecipeCount"), 0);
  },
};
export const g34_2 = {
  id: "G34-02",
  title:
    "gm34: G34-02 emboss/engrave marks are gated geometry recipes, never images",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const doc = session.document.name;
    const out = await fmcad([
      "marking",
      "create",
      "--doc",
      doc,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        marks: [
          {
            id: "logo",
            kind: "text",
            representation: "emboss",
            content: "LOGO",
            position: ["0 mm", "0 mm", "0 mm"],
            dimensions: { height: "5 mm" },
            depth: "0.5 mm",
          },
          {
            id: "eng",
            kind: "symbol",
            representation: "engrave",
            content: "CE",
            position: ["10 mm", "0 mm", "0 mm"],
            dimensions: { height: "5 mm" },
            depth: "0.2 mm",
          },
        ],
      }),
    ]);
    assert.equal(at(out, "status"), "pass", JSON.stringify(out));
    const emboss = at(out, "result", "marks", 0);
    assert.equal(at(emboss, "nativeAcceptance"), "notEvaluated");
    assert.equal(at(emboss, "geometryRecipe", "representation"), "emboss");
    assert.equal(at(emboss, "annotation"), null);
    assert.equal(at(out, "result", "geometryRecipeCount"), 2);
  },
};
export const g34_3 = {
  id: "G34-03",
  title:
    "gm34: G34-03 marking.check verifies MIN/MAX derivation against a computed level",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const doc = session.document.name;
    const out = await fmcad([
      "marking",
      "check",
      "--doc",
      doc,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        marks: [
          {
            id: "level-max",
            kind: "text",
            representation: "annotation",
            content: "MAX",
            position: ["0 mm", "20 mm", "0 mm"],
            dimensions: { height: "3 mm" },
            reference: { kind: "liquid-level", bound: "max" },
            levelValue: "20 mm",
          },
        ],
        levels: { min: "0 mm", max: "20 mm" },
      }),
    ]);
    assert.equal(at(out, "status"), "pass", JSON.stringify(out));
    assert.equal(at(out, "result", "marks", 0, "passed"), true);
    assert.equal(
      at(out, "result", "marks", 0, "checks", 0, "check"),
      "level-derivation",
    );
    assert.equal(at(out, "result", "marks", 0, "checks", 0, "passed"), true);
  },
};
export const g34_4 = {
  id: "G34-04",
  title:
    "gm34: G34-04 marking.check enforces flow-derived arrows and protected zones",
  async run(session: ScenarioSession) {
    const { fmcad, cad } = gmCommands(session);
    const doc = session.document.name;
    const arrow = await fmcad([
      "marking",
      "check",
      "--doc",
      doc,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        marks: [
          {
            id: "flow-arrow",
            kind: "arrow",
            representation: "annotation",
            position: ["0 mm", "0 mm", "0 mm"],
            dimensions: { height: "5 mm" },
            direction: [1, 0, 0],
          },
        ],
        flows: [{ id: "pump-out", direction: [1, 0, 0] }],
      }),
    ]);
    assert.equal(at(arrow, "status"), "pass", JSON.stringify(arrow));
    assert.equal(
      at(arrow, "result", "marks", 0, "checks", 0, "matched"),
      "pump-out",
    );
    const zone = await cad([
      "marking",
      "create",
      "--doc",
      doc,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        marks: [
          {
            id: "badge",
            kind: "text",
            representation: "annotation",
            content: "BADGE",
            position: ["0 mm", "0 mm", "0 mm"],
            dimensions: { height: "10 mm" },
          },
        ],
        zones: [
          {
            name: "lens",
            kind: "optical",
            region: {
              min: ["-5 mm", "-5 mm", "-5 mm"],
              max: ["5 mm", "5 mm", "5 mm"],
            },
          },
        ],
      }),
    ]);
    assert.equal(
      at(zone, "json", "status"),
      "fail",
      JSON.stringify(at(zone, "json")),
    );
    assert.deepEqual(at(zone, "json", "result", "marks", 0, "zoneViolations"), [
      "lens",
    ]);
  },
};
export const g34_5 = {
  id: "G34-05",
  title:
    "gm34: G34-05 marking.create preserves user content and source item/BOM association",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const doc = session.document.name;
    const content = "MAX 50% — no translation";
    const out = await fmcad([
      "marking",
      "create",
      "--doc",
      doc,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        marks: [
          {
            id: "level-max",
            kind: "text",
            representation: "annotation",
            content,
            position: ["0 mm", "20 mm", "0 mm"],
            dimensions: { height: "3 mm" },
            source: { item: "tank", level: "max", status: "CONFIRMED" },
          },
        ],
      }),
    ]);
    assert.equal(at(out, "status"), "pass", JSON.stringify(out));
    const mark = at(out, "result", "marks", 0);
    assert.equal(at(mark, "content"), content);
    assert.deepEqual(at(mark, "source"), {
      item: "tank",
      level: "max",
      status: "CONFIRMED",
    });
  },
};
export const gm34Cases = [g34_1, g34_2, g34_3, g34_4, g34_5];

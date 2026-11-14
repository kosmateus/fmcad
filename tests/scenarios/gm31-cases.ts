import assert from "node:assert/strict";
import type { ScenarioSession } from "./runner";
import { gmCommands } from "./gm-command-contract";
import { at, list, text, number } from "../integration/offline-cli";
const near = (actual: unknown, expected: unknown, tol = 1e-6) =>
  assert.ok(
    Math.abs(number(actual) - number(expected)) < tol,
    `${actual} != ${expected}`,
  );
export const g31_1 = {
  id: "G31-01",
  title:
    "gm31: G31-01 manufacturing.zone applies protection defaults and warns on missing material",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const doc = session.document.name;
    const out = await fmcad([
      "manufacturing",
      "zone",
      "--doc",
      doc,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        zones: [
          { name: "seal-groove", kind: "seal" },
          { name: "a-panel", kind: "a-surface" },
          { name: "boss", kind: "fit", protected: false },
        ],
      }),
    ]);
    assert.equal(at(out, "status"), "pass", JSON.stringify(out));
    const byName = Object.fromEntries(
      list(at(out, "result", "zones")).map((zone) => [at(zone, "name"), zone]),
    );
    assert.equal(at(byName, "seal-groove", "protected"), true);
    assert.equal(at(byName, "a-panel", "protected"), true);
    assert.equal(at(byName, "boss", "protected"), false);
    assert.ok(
      list(at(out, "result", "warnings")).some((w) =>
        /material/i.test(text(w)),
      ),
    );
  },
};
export const g31_2 = {
  id: "G31-02",
  title:
    "gm31: G31-02 manufacturing.check rejects a global operation that touches a protected zone",
  async run(session: ScenarioSession) {
    const { fmcad, cad } = gmCommands(session);
    const doc = session.document.name;
    const base = {
      schemaVersion: 1,
      zones: [{ name: "seal", kind: "seal" }],
      faces: [
        { name: "wall", point: ["0 mm", "0 mm", "10 mm"], normal: [1, 0, 0] },
      ],
      walls: [
        {
          name: "shell",
          point: ["0 mm", "0 mm", "0 mm"],
          opposite: ["2 mm", "0 mm", "0 mm"],
          continuity: "solid",
        },
      ],
      pullDirections: [{ name: "eject", axis: [0, 0, 1] }],
    };
    const clean = await fmcad([
      "manufacturing",
      "check",
      "--doc",
      doc,
      "--data",
      JSON.stringify(base),
    ]);
    assert.equal(at(clean, "status"), "pass", JSON.stringify(clean));
    assert.equal(at(clean, "result", "passed"), true);
    const violated = await cad([
      "manufacturing",
      "check",
      "--doc",
      doc,
      "--data",
      JSON.stringify({
        ...base,
        operations: [{ name: "global-draft", touches: ["seal"] }],
      }),
    ]);
    assert.equal(
      at(violated, "json", "status"),
      "fail",
      JSON.stringify(at(violated, "json")),
    );
    assert.equal(at(violated, "json", "result", "passed"), false);
    assert.ok(
      list(at(violated, "json", "result", "protectedZones")).includes("seal"),
    );
    assert.ok(
      list(at(violated, "json", "result", "violations")).some(
        (v) => at(v, "source") === "protected-zone",
      ),
    );
  },
};
export const g31_3 = {
  id: "G31-03",
  title:
    "gm31: G31-03 measure.draft reports a signed draft map with the sign convention",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const doc = session.document.name;
    const out = await fmcad([
      "measure",
      "draft",
      "--doc",
      doc,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        faces: [
          { name: "wall", point: ["0 mm", "0 mm", "10 mm"], normal: [1, 0, 0] },
          { name: "top", point: ["0 mm", "0 mm", "10 mm"], normal: [0, 0, 1] },
          {
            name: "under",
            point: ["0 mm", "0 mm", "0 mm"],
            normal: [0, 0, -1],
          },
        ],
        pullDirections: [{ name: "eject", axis: [0, 0, 1] }],
      }),
    ]);
    assert.equal(at(out, "status"), "pass", JSON.stringify(out));
    assert.deepEqual(at(out, "units"), { length: "cm", angle: "deg" });
    const byFace = Object.fromEntries(
      list(at(out, "result", "draftMap")).map((r) => [at(r, "face"), r]),
    );
    near(at(byFace, "wall", "signedDraft"), 0);
    assert.equal(at(byFace, "wall", "pullWall"), true);
    near(at(byFace, "top", "signedDraft"), 90);
    near(at(byFace, "under", "signedDraft"), -90);
    assert.equal(at(out, "result", "demoldableIsNotDraftAlone"), true);
  },
};
export const g31_4 = {
  id: "G31-04",
  title:
    "gm31: G31-04 undercut.check detects a face locked against the pull direction",
  async run(session: ScenarioSession) {
    const { fmcad, cad } = gmCommands(session);
    const doc = session.document.name;
    const detected = await cad([
      "undercut",
      "check",
      "--doc",
      doc,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        faces: [
          { name: "lip", point: ["0 mm", "0 mm", "5 mm"], normal: [0, 0, -1] },
        ],
        pullDirections: [{ name: "eject", axis: [0, 0, 1] }],
      }),
    ]);
    assert.equal(
      at(detected, "json", "status"),
      "fail",
      JSON.stringify(at(detected, "json")),
    );
    assert.equal(at(detected, "json", "result", "passed"), false);
    assert.equal(at(detected, "json", "result", "undercutCount"), 1);
    assert.equal(
      at(detected, "json", "result", "undercuts", 0, "undercut"),
      true,
    );
    const clear = await fmcad([
      "undercut",
      "check",
      "--doc",
      doc,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        faces: [
          { name: "side", point: ["0 mm", "0 mm", "5 mm"], normal: [0, 0, 1] },
        ],
        pullDirections: [{ name: "eject", axis: [0, 0, 1] }],
      }),
    ]);
    assert.equal(at(clear, "status"), "pass", JSON.stringify(clear));
    assert.equal(at(clear, "result", "passed"), true);
  },
};
export const g31_5 = {
  id: "G31-05",
  title:
    "gm31: G31-05 measure.wall-map checks material continuity and flags void-backed samples",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const doc = session.document.name;
    const out = await fmcad([
      "measure",
      "wall-map",
      "--doc",
      doc,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        samples: [
          {
            name: "shell",
            point: ["0 mm", "0 mm", "0 mm"],
            opposite: ["2 mm", "0 mm", "0 mm"],
            continuity: "solid",
          },
          {
            name: "boss",
            point: ["10 mm", "0 mm", "0 mm"],
            opposite: ["14 mm", "0 mm", "0 mm"],
            continuity: "void",
          },
        ],
      }),
    ]);
    assert.equal(at(out, "status"), "pass", JSON.stringify(out));
    near(at(out, "result", "wallMap", 0, "thickness"), 0.2);
    assert.equal(at(out, "result", "wallMap", 0, "voidBacked"), false);
    assert.equal(at(out, "result", "wallMap", 1, "voidBacked"), true);
    assert.ok(list(at(out, "result", "unhandledAreas")).includes("boss"));
    assert.equal(at(out, "result", "materialContinuityChecked"), true);
  },
};
export const g31_6 = {
  id: "G31-06",
  title:
    "gm31: G31-06 wall-map reports thin walls and uniformity for shell/rib fixtures",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const doc = session.document.name;
    const out = await fmcad([
      "measure",
      "wall-map",
      "--doc",
      doc,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        samples: [
          {
            name: "a",
            point: ["0 mm", "0 mm", "0 mm"],
            opposite: ["2 mm", "0 mm", "0 mm"],
          },
          {
            name: "b",
            point: ["0 mm", "10 mm", "0 mm"],
            opposite: ["2 mm", "10 mm", "0 mm"],
          },
        ],
        minThickness: "3 mm",
      }),
    ]);
    assert.equal(at(out, "status"), "pass", JSON.stringify(out));
    assert.equal(
      list(at(out, "result", "wallMap")).every((r) => at(r, "thinWall")),
      true,
    );
    assert.equal(at(out, "result", "uniform"), true);
    assert.equal(list(at(out, "result", "thinWallViolations")).length, 2);
  },
};
export const g31_7 = {
  id: "G31-07",
  title:
    "gm31: G31-07 native sampling is an honest blocked gap and draft alone never proves demoldability",
  async run(session: ScenarioSession) {
    const { fmcad, cad } = gmCommands(session);
    const doc = session.document.name;
    const draft = await cad([
      "measure",
      "draft",
      "--doc",
      doc,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        method: "native",
        faces: [
          { name: "wall", point: ["0 mm", "0 mm", "10 mm"], normal: [1, 0, 0] },
        ],
        pullDirections: [{ name: "eject", axis: [0, 0, 1] }],
      }),
    ]);
    assert.equal(
      at(draft, "json", "status"),
      "blocked",
      JSON.stringify(at(draft, "json")),
    );
    assert.equal(at(draft, "json", "success"), false);
    assert.equal(
      at(draft, "json", "result", "nativeSampling", "available"),
      false,
    );
    assert.equal(at(draft, "json", "result", "requestedMethod"), "native");
    const analytic = await fmcad([
      "measure",
      "draft",
      "--doc",
      doc,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        faces: [
          { name: "wall", point: ["0 mm", "0 mm", "10 mm"], normal: [1, 0, 0] },
        ],
        pullDirections: [{ name: "eject", axis: [0, 0, 1] }],
        minDraft: "1 deg",
      }),
    ]);
    assert.equal(at(analytic, "status"), "pass", JSON.stringify(analytic));
    assert.equal(at(analytic, "result", "demoldableByDraft"), false);
    assert.equal(at(analytic, "result", "demoldableIsNotDraftAlone"), true);
  },
};
export const gm31Cases = [g31_1, g31_2, g31_3, g31_4, g31_5, g31_6, g31_7];

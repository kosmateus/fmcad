import assert from "node:assert/strict";
import { cadCommand } from "./cad-programs";
import type { ScenarioSession } from "./runner";
import { gmCommands } from "./gm-command-contract";
import { at, list, text, number } from "../integration/offline-cli";
const near = (actual: unknown, expected: unknown, tol = 1e-6) =>
  assert.ok(
    Math.abs(number(actual) - number(expected)) < tol,
    `${actual} != ${expected}`,
  );
const PI_OVER_2 = Math.PI / 2;
// flat 20mm + 90deg bend (r 2mm, K 0.5) + flat 20mm, thickness 1mm.
function bracket() {
  return {
    schemaVersion: 1,
    thickness: "1 mm",
    segments: [
      { type: "flat", length: "20 mm" },
      { type: "bend", radius: "2 mm", angle: "90 deg", axis: "y", K: 0.5 },
      { type: "flat", length: "20 mm" },
    ],
  };
}
export const g32_1 = {
  id: "G32-01",
  title: "gm32: G32-01 native flat-pattern authoring is an honest blocked gate",
  async run(session: ScenarioSession) {
    const { cad } = gmCommands(session);
    const doc = session.document.name;
    const out = await cad([
      "sheet",
      "form",
      "--doc",
      doc,
      "--data",
      JSON.stringify({
        ...bracket(),
        representation: "native",
      }),
    ]);
    assert.equal(
      at(out, "json", "status"),
      "blocked",
      JSON.stringify(at(out, "json")),
    );
    assert.equal(at(out, "json", "success"), false);
    assert.equal(
      at(out, "json", "result", "nativeFlatPattern", "available"),
      false,
    );
  },
};
export const g32_2 = {
  id: "G32-02",
  title:
    "gm32: G32-02 sheet.form folds the neutral axis and preserves developed length",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const doc = session.document.name;
    const out = await fmcad([
      "sheet",
      "form",
      "--doc",
      doc,
      "--data",
      JSON.stringify({
        ...bracket(),
        representation: "external",
        fixedFace: "base",
        reliefs: [{ kind: "tear" }],
      }),
    ]);
    assert.equal(at(out, "status"), "pass", JSON.stringify(out));
    assert.deepEqual(at(out, "units"), { length: "cm", angle: "deg" });
    near(
      at(out, "result", "totalDevelopedLength"),
      2.0 + 0.25 * PI_OVER_2 + 2.0,
    );
    const end = at(
      out,
      "result",
      "formedCenterline",
      list(at(out, "result", "formedCenterline")).length - 1,
    );
    near(at(end, 0), 2.25);
    near(at(end, 2), -2.25);
    assert.equal(at(out, "result", "representation"), "external");
    assert.equal(at(out, "result", "nativeFlatPattern", "available"), false);
    assert.equal(list(at(out, "result", "correspondence")).length, 3);
  },
};
export const g32_3 = {
  id: "G32-03",
  title:
    "gm32: G32-03 sheet.flat lays bends straight without scaling the neutral axis",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const doc = session.document.name;
    const out = await fmcad([
      "sheet",
      "flat",
      "--doc",
      doc,
      "--data",
      JSON.stringify(bracket()),
    ]);
    assert.equal(at(out, "status"), "pass", JSON.stringify(out));
    assert.equal(at(out, "result", "developedEqualsFormedNeutral"), true);
    assert.equal(at(out, "result", "scaled"), false);
    near(
      at(out, "result", "totalDevelopedLength"),
      2.0 + 0.25 * PI_OVER_2 + 2.0,
    );
  },
};
export const g32_4 = {
  id: "G32-04",
  title:
    "gm32: G32-04 sheet.bends derives neutral radius and direction and never guesses allowance",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const doc = session.document.name;
    const out = await fmcad([
      "sheet",
      "bends",
      "--doc",
      doc,
      "--data",
      JSON.stringify(bracket()),
    ]);
    assert.equal(at(out, "status"), "pass", JSON.stringify(out));
    assert.equal(at(out, "result", "bendCount"), 1);
    const row = at(out, "result", "bendTable", 0);
    near(at(row, "neutralRadius"), 0.25);
    near(at(row, "developedLength"), 0.25 * PI_OVER_2);
    assert.equal(at(row, "direction"), "up");
    const missing = await session.execute(
      "sheet-missing-allowance",
      cadCommand(session.document, "sheet.bends", {
        schemaVersion: 1,
        thickness: "1 mm",
        segments: [
          { type: "flat", length: "20 mm" },
          { type: "bend", radius: "2 mm", angle: "90 deg", axis: "y" },
        ],
      }),
      session.document,
      "cad-v1",
    );
    assert.ok(
      String(missing["error"]).includes("exactly one of K"),
      String(missing["error"]),
    );
    assert.equal(missing["result"], null);
  },
};
export const g32_5 = {
  id: "G32-05",
  title:
    "gm32: G32-05 sheet.flat reports developed length equal to a declared bend allowance",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const doc = session.document.name;
    const allowance = 0.25 * PI_OVER_2;
    const out = await fmcad([
      "sheet",
      "flat",
      "--doc",
      doc,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        thickness: "1 mm",
        segments: [
          { type: "flat", length: "20 mm" },
          {
            type: "bend",
            radius: "2 mm",
            angle: "90 deg",
            axis: "y",
            allowance: `${allowance * 10} mm`,
          },
          { type: "flat", length: "20 mm" },
        ],
      }),
    ]);
    assert.equal(at(out, "status"), "pass", JSON.stringify(out));
    near(at(out, "result", "bendTable", 0, "allowance"), allowance);
    near(at(out, "result", "totalDevelopedLength"), 2.0 + allowance + 2.0);
    assert.equal(
      at(out, "result", "association"),
      "external recipe; no native flat-pattern associativity",
    );
  },
};
export const g32_6 = {
  id: "G32-06",
  title:
    "gm32: G32-06 native flat pattern is never faked as a static solid and FPC is not sheet metal",
  async run(session: ScenarioSession) {
    const { fmcad, cad } = gmCommands(session);
    const doc = session.document.name;
    for (const operation of list(["form", "flat"])) {
      const out = await cad([
        "sheet",
        text(operation),
        "--doc",
        doc,
        "--data",
        JSON.stringify({
          ...bracket(),
          representation: "native",
        }),
      ]);
      assert.equal(
        at(out, "json", "status"),
        "blocked",
        JSON.stringify(at(out, "json")),
      );
      assert.equal(
        at(out, "json", "result", "nativeFlatPattern", "available"),
        false,
      );
    }
    // External is the only computed representation, and it declares the limitation.
    const external = await fmcad([
      "sheet",
      "form",
      "--doc",
      doc,
      "--data",
      JSON.stringify(bracket()),
    ]);
    assert.equal(at(external, "status"), "pass", JSON.stringify(external));
    assert.equal(at(external, "result", "representation"), "external");
    assert.ok(
      list(at(external, "limitations")).some((l) =>
        /arbitrary solid body is not unfolded/.test(text(l)),
      ),
    );
  },
};
export const gm32Cases = [g32_1, g32_2, g32_3, g32_4, g32_5, g32_6];

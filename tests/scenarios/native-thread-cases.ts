import assert from "node:assert/strict";
import type { Scenario } from "./runner";
import { record, text, number } from "./contracts";
import { nativeModelingHarness, values } from "./native-modeling-support";
export const nativeThreadCapability = "native-thread-catalog-feature";
const targetOperations = [
  "thread.catalog",
  "thread.custom-profile",
  "thread.pair-check",
  "model.thread",
];
function field(value: unknown, ...keys: (string | number)[]): unknown {
  return keys.reduce<unknown>(
    (current, key) =>
      typeof key === "number"
        ? values(current)[key]
        : key === "length" && Array.isArray(current)
          ? current.length
          : record(current)[key],
    value,
  );
}
export function nativeThreadScenarios(owners = 10): Scenario[] {
  return Array.from({ length: owners }, (_, index): Scenario => ({
    id: "native-thread-" + index,
    scope: "exclusive-instance",
    requires: ["documents", nativeThreadCapability],
    async run(session) {
      const harness = await nativeModelingHarness(
        session,
        "tests/live-thread-method.js",
        ["shape.cylinder", "entity.find", "measure.volume", "entity.list"],
        targetOperations,
        { honorResultStatus: true },
      );
      const { cad, check, validated, guard } = harness;
      const report = {
        tests: [] as {
          name: string;
          status: string;
          operations: string[];
        }[],
      };
      let body: unknown,
        currentCase = "fixture";
      // The historical catalog query used a designation where the unchanged handler
      // accepts its nominal key. Keep its rejection as a separate original command.
      await guard();
      const rejected = await session.cadRejected(
        "cad-native-thread-designation-rejected",
        "thread.catalog",
        {
          schemaVersion: 1,
          frame: "component",
          system: "iso-metric-coarse",
          query: "M10x1.5",
          starts: 2,
        },
      );
      assert.equal(rejected.state, "failed");
      assert.match(rejected.stderr ?? rejected.error ?? "", /query|M10x1.5/u);
      // ORIGINAL_NATIVE_BODY
      await guard();
      const cylinder = await cad("shape.cylinder", {
        name: "ThreadCylinder",
        radius: "5 mm",
        height: "20 mm",
      });
      check(
        "shape.cylinder",
        "one cylindrical fixture body returned",
        field(cylinder, "bodies", "length"),
        1,
      );
      validated("shape.cylinder");
      body = field(cylinder, "bodies", 0);
      const face = await cad("entity.find", {
        kind: "face",
        filters: { geometry: "cylinder", radius: "5 mm" },
        unique: true,
      });
      check(
        "entity.find",
        "one exact outer cylindrical face selected",
        field(face, "kind"),
        "face",
      );
      validated("entity.find");
      const volumeBefore = await cad("measure.volume", {
        ref: body,
        units: "mm3",
      });
      validated("measure.volume");
      const featuresBefore = await cad("entity.list", { kind: "feature" });
      validated("entity.list");
      currentCase = "thread-catalog-custom-profile-and-pair-check";
      const catalogResult = await cad("thread.catalog", {
        schemaVersion: 1,
        frame: "component",
        system: "iso-metric-coarse",
        query: "M10",
        starts: 2,
      });
      check(
        "thread.catalog",
        "curated query returns exactly M10x1.5",
        field(catalogResult, "entries", "length"),
        1,
      );
      check(
        "thread.catalog",
        "catalog result identifies the curated ISO subset",
        field(catalogResult, "curated"),
        true,
      );
      check(
        "thread.catalog",
        "multi-start lead equals two starts times 1.5 mm pitch",
        field(catalogResult, "entries", 0, "lead", "value"),
        3,
        1e-9,
      );
      validated("thread.catalog");
      const custom = await cad("thread.custom-profile", {
        schemaVersion: 1,
        frame: "component",
        majorDiameter: "10 mm",
        minorDiameter: "8.16 mm",
        pitch: "1.5 mm",
        starts: 2,
        hand: "left",
        flankAngle: "60 deg",
        rootShape: "rounded",
        length: "12 mm",
        runout: "0.5 mm",
        clearance: "0.1 mm",
      });
      check(
        "thread.custom-profile",
        "custom profile is explicitly a recipe",
        field(custom, "representation"),
        "recipe",
      );
      check(
        "thread.custom-profile",
        "custom profile lead is 3 mm",
        field(custom, "profile", "lead", "value"),
        3,
        1e-9,
      );
      check(
        "thread.custom-profile",
        "custom profile has 0.92 mm radial depth",
        field(custom, "profile", "depth", "value"),
        0.92,
        1e-9,
      );
      check(
        "thread.custom-profile",
        "custom profile retains left hand and rounded root",
        text(field(custom, "profile", "hand")) +
          "|" +
          text(field(custom, "profile", "rootShape")),
        "left|rounded",
      );
      check(
        "thread.custom-profile",
        "turns-per-length is separate from lead",
        field(custom, "profile", "turnsPerLength", "value"),
        1 / 3,
        1e-9,
      );
      validated("thread.custom-profile");
      const pair = await cad("thread.pair-check", {
        schemaVersion: 1,
        frame: "component",
        external: {
          majorDiameter: "10 mm",
          minorDiameter: "8.16 mm",
          pitch: "1.5 mm",
          starts: 1,
          hand: "right",
        },
        internal: {
          majorDiameter: "10 mm",
          minorDiameter: "8.38 mm",
          pitch: "1.5 mm",
          starts: 1,
          hand: "right",
        },
      });
      check(
        "thread.pair-check",
        "matching ISO-style thread pair fits",
        field(pair, "pairFit"),
        "pass",
      );
      check(
        "thread.pair-check",
        "hand, lead, starts, radial fit and engagement checks pass",
        values(field(pair, "checks")).every(
          (item) => field(item, "status") === "pass",
        ),
        true,
      );
      check(
        "thread.pair-check",
        "radial engagement depth is 0.81 mm",
        field(pair, "engagementDepth", "value"),
        0.81,
        1e-9,
      );
      check(
        "thread.pair-check",
        "60-degree profile is identified as ISO-style V",
        field(pair, "crossSection", "type"),
        "ISO-style 60-degree V",
      );
      validated("thread.pair-check");
      report.tests.push({
        name: currentCase,
        status: "pass",
        operations: targetOperations.slice(0, 3),
      });
      currentCase = "custom-thread-profile-recipe-no-geometry";
      const beforeRecipe = await cad("entity.list", { kind: "feature" });
      const recipe = await cad("model.thread", {
        name: "ThreadRecipe",
        faces: [face],
        internal: false,
        profile: {
          majorDiameter: "10 mm",
          minorDiameter: "8.16 mm",
          pitch: "1.5 mm",
          starts: 2,
          hand: "left",
          flankAngle: "60 deg",
          rootShape: "rounded",
          runout: "0.5 mm",
          clearance: "0.1 mm",
        },
        length: "12 mm",
      });
      check(
        "model.thread",
        "custom-profile branch returns recipe representation",
        field(recipe, "representation"),
        "recipe",
      );
      check(
        "model.thread",
        "custom-profile branch does not claim a native feature",
        field(recipe, "feature"),
        null,
      );
      check(
        "model.thread",
        "custom-profile recipe lead equals starts × pitch",
        field(recipe, "lead", "value"),
        3,
        1e-8,
      );
      check(
        "model.thread",
        "custom-profile recipe preserves left hand",
        field(recipe, "hand"),
        "left",
      );
      check(
        "model.thread",
        "custom-profile depth equals half major-minus-minor diameter",
        field(recipe, "profile", "depth", "value"),
        0.92,
        1e-8,
      );
      check(
        "model.thread",
        "custom-profile length is returned in mm",
        field(recipe, "length", "value"),
        12,
        1e-8,
      );
      check(
        "model.thread",
        "custom-profile notes the native helical-tooth limitation",
        text(field(recipe, "note")).includes(
          "no persistent Coil/helical-path API",
        ),
        true,
      );
      validated("model.thread");
      const afterRecipe = await cad("entity.list", { kind: "feature" });
      check(
        "entity.list",
        "recipe branch creates no additional native feature",
        field(afterRecipe, "entities", "length"),
        field(beforeRecipe, "entities", "length"),
      );
      validated("entity.list");
      const recipeVolume = await cad("measure.volume", {
        ref: body,
        units: "mm3",
      });
      check(
        "measure.volume",
        "recipe branch leaves native cylinder volume unchanged",
        field(recipeVolume, "value"),
        field(volumeBefore, "value"),
        0.001,
      );
      validated("measure.volume");
      report.tests.push({
        name: "custom-thread-profile-recipe-no-geometry",
        status: "pass",
        operations: ["model.thread"],
      });
      currentCase = "native-tabular-cosmetic-thread";
      const tabular = await cad("model.thread", {
        name: "TabularM10",
        faces: [face],
        internal: false,
        threadType: "ISO Metric profile",
        designation: "M10x1.5",
        class: "6g",
        modeled: false,
        rightHanded: true,
      });
      check(
        "model.thread",
        "tabular thread returns a feature reference",
        field(tabular, "feature", "kind"),
        "feature",
      );
      validated("model.thread");
      const featureReadback = await cad("entity.list", { kind: "feature" });
      check(
        "entity.list",
        "tabular thread adds one feature to the timeline",
        field(featureReadback, "entities", "length"),
        number(field(featuresBefore, "entities", "length")) + 1,
      );
      check(
        "entity.list",
        "cosmetic tabular thread is present in feature history",
        values(field(featureReadback, "entities")).some(
          (item) => field(item, "name") === "TabularM10",
        ),
        true,
      );
      validated("entity.list");
      const volumeAfter = await cad("measure.volume", {
        ref: body,
        units: "mm3",
      });
      check(
        "measure.volume",
        "cosmetic thread preserves BRep volume",
        field(volumeAfter, "value"),
        field(volumeBefore, "value"),
        0.001,
      );
      validated("measure.volume");
      report.tests.push({
        name: "native-tabular-cosmetic-thread",
        status: "pass",
        operations: ["model.thread"],
      });
      await guard();
      assert.equal(report.tests.length, 3);
    },
  }));
}

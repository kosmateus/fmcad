import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { nativeCadReimport } from "./native-cad-reimport";
import type { Scenario } from "./runner";
import { record, text, number } from "./contracts";
import { concurrencyLimit } from "./scheduling";
import {
  nativeModelingHarness,
  nativeResultUncertain,
  values,
} from "./native-modeling-support";
const root = path.resolve(__dirname, "../../..");
const { catalog } = createRequire(path.join(root, "package.json"))(
  "./src/cad",
) as typeof import("../../src/composition/cad-execution");
export const nativeCadCapability = "native-cad-physical-regeneration";
interface Group {
  name: string;
  status: "passed" | "failed" | "not-tested";
  reason?: string;
  error?: string;
  afterFailureAudit?: unknown;
  diagnosticError?: string;
}
interface Shape {
  component: string;
  ok: boolean;
  body?: unknown;
}
interface Exported {
  fusionPath: string;
  wslMapping: string;
  localMappingExists: boolean;
  bytes: number;
  owned: true;
}
const shapeKinds = ["box", "tube", "cylinder", "cone"] as const;
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
export function nativeCadScenarios(owners = 10): Scenario[] {
  concurrencyLimit(owners);
  return Array.from({ length: owners }, (_, index): Scenario => ({
    id: "native-cad-" + index,
    requires: ["documents", nativeCadCapability],
    scope: "exclusive-instance",
    async run(session) {
      const harness = await nativeModelingHarness(
        session,
        "tests/live-cad.js",
        [],
        [],
      );
      const { identity, baseline, guard } = harness;
      const name = identity.name;
      const report = {
        source: "tests/live-cad.js",
        owner: session.report.owner,
        tests: [] as Group[],
        measurements: [] as Record<string, unknown>[],
        files: [] as Exported[],
        finalAudit: {} as Record<string, unknown>,
      };
      const shapes: Record<(typeof shapeKinds)[number], Shape> = {
        box: { component: "Test_box", ok: false },
        tube: { component: "Test_tube", ok: false },
        cylinder: { component: "Test_cylinder", ok: false },
        cone: { component: "Test_cone", ok: false },
      };
      let currentGroup = "setup",
        sequence = 0;
      const tested = new Set<string>();
      const persist = () =>
        fs.writeFileSync(
          path.join(session.directory, "native-cad.json"),
          JSON.stringify(report, null, 2) + "\n",
          { mode: 0o600 },
        );
      async function cad(
        op: string,
        data: Record<string, unknown> = {},
        component?: string | null,
        expectedError?: RegExp | null,
        target = identity,
        spelling?: string,
      ): Promise<Record<string, unknown>> {
        assert.ok(catalog[op], "Unknown test operation " + op);
        assert.equal(
          target.creationId,
          identity.creationId,
          "Imported child readbacks must use their durable owned scope",
        );
        if (!catalog[op].readOnly) await guard();
        tested.add(op);
        const options = {
          ...(component ? { component } : {}),
          ...(spelling ? { spelling: spelling.split(" ") } : {}),
        };
        if (expectedError) {
          const rejected = await session.cadRejected(
            "cad-native-rejected-" + sequence++,
            op,
            data,
            options,
          );
          assert.equal(rejected.state, "failed", "Expected command rejection");
          assert.equal(
            rejected.sdkSettled,
            true,
            "Expected rejection must prove SDK settlement",
          );
          assert.match(
            (rejected.stderr ?? "") + rejected.stdout + (rejected.error ?? ""),
            expectedError,
          );
          persist();
          return {};
        }
        const out = await session.cad(
          "cad-native-main-" + sequence++,
          op,
          data,
          options,
        );
        if (nativeResultUncertain(out))
          session.deferCleanup(
            op + " returned unknown/pending; do not replay.",
          );
        assert.equal(out["success"], true);
        assert.equal(out["document"], target.name);
        persist();
        return record(out["result"]);
      }
      async function group(
        label: string,
        fn: () => Promise<void>,
        enabled = true,
      ): Promise<boolean> {
        currentGroup = label;
        if (!enabled) {
          report.tests.push({
            name: label,
            status: "not-tested",
            reason: "Dependent prerequisite failed",
          });
          persist();
          return false;
        }
        try {
          await fn();
          report.tests.push({ name: label, status: "passed" });
          persist();
          return true;
        } catch (error) {
          const row: Group = {
            name: label,
            status: "failed",
            error: String(error),
          };
          report.tests.push(row);
          persist();
          if (session.uncertain) throw error;
          try {
            row.afterFailureAudit = await cad("audit");
          } catch (diagnostic) {
            row.diagnosticError = String(diagnostic);
            if (session.uncertain) throw diagnostic;
          }
          persist();
          return false;
        }
      }
      function near(
        actual: unknown,
        expected: unknown,
        tolerance: number,
        label: string,
      ): void {
        const row = {
          group: currentGroup,
          label,
          actual,
          expected,
          tolerance,
          status:
            typeof actual === "number" &&
            Number.isFinite(actual) &&
            typeof expected === "number" &&
            Math.abs(actual - expected) <= tolerance
              ? "passed"
              : "failed",
        };
        report.measurements.push(row);
        persist();
        assert.equal(row.status, "passed", JSON.stringify(row));
      }
      async function physical(
        body: unknown,
        size: readonly number[],
        volume: number,
        component?: string | null,
        target = identity,
      ): Promise<void> {
        const bounds = await cad(
          "measure.bounds",
          { ref: body, units: "mm" },
          component,
          null,
          target,
        );
        assert.equal(field(bounds, "units"), "mm");
        assert.equal(
          values(field(bounds, "size")).length,
          3,
          "Native bounds must contain all three dimensions",
        );
        values(field(bounds, "size")).forEach((v, i) =>
          near(v, size[i], 0.001, "bounds " + "xyz"[i] + " mm"),
        );
        const measured = await cad(
          "measure.volume",
          { ref: body, units: "mm3" },
          component,
          null,
          target,
        );
        assert.equal(field(measured, "units"), "mm3");
        near(
          field(measured, "value"),
          volume,
          Math.max(0.001, volume * 0.00001),
          "volume mm3",
        );
      }
      async function count(
        component: string,
        kind: string,
        expected: number,
      ): Promise<unknown[]> {
        const entities = values(
          field(await cad("entity.list", { kind }, component), "entities"),
        );
        assert.equal(entities.length, expected, `${component} ${kind} count`);
        return entities;
      }
      async function params(
        parameters: Record<string, string>,
        overwrite = false,
      ): Promise<Record<string, unknown>> {
        return cad("param.apply", {
          parameters: Object.entries(parameters).map(([name, expression]) => ({
            name,
            expression,
            unit: "mm",
          })),
          overwrite,
        });
      }
      async function regenerate(): Promise<void> {
        assert.equal(field(await cad("history.recompute"), "healthy"), true);
      }
      const initialized = await group(
        "doc new and creationId ownership",
        async () => {
          assert.ok(
            !values(baseline["documents"])
              .map(record)
              .some((d) => d["name"] === name),
          );
          assert.equal(
            record(
              values((await guard())["documents"]).find(
                (d) => record(d)["creationId"] === identity.creationId,
              ),
            )["active"],
            true,
          );
          assert.equal(
            record(field(await cad("audit"), "counts"))["bodyDefinitions"],
            0,
          );
        },
      );
      await group(
        "parameter apply and offset datum",
        async () => {
          await params({ datum_offset: "5 mm" });
          const plane = await cad("datum.plane", {
            name: "TestOffset",
            plane: "XY",
            mode: "offset",
            offset: "datum_offset",
          });
          near(
            field(
              await cad("entity.inspect", { ref: plane }),
              "geometry",
              "origin",
              2,
            ),
            0.5,
            1e-7,
            "datum z cm",
          );
          await params({ datum_offset: "8 mm" }, true);
          await regenerate();
          near(
            field(
              await cad("entity.inspect", { ref: plane }),
              "geometry",
              "origin",
              2,
            ),
            0.8,
            1e-7,
            "regenerated datum z cm",
          );
          await count("root", "plane", 1);
        },
        initialized,
      );
      for (const kind of shapeKinds) {
        shapes[kind] = { component: "Test_" + kind, ok: false };
        shapes[kind].ok = await group(
          "shape." + kind + " physical geometry and parameter regeneration",
          async () => {
            const component = shapes[kind].component;
            await cad("component.create", { name: component });
            await count(component, "body", 0);
            const p = kind + "_";
            await params({
              [p + "h"]: "20 mm",
              [p + "w"]: "40 mm",
              [p + "d"]: "30 mm",
              [p + "r"]: "10 mm",
              [p + "i"]: "6 mm",
              [p + "t"]: "5 mm",
            });
            const data: Record<string, unknown> = {
              name: "Solid_" + kind,
              height: p + "h",
            };
            if (kind === "box")
              Object.assign(data, { width: p + "w", depth: p + "d" });
            if (kind === "cylinder") data["radius"] = p + "r";
            if (kind === "tube")
              Object.assign(data, {
                outerRadius: p + "r",
                innerRadius: p + "i",
              });
            if (kind === "cone")
              Object.assign(data, { baseRadius: p + "r", topRadius: p + "t" });
            const made = await cad("shape." + kind, data, component);
            assert.equal(field(made, "bodies", "length"), 1);
            const body = field(made, "bodies", 0);
            shapes[kind].body = body;
            async function verify(
              h: number,
              w: number,
              d: number,
              r: number,
              i: number,
              t: number,
            ) {
              const volume =
                kind === "box"
                  ? w * d * h
                  : kind === "tube"
                    ? Math.PI * (r * r - i * i) * h
                    : kind === "cone"
                      ? (Math.PI * h * (r * r + r * t + t * t)) / 3
                      : Math.PI * r * r * h;
              await physical(
                body,
                kind === "box" ? [w, d, h] : [2 * r, 2 * r, h],
                volume,
                component,
              );
              if (kind !== "box") {
                for (const radius of kind === "tube"
                  ? [r, i]
                  : kind === "cone"
                    ? [r, t]
                    : [r]) {
                  const refs = field(
                    await cad(
                      "entity.find",
                      {
                        kind: kind === "cone" ? "edge" : "face",
                        filters: {
                          geometry: kind === "cone" ? "circle" : "cylinder",
                          radius: radius + " mm",
                        },
                      },
                      component,
                    ),
                    "entities",
                  );
                  assert.equal(values(refs).length, 1);
                  near(
                    field(
                      await cad(
                        "measure.radius",
                        { ref: values(refs)[0], units: "mm" },
                        component,
                      ),
                      "value",
                    ),
                    radius,
                    0.001,
                    "analytic radius mm",
                  );
                }
              }
              await count(component, "body", 1);
            }
            await verify(20, 40, 30, 10, 6, 5);
            await params(
              {
                [p + "h"]: "25 mm",
                [p + "w"]: "50 mm",
                [p + "d"]: "35 mm",
                [p + "r"]: "12 mm",
                [p + "i"]: "7 mm",
                [p + "t"]: "6 mm",
              },
              true,
            );
            await regenerate();
            await verify(25, 50, 35, 12, 7, 6);
          },
          initialized,
        );
      }
      await group(
        "sketch geometry dimension refs and extrude regeneration",
        async () => {
          const component = "Test_sketch";
          await cad("component.create", { name: component });
          await params({ sketch_r: "8 mm", sketch_h: "12 mm" });
          const sketch = field(
            await cad(
              "sketch.create",
              { name: "CircleSection", plane: "XY" },
              component,
            ),
            "sketch",
          );
          const circle = field(
            await cad(
              "sketch.geometry",
              {
                sketch,
                geometry: [
                  {
                    type: "circle",
                    name: "circle",
                    center: ["0 mm", "0 mm", "0 mm"],
                    radius: "sketch_r",
                  },
                ],
              },
              component,
            ),
            "refs",
            "circle",
          );
          await cad(
            "sketch.dimension",
            {
              sketch,
              type: "radius",
              entities: [circle],
              text: ["12 mm", "12 mm", "0 mm"],
              expression: "sketch_r",
            },
            component,
          );
          const profiles = field(
            await cad("sketch.inspect", { sketch }, component),
            "profiles",
          );
          assert.equal(field(profiles, "length"), 1);
          const made = await cad(
            "model.extrude",
            {
              name: "ExplicitExtrude",
              profile: field(profiles, 0, "ref"),
              distance: "sketch_h",
            },
            component,
          );
          await physical(
            field(made, "bodies", 0),
            [16, 16, 12],
            Math.PI * 64 * 12,
            component,
          );
          await params({ sketch_r: "9 mm", sketch_h: "15 mm" }, true);
          await regenerate();
          await physical(
            field(made, "bodies", 0),
            [18, 18, 15],
            Math.PI * 81 * 15,
            component,
          );
          await count(component, "body", 1);
        },
        initialized,
      );
      await group(
        "bare revolve alias with explicit profile and axis refs",
        async () => {
          const component = "Test_revolve";
          await cad("component.create", { name: component });
          await params({ revolve_r: "4 mm", revolve_h: "10 mm" });
          const sketch = field(
            await cad(
              "sketch.create",
              { name: "RevolveSection", plane: "XY" },
              component,
            ),
            "sketch",
          );
          const lines = field(
            await cad(
              "sketch.geometry",
              {
                sketch,
                geometry: [
                  {
                    type: "rectangle",
                    name: "section",
                    start: ["0 mm", "0 mm", "0 mm"],
                    end: ["revolve_r", "revolve_h", "0 mm"],
                  },
                ],
              },
              component,
            ),
            "refs",
            "section",
          );
          const inspected = await cad("sketch.inspect", { sketch }, component);
          assert.equal(field(inspected, "profiles", "length"), 1);
          for (const [line, expression, orientation] of [
            [field(lines, 0), "revolve_r", "horizontal"],
            [field(lines, 1), "revolve_h", "vertical"],
          ]) {
            await cad(
              "sketch.dimension",
              {
                sketch,
                type: "distance",
                entities: [
                  { entity: line, point: "start" },
                  { entity: line, point: "end" },
                ],
                text: ["12 mm", "12 mm", "0 mm"],
                expression,
                orientation,
              },
              component,
            );
          }
          const profile = field(
            await cad("sketch.inspect", { sketch }, component),
            "profiles",
            0,
            "ref",
          );
          const axis = await cad("entity.inspect", { ref: "Y" }, component);
          const made = await cad(
            "model.revolve",
            { name: "ExplicitRevolve", profile, axis, angle: "360 deg" },
            component,
            null,
            identity,
            "revolve",
          );
          await physical(
            field(made, "bodies", 0),
            [8, 10, 8],
            Math.PI * 16 * 10,
            component,
          );
          await count(component, "body", 1);
        },
        initialized,
      );
      await group(
        "seed hole circular pattern physical volume and count",
        async () => {
          const component = "Test_pattern";
          await cad("component.create", { name: component });
          const body = field(
            await cad(
              "shape.cylinder",
              { name: "Plate", radius: "20 mm", height: "5 mm" },
              component,
            ),
            "bodies",
            0,
          );
          const plane = await cad(
            "datum.plane",
            { name: "PlateTop", offset: "5 mm" },
            component,
          );
          const sketch = field(
            await cad("sketch.create", { name: "HoleSeed", plane }, component),
            "sketch",
          );
          const point = field(
            await cad(
              "sketch.geometry",
              {
                sketch,
                geometry: [
                  {
                    type: "point",
                    name: "seed",
                    point: ["10 mm", "0 mm", "0 mm"],
                  },
                ],
              },
              component,
            ),
            "refs",
            "seed",
          );
          const hole = await cad(
            "model.hole",
            {
              name: "SeedHole",
              points: [point],
              diameter: "4 mm",
              depth: "10 mm",
              participants: [body],
            },
            component,
          );
          await physical(body, [40, 40, 5], Math.PI * (400 - 4) * 5, component);
          await cad(
            "pattern.circular",
            {
              name: "FourHoles",
              entities: [hole["feature"]],
              axis: "Z",
              quantity: 4,
              angle: "360 deg",
            },
            component,
          );
          await regenerate();
          await physical(
            body,
            [40, 40, 5],
            Math.PI * (400 - 16) * 5,
            component,
          );
          assert.equal(
            field(
              await cad(
                "entity.find",
                {
                  kind: "face",
                  filters: { geometry: "cylinder", radius: "2 mm" },
                },
                component,
              ),
              "count",
            ),
            4,
          );
          await count(component, "body", 1);
        },
        initialized,
      );
      await group(
        "fillet found and resolved circular edge",
        async () => {
          const { component, body } = shapes.cylinder;
          const edge = await cad(
            "entity.find",
            {
              kind: "edge",
              filters: {
                geometry: "circle",
                radius: "12 mm",
                position: ["0 mm", "0 mm", "25 mm"],
              },
              unique: true,
            },
            component,
          );
          const resolved = await cad(
            "entity.inspect",
            { ref: edge },
            component,
          );
          const before = field(
            await cad("measure.volume", { ref: body }, component),
            "value",
          );
          await cad(
            "model.fillet",
            {
              name: "TopRound",
              edges: [resolved],
              radius: "1 mm",
              tangentChain: false,
            },
            component,
          );
          await regenerate();
          const after = field(
            await cad("measure.volume", { ref: body }, component),
            "value",
          );
          assert.ok(
            number(after) < number(before) &&
              number(after) > number(before) * 0.95,
            "Fillet must remove a small positive volume",
          );
          values(
            field(
              await cad("measure.bounds", { ref: body }, component),
              "size",
            ),
          ).forEach((v, i) =>
            near(v, [24, 24, 25][i], 0.001, "fillet bounds mm"),
          );
          await count(component, "body", 1);
        },
        shapes.cylinder.ok,
      );
      await group(
        "assembly linked occurrence shares definition and measured placement",
        async () => {
          const { component, body } = shapes.box;
          const before = await cad("audit");
          const added = await cad("occurrence.add", {
            component,
            copyMode: "linked",
            placement: { translation: ["100 mm", "0 mm", "0 mm"] },
          });
          const after = await cad("audit");
          assert.equal(
            field(after, "counts", "bodyDefinitions"),
            field(before, "counts", "bodyDefinitions"),
          );
          assert.equal(
            field(after, "counts", "componentDefinitions"),
            field(before, "counts", "componentDefinitions"),
          );
          assert.equal(
            field(after, "counts", "occurrences"),
            number(field(before, "counts", "occurrences")) + 1,
          );
          const inspected = await cad("component.inspect", { component });
          assert.equal(
            field(added, "component", "token"),
            field(inspected, "component", "token"),
          );
          const proxy = {
            ...record(body),
            occurrence: field(added, "occurrence"),
          };
          const bounds = await cad("measure.bounds", { ref: proxy });
          near(
            field(bounds, "min", 0),
            100,
            0.001,
            "linked occurrence min x mm",
          );
          await physical(proxy, [50, 35, 25], 50 * 35 * 25);
        },
        shapes.box.ok,
      );
      await group(
        "expected unknown field and invalid units preserve entity counts",
        async () => {
          for (const [op, data, error] of [
            [
              "shape.box",
              {
                name: "RejectUnknown",
                width: "1 mm",
                depth: "1 mm",
                height: "1 mm",
                unexpected: true,
              },
              /Unknown CAD inputs: unexpected/,
            ],
            [
              "shape.cylinder",
              { name: "RejectUnits", radius: "2 deg", height: "5 mm" },
              /Invalid or incompatible expression/,
            ],
          ] as const) {
            const before = await cad("audit");
            await cad(op, data, "root", error);
            const after = await cad("audit");
            assert.deepEqual(field(after, "counts"), field(before, "counts"));
            assert.deepEqual(
              field(after, "components"),
              field(before, "components"),
            );
          }
        },
        initialized,
      );
      await group(
        "expected ambiguous body rejects without duplicate entities",
        async () => {
          const component = "Test_ambiguity";
          await cad("component.create", { name: component });
          const first = field(
            await cad(
              "shape.box",
              { name: "First", width: "2 mm", depth: "3 mm", height: "4 mm" },
              component,
            ),
            "bodies",
            0,
          );
          const second = field(
            await cad(
              "shape.box",
              { name: "Second", width: "3 mm", depth: "4 mm", height: "5 mm" },
              component,
            ),
            "bodies",
            0,
          );
          assert.notEqual(record(first)["name"], record(second)["name"]);
          const aliased = await cad(
            "entity.alias",
            { ref: first, alias: record(second)["name"] },
            component,
          );
          assert.equal(
            field(aliased, "alias"),
            record(second)["name"],
            "Unicode alias must exactly round-trip",
          );
          const before = await cad("audit");
          await cad(
            "measure.bounds",
            { ref: { name: record(second)["name"], kind: "body" } },
            component,
            /expected one match, found 2/,
          );
          const after = await cad("audit");
          assert.deepEqual(field(after, "counts"), field(before, "counts"));
          assert.deepEqual(
            field(after, "components"),
            field(before, "components"),
          );
          await count(component, "body", 2);
        },
        initialized,
      );
      const audited = await group(
        "full audit and recomputed timeline health",
        async () => {
          await regenerate();
          report.finalAudit = await cad("audit");
          assert.deepEqual(report.finalAudit["issues"], []);
        },
        initialized,
      );
      const exportedOK = await group(
        "local checkpoint and native export",
        async () => {
          const now = await guard();
          assert.equal(field(now, "tempExists"), true);
          const windows = path.win32;
          assert.ok(
            windows.isAbsolute(text(field(now, "tempDir"))),
            "Expected a Fusion Windows absolute temp path",
          );
          for (const [operation, suffix] of [
            ["checkpoint.create", "checkpoint"],
            ["export.native", "native"],
          ] as const) {
            const mapped = path.join(
              session.directory,
              name + "_" + suffix + ".f3d",
            );
            const filename = session.backend.fusionPath(mapped);
            const exists = await cad("export.verify", { path: filename });
            assert.equal(
              field(exists, "exists"),
              false,
              "Never overwrite existing output",
            );
            const exported = await cad(operation, { path: filename });
            assert.ok(
              field(exported, "exists") && number(field(exported, "bytes")) > 0,
            );
            report.files.push({
              fusionPath: filename,
              wslMapping: mapped,
              localMappingExists: fs.existsSync(mapped),
              bytes: number(field(exported, "bytes")),
              owned: true,
            });
            assert.ok(
              number(
                field(
                  await cad("checkpoint.inspect", { path: filename }),
                  "bytes",
                ),
              ) > 0,
            );
            await guard();
          }
        },
        audited,
      );
      if (exportedOK && process.env["FMCAD_LIVE_REIMPORT"] === "1") {
        await group("owned reimport verification (opt-in isolated risk)", () =>
          nativeCadReimport(session, harness, report.files, cad),
        );
      }
      await guard();
      persist();
      assert.ok(
        !report.tests.some((row) => row.status === "failed"),
        "Retained native CAD groups failed; inspect native-cad.json",
      );
    },
  }));
}

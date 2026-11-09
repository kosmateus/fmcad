import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { Scenario } from "./runner";
import { record, text } from "./contracts";
import { concurrencyLimit } from "./scheduling";
import { emit, program } from "./programs";
import {
  nativeModelingHarness,
  nativeResultUncertain,
  values,
} from "./native-modeling-support";
const root = path.resolve(__dirname, "../../..");
const { validateCad } = createRequire(path.join(root, "package.json"))(
  "./src/cad",
) as typeof import("../../src/composition/cad-execution");
export const nativeFeatureModesCapability = "native-feature-modes-addin";
const py = (value: unknown): string =>
  `json.loads(${JSON.stringify(JSON.stringify(value))})`;
interface Metric {
  label: string;
  actual: unknown;
  expected: unknown;
  tolerance: number;
  units: string;
  requestIndex: number;
  status: "pass" | "fail";
}
interface CaseEvidence {
  name: string;
  status: "running" | "pass" | "fail";
  metrics: Metric[];
  error?: string;
  inspectionGap?: string;
  failureInspection?: unknown;
  inspectionError?: string;
}
interface ScriptOptions {
  mutation?: boolean;
  cadBundle?: boolean;
  request?: unknown;
}
interface SectionOptions {
  plane?: unknown;
  rectangle?: readonly [string[], string[]];
  radius?: string;
  point?: string[];
}
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

/** Retained extent/rail/participant/regeneration probes use the real installed handlers. */
export function nativeFeatureModesScenarios(owners = 10): Scenario[] {
  concurrencyLimit(owners);
  return Array.from({ length: owners }, (_, index): Scenario => ({
    id: "native-feature-modes-" + index,
    requires: ["documents", nativeFeatureModesCapability],
    scope: "exclusive-instance",
    async run(session) {
      assert.equal(
        session.backend.protocol,
        "addin",
        "The retained feature-mode qualification is addin-only",
      );
      const harness = await nativeModelingHarness(
        session,
        "tests/live-feature-modes.js",
        [],
        [],
      );
      const { identity, baseline } = harness;
      const name = identity.name;
      const foreign = values(baseline["documents"])
        .map(record)
        .map((doc) => ({
          name: doc["name"],
          creationId: doc["creationId"],
          saved: doc["saved"],
          modified: doc["modified"],
        }))
        .sort((a, b) => text(a.creationId).localeCompare(text(b.creationId)));
      const cadDir = path.join(root, "assets/cad");
      const files = [
        "core.py",
        ...fs
          .readdirSync(cadDir)
          .filter((f) => f.endsWith(".py") && f !== "core.py")
          .sort(),
      ];
      const bundle = files
        .map((f) => fs.readFileSync(path.join(cadDir, f), "utf8"))
        .join("\n\n");
      const report = {
        retainedSource: "tests/live-feature-modes.js",
        owner: session.report.owner,
        identity,
        bundleSha256: createHash("sha256").update(bundle).digest("hex"),
        tolerances: {
          lengthMm: 0.001,
          volumeAbsoluteMm3: 0.001,
          volumeRelative: 0.00001,
        },
        tests: [] as CaseEvidence[],
        probes: [] as Record<string, unknown>[],
      };
      const persist = () =>
        fs.writeFileSync(
          path.join(session.directory, "native-feature-modes.json"),
          JSON.stringify(report, null, 2) + "\n",
          { mode: 0o600 },
        );
      let component = "root",
        sequence = 0;
      let current: CaseEvidence = {
        name: "setup",
        status: "running",
        metrics: [],
      };
      const output = (value: string): string =>
        emit(`dict(creationId=doc.creationId, result=${value})`);
      async function script(
        label: string,
        body: string,
        options: ScriptOptions = {},
      ): Promise<unknown> {
        await harness.guard();
        const guard = `import adsk.core, adsk.fusion, json, math
app = adsk.core.Application.get()
def documents():
    return sorted([dict(name=d.name, creationId=d.creationId, saved=d.isSaved, modified=d.isModified) for d in app.documents], key=lambda d: d['creationId'])
matches = [d for d in app.documents if d.creationId == ${JSON.stringify(identity.creationId)} and d.name == ${JSON.stringify(name)}]
assert len(matches) == 1 and not matches[0].isSaved and matches[0].dataFile is None and app.activeDocument == matches[0], 'Owned active unsaved document guard failed'
doc = matches[0]
assert [d for d in documents() if d['creationId'] != doc.creationId] == ${py(foreign)}, 'Other document state changed'
`;
        const source =
          (options.cadBundle ? bundle + "\n\n" : "") + program(guard + body);
        const row: Record<string, unknown> = {
          label,
          test: current.name,
          mutation: options.mutation ?? false,
          request: options.request,
          sourceSha256: createHash("sha256").update(source).digest("hex"),
        };
        report.probes.push(row);
        persist();
        const result = await session.execute(
          "feature-mode-" + sequence++ + "-" + label,
          source,
        );
        if (nativeResultUncertain(result))
          session.deferCleanup(
            "Feature-mode probe returned unknown/pending; do not replay.",
          );
        row["result"] = result["result"];
        persist();
        return result["result"];
      }
      async function cad(
        operation: string,
        data: Record<string, unknown> = {},
        scope = component,
      ): Promise<Record<string, unknown>> {
        const entry = validateCad(operation, data);
        const result = record(
          await script(
            operation,
            `ctx = CadContext(${JSON.stringify(name)}, ${py(scope)})
result = ctx.call(${JSON.stringify(operation)}, ${py(data)})
${output("dict(result=_cad_json(result), created=ctx.created)")}`,
            {
              mutation: !entry.readOnly,
              cadBundle: true,
              request: { operation, data, component: scope },
            },
          ),
        );
        return record(result["result"]);
      }
      function near(
        actual: unknown,
        expected: unknown,
        tolerance: number,
        label: string,
      ): void {
        const metric: Metric = {
          label,
          actual,
          expected,
          tolerance,
          units: label.includes("volume")
            ? "mm3"
            : label.includes("unit direction")
              ? "unitless"
              : "mm",
          requestIndex: session.report.requests.length - 1,
          status:
            typeof actual === "number" &&
            Number.isFinite(actual) &&
            typeof expected === "number" &&
            Math.abs(actual - expected) <= tolerance
              ? "pass"
              : "fail",
        };
        current.metrics.push(metric);
        persist();
        assert.equal(metric.status, "pass", JSON.stringify(metric));
      }
      async function volume(body: unknown, expected: number): Promise<void> {
        const v = await cad("measure.volume", { ref: body, units: "mm3" });
        assert.equal(v["units"], "mm3");
        near(
          v["value"],
          expected,
          Math.max(0.001, Math.abs(expected) * 0.00001),
          "volume",
        );
      }
      async function bounds(
        body: unknown,
        min: number[],
        max: number[],
      ): Promise<void> {
        const b = await cad("measure.bounds", { ref: body, units: "mm" });
        assert.equal(b["units"], "mm");
        min.forEach((v, i) =>
          near(values(b["min"])[i], v, 0.001, "bounds min " + "xyz"[i]),
        );
        max.forEach((v, i) =>
          near(values(b["max"])[i], v, 0.001, "bounds max " + "xyz"[i]),
        );
      }
      const xyz = (x = 0, y = 0, z = 0): string[] =>
        [x, y, z].map((v) => v + " mm");
      const named = (suffix: string): string => component + "_" + suffix;
      const profileRef = (sketch: unknown) => ({
        kind: "profile",
        sketch,
        index: 0,
      });
      async function plane(
        suffix: string,
        offset: string,
      ): Promise<Record<string, unknown>> {
        return cad("datum.plane", {
          name: named(suffix),
          mode: "offset",
          plane: "XY",
          offset,
        });
      }
      async function parameter(
        key: string,
        expression: string,
        overwrite = false,
      ): Promise<void> {
        await cad(
          "param.apply",
          { parameters: [{ name: key, expression, unit: "mm" }], overwrite },
          "root",
        );
      }
      async function section(
        suffix: string,
        {
          plane: onPlane = "XY",
          rectangle,
          radius,
          point,
        }: SectionOptions = {},
      ) {
        const sketch = field(
          await cad("sketch.create", { name: named(suffix), plane: onPlane }),
          "sketch",
        );
        const geometry = point
          ? { type: "point", point }
          : rectangle
            ? { type: "rectangle", start: rectangle[0], end: rectangle[1] }
            : { type: "circle", center: xyz(), radius: radius || "4 mm" };
        const made = await cad("sketch.geometry", {
          sketch,
          geometry: [geometry],
        });
        if (!point)
          assert.equal(
            values(field(await cad("sketch.inspect", { sketch }), "profiles"))
              .length,
            1,
          );
        return {
          sketch,
          profile: profileRef(sketch),
          entities: values(field(made, "entities")),
        };
      }
      async function line(
        suffix: string,
        x: number,
        height: number,
        driving?: string,
      ) {
        const sketch = field(
          await cad("sketch.create", { name: named(suffix), plane: "XZ" }),
          "sketch",
        );
        const entity = values(
          field(
            await cad("sketch.geometry", {
              sketch,
              geometry: [{ type: "line", start: xyz(x), end: xyz(x, -height) }],
            }),
            "entities",
          ),
        )[0];
        if (driving) {
          await cad("sketch.edit", {
            sketch,
            entities: [{ entity, point: "start" }],
            fixed: true,
          });
          await cad("sketch.constrain", {
            sketch,
            type: "vertical",
            entities: [entity],
          });
          await cad("sketch.dimension", {
            sketch,
            type: "distance",
            entities: [
              { entity, point: "start" },
              { entity, point: "end" },
            ],
            text: xyz(x + 5, -height / 2),
            expression: driving,
          });
        }
        const route = field(
          await cad("path.create", { curves: [entity], chain: "none" }),
          "path",
        );
        const ends = values(
          await script(
            "native-line-endpoints",
            `ctx = CadContext(${JSON.stringify(name)}, ${py(component)})
e = ctx.resolve(${py(entity)})
${output("[ [p.x * 10, p.y * 10, p.z * 10] for p in (e.startSketchPoint.worldGeometry, e.endSketchPoint.worldGeometry) ]")}`,
            { cadBundle: true },
          ),
        );
        assert.equal(
          values(ends[0]).length,
          3,
          "Native endpoint must contain all three coordinates",
        );
        assert.equal(
          values(ends[1]).length,
          3,
          "Native endpoint must contain all three coordinates",
        );
        values(ends[0]).forEach((v, i) =>
          near(v, [x, 0, 0][i], 0.001, "line start " + "xyz"[i]),
        );
        values(ends[1]).forEach((v, i) =>
          near(v, [x, 0, height][i], 0.001, "line end " + "xyz"[i]),
        );
        return { entity, path: route };
      }
      async function native(
        feature: unknown,
        mode: string,
      ): Promise<Record<string, unknown>> {
        const result = record(
          await script(
            "native-feature-properties",
            `ctx = CadContext(${JSON.stringify(name)}, ${py(component)})
f = ctx.resolve(${py(feature)})
r = dict(name=f.name, type=f.objectType, health=int(f.healthState), message=f.errorOrWarningMessage, token=f.entityToken)
mode = ${JSON.stringify(mode)}
if mode == 'extrude':
    r['extentType'] = f.extentOne.objectType
    r['startType'] = f.startExtent.objectType
    if adsk.fusion.ToEntityExtentDefinition.cast(f.extentOne):
        r['target'] = ctx.ref(f.extentOne.entity)
        r['offset'] = f.extentOne.offset.expression
    if adsk.fusion.OffsetStartDefinition.cast(f.startExtent):
        r['startOffset'] = f.startExtent.offset.expression
elif mode == 'hole':
    r['extentType'] = f.extentDefinition.objectType
    r['defaultDirection'] = f.isDefaultDirection
    r['diameter'] = f.holeDiameter.expression
    r['direction'] = [f.direction.x, f.direction.y, f.direction.z]
    r['holeType'] = int(f.holeType)
    r['parameters'] = [dict(name=p.name, expression=p.expression, value=p.value, unit=p.unit) for p in ctx.design.allParameters if getattr(p, 'createdBy', None) == f]
    r['cylinders'] = []
    for body in f.bodies:
        for face in body.faces:
            cylinder = adsk.core.Cylinder.cast(face.geometry)
            if cylinder:
                box = face.boundingBox
                r['cylinders'].append(dict(radiusMm=cylinder.radius * 10, minZMm=box.minPoint.z * 10, maxZMm=box.maxPoint.z * 10))
elif mode == 'sweep':
    r['orientation'] = int(f.orientation)
    r['parallelEnum'] = int(adsk.fusion.SweepOrientationTypes.ParallelOrientationType)
    r['perpendicularEnum'] = int(adsk.fusion.SweepOrientationTypes.PerpendicularOrientationType)
elif mode == 'sweepRail':
    r['profileScaling'] = int(f.profileScaling)
    r['scaleEnum'] = int(adsk.fusion.SweepProfileScalingOptions.SweepProfileScaleOption)
    r['inspectionGap'] = 'guideRail getter requires timeline rollback; orientation getter is inapplicable. Neither is read by this read-only probe. Guide effect verified by separate scaling geometry test.'
elif mode == 'loft':
    r['guideCount'] = f.centerLineOrRails.count
    r['isCenterLine'] = f.centerLineOrRails.isCenterLine
${output("r")}`,
            { cadBundle: true, request: { feature, mode } },
          ),
        );
        assert.equal(result["health"], 0, JSON.stringify(result));
        return result;
      }
      async function recompute(): Promise<void> {
        const result = await cad("history.recompute");
        assert.equal(result["recomputed"], true);
        assert.equal(result["healthy"], true, JSON.stringify(result));
      }
      async function test(
        label: string,
        fn: () => Promise<void>,
      ): Promise<void> {
        current = { name: label, status: "running", metrics: [] };
        report.tests.push(current);
        persist();
        component = "Geo_" + label;
        try {
          await cad("component.create", { name: component }, "root");
          await fn();
          current.status = "pass";
        } catch (error) {
          current.status = "fail";
          current.error =
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error);
          persist();
          if (session.uncertain) throw error;
          try {
            current.failureInspection = await cad("history.check");
          } catch (inspectionError) {
            current.inspectionError = String(inspectionError);
            if (session.uncertain) throw inspectionError;
          }
        }
        persist();
      }
      await test("extrude_throughAll", async () => {
        const h = named("height");
        await parameter(h, "10 mm");
        const stock = await cad("shape.box", {
          name: named("stock"),
          width: "20 mm",
          depth: "20 mm",
          height: h,
        });
        const other = await cad("shape.box", {
          name: named("other"),
          width: "20 mm",
          depth: "20 mm",
          height: "4 mm",
          plane: await plane("otherPlane", "25 mm"),
        });
        const cut = await section("cut", {
          rectangle: [xyz(5, 5), xyz(10, 10)],
        });
        const made = await cad("model.extrude", {
          name: named("through"),
          profile: cut.profile,
          extent: "throughAll",
          direction: "positive",
          operation: "cut",
          participants: [field(stock, "bodies", 0)],
        });
        for (const height of [10, 16, 10]) {
          if (height !== 10 || current.metrics.length) {
            await parameter(h, height + " mm", true);
            await recompute();
          }
          await volume(field(stock, "bodies", 0), 375 * height);
          await bounds(field(stock, "bodies", 0), [0, 0, 0], [20, 20, height]);
          await volume(field(other, "bodies", 0), 1600);
          await bounds(field(other, "bodies", 0), [0, 0, 25], [20, 20, 29]);
          assert.match(
            text(
              field(
                await native(field(made, "feature"), "extrude"),
                "extentType",
              ),
            ),
            /ThroughAll/,
          );
        }
      });
      await test("extrude_toEntity", async () => {
        const h = named("height");
        await parameter(h, "20 mm");
        const target = await plane("target", h);
        const low = await section("section", { rectangle: [xyz(), xyz(4, 3)] });
        const made = await cad("model.extrude", {
          name: named("to"),
          profile: low.profile,
          extent: "toEntity",
          target,
          offset: "-1 mm",
          startOffset: "2 mm",
        });
        for (const height of [20, 26, 20]) {
          if (height !== 20 || current.metrics.length) {
            await parameter(h, height + " mm", true);
            await recompute();
          }
          await volume(field(made, "bodies", 0), 12 * (height - 3));
          await bounds(field(made, "bodies", 0), [0, 0, 2], [4, 3, height - 1]);
          const props = await native(field(made, "feature"), "extrude");
          assert.match(text(field(props, "extentType")), /ToEntity/);
          assert.match(text(field(props, "startType")), /OffsetStart/);
          assert.equal(
            text(field(props, "offset")).replaceAll(" ", ""),
            "-1mm",
          );
          assert.equal(
            text(field(props, "startOffset")).replaceAll(" ", ""),
            "2mm",
          );
        }
      });
      for (const extent of ["throughAll", "toEntity"])
        await test("hole_" + extent, async () => {
          const h = named("height");
          await parameter(h, "10 mm");
          const stock = await cad("shape.box", {
            name: named("stock"),
            width: "20 mm",
            depth: "20 mm",
            height: h,
          });
          const top = await plane("top", h);
          const points = await section("points", {
            plane: top,
            point: xyz(10, 10),
          });
          if (extent === "throughAll")
            await script(
              "hole-native-input-direction-diagnostic",
              `ctx = CadContext(${JSON.stringify(name)}, ${py(component)})
p = ctx.resolve(${py(points.entities[0])})
rows = []
for direction in [adsk.fusion.ExtentDirections.NegativeExtentDirection, adsk.fusion.ExtentDirections.PositiveExtentDirection]:
    inp = ctx.component.features.holeFeatures.createSimpleInput(adsk.core.ValueInput.createByString('4 mm'))
    assert inp.setPositionBySketchPoints(ctx.collection([p]))
    row = dict(directionEnum=int(direction), before=inp.isDefaultDirection)
    assert inp.setAllExtent(direction)
    row['after'] = inp.isDefaultDirection
    rows.append(row)
${output("dict(inputs=rows, point=[p.worldGeometry.x * 10, p.worldGeometry.y * 10, p.worldGeometry.z * 10])")}`,
              { cadBundle: true },
            );
          const made = await cad("model.hole", {
            name: named("hole"),
            points: points.entities,
            diameter: "4 mm",
            extent,
            ...(extent === "toEntity" ? { target: "XY" } : { reverse: false }),
            participants: [field(stock, "bodies", 0)],
          });
          for (const height of [10, 17, 10]) {
            if (height !== 10 || current.metrics.length) {
              await parameter(h, height + " mm", true);
              await recompute();
            }
            await volume(
              field(stock, "bodies", 0),
              (400 - Math.PI * 4) * height,
            );
            await bounds(
              field(stock, "bodies", 0),
              [0, 0, 0],
              [20, 20, height],
            );
            await native(field(made, "feature"), "hole");
          }
        });
      for (const type of ["simple", "counterbore", "countersink"])
        await test("hole_reverse_" + type, async () => {
          const h = named("height");
          await parameter(h, "10 mm");
          const stock = await cad("shape.box", {
            name: named("stock"),
            width: "20 mm",
            depth: "20 mm",
            height: h,
          });
          const points = await section("points", { point: xyz(10, 10) });
          const extras =
            type === "counterbore"
              ? { boreDiameter: "8 mm", boreDepth: "2 mm" }
              : type === "countersink"
                ? { sinkDiameter: "8 mm", sinkAngle: "90 deg" }
                : {};
          const made = await cad("model.hole", {
            name: named("hole"),
            points: points.entities,
            diameter: "4 mm",
            extent: "throughAll",
            reverse: true,
            type,
            ...extras,
            participants: [field(stock, "bodies", 0)],
          });
          const additionalRemoval =
            type === "counterbore"
              ? Math.PI * 12 * 2
              : type === "countersink"
                ? (Math.PI * 32) / 3
                : 0;
          for (const height of [10, 17, 10]) {
            await parameter(h, height + " mm", true);
            await recompute();
            const props = await native(field(made, "feature"), "hole");
            await volume(
              field(stock, "bodies", 0),
              (400 - Math.PI * 4) * height - additionalRemoval,
            );
            await bounds(
              field(stock, "bodies", 0),
              [0, 0, 0],
              [20, 20, height],
            );
            assert.equal(field(props, "defaultDirection"), false);
            values(field(props, "direction")).forEach((v, i) =>
              near(
                v,
                [0, 0, 1][i],
                0.000001,
                "hole unit direction " + "xyz"[i],
              ),
            );
          }
        });
      for (const orientation of ["parallel", "perpendicular"])
        await test("sweep_" + orientation, async () => {
          const h = named("length");
          await parameter(h, "20 mm");
          const sectionRef = await section("section", {
            rectangle: [xyz(-2, -1), xyz(2, 1)],
          });
          const route = await line("route", 0, 20, h);
          const made = await cad("model.sweep", {
            name: named("sweep"),
            profile: sectionRef.profile,
            path: route.path,
            orientation,
          });
          for (const length of [20, 25, 20]) {
            await parameter(h, length + " mm", true);
            await recompute();
            await volume(field(made, "bodies", 0), 8 * length);
            await bounds(field(made, "bodies", 0), [-2, -1, 0], [2, 1, length]);
            const props = await native(field(made, "feature"), "sweep");
            assert.equal(
              field(props, "orientation"),
              props[orientation + "Enum"],
            );
          }
        });
      for (const orientation of ["parallel", "perpendicular"])
        await test("sweep_bent_" + orientation, async () => {
          const sectionRef = await section("section", {
            rectangle: [xyz(-2, -1), xyz(2, 1)],
          });
          const sketch = field(
            await cad("sketch.create", { name: named("arc"), plane: "XZ" }),
            "sketch",
          );
          const arc = await cad("sketch.geometry", {
            sketch,
            geometry: [
              { type: "arc", center: xyz(20), start: xyz(), sweep: "45 deg" },
            ],
          });
          const route = field(
            await cad("path.create", { curves: field(arc, "entities") }),
            "path",
          );
          const made = await cad("model.sweep", {
            name: named("sweep"),
            profile: sectionRef.profile,
            path: route,
            orientation,
          });
          await volume(
            field(made, "bodies", 0),
            8 * 20 * (orientation === "parallel" ? Math.SQRT1_2 : Math.PI / 4),
          );
          const props = await native(field(made, "feature"), "sweep");
          assert.equal(
            field(props, "orientation"),
            props[orientation + "Enum"],
          );
          await bounds(
            field(made, "bodies", 0),
            [-2, -1, 0],
            [
              20 * (1 - Math.SQRT1_2) +
                (orientation === "parallel" ? 2 : Math.SQRT2),
              1,
              20 * Math.SQRT1_2 + (orientation === "parallel" ? 0 : Math.SQRT2),
            ],
          );
        });
      await test("sweep_guideRail", async () => {
        const h = named("length");
        await parameter(h, "20 mm");
        const sectionRef = await section("section", {
          rectangle: [xyz(-2, -1), xyz(2, 1)],
        });
        const route = await line("route", 0, 20, h),
          rail = await line("rail", 2, 20, h);
        const made = await cad("model.sweep", {
          name: named("sweep"),
          profile: sectionRef.profile,
          path: route.path,
          guideRail: rail.path,
        });
        for (const length of [20, 25, 20]) {
          await parameter(h, length + " mm", true);
          await recompute();
          await volume(field(made, "bodies", 0), 8 * length);
          await bounds(field(made, "bodies", 0), [-2, -1, 0], [2, 1, length]);
          const props = await native(field(made, "feature"), "sweepRail");
          assert.equal(
            field(props, "profileScaling"),
            field(props, "scaleEnum"),
          );
        }
        current.inspectionGap =
          "guideRail getter requires rollback; this read-only suite does not change the timeline to inspect it.";
      });
      await test("sweep_guideRail_scaling", async () => {
        const spread = named("spread");
        await parameter(spread, "1 mm");
        const sectionRef = await section("section", {
          rectangle: [xyz(-2, -1), xyz(2, 1)],
        });
        const route = await line("route", 0, 20);
        const sketch = field(
          await cad("sketch.create", { name: named("rail"), plane: "XZ" }),
          "sketch",
        );
        const entity = field(
          await cad("sketch.geometry", {
            sketch,
            geometry: [{ type: "line", start: xyz(2), end: xyz(3, -20) }],
          }),
          "entities",
          0,
        );
        await cad("sketch.edit", {
          sketch,
          entities: [{ entity, point: "start" }],
          fixed: true,
        });
        for (const [orientation, expression] of [
          ["horizontal", spread],
          ["vertical", "20 mm"],
        ]) {
          await cad("sketch.dimension", {
            sketch,
            type: "distance",
            entities: [
              { entity, point: "start" },
              { entity, point: "end" },
            ],
            text: xyz(5, -10),
            orientation,
            expression,
          });
        }
        const guideRail = field(
          await cad("path.create", { curves: [entity] }),
          "path",
        );
        const made = await cad("model.sweep", {
          name: named("sweep"),
          profile: sectionRef.profile,
          path: route.path,
          guideRail,
        });
        for (const value of [1, 2, 1]) {
          await parameter(spread, value + " mm", true);
          await recompute();
          const scale = 1 + value / 2;
          await volume(
            field(made, "bodies", 0),
            (8 * 20 * (1 + scale + scale * scale)) / 3,
          );
          await bounds(
            field(made, "bodies", 0),
            [-2 * scale, -scale, 0],
            [2 * scale, scale, 20],
          );
          const props = await native(field(made, "feature"), "sweepRail");
          assert.equal(
            field(props, "profileScaling"),
            field(props, "scaleEnum"),
          );
        }
        current.inspectionGap =
          "Native guideRail getter not read because it requires rollback; independent rail-only perturbation verifies geometric dependence.";
      });
      for (const guide of ["rails", "centerLine"])
        await test("loft_" + guide, async () => {
          const h = named("height");
          await parameter(h, "20 mm");
          const low = await section("low"),
            high = await section("high", { plane: await plane("top", h) });
          const rail = await line("guide", guide === "rails" ? 4 : 0, 20, h);
          const made = await cad("model.loft", {
            name: named("loft"),
            profiles: [low.profile, high.profile],
            ...(guide === "rails"
              ? { rails: [rail.path] }
              : { centerLine: rail.entity }),
          });
          for (const height of [20, 26, 20]) {
            await parameter(h, height + " mm", true);
            await recompute();
            await volume(field(made, "bodies", 0), Math.PI * 16 * height);
            await bounds(field(made, "bodies", 0), [-4, -4, 0], [4, 4, height]);
            const props = await native(field(made, "feature"), "loft");
            assert.equal(field(props, "guideCount"), 1);
            assert.equal(field(props, "isCenterLine"), guide === "centerLine");
          }
        });
      await harness.guard();
      persist();
      assert.ok(
        report.tests.length > 0 &&
          report.tests.every((row) => row.status === "pass"),
        "Retained native feature modes did not all pass; inspect native-feature-modes.json",
      );
    },
  }));
}

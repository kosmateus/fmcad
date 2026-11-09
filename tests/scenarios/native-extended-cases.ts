import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { Scenario } from "./runner";
import { record, text, number } from "./contracts";
import { concurrencyLimit } from "./scheduling";
import { program, emit } from "./programs";
import {
  nativeModelingHarness,
  nativeResultUncertain,
  values,
} from "./native-modeling-support";
const root = path.resolve(__dirname, "../../..");
const { catalog, validateCad } = createRequire(path.join(root, "package.json"))(
  "./src/cad",
) as typeof import("../../src/composition/cad-execution");
export const nativeExtendedCapability = "native-extended-geometry-camera";
interface CaseRow {
  name: string;
  status: "running" | "pass" | "fail" | "blocked";
  operations: Set<string>;
  metrics: string[];
  component?: string;
  error?: string;
  notTestedOperations?: string[];
}
interface ImageRow {
  fusionPath: string;
  absentBefore: boolean;
  writeAttempted: boolean;
  bytes?: number;
  wslPath?: string;
  verifiedPNG?: boolean;
  removed?: boolean;
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
async function sequentialMap<T, U>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  const result: U[] = [];
  for (const [index, item] of items.entries())
    result.push(await fn(item, index));
  return result;
}
async function sequentialEach<T>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  for (const [index, item] of items.entries()) await fn(item, index);
}
/** Retained physical modes and restoration assertions share the existing receipt queue. */
export function nativeExtendedScenarios(owners = 10): Scenario[] {
  concurrencyLimit(owners);
  return Array.from({ length: owners }, (_, index): Scenario => ({
    id: "native-extended-" + index,
    requires: ["documents", nativeExtendedCapability],
    scope: "exclusive-instance",
    async run(session) {
      const harness = await nativeModelingHarness(
        session,
        "tests/live-extended.js",
        [],
        [],
      );
      const { identity, guard } = harness;
      const name = identity.name;
      let component = "root",
        sequence = 0,
        batchDirectory: string | undefined;
      let current: CaseRow = {
        name: "setup",
        status: "running",
        operations: new Set(),
        metrics: [],
      };
      const report = {
        source: "tests/live-extended.js",
        owner: session.report.owner,
        tests: [] as CaseRow[],
        measurements: [] as Record<string, unknown>[],
        files: [] as ImageRow[],
        finalAudit: {} as Record<string, unknown>,
        batchDirectory: undefined as string | undefined,
        batchDirectoryRemoved: false,
        operationCoverage: [] as Record<string, unknown>[],
      };
      const attempted = new Set<string>();
      const persist = () => {
        report.operationCoverage = Object.keys(catalog).map((operation) => ({
          operation,
          status: report.tests.some(
            (row) => row.status === "pass" && row.operations.has(operation),
          )
            ? "pass"
            : attempted.has(operation)
              ? "fail"
              : "not-tested",
          note: "Operation invocation coverage only; inspect group status, requested modes and numeric measurement rows.",
        }));
        fs.writeFileSync(
          path.join(session.directory, "operation-coverage.json"),
          JSON.stringify(report.operationCoverage, null, 2) + "\n",
          { mode: 0o600 },
        );
        fs.writeFileSync(
          path.join(session.directory, "native-extended.json"),
          JSON.stringify(
            report,
            (_, value: unknown) => (value instanceof Set ? [...value] : value),
            2,
          ) + "\n",
          { mode: 0o600 },
        );
      };
      async function cad(
        operation: string,
        data: Record<string, unknown> = {},
        scope = component || "root",
        expectedFailure = false,
      ): Promise<Record<string, unknown>> {
        const spec = validateCad(operation, data);
        assert.ok(!["import.file", "checkpoint.open"].includes(operation));
        assert.ok(!data["reimport"], "Reimport forbidden in this fixture");
        if (!spec.readOnly) await guard();
        attempted.add(operation);
        current.operations.add(operation);
        let output: Record<string, unknown>;
        if (expectedFailure) {
          const rejected = await session.cadRejected(
            "cad-extended-rejected-" + sequence++,
            operation,
            data,
            { component: scope },
          );
          assert.equal(rejected.state, "failed");
          assert.equal(rejected.sdkSettled, true);
          try {
            output = record(JSON.parse(rejected.stdout) as unknown);
          } catch (error) {
            if (nativeResultUncertain(rejected))
              session.deferCleanup(
                "Indeterminate expected CAD failure: " + operation,
              );
            throw error;
          }
        } else
          output = await session.cad(
            "cad-extended-" + sequence++,
            operation,
            data,
            { component: scope },
          );
        if (nativeResultUncertain(output))
          session.deferCleanup(
            "Batch/native execution uncertain; no further mutations: " +
              operation,
          );
        if (!Object.keys(output).length)
          return session.deferCleanup("Empty CLI JSON envelope: " + operation);
        assert.equal(output["operation"], operation);
        if (!spec.nodeOnly) {
          assert.equal(output["document"], name);
          const native = output["result"];
          if (
            !native ||
            typeof native !== "object" ||
            Array.isArray(native) ||
            !Object.keys(native).length
          )
            return session.deferCleanup(
              "Empty CAD result object: " + operation,
            );
        }
        assert.equal(
          output["success"],
          !expectedFailure,
          JSON.stringify(output),
        );
        persist();
        return spec.nodeOnly ? output : record(output["result"]);
      }
      async function script(body: string, readOnly = true): Promise<unknown> {
        await guard();
        const wrapped = `import adsk.core, adsk.fusion, json, os, tempfile, contextlib, io
app = adsk.core.Application.get()
owned = [d for d in app.documents if d.creationId == ${JSON.stringify(identity.creationId)} and d.name == ${JSON.stringify(identity.name)}]
assert len(owned) == 1 and owned[0] == app.activeDocument and not owned[0].isSaved and owned[0].dataFile is None
captured = io.StringIO()
with contextlib.redirect_stdout(captured):
${body
  .split("\n")
  .map((line) => "    " + line)
  .join("\n")}
lines = [line for line in captured.getvalue().splitlines() if line.startswith('LIVE_EXT ')]
assert len(lines) == 1, 'Probe/lifecycle script has no unambiguous JSON result'
value = json.loads(lines[0][len('LIVE_EXT '):])
${emit(`dict(creationId=${JSON.stringify(identity.creationId)}, result=value)`)}`;
        const output = readOnly
          ? await session.observe(
              "observe-extended-" + sequence++,
              program(wrapped),
            )
          : await session.execute(
              "extended-script-" + sequence++,
              program(wrapped),
            );
        if (nativeResultUncertain(output))
          session.deferCleanup(
            "Probe/lifecycle result is unknown/pending; no further mutations",
          );
        return output["result"];
      }
      async function test(
        label: string,
        operations: string[],
        fn: () => Promise<void>,
        {
          fixture = true,
          enabled = true,
        }: {
          fixture?: boolean;
          enabled?: boolean;
        } = {},
      ): Promise<boolean> {
        const row: CaseRow = {
          name: label,
          status: "running",
          operations: new Set(),
          metrics: [],
        };
        current = row;
        report.tests.push(row);
        if (!enabled) {
          row.status = "blocked";
          persist();
          return false;
        }
        try {
          if (fixture) {
            component = "Ext_" + label.replace(/[^A-Za-z0-9_]/g, "_");
            row.component = component;
            await cad("component.create", { name: component }, "root");
          }
          await fn();
          row.status = "pass";
        } catch (error) {
          row.status = "fail";
          row.error = String(error);
          if (session.uncertain) throw error;
        } finally {
          row.notTestedOperations = operations.filter(
            (op) => !row.operations.has(op),
          );
          persist();
        }
        return row.status === "pass";
      }
      function near(
        actual: unknown,
        expected: unknown,
        tolerance: number,
        label: string,
      ): void {
        const row = {
          group: current.name,
          label,
          commandIndex: session.report.requests.length - 1,
          actual,
          expected,
          tolerance,
          status:
            typeof actual === "number" &&
            Number.isFinite(actual) &&
            typeof expected === "number" &&
            Math.abs(actual - expected) <= tolerance
              ? "pass"
              : "fail",
        };
        current.metrics.push(label);
        report.measurements.push(row);
        persist();
        assert.equal(row.status, "pass", JSON.stringify(row));
      }
      const mm = (n: number): string => n + " mm";
      const xyz = (x = 0, y = 0, z = 0): string[] => [x, y, z].map(mm);
      const named = (suffix: string): string => component + "_" + suffix;
      async function volume(
        ref: unknown,
        expected: number,
        scope = component,
      ): Promise<void> {
        const result = await cad(
          "measure.volume",
          { ref, units: "mm3" },
          scope,
        );
        assert.equal(field(result, "units"), "mm3");
        near(
          field(result, "value"),
          expected,
          Math.max(0.001, Math.abs(expected) * 0.00001),
          "measure.volume " +
            (typeof ref === "object" && ref
              ? (record(ref)["name"] ?? ref)
              : ref) +
            " mm3",
        );
      }
      async function bounds(
        ref: unknown,
        size: number[],
        min?: number[],
        scope = component,
      ): Promise<Record<string, unknown>> {
        const result = await cad("measure.bounds", { ref, units: "mm" }, scope);
        assert.equal(field(result, "units"), "mm");
        size.forEach((v, i) =>
          near(
            values(field(result, "size"))[i],
            v,
            0.001,
            "measure.bounds size " + "xyz"[i] + " mm",
          ),
        );
        if (min)
          min.forEach((v, i) =>
            near(
              values(field(result, "min"))[i],
              v,
              0.001,
              "measure.bounds min " + "xyz"[i] + " mm",
            ),
          );
        return result;
      }
      async function bodies(expected: number): Promise<unknown[]> {
        const found = values(
          field(await cad("entity.list", { kind: "body" }), "entities"),
        );
        near(field(found, "length"), expected, 0, "entity.list body count");
        return found;
      }
      async function box(
        suffix: string,
        w: string | number = 20,
        d = 12,
        h: string | number = 10,
        plane?: unknown,
      ): Promise<Record<string, unknown>> {
        return cad("shape.box", {
          name: named(suffix),
          width: typeof w === "string" ? w : mm(w),
          depth: mm(d),
          height: typeof h === "string" ? h : mm(h),
          ...(plane ? { plane } : {}),
        });
      }
      async function plane(
        suffix: string,
        offset: string | number,
        base = "XY",
      ): Promise<Record<string, unknown>> {
        return cad("datum.plane", {
          name: named(suffix),
          plane: base,
          mode: "offset",
          offset: typeof offset === "string" ? offset : mm(offset),
        });
      }
      async function face(
        axis: number[],
        position: [number, number, number],
      ): Promise<Record<string, unknown>> {
        return cad("entity.find", {
          kind: "face",
          filters: { geometry: "plane", axis, position: xyz(...position) },
          unique: true,
        });
      }
      async function circleProfile(
        suffix: string,
        radius: number,
        onPlane: unknown = "XY",
      ): Promise<unknown> {
        const sketch = field(
          await cad("sketch.create", { name: named(suffix), plane: onPlane }),
          "sketch",
        );
        await cad("sketch.geometry", {
          sketch,
          geometry: [
            {
              type: "circle",
              name: named(suffix + "_circle"),
              center: xyz(),
              radius: mm(radius),
            },
          ],
        });
        const profiles = values(
          field(await cad("sketch.inspect", { sketch }), "profiles"),
        );
        assert.equal(profiles.length, 1);
        return record(profiles[0])["ref"];
      }
      async function linePath(
        suffix: string,
        onPlane: unknown,
        start: string[],
        end: string[],
      ): Promise<unknown> {
        const sketch = field(
          await cad("sketch.create", { name: named(suffix), plane: onPlane }),
          "sketch",
        );
        const geometry = await cad("sketch.geometry", {
          sketch,
          geometry: [
            { type: "line", name: named(suffix + "_line"), start, end },
          ],
        });
        const made = await cad("path.create", {
          curves: geometry["entities"],
          chain: "none",
          name: named(suffix + "_path"),
        });
        assert.equal(
          field(
            await cad("path.inspect", record(field(made, "path"))),
            "count",
          ),
          1,
        );
        return field(made, "path");
      }
      async function parameters(
        entries: Record<string, readonly [string, string?]>,
        overwrite = false,
      ): Promise<void> {
        await cad(
          "param.apply",
          {
            parameters: Object.entries(entries).map(
              ([name, [expression, unit = "mm"]]) => ({
                name,
                expression,
                unit,
              }),
            ),
            overwrite,
          },
          "root",
        );
      }
      async function recompute(): Promise<void> {
        const result = await cad("history.recompute");
        assert.equal(field(result, "recomputed"), true);
        assert.equal(field(result, "healthy"), true, JSON.stringify(result));
      }
      const initialized = await test(
        "new_document_ownership",
        [],
        async () => {
          await guard();
          assert.equal(
            record(field(await cad("audit"), "counts"))["bodyDefinitions"],
            0,
          );
        },
        { fixture: false },
      );
      // Run design-wide health/restoration tests first so unrelated kernel failures in
      // later groups cannot hide parameter.test's own restoration behavior.
      await test(
        "section_thickness_check_parameter_restoration",
        ["measure.section", "measure.thickness", "check", "parameter.test"],
        async () => {
          const width = named("width");
          await parameters({ [width]: ["20 mm"] });
          const body = field(await box("block", width), "bodies", 0);
          const mid = await plane("mid", 5);
          const section = await cad("measure.section", {
            body,
            plane: mid,
            mode: "curves",
            units: "mm",
          });
          near(
            field(section, "edgeCount"),
            4,
            0,
            "measure.section rectangle edge count",
          );
          near(
            field(section, "totalLength", "value"),
            64,
            0.001,
            "measure.section perimeter mm",
          );
          assert.equal(field(section, "totalLength", "units"), "mm");
          const thickness = {
            a: await face([0, 0, 1], [0, 0, 0]),
            b: await face([0, 0, 1], [0, 0, 10]),
            mode: "parallelPlanes",
            units: "mm",
          };
          near(
            field(await cad("measure.thickness", thickness), "value"),
            10,
            0.001,
            "measure.thickness parallel faces mm",
          );
          const check = {
            id: named("volume_check"),
            source: "20 x 12 x 10 mm analytic fixture",
            measurement: {
              operation: "measure.volume",
              data: { ref: body, units: "mm3" },
            },
            expected: "2400 mm^3",
            tolerance: "0.01 mm^3",
          };
          assert.equal(field(await cad("check", check), "passed"), true);
          const before = await cad("param.inspect", { names: [width] });
          for (const fail of [false, true]) {
            const result = await cad(
              "parameter.test",
              {
                parameter: width,
                expressions: ["22 mm", "25 mm"],
                confirm: true,
                checks: [
                  {
                    ...check,
                    expected: fail ? "1 mm^3" : width + " * 12 mm * 10 mm",
                  },
                ],
              },
              component,
              fail,
            );
            assert.equal(field(result, "passed"), !fail);
            assert.equal(field(result, "error"), null);
            assert.equal(field(result, "restored"), true);
            assert.deepEqual(field(result, "restoreErrors"), []);
            assert.deepEqual(
              field(result, "restoredHealth"),
              field(result, "baselineHealth"),
            );
            assert.equal(field(result, "samples", "length"), 2);
            values(field(result, "samples")).forEach((sample, i) => {
              assert.equal(field(sample, "checks", 0, "passed"), !fail);
              near(
                field(sample, "checks", 0, "actual", "value"),
                number([22, 25][i]) * 120,
                0.01,
                "parameter.test sample volume mm3",
              );
            });
            assert.deepEqual(
              await cad("param.inspect", { names: [width] }),
              before,
              "parameter.test restores expression and value",
            );
            await volume(body, 2400);
            await bounds(body, [20, 12, 10], [0, 0, 0]);
          }
        },
        { enabled: initialized },
      );
      await test(
        "sweep",
        ["model.sweep"],
        async () => {
          // YZ section is normal to +X; the XY path starts at its center.
          const profile = await circleProfile("section", 3, "YZ");
          const route = await linePath("route", "XY", xyz(), xyz(20));
          const body = field(
            await cad("model.sweep", {
              name: named("sweep"),
              profile,
              path: route,
              operation: "newBody",
            }),
            "bodies",
            0,
          );
          await volume(body, Math.PI * 9 * 20);
          await bounds(body, [20, 6, 6], [0, -3, -3]);
          await bodies(1);
        },
        { enabled: initialized },
      );
      await test(
        "loft",
        ["model.loft"],
        async () => {
          const low = await circleProfile("low", 8);
          const high = await circleProfile("high", 4, await plane("top", 15));
          const body = field(
            await cad("model.loft", {
              name: named("loft"),
              profiles: [low, high],
              operation: "newBody",
              closed: false,
            }),
            "bodies",
            0,
          );
          await volume(body, (Math.PI * 15 * (64 + 32 + 16)) / 3);
          await bounds(body, [16, 16, 15], [-8, -8, 0]);
          await bodies(1);
        },
        { enabled: initialized },
      );
      await test(
        "shell",
        ["model.shell"],
        async () => {
          const body = field(await box("block"), "bodies", 0);
          await cad("model.shell", {
            name: named("shell"),
            entities: [await face([0, 0, 1], [0, 0, 10])],
            thickness: "2 mm",
            tangentChain: false,
          });
          await volume(body, 20 * 12 * 10 - 16 * 8 * 8);
          await bounds(body, [20, 12, 10], [0, 0, 0]);
          await bodies(1);
        },
        { enabled: initialized },
      );
      await test(
        "chamfer",
        ["model.chamfer"],
        async () => {
          const body = field(await box("block"), "bodies", 0);
          const top = await face([0, 0, 1], [0, 0, 10]);
          await cad("model.chamfer", {
            name: named("chamfer"),
            edges: [top],
            distance: "1 mm",
            tangentChain: false,
          });
          // Four equal-distance top-edge chamfers: integrate the inset rectangle over depth.
          const expected = (t: number) =>
            2400 - ((20 + 12) * t * t - (4 * t * t * t) / 3);
          await volume(body, expected(1));
          await bounds(body, [20, 12, 10], [0, 0, 0]);
          await bodies(1);
        },
        { enabled: initialized },
      );
      await test(
        "feature_edit_suppress",
        [
          "feature.list",
          "feature.inspect",
          "feature.edit",
          "feature.suppress",
          "feature.unsuppress",
        ],
        async () => {
          const height = named("height");
          await parameters({ [height]: ["10 mm"] });
          const made = await box("extrude", 20, 12, height);
          const body = field(made, "bodies", 0);
          const inspected = await cad("feature.inspect", {
            feature: field(made, "feature"),
          });
          assert.equal(field(inspected, "feature", "isSuppressed"), false);
          const distances = values(field(inspected, "parameters")).filter(
            (p) => text(field(p, "expression")).replaceAll(" ", "") === height,
          );
          assert.equal(
            distances.length,
            1,
            "Discover actual extrusion distance by its retained expression; never guess dN",
          );
          const parameter = distances[0];
          assert.ok(field(parameter, "unit"));
          assert.ok(
            values(field(await cad("feature.list"), "features")).some(
              (f) => field(f, "name") === named("extrude"),
            ),
          );
          await cad("feature.edit", {
            feature: field(made, "feature"),
            name: named("edited"),
            parameters: { [text(field(parameter, "name"))]: height + " * 2" },
          });
          await volume(body, 4800);
          await bounds(body, [20, 12, 20], [0, 0, 0]);
          assert.equal(
            field(
              await cad("feature.inspect", { feature: field(made, "feature") }),
              "feature",
              "name",
            ),
            named("edited"),
          );
          let suppressed = false;
          try {
            const result = await cad("feature.suppress", {
              feature: field(made, "feature"),
            });
            suppressed = true;
            assert.equal(field(result, "feature", "isSuppressed"), true);
            await bodies(0);
          } finally {
            if (suppressed && !session.uncertain)
              await cad("feature.unsuppress", {
                feature: field(made, "feature"),
              });
          }
          assert.equal(
            field(
              await cad("feature.inspect", { feature: field(made, "feature") }),
              "feature",
              "isSuppressed",
            ),
            false,
          );
          const restored = (await bodies(1))[0];
          await volume(restored, 4800);
          await bounds(restored, [20, 12, 20], [0, 0, 0]);
        },
        { enabled: initialized },
      );
      for (const operation of ["join", "cut", "intersect"]) {
        await test(
          "combine_" + operation,
          ["model.combine"],
          async () => {
            const target = field(await box("target", 10, 10, 10), "bodies", 0);
            const tool = field(
              await box("tool", 10, 10, 10, await plane("offset", 5)),
              "bodies",
              0,
            );
            await cad("model.combine", {
              name: named("boolean"),
              target,
              tools: [tool],
              operation,
              keepTools: false,
            });
            const body = (await bodies(1))[0];
            await volume(body, operation === "join" ? 1500 : 500);
            await bounds(
              body,
              [10, 10, operation === "join" ? 15 : 5],
              [0, 0, operation === "intersect" ? 5 : 0],
            );
          },
          { enabled: initialized },
        );
      }
      await test(
        "split",
        ["model.split"],
        async () => {
          const body = field(await box("block"), "bodies", 0);
          await cad("model.split", {
            name: named("split"),
            bodies: [body],
            tool: await plane("mid", 4),
            extend: true,
          });
          const pieces = (
            await sequentialMap(await bodies(2), async (ref) => ({
              ref,
              bounds: await cad("measure.bounds", { ref, units: "mm" }),
            }))
          ).sort(
            (a, b) =>
              number(values(a.bounds["min"])[2]) -
              number(values(b.bounds["min"])[2]),
          );
          await sequentialEach(pieces, async ({ ref }, i) => {
            await volume(ref, 20 * 12 * number([4, 6][i]));
            await bounds(
              ref,
              [20, 12, number([4, 6][i])],
              [0, 0, number([0, 4][i])],
            );
          });
        },
        { enabled: initialized },
      );
      await test(
        "draft",
        ["model.draft"],
        async () => {
          const body = field(await box("block"), "bodies", 0);
          const side = await face([1, 0, 0], [20, 0, 0]);
          await cad("model.draft", {
            name: named("draft"),
            faces: [side],
            plane: "XY",
            angle: "5 deg",
            reverse: false,
            symmetric: false,
            tangentChain: false,
          });
          const faces = field(
            await cad("entity.list", { kind: "face" }),
            "entities",
          );
          const candidates = values(faces).filter((f) => {
            const geometry = record(f)["geometry"];
            if (
              !geometry ||
              typeof geometry !== "object" ||
              Array.isArray(geometry)
            )
              return false;
            const normal = record(geometry)["normal"];
            return (
              Array.isArray(normal) &&
              Math.abs(number(normal[0])) > 0.9 &&
              Math.abs(number(normal[2])) > 0.01
            );
          });
          assert.equal(
            field(candidates, "length"),
            1,
            "One drafted planar side",
          );
          const n = field(candidates, 0, "geometry", "normal");
          // Signed slope comes from the measured normal, not a guessed Fusion draft sign.
          near(
            (Math.abs(Math.atan(number(field(n, 2)) / number(field(n, 0)))) *
              180) /
              Math.PI,
            5,
            0.001,
            "model.draft side inclination deg",
          );
          const delta = (-10 * number(field(n, 2))) / number(field(n, 0));
          await volume(body, 12 * 10 * (20 + delta / 2));
          await bounds(body, [20 + Math.max(0, delta), 12, 10], [0, 0, 0]);
          await bodies(1);
        },
        { enabled: initialized },
      );
      for (const distanceType of ["spacing", "extent"]) {
        await test(
          "rectangular_" + distanceType,
          ["pattern.rectangular"],
          async () => {
            const seed = field(await box("seed", 2, 3, 4), "bodies", 0);
            await cad("pattern.rectangular", {
              name: named("pattern"),
              entities: [seed],
              direction: "X",
              quantity: 3,
              distance: distanceType === "spacing" ? "10 mm" : "20 mm",
              distanceType,
              directionTwo: "Y",
              quantityTwo: 2,
              distanceTwo: "12 mm",
            });
            const refs = await bodies(6);
            await sequentialEach(refs, async (ref) => {
              await volume(ref, 24);
              await bounds(ref, [2, 3, 4]);
            });
            const starts = (
              await sequentialMap(refs, async (ref) =>
                field(await cad("measure.bounds", { ref, units: "mm" }), "min"),
              )
            ).sort(
              (a, b) =>
                number(values(a)[0]) - number(values(b)[0]) ||
                number(values(a)[1]) - number(values(b)[1]),
            );
            const expected = [0, 10, 20].flatMap((x) => [
              [x, 0, 0],
              [x, 12, 0],
            ]);
            values(starts).forEach((p, i) =>
              values(p).forEach((v, j) =>
                near(
                  v,
                  expected[i]?.[j],
                  0.001,
                  "pattern.rectangular instance " + i + " " + "xyz"[j] + " mm",
                ),
              ),
            );
            await volume(component, 144);
            await bounds(component, [22, 15, 4], [0, 0, 0]);
          },
          { enabled: initialized },
        );
        await test(
          "path_pattern_" + distanceType,
          ["pattern.path"],
          async () => {
            const seed = field(await box("seed", 2, 3, 4), "bodies", 0);
            const route = await linePath("route", "XY", xyz(), xyz(40));
            await cad("pattern.path", {
              name: named("pattern"),
              entities: [seed],
              path: route,
              quantity: 3,
              distance: distanceType === "spacing" ? "10 mm" : "20 mm",
              distanceType,
            });
            const refs = await bodies(3);
            await sequentialEach(refs, async (ref) => {
              await volume(ref, 24);
              await bounds(ref, [2, 3, 4]);
            });
            const starts = (
              await sequentialMap(refs, async (ref) =>
                field(
                  await cad("measure.bounds", { ref, units: "mm" }),
                  "min",
                  0,
                ),
              )
            ).sort((a, b) => number(a) - number(b));
            values(starts).forEach((v, i) =>
              near(v, i * 10, 0.001, "pattern.path instance x mm"),
            );
            await volume(component, 72);
          },
          { enabled: initialized },
        );
      }
      await test(
        "mirror",
        ["model.mirror"],
        async () => {
          const seed = field(await box("seed", 2, 3, 4), "bodies", 0);
          await cad("model.mirror", {
            name: named("mirror"),
            entities: [seed],
            plane: await plane("mirror_plane", 5, "YZ"),
          });
          const refs = await bodies(2);
          await sequentialEach(refs, async (ref) => await volume(ref, 24));
          await bounds(component, [10, 3, 4], [0, 0, 0]);
          const mins = (
            await sequentialMap(refs, async (ref) =>
              field(
                await cad("measure.bounds", { ref, units: "mm" }),
                "min",
                0,
              ),
            )
          ).sort((a, b) => number(a) - number(b));
          mins.forEach((v, i) =>
            near(v, [0, 8][i], 0.001, "model.mirror instance min x mm"),
          );
        },
        { enabled: initialized },
      );
      await test(
        "generated_slot_regeneration",
        ["shape.slot", "param.apply", "history.recompute"],
        async () => {
          const p = (suffix: string) => named(suffix);
          await parameters({
            [p("length")]: ["30 mm"],
            [p("width")]: ["6 mm"],
            [p("height")]: ["3 mm"],
            [p("x")]: ["10 mm"],
            [p("y")]: ["-5 mm"],
            [p("z")]: ["2 mm"],
            [p("angle")]: ["0 deg", "deg"],
          });
          const made = await cad("shape.slot", {
            name: named("slot"),
            length: p("length"),
            width: p("width"),
            thickness: p("height"),
            position: [p("x"), p("y"), p("z")],
            angle: p("angle"),
            operation: "newBody",
            symmetric: true,
          });
          assert.equal(field(made, "recipe"), "slot");
          assert.ok(number(field(made, "slotGeometry", "length")) >= 4);
          const body = (await bodies(1))[0];
          await volume(body, ((30 - 6) * 6 + Math.PI * 9) * 3);
          await bounds(body, [30, 6, 3], [-5, -8, 0.5]);
          await parameters(
            {
              [p("length")]: ["40 mm"],
              [p("width")]: ["8 mm"],
              [p("height")]: ["4 mm"],
              [p("x")]: ["-7 mm"],
              [p("y")]: ["9 mm"],
              [p("z")]: ["-3 mm"],
              [p("angle")]: ["90 deg", "deg"],
            },
            true,
          );
          await recompute();
          await volume(body, ((40 - 8) * 8 + Math.PI * 16) * 4);
          await bounds(body, [8, 40, 4], [-11, -11, -5]);
          const caps = field(
            await cad("entity.find", {
              kind: "face",
              filters: { geometry: "cylinder", radius: "4 mm" },
            }),
            "entities",
          );
          assert.equal(field(caps, "length"), 2);
          await sequentialEach(values(caps), async (ref) =>
            near(
              field(await cad("measure.radius", { ref, units: "mm" }), "value"),
              4,
              0.001,
              "shape.slot regenerated cap radius mm",
            ),
          );
        },
        { enabled: initialized },
      );
      await test(
        "generated_bolt_circle_regeneration",
        ["shape.bolt_circle", "param.apply", "history.recompute"],
        async () => {
          const p = (suffix: string) => named(suffix);
          await parameters({
            [p("pitch")]: ["20 mm"],
            [p("diameter")]: ["4 mm"],
            [p("depth")]: ["8 mm"],
            [p("phase")]: ["0 deg", "deg"],
            [p("quantity")]: ["4", ""],
          });
          const plate = field(
            await cad("shape.cylinder", {
              name: named("plate"),
              radius: "30 mm",
              height: "5 mm",
            }),
            "bodies",
            0,
          );
          const made = await cad("shape.bolt_circle", {
            name: named("holes"),
            pitchDiameter: p("pitch"),
            diameter: p("diameter"),
            depth: p("depth"),
            phase: p("phase"),
            quantity: p("quantity"),
            participants: [plate],
            reverse: true,
          });
          assert.equal(field(made, "recipe"), "bolt_circle");
          assert.ok(field(made, "seed", "feature", "token"));
          async function verify(
            pitch: number,
            diameter: number,
            quantity: number,
            phase: number,
          ) {
            await volume(
              plate,
              Math.PI * (900 - (quantity * diameter * diameter) / 4) * 5,
            );
            await bounds(plate, [60, 60, 5], [-30, -30, 0]);
            const cylinders = field(
              await cad("entity.find", {
                kind: "face",
                filters: { geometry: "cylinder", radius: mm(diameter / 2) },
              }),
              "entities",
            );
            assert.equal(values(cylinders).length, quantity);
            for (let i = 0; i < quantity; i++) {
              const angle = ((phase + (i * 360) / quantity) * Math.PI) / 180;
              const found = await cad("entity.find", {
                kind: "face",
                filters: {
                  geometry: "cylinder",
                  radius: mm(diameter / 2),
                  axis: [0, 0, 1],
                  position: xyz(
                    (pitch / 2) * Math.cos(angle),
                    (pitch / 2) * Math.sin(angle),
                    0,
                  ),
                },
                unique: true,
              });
              near(
                field(
                  await cad("measure.diameter", { ref: found, units: "mm" }),
                  "value",
                ),
                diameter,
                0.001,
                "shape.bolt_circle hole " + i + " diameter mm",
              );
              const origin = field(found, "geometry", "origin");
              near(
                Math.hypot(number(field(origin, 0)), number(field(origin, 1))) *
                  10,
                pitch / 2,
                0.001,
                "shape.bolt_circle hole axis pitch radius mm",
              );
            }
            await bodies(1);
          }
          await verify(20, 4, 4, 0);
          await parameters(
            {
              [p("pitch")]: ["30 mm"],
              [p("diameter")]: ["6 mm"],
              [p("depth")]: ["10 mm"],
              [p("phase")]: ["30 deg", "deg"],
              [p("quantity")]: ["6", ""],
            },
            true,
          );
          await recompute();
          await verify(30, 6, 6, 30);
        },
        { enabled: initialized },
      );
      for (const type of ["rigid", "revolute"]) {
        await test(
          "joint_" + type,
          [
            "joint." + type,
            "joint.inspect",
            "joint.edit",
            "assembly.ground",
            "assembly.unground",
            ...(type === "revolute" ? ["joint.drive"] : []),
          ],
          async () => {
            const baseName = named("base");
            const armName = named("arm");
            const base = field(
              await cad("component.create", { name: baseName }, "root"),
              "occurrence",
            );
            const arm = field(
              await cad("component.create", { name: armName }, "root"),
              "occurrence",
            );
            await cad(
              "shape.box",
              {
                name: baseName + "_body",
                width: "4 mm",
                depth: "4 mm",
                height: "2 mm",
              },
              baseName,
            );
            const body = field(
              await cad(
                "shape.box",
                {
                  name: armName + "_body",
                  width: "20 mm",
                  depth: "4 mm",
                  height: "2 mm",
                },
                armName,
              ),
              "bodies",
              0,
            );
            const proxy = { ...record(body), occurrence: arm };
            assert.equal(
              field(
                await cad("assembly.ground", { occurrence: base }, "root"),
                "grounded",
              ),
              true,
            );
            const before = await cad(
              "measure.bounds",
              { ref: proxy, units: "mm" },
              "root",
            );
            const made = await cad(
              "joint." + type,
              {
                name: named("joint"),
                occurrenceOne: base,
                occurrenceTwo: arm,
                ...(type === "revolute" ? { point: "origin", axis: "Z" } : {}),
              },
              "root",
            );
            assert.equal(field(made, "asBuilt"), true);
            assert.equal(field(made, "type"), type);
            assert.match(
              text(field(made, "joint", "objectType")),
              /AsBuiltJoint$/,
            );
            const after = await cad(
              "measure.bounds",
              { ref: proxy, units: "mm" },
              "root",
            );
            for (const field of ["min", "max", "size"]) {
              values(before[field]).forEach((value, i) =>
                near(
                  values(after[field])[i],
                  value,
                  0.001,
                  "joint." +
                    type +
                    " as-built " +
                    field +
                    " " +
                    "xyz"[i] +
                    " mm",
                ),
              );
            }
            const joint = field(made, "joint");
            const inspected = await cad("joint.inspect", { joint }, "root");
            assert.equal(
              field(inspected, "motionType"),
              type === "rigid" ? "RigidJointMotion" : "RevoluteJointMotion",
            );
            assert.equal(field(inspected, "occurrences", "length"), 2);
            await cad("joint.edit", { joint, name: named("renamed") }, "root");
            assert.equal(
              field(
                await cad("joint.inspect", { joint }, "root"),
                "joint",
                "name",
              ),
              named("renamed"),
            );
            let suppressed = false;
            try {
              const result = await cad(
                "joint.edit",
                { joint, suppressed: true },
                "root",
              );
              suppressed = true;
              assert.equal(field(result, "joint", "isSuppressed"), true);
            } finally {
              if (suppressed && !session.uncertain)
                await cad("joint.edit", { joint, suppressed: false }, "root");
            }
            assert.equal(
              field(
                await cad("joint.inspect", { joint }, "root"),
                "joint",
                "isSuppressed",
              ),
              false,
            );
            if (type === "revolute") {
              try {
                const driven = await cad(
                  "joint.drive",
                  { joint, rotation: "90 deg" },
                  "root",
                );
                near(
                  field(driven, "rotationValue"),
                  Math.PI / 2,
                  0.00001,
                  "joint.drive actual radians",
                );
                near(
                  field(
                    await cad("joint.inspect", { joint }, "root"),
                    "rotationValue",
                  ),
                  Math.PI / 2,
                  0.00001,
                  "joint.inspect driven radians",
                );
                // Sign depends on joint frame convention; a 90-degree turn must still
                // exchange the non-square arm's world X/Y extents, not just set a scalar.
                await bounds(proxy, [4, 20, 2], undefined, "root");
                await volume(proxy, 160, "root");
              } finally {
                if (!session.uncertain)
                  await cad(
                    "joint.drive",
                    { joint, rotation: "0 deg" },
                    "root",
                  );
              }
              await bounds(proxy, [20, 4, 2], [0, 0, 0], "root");
            } else {
              await bounds(proxy, [20, 4, 2], [0, 0, 0], "root");
              await volume(proxy, 160, "root");
            }
            assert.equal(
              field(
                await cad("assembly.unground", { occurrence: base }, "root"),
                "grounded",
              ),
              false,
            );
          },
          { enabled: initialized },
        );
      }
      await test(
        "assembly_interference_clearance",
        ["assembly.interference", "assembly.clearance"],
        async () => {
          const aName = named("a");
          const bName = named("b");
          const a = field(
            await cad("component.create", { name: aName }, "root"),
            "occurrence",
          );
          const b = field(
            await cad(
              "component.create",
              { name: bName, placement: { translation: xyz(5) } },
              "root",
            ),
            "occurrence",
          );
          const refs = await sequentialMap(
            [aName, bName],
            async (scope, i) => ({
              ...record(
                field(
                  await cad(
                    "shape.box",
                    {
                      name: scope + "_box",
                      width: "10 mm",
                      depth: "10 mm",
                      height: "10 mm",
                    },
                    scope,
                  ),
                  "bodies",
                  0,
                ),
              ),
              occurrence: [a, b][i],
            }),
          );
          const data = { a: field(refs, 0), b: field(refs, 1) };
          const overlap = await cad(
            "assembly.interference",
            data,
            "root",
            true,
          );
          assert.equal(field(overlap, "interferes"), true);
          near(
            field(overlap, "overlapVolume", "value"),
            500,
            0.001,
            "assembly.interference overlap mm3",
          );
          near(
            field(overlap, "distance", "value"),
            0,
            0.001,
            "assembly.interference overlapping distance mm",
          );
          assert.equal(
            field(
              await cad(
                "assembly.clearance",
                { ...data, minimum: "1 mm" },
                "root",
                true,
              ),
              "passed",
            ),
            false,
          );
          await cad(
            "occurrence.transform",
            { occurrence: b, placement: { translation: xyz(13) } },
            "root",
          );
          const clear = await cad(
            "assembly.clearance",
            { ...data, minimum: "2 mm" },
            "root",
          );
          near(
            field(clear, "distance", "value"),
            3,
            0.001,
            "assembly.clearance separated distance mm",
          );
          near(
            field(clear, "overlapVolume", "value"),
            0,
            0.001,
            "assembly.clearance no overlap mm3",
          );
          assert.equal(field(clear, "passed"), true);
          assert.equal(
            field(
              await cad("assembly.interference", data, "root"),
              "interferes",
            ),
            false,
          );
          assert.equal(
            field(
              await cad(
                "assembly.clearance",
                { ...data, minimum: "4 mm" },
                "root",
                true,
              ),
              "passed",
            ),
            false,
          );
          await sequentialEach(
            refs,
            async (ref) => await volume(ref, 1000, "root"),
          );
        },
        { enabled: initialized },
      );
      await test(
        "batch_run_and_failed_gate",
        ["batch.run", "check"],
        async () => {
          batchDirectory = fs.mkdtempSync(
            path.join(os.tmpdir(), name + "_batch_"),
          );
          report.batchDirectory = batchDirectory;
          const data = {
            name: named("batch_box"),
            width: "2 mm",
            depth: "3 mm",
            height: "4 mm",
          };
          const check = {
            id: named("batch_volume"),
            measurement: {
              operation: "measure.volume",
              data: {
                ref: { $ref: "seed.result.bodies.0" },
                units: "mm3",
              },
            },
            expected: "24 mm^3",
            tolerance: "0.001 mm^3",
          };
          // Exactly one potential mutation per batch, guarded immediately before launch.
          const passed = await cad("batch.run", {
            runId: named("pass"),
            reportPath: path.join(batchDirectory, "pass"),
            operations: [
              { id: "seed", operation: "shape.box", data },
              { id: "gate", operation: "check", data: check },
            ],
          });
          assert.equal(field(passed, "status"), "success");
          assert.deepEqual(
            values(field(passed, "steps")).map((step) => field(step, "status")),
            ["success", "success"],
          );
          near(
            field(passed, "steps", 1, "output", "result", "actual", "value"),
            24,
            0.001,
            "batch.run resolved reference volume mm3",
          );
          const body = (await bodies(1))[0];
          await volume(body, 24);
          const before = await cad("component.inspect");
          // Per-step failed-check output is the non-atomic contract; atomic rollback
          // reports this failure through step.error instead.
          const failed = await cad(
            "batch.run",
            {
              runId: named("fail"),
              reportPath: path.join(batchDirectory, "fail"),
              atomic: false,
              operations: [
                {
                  id: "gate",
                  operation: "check",
                  data: {
                    ...check,
                    measurement: {
                      operation: "measure.volume",
                      data: { ref: body, units: "mm3" },
                    },
                    expected: "999 mm^3",
                  },
                },
                {
                  id: "must_not_run",
                  operation: "shape.box",
                  data: { ...data, name: named("FORBIDDEN") },
                },
              ],
            },
            component,
            true,
          );
          assert.equal(field(failed, "status"), "failed");
          assert.deepEqual(
            values(field(failed, "steps")).map((step) => field(step, "status")),
            ["failed", "skipped"],
          );
          assert.equal(
            field(failed, "steps", 0, "output", "operation"),
            "check",
          );
          assert.equal(
            field(failed, "steps", 0, "output", "result", "passed"),
            false,
            "Must fail the measured gate, not operation dispatch",
          );
          near(
            field(failed, "steps", 0, "output", "result", "actual", "value"),
            24,
            0.001,
            "batch failed gate actual volume mm3",
          );
          assert.equal(
            field(failed, "steps", 1, "request"),
            undefined,
            "Next mutation must not even start",
          );
          assert.equal(field(failed, "steps", 1, "output"), undefined);
          assert.deepEqual(await cad("component.inspect"), before);
          assert.ok(
            !values(field(await cad("feature.list"), "features")).some(
              (f) => field(f, "name") === named("FORBIDDEN"),
            ),
          );
          await bodies(1);
          await volume(body, 24);
        },
        { enabled: initialized },
      );
      function cameraEqual(
        actual: Record<string, unknown>,
        expected: Record<string, unknown>,
      ) {
        assert.deepEqual(
          field(actual, "document"),
          field(expected, "document"),
        );
        assert.equal(
          field(actual, "cameraType"),
          field(expected, "cameraType"),
        );
        assert.equal(field(actual, "units"), field(expected, "units"));
        for (const field of ["eye", "target", "up", "extents"]) {
          if (expected[field]) {
            assert.equal(
              values(actual[field]).length,
              values(expected[field]).length,
            );
            values(expected[field]).forEach((v, i) =>
              near(
                values(actual[field])[i],
                v,
                0.00001,
                "camera restored " + field + "[" + i + "] internal units",
              ),
            );
          }
        }
        if (field(expected, "perspectiveAngle") !== undefined)
          near(
            field(actual, "perspectiveAngle"),
            field(expected, "perspectiveAngle"),
            0.00001,
            "camera restored perspective rad",
          );
      }
      await test(
        "visibility",
        [
          "visibility.hide",
          "visibility.show",
          "visibility.restore",
          "visibility.isolate",
        ],
        async () => {
          const first = field(await box("one", 2, 3, 4), "bodies", 0);
          const second = field(
            await box("two", 2, 3, 4, await plane("offset", 10)),
            "bodies",
            0,
          );
          let restore;
          try {
            const hidden = await cad("visibility.hide", {
              refs: [first, second],
            });
            restore = field(hidden, "restoreState");
            assert.deepEqual(
              values(field(hidden, "items")).map((item) =>
                field(item, "isLightBulbOn"),
              ),
              [false, false],
            );
            assert.deepEqual(
              values(
                field(
                  await cad("visibility.show", { refs: [first, second] }),
                  "items",
                ),
              ).map((item) => field(item, "isLightBulbOn")),
              [true, true],
            );
            assert.deepEqual(
              values(
                field(
                  await cad("visibility.isolate", {
                    refs: [first],
                    scope: [first, second],
                  }),
                  "items",
                ),
              ).map((item) => field(item, "isLightBulbOn")),
              [true, false],
            );
          } finally {
            if (restore && !session.uncertain) {
              const restored = await cad("visibility.restore", {
                state: restore,
              });
              assert.deepEqual(
                values(field(restored, "items")).map((item) =>
                  field(item, "isLightBulbOn"),
                ),
                values(field(restore, "items")).map((item) =>
                  field(item, "isLightBulbOn"),
                ),
              );
            }
          }
          await volume(first, 24);
          await volume(second, 24);
        },
        { enabled: initialized },
      );
      await test(
        "style_lists",
        ["appearance.list", "material.list"],
        async () => {
          await box("block");
          for (const kind of ["appearance", "material"]) {
            const local = await cad(kind + ".list");
            assert.equal(field(local, "kind"), kind);
            assert.ok(Array.isArray(field(local, "items")));
            assert.ok(Array.isArray(field(local, "libraries")));
            for (const row of [
              ...values(field(local, "items")),
              ...values(field(local, "libraries")),
            ]) {
              assert.equal(typeof field(row, "id"), "string");
              assert.ok(text(field(row, "id")).length);
              assert.equal(typeof field(row, "name"), "string");
            }
            if (field(local, "libraries", "length")) {
              const library = await cad(kind + ".list", {
                library: field(local, "libraries", 0, "id"),
              });
              assert.equal(
                field(library, "library"),
                field(local, "libraries", 0, "id"),
              );
              assert.ok(Array.isArray(field(library, "items")));
            }
          }
        },
        { enabled: initialized },
      );
      await test(
        "camera_and_shot_pack",
        ["camera.save", "camera.set", "camera.restore", "shot.pack"],
        async () => {
          const body = field(await box("block"), "bodies", 0);
          const original = field(await cad("camera.save"), "state");
          try {
            await cad("camera.set", {
              eye: xyz(80, 60, 50),
              target: xyz(10, 6, 5),
              up: [0, 0, 1],
              projection: "perspective",
              perspectiveAngle: "40 deg",
              fit: false,
            });
            const changed = field(await cad("camera.save"), "state");
            assert.equal(field(changed, "cameraType"), "PerspectiveCameraType");
            near(
              field(changed, "perspectiveAngle"),
              (40 * Math.PI) / 180,
              0.00001,
              "camera.set perspective rad",
            );
            [8, 6, 5].forEach((v, i) =>
              near(
                values(record(changed)["eye"])[i],
                v,
                0.00001,
                "camera.set eye cm",
              ),
            );
            const now = await guard();
            assert.ok(
              field(now, "tempExists") &&
                path.win32.isAbsolute(text(field(now, "tempDir"))),
              "Require existing Fusion Windows temp directory from read-only probe",
            );
            const files = ["front", "iso-top-right"].map((label) => ({
              path: path.win32.join(
                text(field(now, "tempDir")),
                name + "_" + label + ".png",
              ),
              camera: { orientation: label, fit: true },
              width: 640,
              height: 480,
            }));
            const present =
              await script(`paths = ${JSON.stringify(files.map((file) => file.path))}
print('LIVE_EXT ' + json.dumps([os.path.lexists(p) for p in paths]))`);
            assert.deepEqual(
              present,
              [false, false],
              "Never overwrite an existing image",
            );
            report.files.push(
              ...files.map((file) => ({
                fusionPath: file.path,
                absentBefore: true,
                writeAttempted: true,
              })),
            );
            const shots = await cad("shot.pack", { shots: files });
            assert.equal(field(shots, "images", "length"), 2);
            assert.equal(field(shots, "cameraRestored"), true);
            cameraEqual(
              record(field(await cad("camera.save"), "state")),
              record(changed),
            );
            for (let i = 0; i < number(field(shots, "images", "length")); i++) {
              const image = record(values(shots["images"])[i]);
              assert.equal(
                path.win32.normalize(text(field(image, "path"))),
                files[i]!.path,
              );
              assert.ok(
                field(image, "exists") && number(field(image, "bytes")) > 24,
              );
              const mapped = text(image["path"])
                .replace(
                  /^([A-Za-z]):[\\/]/,
                  (_match: string, drive: string) =>
                    "/mnt/" + drive.toLowerCase() + "/",
                )
                .replaceAll("\\", "/");
              const bytes = fs.readFileSync(mapped);
              assert.equal(bytes.length, field(image, "bytes"));
              assert.deepEqual(
                bytes.subarray(0, 8),
                Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
              );
              assert.equal(bytes.toString("ascii", 12, 16), "IHDR");
              near(
                bytes.readUInt32BE(16),
                640,
                0,
                "shot.pack PNG width pixels",
              );
              near(
                bytes.readUInt32BE(20),
                480,
                0,
                "shot.pack PNG height pixels",
              );
              const ownedImage = report.files.find(
                (file) => file.fusionPath === files[i]!.path,
              );
              assert.ok(
                ownedImage,
                "PNG must correspond to its original owned output intent",
              );
              Object.assign(ownedImage, {
                bytes: number(field(image, "bytes")),
                wslPath: mapped,
                verifiedPNG: true,
              });
            }
          } finally {
            if (!session.uncertain) {
              await cad("camera.restore", { state: original });
              cameraEqual(
                record(field(await cad("camera.save"), "state")),
                record(original),
              );
            }
          }
          await volume(body, 2400);
        },
        { enabled: initialized },
      );
      await test(
        "final_audit",
        ["audit", "history.check"],
        async () => {
          report.finalAudit = await cad("audit");
          const health = await cad("history.check");
          assert.equal(field(health, "healthy"), true, JSON.stringify(health));
          assert.deepEqual(report.finalAudit["issues"], []);
        },
        { fixture: false, enabled: initialized },
      );
      await test(
        "cleanup_owned_images",
        [],
        async () => {
          for (const file of report.files) {
            await guard();
            const result = await script(
              `app = adsk.core.Application.get()
matches = [d for d in app.documents if d.creationId == ${JSON.stringify(identity?.creationId)} and d.name == ${JSON.stringify(name)}]
assert len(matches) == 1 and not matches[0].isSaved and matches[0] == app.activeDocument, 'Owned identity changed before file cleanup'
p = ${JSON.stringify(file.fusionPath)}
assert os.path.dirname(p) == tempfile.gettempdir() and os.path.basename(p).startswith(${JSON.stringify(name + "_")}), 'Not a fixture temp path'
assert not os.path.islink(p), 'Refuse symbolic link cleanup'
if os.path.exists(p):
    assert os.path.isfile(p), 'Not a regular file'
    os.remove(p)
print('LIVE_EXT ' + json.dumps({"path": p, "removed": not os.path.lexists(p)}))`,
              false,
            );
            assert.equal(field(result, "removed"), true);
            file.removed = true;
          }
        },
        { fixture: false, enabled: !!identity },
      );
      await guard();
      if (batchDirectory && !session.uncertain) {
        fs.rmSync(batchDirectory, { recursive: true });
        report.batchDirectoryRemoved = true;
      }
      persist();
      assert.ok(
        report.tests.every((row) => field(row, "status") === "pass"),
        "Retained native extended groups failed; inspect native-extended.json",
      );
    },
  }));
}

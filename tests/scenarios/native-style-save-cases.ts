import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { Scenario } from "./runner";
import { record, number, text } from "./contracts";
import { concurrencyLimit } from "./scheduling";
import { values } from "./native-modeling-support";
import { NativeProbe } from "./native-probe";
import { nativeCadRuntime } from "./native-cad-runtime";
const root = path.resolve(__dirname, "../../..");
const load = createRequire(path.join(root, "package.json"));
const { executeCad } = load(
  "./src/cad",
) as typeof import("../../src/composition/cad-execution");
const { pythonValue: py } = load(
  "./src/python",
) as typeof import("../../packages/node-adapters/src/python/artifact");
export const nativeStyleSaveCapability = "native-style-save-addin";
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

/** Retained local preview is an offline check and never a cloud save. */
export async function nativeStyleSavePreview() {
  return executeCad(
    {
      callTool() {
        throw new Error("Preview must not access backend");
      },
    },
    "document.save_as",
    {
      name: "FMCAD_STYLE_OFFLINE",
      project: "OFFLINE_PLACEHOLDER_NOT_A_DESTINATION",
      folder: "",
      confirm: true,
    },
    { doc: "FMCAD_STYLE_OFFLINE", preview: true },
  );
}

const helpers = `
import tempfile
app = adsk.core.Application.get()
def doc_rows():
    return sorted([dict(name=d.name, creationId=d.creationId, saved=d.isSaved, modified=d.isModified, fileId=d.dataFile.id if d.dataFile else None) for d in app.documents], key=lambda r: (r['creationId'], r['name']))
def identity(d):
    return dict(name=d.name, creationId=d.creationId)
def same_doc(d, key):
    return d.name == key['name'] and d.creationId == key['creationId']
def checked_doc(key):
    matches = [d for d in app.documents if same_doc(d, key)]
    assert len(matches) == 1, 'Document name/creationId guard failed'
    return matches[0]
def guard(key, original):
    d = checked_doc(key)
    assert app.activeDocument == d and not d.isSaved and d.dataFile is None, 'Owned document must be active and unsaved'
    assert app.userInterface.activeCommand in ('', 'SelectCommand'), 'Interactive command open'
    remaining = [r for r in doc_rows() if not (r['name'] == key['name'] and r['creationId'] == key['creationId'])]
    assert remaining == original, 'Other document states changed'
    return d
def density_metadata(material):
    matches = [p for p in material.materialProperties if 'density' in p.id.casefold() and adsk.core.FloatProperty.cast(p)]
    if len(matches) != 1:
        return None
    p = matches[0]
    value = getattr(p, 'value', None)
    units = getattr(p, 'units', None)
    expression_units = {'KilogramPerCubicMeter': 'kg / m^3', 'GramPerCubicCentimeter': 'g / cm^3'}.get(units)
    return dict(id=p.id, name=p.name, value=value if type(value) in (int, float) and math.isfinite(value) else None,
                units=units, expressionUnits=expression_units, type=p.objectType)
def colors(appearance):
    if appearance is None:
        return None
    rows = []
    for p in appearance.appearanceProperties:
        color = adsk.core.ColorProperty.cast(p)
        if color and not color.hasMultipleValues:
            v = color.value
            rows.append(dict(id=p.id, rgba=[v.red, v.green, v.blue, v.opacity]))
    return sorted(rows, key=lambda r: r['id'])
def native_state(ctx, refs):
    rows = []
    for ref in refs:
        e = ctx.resolve(ref)
        kind = _cad_kind(e)
        m = e.body.material if kind == 'face' else e.component.material if kind == 'occurrence' else e.material
        a = getattr(e, 'appearance', None)
        row = dict(kind=kind, name=getattr(e, 'name', None), material=_io_style_value(m),
                   appearance=_io_style_value(a), colors=colors(a), source=getattr(e, 'appearanceSourceType', None))
        if row['source'] is not None:
            row['source'] = int(row['source'])
        if kind == 'body':
            assert e.nativeObject is None and e.assemblyContext is None and not e.isTransient
            p = e.physicalProperties
            row['physicalProperties'] = dict(mass=p.mass, density=p.density, volume=p.volume,
                                            units=dict(mass='kg', density='kg/cm3', volume='cm3'))
            metadata = density_metadata(m)
            converted = None
            if metadata and metadata['value'] is not None and metadata['expressionUnits']:
                converted = ctx.design.unitsManager.convert(metadata['value'], metadata['expressionUnits'], 'kg / cm^3')
                assert math.isfinite(converted) and converted > 0, 'Density unit conversion failed'
            row['sourceMaterial'] = dict(id=m.id, name=m.name, density=metadata, densityKgPerCm3=converted)
            row['materialAppearance'] = _io_style_value(m.appearance)
        rows.append(row)
    return rows
`;

export function nativeStyleSaveScenarios(owners = 10): Scenario[] {
  concurrencyLimit(owners);
  return Array.from({ length: owners }, (_, index): Scenario => ({
    id: "native-style-save-" + index,
    requires: ["documents", nativeStyleSaveCapability, "original-user-view"],
    scope: "exclusive-instance",
    async run(session) {
      assert.equal(
        session.backend.protocol,
        "addin",
        "Retained style/save qualification is addin-only",
      );
      const owned = session.document,
        name = owned.name;
      const baseline = session.originalView;
      const bundle = nativeCadRuntime();
      const native = new NativeProbe(
        session,
        "native-style-save",
        "STYLE_SAVE ",
        bundle + "\n" + helpers,
      );
      const report = {
        source: "tests/live-style-save.js",
        status: "running",
        owner: session.report.owner,
        owned,
        baseline,
        bundleSha256: createHash("sha256").update(bundle).digest("hex"),
        tests: [] as Record<string, unknown>[],
        probeLabels: [] as string[],
        ownedFiles: [] as string[],
        fixture: {} as Record<string, unknown>,
        cleanup: undefined as unknown,
        cleanupError: undefined as string | undefined,
      };
      const persist = () =>
        fs.writeFileSync(
          path.join(session.directory, "native-style-save.json"),
          JSON.stringify(report, null, 2) + "\n",
          { mode: 0o600 },
        );
      function guardCode(): string {
        assert.ok(owned && baseline, "No owned document identity");
        return `doc = guard(${py(owned)}, ${py(baseline["documents"])})\n`;
      }
      const emit = (expression: string): string =>
        `print('STYLE_SAVE ' + json.dumps(_cad_json(${expression}), allow_nan=False))`;
      const contextCode = (): string => `ctx = CadContext(${py(owned.name)})\n`;
      async function probe(
        label: string,
        code: string | ((requestId: string) => string),
        { mutation = false }: { mutation?: boolean } = {},
      ): Promise<unknown> {
        report.probeLabels.push(label);
        const body =
          typeof code === "function"
            ? (requestId: string) => guardCode() + code(requestId)
            : guardCode() + code;
        const value = await native.script<unknown>(body, !mutation);
        persist();
        return value;
      }
      async function cad(
        operation: string,
        data: Record<string, unknown> = {},
        component: unknown = "root",
      ): Promise<Record<string, unknown>> {
        const result = await native.compiled(
          operation,
          data,
          typeof component === "string" ? component : record(component),
          (source) => {
            const needle = "def run(_context: str):\n";
            assert.equal(source.split(needle).length, 2);
            return source.replace(
              needle,
              helpers +
                "\n" +
                needle +
                guardCode()
                  .split("\n")
                  .filter(Boolean)
                  .map((line) => "    " + line + "\n")
                  .join(""),
            );
          },
        );
        assert.equal(result["success"], true, JSON.stringify(result));
        return record(result["result"]);
      }
      async function test(
        label: string,
        fn: () => Promise<unknown>,
      ): Promise<void> {
        const row: Record<string, unknown> = {
          name: label,
          status: "running",
          requestStart: session.report.requests.length,
        };
        report.tests.push(row);
        persist();
        try {
          row["evidence"] = await fn();
          row["status"] = "pass";
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          row["status"] = message.includes("BLOCKED:") ? "blocked" : "fail";
          row["error"] = String(error);
          throw error;
        } finally {
          row["requestEnd"] = session.report.requests.length;
          persist();
        }
      }
      function near(
        actual: unknown,
        expected: unknown,
        absolute = 1e-10,
      ): void {
        const a = number(actual),
          e = number(expected);
        assert.ok(Number.isFinite(a) && Number.isFinite(e));
        assert.ok(
          Math.abs(a - e) <= Math.max(absolute, Math.abs(e) * 0.00001),
          `Expected ${actual} near ${expected}`,
        );
      }
      function physicalUnchanged(
        beforeValue: unknown,
        afterValue: unknown,
      ): void {
        const before = values(beforeValue),
          after = values(afterValue);
        assert.equal(field(after, "length"), field(before, "length"));
        values(before).forEach((row, i) => {
          assert.deepEqual(field(after, i, "material"), field(row, "material"));
          if (field(row, "physicalProperties"))
            for (const key of ["mass", "density", "volume"])
              near(
                field(after, i, "physicalProperties", key),
                field(row, "physicalProperties", key),
              );
        });
      }
      async function snapshot(refs: unknown[]): Promise<unknown[]> {
        return values(
          await probe(
            "native-style-and-physical-readback",
            contextCode() + emit(`native_state(ctx, ${py(refs)})`),
          ),
        );
      }
      async function rejection(
        operation: string,
        data: Record<string, unknown>,
        refs: unknown[],
        pattern: RegExp,
      ): Promise<Record<string, unknown>> {
        const before = await snapshot(refs);
        const result = record(
          await probe(
            "prevalidate-" + operation,
            contextCode() +
              `
styles_before = dict(materials=[_io_style_value(v) for v in ctx.design.materials], appearances=[_io_style_value(v) for v in ctx.design.appearances])
error = None
try:
    ctx.call(${py(operation)}, ${py(data)})
except ValueError as exc:
    error = str(exc)
assert error is not None, 'Expected handler ValueError'
assert styles_before == dict(materials=[_io_style_value(v) for v in ctx.design.materials], appearances=[_io_style_value(v) for v in ctx.design.appearances]), 'Unexpected style copy'
assert not doc.isSaved and doc.dataFile is None
${emit("dict(error=error, saved=doc.isSaved)")}`,
            { mutation: true },
          ),
        );
        assert.match(text(result["error"]), pattern);
        assert.deepEqual(
          await snapshot(refs),
          before,
          "Rejected mixed refs performed earlier writes",
        );
        return result;
      }
      persist();
      try {
        const made = await cad("component.create", { name: "StyleDefinition" });
        const component = field(made, "component");
        const box = await cad(
          "shape.box",
          {
            name: "StyleBody",
            width: "10 mm",
            depth: "10 mm",
            height: "10 mm",
          },
          component,
        );
        const body = field(box, "bodies", 0);
        const otherBox = await cad(
          "shape.box",
          { name: "OtherBody", width: "5 mm", depth: "5 mm", height: "5 mm" },
          component,
        );
        const other = field(otherBox, "bodies", 0);
        const linked = await cad("occurrence.add", {
          component,
          copyMode: "linked",
        });
        const fixture = await probe(
          "native-fixture-refs",
          contextCode() +
            `
b = ctx.resolve(${py(body)})
c = ctx.resolve(${py(component)})
assert b.parentComponent == c and b.faces.count == 6
b.name = 'StyleBody'
ctx.resolve(${py(other)}).name = 'OtherBody'
assert ctx.resolve(${py(field(made, "occurrence"))}).component == ctx.resolve(${py(field(linked, "occurrence"))}).component
assert not ctx.design.snapshots.hasPendingSnapshot
${emit("dict(face=ctx.ref(b.faces.item(0)), enums={n: int(getattr(adsk.core.AppearanceSourceTypes, n)) for n in ('MaterialAppearanceSource', 'BodyAppearanceSource', 'OccurrenceAppearanceSource', 'FaceAppearanceSource', 'OverrideAppearanceSource')})")}`,
          { mutation: true },
        );
        const refs = [
          body,
          other,
          field(fixture, "face"),
          field(made, "occurrence"),
          field(linked, "occurrence"),
          component,
        ];
        report.fixture = {
          component,
          body,
          other,
          ...record(fixture),
          occurrences: [field(made, "occurrence"), field(linked, "occurrence")],
        };
        near(
          field(await snapshot([body]), 0, "physicalProperties", "volume"),
          1,
          1e-8,
        );

        let selected: unknown;
        await test("discover-loaded-styles-and-density-metadata", async () => {
          const local = await cad("material.list");
          const catalogs: Record<string, unknown>[] = [];
          for (const lib of values(field(local, "libraries")))
            catalogs.push(
              await cad("material.list", { library: field(lib, "id") }),
            );
          selected = await probe(
            "choose-materials-by-metadata",
            contextCode() +
              `
local = list(ctx.design.materials)
candidates = []
for catalog in ${py(catalogs)}:
    lib = app.materialLibraries.itemById(catalog['library'])
    for item in catalog['items']:
        m = lib.materials.itemById(item['id'])
        if any(v.id == m.id or v.name == m.name for v in local):
            continue
        density = density_metadata(m)
        if density and density['value'] is not None and density['value'] > 0:
            candidates.append(dict(id=m.id, name=m.name, library=lib.id, density=density))
pair = next(([a, b] for a in candidates for b in candidates if a['id'] != b['id'] and a['name'] != b['name'] and a['density']['units'] == b['density']['units'] and abs(a['density']['value'] / b['density']['value'] - 1) > 0.1), None)
assert pair is not None, 'BLOCKED: no two collision-free loaded materials with differing density metadata'
${emit("dict(materials=pair, candidateCount=len(candidates))")}`,
          );
          return { local, catalogs, selected };
        });
        let materialA: unknown,
          materialB: unknown,
          massA: unknown,
          massB: unknown;
        await test("component-and-native-body-physical-material", async () => {
          const a = field(selected, "materials", 0),
            b = field(selected, "materials", 1);
          materialA = await cad("material.assign", {
            refs: [component],
            id: field(a, "id"),
            library: field(a, "library"),
          });
          assert.equal(
            field(await snapshot([component]), 0, "material", "id"),
            field(materialA, "id"),
          );
          const componentInspection = await cad("material.inspect", {
            refs: [component],
          });
          assert.equal(
            field(componentInspection, "items", 0, "material", "id"),
            field(materialA, "id"),
          );
          assert.equal(
            field(componentInspection, "items", 0, "materialSource"),
            "Component.material",
          );
          await cad("material.assign", {
            refs: [body, other],
            id: field(materialA, "id"),
          });
          massA = field(await snapshot([body]), 0);
          materialB = await cad("material.assign", {
            refs: [body],
            id: field(b, "id"),
            library: field(b, "library"),
          });
          massB = field(await snapshot([body]), 0);
          assert.equal(field(massB, "material", "id"), field(materialB, "id"));
          for (const row of [massA, massB]) {
            const p = field(row, "physicalProperties");
            assert.ok(
              number(field(p, "mass")) > 0 && number(field(p, "density")) > 0,
            );
            near(
              field(p, "mass"),
              number(field(p, "density")) * number(field(p, "volume")),
            );
            assert.ok(
              number(field(row, "sourceMaterial", "density", "value")) > 0,
              "Assigned body material density property unavailable",
            );
            if (field(row, "sourceMaterial", "densityKgPerCm3") !== null) {
              near(
                field(p, "density"),
                field(row, "sourceMaterial", "densityKgPerCm3"),
              );
              near(
                field(p, "mass"),
                number(field(row, "sourceMaterial", "densityKgPerCm3")) *
                  number(field(p, "volume")),
              );
            }
          }
          near(
            field(massB, "physicalProperties", "volume"),
            field(massA, "physicalProperties", "volume"),
            1e-8,
          );
          const ratio =
            number(field(b, "density", "value")) /
            number(field(a, "density", "value"));
          near(
            number(field(massB, "physicalProperties", "mass")) /
              number(field(massA, "physicalProperties", "mass")),
            ratio,
          );
          near(
            number(field(massB, "physicalProperties", "density")) /
              number(field(massA, "physicalProperties", "density")),
            ratio,
          );
          near(
            field(massA, "sourceMaterial", "density", "value"),
            field(a, "density", "value"),
          );
          near(
            field(massB, "sourceMaterial", "density", "value"),
            field(b, "density", "value"),
          );
          assert.ok(
            Math.abs(
              number(field(massA, "physicalProperties", "mass")) /
                number(field(massB, "physicalProperties", "mass")) -
                1,
            ) > 0.1,
          );
          const measured = await cad("measure.mass", {
            ref: body,
            units: "kg",
          });
          near(
            field(measured, "value"),
            field(massB, "physicalProperties", "mass"),
          );
          const bodyInspection = await cad("material.inspect", {
            refs: [body, field(fixture, "face")],
          });
          assert.equal(
            field(bodyInspection, "items", 0, "material", "id"),
            field(materialB, "id"),
          );
          assert.equal(
            field(bodyInspection, "items", 0, "materialSource"),
            "BRepBody.material",
          );
          return {
            selected,
            materialA,
            materialB,
            massA,
            massB,
            measured,
            componentInspection,
            bodyInspection,
            expectedMassRatio: ratio,
            densityUnitsGap:
              field(massB, "sourceMaterial", "densityKgPerCm3") === null
                ? "Metadata units absent; density ratio and native mass=density*volume checked, absolute metadata conversion not claimed"
                : null,
          };
        });

        await test("physical-face-and-invalid-mixed-ref-prevalidation", async () => {
          const face = await rejection(
            "material.assign",
            {
              refs: [body, field(fixture, "face")],
              id: field(materialA, "id"),
            },
            refs,
            /native Component or BRepBody|appearance.assign/,
          );
          const invalid = await rejection(
            "material.assign",
            {
              refs: [body, { kind: "body", name: "invalid_" + name }],
              id: field(materialA, "id"),
            },
            refs,
            /match|resolve|Reference/i,
          );
          return { face, invalid };
        });

        let visual: unknown;
        await test("appearance-cascade-face-instance-and-clear", async () => {
          const local = await cad("appearance.list");
          const catalogs: Record<string, unknown>[] = [];
          for (const lib of values(field(local, "libraries")))
            catalogs.push(
              await cad("appearance.list", { library: field(lib, "id") }),
            );
          const choice = await probe(
            "choose-loaded-colored-appearance",
            contextCode() +
              `
local = list(ctx.design.appearances)
chosen = None
for catalog in ${py(catalogs)}:
    lib = app.materialLibraries.itemById(catalog['library'])
    for item in catalog['items']:
        a = lib.appearances.itemById(item['id'])
        if not any(v.id == a.id or v.name == a.name for v in local) and colors(a):
            chosen = dict(id=a.id, name=a.name, library=lib.id, colors=colors(a))
            break
    if chosen:
        break
assert chosen is not None, 'BLOCKED: no collision-free loaded appearance with readable colors'
${emit("chosen")}`,
          );
          const before = await snapshot(refs);
          visual = await cad("appearance.assign", {
            refs: [component],
            id: field(choice, "id"),
            library: field(choice, "library"),
          });
          assert.equal(field(visual, "count"), 2);
          assert.equal(
            field(visual, "mapping", 0, "scope"),
            "component-body-cascade",
          );
          let state = await snapshot(refs);
          physicalUnchanged(before, state);
          for (const i of [0, 1]) {
            assert.equal(
              field(state, i, "appearance", "id"),
              field(visual, "id"),
            );
            assert.equal(
              field(state, i, "source"),
              field(fixture, "enums", "BodyAppearanceSource"),
            );
            assert.deepEqual(
              field(state, i, "colors"),
              field(choice, "colors"),
            );
          }
          const cascadeInspect = await cad("appearance.inspect", {
            refs: [body, other, field(fixture, "face")],
          });
          for (const i of [0, 1]) {
            assert.equal(
              field(cascadeInspect, "items", i, "appearanceSource"),
              "BodyAppearanceSource",
            );
            assert.equal(
              field(cascadeInspect, "items", i, "appearanceOverride"),
              true,
            );
          }
          assert.equal(
            field(cascadeInspect, "items", 2, "appearanceSource"),
            "BodyAppearanceSource",
          );
          assert.equal(
            field(cascadeInspect, "items", 2, "appearanceOverride"),
            false,
            "Inherited body appearance is not a face override",
          );
          const localId = { id: field(visual, "id") };
          const instanceId = field(before, 0, "materialAppearance", "id");
          assert.notEqual(
            instanceId,
            field(visual, "id"),
            "Instance test needs a distinct actual style",
          );
          const localStyles = field(await cad("appearance.list"), "items");
          assert.ok(
            values(localStyles).some(
              (item) => record(item)["id"] === instanceId,
            ),
          );
          const faceId = values(localStyles)
            .map(record)
            .find(
              (item) =>
                item["id"] !== field(visual, "id") && item["id"] !== instanceId,
            )?.["id"];
          assert.ok(
            faceId,
            "BLOCKED: face test needs a local appearance distinct from body override and underlying material appearance",
          );
          await cad("appearance.assign", {
            refs: [field(fixture, "face")],
            id: faceId,
          });
          physicalUnchanged(before, await snapshot(refs));
          await cad("appearance.assign", {
            refs: [field(made, "occurrence")],
            id: instanceId,
          });
          state = await snapshot(refs);
          physicalUnchanged(before, state);
          assert.equal(field(state, 2, "appearance", "id"), faceId);
          assert.equal(
            field(state, 2, "source"),
            field(fixture, "enums", "FaceAppearanceSource"),
          );
          const faceInspect = await cad("appearance.inspect", {
            refs: [field(fixture, "face")],
          });
          assert.equal(
            field(faceInspect, "items", 0, "appearanceSource"),
            "FaceAppearanceSource",
          );
          assert.equal(
            field(faceInspect, "items", 0, "appearanceOverride"),
            true,
          );
          assert.equal(field(state, 3, "appearance", "id"), instanceId);
          assert.deepEqual(
            field(state, 4),
            field(before, 4),
            "Other instance changed",
          );
          assert.deepEqual(
            field(state, 5),
            field(before, 5),
            "Component definition changed",
          );
          const instanceInspect = await cad("appearance.inspect", {
            refs: [field(made, "occurrence"), field(linked, "occurrence")],
          });
          assert.equal(
            field(instanceInspect, "items", 0, "appearanceSource"),
            "OccurrenceOverride",
          );
          assert.equal(
            field(instanceInspect, "items", 0, "appearanceOverride"),
            true,
          );
          assert.equal(
            field(instanceInspect, "items", 1, "appearanceOverride"),
            false,
          );
          const masked = await snapshot(refs);
          await cad("appearance.clear", { refs: [component] });
          state = await snapshot(refs);
          physicalUnchanged(before, state);
          for (const i of [0, 1]) {
            assert.equal(
              field(state, i, "source"),
              field(fixture, "enums", "OccurrenceAppearanceSource"),
            );
            assert.equal(field(state, i, "appearance", "id"), instanceId);
          }
          assert.deepEqual(
            field(state, 2),
            field(masked, 2),
            "Component clear removed face override",
          );
          assert.deepEqual(
            field(state, 3),
            field(masked, 3),
            "Component clear removed instance override",
          );
          await cad("appearance.clear", {
            refs: [field(fixture, "face"), field(made, "occurrence")],
          });
          state = await snapshot(refs);
          physicalUnchanged(before, state);
          for (const i of [0, 1]) {
            assert.equal(
              field(state, i, "source"),
              field(fixture, "enums", "MaterialAppearanceSource"),
            );
            assert.equal(
              field(state, i, "appearance", "id"),
              field(state, i, "materialAppearance", "id"),
            );
          }
          assert.equal(
            field(state, 2, "appearance", "id"),
            field(state, 0, "appearance", "id"),
          );
          assert.equal(
            field(state, 2, "source"),
            field(fixture, "enums", "MaterialAppearanceSource"),
          );
          assert.equal(field(state, 3, "appearance"), null);
          assert.deepEqual(field(state, 4), field(before, 4));
          const cleared = await cad("appearance.inspect", {
            refs: [body, field(fixture, "face"), field(made, "occurrence")],
          });
          for (const i of [0, 1]) {
            assert.equal(
              field(cleared, "items", i, "appearanceSource"),
              "MaterialAppearanceSource",
            );
            assert.equal(
              field(cleared, "items", i, "appearanceOverride"),
              false,
            );
          }
          assert.equal(field(cleared, "items", 2, "appearanceOverride"), false);
          await rejection(
            "appearance.assign",
            {
              refs: [body, { kind: "body", name: "invalid_" + name }],
              ...localId,
            },
            refs,
            /match|resolve|Reference/i,
          );
          await rejection(
            "appearance.assign",
            {
              refs: [body],
              id: field(choice, "id"),
              library: field(choice, "library"),
            },
            refs,
            /collision/i,
          );
          // Leave three distinct override scopes in the archive, then check every visual-only step.
          await cad("appearance.assign", { refs: [body], ...localId });
          physicalUnchanged(before, await snapshot(refs));
          await rejection(
            "appearance.clear",
            { refs: [body, { kind: "body", name: "invalid_" + name }] },
            refs,
            /match|resolve|Reference/i,
          );
          await cad("appearance.assign", {
            refs: [field(fixture, "face")],
            id: faceId,
          });
          physicalUnchanged(before, await snapshot(refs));
          const beforeInstance = await snapshot(refs);
          await cad("appearance.assign", {
            refs: [field(made, "occurrence")],
            id: instanceId,
          });
          const final = await snapshot(refs);
          physicalUnchanged(before, final);
          assert.equal(
            field(final, 0, "appearance", "id"),
            field(visual, "id"),
          );
          assert.equal(
            field(final, 0, "source"),
            field(fixture, "enums", "BodyAppearanceSource"),
          );
          assert.equal(field(final, 2, "appearance", "id"), faceId);
          assert.equal(
            field(final, 2, "source"),
            field(fixture, "enums", "FaceAppearanceSource"),
          );
          assert.equal(field(final, 3, "appearance", "id"), instanceId);
          for (const i of [0, 2, 4, 5])
            assert.deepEqual(
              field(final, i),
              field(beforeInstance, i),
              "Instance override changed an explicit override or another instance",
            );
          assert.equal(
            field(final, 1, "source"),
            field(fixture, "enums", "OccurrenceAppearanceSource"),
          );
          assert.equal(field(final, 1, "appearance", "id"), instanceId);
          return {
            choice,
            actualLocalId: field(visual, "id"),
            faceId,
            instanceId,
            before,
            final,
            cascadeInspect,
            faceInspect,
            instanceInspect,
            cleared,
          };
        });

        await test("unsaved-status-and-no-cloud-destination", async () => {
          const before = await cad("document.status");
          assert.equal(field(before, "saved"), false);
          assert.equal(field(before, "fileId"), null);
          const confirm = await rejection(
            "document.save_as",
            { name, project: "NOT_SELECTED", folder: "", confirm: false },
            refs,
            /confirm/i,
          );
          const missing = await rejection(
            "document.save_as",
            { name, confirm: true },
            refs,
            /Missing inputs/,
          );
          const after = await cad("document.status");
          assert.deepEqual(after, before);
          return { before, confirm, missing, after };
        });

        await test("local-f3d-style-and-mass-roundtrip", async () => {
          const checkpoint = text(
            await probe(
              "reserve-known-checkpoint-path",
              `
p = Path(tempfile.gettempdir()) / ${py(name + ".f3d")}
assert p.parent.is_dir() and not p.exists() and not p.is_symlink()
${emit("str(p)")}`,
            ),
          );
          report.ownedFiles.push(checkpoint);
          persist();
          const saved = await cad("checkpoint.create", { path: checkpoint });
          assert.equal(field(saved, "exists"), true);
          assert.ok(number(field(saved, "bytes")) > 0);
          assert.equal(field(saved, "userDocumentSaved"), false);
          assert.equal(field(await cad("document.status"), "saved"), false);
          const before = await snapshot(refs);
          // Use the real checkpoint.open handler, but retain the returned document object
          // in this one request so copies sharing a creationId cannot be mistaken for ours.
          const roundtrip = await probe(
            "guarded-checkpoint-open-and-compare",
            (requestId) => {
              const original = session.report.requests.at(-1);
              assert.ok(
                original && original.requestId === requestId,
                "Child receipt must use its original bound native request",
              );
              const receipt = session.prepareChildReceipt(
                original.phase,
                requestId,
                path.join(session.directory, name + ".f3d"),
                { allowCopiedCreationId: true },
              );
              return (
                contextCode() +
                `
assert hasattr(app.importManager, 'createFusionArchiveImportOptions') and hasattr(app.importManager, 'importToNewDocument'), 'BLOCKED: safe archive import API unavailable'
source = doc
prior_docs = list(app.documents)
result = ctx.call('checkpoint.open', dict(path=${py(checkpoint)}))
new_docs = [d for d in app.documents if d not in prior_docs]
assert len(new_docs) == 1, 'Import ownership ambiguous; do not close unknown documents'
imported = new_docs[0]
key = result['document']
assert same_doc(imported, key) and imported != source and not imported.isSaved
assert not any(d.name == ${py(name + "_REIMPORT")} for d in app.documents)
# A copied archive may share creationId; object provenance plus returned name is required.
assert same_doc(imported, key) and imported not in prior_docs
imported.name = ${py(name + "_REIMPORT")}
key = identity(imported)
assert imported.dataFile is None and not imported.isSaved
receipt_path = ${py(receipt)}
assert not os.path.lexists(receipt_path), 'Never overwrite an existing child receipt'
receipt_value = dict(requestId=${py(requestId)}, clientId=${py(session.report.owner.clientId)}, parentCreationId=${py(owned.creationId)}, path=${py(checkpoint)}, creationId=key['creationId'], name=key['name'], saved=False, fileId=None, identityMode='native-object-in-original-request')
def write_receipt(status):
    receipt_value['status'] = status
    temporary = receipt_path + '.new'
    assert not os.path.lexists(temporary)
    with open(temporary, 'x', encoding='utf-8') as stream:
        json.dump(receipt_value, stream, allow_nan=False)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, receipt_path)
write_receipt('created')
try:
    assert checked_doc(key) == imported and app.activeDocument == imported
    ic = CadContext(imported.name)
    c = ic.resolve(dict(kind='component', name='StyleDefinition'))
    b = _cad_unique([b for b in c.bRepBodies if b.name == 'StyleBody'], 'Imported body')
    other = _cad_unique([b for b in c.bRepBodies if b.name == 'OtherBody'], 'Imported other body')
    occurrences = list(ic.root.allOccurrences)
    assert len(occurrences) == 2 and all(o.component == c for o in occurrences)
    first = _cad_unique([o for o in occurrences if o.appearance is not None], 'Styled occurrence')
    second = _cad_unique([o for o in occurrences if o.appearance is None], 'Unstyled occurrence')
    face = _cad_unique([f for f in b.faces if f.appearanceSourceType == adsk.core.AppearanceSourceTypes.FaceAppearanceSource], 'Styled face')
    actual = native_state(ic, [ic.ref(e) for e in (b, other, face, first, second, c)])
finally:
    assert checked_doc(key) == imported and imported not in prior_docs and not imported.isSaved and imported.dataFile is None
    assert [d for d in app.documents if d != imported] == prior_docs
    assert imported.close(False), 'Close imported owned document failed'
    assert checked_doc(${py(owned)}) == source and not source.isSaved
    assert source.activate() and app.activeDocument == source
    write_receipt('closed')
${emit("dict(imported=key, actual=actual, closed=True)")}`
              );
            },
            { mutation: true },
          );
          physicalUnchanged(before, field(roundtrip, "actual"));
          for (let i = 0; i < number(field(before, "length")); i++) {
            assert.deepEqual(
              field(roundtrip, "actual", i, "appearance"),
              field(before, i, "appearance"),
            );
            assert.deepEqual(
              field(roundtrip, "actual", i, "colors"),
              field(before, i, "colors"),
            );
            assert.equal(
              field(roundtrip, "actual", i, "source"),
              field(before, i, "source"),
            );
          }
          assert.equal(field(await cad("document.status"), "saved"), false);
          return { checkpoint: saved, before, roundtrip };
        });

        report.status = "pass";
      } finally {
        if (!native.uncertain) {
          try {
            session.verifyChildClosures();
            report.cleanup = await probe(
              "cleanup-only-owned-files",
              `
for filename in ${py(report.ownedFiles)}:
    guard(${py(owned)}, ${py(baseline["documents"])})
    p = Path(filename)
    assert p.parent == Path(tempfile.gettempdir()) and p.name == ${py(name + ".f3d")} and not p.is_symlink()
    if p.exists():
        assert p.is_file()
        p.unlink()
${emit("dict(filesRemoved=" + py(report.ownedFiles) + ")")}`,
              { mutation: true },
            );
          } catch (error) {
            report.cleanupError = String(error);
            report.status = "fail";
          }
        } else {
          report.cleanup = {
            status: "blocked",
            reason: "Indeterminate execution; no blind cleanup",
            owned,
          };
          report.status = "fail";
        }
        persist();
      }
      // Existing ScenarioSession closes the primary and verifies/restores the captured user camera/workspace.
      assert.equal(
        report.status,
        "pass",
        "See native-style-save.json and original-user-view receipts",
      );
    },
  }));
}

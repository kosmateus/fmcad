import assert from "node:assert/strict";
import path from "node:path";
import type { Scenario } from "./runner";
import { record } from "./contracts";
import { NativeProbe } from "./native-probe";

export const nativeMotionCapability = "native-motion-geometry-workspace";
interface Ref extends Record<string, unknown> {
  token: string;
  kind: string;
  objectType: string;
}
interface JointRef extends Record<string, unknown> {
  token: string;
}
interface Part {
  kind: string;
  occurrence: Ref;
  component: Ref;
  body: Ref;
  joint?: JointRef;
}
interface PoseRow {
  volume: number;
  matrix: number[];
  vertices: number[][];
  values: Record<string, number>;
  grounded: boolean;
}
interface PoseState {
  rows: PoseRow[];
  camera: unknown;
  workspace: string;
}
interface Environment {
  documents: {
    creationId: string;
    name: string;
    fileId: string | null;
    saved: boolean;
    modified: boolean;
    products: string[];
  }[];
  active: string | null;
  workspace: string;
  command: string;
}
interface StoryboardRef {
  index: number;
  document: string;
}
interface NativeResult {
  collectionAccess: string;
  productAccessed: boolean;
  component: Ref;
  occurrence: Ref;
  bodies: Ref[];
  asBuilt: boolean;
  motionType: string;
  joint: Ref;
  limits: Record<string, unknown>;
  passed: boolean;
  status: string;
  restored: boolean;
  restoreErrors: unknown[];
  error: unknown;
  samples: {
    fraction: number;
    joints: Record<string, number>[];
    checks: { passed: boolean; actual: { value: number } }[];
  }[];
  frameFiles: string[];
  workspaceActive: boolean;
  ref: StoryboardRef;
  storyboards: { ref: StoryboardRef }[];
  end: number;
  playheadPosition: number;
  isInPlayMode: boolean;
}
interface NativeEnvelope {
  success: boolean;
  result: NativeResult;
}
interface Observations {
  poses: { check: unknown; pose: PoseState }[];
  nativeCalls: string[];
  mappedData: Record<string, unknown>;
}
const py = (value: unknown): string =>
  `json.loads(${JSON.stringify(JSON.stringify(value))})`;
const emit = (expression: string): string =>
  `print('MOTION_PROBE ' + json.dumps(${expression}, allow_nan=False))`;
function required<T>(value: T | undefined): T {
  assert.notEqual(value, undefined);
  return value!;
}
function closeNumbers(
  actual: unknown,
  expected: unknown,
  tolerance = 1e-7,
): void {
  if (typeof expected === "number") {
    assert.ok(
      typeof actual === "number" &&
        Number.isFinite(actual) &&
        Math.abs(actual - expected) <= tolerance,
      `${actual} != ${expected}`,
    );
  } else if (expected && typeof expected === "object") {
    assert.ok(actual && typeof actual === "object");
    assert.deepEqual(Object.keys(actual), Object.keys(expected));
    for (const key of Object.keys(expected))
      closeNumbers(
        (actual as Record<string, unknown>)[key],
        (expected as Record<string, unknown>)[key],
        tolerance,
      );
  } else assert.equal(actual, expected);
}
const helpers = `import adsk.core, adsk.fusion, json, math, os, tempfile, sys, struct, hashlib
app = adsk.core.Application.get()
def documents():
    return sorted([dict(creationId=d.creationId, name=d.name, fileId=d.dataFile.id if d.dataFile else None, saved=d.isSaved, modified=d.isModified,
                         products=[p.objectType for p in d.products]) for d in app.documents], key=lambda d: d['creationId'])
def camera_state():
    c = app.activeViewport.camera
    return dict(eye=list(c.eye.asArray()), target=list(c.target.asArray()), up=list(c.upVector.asArray()),
                cameraType=int(c.cameraType), viewExtents=c.viewExtents, perspectiveAngle=c.perspectiveAngle)
def environment():
    return dict(documents=documents(), active=app.activeDocument.creationId if app.activeDocument else None,
                workspace=app.userInterface.activeWorkspace.id, command=app.userInterface.activeCommand)
def pose_state():
    d = adsk.fusion.Design.cast(app.activeDocument.products.itemByProductType('DesignProductType'))
    rows = []
    for spec in FIXTURE:
        o = d.findEntityByToken(spec['occurrence']['token'])[0]
        j = d.findEntityByToken(spec['joint']['token'])[0] if spec.get('joint') else None
        m = j.jointMotion if j else None
        native = o.component.bRepBodies.item(0)
        proxy = o.bRepBodies.item(0)
        expected = []
        for vertex in native.vertices:
            p = vertex.geometry.copy()
            assert p.transformBy(o.transform2)
            expected.append(list(p.asArray()))
        actual = [list(v.geometry.asArray()) for v in proxy.vertices]
        assert len(actual) == 8 and len(expected) == 8
        assert all(any(max(abs(a-b) for a,b in zip(p,q)) < 1e-6 for q in actual) for p in expected), 'Proxy vertices disagree with occurrence transform'
        box = proxy.preciseBoundingBox
        rows.append(dict(kind=spec['kind'], matrix=list(o.transform2.asArray()), vertices=actual,
                         bounds=[list(box.minPoint.asArray()), list(box.maxPoint.asArray())],
                         volume=proxy.volume, grounded=o.isGrounded,
                         values={k:getattr(m,k) for k in ('rotationValue','slideValue') if m and hasattr(m,k)}))
    return dict(rows=rows, camera=camera_state(), workspace=app.userInterface.activeWorkspace.id)
`;

/** Retains the production profiler and native geometry/PNG/workspace assertions. */
export function nativeMotionScenarios(owners = 2): Scenario[] {
  return Array.from({ length: owners }, (_, index): Scenario => ({
    id: "native-motion-animation-" + index,
    scope: "exclusive-instance",
    requires: [
      "documents",
      nativeMotionCapability,
      "original-user-view-absolute-camera",
    ],
    async run(session) {
      const probe = new NativeProbe(
        session,
        "native-motion-animation",
        "MOTION_PROBE ",
      );
      const identity = session.document,
        name = identity.name,
        fixture: Part[] = [],
        ownedFiles: string[] = [];
      const nativeBaseline = await probe.script<Environment>(
        helpers + "\n" + emit("environment()"),
      );
      const baseline = {
        documents: nativeBaseline.documents.filter(
          (d) => d.creationId !== identity.creationId,
        ),
        workspace: session.originalView["workspace"],
        temp: probe.directory,
      };
      assert.equal(nativeBaseline.workspace, baseline.workspace);
      const guard =
        () => `matches = [d for d in app.documents if d.creationId == ${py(identity.creationId)}]
assert len(matches) == 1, 'Owned creationId missing or ambiguous'
doc = matches[0]
assert doc.isValid and doc.name == ${py(name)} and not doc.isSaved and doc.dataFile is None and app.activeDocument == doc, 'Owned active unsaved identity guard'
assert [d for d in documents() if d['creationId'] != doc.creationId] == ${py(baseline.documents)}, 'User document state changed'
assert app.userInterface.activeCommand in ('', 'SelectCommand'), 'Interactive command: no mutation or cleanup'
`;
      const script = async <T = Record<string, unknown>>(
        label: string,
        body: string,
        { readOnly = true }: { readOnly?: boolean } = {},
      ): Promise<T> => {
        const result = await probe.script<T>(
          helpers + `\nFIXTURE = ${py(fixture)}\n` + guard() + body,
          readOnly,
        );
        probe.observations.push({ phase: label, result });
        probe.persist();
        return result;
      };
      const observation = (): Observations => {
        const row = required(
          probe.observations.findLast((row) =>
            row.phase.includes("-compiled-"),
          ),
        );
        const values = record(row.result)["observations"];
        assert.ok(Array.isArray(values));
        assert.equal(values.length, 1);
        const value = record(values[0]);
        assert.ok(
          Array.isArray(value["poses"]) && Array.isArray(value["nativeCalls"]),
        );
        record(value["mappedData"]);
        return value as unknown as Observations;
      };
      const cad = (
        operation: string,
        data: Record<string, unknown> = {},
        component: string | Record<string, unknown> = "root",
      ): Promise<NativeEnvelope> =>
        probe.compiled<NativeEnvelope>(
          operation,
          data,
          component,
          (original) =>
            original +
            `
${helpers}
FIXTURE = ${py(fixture)}
_test_compiled_run = run
def run(_context: str):
${guard()
  .split("\n")
  .map((line) => "    " + line)
  .join("\n")}
    observations, native_calls = [], []
    def observer(frame, event, arg):
        module = frame.f_globals.get('__name__', '')
        method = frame.f_code.co_name
        simulation_method = module.startswith('adsk.sim') and (method in ('get', 'create', 'solve', 'add', 'submit') or 'self' in frame.f_locals or 'cls' in frame.f_locals)
        if event == 'call' and (simulation_method or (method == 'play' and module.startswith('adsk.fusion'))):
            native_calls.append(module + '.' + method)
        if event == 'return' and method == '_measure_check' and frame.f_locals.get('data', {}).get('id') == 'pose-volume':
            observations.append(dict(check=arg, pose=pose_state()))
    previous = sys.getprofile()
    try:
        sys.setprofile(observer)
        _test_compiled_run(_context)
    finally:
        sys.setprofile(previous)
        print('MOTION_OBSERVATIONS ' + json.dumps(dict(poses=observations, nativeCalls=native_calls, mappedData=_FMCAD_REQUEST['data']), allow_nan=False))
`,
        );
      const test = async (
        label: string,
        fn: () => Promise<unknown>,
      ): Promise<boolean> => {
        try {
          const result = await fn();
          probe.observations.push({ phase: label, result });
          return true;
        } finally {
          probe.persist();
        }
      };
      const pose = () =>
        script<PoseState>("read-actual-pose-camera", emit("pose_state()"));
      const limits = (axis: string) => ({
        minimumValue: axis === "rotation" ? "-90 deg" : "-10 mm",
        maximumValue: axis === "rotation" ? "90 deg" : "20 mm",
        restValue: axis === "rotation" ? "0 deg" : "0 mm",
        isMinimumValueEnabled: true,
        isMaximumValueEnabled: true,
        isRestValueEnabled: false,
      });
      try {
        await test("animation-discovery-before-workspace", async () => {
          const before = await script(
            "before-discovery",
            emit("environment()"),
          );
          const capabilities = await cad("animation.capabilities");
          await assert.rejects(
            () => cad("animation.list"),
            /Storyboard access requires an active Animation workspace/,
          );
          closeNumbers(
            await script("after-discovery", emit("environment()")),
            before,
          );
          assert.equal(capabilities.success, true);
          assert.equal(capabilities.result.collectionAccess, "notChecked");
          return { capabilities, inactiveListRejectedWithoutActivation: true };
        });
        await test("simulation-metadata-only", async () => {
          const before = await script(
            "products-before-simulation",
            emit("environment()"),
          );
          const result = await cad("simulation.capabilities");
          const observed = observation();
          const after = await script(
            "products-after-simulation",
            emit("environment()"),
          );
          assert.equal(result.success, true);
          assert.equal(result.result.productAccessed, false);
          assert.deepEqual(observed.nativeCalls, []);
          closeNumbers(after, before);
          return {
            before,
            after,
            result,
            nativeCalls: observed.nativeCalls,
            jobEvidence:
              "Only metadata command dispatched; no simulation object method invoked. No external queue inspection.",
          };
        });

        const built =
          await test("root-local-rigid-and-three-as-built-joints-limits", async () => {
            for (const kind of [
              "anchor",
              "base",
              "revolute",
              "slider",
              "cylindrical",
            ]) {
              const made = await cad("component.create", { name: kind });
              assert.equal(made.success, true);
              const box = await cad(
                "shape.box",
                {
                  name: kind + "_body",
                  width: "8 mm",
                  depth: "4 mm",
                  height: "3 mm",
                },
                made.result.component,
              );
              assert.equal(box.success, true);
              fixture.push({
                kind,
                occurrence: made.result.occurrence,
                component: made.result.component,
                body: required(box.result.bodies[0]),
              });
            }
            await cad("assembly.ground", {
              occurrence: required(fixture[0]).occurrence,
            });
            const rigid = await cad("joint.rigid", {
              name: "rigid_base",
              occurrenceOne: required(fixture[1]).occurrence,
              occurrenceTwo: required(fixture[0]).occurrence,
            });
            assert.equal(rigid.result.asBuilt, true);
            assert.equal(rigid.result.motionType, "RigidJointMotion");
            for (const part of fixture.slice(2)) {
              const axes =
                part.kind === "cylindrical"
                  ? ["rotation", "slide"]
                  : [part.kind === "slider" ? "slide" : "rotation"];
              const spec = Object.fromEntries(
                axes.map((axis) => [axis, limits(axis)]),
              );
              const made = await cad("joint." + part.kind, {
                name: part.kind + "_joint",
                occurrenceOne: part.occurrence,
                occurrenceTwo: required(fixture[1]).occurrence,
                point: "origin",
                axis: "Z",
                limits: spec,
                confirm: true,
              });
              assert.equal(made.result.asBuilt, true);
              assert.match(made.result.joint.objectType, /AsBuiltJoint$/);
              part.joint = { token: made.result.joint.token };
              const edited = await cad("joint.limits", {
                joint: part.joint,
                confirm: true,
                limits: Object.fromEntries(
                  axes.map((axis) => [
                    axis,
                    {
                      restValue: axis === "rotation" ? "10 deg" : "2 mm",
                      isRestValueEnabled: true,
                    },
                  ]),
                ),
              });
              const inspected = await cad("joint.inspect", {
                joint: part.joint,
              });
              closeNumbers(inspected.result.limits, edited.result.limits);
              for (const axis of axes) {
                closeNumbers(inspected.result.limits[axis], {
                  minimumValue: axis === "rotation" ? -Math.PI / 2 : -1,
                  maximumValue: axis === "rotation" ? Math.PI / 2 : 2,
                  restValue: axis === "rotation" ? Math.PI / 18 : 0.2,
                  isMinimumValueEnabled: true,
                  isMaximumValueEnabled: true,
                  isRestValueEnabled: true,
                  units: axis === "rotation" ? "rad" : "cm",
                });
              }
              await cad("joint.limits", {
                joint: part.joint,
                confirm: true,
                limits: Object.fromEntries(
                  axes.map((axis) => [axis, { isRestValueEnabled: false }]),
                ),
              });
              await cad("joint.drive", {
                joint: part.joint,
                ...Object.fromEntries(
                  axes.map((axis) => [
                    axis,
                    axis === "rotation" ? "0 deg" : "0 mm",
                  ]),
                ),
              });
            }
            return script(
              "verify-native-root-local-fixture",
              `d = adsk.fusion.Design.cast(doc.products.itemByProductType('DesignProductType'))
assert d.rootComponent.occurrences.count == 5 and d.rootComponent.asBuiltJoints.count == 4
assert d.activeComponent == d.rootComponent
for o in d.rootComponent.occurrences:
    assert o.assemblyContext is None and not o.isReferencedComponent
${emit("pose_state()")}`,
            );
          });
        if (built) {
          const tracks = fixture
            .slice(2)
            .map((p) => ({
              joint: p.joint,
              ...(p.kind !== "slider"
                ? { rotation: { from: "0 deg", to: "60 deg" } }
                : {}),
              ...(p.kind !== "revolute"
                ? { slide: { from: "0 mm", to: "10 mm" } }
                : {}),
            }));
          const check = {
            id: "pose-volume",
            measurement: {
              operation: "measure.volume",
              data: { ref: required(fixture[4]).occurrence, units: "mm3" },
            },
            expected: "96 mm^3",
            tolerance: "0.001 mm^3",
          };
          await test("out-of-limits-rejected-before-any-pose-change", async () => {
            const before = await pose(),
              errors: string[] = [];
            for (const part of fixture.slice(2))
              for (const axis of part.kind === "cylindrical"
                ? ["rotation", "slide"]
                : [part.kind === "slider" ? "slide" : "rotation"]) {
                for (const value of axis === "rotation"
                  ? ["-91 deg", "91 deg"]
                  : ["-11 mm", "21 mm"]) {
                  await assert.rejects(
                    () =>
                      cad("joint.drive", {
                        joint: part.joint,
                        ...(part.kind === "cylindrical"
                          ? { rotation: "15 deg", slide: "5 mm" }
                          : {}),
                        [axis]: value,
                      }),
                    (error: unknown) => {
                      assert.ok(error instanceof Error);
                      errors.push(error.message);
                      return /outside joint limits/.test(error.message);
                    },
                  );
                  closeNumbers(await pose(), before);
                }
              }
            await assert.rejects(
              () =>
                cad("motion.sample", {
                  tracks: [
                    ...tracks.slice(0, 2),
                    {
                      joint: required(fixture[4]).joint,
                      rotation: { from: "0 deg", to: "91 deg" },
                    },
                  ],
                  frameCount: 5,
                  confirm: true,
                }),
              /outside joint limits/,
            );
            closeNumbers(await pose(), before);
            return { before, errors, after: await pose() };
          });
          for (const mode of ["directory", "frameFiles", "forced-negative"])
            await test("five-frame-" + mode, async () => {
              const before = await pose();
              const prefix = name + "_" + mode.replaceAll("-", "_");
              const nativePaths = Array.from({ length: 5 }, (_, i) =>
                path.win32.join(
                  baseline.temp,
                  `${prefix}-${String(i).padStart(3, "0")}.png`,
                ),
              );
              await script(
                "reserve-owned-frame-files",
                `targets = ${py(nativePaths)}\nassert not any(os.path.lexists(p) for p in targets)\n${emit("dict(reserved=targets)")}`,
              );
              if (mode !== "forced-negative") ownedFiles.push(...nativePaths);
              // Both inputs are native values received from the read-only Windows Temp probe.
              const output =
                mode === "directory"
                  ? { directory: baseline.temp, prefix }
                  : mode === "frameFiles"
                    ? { frameFiles: nativePaths }
                    : {};
              const result = await cad("motion.sample", {
                tracks,
                frameCount: 5,
                confirm: true,
                restore: true,
                checks: [
                  {
                    ...check,
                    ...(mode === "forced-negative"
                      ? { expected: "97 mm^3" }
                      : {}),
                  },
                ],
                ...output,
                ...(mode !== "forced-negative"
                  ? { width: 320, height: 240 }
                  : {}),
              });
              const evidence = observation();
              for (const [key, value] of Object.entries(output))
                assert.deepEqual(
                  evidence.mappedData[key],
                  value,
                  "Native path mapping must preserve probe-provided input",
                );
              const after = await pose();
              closeNumbers(after, before);
              assert.equal(result.success, mode !== "forced-negative");
              assert.equal(result.result.passed, mode !== "forced-negative");
              assert.equal(
                result.result.status,
                mode === "forced-negative" ? "fail" : "pass",
              );
              assert.equal(result.result.restored, true);
              assert.deepEqual(result.result.restoreErrors, []);
              assert.equal(result.result.error, null);
              assert.equal(result.result.samples.length, 5);
              assert.equal(evidence.poses.length, 6); // Initial preflight, then five in-pose checks.
              for (let i = 0; i < 5; i++) {
                const sample = required(result.result.samples[i]),
                  observed = required(evidence.poses[i + 1]).pose;
                closeNumbers(sample.fraction, i / 4);
                closeNumbers(
                  observed.rows.slice(0, 2),
                  before.rows.slice(0, 2),
                );
                for (let j = 0; j < 3; j++) {
                  const row = required(observed.rows[j + 2]),
                    values = required(sample.joints[j]);
                  closeNumbers(row.volume, 0.096, 1e-6);
                  for (const key of Object.keys(row.values)) {
                    closeNumbers(row.values[key], values[key]);
                    closeNumbers(
                      values[key],
                      key === "rotationValue" ? ((Math.PI / 3) * i) / 4 : i / 4,
                    );
                  }
                  const m = row.matrix;
                  // Axis is Z at root origin; sign can depend on native joint orientation.
                  closeNumbers(
                    (required(m[0]) + required(m[5]) + required(m[10]) - 1) / 2,
                    Math.cos(row.values["rotationValue"] || 0),
                    1e-6,
                  );
                  closeNumbers(
                    Math.abs(required(m[11])),
                    row.values["slideValue"] || 0,
                    1e-6,
                  );
                  if (i > 0)
                    assert.notDeepEqual(
                      row.vertices,
                      required(before.rows[j + 2]).vertices,
                      "Actual body geometry must move",
                    );
                }
                assert.equal(
                  required(sample.checks[0]).passed,
                  mode !== "forced-negative",
                );
                closeNumbers(
                  required(sample.checks[0]).actual.value,
                  96,
                  0.001,
                );
              }
              let files: unknown = [];
              if (mode !== "forced-negative") {
                assert.deepEqual(
                  result.result.frameFiles.map((p) => path.win32.normalize(p)),
                  nativePaths,
                );
                files = await script(
                  "read-only-png-file-proof",
                  `rows = []
for filename in ${py(nativePaths)}:
    assert os.path.dirname(filename) == ${py(baseline.temp)}
    with open(filename, 'rb') as stream:
        content = stream.read()
    assert content[:8] == b'\\x89PNG\\r\\n\\x1a\\n' and content[12:16] == b'IHDR'
    width, height = struct.unpack('>II', content[16:24])
    assert (width, height) == (320, 240) and len(content) > 24
    rows.append(dict(path=filename, bytes=len(content), width=width, height=height, sha256=hashlib.sha256(content).hexdigest()))
${emit("rows")}`,
                );
              }
              return {
                before,
                result,
                evidence,
                after,
                files,
                videoPublish: false,
              };
            });
        } else
          throw new Error("Fixture creation failed; no speculative motion.");

        await test("native-workspace-storyboard-create-inspect-seek-empty-play-rejection", async () => {
          const activated = await cad("animation.workspace", { confirm: true });
          assert.equal(activated.result.workspaceActive, true);
          const made = await cad("animation.create", {
            confirm: true,
            clean: true,
          });
          const list = await cad("animation.list");
          const ref = list.result.storyboards.find(
            (b) => b.ref.index === made.result.ref.index,
          )?.ref;
          assert.ok(ref);
          assert.equal(ref.document, identity.creationId);
          await cad("animation.activate", { storyboard: ref, confirm: true });
          const inspected = await cad("animation.inspect", { storyboard: ref });
          assert.equal(
            inspected.result.end,
            0,
            "Clean storyboard must be empty; never play nonempty native actions",
          );
          const seek = await cad("animation.seek", {
            storyboard: ref,
            seconds: 0,
            confirm: true,
          });
          assert.equal(seek.result.playheadPosition, 0);
          await assert.rejects(
            () =>
              cad("animation.play", {
                storyboard: ref,
                begin: 0,
                end: 0,
                confirm: true,
              }),
            /Playback requires 0 <= begin < end <= storyboard.end/,
          );
          const calls = observation().nativeCalls;
          assert.deepEqual(
            calls,
            [],
            "Empty playback must reject before native play",
          );
          const after = await cad("animation.inspect", { storyboard: ref });
          assert.equal(after.result.isInPlayMode, false);
          assert.equal(after.result.playheadPosition, 0);
          return {
            activated,
            made,
            list,
            inspected,
            seek,
            after,
            nativePlayCalls: calls,
          };
        });
      } finally {
        if (!session.uncertain) {
          try {
            if (ownedFiles.length)
              await script(
                "cleanup-exact-owned-png-files",
                `owned = ${py(ownedFiles)}
root = os.path.abspath(${py(probe.directory)})
for filename in owned:
    assert os.path.dirname(os.path.abspath(filename)) == root and os.path.basename(filename).startswith(${py(name + "_")})
    if os.path.lexists(filename):
        assert os.path.isfile(filename) and not os.path.islink(filename), 'Owned PNG is not a regular file'
        os.remove(filename)
assert not any(os.path.lexists(filename) for filename in owned)
${emit("dict(removed=owned)")}`,
                { readOnly: false },
              );
          } catch (error) {
            if (session.uncertain) throw error;
            session.deferCleanup(
              "Native motion output cleanup failed: " + String(error),
            );
          }
        }
        probe.persist();
      }
    },
  }));
}

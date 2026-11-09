import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { Document } from "./contracts";
import { record, number } from "./contracts";
import type { Scenario, ScenarioSession } from "./runner";
import { program, emit } from "./programs";
import { cameraEqual } from "./camera-cases";

/** Fusion viewport ordering, ViewCube fit and actual PNG bytes are native evidence. */
export const nativeCameraProbeCapability = "native-camera-viewcube-fit-png";
const literal = (value: unknown): string =>
  JSON.stringify(JSON.stringify(value));
const helpers = `import adsk.core, adsk.fusion, json, math, os
app = adsk.core.Application.get()
def docs():
    return sorted([dict(name=d.name, creationId=d.creationId, fileId=d.dataFile.id if d.dataFile else None, saved=d.isSaved, modified=d.isModified) for d in app.documents], key=lambda d: d['creationId'])
def xyz(v):
    return [v.x, v.y, v.z]
def state(c):
    result = dict(eye=xyz(c.eye), target=xyz(c.target), up=xyz(c.upVector), projection=int(c.cameraType), fit=c.isFitView, smooth=c.isSmoothTransition)
    result['fov'] = c.perspectiveAngle if c.cameraType != adsk.core.CameraTypes.OrthographicCameraType else None
    result['extents'] = list(c.getExtents()) if c.cameraType == adsk.core.CameraTypes.OrthographicCameraType else None
    return result
def quiet(c):
    c.isFitView = False
    c.isSmoothTransition = False
    return c
def pose(c, s):
    c.target = adsk.core.Point3D.create(*s['target'])
    c.eye = adsk.core.Point3D.create(*s['eye'])
    c.upVector = adsk.core.Vector3D.create(*s['up'])`;

function source(
  document: Document,
  body: string,
  result: string,
  baseline?: unknown,
): string {
  return program(`${helpers}
matches = [d for d in app.documents if d.creationId == ${JSON.stringify(document.creationId)} and d.name == ${JSON.stringify(document.name)}]
assert len(matches) == 1 and not matches[0].isSaved and matches[0].dataFile is None and app.activeDocument == matches[0], 'Owned active document guard failed'
doc = matches[0]
${baseline === undefined ? "" : `assert [d for d in docs() if d['creationId'] != doc.creationId] == json.loads(${literal(baseline)}), 'Other document state changed'`}
vp = app.activeViewport
assert vp.parentDocument == doc, 'Viewport ownership mismatch'
${body}
${emit(`dict(creationId=doc.creationId, result=${result})`)}`);
}
function restore(original: Record<string, unknown>): string {
  return `saved = json.loads(${literal(original)})
log = dict(before=state(vp.camera))
c = quiet(vp.camera)
c.cameraType = adsk.core.CameraTypes.OrthographicCameraType
vp.camera = c
log['projectionApplied'] = state(vp.camera)
c = quiet(vp.camera)
assert c.setExtents(*saved['extents'][1:])
pose(c, saved)
log['prepared'] = state(c)
vp.camera = c
log['immediate'] = state(vp.camera)
vp.refresh()
adsk.doEvents()
log['settled'] = state(vp.camera)`;
}
function variation(original: Record<string, unknown>, variant: number): string {
  return `saved = json.loads(${literal(original)})
wanted = dict(eye=[8,6,5], target=[1,0.6,0.5], up=[0,0,1])
c = quiet(vp.camera)
c.cameraType = adsk.core.CameraTypes.OrthographicCameraType
vp.camera = c
c = quiet(vp.camera)
assert c.setExtents(*saved['extents'][1:])
pose(c, saved)
vp.camera = c
vp.refresh()
log = dict(before=state(vp.camera))
variant = ${variant}
c = quiet(adsk.core.Camera.create() if variant == 2 else vp.camera)
if variant == 3:
    pose(c, wanted)
c.cameraType = adsk.core.CameraTypes.PerspectiveCameraType
if variant in (4, 5):
    if variant == 5:
        c.perspectiveAngle = math.radians(40)
    log['stagePrepared'] = state(c)
    vp.camera = c
    log['stageApplied'] = state(vp.camera)
    c = quiet(vp.camera)
if variant != 5:
    c.perspectiveAngle = math.radians(40)
if variant != 3:
    pose(c, wanted)
log['prepared'] = state(c)
vp.camera = c
log['immediate'] = state(vp.camera)
if variant == 6:
    c = quiet(vp.camera)
    pose(c, wanted)
    log['repeatPrepared'] = state(c)
    vp.camera = c
    log['repeatApplied'] = state(vp.camera)
vp.refresh()
adsk.doEvents()
log['settled'] = state(vp.camera)`;
}
async function run(session: ScenarioSession): Promise<void> {
  const evidence: Record<string, unknown> = {
    source: "tests/live-camera-probe.js",
    variations: [],
  };
  const evidenceFile = path.join(session.directory, "camera-probe.json");
  const persist = () =>
    fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2) + "\n", {
      mode: 0o600,
    });
  const baseline = (
    await session.observe(
      "observe-camera-baseline",
      source(
        session.document,
        "",
        "[d for d in docs() if d['creationId'] != doc.creationId]",
      ),
    )
  )["result"];
  evidence["camera-baseline"] = baseline;
  persist();
  assert.ok(Array.isArray(baseline));
  const probe = async (
    phase: string,
    body: string,
    result: string,
    cad = false,
    observe = false,
  ): Promise<unknown> => {
    const script = source(session.document, body, result, baseline);
    const value = observe
      ? await session.observe("observe-" + phase, script)
      : await session.execute(
          phase,
          script,
          session.document,
          cad ? "cad-v1" : undefined,
          cad,
        );
    evidence[phase] = value["result"];
    persist();
    return value["result"];
  };
  const cad = async (
    phase: string,
    operation: string,
    data: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> =>
    record(
      await probe(
        phase,
        `result = FMCAD.call(${JSON.stringify(operation)}, json.loads(${literal(data)}))`,
        "result",
        true,
      ),
    );

  const original = record(
    await probe(
      "camera-initialize-owned-box",
      `design = adsk.fusion.Design.cast(app.activeProduct)
root = design.rootComponent
sketch = root.sketches.add(root.xYConstructionPlane)
sketch.sketchCurves.sketchLines.addTwoPointRectangle(adsk.core.Point3D.create(0,0,0), adsk.core.Point3D.create(2,1.2,0))
root.features.extrudeFeatures.addSimple(sketch.profiles.item(0), adsk.core.ValueInput.createByReal(1), adsk.fusion.FeatureOperations.NewBodyFeatureOperation)
c = quiet(vp.camera)
c.cameraType = adsk.core.CameraTypes.OrthographicCameraType
c.isFitView = True
vp.camera = c
vp.refresh()`,
      "state(vp.camera)",
    ),
  );
  const imagePaths = ["front.png", "iso.png"].map((name) =>
    session.backend.fusionPath(path.join(session.directory, name)),
  );
  let allocated = false,
    primary: unknown;
  try {
    for (let variant = 1; variant <= 6; variant++) {
      const row: Record<string, unknown> = { variant };
      row["apply"] = await probe(
        `camera-variation-${variant}`,
        variation(original, variant),
        "log",
      );
      row["later"] = await probe(
        `camera-variation-${variant}-later`,
        "",
        "state(vp.camera)",
        false,
        true,
      );
      row["restore"] = await probe(
        `camera-variation-${variant}-restore`,
        restore(original),
        "log",
      );
      row["restoreLater"] = await probe(
        `camera-variation-${variant}-restore-later`,
        "",
        "state(vp.camera)",
        false,
        true,
      );
      (evidence["variations"] as Record<string, unknown>[]).push(row);
      persist();
    }
    let fixtureFailure: unknown;
    const fixtureOriginal = record(
      (await cad("camera-fixture-original", "camera.save"))["state"],
    );
    try {
      await cad("camera-fixture-perspective", "camera.set", {
        projection: "perspective",
        perspectiveAngle: "40 deg",
        eye: ["80 mm", "60 mm", "50 mm"],
        target: ["10 mm", "6 mm", "5 mm"],
        up: [0, 0, 1],
        fit: false,
      });
      const changed = record(
        (await cad("camera-fixture-perspective-later", "camera.save"))["state"],
      );
      cameraEqual(changed, {
        document: fixtureOriginal["document"],
        cameraType: "PerspectiveCameraType",
        eye: [8, 6, 5],
        target: [1, 0.6, 0.5],
        up: [0, 0, 1],
        perspectiveAngle: (40 * Math.PI) / 180,
      });
      await probe(
        "camera-allocate-image-paths",
        `paths = json.loads(${literal(imagePaths)})
assert not any(os.path.lexists(p) for p in paths)`,
        "paths",
      );
      allocated = true;
      await cad("camera-fixture-shots", "shot.pack", {
        shots: ["front", "iso-top-right"].map((orientation, i) => ({
          path: imagePaths[i]!,
          camera: { orientation, fit: true },
          width: 640,
          height: 480,
        })),
      });
      cameraEqual(
        record(
          (await cad("camera-fixture-after-shots", "camera.save"))["state"],
        ),
        changed,
      );
      const pngs = await probe(
        "camera-verify-owned-images",
        `import struct
result = []
for p in json.loads(${literal(imagePaths)}):
    assert not os.path.islink(p) and os.path.isfile(p)
    with open(p, 'rb') as f:
        header = f.read(24)
    assert header[:8] == bytes([137, 80, 78, 71, 13, 10, 26, 10])
    dimensions = struct.unpack('>II', header[16:24])
    assert dimensions == (640, 480)
    result.append(dict(path=p, bytes=os.path.getsize(p), dimensions=dimensions))`,
        "result",
      );
      assert.ok(Array.isArray(pngs));
      assert.equal(pngs.length, 2);
      for (const png of pngs) assert.ok(number(record(png)["bytes"]) >= 24);
    } catch (error) {
      fixtureFailure = error;
      throw error;
    } finally {
      try {
        await cad("camera-fixture-final-restore", "camera.restore", {
          state: fixtureOriginal,
        });
        cameraEqual(
          record(
            (await cad("camera-fixture-final-restore-later", "camera.save"))[
              "state"
            ],
          ),
          fixtureOriginal,
        );
      } catch (error) {
        if (fixtureFailure !== undefined)
          throw new AggregateError(
            [fixtureFailure, error],
            "Camera fixture failed and restoration is not verified",
          );
        throw error;
      }
    }
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    try {
      await probe("camera-final-native-restore", restore(original), "log");
      if (allocated) {
        // The allocation request proves these exact files were absent in this
        // private session directory before shot.pack; no temp-directory glob.
        await probe(
          "camera-remove-owned-images",
          `import stat
expected = json.loads(${literal(imagePaths)})
owned_directory = ${JSON.stringify(session.backend.fusionPath(session.directory))}
for p in expected:
    assert os.path.dirname(p) == owned_directory and os.path.basename(p) in ('front.png', 'iso.png')
    if os.path.lexists(p):
        identity = os.lstat(p)
        assert stat.S_ISREG(identity.st_mode) and not os.path.islink(p)
        current = os.lstat(p)
        assert (current.st_dev, current.st_ino, current.st_size, current.st_mtime_ns) == (identity.st_dev, identity.st_ino, identity.st_size, identity.st_mtime_ns)
        os.remove(p)
assert not any(os.path.lexists(p) for p in expected)`,
          "dict(removed=True)",
        );
        evidence["imageCleanup"] = "complete";
      }
    } catch (error) {
      evidence["imageCleanup"] = "deferred";
      persist();
      const failure =
        primary === undefined
          ? error
          : new AggregateError(
              [primary, error],
              "Native camera probe failed and cleanup is not verified",
            );
      try {
        session.deferCleanup(
          "Native camera/image restoration is unverified; inspect original receipts and owned image intents before cleanup",
        );
      } catch (hold) {
        throw new AggregateError(
          [failure, hold],
          "Native camera cleanup remains deferred",
        );
      }
    }
    persist();
  }
}

/** One owned unsaved document per scenario, serialized with every global-state suite. */
export function nativeCameraProbeScenarios(owners = 2): Scenario[] {
  return Array.from({ length: owners }, (_, index) => ({
    id: "native-camera-probe-" + index,
    scope: "exclusive-instance" as const,
    requires: ["documents", "camera-state", nativeCameraProbeCapability],
    run,
  }));
}

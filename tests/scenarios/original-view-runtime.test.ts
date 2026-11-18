import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./test-support";
import { program } from "./programs";
import {
  captureOriginalView,
  restoreOriginalView,
} from "./original-view-programs";

for (const projection of [
  "OrthographicCameraType",
  "PerspectiveCameraType",
  "PerspectiveWithOrthoFacesCameraType",
]) {
  test(`actual original-view program restores ${projection} and rejects changed inventory`, async (t) => {
    const { model } = await fixture(t);
    // The component model has cameras but no workspaces. Supply only that UI
    // boundary; execute the complete production camera runtime and view script.
    const setup = await model.execute(
      program(`import adsk.core
app = adsk.core.Application.get()
doc = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
doc.name = 'Original'
class Workspace:
    id = 'FusionSolidEnvironment'
    def activate(self):
        app.userInterface.activeWorkspace = self
        return True
class Workspaces:
    def itemById(self, key):
        assert key == 'FusionSolidEnvironment'
        return Workspace()
app.userInterface.activeWorkspace = Workspace()
app.userInterface.workspaces = Workspaces()
camera = app.activeViewport.camera
camera.cameraType = adsk.core.CameraTypes.${projection}
app.activeViewport.camera = camera`),
    );
    assert.equal(setup.success, true, setup.error);
    const captured = await model.execute(captureOriginalView(true));
    assert.equal(captured.success, true, captured.error);
    const snapshot = JSON.parse(
      captured.stdout.trim().slice("FMCAD_SCENARIO ".length),
    ) as Record<string, unknown>;
    const changed = await model.execute(
      program(`import adsk.core
app = adsk.core.Application.get()
camera = app.activeViewport.camera
camera.eye = adsk.core.Point3D.create(90, 80, 70)
app.activeViewport.camera = camera`),
    );
    assert.equal(changed.success, true, changed.error);
    const restored = await model.execute(restoreOriginalView(snapshot));
    assert.equal(restored.success, true, restored.error);
    const actual = JSON.parse(
      restored.stdout.trim().slice("FMCAD_SCENARIO ".length),
    ) as Record<string, unknown>;
    assert.equal(actual["restored"], true);
    assert.deepEqual(actual["nativeCamera"], snapshot["nativeCamera"]);
    const foreign = await model.execute(
      program(`import adsk.core
adsk.core.Application.get().documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)`),
    );
    assert.equal(foreign.success, true, foreign.error);
    const rejected = await model.execute(restoreOriginalView(snapshot));
    assert.equal(rejected.success, false);
    assert.match(
      rejected.error,
      /Other documents changed before original view restoration/u,
    );
  });
}

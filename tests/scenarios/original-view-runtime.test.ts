import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./test-support";
import { program } from "./programs";
import {
  captureOriginalView,
  restoreOriginalView,
} from "./original-view-programs";
import { runScenarios } from "./runner";

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

test("receipt-proven peer mutation does not replace or block the real user camera", async (t) => {
  const { model } = await fixture(t);
  const setup = await model.execute(
    program(`import adsk.core
app = adsk.core.Application.get()
doc = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
doc.name = 'UserView'
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
peer = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
peer.name = 'ReceiptBoundPeer'
assert doc.activate()`),
  );
  assert.equal(setup.success, true, setup.error);
  const captured = await model.execute(captureOriginalView(true));
  assert.equal(captured.success, true, captured.error);
  const snapshot = JSON.parse(
    captured.stdout.trim().slice("FMCAD_SCENARIO ".length),
  ) as Record<string, unknown>;
  const documents = snapshot["documents"] as Record<string, unknown>[];
  const peer = documents.find((row) => row["name"] === "ReceiptBoundPeer")!;
  const changed = await model.execute(
    program(`import adsk.core
app = adsk.core.Application.get()
peer = next(d for d in app.documents if d.name == 'ReceiptBoundPeer')
peer.isModified = True
assert peer.activate()`),
  );
  assert.equal(changed.success, true, changed.error);
  const restored = await model.execute(
    restoreOriginalView(snapshot, {
      baseline: documents,
      peers: [
        {
          document: {
            creationId: String(peer["creationId"]),
            name: String(peer["name"]),
          },
          state: "open",
        },
      ],
    }),
  );
  assert.equal(restored.success, true, restored.error);
  const actual = parseView(restored.stdout);
  assert.deepEqual(actual["nativeCamera"], snapshot["nativeCamera"]);
  const after = actual["documents"] as Record<string, unknown>[];
  assert.equal(
    after.find((row) => row["creationId"] === peer["creationId"])?.["modified"],
    true,
  );
});

async function contextFixture(t: TestContext) {
  const { model, backend, directory } = await fixture(t);
  const setup = await model.execute(
    program(`import adsk.core
app = adsk.core.Application.get()
user = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
user.name = 'User context'
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
peer = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
peer.name = 'Independent peer'
assert user.activate()`),
  );
  assert.equal(setup.success, true, setup.error);
  const captured = await model.execute(captureOriginalView(true));
  assert.equal(captured.success, true, captured.error);
  const snapshot = parseView(captured.stdout);
  const documents = snapshot["documents"] as Record<string, unknown>[];
  const row = documents.find((value) => value["name"] === "Independent peer")!;
  const peer = {
    creationId: String(row["creationId"]),
    name: String(row["name"]),
  };
  const user = snapshot["active"] as Record<string, unknown>;
  return { model, backend, directory, snapshot, documents, peer, user };
}
function parseView(stdout: string): Record<string, unknown> {
  const lines = stdout
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("FMCAD_SCENARIO "));
  assert.equal(lines.length, 1, stdout);
  return JSON.parse(lines[0]!.slice("FMCAD_SCENARIO ".length)) as Record<
    string,
    unknown
  >;
}

test("ScenarioSession uses fresh user context and full restore after owned camera work", async (t) => {
  const f = await contextFixture(t);
  const [report] = await runScenarios(
    {
      ...f.backend,
      capabilities: new Set([...f.backend.capabilities, "original-user-view"]),
    },
    [
      {
        id: "owned-camera-work",
        scope: "exclusive-instance",
        requires: ["documents", "fixture-export", "original-user-view"],
        async run(session) {
          assert.deepEqual(session.originalView["active"], f.user);
          await session.execute(
            "owned-camera-work",
            program(`import adsk.core, json
app = adsk.core.Application.get()
assert app.activeDocument.creationId == ${JSON.stringify(session.document.creationId)}
camera = app.activeViewport.camera
camera.eye = adsk.core.Point3D.create(90,80,70)
app.activeViewport.camera = camera
print('FMCAD_SCENARIO ' + json.dumps(dict(changed=True, creationId=app.activeDocument.creationId)))`),
          );
        },
      },
    ],
    f.directory,
    1,
  );
  assert.equal(report?.status, "passed", JSON.stringify(report));
  assert.equal(report.cleanup, "complete");
  assert.equal(
    report.requests.find((row) => row.phase === "original-user-view-restore")
      ?.result?.state,
    "succeeded",
  );
  const final = await f.model.execute(captureOriginalView(true));
  assert.equal(final.success, true, final.error);
  assert.deepEqual(
    parseView(final.stdout)["nativeCamera"],
    f.snapshot["nativeCamera"],
  );
});

for (const transition of [
  "closed",
  "saved-open",
  "saved-closed",
  "unsettled",
  "missing-proof",
  "wrong-name",
  "wrong-file",
  "user-change",
  "missing-user",
  "newer-camera",
] as const) {
  test(`receipt-aware view guard handles ${transition} without weakening user protection`, async (t) => {
    const f = await contextFixture(t);
    const identity = JSON.stringify(f.peer.creationId);
    let proof: import("./fixture-provenance").OwnedUnsavedFixtureProof = {
      document: f.peer,
      state: "closed",
    };
    if (transition.startsWith("saved-")) {
      const saved = await f.model.execute(
        program(`import adsk.core, json
app = adsk.core.Application.get()
peer = next(d for d in app.documents if d.creationId == ${identity})
assert peer.saveAs('Saved successor', app.data.dataProjects.item(0).rootFolder, '', '')
peer.creationId = 'saved-successor-id'
print('FMCAD_SCENARIO ' + json.dumps(dict(creationId=peer.creationId, name=peer.name, fileId=peer.dataFile.id)))`),
      );
      assert.equal(saved.success, true, saved.error);
      const row = parseView(saved.stdout);
      proof = {
        document: f.peer,
        state: "saved",
        savedState: transition === "saved-open" ? "open" : "closed",
        savedDocument: {
          creationId: String(row["creationId"]),
          name: String(row["name"]),
          file: {
            projectId: "sim-project:fixtures",
            folderId: "sim-folder:fixtures",
            fileId: String(row["fileId"]),
            version: 1,
          },
        },
      };
      if (transition === "saved-closed")
        assert.equal(
          (
            await f.model.execute(
              program(
                "import adsk.core\napp = adsk.core.Application.get()\nassert next(d for d in app.documents if d.creationId == 'saved-successor-id').close(False)",
              ),
            )
          ).success,
          true,
        );
    } else if (transition === "closed") {
      assert.equal(
        (
          await f.model.execute(
            program(
              `import adsk.core\nassert next(d for d in adsk.core.Application.get().documents if d.creationId == ${identity}).close(False)`,
            ),
          )
        ).success,
        true,
      );
    } else {
      proof = {
        document: f.peer,
        state: transition === "unsettled" ? "unsettled" : "open",
      };
      const mutation =
        transition === "missing-user"
          ? "assert app.documents.item(0).close(False)"
          : transition === "user-change"
            ? "app.documents.item(0).isModified = True"
            : transition === "newer-camera"
              ? "camera = app.activeViewport.camera\ncamera.eye = adsk.core.Point3D.create(90,80,70)\napp.activeViewport.camera = camera"
              : `next(d for d in app.documents if d.creationId == ${identity}).isModified = True`;
      const changed = await f.model.execute(
        program(
          "import adsk.core\napp = adsk.core.Application.get()\n" + mutation,
        ),
      );
      assert.equal(changed.success, true, changed.error);
      if (transition === "wrong-name")
        proof = { document: { ...f.peer, name: "Forged peer" }, state: "open" };
      if (transition === "wrong-file")
        proof = {
          document: f.peer,
          state: "saved",
          savedState: "open",
          savedDocument: {
            ...f.peer,
            file: {
              projectId: "project",
              folderId: "folder",
              fileId: "foreign-file",
              version: 1,
            },
          },
        };
    }
    const source = restoreOriginalView(f.snapshot, {
      baseline: f.documents,
      peers: transition === "missing-proof" ? [] : [proof],
    });
    const result = await f.model.execute(source);
    const success = ["closed", "saved-open", "saved-closed"].includes(
      transition,
    );
    assert.equal(result.success, success, result.error);
    if (success)
      assert.deepEqual(
        parseView(result.stdout)["nativeCamera"],
        f.snapshot["nativeCamera"],
      );
    if (transition === "newer-camera") {
      assert.match(result.error, /newer or changed user camera/u);
      const read = await f.model.execute(
        program(
          "import adsk.core, json\nprint('FMCAD_SCENARIO ' + json.dumps(dict(eye=list(adsk.core.Application.get().activeViewport.camera.eye.asArray()))))",
        ),
      );
      assert.deepEqual(
        parseView(read.stdout)["eye"],
        [90, 80, 70],
        "newer user camera must not be overwritten",
      );
    }
  });
}

test("a stale user camera rejects restoration and recovers observed peer focus", async (t) => {
  const f = await contextFixture(t);
  const prepared = await f.model.execute(
    program(`import adsk.core
app = adsk.core.Application.get()
camera = app.activeViewport.camera
camera.eye = adsk.core.Point3D.create(90,80,70)
app.activeViewport.camera = camera
assert app.documents.item(1).activate()`),
  );
  assert.equal(prepared.success, true, prepared.error);
  const result = await f.model.execute(
    restoreOriginalView(f.snapshot, {
      baseline: f.documents,
      peers: [{ document: f.peer, state: "open" }],
    }),
  );
  assert.equal(result.success, false);
  assert.match(result.error, /newer or changed user camera/u);
  assert.match(result.stdout, /restore-failed-focus/u);
  const read = await f.model.execute(
    program(`import adsk.core, json
app = adsk.core.Application.get()
assert app.activeDocument.creationId == ${JSON.stringify(f.peer.creationId)}
assert app.documents.item(0).activate()
print('FMCAD_SCENARIO ' + json.dumps(dict(eye=list(app.activeViewport.camera.eye.asArray()))))`),
  );
  assert.equal(read.success, true, read.error);
  assert.deepEqual(parseView(read.stdout)["eye"], [90, 80, 70]);
});

for (const fault of [
  "none",
  "blocked-ancestry",
  "missing-user",
  "activate-user",
  "camera-read",
  "restore-focus",
  "restore-workspace",
] as const) {
  test(`fresh user capture with disposable active peer: ${fault}`, async (t) => {
    const f = await contextFixture(t);
    const plan = {
      baseline: f.documents,
      peers: [{ document: f.peer, state: "open" as const }],
      roots: { [f.peer.creationId]: f.user },
      blocked: fault === "blocked-ancestry" ? [f.peer.creationId] : [],
    };
    const injection =
      fault === "missing-user"
        ? "assert user.close(False)"
        : fault === "activate-user"
          ? "user.activate = lambda: False"
          : fault === "camera-read"
            ? `original_extents = adsk.core.Camera.getExtents
def checked_extents(camera):
    return (False,0,0) if app.activeDocument == user else original_extents(camera)
adsk.core.Camera.getExtents = checked_extents`
            : fault === "restore-focus"
              ? "peer.activate = lambda: False"
              : fault === "restore-workspace"
                ? `from types import SimpleNamespace
original_activate = user.activate
def activate_user():
    ok = original_activate()
    app.userInterface.activeWorkspace = SimpleNamespace(id='other')
    return ok
user.activate = activate_user
app.userInterface.workspaces.itemById = lambda key: SimpleNamespace(id=key, activate=lambda: False)`
                : "";
    const prepared = await f.model.execute(
      program(`import adsk.core
app = adsk.core.Application.get()
user = app.documents.item(0)
peer = app.documents.item(1)
assert peer.activate()
${injection}`),
    );
    assert.equal(prepared.success, true, prepared.error);
    const result = await f.model.execute(captureOriginalView(true, plan));
    assert.equal(result.success, fault === "none", result.error);
    if (fault === "none") {
      const captured = parseView(result.stdout);
      assert.deepEqual(captured["active"], f.user);
      assert.deepEqual(captured["observedActive"], { ...f.peer, fileId: null });
      const focus = await f.model.execute(
        program(
          "import adsk.core, json\nprint('FMCAD_SCENARIO ' + json.dumps(dict(active=adsk.core.Application.get().activeDocument.creationId)))",
        ),
      );
      assert.equal(parseView(focus.stdout)["active"], f.peer.creationId);
    }
    if (["camera-read", "restore-focus", "restore-workspace"].includes(fault))
      assert.match(
        result.stdout,
        /FMCAD_VIEW_EFFECT/u,
        "partial focus effects must be retained, not called no-mutation",
      );
  });
}

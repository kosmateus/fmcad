import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./test-support";
import { program } from "./programs";
import {
  captureOriginalView,
  restoreOriginalView,
  establishReferenceView,
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

test("an explicit operator reference activation establishes a fresh baseline without adopting historical ancestry", async (t) => {
  const f = await contextFixture(t);
  const observed = await f.model.execute(
    program(
      "import adsk.core\nassert adsk.core.Application.get().documents.item(1).activate()",
    ),
  );
  assert.equal(observed.success, true, observed.error);
  const target = f.documents.find(
    (row) => row["creationId"] === f.user["creationId"],
  )!;
  const plan = {
    requestId: "operator-request:1",
    clientId: "operator-client",
    target,
    documents: f.documents,
  };
  const result = await f.model.execute(establishReferenceView(plan));
  assert.equal(result.success, true, result.error);
  const value = parseView(result.stdout);
  assert.equal(value["established"], true);
  assert.equal(value["baselineKind"], "operator-reference");
  assert.equal(value["requestId"], plan.requestId);
  assert.equal(value["clientId"], plan.clientId);
  assert.deepEqual(value["active"], f.user);
  assert.deepEqual(value["beforeActive"], { ...f.peer, fileId: null });
  assert.deepEqual(value["documents"], f.documents);
  assert.deepEqual(value["nativeCamera"], f.snapshot["nativeCamera"]);
  const canonical = await f.model.execute(captureOriginalView(true));
  assert.equal(canonical.success, true, canonical.error);
  assert.deepEqual(parseView(canonical.stdout)["active"], f.user);
  assert.deepEqual(
    parseView(canonical.stdout)["nativeCamera"],
    f.snapshot["nativeCamera"],
  );
});

for (const change of ["unchanged", "modified", "closed"] as const)
  test(`retained peer remains a protected baseline row during capture: ${change}`, async (t) => {
    const f = await contextFixture(t);
    const plan = {
      baseline: f.documents,
      peers: [
        {
          document: f.peer,
          state: "retained" as const,
          terminalReceipt: {
            requestId: "retained-request",
            jobId: "retained-job",
          },
        },
      ],
      roots: {},
      blocked: [f.peer.creationId],
    };
    if (change !== "unchanged") {
      const changed = await f.model.execute(
        program(`import adsk.core
app = adsk.core.Application.get()
peer = app.documents.item(1)
${change === "modified" ? "peer.isModified = True" : "assert peer.close(False)"}
assert app.documents.item(0).activate()`),
      );
      assert.equal(changed.success, true, changed.error);
    }
    const result = await f.model.execute(captureOriginalView(true, plan));
    if (change === "unchanged") {
      assert.equal(result.success, true, result.error);
      assert.deepEqual(parseView(result.stdout)["active"], f.user);
    } else {
      assert.equal(result.success, false);
      assert.match(result.error, /Unproven user document transition/u);
      assert.doesNotMatch(result.stdout, /FMCAD_VIEW_EFFECT/u);
    }
  });

test("capture defers a stale open peer before any camera or focus effect", async (t) => {
  const f = await contextFixture(t);
  const plan = {
    baseline: f.documents,
    peers: [{ document: f.peer, state: "open" as const }],
    roots: { [f.peer.creationId]: f.user },
    blocked: [],
  };
  const closed = await f.model.execute(
    program(`import adsk.core
app = adsk.core.Application.get()
assert app.documents.item(1).close(False)
assert app.documents.item(0).activate()`),
  );
  assert.equal(closed.success, true, closed.error);
  const result = await f.model.execute(captureOriginalView(true, plan));
  assert.equal(result.success, true, result.error);
  const admission = parseView(result.stdout);
  assert.equal(admission["viewAdmissionChanged"], true);
  assert.equal(admission["missingPeer"], f.peer.creationId);
  assert.equal(admission["bodyCalls"], 0);
  assert.equal(admission["mutationStarted"], false);
  assert.doesNotMatch(result.stdout, /FMCAD_VIEW_EFFECT/u);
});

test("a retained active peer does not acquire user-view ancestry", async (t) => {
  const f = await contextFixture(t);
  const activated = await f.model.execute(
    program(`import adsk.core
assert adsk.core.Application.get().documents.item(1).activate()`),
  );
  assert.equal(activated.success, true, activated.error);
  const result = await f.model.execute(
    captureOriginalView(true, {
      baseline: f.documents,
      peers: [
        {
          document: f.peer,
          state: "retained",
          terminalReceipt: {
            requestId: "retained-request",
            jobId: "retained-job",
          },
        },
      ],
      roots: {},
      blocked: [f.peer.creationId],
    }),
  );
  assert.equal(result.success, false);
  assert.doesNotMatch(result.stdout, /FMCAD_VIEW_EFFECT/u);
});

for (const fault of [
  "none",
  "missing-proof",
  "unsettled-proof",
  "forged-identity",
  "target-mutated",
  "target-closed",
  "target-substituted",
  "target-exemption",
  "policy-baseline",
  "during-activation",
] as const) {
  test(`operator reference policy preserves target and foreign guards: ${fault}`, async (t) => {
    const f = await contextFixture(t);
    const target = f.documents.find(
      (row) => row["creationId"] === f.user["creationId"],
    )!;
    const injection =
      fault === "target-mutated"
        ? "user.isModified = True"
        : fault === "target-closed"
          ? "assert user.close(False)"
          : fault === "target-substituted"
            ? "user.creationId = 'foreign-substitute'"
            : fault === "during-activation"
              ? `original_activate=user.activate
def changed_activate():
    ok=original_activate()
    peer.isModified=False
    return ok
user.activate=changed_activate`
              : "";
    const changed = await f.model.execute(
      program(`import adsk.core
app=adsk.core.Application.get()
user=app.documents.item(0)
peer=app.documents.item(1)
peer.isModified=True
assert peer.activate()
${injection}`),
    );
    assert.equal(changed.success, true);
    const result = await f.model.execute(
      establishReferenceView(
        {
          requestId: "fresh-operator:1",
          clientId: "fresh-operator",
          target,
          documents: f.documents,
        },
        {
          baseline: fault === "policy-baseline" ? [] : f.documents,
          peers:
            fault === "missing-proof"
              ? []
              : fault === "target-exemption"
                ? [
                    {
                      document: {
                        creationId: String(f.user["creationId"]),
                        name: String(f.user["name"]),
                      },
                      state: "open",
                    },
                  ]
                : [
                    {
                      document:
                        fault === "forged-identity"
                          ? { ...f.peer, name: "forged" }
                          : f.peer,
                      state: fault === "unsettled-proof" ? "unsettled" : "open",
                    },
                  ],
        },
      ),
    );
    if (fault !== "none") {
      assert.equal(result.success, false, `Must reject ${fault}`);
      assert.equal(result.stdout.includes('"established": true'), false);
      if (fault !== "during-activation")
        assert.equal(
          result.stdout.includes("FMCAD_VIEW_EFFECT "),
          false,
          "Guard rejects before activation",
        );
      return;
    }
    assert.equal(result.success, true, result.error);
    const value = parseView(result.stdout);
    assert.equal(value["established"], true);
    assert.deepEqual(value["active"], f.user);
  });
}

for (const fault of [
  "wrong-name",
  "wrong-file",
  "wrong-saved",
  "changed-target",
  "changed-foreign",
  "new-foreign",
  "missing-target",
  "duplicate-inventory",
  "missing-request",
  "activation-failed",
  "camera-read-failed",
  "recovery-failed",
  "post-activation-inventory",
] as const) {
  test(`operator reference activation rejects ${fault} without granting historical rights`, async (t) => {
    const f = await contextFixture(t);
    const target = {
      ...f.documents.find((row) => row["creationId"] === f.user["creationId"])!,
    };
    const plan = {
      requestId: "operator-request:1",
      clientId: "operator-client",
      target,
      documents: f.documents,
    };
    if (fault === "wrong-name") target["name"] = "Unproven name";
    if (fault === "wrong-file") target["fileId"] = "foreign-file";
    if (fault === "wrong-saved") target["saved"] = true;
    if (fault === "duplicate-inventory")
      plan.documents = [...f.documents, { ...target }];
    if (fault === "missing-request") plan.requestId = "";
    const injection =
      fault === "changed-target"
        ? "user.isModified = True"
        : fault === "changed-foreign"
          ? "peer.isModified = True"
          : fault === "new-foreign"
            ? "app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)"
            : fault === "missing-target"
              ? "assert user.close(False)"
              : fault === "activation-failed"
                ? "user.activate = lambda: False"
                : ["camera-read-failed", "recovery-failed"].includes(fault)
                  ? `original_extents = adsk.core.Camera.getExtents
def failed_extents(camera):
    return (False,0,0) if app.activeDocument == user else original_extents(camera)
adsk.core.Camera.getExtents = failed_extents
${fault === "recovery-failed" ? "peer.activate = lambda: False" : ""}`
                  : fault === "post-activation-inventory"
                    ? `original_activate = user.activate
def changed_activate():
    ok = original_activate()
    peer.isModified = True
    return ok
user.activate = changed_activate`
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
    const result = await f.model.execute(establishReferenceView(plan));
    assert.equal(
      result.success,
      false,
      "Invalid operator handoff must not establish a baseline",
    );
    assert.equal(result.stdout.includes('"established": true'), false);
    if (
      [
        "activation-failed",
        "camera-read-failed",
        "recovery-failed",
        "post-activation-inventory",
      ].includes(fault)
    ) {
      assert.match(result.stdout, /operator-reference-activation/u);
      assert.match(result.stdout, /operator-reference-recovery/u);
      assert.match(
        result.stdout,
        ["recovery-failed", "post-activation-inventory"].includes(fault)
          ? /"recovered": false/u
          : /"recovered": true/u,
      );
    } else
      assert.equal(
        result.stdout.includes("FMCAD_VIEW_EFFECT"),
        false,
        "Reject a stale plan before activation effects",
      );
    if (
      !["recovery-failed", "post-activation-inventory", "new-foreign"].includes(
        fault,
      )
    ) {
      const read = await f.model.execute(
        program(`import adsk.core, json
app = adsk.core.Application.get()
print('FMCAD_SCENARIO ' + json.dumps(dict(active=app.activeDocument.creationId)))`),
      );
      assert.equal(read.success, true, read.error);
      assert.equal(parseView(read.stdout)["active"], f.peer.creationId);
    }
  });
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

import test from "node:test";
import assert from "node:assert/strict";
import { fixture, remaining } from "./test-support";
import { simulatorFolder } from "./simulator";
import { cameraScenarios } from "./camera-cases";
import path from "node:path";
import { runScenarios, resumeCleanup } from "./runner";
import { program } from "./programs";
for (const protocol of ["mcp", "addin"] as const) {
  for (const concurrency of [1, 2, 10]) {
    test(`camera restore and rejection via ${protocol}, concurrency ${concurrency}`, async (t) => {
      const { backend, model, directory } = await fixture(t, protocol);
      const reports = await runScenarios(
        backend,
        cameraScenarios(simulatorFolder, 2),
        directory,
        concurrency,
      );
      for (const report of reports) {
        assert.equal(report.status, "passed", JSON.stringify(report));
        assert.equal(report.cleanup, "complete");
      }
      assert.deepEqual(await remaining(model), { active: null, documents: [] });
    });
  }
}
test("camera snapshots are detached and viewport ownership survives document switching", async (t) => {
  const { model } = await fixture(t);
  const result = await model.execute(
    program(`import adsk.core
app = adsk.core.Application.get()
a = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
av = app.activeViewport
before = av.camera.eye.asArray()
c = av.camera
c.eye = adsk.core.Point3D.create(8, 6, 5)
assert av.camera.eye.asArray() == before
av.camera = c
c.eye = adsk.core.Point3D.create(1, 2, 3)
assert av.camera.eye.asArray() == [8, 6, 5]
b = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
assert app.activeViewport.parentDocument == b
assert app.activeViewport.camera.eye.asArray() == before
assert a.activate()
assert app.activeViewport == av
assert av.camera.eye.asArray() == [8, 6, 5]
for field in ('isFitView', 'isSmoothTransition'):
    unsupported = av.camera
    setattr(unsupported, field, True)
    try:
        av.camera = unsupported
    except NotImplementedError:
        pass
    else:
        raise AssertionError('Unsupported native view behavior accepted')
    assert av.camera.eye.asArray() == [8, 6, 5]
assert a.close(False)
try:
    av.camera
except ValueError:
    pass
else:
    raise AssertionError('Closed viewport accepted')
assert b.close(False)
`),
  );
  assert.equal(result.success, true, result.error);
});

test("camera assertion failure restores state before closing the owned fixture", async (t) => {
  const { backend, model, directory } = await fixture(t);
  let changed = false,
    poisoned = false,
    restored = false;
  const observed = {
    ...backend,
    async execute(request: Parameters<typeof backend.execute>[0]) {
      const result = await backend.execute(request);
      if (request.source.includes('FMCAD.call("camera.set"')) changed = true;
      if (request.source.includes('FMCAD.call("camera.restore"'))
        restored = true;
      if (
        changed &&
        !poisoned &&
        request.source.includes('FMCAD.call("camera.save"')
      ) {
        poisoned = true;
        const lines = result.stdout.split("\n");
        const line = lines.findIndex((value) =>
          value.startsWith("FMCAD_SCENARIO "),
        );
        assert.ok(line >= 0);
        const value = JSON.parse(lines[line]!.slice("FMCAD_SCENARIO ".length));
        value.result.state.eye[0] = 999;
        lines[line] = "FMCAD_SCENARIO " + JSON.stringify(value);
        return { ...result, stdout: lines.join("\n") };
      }
      if (request.source.includes("doc.close(False)"))
        assert.equal(restored, true);
      return result;
    },
  };
  const reports = await runScenarios(
    observed,
    cameraScenarios(simulatorFolder, 2),
    directory,
    10,
  );
  assert.equal(reports[0]?.status, "failed");
  assert.equal(reports[0]?.cleanup, "complete", JSON.stringify(reports[0]));
  assert.equal(reports[1]?.status, "not-run");
  assert.equal(restored, true);
  assert.deepEqual(await remaining(model), { active: null, documents: [] });
});

test("lost camera mutation is never replayed or followed by restoration mutations", async (t) => {
  const { backend, model, directory } = await fixture(t);
  let calls = 0,
    restores = 0;
  const faulty = {
    ...backend,
    async execute(request: Parameters<typeof backend.execute>[0]) {
      const result = await backend.execute(request);
      if (request.source.includes('FMCAD.call("camera.restore"')) restores++;
      if (request.source.includes('FMCAD.call("camera.set"')) {
        calls++;
        throw new Error("Lost camera result");
      }
      return result;
    },
  };
  const reports = await runScenarios(
    faulty,
    cameraScenarios(simulatorFolder, 2),
    directory,
    10,
  );
  assert.equal(reports[0]?.status, "failed");
  assert.equal(reports[0]?.cleanup, "deferred");
  assert.match(reports[0]!.error!, /Lost camera result/u);
  assert.equal(reports[1]?.status, "not-run");
  assert.equal(calls, 1);
  assert.equal(restores, 0);
  const recovered = await resumeCleanup(
    backend,
    path.join(reports[0]!.directory, "report.json"),
  );
  assert.equal(recovered.cleanup, "complete");
  assert.notEqual(recovered.status, "passed");
  assert.equal(calls, 1);
  assert.equal(restores, 0);
  assert.deepEqual(await remaining(model), { active: null, documents: [] });
});

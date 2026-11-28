import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const load = createRequire(path.join(root, "package.json"));
const python = load("./src/python");
const { prepareCadScript } = load("./src/cad");
const { registeredCameraForAddin, matchesCameraInvocation } = load(
  "./src/dist/python/camera-save-payload",
);
const { prepareReceiptScript } = load("./src/queue-instance");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

test("ADDIN camera wire and scoped receipt retain live guards and erase static-only code", async () => {
  const context = { doc: "CameraOracle", docId: "camera-read-id" };
  const logical = prepareCadScript("camera.save", {}, context);
  const adapted = registeredCameraForAddin(
    root,
    logical.script,
    python.pythonArtifactManifest(logical),
  );
  const code = adapted.script + "\nrun()\n";
  const origin = python.pythonArtifactManifest(adapted);
  const invocation = {
    ...context,
    kind: "cad",
    operation: "camera.save",
    data: {},
  };
  assert.equal(matchesCameraInvocation(root, code, origin, invocation), true);
  assert.equal(
    matchesCameraInvocation(root, code + "pass", origin, invocation),
    false,
  );
  assert.equal(
    matchesCameraInvocation(root, code, origin, {
      ...invocation,
      docId: "foreign",
    }),
    false,
  );
  assert.throws(
    () => prepareCadScript("camera.save", { fit: true }, context),
    /Unknown CAD inputs/,
  );
  assert.doesNotMatch(
    code,
    /TYPE_CHECKING|from typing|_cad_cast|_cad_fields|rootComponent|_profile_selections|doc_file_id|project_id|class CadContext|def run\(_context/,
  );
  for (const text of [
    "allDocumentReferences",
    "DesignProductType",
    "doc.creationId",
    "activeDocument",
    "parentDocument",
    "getExtents",
    "perspectiveAngle",
    "_NsSanitizedWriter",
  ])
    assert.ok(code.includes(text), text);
  const binding = {
    jobId: "offline",
    rpcId: "read",
    requestHash: "request",
    buildHash: "build",
    sourceHash: sha(code),
  };
  const receipt = prepareReceiptScript(
    code,
    false,
    "C:\\camera-receipt.json",
    binding,
    { receiptProfile: "doc-camera-v1", mapPath: (v: string) => v },
  );
  assert.doesNotMatch(
    receipt.script,
    /atomic-batch|_qr_native|_qi_Protocol|from typing|\/proc\/|auditExpected/,
  );
  const artifact = python.retainPythonOrigin(receipt, origin);
  const typingRoot = path.join(root, "dist/runtime/python/typing");
  const checker = python.createPythonChecker({
    typingRoot,
    definitionsRoot: typingRoot,
    pythonPlatform: "Windows",
  });
  const checked = await checker.check({ artifact, context: { kind: "raw" } });
  assert.equal(checked.status, "passed", JSON.stringify(checked));
  assert.equal(checked.provenance.wireHash, sha(receipt.script));
  const tampered = python.prepareWireArtifact(
    path.join(root, "dist/runtime/python"),
    receipt.script + "\npass\n",
    { context: artifact.context, request: binding },
  );
  const rejected = await checker.check({
    artifact: tampered,
    context: { kind: "raw" },
  });
  assert.notEqual(rejected.status, "passed");
});

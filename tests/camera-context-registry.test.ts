import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { planCameraSaveContext } from "../packages/node-adapters/src/python/camera-context-registry.js";

const root = process.env["FMCAD_CONTEXT_TEST_ROOT"] ?? process.cwd();
const load = createRequire(path.join(root, "package.json"));
const { loadPayloadDefinitions } = load(
  "./packages/node-adapters/dist/python/registered-payload.js",
) as {
  loadPayloadDefinitions(
    root: string,
    refs: readonly object[],
  ): readonly { source: string }[];
};

test("canonical camera context preserves target guards without resolvers", () => {
  const plan = planCameraSaveContext({});
  assert.ok(plan);
  const definitions = loadPayloadDefinitions(root, [
    {
      id: "test.cast",
      filename: "assets/cad/core.py",
      symbol: "_cad_cast",
      importName: "typing.cast",
    },
    ...plan.references,
  ]);
  const source = definitions.map((unit) => unit.source).join("\n\n");
  assert.doesNotMatch(source, /def resolve|self\.resolve|def activate_target/);
  assert.match(source, /def assert_identity/);
  assert.match(source, /_document_assert_identity\(self.doc/);
  const program = `
import json, sys, types, unittest
adsk = types.ModuleType("adsk")
adsk.core = types.ModuleType("adsk.core")
adsk.fusion = types.ModuleType("adsk.fusion")
sys.modules.update({"adsk": adsk, "adsk.core": adsk.core, "adsk.fusion": adsk.fusion})
app = types.SimpleNamespace(documents=[])
adsk.core.Application = types.SimpleNamespace(get=lambda: app)
adsk.fusion.Design = types.SimpleNamespace(cast=lambda value: value)
namespace = {}
exec("from __future__ import annotations\\n" + ${JSON.stringify(source)}, namespace)
Context = namespace["CadContext"]

class Document:
    def __init__(self, name="Target", creation="creation", project="project"):
        self.name, self.creationId = name, creation
        self.file = types.SimpleNamespace(id="file", parentProject=types.SimpleNamespace(id=project))
        self.failure = None
        self.design_reads = 0
        self.design = types.SimpleNamespace(rootComponent=object())
        self.products = self
    @property
    def dataFile(self):
        if self.failure: raise RuntimeError(self.failure)
        return self.file
    def itemByProductType(self, name):
        assert name == "DesignProductType"
        self.design_reads += 1
        return self.design

class ContextBehavior(unittest.TestCase):
    def setUp(self):
        self.doc = Document()
        app.documents = [self.doc]
    def test_exact_target(self):
        ctx = Context("Target", None, None, "creation", "file")
        self.assertIs(ctx.doc, self.doc)
        self.assertEqual(ctx.created, [])
        self.assertEqual(self.doc.design_reads, 1)
        self.assertFalse(hasattr(Context, "resolve"))
        self.doc.creationId = "changed"
        with self.assertRaisesRegex(ValueError, "doc-id mismatch"):
            ctx.assert_identity()
    def test_wrong_pin_stops_before_design(self):
        with self.assertRaisesRegex(ValueError, "doc-id mismatch"):
            Context("Target", None, None, "other", "file")
        self.assertEqual(self.doc.design_reads, 0)
    def test_invalid_pin(self):
        for pin in ("", "bad pin", "-option"):
            with self.subTest(pin=pin), self.assertRaisesRegex(ValueError, "requires a nonempty identity"):
                Context("Target", None, None, pin)
        self.assertEqual(self.doc.design_reads, 0)
    def test_wrong_file(self):
        with self.assertRaisesRegex(ValueError, "doc-file-id mismatch"):
            Context("Target", None, None, "creation", "other-file")
    def test_missing_or_ambiguous_name(self):
        with self.assertRaisesRegex(ValueError, "expected one match, found 0"):
            Context("Other")
        app.documents.append(Document(creation="other"))
        with self.assertRaisesRegex(ValueError, "expected one match, found 2"):
            Context("Target")
    def test_design_required(self):
        self.doc.design = None
        with self.assertRaisesRegex(ValueError, "no Fusion Design product"):
            Context("Target")
    def test_temporary_file_failure_without_file_pin(self):
        self.doc.failure = "Failed to get temporary file"
        self.assertIs(Context("Target", None, None, "creation").doc, self.doc)
        with self.assertRaisesRegex(ValueError, "doc-file-id cannot be verified"):
            Context("Target", None, None, "creation", "file")
    def test_unexpected_sdk_failure(self):
        self.doc.failure = "unexpected SDK error"
        with self.assertRaisesRegex(RuntimeError, "unexpected SDK error"):
            Context("Target", None, None, "creation", "file")

unittest.main()
`;
  const result = spawnSync("python3", ["-I", "-S", "-B", "-c", program], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran 8 tests/);
});

test("project filtering remains canonical and components require an explicit plan", () => {
  const plan = planCameraSaveContext({ projectId: "project" });
  assert.ok(plan);
  const definition = plan.references.find((ref) => ref.symbol === "CadContext");
  assert.deepEqual(definition?.bindings, {
    __init__: { component_ref: null, resolved_doc: null },
  });
  assert.equal(planCameraSaveContext({ component: "root" }), null);
  assert.equal(planCameraSaveContext({ component: { name: "part" } }), null);
  const source = loadPayloadDefinitions(root, plan.references)
    .map((unit) => unit.source)
    .join("\n\n");
  assert.match(source, /parentProject.id/);
  assert.doesNotMatch(source, /self\.resolve|def resolve/);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

import { field, array, string, present } from "./modeling-unit-test-support";
const sourceDirectory = path.join(process.cwd(), "tests");
const sourceFile = path.join(sourceDirectory, "recovery-isolation.test.ts");
const loadModule = createRequire(sourceFile);

const qi = loadModule("../src/queue-instance") as ReturnType<
  typeof import("../packages/node-adapters/src/execution/queue-instance").createQueueInstance
>;
const { buildBridgeScript } = loadModule(
  "../src/addin-bridge",
) as typeof import("../src/composition/library-addin-bridge");

const stub = `import sys, types
class Collection:
    def __init__(self,values): self.values=values;self.count=len(values)
    def item(self,i): return self.values[i]
    def __iter__(self): return iter(self.values)
def coll(values): return Collection(values)
design=types.SimpleNamespace(allComponents=coll([]),allParameters=coll([]),timeline=types.SimpleNamespace(count=0,markerPosition=0))
class Doc:
    def __init__(self,name,broken=False):
        self.name=name;self.creationId='creation-'+name;self.isSaved=True;self.isModified=broken;self.isActive=False;self.broken=broken
        self.products=types.SimpleNamespace(itemByProductType=lambda kind:design)
        self.allDocumentReferences=coll([])
    @property
    def dataFile(self):
        if self.broken: raise RuntimeError('3 : Failed to get temporary file')
        return types.SimpleNamespace(id='file-'+self.name,versionNumber=3)
docs=[Doc('recovery',True),Doc('healthy')]
app=types.SimpleNamespace(version='offline-test',userInterface=types.SimpleNamespace(activeCommand='SelectCommand'),documents=coll(docs))
core=types.ModuleType('adsk.core');core.Application=types.SimpleNamespace(get=lambda:app)
adsk=types.ModuleType('adsk');adsk.core=core
sys.modules['adsk']=adsk;sys.modules['adsk.core']=core
`;

function python(source: string) {
  const result = spawnSync("python3", ["-B", "-c", stub + source], {
    encoding: "utf8",
  });
  assert.equal(field(result, "status"), 0, string(field(result, "stderr")));
  return string(field(result, "stdout"));
}
const asset = (file: string) =>
  fs.readFileSync(path.join(sourceDirectory, "..", "assets", file), "utf8");
function client(setup = "") {
  return {
    server: { timeoutMs: 20000 },
    async callTool(value: unknown) {
      const result = spawnSync(
        "python3",
        [
          "-B",
          "-c",
          stub +
            setup +
            "\n" +
            string(field(value, "object", "script")) +
            "\nrun(None)",
        ],
        { encoding: "utf8" },
      );
      return {
        failed: field(result, "status") !== 0,
        text: string(field(result, "stdout")) + string(field(result, "stderr")),
      };
    },
  };
}

test("probe observes the recovery identity and still fingerprints a pinned healthy sibling", async () => {
  const result = await qi.probe(client(), {
    documentSelector: {
      name: "healthy",
      creationId: "creation-healthy",
      fileId: "file-healthy",
    },
  });
  assert.equal(field(result, "documents", "length"), 2);
  assert.equal(field(result, "documents", 0, "id"), "creation-recovery");
  assert.equal(field(result, "documents", 0, "fileId"), null);
  assert.match(
    string(field(result, "documents", 0, "dataFileError", "message")),
    /temporary file/,
  );
  assert.equal(field(result, "documentState", "status"), "complete");
  assert.equal(
    field(result, "documentState", "state", "identity", "fileId"),
    "file-healthy",
  );
});

test("creation-pinned recovery diagnostics do not invent a cloud identity; cloud pins remain rejected", async () => {
  const local = await qi.probe(client(), {
    documentSelector: { name: "recovery", creationId: "creation-recovery" },
  });
  assert.equal(field(local, "documentState", "status"), "complete");
  assert.equal(
    field(local, "documentState", "state", "identity", "fileId"),
    null,
  );
  assert.equal(
    field(local, "documentState", "state", "identity", "version"),
    null,
  );
  assert.equal(
    field(local, "documentState", "state", "identity", "isSaved"),
    true,
  );
  assert.match(
    string(
      field(
        local,
        "documentState",
        "state",
        "identity",
        "dataFileError",
        "message",
      ),
    ),
    /temporary file/,
  );
  const pinned = await qi.probe(client(), {
    documentSelector: {
      name: "recovery",
      creationId: "creation-recovery",
      fileId: "claimed-lineage",
    },
  });
  assert.equal(field(pinned, "documentState", "status"), "unavailable");
  assert.equal(field(pinned, "documentState", "fingerprint"), undefined);
  const fileOnly = await qi.probe(client(), {
    documentSelector: { fileId: "file-healthy" },
  });
  assert.equal(
    field(fileOnly, "documentState", "status"),
    "unavailable",
    "An unreadable sibling could be another editor of the same lineage; require a local identity pin",
  );
});

test("document list reports both recovery and healthy documents with usable creation IDs", () => {
  const script = buildBridgeScript("fusion_mcp_read", {
    queryType: "document",
    operation: "open",
  });
  const text = python(script + "\nrun(None)");
  const result: unknown = JSON.parse(
    present(
      text.split("\n").find((line) => line.startsWith("FMCAD_BRIDGE_RESULT ")),
    ).slice("FMCAD_BRIDGE_RESULT ".length),
  );
  assert.equal(field(result, "success"), true);
  assert.equal(field(result, "partial"), true);
  assert.equal(field(result, "results", "length"), 2);
  assert.equal(field(result, "results", 0, "creationId"), "creation-recovery");
  assert.equal(field(result, "results", 0, "id"), undefined);
  assert.match(
    string(field(result, "results", 0, "dataFileError", "message")),
    /temporary file/,
  );
  assert.equal(field(result, "results", 1, "id"), "file-healthy");
});

test("status and review retain real saved/dirty flags with explicit unavailable metadata", () => {
  const text = python(
    asset("cad/identity.py") +
      "\n" +
      asset("cad/document_snapshot.py") +
      "\n" +
      asset("review.py") +
      "\nprint(json.dumps([_document_snapshot(docs[0]),document_identity(docs[0])]))",
  );
  const [status, review] = array(JSON.parse(text));
  assert.equal(field(status, "saved"), true);
  assert.equal(field(status, "modified"), true);
  assert.equal(field(status, "fileId"), null);
  assert.equal(field(review, "isSaved"), true);
  assert.equal(field(review, "isModified"), true);
  assert.equal(field(review, "version"), null);
  assert.match(
    string(field(status, "dataFileError", "message")),
    /temporary file/,
  );
  assert.match(
    string(field(review, "dataFileError", "message")),
    /temporary file/,
  );
});

test("a recovery cloud pin fails before activation and unexpected SDK faults propagate", () => {
  python(
    asset("cad/identity.py") +
      `
try:
    _document_assert_identity(docs[0],'creation-recovery','file-recovery')
    raise AssertionError('cloud identity was accepted')
except ValueError as error:
    assert 'cannot be verified' in str(error)
class Unexpected:
    @property
    def dataFile(self): raise RuntimeError('Unexpected SDK failure')
try:
    _document_data_file(Unexpected())
    raise AssertionError('unexpected SDK failure swallowed')
except RuntimeError as error:
    assert str(error)=='Unexpected SDK failure'
`,
  );
});

test("recovering a cloud identity invalidates the old creation-pinned fingerprint instead of silently adopting it", async () => {
  const selector = { name: "recovery", creationId: "creation-recovery" };
  const before = await qi.probe(client(), { documentSelector: selector });
  const after = await qi.probe(client("docs[0].broken=False"), {
    documentSelector: selector,
  });
  assert.equal(
    field(before, "documentState", "state", "identity", "fileId"),
    null,
  );
  assert.equal(
    field(after, "documentState", "state", "identity", "fileId"),
    "file-recovery",
  );
  assert.equal(
    Reflect.apply(
      (
        loadModule(
          "../src/queue-document",
        ) as typeof import("../src/queue-document")
      ).compareDocumentState,
      undefined,
      [field(before, "documentState"), field(after, "documentState")],
    ),
    "DOCUMENT_CHANGED",
  );
});

test("temporary-file failure in top-level reference metadata does not hide creation-pinned diagnostics", () => {
  python(
    asset("cad/identity.py") +
      `
class Recovery(Doc):
    @property
    def allDocumentReferences(self): raise RuntimeError('3 : Failed to get temporary file')
    @allDocumentReferences.setter
    def allDocumentReferences(self,value): pass
recovery=Recovery('recovery',True)
app.documents=coll([recovery,docs[1]])
assert _document_target(app,'recovery') is recovery
assert _document_target(app,'healthy') is docs[1]
`,
  );
});

test("a queue rejection before capture is reported as not submitted, not an unknown Fusion result", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qreview-"));
  const text: string[] = [];
  try {
    const result = await (
      loadModule(
        "../src/review",
      ) as typeof import("../src/composition/library-review-registration")
    ).reviewCmd(
      {
        async callTool() {
          throw Object.assign(
            new Error("Document changed before its SDK turn"),
            { code: "DOCUMENT_CHANGED", notStarted: true },
          );
        },
      },
      [
        "--doc",
        "Recovery",
        "--doc-id",
        "creation-recovery",
        "--out",
        path.join(dir, "review"),
      ],
      (value: string) => value,
      {
        stdout: {
          write(value: string) {
            text.push(value);
          },
        },
      },
    );
    assert.equal(result, 1);
    const report: unknown = JSON.parse(text.join(""));
    assert.equal(field(report, "status"), "rejected-before-capture");
    assert.equal(field(report, "operationSubmitted"), false);
    assert.equal(field(report, "restoration", "status"), "not-needed");
    assert.equal(field(report, "success"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

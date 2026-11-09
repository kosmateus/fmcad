import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Module, { createRequire } from "node:module";
import { createHash } from "node:crypto";
import ts from "typescript";
import type { Reference } from "../src/queue-epoch-lineage";
const root = process.cwd(),
  load = createRequire(path.join(root, "package.json"));
type Proof = typeof import("../src/queue-audit-response-proof");
type Data = Record<string, unknown>;
const frozen = "843ce0dc98d512f88c3c42124ad4f6909b69cc91",
  predecessor = "dce47c5e214b91b4ab68151e0b40510c4f7edfaf";
const fingerprint =
  "14aca04a4c37e5a3142d2493fc9e559987864779bad0b25dee41d166bcd3960d";
function fields(value: unknown): Data {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  return value as Data;
}
function frozenSource(revision: string, sourcePath: string): string {
  const entries = JSON.parse(
    fs.readFileSync(
      path.join(root, "tests/fixtures/history/manifest.json"),
      "utf8",
    ),
  ) as { revision: string; sourcePath: string; file: string; sha256: string }[];
  const entry = entries.find(
    (row) => row.revision === revision && row.sourcePath === sourcePath,
  );
  assert.ok(entry);
  assert.equal(path.basename(entry.file), entry.file);
  const bytes = fs.readFileSync(
    path.join(root, "tests/fixtures/history", entry.file),
  );
  assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256);
  return bytes.toString("utf8");
}
function compile(source: string, filename: string): unknown {
  const module = new Module(filename) as Module & {
    _compile(source: string, filename: string): void;
  };
  module.filename = filename;
  module.paths = createRequire(filename).resolve.paths("fixture") ?? [];
  module._compile(source, filename);
  return module.exports as unknown;
}
interface Fixture {
  files: Record<string, Reference>;
  records: Record<string, Data>;
  key: Data;
  migrationAudit: string;
}
function fixture(t: test.TestContext) {
  const restore = (
    load("./tests/fixtures/fake-wsl-platform.cjs") as () => () => void
  )();
  t.after(restore);
  const parent = path.join(root, ".test-artifacts");
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, "portable-audit843-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const installation = path.join(directory, "synthetic-runtime"),
    dir = path.join(directory, "queue");
  const put = (relative: string, source: string) => {
    const file = path.join(installation, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
    return file;
  };
  const python = frozenSource(
    predecessor,
    "runtime/python/recovery/atomic_audit.py",
  ).replaceAll("\n", "\r\n"); // Public dce47c5 blob, packaged as the historical CRLF producer.
  const pythonFile = put("runtime/python/recovery/atomic_audit.py", python);
  const sourceHash = createHash("sha256").update(python).digest("hex");
  // This is an explicit synthetic host identity port, not an installed runtime
  // qualification. Producer source and Python bytes are public Git predecessors;
  // receipt preparation uses the existing adapter. The private sealed843 run
  // separately verifies authentic historical executable/dependency bytes.
  put(
    "src/queue-instance.js",
    `const a=require(${JSON.stringify(path.join(root, "src/queue-instance"))});const fs=require('node:fs'),crypto=require('node:crypto');module.exports={...a,buildHash(directory){if(directory!==${JSON.stringify(installation)})throw Error('Unexpected synthetic producer root');if(crypto.createHash('sha256').update(fs.readFileSync(${JSON.stringify(pythonFile)})).digest('hex')!==${JSON.stringify(sourceHash)})throw Error('Synthetic producer bytes changed');return ${JSON.stringify(fingerprint)}}};`,
  );
  put(
    "src/python.js",
    `module.exports=require(${JSON.stringify(path.join(root, "src/python"))});`,
  );
  put(
    "src/queue-atomic-migration-files.js",
    `module.exports=require(${JSON.stringify(path.join(root, "src/queue-atomic-migration-files"))});`,
  );
  put(
    "src/dist/core/application/cad/json.js",
    `module.exports=require(${JSON.stringify(path.join(root, "src/dist/core/application/cad/json"))});`,
  );
  put(
    "src/queue-atomic-recovery-audit.js",
    frozenSource(frozen, "src/queue-atomic-recovery-audit.js"),
  );
  const filename = path.join(installation, "src/queue-audit-response-proof.js");
  const old = compile(
    frozenSource(predecessor, "src/queue-audit-response-proof.js"),
    filename,
  ) as Proof;
  const current = compile(
    ts.transpileModule(
      fs.readFileSync(
        path.join(root, "src/queue-audit-response-proof.ts"),
        "utf8",
      ),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2023,
        },
      },
    ).outputText,
    filename,
  ) as Proof;
  const existingFixture = fs.readFileSync(
    path.join(root, "tests/fixtures/audit-response.cjs"),
    "utf8",
  );
  const selector =
    "const installation = process.env.FMCAD_TEST_LEGACY_843_RUNTIME;";
  assert.ok(
    existingFixture.includes(selector),
    "Keep the retained fixture body intact",
  );
  const create = compile(
    existingFixture.replace(
      selector,
      `const installation = ${JSON.stringify(installation)};`,
    ),
    path.join(root, "tests/fixtures/audit-response.cjs"),
  ) as (
    dir: string,
    scope: Data,
    identity: Data,
    current: Data,
    historical: Data,
    owner: Data,
  ) => Fixture;
  const scope = { jobId: "target", observationJobId: "observer" };
  const data = create(
    dir,
    scope,
    {
      commandId: "fmcad_atomic_fixture",
      resolvedIdentity: {
        name: "Historical fixture",
        creationId: "old",
        fileId: null,
      },
    },
    { pid: 20, birth: "selected", version: "2706" },
    { pid: 10, birth: "historical", version: "2706" },
    { nonce: "departing-843" },
  );
  return { ...data, dir, scope, apis: [old, current] };
}
// Exact case map: these thirteen names and mutations retain every assertion in
// audit-response-proof.test.js. Additional predecessor/current equality proves
// migration parity; the synthetic identity port does not qualify native Fusion.
test("portable843: successful source/process-bound execution never invents missing dynamic facts or epoch eligibility", (t) => {
  const f = fixture(t),
    values = f.apis.map((api) =>
      api.auditResponseProof(f.files, f.dir, f.scope),
    );
  assert.deepEqual(values[1], values[0]);
  for (const proof of values) {
    assert.equal(proof.executionProof.exactGuardBeforeBodyVerified, true);
    assert.equal(proof.responseContract.callerId, 2);
    const wireId = proof.responseContract.wireId;
    assert.ok(typeof wireId === "string");
    assert.match(wireId, /^fmcad:/);
    assert.deepEqual(proof.facts.summary, null);
    assert.equal(proof.facts.available, false);
    assert.equal(proof.epochEligible, false);
    assert.equal(proof.originalStatus.endpointVerified, false);
    assert.equal(proof.historicalOutcome, "unknown");
  }
  for (const api of f.apis)
    assert.equal(api.auditResponseProofStillCurrent(values[0]), true);
  fs.writeFileSync(
    f.files["auditResult"]!.path,
    JSON.stringify({ forged: true }),
  );
  for (const api of f.apis)
    assert.equal(api.auditResponseProofStillCurrent(values[0]), false);
});
const changes: readonly [string, string, (record: Data) => void][] = [
  [
    "forged current instance",
    "auditRemote",
    (x) => {
      fields(x["instance"])["birth"] = "foreign";
    },
  ],
  [
    "wrong source hash",
    "auditRemote",
    (x) => {
      x["sourceHash"] = "other";
    },
  ],
  [
    "nonterminal receipt",
    "auditRemote",
    (x) => {
      x["terminal"] = false;
    },
  ],
  [
    "failed Python body",
    "auditRemote",
    (x) => {
      x["outcome"] = "failed";
    },
  ],
  [
    "different original caller",
    "auditStart",
    (x) => {
      fields(x["binding"])["requestHash"] = "other";
    },
  ],
  [
    "stripped endpoint guard",
    "auditStart",
    (x) => {
      delete fields(x["binding"])["auditExpectedInstance"];
    },
  ],
  [
    "changed checked wire",
    "auditWire",
    (x) => {
      const args = fields(fields(x["outgoing"])["params"]);
      const values = fields(args["arguments"]);
      values["code"] = String(values["code"]) + "\n# drift";
    },
  ],
  [
    "wrong wire identity",
    "auditWire",
    (x) => {
      fields(x["outgoing"])["id"] = "foreign";
    },
  ],
  [
    "forged summary",
    "auditResult",
    (x) => {
      x["summary"] = { ready: true };
    },
  ],
  [
    "fabricated endpoint verification",
    "auditResult",
    (x) => {
      x["endpointVerified"] = true;
    },
  ],
  [
    "wrong owner",
    "auditIntent",
    (x) => {
      fields(x["key"])["clientId"] = "foreign";
    },
  ],
  [
    "checker not passed",
    "auditStart",
    (x) => {
      fields(x["pythonCheck"])["status"] = "incomplete";
    },
  ],
];
for (const [name, record, mutate] of changes)
  test("portable843: even rehashed original evidence rejects " + name, (t) => {
    const f = fixture(t),
      ref = f.files[record]!;
    const value = fields(JSON.parse(fs.readFileSync(ref.path, "utf8")));
    mutate(value);
    const bytes = JSON.stringify(value);
    fs.writeFileSync(ref.path, bytes);
    ref.sha256 = createHash("sha256").update(bytes).digest("hex");
    for (const api of f.apis)
      assert.throws(() => api.auditResponseProof(f.files, f.dir, f.scope));
    assert.equal(
      fs.readFileSync(ref.path, "utf8"),
      bytes,
      "A rejected proof cannot repair or rewrite historical evidence",
    );
  });

import { createRequire } from "node:module";
import path from "node:path";
import nodeTest from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

interface AuditFixture {
  files: import("../src/queue-audit-response-proof").AuditResponseManifest;
  records: Record<string, Record<string, unknown>>;
  migrationAudit: string;
  key: { requestId: string };
}
interface MutableEvidence {
  instance: { birth: string };
  sourceHash: string;
  terminal: boolean;
  outcome: string;
  binding: { requestHash: string; auditExpectedInstance?: unknown };
  outgoing: { id: string; params: { arguments: { code: string } } };
  summary: unknown;
  endpointVerified: boolean;
  key: { clientId: string };
  pythonCheck: { status: string };
}
const root = process.cwd();
const load = createRequire(
  path.join(root, "tests", "audit-response-proof.test.js"),
);
const test = (name: string, fn: (t: nodeTest.TestContext) => void) =>
  nodeTest(
    name,
    {
      skip:
        !process.env["FMCAD_TEST_LEGACY_843_RUNTIME"] &&
        "Requires exact qualified legacy 843 runtime; set FMCAD_TEST_LEGACY_843_RUNTIME",
    },
    fn,
  );
const { auditResponseProof, auditResponseProofStillCurrent } = load(
  "../src/queue-audit-response-proof",
) as typeof import("../src/queue-audit-response-proof");
const { durable } = load("../src/queue-instance") as ReturnType<
  typeof import("../packages/node-adapters/src/execution/queue-instance").createQueueInstance
>;
const { fileHash } = load(
  "../src/queue-atomic-migration-files",
) as typeof import("../src/queue-atomic-migration-files");
function fixture(t: nodeTest.TestContext) {
  const dir = fs.mkdtempSync("/tmp/opencode/audit-response-proof-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const scope = { jobId: "target", observationJobId: "observer" };
  const f = (
    load("./fixtures/audit-response.cjs") as (
      ...args: unknown[]
    ) => AuditFixture
  )(
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
  return {
    ...f,
    dir,
    scope,
    read: () => auditResponseProof(f.files, dir, scope),
  };
}
test("successful source/process-bound execution never invents missing dynamic facts or epoch eligibility", (t) => {
  const f = fixture(t),
    proof = f.read();
  assert.equal(proof.executionProof.exactGuardBeforeBodyVerified, true);
  assert.equal(proof.responseContract.callerId, 2);
  assert.equal(typeof proof.responseContract.wireId, "string");
  assert.match(proof.responseContract.wireId as string, /^fmcad:/);
  assert.deepEqual(proof.facts.summary, null);
  assert.equal(proof.facts.available, false);
  assert.equal(proof.epochEligible, false);
  assert.equal(proof.originalStatus.endpointVerified, false);
  assert.equal(proof.historicalOutcome, "unknown");
  assert.equal(auditResponseProofStillCurrent(proof), true);
  durable(f.files.auditResult.path, { forged: true });
  assert.equal(auditResponseProofStillCurrent(proof), false);
});
const mutations: ReadonlyArray<
  readonly [
    string,
    keyof AuditFixture["files"],
    (value: MutableEvidence) => void,
  ]
> = [
  [
    "forged current instance",
    "auditRemote",
    (x) => {
      x.instance.birth = "foreign";
    },
  ],
  [
    "wrong source hash",
    "auditRemote",
    (x) => {
      x.sourceHash = "other";
    },
  ],
  [
    "nonterminal receipt",
    "auditRemote",
    (x) => {
      x.terminal = false;
    },
  ],
  [
    "failed Python body",
    "auditRemote",
    (x) => {
      x.outcome = "failed";
    },
  ],
  [
    "different original caller",
    "auditStart",
    (x) => {
      x.binding.requestHash = "other";
    },
  ],
  [
    "stripped endpoint guard",
    "auditStart",
    (x) => {
      delete x.binding.auditExpectedInstance;
    },
  ],
  [
    "changed checked wire",
    "auditWire",
    (x) => {
      x.outgoing.params.arguments.code += "\n# drift";
    },
  ],
  [
    "wrong wire identity",
    "auditWire",
    (x) => {
      x.outgoing.id = "foreign";
    },
  ],
  [
    "forged summary",
    "auditResult",
    (x) => {
      x.summary = { ready: true };
    },
  ],
  [
    "fabricated endpoint verification",
    "auditResult",
    (x) => {
      x.endpointVerified = true;
    },
  ],
  [
    "wrong owner",
    "auditIntent",
    (x) => {
      x.key.clientId = "foreign";
    },
  ],
  [
    "checker not passed",
    "auditStart",
    (x) => {
      x.pythonCheck.status = "incomplete";
    },
  ],
];
for (const [name, record, mutate] of mutations)
  test("even rehashed original evidence rejects " + name, (t) => {
    const f = fixture(t),
      p = f.files[record].path,
      value = JSON.parse(fs.readFileSync(p, "utf8")) as MutableEvidence;
    mutate(value);
    durable(p, value);
    f.files[record].sha256 = fileHash(p).sha256;
    assert.throws(f.read);
  });

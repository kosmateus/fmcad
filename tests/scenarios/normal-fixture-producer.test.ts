import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { NormalFixtureProducer } from "./normal-fixture-producer";
import {
  discoverOwnedUnsavedFixtureProofs,
  assertReceiptBoundDocumentInventory,
} from "./fixture-provenance";

const build = "a".repeat(64);
const backend = {
  identity: "fusion:addin:" + build,
  mode: "fusion",
  qualification: "broker",
  protocol: "addin",
} as const;

function fixture(t: { after(fn: () => void): void }) {
  const parent = path.join(process.cwd(), ".test-artifacts");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "normal-canonical-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const producer = new NormalFixtureProducer(root, randomUUID(), 1, build);
  producer.baseline([]);
  const owner = producer.owners[0]!;
  const requestId = producer.begin(0, "create");
  const document = {
    creationId: randomUUID(),
    name: "Display name is not admission authority",
  };
  const identity = {
    ...document,
    activeCreationId: document.creationId,
    requestId,
    clientId: owner.clientId,
  };
  fs.writeFileSync(
    path.join(producer.directory, owner.scenarioId, "creation.json"),
    JSON.stringify(identity),
    { flag: "wx" },
  );
  const sourceFile = path.join(root, "original-create.py");
  const source =
    "# exact submitted source\n" +
    producer.creationTail(0, requestId, (file) => file);
  fs.writeFileSync(sourceFile, source);
  const raw = {
    job: {
      id: randomUUID(),
      requestId,
      clientId: owner.clientId,
      state: "succeeded",
    },
    execution: { sdkSettled: true, mayHaveMutated: true, exitCode: 0 },
    stdout: "FMCAD_SCENARIO " + JSON.stringify(identity),
    provenance: {
      status: "available",
      inputs: [
        {
          kind: "source",
          originalPath: sourceFile,
          bytes: Buffer.byteLength(source),
          sha256: createHash("sha256").update(source).digest("hex"),
        },
      ],
    },
  };
  return { root, producer, owner, document, requestId, sourceFile, raw };
}

test("new normal owners use the canonical producer contract and admit open then closed fixtures", async (t) => {
  const f = fixture(t);
  await f.producer.publish(
    0,
    f.requestId,
    f.raw.job.id,
    f.sourceFile,
    async () => f.raw,
  );
  const observed = [
    { ...f.document, saved: false, modified: true, fileId: null },
  ];
  let proofs = discoverOwnedUnsavedFixtureProofs(f.root, backend);
  assert.equal(proofs.get(f.document.creationId)?.state, "open");
  assertReceiptBoundDocumentInventory(
    [],
    observed,
    proofs,
    "new normal owner is a canonical live peer",
  );
  const closeId = f.producer.begin(0, "close");
  const closeSource = path.join(f.root, "original-close.py");
  const bytes = f.producer.closeTail(f.document);
  fs.writeFileSync(closeSource, bytes);
  const close = {
    ...f.raw,
    job: { ...f.raw.job, id: randomUUID(), requestId: closeId },
    stdout:
      "FMCAD_SCENARIO " +
      JSON.stringify({ closed: true, creationId: f.document.creationId }),
    provenance: {
      status: "available",
      inputs: [
        {
          kind: "source",
          originalPath: closeSource,
          bytes: Buffer.byteLength(bytes),
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      ],
    },
  };
  await f.producer.publish(
    0,
    closeId,
    close.job.id,
    closeSource,
    async () => close,
  );
  f.producer.finish(true);
  proofs = discoverOwnedUnsavedFixtureProofs(f.root, backend);
  assert.equal(proofs.get(f.document.creationId)?.state, "closed");
  assertReceiptBoundDocumentInventory(
    observed,
    [],
    proofs,
    "exact normal cleanup permits disappearance",
  );
});

test("normal publication rejects foreign, unknown, forged source and substituted request originals", async (t) => {
  for (const mutation of [
    "foreign",
    "request",
    "unknown",
    "source",
    "job",
  ] as const) {
    const f = fixture(t);
    const raw = structuredClone(f.raw);
    if (mutation === "foreign") raw.job.clientId += ":foreign";
    if (mutation === "request") raw.job.requestId += ":foreign";
    if (mutation === "unknown") raw.execution.sdkSettled = false;
    if (mutation === "source")
      raw.provenance.inputs[0]!.sha256 = "f".repeat(64);
    if (mutation === "job") raw.job.id = randomUUID();
    await assert.rejects(
      f.producer.publish(
        0,
        f.requestId,
        f.raw.job.id,
        f.sourceFile,
        async () => raw,
      ),
    );
    assert.equal(
      discoverOwnedUnsavedFixtureProofs(f.root, backend).has(
        f.document.creationId,
      ),
      false,
    );
    assert.throws(() =>
      assertReceiptBoundDocumentInventory(
        [],
        [{ ...f.document, saved: false, modified: false, fileId: null }],
        discoverOwnedUnsavedFixtureProofs(f.root, backend),
        "Unpublished normal source is not authority",
      ),
    );
  }
});

test("a normal owner with an unknown close remains unsettled, never closed or replayed", async (t) => {
  const f = fixture(t);
  await f.producer.publish(
    0,
    f.requestId,
    f.raw.job.id,
    f.sourceFile,
    async () => f.raw,
  );
  await assert.rejects(
    f.producer.publish(
      0,
      f.requestId,
      f.raw.job.id,
      f.sourceFile,
      async () => f.raw,
    ),
    /republish/u,
  );
  const closeId = f.producer.begin(0, "close");
  const raw = {
    ...f.raw,
    job: { ...f.raw.job, id: randomUUID(), requestId: closeId },
    execution: { ...f.raw.execution, sdkSettled: false },
  };
  await assert.rejects(
    f.producer.publish(0, closeId, raw.job.id, f.sourceFile, async () => raw),
  );
  f.producer.finish(false);
  const proofs = discoverOwnedUnsavedFixtureProofs(f.root, backend);
  assert.equal(proofs.get(f.document.creationId)?.state, "unsettled");
  const observed = [
    { ...f.document, saved: false, modified: true, fileId: null },
  ];
  assert.throws(() =>
    assertReceiptBoundDocumentInventory(
      observed,
      [],
      proofs,
      "unknown close is not disappearance authority",
    ),
  );
});

test("new canonical normal create and close payloads pass pinned production admission", async (t) => {
  const f = fixture(t);
  const root = path.resolve(__dirname, "../../..");
  const load = createRequire(path.join(root, "package.json"));
  const { createPythonChecker } = load(
    "./packages/node-adapters/dist/python/checker",
  ) as typeof import("../../packages/node-adapters/src/python/checker");
  const { preparePythonArtifact } = load(
    "./packages/node-adapters/dist/python/artifact",
  ) as typeof import("../../packages/node-adapters/src/python/artifact");
  const typingRoot = path.join(root, "dist/runtime/python/typing");
  const checker = createPythonChecker({
    typingRoot,
    definitionsRoot: typingRoot,
    pythonPlatform: "Windows",
  });
  const bodies = [
    `a=adsk.core.Application.get()
assert not any(d.name=="Unrelated display name" for d in a.documents)
d=a.documents.add(cast(adsk.core.DocumentTypes, adsk.core.DocumentTypes.FusionDesignDocumentType))
d.name="Unrelated display name"
print('FMCAD_RESULT '+json.dumps(dict(name=d.name,creationId=d.creationId,saved=d.isSaved)))` +
      f.producer.creationTail(0, f.requestId, (file) => file),
    `a=adsk.core.Application.get()
owned=[d for d in a.documents if d.creationId==${JSON.stringify(f.document.creationId)}]
assert len(owned)==1 and owned[0].name==${JSON.stringify(f.document.name)} and not owned[0].isSaved
d=owned[0]
assert d.close(False)
print('FMCAD_RESULT '+json.dumps(dict(closed=True,creationId=${JSON.stringify(f.document.creationId)})))` +
      f.producer.closeTail(f.document),
  ];
  for (const [index, body] of bodies.entries()) {
    const source =
      "import adsk.core, adsk.fusion, json, time\nfrom typing import cast\nDOC_NAME = None\ndef run(context: str):\n" +
      body
        .split("\n")
        .map((line) => "    " + line)
        .join("\n") +
      '\nrun("")\n';
    const artifact = preparePythonArtifact([
      {
        id: "normal-canonical-" + index,
        filename: "normal-canonical.py",
        role: "user",
        source,
      },
    ]);
    const result = await checker.check({ artifact, context: { kind: "run" } });
    assert.equal(result.status, "passed", JSON.stringify(result));
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.provenance.checkerVersion, "1.40.2");
    assert.equal(
      result.provenance.definitionsHash,
      "83dc3697aa61a47ada93c323e2f719c7be3d72091938415f666089a96b159179",
    );
  }
});

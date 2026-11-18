import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { TestContext } from "node:test";
import type { Execution, ScenarioBackend } from "./contracts";
import * as provenance from "./fixture-provenance";
import { close, create, marker } from "./programs";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "fmcad-supplemental-close-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runId = "11111111-2222-4333-8444-555555555555",
    scenarioId = "peer";
  const directory = path.join(root, runId, scenarioId);
  fs.mkdirSync(directory, { recursive: true });
  const owner = {
    runId,
    scenarioId,
    clientId: "scenario:" + runId + ":" + scenarioId,
  };
  const document = { creationId: "exact-peer-id", name: "Owned peer" };
  const identity = {
    ...document,
    activeCreationId: document.creationId,
    clientId: owner.clientId,
    requestId: owner.clientId + ":0",
  };
  const creation: Execution = {
    requestId: identity.requestId,
    state: "succeeded",
    sdkSettled: true,
    mayHaveMutated: true,
    stdout: marker + JSON.stringify(identity),
    brokerReceipt: {
      requestId: identity.requestId,
      clientId: owner.clientId,
      jobId: "create-job",
      state: "succeeded",
      operationResult: null,
    },
  };
  const retained = new Map<string, Execution>([[creation.requestId, creation]]);
  const build = "b".repeat(64);
  const backend: Pick<
    ScenarioBackend,
    "mode" | "qualification" | "protocol" | "identity"
  > & { lookup: NonNullable<ScenarioBackend["lookup"]> } = {
    mode: "simulator",
    qualification: "broker",
    protocol: "addin",
    identity: "simulator:addin:" + build,
    lookup: async (requestedOwner, requestId) =>
      requestedOwner.clientId === owner.clientId
        ? (retained.get(requestId) ?? null)
        : null,
  };
  const write = (filename: string, value: unknown) =>
    fs.writeFileSync(filename, JSON.stringify(value), { mode: 0o600 });
  write(path.join(root, runId, "index.json"), {
    runId,
    mode: backend.mode,
    qualification: backend.qualification,
    protocol: backend.protocol,
    backendIdentity: backend.identity,
    scenarioIds: [scenarioId],
    before: { documents: [] },
    status: "finished",
  });
  write(path.join(directory, "creation.json"), identity);
  write(path.join(directory, "report.json"), {
    owner,
    directory,
    mode: backend.mode,
    qualification: backend.qualification,
    protocol: backend.protocol,
    backendIdentity: backend.identity,
    scope: "owned-document",
    status: "failed",
    cleanup: "deferred",
    document,
    requests: [
      {
        requestId: creation.requestId,
        phase: "create",
        intent: { kind: "script" },
        result: creation,
      },
    ],
  });
  const runtime = async () => ({
    buildHash: build,
    instanceId: "runtime-instance",
  });
  const createFile = path.join(directory, "request-0.py"),
    createSource = create(
      document.name,
      path.join(directory, "creation.json"),
      { clientId: owner.clientId, requestId: creation.requestId },
    );
  fs.writeFileSync(createFile, createSource, { flag: "wx", mode: 0o600 });
  const originals = new Map<string, unknown>([
    [
      creation.requestId,
      {
        job: {
          id: "create-job",
          requestId: creation.requestId,
          clientId: owner.clientId,
          state: "succeeded",
          operationResult: null,
        },
        execution: { sdkSettled: true },
        stdout: creation.stdout,
        provenance: {
          status: "available",
          inputs: [
            {
              kind: "source",
              originalPath: createFile,
              sha256: createHash("sha256").update(createSource).digest("hex"),
              bytes: Buffer.byteLength(createSource),
            },
          ],
        },
      },
    ],
  ]);
  const ports: provenance.SupplementalClosePorts = {
    readRuntimeBinding: runtime,
    readOriginalResult: async (requestedOwner, id) => {
      assert.deepEqual(requestedOwner, owner);
      assert.ok(originals.has(id), "Original receipt not found");
      return originals.get(id);
    },
  };
  const requestId = owner.clientId + ":1";
  const complete = () => {
    const source = close(document, false);
    const executionSourceFile = path.join(directory, "request-1.py");
    fs.writeFileSync(executionSourceFile, source, { flag: "wx", mode: 0o600 });
    const row = {
      ...document,
      fileId: null,
      saved: false,
      modified: false,
      active: true,
    };
    const foreign = {
      creationId: "user-document",
      name: "User",
      fileId: "user-file",
      saved: true,
      modified: false,
      active: false,
    };
    const stdout =
      marker +
      JSON.stringify({
        creationId: document.creationId,
        closed: true,
        inventoryFence: {
          version: 1,
          before: [row, foreign],
          after: [foreign],
        },
      });
    const operationResult = {
      version: 1,
      requestId,
      jobId: "close-job",
      acceptance: "accepted",
      executionOutcome: "succeeded",
      mayHaveMutated: true,
    };
    const execution: Execution = {
      requestId,
      state: "succeeded",
      sdkSettled: true,
      mayHaveMutated: true,
      exitCode: 0,
      stdout,
      brokerReceipt: {
        requestId,
        clientId: owner.clientId,
        jobId: "close-job",
        state: "succeeded",
        operationResult,
      },
    };
    retained.set(requestId, execution);
    const now = Date.now();
    return {
      job: {
        id: "close-job",
        requestId,
        clientId: owner.clientId,
        kind: "command",
        state: "succeeded",
        submittedAt: now,
        startedAt: now,
        finishedAt: now,
        operationResult,
      },
      execution: {
        state: "succeeded",
        sdkSettled: true,
        mayHaveMutated: true,
        exitCode: 0,
        publicationOutcome: "published",
      },
      stdout,
      provenance: {
        status: "available",
        inputs: [
          {
            version: 1,
            kind: "source",
            originalPath: executionSourceFile,
            sha256: createHash("sha256").update(source).digest("hex"),
            bytes: Buffer.byteLength(source),
          },
        ],
      },
    };
  };
  return {
    root,
    directory,
    owner,
    document,
    backend,
    runtime,
    ports,
    originals,
    requestId,
    complete,
    retained,
    write,
  };
}

test("public canonical reader consumes a prepared owner-bound supplemental close without rewriting historical failure", async (t) => {
  const f = fixture(t);
  const original = fs.readFileSync(
    path.join(f.directory, "report.json"),
    "utf8",
  );
  assert.equal(typeof provenance.prepareSupplementalCloseProof, "function");
  const prepared = await provenance.prepareSupplementalCloseProof(
    f.directory,
    f.backend,
    f.requestId,
    f.ports,
  );
  assert.equal(fs.readFileSync(prepared.sourceFile, "utf8"), prepared.source);
  assert.deepEqual(prepared.owner, f.owner);
  f.originals.set(f.requestId, f.complete());
  await provenance.publishSupplementalCloseProof(
    f.directory,
    f.backend,
    f.ports,
  );
  const proof = provenance
    .discoverOwnedUnsavedFixtureProofs(f.root, f.backend)
    .get(f.document.creationId);
  assert.equal(proof?.state, "closed");
  assert.equal(proof?.supplementalClose?.jobId, "close-job");
  assert.equal(
    fs.readFileSync(path.join(f.directory, "report.json"), "utf8"),
    original,
  );
});

const invalidOriginals: ReadonlyArray<
  readonly [
    string,
    (raw: ReturnType<ReturnType<typeof fixture>["complete"]>) => void,
  ]
> = [
  [
    "another client",
    (raw) => {
      raw.job.clientId = "foreign-client";
    },
  ],
  [
    "another request",
    (raw) => {
      raw.job.requestId = "foreign-request";
    },
  ],
  [
    "another job",
    (raw) => {
      raw.job.id = "foreign-job";
    },
  ],
  [
    "failed execution",
    (raw) => {
      raw.execution.state = "failed";
    },
  ],
  [
    "unsettled execution",
    (raw) => {
      raw.execution.sdkSettled = false;
    },
  ],
  [
    "unpublished execution",
    (raw) => {
      raw.execution.publicationOutcome = "failed";
    },
  ],
  [
    "receipt before preparation",
    (raw) => {
      raw.job.submittedAt = 0;
      raw.job.startedAt = 0;
    },
  ],
  [
    "inverted chronology",
    (raw) => {
      raw.job.finishedAt = raw.job.startedAt - 1;
    },
  ],
  [
    "source digest mismatch",
    (raw) => {
      raw.provenance.inputs[0]!.sha256 = "a".repeat(64);
    },
  ],
  [
    "source length mismatch",
    (raw) => {
      raw.provenance.inputs[0]!.bytes++;
    },
  ],
  [
    "source path mismatch",
    (raw) => {
      raw.provenance.inputs[0]!.originalPath += ".foreign";
    },
  ],
  [
    "unavailable source provenance",
    (raw) => {
      raw.provenance.status = "unavailable";
    },
  ],
  [
    "different output",
    (raw) => {
      raw.stdout = marker + "{}";
    },
  ],
];
for (const [label, corrupt] of invalidOriginals) {
  test(`publisher rejects ${label} without publishing a canonical closure`, async (t) => {
    const f = fixture(t);
    await provenance.prepareSupplementalCloseProof(
      f.directory,
      f.backend,
      f.requestId,
      f.ports,
    );
    const raw = f.complete();
    corrupt(raw);
    f.originals.set(f.requestId, raw);
    await assert.rejects(
      provenance.publishSupplementalCloseProof(f.directory, f.backend, f.ports),
    );
    assert.equal(
      fs.existsSync(path.join(f.directory, "supplemental-close.json")),
      false,
    );
    assert.equal(
      provenance
        .discoverOwnedUnsavedFixtureProofs(f.root, f.backend)
        .get(f.document.creationId)?.state,
      "unsettled",
    );
  });
}

test("publisher requires the authenticated original owner lookup", async (t) => {
  const f = fixture(t);
  await provenance.prepareSupplementalCloseProof(
    f.directory,
    f.backend,
    f.requestId,
    f.ports,
  );
  f.originals.set(f.requestId, f.complete());
  f.retained.delete(f.requestId);
  await assert.rejects(
    provenance.publishSupplementalCloseProof(f.directory, f.backend, f.ports),
  );
});

test("prepare rejects already admitted work and never overwrites its evidence", async (t) => {
  const f = fixture(t);
  const prepared = await provenance.prepareSupplementalCloseProof(
    f.directory,
    f.backend,
    f.requestId,
    f.ports,
  );
  const intentFile = path.join(f.directory, "supplemental-close.intent.json");
  const intent = fs.readFileSync(intentFile, "utf8");
  await assert.rejects(
    provenance.prepareSupplementalCloseProof(
      f.directory,
      f.backend,
      f.requestId,
      f.ports,
    ),
  );
  assert.equal(fs.readFileSync(intentFile, "utf8"), intent);
  assert.equal(fs.readFileSync(prepared.sourceFile, "utf8"), prepared.source);
  f.originals.set(f.requestId, f.complete());
  await assert.rejects(
    provenance.prepareSupplementalCloseProof(
      f.directory,
      f.backend,
      f.requestId,
      f.ports,
    ),
  );
  await provenance.publishSupplementalCloseProof(
    f.directory,
    f.backend,
    f.ports,
  );
  const closureFile = path.join(f.directory, "supplemental-close.json"),
    closure = fs.readFileSync(closureFile, "utf8");
  await assert.rejects(
    provenance.publishSupplementalCloseProof(f.directory, f.backend, f.ports),
  );
  assert.equal(fs.readFileSync(closureFile, "utf8"), closure);
});

test("publisher rejects a replacement runtime instance even with the same build", async (t) => {
  const f = fixture(t);
  await provenance.prepareSupplementalCloseProof(
    f.directory,
    f.backend,
    f.requestId,
    f.ports,
  );
  f.originals.set(f.requestId, f.complete());
  await assert.rejects(
    provenance.publishSupplementalCloseProof(f.directory, f.backend, {
      ...f.ports,
      readRuntimeBinding: async () => ({
        ...(await f.runtime()),
        instanceId: "replacement",
      }),
    }),
  );
});

for (const filename of [
  "report.json",
  "creation.json",
  "supplemental-close.intent.json",
  "supplemental-close.py",
  "request-1.py",
  "supplemental-close.json",
]) {
  test(`canonical discovery fails closed after ${filename} tampering`, async (t) => {
    const f = fixture(t);
    await provenance.prepareSupplementalCloseProof(
      f.directory,
      f.backend,
      f.requestId,
      f.ports,
    );
    f.originals.set(f.requestId, f.complete());
    await provenance.publishSupplementalCloseProof(
      f.directory,
      f.backend,
      f.ports,
    );
    fs.appendFileSync(path.join(f.directory, filename), "tampered");
    assert.notEqual(
      provenance
        .discoverOwnedUnsavedFixtureProofs(f.root, f.backend)
        .get(f.document.creationId)?.state,
      "closed",
    );
  });
}

test("prepare never treats a cleanup hold as cleanup authorization", async (t) => {
  const f = fixture(t),
    filename = path.join(f.directory, "report.json");
  const report: unknown = JSON.parse(fs.readFileSync(filename, "utf8"));
  assert.ok(report && typeof report === "object");
  f.write(filename, {
    ...report,
    cleanupHold: { requestId: f.owner.clientId + ":0", reason: "Guard failed" },
  });
  await assert.rejects(
    provenance.prepareSupplementalCloseProof(
      f.directory,
      f.backend,
      f.requestId,
      f.ports,
    ),
    /cleanupHold/u,
  );
  assert.equal(
    fs.existsSync(path.join(f.directory, "supplemental-close.intent.json")),
    false,
  );
});

test("even authenticated output cannot excuse a changed foreign row or a duplicate identity", async (t) => {
  for (const duplicate of [false, true]) {
    const f = fixture(t);
    await provenance.prepareSupplementalCloseProof(
      f.directory,
      f.backend,
      f.requestId,
      f.ports,
    );
    const raw = f.complete();
    const payload = {
      creationId: f.document.creationId,
      closed: true,
      inventoryFence: {
        version: 1,
        before: [
          {
            ...f.document,
            fileId: null,
            saved: false,
            modified: false,
            active: true,
          },
          {
            creationId: "user",
            name: "User",
            fileId: "user-file",
            saved: true,
            modified: false,
            active: false,
          },
        ],
        after: [
          {
            creationId: "user",
            name: "User",
            fileId: "user-file",
            saved: true,
            modified: !duplicate,
            active: false,
          },
        ],
      },
    };
    if (duplicate)
      payload.inventoryFence.after.push(payload.inventoryFence.after[0]!);
    raw.stdout = marker + JSON.stringify(payload);
    const retained = f.retained.get(f.requestId)!;
    f.retained.set(f.requestId, { ...retained, stdout: raw.stdout });
    f.originals.set(f.requestId, raw);
    await assert.rejects(
      provenance.publishSupplementalCloseProof(f.directory, f.backend, f.ports),
    );
    assert.equal(
      fs.existsSync(path.join(f.directory, "supplemental-close.json")),
      false,
    );
  }
});

test("prepare rejects a creator report not matching authenticated original work", async (t) => {
  const f = fixture(t),
    original = f.retained.get(f.owner.clientId + ":0")!;
  f.retained.set(original.requestId, {
    ...original,
    stdout: original.stdout + "different",
  });
  await assert.rejects(
    provenance.prepareSupplementalCloseProof(
      f.directory,
      f.backend,
      f.requestId,
      f.ports,
    ),
  );
  assert.equal(
    fs.existsSync(path.join(f.directory, "supplemental-close.intent.json")),
    false,
  );
});

test("canonical source records reject symlinks and oversized sidecars", async (t) => {
  const f = fixture(t);
  await provenance.prepareSupplementalCloseProof(
    f.directory,
    f.backend,
    f.requestId,
    f.ports,
  );
  f.originals.set(f.requestId, f.complete());
  await provenance.publishSupplementalCloseProof(
    f.directory,
    f.backend,
    f.ports,
  );
  const filename = path.join(f.directory, "supplemental-close.json"),
    outside = path.join(f.root, "outside.json");
  fs.renameSync(filename, outside);
  fs.symlinkSync(outside, filename);
  assert.equal(
    provenance
      .discoverOwnedUnsavedFixtureProofs(f.root, f.backend)
      .get(f.document.creationId)?.state,
    "unsettled",
  );
  fs.unlinkSync(filename);
  fs.writeFileSync(filename, " ".repeat(1024 * 1024 + 1));
  assert.equal(
    provenance
      .discoverOwnedUnsavedFixtureProofs(f.root, f.backend)
      .get(f.document.creationId)?.state,
    "unsettled",
  );
});

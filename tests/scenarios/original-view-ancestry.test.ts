import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import {
  currentProcessIdentity,
  discoverOwnedUnsavedFixtureProofs,
} from "./fixture-provenance";
import {
  captureOriginalView,
  prepareCaptureView,
} from "./original-view-programs";
import type { ScenarioBackend, Owner } from "./contracts";
import {
  create as createProgram,
  snapshot as inventorySnapshot,
} from "./programs";

function ancestry(
  t: TestContext,
  sharedRoot?: string,
  originalUser?: { creationId: string; name: string; fileId: null },
) {
  const root = sharedRoot ?? fs.mkdtempSync("/tmp/opencode/view-ancestry-");
  if (!sharedRoot)
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runId = randomUUID(),
    scenarioId = "peer",
    clientId = `scenario:${runId}:${scenarioId}`;
  const owner = { runId, scenarioId, clientId },
    directory = path.join(root, runId, scenarioId);
  const user = originalUser ?? {
    creationId: "real-user-id",
    name: "Independent user title",
    fileId: null,
  };
  const document = { creationId: randomUUID(), name: "Unrelated peer title" };
  const camera = {
    document: {
      creationId: user.creationId,
      name: user.name,
      dataFileId: null,
    },
    eye: [9, 8, 7],
    target: [0, 0, 0],
    up: [0, 0, 1],
    cameraType: "OrthographicCameraType",
    units: "cm",
    extents: [10, 9],
  };
  const snapshot = {
    documents: [{ ...user, saved: false, modified: false }],
    active: user,
    workspace: "FusionSolidEnvironment",
    camera,
    nativeCamera: {
      eye: camera.eye,
      target: camera.target,
      up: camera.up,
      cameraType: camera.cameraType,
      extents: camera.extents,
    },
    restorationProfile: "style-relative-1e-5",
  };
  const backend: ScenarioBackend = {
    identity: "view-ancestry:v1",
    mode: "fusion",
    qualification: "broker",
    protocol: "addin",
    capabilities: new Set(),
    fusionPath: (file) => file,
    execute: async () => {
      throw Error("Ancestry must not submit SDK");
    },
  };
  const identity = {
    ...document,
    requestId: clientId + ":1",
    clientId,
    activeCreationId: document.creationId,
  };
  const entry = (phase: string, sequence: number, value: unknown) => {
    const requestId = clientId + ":" + sequence,
      jobId = randomUUID();
    return {
      phase,
      requestId,
      intent: { kind: "script" },
      result: {
        requestId,
        state: "succeeded",
        sdkSettled: true,
        mayHaveMutated: true,
        stdout: "FMCAD_SCENARIO " + JSON.stringify(value) + "\n",
        brokerReceipt: {
          requestId,
          clientId,
          jobId,
          state: "succeeded",
          operationResult: {
            version: 1,
            requestId,
            jobId,
            acceptance: "accepted",
            executionOutcome: "succeeded",
            mayHaveMutated: true,
            code: "EXECUTION_COMPLETE",
          },
        },
      },
    };
  };
  const capture = entry("original-user-view-capture", 0, snapshot),
    create = entry("create", 1, identity);
  const report = {
    owner,
    directory,
    mode: backend.mode,
    qualification: backend.qualification,
    protocol: backend.protocol,
    backendIdentity: backend.identity,
    scope: "exclusive-instance",
    status: "running",
    cleanup: "pending",
    document,
    requests: [capture, create],
  };
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(root, runId, "index.json"),
    JSON.stringify({
      runId,
      mode: backend.mode,
      qualification: backend.qualification,
      protocol: backend.protocol,
      backendIdentity: backend.identity,
      scenarioIds: [scenarioId],
      status: "running",
      processIdentity: currentProcessIdentity(),
      before: { documents: snapshot.documents },
    }),
  );
  const source = captureOriginalView(),
    sourceFile = path.join(directory, "request-0.py");
  fs.writeFileSync(sourceFile, source);
  fs.writeFileSync(
    path.join(directory, "creation.json"),
    JSON.stringify(identity),
  );
  const write = () =>
    fs.writeFileSync(
      path.join(directory, "report.json"),
      JSON.stringify(report),
    );
  write();
  const original = {
    job: {
      id: capture.result.brokerReceipt.jobId,
      requestId: capture.requestId,
      clientId,
      state: "succeeded",
      startedAt: 100,
      finishedAt: 200,
      operationResult: structuredClone(
        capture.result.brokerReceipt.operationResult,
      ),
    },
    execution: { state: "succeeded", sdkSettled: true },
    stdout: capture.result.stdout,
    provenance: {
      status: "available",
      inputs: [
        {
          kind: "source",
          originalPath: sourceFile,
          sha256: createHash("sha256").update(source).digest("hex"),
          bytes: Buffer.byteLength(source),
        },
      ],
    },
  };
  const creationSource = createProgram(
    document.name,
    path.join(directory, "creation.json"),
    { requestId: create.requestId, clientId },
  );
  fs.writeFileSync(path.join(directory, "request-1.py"), creationSource);
  const originalCreate = {
    job: {
      id: create.result.brokerReceipt.jobId,
      requestId: create.requestId,
      clientId,
      state: "succeeded",
      startedAt: 300,
      finishedAt: 400,
      operationResult: structuredClone(
        create.result.brokerReceipt.operationResult,
      ),
    },
    execution: { state: "succeeded", sdkSettled: true },
    stdout: create.result.stdout,
    provenance: {
      status: "available",
      inputs: [
        {
          kind: "source",
          originalPath: path.join(directory, "request-1.py"),
          sha256: createHash("sha256").update(creationSource).digest("hex"),
          bytes: Buffer.byteLength(creationSource),
        },
      ],
    },
  };
  const originals = new Map<string, unknown>([
    [capture.result.brokerReceipt.jobId, original],
    [create.result.brokerReceipt.jobId, originalCreate],
  ]);
  const read = async (who: Owner, job: string): Promise<unknown> => {
    assert.equal(who.runId, owner.runId);
    assert.ok(originals.has(job), "Missing original receipt");
    return originals.get(job);
  };
  return {
    root,
    backend,
    user,
    document,
    directory,
    sourceFile,
    snapshot,
    capture,
    create,
    report,
    original,
    originalCreate,
    originals,
    entry,
    write,
    read,
  };
}

test("a newly created peer discovered after ancestry I/O also receives verified user ancestry", async (t) => {
  const f = ancestry(t);
  let newcomer: ReturnType<typeof ancestry> | undefined;
  const plan = await prepareCaptureView(
    f.root,
    f.backend,
    f.snapshot.documents,
    async (owner, job) => {
      if (job === f.capture.result.brokerReceipt.jobId && !newcomer)
        newcomer = ancestry(t, f.root, f.user);
      return owner.clientId === f.report.owner.clientId
        ? f.read(owner, job)
        : newcomer!.read(owner, job);
    },
  );
  assert.ok(newcomer);
  const newcomerId = newcomer.document.creationId;
  assert.equal(
    plan.peers.find((proof) => proof.document.creationId === newcomerId)?.state,
    "open",
  );
  assert.deepEqual(
    plan.roots[newcomerId],
    f.user,
    "Do not add a peer exemption without resolving its immutable camera ancestry",
  );
});

for (const fault of [
  "second-new-peer",
  "missing-original",
  "abort",
  "deadline",
] as const) {
  test(`fresh peer ancestry stabilization remains bounded and receipt-bound: ${fault}`, async (t) => {
    const first = ancestry(t),
      fixtures = [first],
      reads = new Map<string, number>(),
      cancellation = new AbortController();
    const execute = () =>
      prepareCaptureView(
        first.root,
        first.backend,
        first.snapshot.documents,
        async (owner, job) => {
          const f = fixtures.find(
            (f) => f.report.owner.clientId === owner.clientId,
          )!;
          reads.set(job, (reads.get(job) ?? 0) + 1);
          if (
            job === f.capture.result.brokerReceipt.jobId &&
            fixtures.length < (fault === "second-new-peer" ? 3 : 2)
          ) {
            fixtures.push(ancestry(t, first.root, first.user));
            if (fault === "abort")
              cancellation.abort(new Error("stop ancestry stabilization"));
          }
          if (fault === "missing-original" && f !== first)
            throw new Error("missing new peer original capture");
          return f.read(owner, job);
        },
        {
          signal: cancellation.signal,
          polling: {
            timeoutMs: fault === "deadline" ? 0 : 10000,
            intervalMs: 1,
          },
        },
      );
    if (fault === "abort" || fault === "deadline") {
      await assert.rejects(
        execute(),
        fault === "abort"
          ? /stop ancestry stabilization/u
          : /budget exhausted/u,
      );
    } else {
      const plan = await execute();
      for (const f of fixtures.slice(1)) {
        if (fault === "missing-original") {
          assert.equal(plan.roots[f.document.creationId], undefined);
          assert.ok(plan.blocked.includes(f.document.creationId));
        } else assert.deepEqual(plan.roots[f.document.creationId], first.user);
      }
    }
    assert.ok(
      [...reads.values()].every((count) => count === 1),
      "Immutable original receipts are cached, never re-executed or repeatedly queried during stabilization",
    );
  });
}

function savedAncestry(t: TestContext) {
  // Match the real saved producer's create:0 and canonical coordinator ancestry.
  const f = ancestry(t),
    requestId = f.report.owner.clientId + ":0";
  const identity = {
    ...f.document,
    activeCreationId: f.document.creationId,
    clientId: f.report.owner.clientId,
    requestId,
  };
  f.create.requestId = requestId;
  f.create.result.requestId = requestId;
  f.create.result.stdout = "FMCAD_SCENARIO " + JSON.stringify(identity) + "\n";
  f.create.result.brokerReceipt.requestId = requestId;
  f.create.result.brokerReceipt.operationResult.requestId = requestId;
  f.originalCreate.job.requestId = requestId;
  f.originalCreate.job.operationResult = structuredClone(
    f.create.result.brokerReceipt.operationResult,
  );
  f.originalCreate.stdout = f.create.result.stdout;
  const source = createProgram(
    f.document.name,
    path.join(f.directory, "creation.json"),
    { requestId, clientId: f.report.owner.clientId },
  );
  fs.writeFileSync(
    path.join(f.directory, "creation.json"),
    JSON.stringify(identity),
  );
  fs.writeFileSync(path.join(f.directory, "request-0.py"), source);
  f.originalCreate.provenance.inputs = [
    {
      kind: "source",
      originalPath: path.join(f.directory, "request-0.py"),
      sha256: createHash("sha256").update(source).digest("hex"),
      bytes: Buffer.byteLength(source),
    },
  ];
  const coordinator = legacyCoordinator(f);
  f.report.backendIdentity = f.backend.identity;
  f.report.cleanup = "pending";
  f.report.status = "running";
  f.write();
  const indexFile = path.join(path.dirname(f.directory), "index.json"),
    index = JSON.parse(fs.readFileSync(indexFile, "utf8")) as Record<
      string,
      unknown
    >;
  index["backendIdentity"] = f.backend.identity;
  fs.writeFileSync(indexFile, JSON.stringify(index));
  return { ...f, coordinatorJob: coordinator.original.job.id };
}

function inFlightSave(f: ReturnType<typeof ancestry>) {
  const file = {
    projectId: "owned-project",
    folderId: "owned-folder",
    fileId: "owned-file",
    version: 1,
  };
  const saved = { creationId: randomUUID(), name: f.document.name + " v0" };
  const intent = {
    ...f.document,
    projectId: file.projectId,
    folderId: file.folderId,
    clientId: f.report.owner.clientId,
    requestId: f.report.owner.clientId + ":2",
  };
  const accepted = {
    ...intent,
    accepted: true,
    postCreationId: saved.creationId,
    postName: saved.name,
  };
  f.report.requests.push(f.entry("save", 2, accepted));
  Object.assign(f.report, {
    document: saved,
    fixture: { projectId: file.projectId, folderId: file.folderId },
    savedIdentityTransition: {
      version: 1,
      originalCreationId: f.document.creationId,
      saveRequestId: intent.requestId,
      ...saved,
    },
  });
  fs.writeFileSync(
    path.join(f.directory, "save-intent.json"),
    JSON.stringify(intent),
  );
  fs.writeFileSync(
    path.join(f.directory, "save-transition.json"),
    JSON.stringify(accepted),
  );
  f.write();
  assert.equal(
    discoverOwnedUnsavedFixtureProofs(f.root, f.backend).get(
      f.document.creationId,
    )?.state,
    "unsettled",
  );
  return {
    saved,
    file,
    complete() {
      f.report.requests.push(
        f.entry("save-observe", 3, {
          ...saved,
          ...file,
          saved: true,
          complete: true,
        }),
      );
      Object.assign(f.report, { document: { ...saved, file } });
      f.write();
      assert.equal(
        discoverOwnedUnsavedFixtureProofs(f.root, f.backend).get(
          f.document.creationId,
        )?.state,
        "saved",
      );
    },
  };
}

test("capture inventory proofs refresh after asynchronous ancestry reads settle a peer close", async (t) => {
  const f = ancestry(t);
  let closed = false;
  const plan = await prepareCaptureView(
    f.root,
    f.backend,
    [
      ...f.snapshot.documents,
      { ...f.document, fileId: null, saved: false, modified: false },
    ],
    async (owner, jobId) => {
      if (jobId === f.capture.result.brokerReceipt.jobId && !closed) {
        closed = true;
        f.report.requests.push(
          f.entry("cleanup", 2, {
            creationId: f.document.creationId,
            closed: true,
          }),
        );
        f.report.status = "passed";
        f.report.cleanup = "complete";
        f.write();
      }
      return f.read(owner, jobId);
    },
  );
  assert.equal(closed, true);
  assert.deepEqual(
    plan.roots[f.document.creationId],
    f.user,
    "Immutable ancestry remains valid after a proved closure",
  );
  assert.equal(
    plan.peers.find(
      (proof) => proof.document.creationId === f.document.creationId,
    )?.state,
    "closed",
    "Do not dispatch a census frozen before the awaited receipt reads",
  );
});

test("capture preparation waits for an already accepted peer SaveAs without submitting SDK or granting an unsettled exemption", async (t) => {
  const f = savedAncestry(t),
    transfer = inFlightSave(f);
  let settled = false;
  const timer = setTimeout(() => {
    transfer.complete();
    settled = true;
  }, 50);
  t.after(() => clearTimeout(timer));
  const plan = await prepareCaptureView(
    f.root,
    f.backend,
    [
      ...f.snapshot.documents,
      { ...f.document, fileId: null, saved: false, modified: false },
    ],
    async (owner, job) => {
      assert.equal(
        settled,
        true,
        "Original ancestry preparation must not dispatch while its peer save remains unproved",
      );
      return f.read(owner, job);
    },
  );
  assert.equal(settled, true);
  assert.equal(
    plan.peers.find(
      (proof) => proof.document.creationId === f.document.creationId,
    )?.state,
    "saved",
  );
  assert.deepEqual(plan.roots[f.document.creationId], f.user);
  assert.deepEqual(
    plan.roots[transfer.saved.creationId],
    f.user,
    "Only the newly verified transfer supplies the saved alias ancestry",
  );
});

test("a SaveAs settling during original ancestry I/O supplies a fresh verified saved alias", async (t) => {
  const f = savedAncestry(t);
  let saved: ReturnType<typeof inFlightSave> | undefined;
  const plan = await prepareCaptureView(
    f.root,
    f.backend,
    [
      ...f.snapshot.documents,
      { ...f.document, fileId: null, saved: false, modified: false },
    ],
    async (owner, job) => {
      if (job === f.coordinatorJob) {
        saved = inFlightSave(f);
        saved.complete();
      }
      return f.read(owner, job);
    },
  );
  assert.ok(saved);
  assert.equal(
    plan.peers.find(
      (proof) => proof.document.creationId === f.document.creationId,
    )?.state,
    "saved",
  );
  assert.deepEqual(plan.roots[saved.saved.creationId], f.user);
  assert.equal(plan.blocked.includes(saved.saved.creationId), false);
});

for (const fault of [
  "hold",
  "dead-owner",
  "abort",
  "abort-during-wait",
  "timeout",
  "failed-original",
  "missing-intent",
] as const) {
  test(`pending peer SaveAs ${fault} fails closed before capture dispatch`, async (t) => {
    const f = savedAncestry(t);
    inFlightSave(f);
    if (fault === "hold") {
      Object.assign(f.report, {
        cleanupHold: {
          requestId: f.report.owner.clientId + ":2",
          reason: "preserved",
        },
      });
      f.write();
    }
    if (fault === "dead-owner") {
      const file = path.join(path.dirname(f.directory), "index.json"),
        index = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
          string,
          unknown
        >;
      index["processIdentity"] = {
        pid: process.pid,
        birth: "not-the-current-process-birth",
      };
      fs.writeFileSync(file, JSON.stringify(index));
    }
    if (fault === "failed-original") {
      f.report.requests.find((entry) => entry.phase === "save")!.result.state =
        "failed";
      f.write();
    }
    if (fault === "missing-intent")
      fs.unlinkSync(path.join(f.directory, "save-intent.json"));
    const controller = new AbortController();
    if (fault === "abort")
      controller.abort(new Error("capture preparation aborted"));
    const abortTimer =
      fault === "abort-during-wait"
        ? setTimeout(
            () =>
              controller.abort(
                new Error("capture preparation aborted during wait"),
              ),
            1,
          )
        : undefined;
    t.after(() => clearTimeout(abortTimer));
    let originalReads = 0;
    await assert.rejects(
      prepareCaptureView(
        f.root,
        f.backend,
        [
          ...f.snapshot.documents,
          { ...f.document, fileId: null, saved: false, modified: false },
        ],
        async (owner, job) => {
          originalReads++;
          return f.read(owner, job);
        },
        {
          signal: controller.signal,
          polling: { timeoutMs: 10, intervalMs: 1 },
        },
      ),
    );
    assert.equal(
      originalReads,
      0,
      "An unresolved save never reaches SDK capture or original camera ancestry reads",
    );
  });
}

test("ancestry I/O consumes the existing preparation budget instead of resetting it before the final census", async (t) => {
  const f = savedAncestry(t);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await assert.rejects(
      prepareCaptureView(
        f.root,
        f.backend,
        [
          ...f.snapshot.documents,
          { ...f.document, fileId: null, saved: false, modified: false },
        ],
        async (owner, job) => {
          if (job === f.coordinatorJob) {
            const transfer = inFlightSave(f);
            timer = setTimeout(() => transfer.complete(), 30);
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          return f.read(owner, job);
        },
        { polling: { timeoutMs: 10, intervalMs: 1 } },
      ),
      /Original cloud operation is not observed complete/u,
    );
  } finally {
    clearTimeout(timer);
  }
});

test("camera ancestry is source-bound and does not grant held lifecycle rights", async (t) => {
  const f = ancestry(t);
  f.report.cleanup = "deferred";
  f.report.status = "failed";
  f.write();
  const plan = await prepareCaptureView(
    f.root,
    f.backend,
    f.snapshot.documents,
    f.read,
  );
  assert.deepEqual(plan.roots[f.document.creationId], f.user);
  assert.deepEqual(plan.blocked, []);
  assert.equal(plan.peers[0]?.state, "unsettled");
  assert.equal(
    plan.ancestry?.[f.document.creationId]?.[0]?.["requestId"],
    f.capture.requestId,
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(f.directory, "report.json"), "utf8")),
    f.report,
    "read-only ancestry must not settle or rewrite a held case",
  );
});

test("camera ancestry follows exact peer captures to a user identity without a name fallback", async (t) => {
  const first = ancestry(t);
  const second = ancestry(t, first.root, { ...first.document, fileId: null });
  const plan = await prepareCaptureView(
    first.root,
    first.backend,
    first.snapshot.documents,
    async (owner, job) =>
      owner.clientId === first.report.owner.clientId
        ? first.read(owner, job)
        : second.read(owner, job),
  );
  assert.deepEqual(plan.roots[second.document.creationId], first.user);
  assert.equal(plan.ancestry?.[second.document.creationId]?.length, 2);
});

test("tampered creation output with an alias cannot select a user document", async (t) => {
  const first = ancestry(t);
  const alias = randomUUID();
  const second = ancestry(t, first.root, {
    ...first.document,
    creationId: alias,
    fileId: null,
  });
  first.create.result.stdout += `doc-id mismatch for document arbitrary: expected ${first.document.creationId}, got ${alias}\n`;
  first.write();
  const plan = await prepareCaptureView(
    first.root,
    first.backend,
    first.snapshot.documents,
    async (owner, job) =>
      owner.runId === first.report.owner.runId
        ? first.read(owner, job)
        : second.read(owner, job),
  );
  assert.equal(plan.roots[second.document.creationId], undefined);
  assert.ok(plan.blocked.includes(second.document.creationId));
  assert.ok(plan.blocked.includes(alias));
});

test("a failed historical saved alias cannot masquerade as a user document", async (t) => {
  const first = ancestry(t),
    alias = randomUUID();
  const second = ancestry(t, first.root, {
    ...first.document,
    creationId: alias,
    fileId: null,
  });
  const failed = structuredClone(first.capture);
  failed.phase = "save-observe";
  failed.result.stdout = `doc-id mismatch for document arbitrary: expected ${first.document.creationId}, got ${alias}\n`;
  failed.result.state = "failed";
  first.report.requests.push(failed);
  first.write();
  const plan = await prepareCaptureView(
    first.root,
    first.backend,
    first.snapshot.documents,
    async (owner, job) =>
      owner.runId === first.report.owner.runId
        ? first.read(owner, job)
        : second.read(owner, job),
  );
  assert.equal(plan.roots[second.document.creationId], undefined);
  assert.ok(plan.blocked.includes(second.document.creationId));
  assert.match(
    plan.blockedReasons?.[second.document.creationId] ?? "",
    /alias lacks an exact saved identity transfer|Missing original verified peer identity proof/u,
  );
});

test("cyclic authoritative captures cannot select a user camera", async (t) => {
  const first = ancestry(t);
  const second = ancestry(t, first.root, { ...first.document, fileId: null });
  first.snapshot.active = { ...second.document, fileId: null };
  first.snapshot.camera.document = { ...second.document, dataFileId: null };
  first.capture.result.stdout =
    "FMCAD_SCENARIO " + JSON.stringify(first.snapshot);
  first.original.stdout = first.capture.result.stdout;
  first.write();
  const plan = await prepareCaptureView(
    first.root,
    first.backend,
    first.snapshot.documents,
    async (owner, job) =>
      owner.clientId === first.report.owner.clientId
        ? first.read(owner, job)
        : second.read(owner, job),
  );
  assert.equal(plan.roots[first.document.creationId], undefined);
  assert.equal(plan.roots[second.document.creationId], undefined);
  assert.match(
    plan.blockedReasons?.[second.document.creationId] || "",
    /Cyclic/u,
  );
});

function legacyCoordinator(f: ReturnType<typeof ancestry>) {
  const backendIdentity = "older-qualified-runtime";
  f.report.backendIdentity = backendIdentity;
  f.report.requests = [f.create];
  f.report.cleanup = "deferred";
  const indexFile = path.join(path.dirname(f.directory), "index.json");
  const index = JSON.parse(fs.readFileSync(indexFile, "utf8")) as Record<
    string,
    unknown
  >;
  index["backendIdentity"] = backendIdentity;
  fs.writeFileSync(indexFile, JSON.stringify(index));
  f.write();
  const directory = path.join(path.dirname(f.directory), "_coordinator");
  fs.mkdirSync(directory);
  const owner = {
      ...f.report.owner,
      scenarioId: "coordinator",
      clientId: `scenario:${f.report.owner.runId}:coordinator`,
    },
    requestId = owner.clientId + ":before";
  const entry = structuredClone(f.capture);
  entry.phase = "before";
  entry.requestId = requestId;
  entry.result.requestId = requestId;
  const receipt = entry.result.brokerReceipt;
  receipt.requestId = requestId;
  receipt.clientId = owner.clientId;
  receipt.jobId = randomUUID();
  receipt.operationResult.requestId = requestId;
  receipt.operationResult.jobId = receipt.jobId;
  entry.result.stdout =
    "FMCAD_SCENARIO " +
    JSON.stringify({
      documents: f.snapshot.documents,
      active: f.user.creationId,
    });
  fs.writeFileSync(
    path.join(directory, "before.intent.json"),
    JSON.stringify({ phase: "before", requestId }),
  );
  fs.writeFileSync(
    path.join(directory, "before.result.json"),
    JSON.stringify(entry.result),
  );
  const source = inventorySnapshot(),
    sourceFile = path.join(directory, "request-before.py");
  fs.writeFileSync(sourceFile, source);
  const original = structuredClone(f.original);
  original.job = {
    ...original.job,
    id: receipt.jobId,
    requestId,
    clientId: owner.clientId,
    operationResult: structuredClone(receipt.operationResult),
  };
  original.stdout = entry.result.stdout;
  original.provenance.inputs = [
    {
      kind: "source",
      originalPath: sourceFile,
      sha256: createHash("sha256").update(source).digest("hex"),
      bytes: Buffer.byteLength(source),
    },
  ];
  f.originals.set(receipt.jobId, original);
  return { directory, entry, original, sourceFile };
}

test("a legacy peer uses original coordinator capture only for user identity, never as a camera or lifecycle exemption", async (t) => {
  const f = ancestry(t);
  legacyCoordinator(f);
  const baseline = [
    ...f.snapshot.documents,
    { ...f.document, fileId: null, saved: false, modified: false },
  ];
  const plan = await prepareCaptureView(f.root, f.backend, baseline, f.read);
  assert.deepEqual(plan.roots[f.document.creationId], f.user);
  assert.deepEqual(
    plan.peers,
    [],
    "Cross-backend ancestry grants no inventory exemption",
  );
  assert.match(
    String(plan.ancestry?.[f.document.creationId]?.[0]?.["requestId"]),
    /:coordinator:before$/u,
  );
});

for (const fault of [
  "missing",
  "source",
  "owner",
  "unknown",
  "late",
  "adopted",
  "intent",
] as const) {
  test(`legacy coordinator identity ancestry rejects ${fault}`, async (t) => {
    const f = ancestry(t),
      c = legacyCoordinator(f);
    if (fault === "missing")
      fs.unlinkSync(path.join(c.directory, "before.result.json"));
    if (fault === "source") fs.appendFileSync(c.sourceFile, "\n# tamper\n");
    if (fault === "owner") c.original.job.clientId = "foreign";
    if (fault === "unknown") c.original.execution.sdkSettled = false;
    if (fault === "late") c.original.job.finishedAt = 500;
    if (fault === "intent")
      fs.writeFileSync(
        path.join(c.directory, "before.intent.json"),
        JSON.stringify({ requestId: "foreign:before", phase: "before" }),
      );
    if (fault === "adopted") {
      c.entry.result.stdout =
        "FMCAD_SCENARIO " +
        JSON.stringify({
          active: f.user.creationId,
          documents: [
            ...f.snapshot.documents,
            { ...f.document, saved: false, modified: false, fileId: null },
          ],
        });
      fs.writeFileSync(
        path.join(c.directory, "before.result.json"),
        JSON.stringify(c.entry.result),
      );
      c.original.stdout = c.entry.result.stdout;
    }
    const plan = await prepareCaptureView(
      f.root,
      f.backend,
      [
        ...f.snapshot.documents,
        { ...f.document, saved: false, modified: false, fileId: null },
      ],
      f.read,
    );
    assert.equal(plan.roots[f.document.creationId], undefined);
    assert.ok(
      plan.blocked.includes(f.document.creationId),
      "An older peer must not masquerade as a user document",
    );
  });
}

for (const fault of [
  "source",
  "source-link",
  "missing-source",
  "report-output",
  "unknown",
  "foreign-client",
  "foreign-job",
  "foreign-request",
  "outcome",
  "creation",
  "missing-capture",
  "duplicate-capture",
  "camera-identity",
  "noncanonical-source",
  "plan-tamper",
] as const) {
  test(`camera ancestry rejects ${fault} without choosing a user document by name`, async (t) => {
    const f = ancestry(t);
    if (fault === "source") fs.appendFileSync(f.sourceFile, "\n# changed\n");
    if (fault === "source-link") {
      fs.unlinkSync(f.sourceFile);
      fs.symlinkSync(path.join(f.directory, "creation.json"), f.sourceFile);
    }
    if (fault === "missing-source") fs.unlinkSync(f.sourceFile);
    if (fault === "report-output") f.capture.result.stdout += "tampered";
    if (fault === "unknown") f.original.execution.sdkSettled = false;
    if (fault === "foreign-client") f.original.job.clientId = "foreign";
    if (fault === "foreign-job") f.original.job.id = randomUUID();
    if (fault === "foreign-request") f.original.job.requestId = "foreign:0";
    if (fault === "outcome")
      f.original.job.operationResult.executionOutcome = "not_started";
    if (fault === "creation")
      fs.writeFileSync(
        path.join(f.directory, "creation.json"),
        JSON.stringify({ ...f.document, requestId: "foreign:1" }),
      );
    if (fault === "missing-capture") f.report.requests = [f.create];
    if (fault === "duplicate-capture")
      f.report.requests.push(structuredClone(f.capture));
    if (fault === "camera-identity") {
      const snapshot = structuredClone(f.snapshot);
      snapshot.camera.document.creationId = "foreign";
      f.capture.result.stdout = "FMCAD_SCENARIO " + JSON.stringify(snapshot);
      f.original.stdout = f.capture.result.stdout;
    }
    if (fault === "noncanonical-source") {
      fs.writeFileSync(f.sourceFile, "def run(context):\n    pass\n");
      f.original.provenance.inputs[0]!.sha256 = createHash("sha256")
        .update(fs.readFileSync(f.sourceFile))
        .digest("hex");
      f.original.provenance.inputs[0]!.bytes = fs.statSync(f.sourceFile).size;
    }
    if (fault === "plan-tamper")
      fs.writeFileSync(
        path.join(f.directory, "view-capture-plan.json"),
        JSON.stringify({ baseline: [], peers: [], roots: {}, blocked: [] }),
      );
    f.write();
    const plan = await prepareCaptureView(
      f.root,
      f.backend,
      f.snapshot.documents,
      f.read,
    );
    assert.ok(
      plan.blocked.includes(f.document.creationId),
      JSON.stringify(plan),
    );
    assert.equal(plan.roots[f.document.creationId], undefined);
    assert.ok(
      plan.blockedReasons?.[f.document.creationId] ||
        fault === "creation" ||
        fault === "duplicate-capture",
    );
  });
}

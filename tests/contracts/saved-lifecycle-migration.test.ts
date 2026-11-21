import type {
  SavedFixtureHost,
  SavedEpoch,
  SavedJob,
  SavedPorts,
  SavedMessage,
  EvidenceRef,
  FirstSaveReply,
  ObservedDocument,
} from "../../packages/core/src/application/cad/saved-fixture-contracts";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
const root = process.cwd();
const localRequire = createRequire(
  path.join(root, "src/queue-saved-runtime.js"),
);
const records = localRequire(
  "./dist/node-adapters/persistence/records",
) as typeof import("../../packages/node-adapters/src/persistence/records");
const proof = localRequire(
  "./queue-saved-fixture-reader",
) as typeof import("../../packages/core/src/application/cad/saved-fixture-proof");
const auditPath = localRequire(
  "./queue-saved-audit-path",
) as typeof import("../../packages/node-adapters/src/persistence/saved-audit-path");
const { hash: digest } = localRequire(
  "./dist/core/application/cad/json",
) as typeof import("../../packages/core/src/application/cad/json");
const { createSavedFixtureLifecycle } = localRequire(
  "./dist/node-adapters/persistence/saved-fixture-lifecycle",
) as typeof import("../../packages/node-adapters/src/persistence/saved-fixture-lifecycle");
type Api = ReturnType<typeof createSavedFixtureLifecycle>;
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const reference = (file: string): EvidenceRef => ({
  path: file,
  sha256: hash(fs.readFileSync(file)),
});
const familyNames = [
  "admin-evidence",
  "destination-approval",
  "first-save-evidence",
  "first-save",
  "fixture-control",
  "native-destination",
  "readiness-evidence",
];

function fixture(t: import("node:test").TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "saved-paired-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const epoch: SavedEpoch = {
    root: path.join(directory, "epochs", "epoch"),
    epochId: "epoch",
    kind: "isolated-fresh-scratch-epoch",
    ownerClientId: "owner",
    ownerTokenHash: "a".repeat(64),
    document: { name: "OWNED", creationId: "doc", fileId: null },
    currentInstance: { pid: 123, birth: "synthetic", version: "fixture" },
    originalInstance: { pid: 122, birth: "old", version: "fixture" },
    qualificationReceipt: {
      path: path.join(directory, "creation.json"),
      sha256: "",
    },
  };
  fs.mkdirSync(epoch.root, { recursive: true });
  const write = (name: string, value: unknown) => {
    const file = path.join(directory, name + ".json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
    return reference(file);
  };
  const read = <T>(file: string) => records.readJson(file) as T;
  const log: string[] = [];
  const host: SavedFixtureHost = {
    hash,
    digest,
    buildHash: () => "b".repeat(64),
    sameInstance: (a, b) =>
      !!a &&
      !!b &&
      a.pid === b.pid &&
      a.birth === b.birth &&
      a.version === b.version,
    priorProcessAlive: () => false, // Synthetic terminated worker; never a physical-process claim.
    fileHash: (file) => ({ sha256: reference(file).sha256 }),
    exclusive: (file, value) => {
      log.push("exclusive:" + path.basename(file));
      fs.writeFileSync(file, JSON.stringify(value), { flag: "wx" });
    },
    epochControlDirectory: () => path.join(directory, "control"),
    parseSavedFixtureReader: proof.parseSavedFixtureReader,
    prepareSavedFixtureReader: () => {
      throw new Error("Unexpected native preparation in policy fixture");
    },
    settledEpochEvidence: () => {
      log.push("settled");
      return [];
    },
    responsePath: (_root, job, name) =>
      path.join(directory, "jobs", job.id, name),
    decodeInvocation: (value) =>
      value as import("../../packages/core/src/application/cad/saved-fixture-contracts").Invocation,
    policyArguments: (value) => [
      "cad",
      value.operation,
      JSON.stringify(value.data),
    ],
    createRecoveryAudit: () => {
      throw new Error("Unexpected SDK audit in refusal/replay fixture");
    },
    verifyScratchSdkProof: () => {
      throw new Error("Unexpected SDK receipt in refusal/replay fixture");
    },
  };
  const historical = new Map<string, Record<string, unknown>>();
  const load = (family: string): Record<string, unknown> => {
    const prior = historical.get(family);
    if (prior) return prior;
    const name = "queue-saved-" + family + "-330849f.js.txt";
    const source = fs.readFileSync(
      path.join(root, "tests/fixtures/history", name),
      "utf8",
    );
    const manifests = JSON.parse(
      fs.readFileSync(
        path.join(root, "tests/fixtures/history/manifest.json"),
        "utf8",
      ),
    ) as { file: string; sha256: string }[];
    assert.equal(
      hash(source),
      manifests.find((row) => row.file === name)?.sha256,
      name,
    );
    const module = { exports: {} as Record<string, unknown> };
    historical.set(family, module.exports);
    const require = (id: string): unknown => {
      const dependency = id.replace("./queue-saved-", "");
      if (familyNames.includes(dependency)) return load(dependency);
      if (id === "./queue-instance") return { ...records, ...host };
      if (id === "./queue-atomic-migration-files") return host;
      if (id === "./queue-epoch-lineage") return host;
      if (id === "./queue-settled-epoch-evidence") return host;
      if (id === "./queue-response-files") return host;
      if (id === "./cad-service") return host;
      if (id === "./queue-atomic-recovery-audit") return host;
      if (id === "./queue-scratch-control") return host;
      if (id === "./queue-saved-fixture-reader")
        return {
          ...proof,
          prepareSavedFixtureReader: host.prepareSavedFixtureReader,
        };
      return localRequire(id) as unknown;
    };
    const run = vm.runInThisContext(
      "(function(module, require) {" + source + "\n})",
    ) as (
      module: { exports: Record<string, unknown> },
      require: (id: string) => unknown,
    ) => void;
    run(module, require);
    historical.set(family, module.exports);
    return module.exports;
  };
  const before = Object.assign({}, ...familyNames.map(load)) as Api;
  const after = createSavedFixtureLifecycle(host);
  const sourceIdentity = {
    buildHash: host.buildHash(),
    sourceCommit: "c".repeat(40),
  };
  write("epochs/epoch/instance", sourceIdentity);
  write("creation", {
    status: "complete",
    summary: {
      independent: true,
      empty: true,
      unsaved: true,
      document: epoch.document,
    },
  });
  const authority = {
    version: 1,
    purpose: "new-saved-native-fixtures-in-user-confirmed-private-project",
    ownerClientId: "owner",
    privacyEvidence:
      "explicit user confirmation in current conversation; not inferred from membership",
    projectName: "PRIVATE",
    projectId: "urn:adsk.workspace:project",
    projectUrl: "https://example.test/project",
    hubId: "hub",
    region: "US",
    folderName: "FMCAD_NATIVE_20261105_123456ab",
    scope:
      "one separate new folder and only new qualification files; retain for user inspection; no existing-data or permission changes",
  };
  const authorityRef = write("authority", authority),
    folderId = "urn:adsk.wipprod:fs.folder:new";
  const folderProof = {
    version: 1,
    status: "new-authorized-folder-created-once-and-read-back",
    projectName: authority.projectName,
    projectId: authority.projectId,
    folderName: authority.folderName,
    folderId,
    dataFilesCreated: 0,
    retention:
      "Keep new qualification files for user inspection; no deletion or existing-data/permission changes.",
    authority: authorityRef,
    creationIntent: write("folder-intent", {
      operation: "fusion_data.create_folder",
      project_name: authority.projectName,
      project_url: authority.projectUrl,
      hub_id: authority.hubId,
      region: authority.region,
      folder_name: authority.folderName,
    }),
    creationResult: write("folder-result", {
      success: true,
      project_name: authority.projectName,
      folder_id: folderId,
    }),
    readback: write("folder-readback", {
      success: true,
      tool: "fusion_data.search_by_hub",
      query: authority.folderName,
      matches: [
        {
          type: "Folder",
          id: folderId,
          name: authority.folderName,
          projectName: authority.projectName,
        },
      ],
    }),
  };
  const proofRef = write("folder-proof", folderProof);
  const approved = after.savedDestinationApproval(
    authorityRef.path,
    proofRef.path,
    "owner",
  );
  const payload = {
    kind: "cad",
    operation: "document.status",
    doc: epoch.document.name,
    docId: epoch.document.creationId,
    data: {},
  };
  const job: SavedJob = {
    id: "11111111-1111-1111-1111-111111111111",
    clientId: "owner",
    requestId: "ready",
    kind: "command",
    state: "succeeded",
    request: {
      kind: "command",
      clientId: "owner",
      requestId: "ready",
      ownerToken: epoch.ownerTokenHash,
      payload,
      argv: host.policyArguments(payload),
    },
    details: { sdkSettled: true },
    dispatch: { rpcCount: 1, completedCount: 1 },
  };
  const jobs = { [job.id]: job };
  write("epochs/epoch/queue-state", { jobs });
  const stdout = path.join(directory, "jobs", job.id, "stdout.txt");
  fs.mkdirSync(path.dirname(stdout), { recursive: true });
  fs.writeFileSync(
    stdout,
    JSON.stringify({
      success: true,
      operation: "document.status",
      result: { ...epoch.document, saved: false, modified: false },
    }),
  );
  const destination = {
    projectName: authority.projectName,
    nativeProjectId: "native-project",
    nativeHubId: "native-hub",
    nativeHubName: "FAKE",
    folderName: authority.folderName,
    folderId,
  };
  const requestId = "destination-read",
    kind = auditPath.savedAuditKind("dp-", requestId),
    adminDir = path.join(directory, "control", kind);
  fs.mkdirSync(adminDir, { recursive: true });
  const binding = {
    purpose: "saved-fixture-destination-v1",
    epochId: epoch.epochId,
    document: epoch.document,
    currentInstance: epoch.currentInstance,
    historicalInstance: epoch.originalInstance,
    clientId: "owner",
    ownerTokenHash: epoch.ownerTokenHash,
    readinessJobId: job.id,
    ...sourceIdentity,
    destination: approved,
    sdkProofPath: path.join(adminDir, "sdk-destination.json"),
    before: {},
  };
  const summary = {
    version: 1,
    purpose: binding.purpose,
    epochId: epoch.epochId,
    bindingHash: digest(binding),
    document: epoch.document,
    destination,
    readOnly: true,
  };
  const rpcId = "22222222-2222-2222-2222-222222222222",
    sourceArtifactHash = "d".repeat(64);
  const wireBinding = {
    jobId: job.id,
    rpcId,
    buildHash: sourceIdentity.buildHash,
    purpose: binding.purpose,
    auditBindingHash: digest(binding),
    pythonOriginHash: sourceArtifactHash,
    auditExpectedInstance: epoch.currentInstance,
  };
  const putAdmin = (name: string, value: unknown) => {
    const file = path.join(adminDir, name);
    fs.writeFileSync(file, JSON.stringify(value));
    return reference(file);
  };
  const remotePath = path.join(adminDir, "remote-" + rpcId + ".json");
  const evidence = [
    putAdmin("intent.json", { binding, sourceArtifactHash }),
    putAdmin("start.json", {
      binding: wireBinding,
      receipt: remotePath,
      pythonCheck: { status: "passed" },
    }),
    putAdmin("wire.json", {}),
    putAdmin("sdk-destination.json", summary),
    putAdmin(path.basename(remotePath), {
      ...wireBinding,
      terminal: true,
      outcome: "succeeded",
      instance: epoch.currentInstance,
    }),
  ];
  const receipt = putAdmin("result.json", {
    requestId,
    kind,
    status: "complete",
    sdkRequestsSent: 1,
    endpointVerified: true,
    clientId: "owner",
    jobId: job.id,
    nativeOutcome: "unknown",
    modelValidation: "not_performed",
    rollbackVerification: "not_performed",
    summary,
  });
  const nativeRecord = {
    version: 1,
    kind: "owner-verified-native-saved-destination",
    epochId: epoch.epochId,
    ownerClientId: "owner",
    ownerTokenHash: epoch.ownerTokenHash,
    originDocument: epoch.document,
    approvedDestination: approved,
    ...sourceIdentity,
    readinessEvidence: [reference(stdout)],
    readinessJobId: job.id,
    readinessJobs: jobs,
    receipt,
    qualificationEvidence: evidence,
    destination,
  };
  write("epochs/epoch/saved-destination-native", nativeRecord);
  const clients = { owner: epoch.ownerTokenHash, native: "e".repeat(64) };
  const ports: SavedPorts = {
    dir: directory,
    buildHash: sourceIdentity.buildHash,
    state: { epoch, data: { jobs }, assertEpoch() {} },
    clients: () => clients,
    assertControl() {},
    fence() {},
    snapshot: () => ({}),
    closed() {},
    auditPorts: {},
  };
  const message: SavedMessage = {
    action: "grant-saved-first-save",
    epochId: epoch.epochId,
    grantClientId: "native",
    requestId: "grant",
    saveRequestId: "save",
    authorityFile: authorityRef.path,
    folderProofFile: proofRef.path,
    jobId: job.id,
  };
  return {
    directory,
    epoch,
    write,
    read,
    log,
    host,
    before,
    after,
    sourceIdentity,
    authority,
    folderProof,
    authorityRef,
    proofRef,
    approved,
    job,
    jobs,
    stdout,
    destination,
    binding,
    summary,
    adminDir,
    evidence,
    receipt,
    nativeRecord,
    ports,
    message,
  };
}

function result(action: () => unknown) {
  try {
    return { value: action() };
  } catch (error) {
    const e = error as Error & { code?: string };
    return { error: e.message, code: e.code };
  }
}

test("saved lifecycle preserves exact owner approval, readiness and administrative evidence", (t) => {
  const f = fixture(t);
  for (const api of [f.before, f.after]) {
    assert.deepEqual(
      api.savedDestinationApproval(
        f.authorityRef.path,
        f.proofRef.path,
        "owner",
      ),
      f.approved,
    );
    assert.equal(
      api.savedReadinessEvidence(f.directory, f.epoch, f.job.id).job.id,
      f.job.id,
    );
    assert.deepEqual(
      api.readSavedNativeDestination(f.directory, f.epoch, f.approved)
        .nativeProjectId,
      "native-project",
    );
  }
  for (const owner of ["", "foreign"])
    assert.deepEqual(
      result(() =>
        f.after.savedDestinationApproval(
          f.authorityRef.path,
          f.proofRef.path,
          owner,
        ),
      ),
      result(() =>
        f.before.savedDestinationApproval(
          f.authorityRef.path,
          f.proofRef.path,
          owner,
        ),
      ),
    );
  const wrong = { ...f.jobs, [f.job.id]: { ...f.job, clientId: "foreign" } };
  assert.deepEqual(
    result(() =>
      f.after.savedReadinessEvidence(f.directory, f.epoch, f.job.id, wrong),
    ),
    result(() =>
      f.before.savedReadinessEvidence(f.directory, f.epoch, f.job.id, wrong),
    ),
  );
  fs.appendFileSync(path.join(f.adminDir, "sdk-destination.json"), "\n");
  const before = result(() =>
    f.before.readSavedNativeDestination(f.directory, f.epoch, f.approved),
  );
  assert.equal(before.code, "SAVED_ADMIN_EVIDENCE_REQUIRED");
  assert.deepEqual(
    result(() =>
      f.after.readSavedNativeDestination(f.directory, f.epoch, f.approved),
    ),
    before,
  );
});

test("first save grant and admission preserve exact scope and receipt-only replay", (t) => {
  const f = fixture(t);
  delete (f.message as Partial<SavedMessage>).jobId;
  const grant = f.before.grantSavedFirstSave(f.ports, f.message, "owner");
  const writes = f.log.filter((row) => row.startsWith("exclusive:")).length;
  assert.equal(writes, 2);
  assert.deepEqual(
    f.after.grantSavedFirstSave(f.ports, f.message, "owner"),
    grant,
  );
  assert.equal(
    f.log.filter((row) => row.startsWith("exclusive:")).length,
    writes,
  );
  const payload = {
    kind: "cad",
    operation: "document.save_as",
    doc: f.epoch.document.name,
    docId: f.epoch.document.creationId,
    data: {
      name: f.epoch.document.name,
      project: f.approved.projectName,
      folder: f.approved.folderName,
      expectedProjectId: "native-project",
      expectedFolderId: f.approved.folderId,
      confirm: true,
    },
  };
  const request = {
    ...f.job.request,
    clientId: "native",
    requestId: "save",
    ownerToken: "e".repeat(64),
    payload,
    argv: f.host.policyArguments(payload),
  };
  assert.deepEqual(
    f.after.firstSaveAdmission(f.epoch, request, grant, f.sourceIdentity),
    f.before.firstSaveAdmission(f.epoch, request, grant, f.sourceIdentity),
  );
  for (const changed of [
    { ...request, requestId: "other" },
    { ...request, phased: true },
    { ...request, payload: { ...payload, docId: "foreign" } },
  ]) {
    const before = result(() =>
      f.before.firstSaveAdmission(f.epoch, changed, grant, f.sourceIdentity),
    );
    assert.equal(before.code, "SAVED_FIRST_SAVE_SCOPE_REQUIRED");
    assert.deepEqual(
      result(() =>
        f.after.firstSaveAdmission(f.epoch, changed, grant, f.sourceIdentity),
      ),
      before,
    );
  }
});

test("pure first publication preserves processing, exact lineage, missing readback and version drift", (t) => {
  const f = fixture(t);
  delete (f.message as Partial<SavedMessage>).jobId;
  const grant = f.after.grantSavedFirstSave(f.ports, f.message, "owner");
  const observed: ObservedDocument = {
    creationId: "doc",
    name: "OWNED",
    fileId: "new-file",
    saved: true,
    modified: false,
    fileName: "OWNED",
    projectId: "native-project",
    folderId: f.approved.folderId,
    version: 1,
    isComplete: true,
  };
  const reply: FirstSaveReply = {
    accepted: true,
    status: "pending",
    pending: true,
    targetObserved: true,
    copyRequested: false,
    original: { ...f.epoch.document, saved: false, modified: false },
    current: observed,
    target: {
      name: "OWNED",
      projectName: f.approved.projectName,
      folder: f.approved.folderName,
      folderId: f.approved.folderId,
      projectId: "native-project",
    },
  };
  for (const observation of [
    null,
    observed,
    { ...observed, isComplete: false },
    { ...observed, dataFileError: "offline" },
    { ...observed, fileId: null, saved: false },
    { ...observed, fileId: "foreign" },
    { ...observed, version: 2 },
  ]) {
    assert.deepEqual(
      result(() => f.after.firstSavePublication(grant, reply, observation)),
      result(() => f.before.firstSavePublication(grant, reply, observation)),
    );
  }
  for (const accepted of [null, { ...reply, accepted: false }])
    assert.deepEqual(
      f.after.firstSavePublication(grant, accepted, null),
      f.before.firstSavePublication(grant, accepted, null),
    );
  assert.equal(
    f.after.firstSavePublication(grant, reply, observed).status,
    "complete",
  );
});

test("saved controller preserves owner refusal and legacy result replay without another SDK attempt", async (t) => {
  const f = fixture(t),
    requestId = "original-observation";
  const message = {
    action: "observe-saved-first-save",
    epochId: "epoch",
    jobId: f.job.id,
    requestId,
  } as SavedMessage;
  const kind = auditPath.savedAuditLegacyKind("sp-", requestId),
    directory = path.join(f.directory, "control", kind);
  fs.mkdirSync(directory, { recursive: true });
  const key = { jobId: message.jobId, requestId, clientId: "owner" };
  fs.writeFileSync(
    path.join(directory, "intent.json"),
    JSON.stringify({
      key,
      binding: {
        epochId: "epoch",
        ownerTokenHash: f.epoch.ownerTokenHash,
        document: f.epoch.document,
      },
    }),
  );
  fs.writeFileSync(
    path.join(directory, "result.json"),
    JSON.stringify({ kind, ...key, status: "complete" }),
  );
  for (const client of ["owner", "foreign"]) {
    assert.deepEqual(
      result(() =>
        f.after.createSavedFixtureControl(f.ports).observe(message, client),
      ),
      result(() =>
        f.before.createSavedFixtureControl(f.ports).observe(message, client),
      ),
    );
  }
  const calls: unknown[] = [];
  const client = {
    async call(action: string, values?: unknown): Promise<unknown> {
      calls.push([action, values]);
      return action === "queue-summary"
        ? {
            features: { savedFirstSaveLifecycle: true },
            control: {
              buildHash: "build",
              instanceId: "broker",
              generation: 2,
              contextEpoch: 3,
            },
          }
        : { submitted: true };
    },
  };
  await f.before.savedFixtureAction(
    client,
    "retain-saved-fixture",
    { requestId: "one" },
    "build",
  );
  const old = calls.splice(0);
  await f.after.savedFixtureAction(
    client,
    "retain-saved-fixture",
    { requestId: "one" },
    "build",
  );
  assert.deepEqual(calls, old);
});

test("first save evidence and separate publication preserve complete original ledger and native receipt binding", (t) => {
  const f = fixture(t);
  delete (f.message as Partial<SavedMessage>).jobId;
  const grant = f.after.grantSavedFirstSave(f.ports, f.message, "owner");
  const payload = {
    kind: "cad",
    operation: "document.save_as",
    doc: f.epoch.document.name,
    docId: f.epoch.document.creationId,
    data: {
      name: "OWNED",
      project: f.approved.projectName,
      folder: f.approved.folderName,
      expectedProjectId: "native-project",
      expectedFolderId: f.approved.folderId,
      confirm: true,
    },
  };
  const job: SavedJob = {
    ...f.job,
    id: "33333333-3333-3333-3333-333333333333",
    clientId: "native",
    requestId: "save",
    request: {
      kind: "command",
      clientId: "native",
      requestId: "save",
      ownerToken: grant.clientTokenHash,
      payload,
      argv: f.host.policyArguments(payload),
    },
  };
  f.write("epochs/epoch/queue-state", { jobs: { ...f.jobs, [job.id]: job } });
  const jobDir = path.join(f.directory, "jobs", job.id);
  fs.mkdirSync(jobDir, { recursive: true });
  const write = (name: string, value: unknown) => {
    const file = path.join(jobDir, name);
    fs.writeFileSync(file, JSON.stringify(value));
    return reference(file);
  };
  write("request.json", job.request);
  write("outcome.json", { state: "succeeded" });
  write("worker-identity.json", {
    pid: 2147483644,
    birth: "synthetic-terminated",
  });
  const binding = {
    jobId: job.id,
    buildHash: f.sourceIdentity.buildHash,
    purpose: "saved-fixture-first-save-v1",
    auditFirstSave: true,
    auditExpectedDocument: f.epoch.document,
    auditExpectedInstance: f.epoch.currentInstance,
  };
  const remote = write("remote.json", {
    ...binding,
    terminal: true,
    outcome: "succeeded",
    instance: f.epoch.currentInstance,
  });
  write("rpc-1.json", {
    terminal: true,
    failed: false,
    pythonCheck: { status: "passed" },
    binding,
    receipt: remote.path,
  });
  const documentState = {
    status: "complete",
    state: { identity: { creationId: "doc" } },
  };
  write("preflight.json", { instance: { documentState } });
  write("postflight.json", { documentState });
  const observed: ObservedDocument = {
    creationId: "doc",
    name: "OWNED",
    fileId: "new-file",
    saved: true,
    modified: false,
    fileName: "OWNED",
    projectId: "native-project",
    folderId: f.approved.folderId,
    version: 1,
    isComplete: true,
  };
  const reply: FirstSaveReply = {
    accepted: true,
    status: "pending",
    pending: true,
    targetObserved: true,
    copyRequested: false,
    original: { ...f.epoch.document, saved: false, modified: false },
    current: observed,
    target: {
      name: "OWNED",
      projectName: f.approved.projectName,
      folder: f.approved.folderName,
      folderId: f.approved.folderId,
      projectId: "native-project",
    },
  };
  write("stdout.txt", {
    success: true,
    operation: "document.save_as",
    result: reply,
  });
  const first = f.before.firstSaveEvidence(f.directory, f.epoch, job.id);
  assert.deepEqual(
    f.after.firstSaveEvidence(f.directory, f.epoch, job.id),
    first,
  );
  assert.equal(first.evidence.length, 9);
  const requestId = "publication-read",
    kind = auditPath.savedAuditKind("sp-", requestId),
    directory = path.join(f.directory, "control", kind);
  fs.mkdirSync(directory, { recursive: true });
  const put = (name: string, value: unknown) => {
    const file = path.join(directory, name);
    fs.writeFileSync(file, JSON.stringify(value));
    return reference(file);
  };
  const observationBinding = {
    ...f.binding,
    purpose: "saved-first-save-publication-v1",
    firstSaveJobId: job.id,
    destination: { projectId: "native-project", folderId: f.approved.folderId },
    expectedFileId: "new-file",
    sdkProofPath: path.join(directory, "sdk-publication.json"),
  };
  const summary = {
    version: 1,
    purpose: observationBinding.purpose,
    epochId: "epoch",
    document: f.epoch.document,
    bindingHash: digest(observationBinding),
    observed,
    readOnly: true,
  };
  const rpcId = "44444444-4444-4444-4444-444444444444",
    sourceArtifactHash = "f".repeat(64);
  const sdkBinding = {
    jobId: job.id,
    rpcId,
    buildHash: f.sourceIdentity.buildHash,
    purpose: observationBinding.purpose,
    auditBindingHash: digest(observationBinding),
    pythonOriginHash: sourceArtifactHash,
    auditExpectedInstance: f.epoch.currentInstance,
  };
  const remotePath = path.join(directory, "remote-" + rpcId + ".json");
  const evidence = [
    put("intent.json", { binding: observationBinding, sourceArtifactHash }),
    put("start.json", {
      binding: sdkBinding,
      receipt: remotePath,
      pythonCheck: { status: "passed" },
    }),
    put("wire.json", {}),
    put("sdk-publication.json", summary),
    put(path.basename(remotePath), {
      ...sdkBinding,
      terminal: true,
      outcome: "succeeded",
      instance: f.epoch.currentInstance,
    }),
  ];
  const receipt = put("result.json", {
    requestId,
    kind,
    status: "complete",
    sdkRequestsSent: 1,
    endpointVerified: true,
    clientId: "owner",
    jobId: job.id,
    nativeOutcome: "unknown",
    modelValidation: "not_performed",
    rollbackVerification: "not_performed",
    summary,
  });
  f.write("epochs/epoch/saved-first-save-publication", {
    version: 1,
    kind: "owner-verified-new-saved-publication",
    epochId: "epoch",
    ownerClientId: "owner",
    ownerTokenHash: f.epoch.ownerTokenHash,
    originDocument: f.epoch.document,
    ...f.sourceIdentity,
    publication: f.before.firstSavePublication(grant, reply, observed),
    firstSaveJobId: job.id,
    firstSaveEvidence: first.evidence,
    observationReceipt: receipt,
    observationEvidence: evidence,
  });
  assert.deepEqual(
    f.after.readSavedPublication(f.directory, f.epoch),
    f.before.readSavedPublication(f.directory, f.epoch),
  );
  write("postflight.json", {
    documentState: {
      status: "complete",
      state: { identity: { creationId: "foreign" } },
    },
  });
  const historical = result(() =>
    f.before.firstSaveEvidence(f.directory, f.epoch, job.id),
  );
  assert.equal(historical.code, "SAVED_FIRST_SAVE_EVIDENCE_REQUIRED");
  assert.deepEqual(
    result(() => f.after.firstSaveEvidence(f.directory, f.epoch, job.id)),
    historical,
  );
});

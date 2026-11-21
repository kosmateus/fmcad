import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { TestContext } from "node:test";
import type { DeadEpochFixture } from "./fixtures/epoch-fixture-types";

const repo = process.cwd();
const load = createRequire(
  path.join(repo, "tests/successor-startup-abort.test.js"),
);
const { abortUnstartedSuccessor, retireMetadataWorker } = load(
  "../scripts/abort-unstarted-successor.cjs",
) as typeof import("../scripts/abort-unstarted-successor.cjs");
const { inspectSuccessor } = load(
  "../src/queue-epoch-successor",
) as typeof import("../src/composition/queue-epoch-successor");
const api = load("../src/queue-instance") as {
  hash(value: string | Uint8Array): string;
  durable(file: string, value: unknown, exclusive?: boolean): void;
  processBirth(pid?: number): string;
  priorProcessAlive(value: unknown): boolean | null;
};
const reference = (file: string) => ({
  path: file,
  sha256: api.hash(fs.readFileSync(file)),
});
const nativeAuditProfile = {
  sourceCommit: "923c339d3b8c85ca74e0c22511128958a97e7476",
  buildHash: "63a7c521b4beb0808afc12815fa3a0ff3ec6dcbd5528bb5557fe284ad5872e14",
  configHash:
    "fb8fba61d742d82c5cea76df8c8e7e235dd2bb09744685835aa4622f88dbd045",
} as const;

function fixture(t: TestContext) {
  const base = fs.mkdtempSync(path.join(repo, ".successor-abort-test-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const f = (
    load("./fixtures/dead-epoch-successor.cjs") as (
      base: string,
      repo: string,
    ) => DeadEpochFixture
  )(base, repo);
  fs.rmSync(path.join(f.audit, "isolated-scratch-qualification"), {
    recursive: true,
  }); // Only this synthetic prospective SDK proof.
  const approvalFile = path.join(base, "approval.json");
  api.durable(approvalFile, f.approval, true);
  const intent = {
    version: 1,
    requestId: f.requestId,
    clientId: f.clientId,
    ownerTokenHash: api.hash(f.token),
    nonce: f.nonce,
    approval: reference(approvalFile),
    previousOwner: f.previousOwner,
  };
  api.durable(path.join(f.audit, "intent.json"), intent, true);
  api.durable(
    path.join(f.audit, "launch-intent.json"),
    { nonce: f.nonce, authority: f.authorityEntry },
    true,
  );
  api.durable(path.join(f.audit, "retired-owner.json"), f.previousOwner, true);
  const guard = {
    kind: "dead-epoch-successor",
    nonce: f.nonce,
    audit: f.audit,
    clientId: f.clientId,
  };
  for (const name of ["recovery.lock", "atomic-migration.lock"])
    api.durable(path.join(f.dir, name), guard, true);
  api.durable(
    path.join(f.dir, "active-epoch-succession.json"),
    { version: 1, authority: f.authorityEntry },
    true,
  );
  fs.unlinkSync(path.join(f.dir, "broker.lock")); // Synthetic terminal startup already released its own marker.
  const worker = {
    pid: 2147483644,
    birth: "dead:rejected-worker",
    nonce: f.nonce,
  };
  api.durable(path.join(f.audit, "worker-claim.json"), worker, true);
  api.durable(
    path.join(f.audit, "worker-error.json"),
    { nonce: f.nonce, code: "INSTANCE_CHANGED" },
    true,
  );
  const nonce = randomUUID(),
    lifecycleFile = path.join(f.dir, "broker-lifecycle-" + nonce + ".json");
  const receipt = path.join(f.dir, "broker-startup-" + nonce + ".receipt.json");
  const lifecycle = {
    owner: { ...worker, nonce, protocol: 2 },
    stage: "rejected",
    safeToRecover: true,
    code: "INSTANCE_CHANGED",
    buildHash: f.authority.buildHash,
    configHash: f.authority.configHash,
    receipt,
    binding: {
      brokerNonce: nonce,
      ownerPid: worker.pid,
      ownerBirth: worker.birth,
      buildHash: f.authority.buildHash,
      stage: "startup",
    },
  };
  api.durable(lifecycleFile, lifecycle, true);
  const client = {
    dir: f.dir,
    auth: { clientId: f.clientId, clientToken: f.token },
  };
  return {
    ...f,
    client,
    base,
    approvalFile,
    lifecycle,
    lifecycleFile,
    receipt,
    worker,
    guard,
  };
}

function readyFixture(t: TestContext) {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.audit, "worker-error.json"));
  const owner = f.lifecycle.owner;
  api.durable(f.lifecycleFile, {
    owner,
    stage: "ready",
    buildHash: f.authority.buildHash,
    configHash: f.authority.configHash,
  });
  api.durable(path.join(f.audit, "worker-ready.json"), {
    nonce: f.nonce,
    owner,
    buildHash: f.authority.buildHash,
    sdkRequestsSent: 0,
  });
  api.durable(path.join(f.audit, "complete.json"), {
    version: 1,
    kind: "dead-epoch-successor-metadata-ready",
    requestId: f.requestId,
    authority: f.authorityEntry,
    owner,
    buildHash: f.authority.buildHash,
    sourceCommit: f.authority.sourceCommit,
    sdkRequestsSent: 0,
    historicalOutcome: "unknown",
    modelingAdmission: "blocked-until-current-facts-and-proven-new-scratch",
  });
  for (const name of ["recovery.lock", "atomic-migration.lock"]) {
    fs.renameSync(
      path.join(f.dir, name),
      path.join(f.audit, "released-" + name + ".json"),
    );
  }
  const observation = path.join(f.audit, "dead-epoch-current-observation");
  fs.mkdirSync(observation);
  const key = {
    jobId: f.inspection.pointer.quarantinedJobIds[0],
    observationJobId: f.inspection.pointer.quarantinedJobIds[1],
    requestId: f.requestId + ":observe",
    clientId: f.clientId,
  };
  api.durable(path.join(observation, "intent.json"), {
    version: 1,
    key,
    binding: {
      purpose: "atomic-recovery-audit-v1",
      clientId: f.clientId,
      expectedProcess: f.authority.expectedProcess,
      successorAuthorityHash: f.authorityEntry.sha256,
    },
    sourceSha256: "a".repeat(64),
    sourceArtifactHash: "b".repeat(64),
  });
  api.durable(path.join(observation, "result.json"), {
    kind: "dead-epoch-current-observation",
    ...key,
    status: "failed",
    code: "AUDIT_REQUEST_INVALID",
    sdkRequestsSent: 0,
    nativeOutcome: "unknown",
    modelValidation: "not_performed",
    rollbackVerification: "not_performed",
  });
  return { ...f, owner, observation };
}

function sdkSubmittedUnknownFixture(
  t: TestContext,
  expectedProcess = { pid: 3332, birth: "134391194634692184" },
) {
  const f = readyFixture(t),
    authorityFile = path.join(f.audit, "authority.json");
  // This is a fake Windows process, not the developer's live Windows host.
  // Plain Linux CI has no PowerShell observer and must not silently supply one.
  const observe = api.priorProcessAlive;
  t.mock.method(api, "priorProcessAlive", (value: unknown) =>
    value &&
    typeof value === "object" &&
    "pid" in value &&
    "birth" in value &&
    value.pid === expectedProcess.pid &&
    value.birth === expectedProcess.birth
      ? false
      : observe(value),
  );
  f.authority = { ...f.authority, expectedProcess };
  api.durable(authorityFile, f.authority);
  f.authorityEntry = reference(authorityFile);
  f.approval = { ...f.approval, expectedProcess };
  api.durable(f.approvalFile, f.approval);
  const intentFile = path.join(f.audit, "intent.json"),
    intent = JSON.parse(fs.readFileSync(intentFile, "utf8")) as Record<
      string,
      unknown
    >;
  api.durable(intentFile, {
    ...intent,
    approval: reference(f.approvalFile),
  });
  api.durable(path.join(f.dir, "active-epoch-succession.json"), {
    version: 1,
    authority: f.authorityEntry,
  });
  api.durable(path.join(f.audit, "launch-intent.json"), {
    nonce: f.nonce,
    authority: f.authorityEntry,
  });
  const completeFile = path.join(f.audit, "complete.json"),
    complete = JSON.parse(fs.readFileSync(completeFile, "utf8")) as Record<
      string,
      unknown
    >;
  api.durable(completeFile, { ...complete, authority: f.authorityEntry });

  const observationIntentFile = path.join(f.observation, "intent.json"),
    observationIntent = {
      version: 1,
      key: {
        jobId: f.inspection.pointer.quarantinedJobIds[0],
        observationJobId: f.inspection.pointer.quarantinedJobIds[1],
        requestId: f.requestId + ":observe",
        clientId: f.clientId,
      },
      binding: {
        purpose: "atomic-recovery-audit-v1",
        clientId: f.clientId,
        expectedProcess,
        successorAuthorityHash: f.authorityEntry.sha256,
      },
      identity: f.auditIdentity,
      sourceSha256:
        "171882e43aa81c12411cd54d5d7ef1071502d25f17f143054aa3ca3bb7ef83f7",
      sourceArtifactHash:
        "66adcde52ab1f17e811c563c3e1fe7c8fa091c42f6b4c00eaaa6116056036efb",
    };
  api.durable(observationIntentFile, observationIntent);
  const rpcId = "d73dcc0f-adae-44f1-9927-016b068cfe7b",
    observationStartFile = path.join(f.observation, "start.json"),
    observationWireFile = path.join(f.observation, "wire.json"),
    observationResultFile = path.join(f.observation, "result.json");
  const syntheticScript = "synthetic bound read-only script";
  const start = {
    binding: {
      jobId: observationIntent.key.jobId,
      rpcId,
      requestHash:
        "1f77dbd713f341e12621c37cabe53657bfa5006b9e5369c3f7c88014d13a88d9",
      buildHash: f.authority.buildHash,
      sourceHash:
        "5f6b41a561bd239155b64d76a6afa5c2674c45130eff5ac0ba3c364eabed4a0c",
      purpose: "atomic-recovery-audit-v1",
      auditBindingHash:
        "bb559da1ec0b16782cef7d12b31659cc6b9392281e477b56a51349e995653ee2",
      pythonOriginHash: observationIntent.sourceArtifactHash,
      auditExpectedProcess: expectedProcess,
    },
    instance: expectedProcess,
    receipt: path.join(f.observation, "remote-" + rpcId + ".json"),
    pythonCheck: {
      status: "passed",
      provenance: {
        artifactHash:
          "15a3ac72466849a0331026935ffccaffd88bacd42eb8552cdef907f2b9814b3b",
        wireHash: api.hash(syntheticScript),
      },
    },
    originArtifactHash: observationIntent.sourceArtifactHash,
  };
  const wire = {
    outgoing: {
      jsonrpc: "2.0",
      id: "fmcad:" + rpcId,
      method: "tools/call",
      params: {
        name: "fusion_mcp_execute",
        arguments: {
          featureType: "script",
          object: {
            script: syntheticScript,
            readOnly: true,
          },
        },
      },
    },
    artifact: {
      artifactHash: start.pythonCheck.provenance.artifactHash,
      sha256: start.pythonCheck.provenance.wireHash,
    },
  };
  api.durable(observationStartFile, start);
  api.durable(observationWireFile, wire);
  api.durable(observationResultFile, {
    kind: "dead-epoch-current-observation",
    ...observationIntent.key,
    status: "failed",
    code: "ENOENT",
    sdkRequestsSent: 1,
    nativeOutcome: "unknown",
    modelValidation: "not_performed",
    rollbackVerification: "not_performed",
  });
  const proofFile = path.join(f.base, "sdk-process-death-proof.json"),
    observedAt = {
      before: "2026-11-14T18:05:10.9856823Z",
      exited: "2026-11-14T18:05:18.3129443Z",
      after: "2026-11-14T18:05:18.3285949Z",
    };
  api.durable(proofFile, {
    version: 1,
    kind: "sdk-process-death-proof-v1",
    expectedProcess,
    before: {
      state: "present",
      ...expectedProcess,
      version: "2706.1.17",
      exe: "C:\\Users\\kamil\\AppData\\Local\\Autodesk\\webdeploy\\production\\39e8a3d5e919c70b05ef3ebfe9c6bfc8d9ee001e\\Fusion360.exe",
      windowHandle: "395154",
      observedAtUtc: observedAt.before,
    },
    handleBoundExit: {
      ...expectedProcess,
      hasExited: true,
      observedAtUtc: observedAt.exited,
    },
    after: {
      state: "absent",
      pid: expectedProcess.pid,
      observedAtUtc: observedAt.after,
      errorId:
        "NoProcessFoundForGivenId,Microsoft.PowerShell.Commands.GetProcessCommand",
    },
    bindings: {
      authority: f.authorityEntry,
      observationIntent: reference(observationIntentFile),
      observationStart: reference(observationStartFile),
      observationWire: reference(observationWireFile),
      observationResult: reference(observationResultFile),
    },
  });
  return { ...f, proofFile, observationIntent, start, wire };
}

function nativeSdkSubmittedUnknownFixture(
  t: TestContext,
  sourceCommit: string = nativeAuditProfile.sourceCommit,
  expectedProcessOverride?: { pid: number; birth: string },
) {
  const f = sdkSubmittedUnknownFixture(t, expectedProcessOverride),
    predecessor = f.authority.predecessor,
    rootIdentityFile = predecessor.rootIdentity.path,
    predecessorIdentityFile = predecessor.identity.path;
  for (const file of new Set([rootIdentityFile, predecessorIdentityFile])) {
    const identity = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
      string,
      unknown
    >;
    api.durable(file, {
      ...identity,
      configHash: nativeAuditProfile.configHash,
    });
  }
  const rootIdentityRef = reference(rootIdentityFile),
    predecessorIdentityRef = reference(predecessorIdentityFile),
    livePointerFile = path.join(f.dir, "isolated-admission-epoch.json"),
    livePointer = JSON.parse(
      fs.readFileSync(livePointerFile, "utf8"),
    ) as Record<string, unknown>;
  livePointer["historicalIdentityHash"] = rootIdentityRef.sha256;
  api.durable(livePointerFile, livePointer);
  const archivedPointerFile = predecessor.pointer.path;
  api.durable(archivedPointerFile, livePointer);
  const predecessorPointerRef = reference(archivedPointerFile);
  f.authority = {
    ...f.authority,
    predecessor: {
      ...predecessor,
      pointer: predecessorPointerRef,
      identity: predecessorIdentityRef,
      rootIdentity: rootIdentityRef,
    },
  };
  f.approval = {
    ...f.approval,
    pointerHash: predecessorPointerRef.sha256,
    rootIdentityHash: rootIdentityRef.sha256,
  };
  const qualificationFile = f.authority.qualification.path,
    qualification = JSON.parse(
      fs.readFileSync(qualificationFile, "utf8"),
    ) as Record<string, unknown>;
  qualification["sourceCommit"] = sourceCommit;
  qualification["buildHash"] = nativeAuditProfile.buildHash;
  api.durable(qualificationFile, qualification);
  const qualificationRef = reference(qualificationFile),
    authorityFile = path.join(f.audit, "authority.json");
  f.authority = {
    ...f.authority,
    sourceCommit,
    buildHash: nativeAuditProfile.buildHash,
    configHash: nativeAuditProfile.configHash,
    qualification: qualificationRef,
  };
  api.durable(authorityFile, f.authority);
  f.authorityEntry = reference(authorityFile);
  f.approval = {
    ...f.approval,
    sourceCommit,
    buildHash: nativeAuditProfile.buildHash,
    qualification: qualificationRef,
  };
  api.durable(f.approvalFile, f.approval);
  const intentFile = path.join(f.audit, "intent.json"),
    intent = JSON.parse(fs.readFileSync(intentFile, "utf8")) as Record<
      string,
      unknown
    >;
  api.durable(intentFile, {
    ...intent,
    approval: reference(f.approvalFile),
  });
  api.durable(path.join(f.dir, "active-epoch-succession.json"), {
    version: 1,
    authority: f.authorityEntry,
  });
  api.durable(path.join(f.audit, "launch-intent.json"), {
    nonce: f.nonce,
    authority: f.authorityEntry,
  });
  for (const name of ["worker-ready.json", "complete.json"]) {
    const file = path.join(f.audit, name),
      value = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
        string,
        unknown
      >;
    if (name === "worker-ready.json")
      value["buildHash"] = nativeAuditProfile.buildHash;
    else
      Object.assign(value, {
        authority: f.authorityEntry,
        buildHash: nativeAuditProfile.buildHash,
        sourceCommit,
      });
    api.durable(file, value);
  }
  const lifecycleFile = path.join(
    f.dir,
    "broker-lifecycle-" + f.owner.nonce + ".json",
  );
  const lifecycle = JSON.parse(
    fs.readFileSync(lifecycleFile, "utf8"),
  ) as Record<string, unknown>;
  api.durable(lifecycleFile, {
    ...lifecycle,
    buildHash: nativeAuditProfile.buildHash,
    configHash: nativeAuditProfile.configHash,
  });

  const observationIntentFile = path.join(f.observation, "intent.json"),
    observationStartFile = path.join(f.observation, "start.json"),
    observationWireFile = path.join(f.observation, "wire.json"),
    observationResultFile = path.join(f.observation, "result.json"),
    key = {
      jobId: f.inspection.pointer.quarantinedJobIds[0],
      observationJobId: f.inspection.pointer.quarantinedJobIds[1],
      requestId: f.requestId + ":observe",
      clientId: f.clientId,
    },
    expectedProcess = f.authority.expectedProcess,
    observationBinding = {
      purpose: "atomic-recovery-audit-v1",
      clientId: f.clientId,
      expectedProcess,
      successorAuthorityHash: f.authorityEntry.sha256,
    },
    observationIntent: Record<string, unknown> = {
      version: 1,
      key,
      binding: observationBinding,
      identity: f.auditIdentity,
      sourceSha256: "",
      sourceArtifactHash: "",
    },
    runtimeLoad = createRequire(
      path.join(f.approval.candidateRoot, "src/queue-instance.js"),
    ),
    nativeReader = (
      runtimeLoad("./queue-atomic-recovery-audit") as {
        prepareRecoveryAudit(
          runtime: string,
          identity: unknown,
          binding: Record<string, unknown>,
        ): {
          sourceSha256: string;
          artifact: { script: string; artifactHash: string; sha256: string };
        };
      }
    ).prepareRecoveryAudit(
      f.approval.candidateRoot,
      f.auditIdentity,
      observationBinding,
    );
  observationIntent["sourceSha256"] = nativeReader.sourceSha256;
  observationIntent["sourceArtifactHash"] = nativeReader.artifact.artifactHash;
  api.durable(observationIntentFile, observationIntent);

  const rpcId = randomUUID(),
    script = nativeReader.artifact.script,
    sourceHash = api.hash(script),
    physical = {
      jobId: key.jobId,
      rpcId,
      requestHash: "1".repeat(64),
      buildHash: nativeAuditProfile.buildHash,
      sourceHash,
      purpose: "atomic-recovery-audit-v1",
      auditBindingHash: (
        load("../src/dist/core/application/cad/json") as {
          hash(value: unknown): string;
        }
      ).hash(observationBinding),
      pythonOriginHash: nativeReader.artifact.artifactHash,
      auditExpectedProcess: expectedProcess,
    },
    { preparePythonArtifact } = load(
      "../src/dist/python/artifact",
    ) as typeof import("../packages/node-adapters/src/python/artifact"),
    { pythonArtifactManifest } = load(
      "../src/dist/python/context-binding",
    ) as typeof import("../packages/node-adapters/src/python/context-binding"),
    prepared = preparePythonArtifact(
      [
        {
          id: "wire",
          filename: "<fmcad-wire>",
          source: script,
          role: "user",
        },
      ],
      {
        context: {
          entrypoints: [],
          origin: {
            artifactHash: nativeReader.artifact.artifactHash,
            sha256: api.hash("synthetic native audit source"),
            context: {
              kind: "atomic-recovery-audit-v1",
              ...observationBinding,
            },
            request: { identity: f.auditIdentity },
            sourceMap: [],
            segments: [{ sha256: sourceHash, startLine: 1, endLine: 1 }],
            units: [],
          },
        },
        request: physical,
      },
    ),
    artifact = pythonArtifactManifest(prepared),
    start = {
      binding: physical,
      instance: expectedProcess,
      receipt: path.join(f.observation, "remote-" + rpcId + ".json"),
      pythonCheck: {
        status: "passed",
        provenance: {
          artifactHash: prepared.artifactHash,
          wireHash: prepared.sha256,
        },
      },
      originArtifactHash: nativeReader.artifact.artifactHash,
    },
    wire = {
      outgoing: {
        jsonrpc: "2.0",
        id: "fmcad:" + rpcId,
        method: "tools/call",
        params: {
          name: "fusion_mcp_execute",
          arguments: {
            featureType: "script",
            object: { script: prepared.script, readOnly: true },
          },
        },
      },
      artifact,
    },
    summary = {
      version: 1,
      purpose: "atomic-recovery-audit-v1",
      profile: "atomic-recovery-counts-v1",
      requestIdentity: f.auditIdentity,
      nativeOutcome: "unknown",
      modelValidation: "not_performed",
      rollbackVerification: "not_performed",
      modulePresent: false,
      ui: { activeCommand: "SelectCommand", idle: true },
      commandDefinition: { status: "absent" },
      document: { status: "absent", matches: 0 },
      snapshot: null,
      fingerprint: null,
    };
  start.originArtifactHash = nativeReader.artifact.artifactHash;
  api.durable(observationStartFile, start);
  api.durable(observationWireFile, wire);
  api.durable(path.join(f.observation, "received-response.json"), {
    version: 1,
    binding: physical,
    wireId: wire.outgoing.id,
    callerId: 1,
    status: 200,
    raw: JSON.stringify({
      jsonrpc: "2.0",
      id: wire.outgoing.id,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              message: "FMCAD_RESULT " + JSON.stringify(summary) + "\n",
            }),
          },
        ],
      },
    }),
  });
  api.durable(start.receipt, {
    ...physical,
    terminal: true,
    outcome: "succeeded",
    instance: {
      ...expectedProcess,
      version: "synthetic-fusion-version",
      activeCommand: "SelectCommand",
    },
  });
  api.durable(observationResultFile, {
    kind: "dead-epoch-current-observation",
    ...key,
    status: "failed",
    code: "AUDIT_OUTPUT_INVALID",
    sdkRequestsSent: 1,
    nativeOutcome: "unknown",
    modelValidation: "not_performed",
    rollbackVerification: "not_performed",
  });
  const proof = JSON.parse(fs.readFileSync(f.proofFile, "utf8")) as Record<
    string,
    unknown
  >;
  api.durable(f.proofFile, {
    ...proof,
    bindings: {
      authority: f.authorityEntry,
      observationIntent: reference(observationIntentFile),
      observationStart: reference(observationStartFile),
      observationWire: reference(observationWireFile),
      observationResult: reference(observationResultFile),
    },
  });
  return { ...f, observationIntent, start, wire };
}

function packedWithdrawalOperator(base: string) {
  const packDirectory = path.join(base, "packed");
  const unpackDirectory = path.join(base, "unpacked");
  fs.mkdirSync(packDirectory);
  fs.mkdirSync(unpackDirectory);
  const npmConfig = path.join(base, "empty.npmrc");
  fs.writeFileSync(npmConfig, "");
  const nodeDirectory = path.dirname(process.execPath),
    pack = spawnSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      [
        "pack",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        packDirectory,
      ],
      {
        cwd: repo,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: [nodeDirectory, process.env["PATH"] ?? ""].join(path.delimiter),
          npm_config_audit: "false",
          npm_config_cache: path.join(base, "npm-cache"),
          npm_config_fund: "false",
          npm_config_offline: "true",
          npm_config_userconfig: npmConfig,
        },
        shell: process.platform === "win32",
      },
    );
  assert.equal(pack.status, 0, pack.stderr);
  const archives = fs
    .readdirSync(packDirectory)
    .filter((name) => name.endsWith(".tgz"));
  assert.equal(archives.length, 1);
  const extract = spawnSync(
    "tar",
    ["-xzf", path.join(packDirectory, archives[0]!), "-C", unpackDirectory],
    { encoding: "utf8" },
  );
  assert.equal(extract.status, 0, extract.stderr);
  const packageRoot = path.join(unpackDirectory, "package"),
    operatorFile = path.join(
      packageRoot,
      "scripts/abort-unstarted-successor.cjs",
    ),
    retainedVerifier = path.join(
      packageRoot,
      "dist/src/dist/node-adapters/execution/recovery-audit.js",
    );
  assert.ok(fs.statSync(operatorFile).isFile());
  assert.ok(fs.statSync(retainedVerifier).isFile());
  assert.equal(
    fs.existsSync(
      path.join(
        packageRoot,
        "src/dist/node-adapters/execution/recovery-audit.js",
      ),
    ),
    false,
  );
  return createRequire(operatorFile)(
    "./abort-unstarted-successor.cjs",
  ) as typeof import("../scripts/abort-unstarted-successor.cjs");
}

test("pinned 923c native SDK1 withdrawal accepts the exact retained six-file audit", (t) => {
  const f = nativeSdkSubmittedUnknownFixture(t),
    names = [
      "intent.json",
      "start.json",
      "wire.json",
      "received-response.json",
      "remote-" + f.start.binding.rpcId + ".json",
      "result.json",
    ],
    files = names.map((name) => path.join(f.observation, name)),
    before = files.map((file) => fs.readFileSync(file));
  const preview = abortUnstartedSuccessor(f.client, f.approvalFile, false, {
    withdrawUnknown: true,
    processDeathProofFile: f.proofFile,
  }) as Record<string, unknown>;
  assert.equal(preview["operation"], "withdraw-after-sdk-unknown");
  assert.equal(preview["sdkRequestsSent"], 1);
  assert.equal(preview["nativeOutcome"], "unknown");
  assert.equal(preview["historicalOutcome"], "unknown");
  const facts = preview["facts"] as Array<{ path: string; sha256: string }>;
  assert.deepEqual(
    facts
      .filter((entry) => path.dirname(entry.path) === f.observation)
      .sort((a, b) => a.path.localeCompare(b.path)),
    files
      .map((file) => reference(file))
      .sort((a, b) => a.path.localeCompare(b.path)),
  );
  const deathProof = JSON.parse(fs.readFileSync(f.proofFile, "utf8")) as {
    bindings: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(deathProof.bindings).sort(), [
    "authority",
    "observationIntent",
    "observationResult",
    "observationStart",
    "observationWire",
  ]);
  assert.deepEqual(fs.readdirSync(f.observation).sort(), names.sort());
  for (const [i, file] of files.entries())
    assert.deepEqual(fs.readFileSync(file), before[i]);
});

test("packed native6 withdrawal preflight enters retained audit with bound death and retirement receipts", (t) => {
  const expectedProcess = {
      pid: 33684,
      birth: "134391533161165520",
    },
    f = nativeSdkSubmittedUnknownFixture(
      t,
      nativeAuditProfile.sourceCommit,
      expectedProcess,
    ),
    retirement = writeSdk1RetirementReceipt(f),
    packedOperator = packedWithdrawalOperator(f.base),
    names = [
      "intent.json",
      "start.json",
      "wire.json",
      "received-response.json",
      "remote-" + f.start.binding.rpcId + ".json",
      "result.json",
    ],
    retainedFiles = names.map((name) => path.join(f.observation, name)),
    proof = JSON.parse(fs.readFileSync(f.proofFile, "utf8")),
    protectedFiles = [
      f.approvalFile,
      f.authorityEntry.path,
      f.proofFile,
      ...retainedFiles,
      retirement.beforeFile,
      retirement.startFile,
      retirement.afterFile,
      path.join(f.dir, "broker.lock"),
      path.join(f.dir, "active-epoch-succession.json"),
    ],
    before = protectedFiles.map((file) => fs.readFileSync(file));
  assert.deepEqual(f.authority.expectedProcess, expectedProcess);
  assert.deepEqual(proof.expectedProcess, expectedProcess);
  assert.equal(proof.after.state, "absent");
  const preview = packedOperator.abortUnstartedSuccessor(
    f.client,
    f.approvalFile,
    false,
    { withdrawUnknown: true, processDeathProofFile: f.proofFile },
  ) as Record<string, unknown>;
  assert.equal(preview["operation"], "withdraw-after-sdk-unknown");
  assert.equal(preview["sdkRequestsSent"], 1);
  assert.equal(preview["nativeOutcome"], "unknown");
  assert.equal(preview["processDeathProofRequired"], false);
  assert.equal(preview["retirementPerformed"], false);
  assert.equal(preview["applyReady"], true);
  const factPaths = new Set(
    (preview["facts"] as Array<{ path: string }>).map((fact) => fact.path),
  );
  for (const file of [
    ...retainedFiles,
    f.proofFile,
    retirement.beforeFile,
    retirement.startFile,
    retirement.afterFile,
  ])
    assert.ok(factPaths.has(file), "packed preflight must bind " + file);
  for (const [index, file] of protectedFiles.entries())
    assert.deepEqual(fs.readFileSync(file), before[index]);
  assert.equal(fs.existsSync(path.join(f.audit, "abort-unstarted")), false);
});

test("packed legacy SDK1 withdrawal keeps the exact four-file compatibility", (t) => {
  const f = sdkSubmittedUnknownFixture(t),
    names = ["intent.json", "result.json", "start.json", "wire.json"],
    observationFiles = names.map((name) => path.join(f.observation, name)),
    packedOperator = packedWithdrawalOperator(f.base),
    protectedFiles = [
      f.approvalFile,
      f.authorityEntry.path,
      f.proofFile,
      ...observationFiles,
    ],
    before = protectedFiles.map((file) => fs.readFileSync(file));
  assert.notEqual(f.authority.sourceCommit, nativeAuditProfile.sourceCommit);
  assert.deepEqual(fs.readdirSync(f.observation).sort(), names);
  const preview = packedOperator.abortUnstartedSuccessor(
    f.client,
    f.approvalFile,
    false,
    { withdrawUnknown: true, processDeathProofFile: f.proofFile },
  ) as Record<string, unknown>;
  assert.equal(preview["operation"], "withdraw-after-sdk-unknown");
  assert.equal(preview["sdkRequestsSent"], 1);
  assert.equal(preview["nativeOutcome"], "unknown");
  assert.equal(preview["applyReady"], true);
  const factPaths = new Set(
    (preview["facts"] as Array<{ path: string }>).map((fact) => fact.path),
  );
  for (const file of [...observationFiles, f.proofFile])
    assert.ok(factPaths.has(file), "packed legacy preflight must bind " + file);
  for (const [index, file] of protectedFiles.entries())
    assert.deepEqual(fs.readFileSync(file), before[index]);
  assert.equal(fs.existsSync(path.join(f.audit, "abort-unstarted")), false);
});

for (const changed of [
  "foreign-source",
  "missing-remote",
  "tampered-response",
  "process-mismatch",
  "death-proof-process-mismatch",
  "wrong-local-failure",
  "live-death-observer",
  "null-death-observer",
]) {
  test("pinned native SDK1 withdrawal refuses " + changed, (t) => {
    const f = nativeSdkSubmittedUnknownFixture(
      t,
      changed === "foreign-source"
        ? "a".repeat(40)
        : nativeAuditProfile.sourceCommit,
    );
    if (changed === "missing-remote") fs.unlinkSync(f.start.receipt);
    else if (changed === "tampered-response") {
      const file = path.join(f.observation, "received-response.json"),
        response = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
          string,
          unknown
        >;
      response["raw"] = "{}";
      api.durable(file, response);
    } else if (changed === "process-mismatch") {
      const remote = JSON.parse(fs.readFileSync(f.start.receipt, "utf8")) as {
        instance: { pid: number; birth: string };
      };
      remote.instance.birth += "-different";
      api.durable(f.start.receipt, remote);
    } else if (changed === "death-proof-process-mismatch") {
      const proof = JSON.parse(fs.readFileSync(f.proofFile, "utf8")) as {
        expectedProcess: { pid: number; birth: string };
      };
      proof.expectedProcess.birth += "-different";
      api.durable(f.proofFile, proof);
    } else if (changed === "wrong-local-failure") {
      const file = path.join(f.observation, "result.json"),
        result = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
          string,
          unknown
        >;
      result["code"] = "AUDIT_REQUEST_INVALID";
      api.durable(file, result);
    } else if (
      changed === "live-death-observer" ||
      changed === "null-death-observer"
    ) {
      const proof = JSON.parse(fs.readFileSync(f.proofFile, "utf8")) as {
        after: { state: string; errorId: string };
      };
      if (changed === "live-death-observer") proof.after.state = "present";
      else {
        proof.after.state = "unknown";
        proof.after.errorId = "AccessDenied";
      }
      api.durable(f.proofFile, proof);
    }
    const before = fs
      .readdirSync(f.observation)
      .map((name) => path.join(f.observation, name))
      .filter((file) => fs.existsSync(file))
      .map((file) => [file, fs.readFileSync(file)] as const);
    assert.throws(() =>
      abortUnstartedSuccessor(f.client, f.approvalFile, false, {
        withdrawUnknown: true,
        processDeathProofFile: f.proofFile,
      }),
    );
    for (const [file, bytes] of before)
      assert.deepEqual(fs.readFileSync(file), bytes);
  });
}

function retirementFixture(t: TestContext) {
  const f = readyFixture(t);
  let alive = true,
    signals = 0,
    fusionReads = 0;
  const original = api.priorProcessAlive;
  t.mock.method(api, "priorProcessAlive", (value: unknown) => {
    if (
      value &&
      typeof value === "object" &&
      "pid" in value &&
      "birth" in value &&
      value.pid === f.worker.pid &&
      value.birth === f.worker.birth
    )
      return alive;
    return original(value);
  });
  api.durable(path.join(f.dir, "broker.lock"), f.owner);
  const exe = path.join(f.base, "synthetic-node-executable");
  fs.writeFileSync(exe, "fake process port ONLY; never executed");
  const process = {
    pid: f.owner.pid,
    birth: f.owner.birth,
    exe,
    exeSha256: reference(exe).sha256,
    cmdline: [
      exe,
      f.approval.candidateRoot + "/src/queue-epoch-successor-worker.js",
    ],
    childrenByTask: {},
    socketRows: [],
  };
  const osFile = path.join(f.base, "os-after.json");
  api.durable(osFile, process);
  const fusion = {
    ...f.authority.expectedProcess,
    version: "synthetic-version",
  };
  const proof = {
    kind: "metadata-worker-retirement-proof-v1",
    qualified: true,
    proofGaps: [],
    sourceCommit: f.authority.sourceCommit,
    buildHash: f.authority.buildHash,
    runtimeRoot: f.approval.candidateRoot,
    worker: f.owner,
    workerClaimNonce: f.nonce,
    requestId: f.requestId,
    epochId: f.approval.predecessorEpochId,
    fusion,
    protectedFiles: [
      reference(path.join(f.dir, "broker.lock")),
      reference(path.join(f.observation, "result.json")),
      reference(f.authority.predecessor.rootState.path),
    ],
    sourceFiles: [reference(exe)],
    evidenceFiles: [reference(osFile)],
  };
  const proofFile = path.join(f.base, "independent-proof.json");
  api.durable(proofFile, proof);
  const control = {
    instanceId: f.owner.nonce,
    buildHash: proof.buildHash,
    activeOperations: 0,
    activeIds: [],
    unresolved: true,
    phase: "RECOVERY_BLOCKED",
  };
  const status = {
    buildHash: proof.buildHash,
    sourceCommit: proof.sourceCommit,
    admissionEpoch: proof.epochId,
    held: "Qualified isolated scratch process is unavailable; metadata only, no SDK or replacement authority",
    stopping: false,
    deadEpochSuccessor: {
      requestId: f.requestId,
      currentFactsAvailable: false,
      expectedProcess: f.authority.expectedProcess,
    },
    features: {
      auditFactsCapture: false,
      atomicRecoveryProcessLossAudit: false,
    },
  };
  const client = {
    ...f.client,
    async call(action: string) {
      return structuredClone(action === "queue-summary" ? status : control);
    },
  };
  const ports: NonNullable<Parameters<typeof retireMetadataWorker>[4]> = {
    certify() {
      /* Fake source certification for protocol tests, not a production qualification. */
    },
    process(_owner, _runtime, _refs, apply) {
      if (apply) {
        signals++;
        alive = false;
      }
      return { process, retired: apply };
    },
    fusion() {
      fusionReads++;
      return { ...fusion, hasExited: false, responding: true };
    },
  };
  return {
    ...f,
    client,
    proof,
    proofFile,
    ports,
    process,
    status,
    control,
    counts: () => ({ signals, fusionReads }),
    setAlive(value: boolean) {
      alive = value;
    },
  };
}

function refreshSdkDeathBindings(
  f: ReturnType<typeof sdkSubmittedUnknownFixture>,
) {
  const proof = JSON.parse(fs.readFileSync(f.proofFile, "utf8"));
  proof.bindings.observationWire = reference(
    path.join(f.observation, "wire.json"),
  );
  api.durable(f.proofFile, proof);
}

test("historical SDK1 Python wire is preserved by the new withdrawal evaluator", (t) => {
  const f = sdkSubmittedUnknownFixture(t);
  const wire = {
    ...f.wire,
    outgoing: {
      ...f.wire.outgoing,
      params: {
        name: "execute_python",
        arguments: {
          code: "synthetic bound read-only script",
          persistent: false,
        },
      },
    },
  };
  api.durable(path.join(f.observation, "wire.json"), wire);
  refreshSdkDeathBindings(f);
  const original = fs.readFileSync(path.join(f.observation, "wire.json"));
  const result = abortUnstartedSuccessor(f.client, f.approvalFile, true, {
    withdrawUnknown: true,
    processDeathProofFile: f.proofFile,
  }) as Record<string, unknown>;
  assert.equal(result["sdkRequestsSent"], 1);
  assert.equal(result["nativeOutcome"], "unknown");
  assert.deepEqual(
    fs.readFileSync(path.join(f.observation, "wire.json")),
    original,
  );
});

function fullHistoricalManifest(
  f: ReturnType<typeof sdkSubmittedUnknownFixture>,
  owner: { pid: number; birth: string; nonce: string; protocol: number },
) {
  for (const name of ["worker-ready.json", "complete.json"]) {
    const file = path.join(f.audit, name);
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    value.owner = owner;
    api.durable(file, value);
  }
  const oldLifecycle = JSON.parse(
    fs.readFileSync(
      path.join(f.dir, "broker-lifecycle-" + f.owner.nonce + ".json"),
      "utf8",
    ),
  );
  api.durable(path.join(f.dir, "broker-lifecycle-" + owner.nonce + ".json"), {
    ...oldLifecycle,
    owner,
  });
  const { preparePythonArtifact } = load(
    "../src/dist/python/artifact",
  ) as typeof import("../packages/node-adapters/src/python/artifact");
  const { pythonArtifactManifest } = load(
    "../src/dist/python/context-binding",
  ) as typeof import("../packages/node-adapters/src/python/context-binding");
  const originalSource = "def run(_context: str):\n    return None\n",
    wrappedSource = originalSource + "\n# synthetic observation wrapper";
  f.start.binding.sourceHash = api.hash(wrappedSource);
  const artifact = preparePythonArtifact(
    [
      {
        id: "historical-audit",
        filename: "runtime/historical-audit.py",
        source: wrappedSource,
        role: "user",
      },
    ],
    {
      request: f.start.binding,
      context: {
        entrypoints: [],
        origin: {
          artifactHash: f.observationIntent.sourceArtifactHash,
          sha256: api.hash(originalSource),
          context: {
            kind: "atomic-recovery-audit-v1",
            ...f.observationIntent.binding,
          },
          request: { identity: f.auditIdentity },
          units: [],
          sourceMap: [],
          segments: [
            { sha256: f.start.binding.sourceHash, startLine: 1, endLine: 3 },
          ],
        },
      },
    },
  );
  const manifest = pythonArtifactManifest(artifact);
  const wireFile = path.join(f.observation, "wire.json");
  const startFile = path.join(f.observation, "start.json");
  api.durable(wireFile, {
    ...f.wire,
    outgoing: {
      ...f.wire.outgoing,
      params: {
        name: "execute_python",
        arguments: { code: artifact.script, persistent: false },
      },
    },
    artifact: manifest,
  });
  const start = structuredClone(f.start);
  start.pythonCheck.provenance = {
    artifactHash: manifest.artifactHash,
    wireHash: manifest.sha256,
  };
  api.durable(startFile, start);
  const proof = JSON.parse(fs.readFileSync(f.proofFile, "utf8"));
  proof.bindings.observationStart = reference(startFile);
  proof.bindings.observationWire = reference(wireFile);
  api.durable(f.proofFile, proof);
  return { wireFile, manifest };
}

test("withdrawal retains distinct broker/claim nonces and a complete historical artifact manifest", (t) => {
  const f = sdkSubmittedUnknownFixture(t);
  const owner = { ...f.owner, nonce: "broker-instance-" + randomUUID() };
  const { wireFile, manifest } = fullHistoricalManifest(f, owner);
  const originalWire = fs.readFileSync(wireFile);
  const result = abortUnstartedSuccessor(f.client, f.approvalFile, true, {
    withdrawUnknown: true,
    processDeathProofFile: f.proofFile,
  });
  assert.equal(result["sdkRequestsSent"], 1);
  assert.equal(result["historicalOutcome"], "unknown");
  assert.deepEqual(fs.readFileSync(wireFile), originalWire);
  assert.notEqual(owner.nonce, f.nonce);
  assert.ok(Object.keys(manifest).length > 2);
});

test("real SDK1 helper receipt permits operator withdrawal of only its own retired synthetic worker", async (t) => {
  const f = sdkSubmittedUnknownFixture(t);
  const worker = spawn(
    process.execPath,
    [
      path.join(
        f.approval.candidateRoot,
        "src/queue-epoch-successor-worker.js",
      ),
    ],
    { stdio: ["pipe", "ignore", "ignore"] },
  );
  await once(worker, "spawn");
  assert.ok(worker.pid);
  t.after(async () => {
    if (worker.exitCode === null && worker.signalCode === null) {
      const exited = once(worker, "exit");
      worker.stdin.end();
      await exited;
    }
  });
  const owner = {
    pid: worker.pid,
    birth: api.processBirth(worker.pid),
    nonce: randomUUID(),
    protocol: 2,
  };
  api.durable(path.join(f.audit, "worker-claim.json"), {
    pid: owner.pid,
    birth: owner.birth,
    nonce: f.nonce,
  });
  api.durable(path.join(f.dir, "broker.lock"), owner);
  fullHistoricalManifest(f, owner);
  const { retireSdk1MetadataWorker } = load(
    "../dist/src/dist/composition/queue-epoch-successor-retirement.js",
  ) as typeof import("../src/composition/queue-epoch-successor-retirement");
  const status = {
    buildHash: f.authority.buildHash,
    sourceCommit: f.authority.sourceCommit,
    held: "Qualified isolated scratch process is unavailable; metadata only, no SDK or replacement authority",
    stopping: false,
    deadEpochSuccessor: {
      requestId: f.requestId,
      currentFactsAvailable: false,
      expectedProcess: f.authority.expectedProcess,
    },
    features: {
      auditFactsCapture: false,
      atomicRecoveryProcessLossAudit: false,
    },
    control: {
      instanceId: owner.nonce,
      buildHash: f.authority.buildHash,
      activeOperations: 0,
      activeIds: [],
      unresolved: true,
      phase: "RECOVERY_BLOCKED",
    },
  };
  const client = {
    ...f.client,
    async call(action: "queue-summary") {
      assert.equal(action, "queue-summary");
      return structuredClone(status);
    },
  };
  const protectedFiles = [
    f.approvalFile,
    path.join(f.audit, "authority.json"),
    ...["intent.json", "start.json", "wire.json", "result.json"].map((n) =>
      path.join(f.observation, n),
    ),
  ];
  const original = protectedFiles.map((file) => fs.readFileSync(file));
  const exited = once(worker, "exit");
  const retirement = await retireSdk1MetadataWorker(
    client,
    f.approvalFile,
    f.proofFile,
    true,
    {
      certify(runtime) {
        assert.equal(runtime, f.approval.candidateRoot);
      },
      deathQuery(expected) {
        return {
          state: "absent",
          pid: expected.pid,
          observedAtUtc: new Date().toISOString(),
          errorId:
            "NoProcessFoundForGivenId,Microsoft.PowerShell.Commands.GetProcessCommand",
        };
      },
    },
  );
  const [, signal] = await exited;
  assert.equal(signal, "SIGKILL");
  assert.ok("kind" in retirement);
  assert.equal(retirement.kind, "sdk1-metadata-worker-retirement-complete");
  assert.equal(retirement.sdkRequestsSent, 1);
  assert.equal(retirement.nativeOutcome, "unknown");
  const result = abortUnstartedSuccessor(f.client, f.approvalFile, true, {
    withdrawUnknown: true,
    processDeathProofFile: f.proofFile,
  });
  assert.equal(result["sdkRequestsSent"], 1);
  assert.equal(result["status"], "withdrawn");
  assert.equal(result["historicalOutcome"], "unknown");
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(f.dir, "broker.lock"), "utf8")),
    f.previousOwner,
  );
  for (const [i, file] of protectedFiles.entries())
    assert.deepEqual(fs.readFileSync(file), original[i]);
});

test("FAKE dead SDK proof: an unavailable Windows observer still refuses withdrawal", (t) => {
  const f = sdkSubmittedUnknownFixture(t),
    observe = api.priorProcessAlive;
  t.mock.method(api, "priorProcessAlive", (value: unknown) =>
    value &&
    typeof value === "object" &&
    "pid" in value &&
    "birth" in value &&
    value.pid === 3332 &&
    value.birth === "134391194634692184"
      ? null
      : observe(value),
  );
  assert.throws(
    () =>
      abortUnstartedSuccessor(f.client, f.approvalFile, true, {
        withdrawUnknown: true,
        processDeathProofFile: f.proofFile,
      }),
    /Unchanged predecessor and original dead-process authority required/,
  );
  assert.equal(fs.existsSync(path.join(f.audit, "abort-unstarted")), false);
});

for (const invalid of [
  "persistent",
  "extra-argument",
  "unknown-tool",
  "missing-code",
  "changed-source",
]) {
  test(
    "historical SDK1 wire refuses " +
      invalid +
      " even with repinned death-proof refs",
    (t) => {
      const f = sdkSubmittedUnknownFixture(t);
      const args: Record<string, unknown> = {
        code: "synthetic bound read-only script",
        persistent: false,
      };
      if (invalid === "persistent") args["persistent"] = true;
      if (invalid === "extra-argument") args["unsafe"] = true;
      if (invalid === "missing-code") delete args["code"];
      if (invalid === "changed-source")
        args["code"] = "changed source without its original artifact";
      const wire = {
        ...f.wire,
        outgoing: {
          ...f.wire.outgoing,
          params: {
            name:
              invalid === "unknown-tool"
                ? "another_python_tool"
                : "execute_python",
            arguments: args,
          },
        },
      };
      api.durable(path.join(f.observation, "wire.json"), wire);
      refreshSdkDeathBindings(f);
      assert.throws(() =>
        abortUnstartedSuccessor(f.client, f.approvalFile, true, {
          withdrawUnknown: true,
          processDeathProofFile: f.proofFile,
        }),
      );
      assert.equal(fs.existsSync(path.join(f.audit, "abort-unstarted")), false);
    },
  );
}

test("new withdrawal evaluator does not import its verifier from the historical runtime", (t) => {
  const f = sdkSubmittedUnknownFixture(t);
  const target = path.join(f.base, "old-runtime");
  fs.mkdirSync(path.join(target, "src"), { recursive: true });
  for (const name of [
    "queue-instance",
    "queue-atomic-migration-files",
    "queue-epoch-lineage",
  ])
    fs.writeFileSync(
      path.join(target, "src", name + ".js"),
      "module.exports = require(" +
        JSON.stringify(path.join(repo, "src", name + ".js")) +
        ");\n",
    );
  fs.writeFileSync(
    path.join(target, "src", "queue-epoch-successor.js"),
    "throw new Error('Historical runtime has no death-proof verifier');\n",
  );
  const approval = JSON.parse(fs.readFileSync(f.approvalFile, "utf8"));
  approval.candidateRoot = target;
  api.durable(f.approvalFile, approval);
  const intentFile = path.join(f.audit, "intent.json");
  const intent = JSON.parse(fs.readFileSync(intentFile, "utf8"));
  intent.approval = reference(f.approvalFile);
  api.durable(intentFile, intent);
  const authority = JSON.parse(fs.readFileSync(f.authorityEntry.path, "utf8"));
  authority.candidateRoot = target;
  api.durable(f.authorityEntry.path, authority);
  const authorityRef = reference(f.authorityEntry.path);
  api.durable(path.join(f.dir, "active-epoch-succession.json"), {
    version: 1,
    authority: authorityRef,
  });
  for (const name of ["complete.json", "launch-intent.json"]) {
    const file = path.join(f.audit, name);
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    value.authority = authorityRef;
    api.durable(file, value);
  }
  const observationIntentFile = path.join(f.observation, "intent.json");
  const observationIntent = JSON.parse(
    fs.readFileSync(observationIntentFile, "utf8"),
  );
  observationIntent.binding.successorAuthorityHash = authorityRef.sha256;
  api.durable(observationIntentFile, observationIntent);
  const proof = JSON.parse(fs.readFileSync(f.proofFile, "utf8"));
  proof.bindings.authority = authorityRef;
  proof.bindings.observationIntent = reference(observationIntentFile);
  api.durable(f.proofFile, proof);
  const before = fs.readFileSync(f.approvalFile);
  const preview = abortUnstartedSuccessor(f.client, f.approvalFile, false, {
    withdrawUnknown: true,
    processDeathProofFile: f.proofFile,
  });
  assert.equal(preview["sdkRequestsSent"], 1);
  assert.ok("operation" in preview);
  assert.equal(preview["operation"], "withdraw-after-sdk-unknown");
  assert.deepEqual(fs.readFileSync(f.approvalFile), before);
});

function writeSdk1RetirementReceipt(f: {
  audit: string;
  clientId: string;
  dir: string;
  owner: unknown;
  proofFile: string;
  requestId: string;
}) {
  api.durable(path.join(f.dir, "broker.lock"), f.owner);
  const journal = path.join(f.audit, "sdk1-worker-retirement");
  fs.mkdirSync(journal);
  const beforeFile = path.join(journal, "before.json");
  api.durable(beforeFile, {
    synthetic: true,
    owner: f.owner,
    sdkRequestsSent: 1,
    nativeOutcome: "unknown",
  });
  const startFile = path.join(journal, "effect-start.json");
  api.durable(startFile, { before: reference(beforeFile), owner: f.owner });
  const afterFile = path.join(journal, "after.json");
  api.durable(afterFile, {
    kind: "sdk1-metadata-worker-retirement-complete",
    status: "retired",
    requestId: f.requestId,
    clientId: f.clientId,
    owner: f.owner,
    before: reference(beforeFile),
    effectStart: reference(startFile),
    processDeathProof: reference(f.proofFile),
    protectedBytesUnchanged: true,
    sdkRequestsSent: 1,
    nativeOutcome: "unknown",
    historicalOutcome: "unknown",
  });
  return { afterFile, beforeFile, startFile };
}

function sdk1RetirementReceiptFixture(t: TestContext) {
  const f = sdkSubmittedUnknownFixture(t);
  return { ...f, ...writeSdk1RetirementReceipt(f) };
}

test("SDK1 withdrawal restores only the exact dead metadata marker after its separate retirement receipt", (t) => {
  const f = sdk1RetirementReceiptFixture(t);
  const retained = fs.readFileSync(f.afterFile);
  const result = abortUnstartedSuccessor(f.client, f.approvalFile, true, {
    withdrawUnknown: true,
    processDeathProofFile: f.proofFile,
  });
  assert.equal(result["sdkRequestsSent"], 1);
  assert.equal(result["historicalOutcome"], "unknown");
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(f.dir, "broker.lock"), "utf8")),
    f.previousOwner,
  );
  assert.deepEqual(
    JSON.parse(
      fs.readFileSync(
        path.join(f.audit, "abort-unstarted", "retired-metadata-owner.json"),
        "utf8",
      ),
    ),
    f.owner,
  );
  assert.deepEqual(fs.readFileSync(f.afterFile), retained);
});

for (const changed of [
  "sdk0-claim",
  "foreign-owner",
  "wrong-death-proof",
  "changed-before",
  "pending-after",
  "live-worker",
]) {
  test(
    "SDK1 marker restoration refuses " +
      changed +
      " without changing the marker",
    (t) => {
      const f = sdk1RetirementReceiptFixture(t);
      const after = JSON.parse(fs.readFileSync(f.afterFile, "utf8"));
      if (changed === "sdk0-claim") after.sdkRequestsSent = 0;
      if (changed === "foreign-owner")
        after.owner = { ...f.owner, nonce: "foreign-owner" };
      if (changed === "wrong-death-proof")
        after.processDeathProof.sha256 = "0".repeat(64);
      if (changed === "changed-before")
        api.durable(f.beforeFile, { changed: true });
      if (changed === "live-worker") {
        const observe = api.priorProcessAlive;
        t.mock.method(api, "priorProcessAlive", (value: unknown) =>
          JSON.stringify(value) === JSON.stringify(f.worker)
            ? true
            : observe(value),
        );
      }
      api.durable(f.afterFile, after);
      if (changed === "pending-after") fs.unlinkSync(f.afterFile);
      const marker = fs.readFileSync(path.join(f.dir, "broker.lock"));
      assert.throws(() =>
        abortUnstartedSuccessor(f.client, f.approvalFile, true, {
          withdrawUnknown: true,
          processDeathProofFile: f.proofFile,
        }),
      );
      assert.deepEqual(
        fs.readFileSync(path.join(f.dir, "broker.lock")),
        marker,
      );
      assert.equal(fs.existsSync(path.join(f.audit, "abort-unstarted")), false);
    },
  );
}

test("SDK1 worker retirement CLI requires separate flags and has no caller ports seam", () => {
  const script = path.join(repo, "scripts/abort-unstarted-successor.cjs");
  for (const flag of [
    "--preflight-retire-sdk1",
    "--confirm-retire-sdk1-metadata-worker",
  ]) {
    const args = [
      script,
      "--approval",
      "/missing-sdk1-original-approval",
      "--sdk-process-death-proof",
      "/missing-sdk1-process-proof",
      flag,
      "true",
    ];
    const accepted = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.notEqual(accepted.status, 0);
    assert.match(accepted.stderr, /ENOENT/);
    assert.doesNotMatch(accepted.stderr, /Use --approval FILE/);
    const injected = spawnSync(
      process.execPath,
      [...args, "--ports", "unsafe"],
      { encoding: "utf8" },
    );
    assert.notEqual(injected.status, 0);
    assert.match(injected.stderr, /Use --approval FILE/);
  }
});

test("SDK0 restoration cannot borrow an SDK1 retirement journal", (t) => {
  const f = readyFixture(t);
  fs.mkdirSync(path.join(f.audit, "sdk1-worker-retirement"));
  assert.throws(
    () => abortUnstartedSuccessor(f.client, f.approvalFile, true),
    /SDK1 retirement journal cannot qualify an SDK0 attempt/,
  );
  assert.equal(fs.existsSync(path.join(f.audit, "abort-unstarted")), false);
});

test("FAKE retirement protocol: preview has no effect, explicit effect appends before/after, restoration retains original unknown", async (t) => {
  const f = retirementFixture(t);
  const before = fs.readFileSync(f.authority.predecessor.rootState.path);
  const preview = await retireMetadataWorker(
    f.client,
    f.approvalFile,
    f.proofFile,
    false,
    f.ports,
  );
  assert.ok("retirementPerformed" in preview);
  assert.equal(preview["retirementPerformed"], false);
  assert.equal(f.counts().signals, 0);
  const result = await retireMetadataWorker(
    f.client,
    f.approvalFile,
    f.proofFile,
    true,
    f.ports,
  );
  assert.equal(result["retired"], true);
  assert.equal(result["gracefulClose"], false);
  assert.equal(f.counts().signals, 1);
  assert.ok(f.counts().fusionReads >= 4);
  assert.deepEqual(
    await retireMetadataWorker(
      f.client,
      f.approvalFile,
      f.proofFile,
      true,
      f.ports,
    ),
    result,
  );
  assert.equal(f.counts().signals, 1);
  const aborted = abortUnstartedSuccessor(f.client, f.approvalFile, true);
  assert.equal(aborted["status"], "aborted");
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(f.dir, "broker.lock"), "utf8")),
    f.previousOwner,
  );
  assert.deepEqual(
    fs.readFileSync(f.authority.predecessor.rootState.path),
    before,
  );
});

for (const reason of [
  "proof-gap",
  "source-certification",
  "pid-birth",
  "active-operation",
  "current-facts",
  "fusion-before",
  "source-drift",
  "late-status",
]) {
  test(
    "FAKE retirement protocol refuses " + reason + " before any signal",
    async (t) => {
      const f = retirementFixture(t);
      if (reason === "proof-gap")
        api.durable(f.proofFile, { ...f.proof, proofGaps: ["unproven port"] });
      if (reason === "source-certification")
        f.ports.certify = () => {
          throw new Error("Unknown runtime closure");
        };
      if (reason === "pid-birth") f.process.birth = "different";
      if (reason === "active-operation") f.control.activeOperations = 1;
      if (reason === "current-facts")
        f.status.deadEpochSuccessor.currentFactsAvailable = true;
      if (reason === "fusion-before")
        f.ports.fusion = () => ({ ...f.proof.fusion, birth: "different" });
      if (reason === "source-drift")
        fs.appendFileSync(f.process.exe, "changed");
      if (reason === "late-status") {
        const call = f.client.call;
        let count = 0;
        f.client.call = async (action) => {
          if (++count > 2) f.control.activeOperations = 1;
          return call(action);
        };
      }
      await assert.rejects(
        retireMetadataWorker(
          f.client,
          f.approvalFile,
          f.proofFile,
          true,
          f.ports,
        ),
      );
      assert.equal(f.counts().signals, 0);
    },
  );
}

test("FAKE retirement protocol: an interrupted signal is never replayed and failed Fusion post-proof remains pending", async (t) => {
  const f = retirementFixture(t),
    process = f.ports.process;
  f.ports.process = (...args) => {
    const result = process(...args);
    if (args[3]) throw new Error("Unknown signal response after effect");
    return result;
  };
  await assert.rejects(
    retireMetadataWorker(f.client, f.approvalFile, f.proofFile, true, f.ports),
    /Unknown signal/,
  );
  assert.equal(f.counts().signals, 1);
  f.ports.fusion = () => {
    throw new Error("Fresh Fusion OS unavailable");
  };
  await assert.rejects(
    retireMetadataWorker(f.client, f.approvalFile, f.proofFile, true, f.ports),
    /Fusion OS unavailable/,
  );
  assert.equal(
    fs.existsSync(
      path.join(f.audit, "abort-unstarted", "retirement-after.json"),
    ),
    false,
  );
  assert.equal(f.counts().signals, 1);
  f.setAlive(true);
  await assert.rejects(
    retireMetadataWorker(f.client, f.approvalFile, f.proofFile, true, f.ports),
    /never repeat a signal/,
  );
  assert.equal(f.counts().signals, 1);
});

test("FAKE metadata-ready: terminal observation rejection SDK0 permits explicit retirement without rewriting ready/history", (t) => {
  const f = readyFixture(t);
  const names = [
    "authority.json",
    "worker-ready.json",
    "complete.json",
    "dead-epoch-current-observation/intent.json",
    "dead-epoch-current-observation/result.json",
  ];
  const before = names.map((name) => fs.readFileSync(path.join(f.audit, name)));
  const preview = abortUnstartedSuccessor(f.client, f.approvalFile, false);
  assert.ok("reason" in preview);
  assert.equal(
    preview["reason"],
    "metadata-ready-observation-rejected-before-sdk",
  );
  const result = abortUnstartedSuccessor(f.client, f.approvalFile, true);
  assert.equal(result["status"], "aborted");
  assert.ok("reason" in result);
  assert.equal(
    result["reason"],
    "metadata-ready-observation-rejected-before-sdk",
  );
  for (const [i, name] of names.entries())
    assert.deepEqual(fs.readFileSync(path.join(f.audit, name)), before[i]);
  assert.deepEqual(
    abortUnstartedSuccessor(f.client, f.approvalFile, true),
    result,
  );
});

test("FAKE dead SDK proof: explicit SDK1 withdrawal preserves unknown and original evidence", (t) => {
  const f = sdkSubmittedUnknownFixture(t),
    options = {
      withdrawUnknown: true,
      processDeathProofFile: f.proofFile,
    },
    originalFiles = [
      path.join(f.audit, "authority.json"),
      path.join(f.audit, "complete.json"),
      path.join(f.observation, "intent.json"),
      path.join(f.observation, "start.json"),
      path.join(f.observation, "wire.json"),
      path.join(f.observation, "result.json"),
    ],
    before = originalFiles.map((file) => fs.readFileSync(file));
  const preview = abortUnstartedSuccessor(
    f.client,
    f.approvalFile,
    false,
    options,
  );
  assert.ok("operation" in preview);
  assert.equal(preview["operation"], "withdraw-after-sdk-unknown");
  assert.equal(preview["sdkRequestsSent"], 1);
  assert.equal(preview["historicalOutcome"], "unknown");
  assert.equal(preview["applyReady"], true);
  const result = abortUnstartedSuccessor(
    f.client,
    f.approvalFile,
    true,
    options,
  ) as Record<string, unknown>;
  assert.equal(
    result["kind"],
    "dead-epoch-successor-withdrawn-after-sdk-unknown",
  );
  assert.equal(result["status"], "withdrawn");
  assert.equal(result["sdkRequestsSent"], 1);
  assert.equal(result["nativeOutcome"], "unknown");
  assert.equal(result["historicalOutcome"], "unknown");
  assert.deepEqual(result["processDeathProof"], reference(f.proofFile));
  for (const [i, file] of originalFiles.entries())
    assert.deepEqual(fs.readFileSync(file), before[i]);
  assert.deepEqual(
    abortUnstartedSuccessor(f.client, f.approvalFile, true, options),
    result,
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(f.dir, "broker.lock"), "utf8")),
    f.previousOwner,
  );
  assert.equal(
    fs.existsSync(path.join(f.dir, "active-epoch-succession.json")),
    false,
  );
});

test("SDK1 CLI withdrawal requires its dedicated confirmation and exact proof argument", (t) => {
  const f = sdkSubmittedUnknownFixture(t),
    cli = path.join(repo, "scripts/abort-unstarted-successor.cjs"),
    missingApproval = path.join(f.base, "missing-approval.json"),
    missingProof = spawnSync(
      process.execPath,
      [
        cli,
        "--approval",
        missingApproval,
        "--confirm-withdraw-unknown",
        "true",
      ],
      { encoding: "utf8" },
    ),
    explicitProof = spawnSync(
      process.execPath,
      [
        cli,
        "--approval",
        missingApproval,
        "--sdk-process-death-proof",
        f.proofFile,
        "--confirm-withdraw-unknown",
        "true",
      ],
      { encoding: "utf8" },
    );
  assert.notEqual(missingProof.status, 0);
  assert.match(missingProof.stderr, /Use --approval FILE/);
  assert.notEqual(explicitProof.status, 0);
  assert.match(explicitProof.stderr, /ENOENT/);
  assert.doesNotMatch(explicitProof.stderr, /Use --approval FILE/);
});

for (const reason of [
  "missing-proof",
  "tampered-proof",
  "wrong-pid",
  "wrong-birth",
  "future-absence",
  "nonfinal-result",
  "response-receipt",
  "foreign-owner",
  "active-worker",
  "implicit-withdrawal",
]) {
  test("FAKE dead SDK proof: SDK1 withdrawal refuses " + reason, (t) => {
    const f = sdkSubmittedUnknownFixture(t),
      original = api.priorProcessAlive,
      options = {
        withdrawUnknown: true,
        processDeathProofFile: f.proofFile,
      };
    if (
      reason === "tampered-proof" ||
      reason === "wrong-pid" ||
      reason === "wrong-birth" ||
      reason === "future-absence"
    ) {
      const proof = JSON.parse(fs.readFileSync(f.proofFile, "utf8")) as {
        bindings: { observationWire: { sha256: string } };
        before: { pid: number };
        handleBoundExit: { birth: string };
        after: { observedAtUtc: string };
      };
      if (reason === "tampered-proof")
        proof["bindings"]["observationWire"]["sha256"] = "0".repeat(64);
      if (reason === "wrong-pid") proof["before"]["pid"] += 1;
      if (reason === "wrong-birth")
        proof["handleBoundExit"]["birth"] = "reused-birth";
      if (reason === "future-absence")
        proof["after"]["observedAtUtc"] = new Date(
          Date.now() + 60_000,
        ).toISOString();
      api.durable(f.proofFile, proof);
    }
    if (reason === "nonfinal-result") {
      const file = path.join(f.observation, "result.json"),
        result = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
          string,
          unknown
        >;
      api.durable(file, { ...result, status: "pending" });
    }
    if (reason === "response-receipt")
      api.durable(f.start.receipt, { received: true });
    if (reason === "foreign-owner") f.client.auth.clientToken = "foreign";
    if (reason === "active-worker") {
      t.mock.method(api, "priorProcessAlive", (value: unknown) =>
        JSON.stringify(value) === JSON.stringify(f.worker)
          ? true
          : original(value),
      );
    }
    assert.throws(() =>
      abortUnstartedSuccessor(
        f.client,
        f.approvalFile,
        true,
        reason === "implicit-withdrawal"
          ? undefined
          : reason === "missing-proof"
            ? { withdrawUnknown: true }
            : options,
      ),
    );
    assert.equal(fs.existsSync(path.join(f.audit, "abort-unstarted")), false);
    assert.equal(
      fs.existsSync(path.join(f.dir, "active-epoch-succession.json")),
      true,
    );
  });
}

test("FAKE metadata-ready: preview identifies the live exact owner but apply cannot signal or retire it", (t) => {
  const f = readyFixture(t),
    original = api.priorProcessAlive;
  t.mock.method(api, "priorProcessAlive", (value: unknown) =>
    JSON.stringify(value) === JSON.stringify(f.worker) ? true : original(value),
  );
  api.durable(path.join(f.dir, "broker.lock"), f.owner);
  const preview = abortUnstartedSuccessor(f.client, f.approvalFile, false);
  assert.ok("requiresWorkerRetirement" in preview);
  assert.equal(preview["requiresWorkerRetirement"], true);
  assert.ok("applyReady" in preview);
  assert.equal(preview["applyReady"], false);
  assert.throws(
    () => abortUnstartedSuccessor(f.client, f.approvalFile, true),
    /proven dead/,
  );
  assert.equal(fs.existsSync(path.join(f.audit, "abort-unstarted")), false);
});

test("FAKE metadata-ready: a new owner-approved successor must link the exact retired attempt and retain its result", (t) => {
  t.after((load("./fixtures/fake-wsl-platform.cjs") as () => () => void)());
  const f = readyFixture(t);
  abortUnstartedSuccessor(f.client, f.approvalFile, true);
  api.durable(
    path.join(f.dir, "broker-lifecycle-" + f.previousOwner.nonce + ".json"),
    f.inspection.previousLifecycle,
  );
  const requestId = "new-qualified-attempt-" + randomUUID();
  const approvalFile = path.join(f.base, "new-approval.json");
  const approval = {
    ...f.approval,
    requestId,
    priorAbortedSuccessor: reference(
      path.join(f.audit, "abort-unstarted", "complete.json"),
    ),
  };
  const before = fs.readFileSync(path.join(f.observation, "result.json"));
  api.durable(approvalFile, approval);
  assert.equal(
    inspectSuccessor(f.client, f.cfg, approvalFile, requestId).requestId,
    requestId,
  );
  const missing = { ...approval };
  delete (missing as Partial<typeof approval>).priorAbortedSuccessor;
  api.durable(approvalFile, missing);
  assert.throws(
    () => inspectSuccessor(f.client, f.cfg, approvalFile, requestId),
    { code: "EPOCH_SUCCESSOR_ABORT_REQUIRED" },
  );
  api.durable(approvalFile, {
    ...approval,
    priorAbortedSuccessor: {
      ...approval.priorAbortedSuccessor,
      sha256: "0".repeat(64),
    },
  });
  assert.throws(
    () => inspectSuccessor(f.client, f.cfg, approvalFile, requestId),
    { code: "EPOCH_SUCCESSOR_ABORT_INVALID" },
  );
  api.durable(approvalFile, approval);
  fs.appendFileSync(path.join(f.observation, "result.json"), " ");
  assert.throws(
    () => inspectSuccessor(f.client, f.cfg, approvalFile, requestId),
    { code: "EPOCH_SUCCESSOR_ABORT_INVALID" },
  );
  assert.deepEqual(
    fs
      .readFileSync(path.join(f.observation, "result.json"))
      .subarray(0, before.length),
    before,
  );
});

test("FAKE dead SDK proof: a new owner-approved successor links the SDK1 withdrawal without reusing its process identity", (t) => {
  t.after((load("./fixtures/fake-wsl-platform.cjs") as () => () => void)());
  const f = sdkSubmittedUnknownFixture(t),
    options = {
      withdrawUnknown: true,
      processDeathProofFile: f.proofFile,
    };
  abortUnstartedSuccessor(f.client, f.approvalFile, true, options);
  api.durable(
    path.join(f.dir, "broker-lifecycle-" + f.previousOwner.nonce + ".json"),
    f.inspection.previousLifecycle,
  );
  const requestId = "new-qualified-attempt-" + randomUUID(),
    approvalFile = path.join(f.base, "new-approval.json"),
    nextProcess = { pid: process.pid, birth: api.processBirth() },
    approval = {
      ...f.approval,
      requestId,
      expectedProcess: nextProcess,
      priorRetiredSuccessor: reference(
        path.join(f.audit, "abort-unstarted", "complete.json"),
      ),
    };
  api.durable(approvalFile, approval);
  assert.equal(
    inspectSuccessor(f.client, f.cfg, approvalFile, requestId).requestId,
    requestId,
  );

  const missing = { ...approval };
  delete (missing as Partial<typeof approval>).priorRetiredSuccessor;
  api.durable(approvalFile, missing);
  assert.throws(
    () => inspectSuccessor(f.client, f.cfg, approvalFile, requestId),
    { code: "EPOCH_SUCCESSOR_ABORT_REQUIRED" },
  );

  api.durable(approvalFile, {
    ...approval,
    priorRetiredSuccessor: {
      ...approval.priorRetiredSuccessor,
      sha256: "0".repeat(64),
    },
  });
  assert.throws(
    () => inspectSuccessor(f.client, f.cfg, approvalFile, requestId),
    { code: "EPOCH_SUCCESSOR_ABORT_INVALID" },
  );

  const original = api.priorProcessAlive;
  t.mock.method(api, "priorProcessAlive", (value: unknown) => {
    if (
      value &&
      typeof value === "object" &&
      "pid" in value &&
      (value.pid === f.authority.expectedProcess.pid ||
        ("birth" in value && value.birth === f.authority.expectedProcess.birth))
    )
      return true;
    return original(value);
  });
  api.durable(approvalFile, {
    ...approval,
    expectedProcess: {
      pid: f.authority.expectedProcess.pid,
      birth: "different-birth",
    },
  });
  assert.throws(
    () => inspectSuccessor(f.client, f.cfg, approvalFile, requestId),
    { code: "EPOCH_SUCCESSOR_ABORT_INVALID" },
  );
  api.durable(approvalFile, {
    ...approval,
    expectedProcess: {
      pid: f.authority.expectedProcess.pid + 1,
      birth: f.authority.expectedProcess.birth,
    },
  });
  assert.throws(
    () => inspectSuccessor(f.client, f.cfg, approvalFile, requestId),
    { code: "EPOCH_SUCCESSOR_ABORT_INVALID" },
  );
});

for (const reason of [
  "sdk-sent",
  "missing-result",
  "unknown-result",
  "start",
  "wire",
  "remote",
  "facts",
  "scratch",
  "pending",
  "guard",
  "marker",
  "owner",
  "ready-build",
  "complete-source",
  "binding",
  "released-guard",
]) {
  test("FAKE metadata-ready: retirement refuses " + reason, (t) => {
    const f = readyFixture(t);
    const resultFile = path.join(f.observation, "result.json");
    const result = JSON.parse(fs.readFileSync(resultFile, "utf8")) as Record<
      string,
      unknown
    >;
    if (reason === "sdk-sent")
      api.durable(resultFile, { ...result, sdkRequestsSent: 1 });
    if (reason === "missing-result") fs.unlinkSync(resultFile);
    if (reason === "unknown-result")
      api.durable(resultFile, { ...result, status: "unknown" });
    if (["start", "wire", "remote"].includes(reason))
      api.durable(path.join(f.observation, reason + ".json"), {});
    if (reason === "facts")
      api.durable(path.join(f.audit, "observed-current.json"), {});
    if (reason === "scratch")
      fs.mkdirSync(path.join(f.audit, "isolated-scratch-qualification"));
    if (reason === "pending")
      api.durable(path.join(f.dir, "queue-state.pending.json"), {});
    if (reason === "guard")
      api.durable(path.join(f.dir, "recovery.lock"), f.guard);
    if (reason === "marker")
      api.durable(path.join(f.dir, "broker.lock"), f.owner);
    if (reason === "owner") f.client.auth.clientToken = "foreign";
    if (reason === "ready-build")
      api.durable(path.join(f.audit, "worker-ready.json"), {
        nonce: f.nonce,
        owner: f.owner,
        buildHash: "foreign",
        sdkRequestsSent: 0,
      });
    if (reason === "complete-source") {
      const file = path.join(f.audit, "complete.json");
      api.durable(file, {
        ...JSON.parse(fs.readFileSync(file, "utf8")),
        sourceCommit: "foreign",
      });
    }
    if (reason === "binding") {
      const file = path.join(f.observation, "intent.json");
      api.durable(file, {
        ...JSON.parse(fs.readFileSync(file, "utf8")),
        binding: {},
      });
    }
    if (reason === "released-guard")
      api.durable(path.join(f.audit, "released-recovery.lock.json"), {});
    assert.throws(() =>
      abortUnstartedSuccessor(f.client, f.approvalFile, true),
    );
    assert.equal(fs.existsSync(path.join(f.audit, "abort-unstarted")), false);
  });
}

test("FAKE metadata: preflight and owner SDK0 abort preserve predecessor/unknown and retain the rejected attempt", (t) => {
  const f = fixture(t);
  const protectedFiles = [
    f.authority.predecessor.pointer.path,
    f.authority.predecessor.state.path,
    f.authority.predecessor.identity.path,
    f.authority.predecessor.rootState.path,
    f.authority.predecessor.rootIdentity.path,
    path.join(f.audit, "authority.json"),
    path.join(f.audit, "worker-error.json"),
  ];
  const before = protectedFiles.map((file) => fs.readFileSync(file));
  const preflight = abortUnstartedSuccessor(f.client, f.approvalFile, false);
  assert.ok("ready" in preflight);
  assert.equal(preflight["ready"], true);
  assert.equal(fs.existsSync(path.join(f.audit, "abort-unstarted")), false);
  const complete = abortUnstartedSuccessor(f.client, f.approvalFile, true);
  assert.equal(complete["status"], "aborted");
  assert.equal(complete["sdkRequestsSent"], 0);
  assert.equal(complete["historicalOutcome"], "unknown");
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(f.dir, "broker.lock"), "utf8")),
    f.previousOwner,
  );
  for (const name of [
    "recovery.lock",
    "atomic-migration.lock",
    "active-epoch-succession.json",
  ])
    assert.equal(fs.existsSync(path.join(f.dir, name)), false);
  for (const [i, file] of protectedFiles.entries())
    assert.deepEqual(fs.readFileSync(file), before[i]);
  // A later owner does not let an observation of the original receipt change global state.
  api.durable(path.join(f.dir, "broker.lock"), { later: "owner" });
  assert.deepEqual(
    abortUnstartedSuccessor(f.client, f.approvalFile, true),
    complete,
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(f.dir, "broker.lock"), "utf8")),
    { later: "owner" },
  );
});

test("FAKE metadata: the selected process may have exited after rejected SDK0 startup", (t) => {
  const f = fixture(t);
  const original = api.priorProcessAlive;
  t.mock.method(api, "priorProcessAlive", (value: unknown) =>
    JSON.stringify(value) === JSON.stringify(f.authority.expectedProcess)
      ? false
      : original(value),
  );
  assert.equal(
    abortUnstartedSuccessor(f.client, f.approvalFile, true)["status"],
    "aborted",
  );
});

test("FAKE metadata: interrupted guard release resumes only the original abort", (t) => {
  const f = fixture(t);
  const unlink = fs.unlinkSync;
  const interruption = t.mock.method(fs, "unlinkSync", (file: fs.PathLike) => {
    unlink(file);
    if (file === path.join(f.dir, "atomic-migration.lock"))
      throw new Error("Synthetic interruption after first guard release");
  });
  assert.throws(
    () => abortUnstartedSuccessor(f.client, f.approvalFile, true),
    /Synthetic interruption/,
  );
  interruption.mock.restore();
  assert.equal(fs.existsSync(path.join(f.dir, "atomic-migration.lock")), false);
  assert.equal(fs.existsSync(path.join(f.dir, "recovery.lock")), true);
  assert.equal(
    abortUnstartedSuccessor(f.client, f.approvalFile, true)["status"],
    "aborted",
  );
});

test("FAKE metadata: relocated approval must retain exactly the approved bytes", (t) => {
  const f = fixture(t);
  const copy = path.join(f.base, "relocated-approval.json");
  fs.copyFileSync(f.approvalFile, copy);
  assert.equal(
    abortUnstartedSuccessor(f.client, copy, true)["status"],
    "aborted",
  );
});

for (const reason of [
  "owner",
  "approval",
  "worker",
  "lifecycle",
  "probe",
  "ready",
  "sdk",
  "guard",
  "pointer",
  "marker",
  "authority",
]) {
  test("FAKE metadata: abort refuses " + reason + " evidence", (t) => {
    const f = fixture(t);
    if (reason === "owner") f.client.auth.clientToken = "b".repeat(64);
    if (reason === "authority") {
      api.durable(path.join(f.audit, "authority.json"), {
        ...f.authority,
        expectedProcess: { pid: 2147483643, birth: "different" },
      });
      const entry = reference(path.join(f.audit, "authority.json"));
      api.durable(path.join(f.dir, "active-epoch-succession.json"), {
        version: 1,
        authority: entry,
      });
      api.durable(path.join(f.audit, "launch-intent.json"), {
        nonce: f.nonce,
        authority: entry,
      });
    }
    if (reason === "approval") fs.appendFileSync(f.approvalFile, " ");
    if (reason === "worker")
      api.durable(path.join(f.audit, "worker-claim.json"), {
        pid: process.pid,
        birth: api.processBirth(),
        nonce: f.nonce,
      });
    if (reason === "lifecycle")
      api.durable(f.lifecycleFile, { ...f.lifecycle, safeToRecover: false });
    if (reason === "probe") api.durable(f.receipt, { terminal: true });
    if (reason === "ready")
      api.durable(path.join(f.audit, "worker-ready.json"), { synthetic: true });
    if (reason === "sdk")
      fs.mkdirSync(path.join(f.audit, "dead-epoch-current-observation"));
    if (reason === "guard")
      api.durable(path.join(f.dir, "recovery.lock"), { other: "owner" });
    if (reason === "pointer")
      api.durable(path.join(f.dir, "isolated-admission-epoch.json"), {
        changed: true,
      });
    if (reason === "marker")
      api.durable(path.join(f.dir, "broker.lock"), {
        pid: process.pid,
        birth: api.processBirth(),
      });
    assert.throws(() =>
      abortUnstartedSuccessor(f.client, f.approvalFile, true),
    );
    assert.equal(fs.existsSync(path.join(f.audit, "abort-unstarted")), false);
    assert.equal(
      fs.existsSync(path.join(f.dir, "atomic-migration.lock")),
      true,
    );
  });
}

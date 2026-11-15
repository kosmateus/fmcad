import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";

const load = createRequire(__filename);
const api = load(
  "../src/dist/node-adapters/execution/recovery-audit",
) as typeof import("../packages/node-adapters/src/execution/recovery-audit");
const { preparePythonArtifact } = load(
  "../src/dist/python/artifact",
) as typeof import("../packages/node-adapters/src/python/artifact");
const { pythonArtifactManifest } = load(
  "../src/dist/python/context-binding",
) as typeof import("../packages/node-adapters/src/python/context-binding");
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const canonicalHash = (
  load("../src/dist/core/application/cad/json") as {
    hash(value: unknown): string;
  }
).hash;

function fixture(
  t: import("node:test").TestContext,
  override?: {
    directory: string;
    key: Record<string, string>;
    identity: unknown;
    binding: Record<string, unknown>;
    instance: { pid: number; birth: string };
    buildHash: string;
    source?: string;
    originHash?: string;
    sourceSha256?: string;
  },
) {
  const directory =
    override?.directory ??
    fs.mkdtempSync(path.join(os.tmpdir(), "retained-audit-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const put = (name: string, value: unknown) =>
    fs.writeFileSync(path.join(directory, name), JSON.stringify(value));
  const instance = override?.instance ?? {
      pid: 123456,
      birth: "synthetic-birth",
    },
    key = override?.key ?? {
      jobId: "synthetic-job",
      observationJobId: "synthetic-observer",
      requestId: "synthetic-successor:observe",
      clientId: "synthetic-owner",
    },
    identity = override?.identity ?? {
      resolvedIdentity: {
        creationId: "synthetic-historical-document",
        name: "synthetic-historical",
        fileId: null,
      },
    },
    binding = override?.binding ?? {
      purpose: "atomic-recovery-audit-v1",
      clientId: key["clientId"],
      expectedProcess: instance,
      successorAuthorityHash: "a".repeat(64),
    },
    source = override?.source ?? "print('synthetic read-only observation')",
    originHash = override?.originHash ?? "b".repeat(64),
    physical = {
      jobId: key["jobId"],
      rpcId: "synthetic-rpc",
      requestHash: "c".repeat(64),
      buildHash: override?.buildHash ?? "d".repeat(64),
      sourceHash: hash(source),
      purpose: binding["purpose"],
      auditBindingHash: canonicalHash(binding),
      pythonOriginHash: originHash,
      auditExpectedProcess: instance,
    },
    artifact = preparePythonArtifact(
      [{ id: "synthetic", filename: "synthetic.py", role: "user", source }],
      { request: physical, context: { origin: { artifactHash: originHash } } },
    ),
    outgoing = {
      jsonrpc: "2.0",
      id: "fmcad:" + physical.rpcId,
      method: "tools/call",
      params: {
        name: "fusion_mcp_execute",
        arguments: {
          featureType: "script",
          object: { script: artifact.script, readOnly: true },
        },
      },
    },
    summary = {
      version: 1,
      purpose: binding["purpose"],
      profile: "atomic-recovery-counts-v1",
      requestIdentity: identity,
      nativeOutcome: "unknown",
      modelValidation: "not_performed",
      rollbackVerification: "not_performed",
      modulePresent: false,
      ui: { activeCommand: "SelectCommand", idle: true },
      commandDefinition: { status: "absent" },
      document: { status: "absent", matches: 0 },
      snapshot: null,
      fingerprint: null,
    },
    reply = {
      jsonrpc: "2.0",
      id: outgoing.id,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              message: "FMCAD_RESULT " + JSON.stringify(summary) + "\n",
              success: true,
            }),
          },
        ],
      },
    };
  put("intent.json", {
    version: 1,
    key,
    binding,
    identity,
    sourceArtifactHash: originHash,
    sourceSha256: override?.sourceSha256 ?? hash(source),
  });
  put("start.json", {
    binding: physical,
    instance,
    receipt: path.join(directory, "remote-" + physical.rpcId + ".json"),
    pythonCheck: {
      status: "passed",
      provenance: {
        artifactHash: artifact.artifactHash,
        wireHash: artifact.sha256,
      },
    },
    originArtifactHash: originHash,
  });
  put("wire.json", { outgoing, artifact: pythonArtifactManifest(artifact) });
  put("received-response.json", {
    version: 1,
    binding: physical,
    wireId: outgoing.id,
    callerId: 2,
    status: 200,
    raw: JSON.stringify(reply),
  });
  put("remote-" + physical.rpcId + ".json", {
    ...physical,
    terminal: true,
    outcome: "succeeded",
    instance: {
      ...instance,
      version: "synthetic",
      activeCommand: "SelectCommand",
    },
  });
  put("result.json", {
    kind: "dead-epoch-current-observation",
    ...key,
    status: "failed",
    code: "AUDIT_OUTPUT_INVALID",
    sdkRequestsSent: 1,
    nativeOutcome: "unknown",
    modelValidation: "not_performed",
    rollbackVerification: "not_performed",
  });
  return {
    directory,
    key,
    identity,
    binding,
    instance,
    buildHash: physical.buildHash,
    summary,
    put,
  };
}

test("retained audit verifies original evidence without changing its failed result", (t) => {
  const f = fixture(t);
  const files = fs
    .readdirSync(f.directory)
    .map((name) => path.join(f.directory, name));
  const before = files.map((file) => fs.readFileSync(file));
  const verified = api.verifyRetainedAuditResponse(f);
  assert.deepEqual(verified.summary, f.summary);
  assert.equal(verified.currentInstance.pid, f.instance.pid);
  for (const [i, file] of files.entries())
    assert.deepEqual(fs.readFileSync(file), before[i]);
});

for (const change of [
  "foreign",
  "raw-id",
  "remote",
  "missing",
  "conflict",
  "wire",
  "checker",
  "native-error",
  "multiple",
  "result",
]) {
  test("retained audit refuses " + change, (t) => {
    const f = fixture(t);
    const read = (name: string) =>
      JSON.parse(fs.readFileSync(path.join(f.directory, name), "utf8"));
    if (change === "foreign") f.key["clientId"] = "foreign";
    if (change === "missing")
      fs.unlinkSync(path.join(f.directory, "received-response.json"));
    if (change === "conflict") f.put("response.json", {});
    if (change === "remote") {
      const r = read("remote-synthetic-rpc.json");
      r.requestHash = "e".repeat(64);
      f.put("remote-synthetic-rpc.json", r);
    }
    if (change === "checker") {
      const r = read("start.json");
      r.pythonCheck.status = "failed";
      f.put("start.json", r);
    }
    if (change === "wire") {
      const r = read("wire.json");
      r.outgoing.params.arguments.object.script += "\nprint('foreign')";
      f.put("wire.json", r);
    }
    if (change === "result") {
      const r = read("result.json");
      r.sdkRequestsSent = 0;
      f.put("result.json", r);
    }
    if (["raw-id", "native-error", "multiple"].includes(change)) {
      const r = read("received-response.json"),
        reply = JSON.parse(r.raw);
      if (change === "raw-id") reply.id = "foreign";
      if (change === "native-error") reply.result.isError = true;
      if (change === "multiple")
        reply.result.content.push(reply.result.content[0]);
      r.raw = JSON.stringify(reply);
      f.put("received-response.json", r);
    }
    assert.throws(() => api.verifyRetainedAuditResponse(f));
  });
}

const recovery = load(
  "../src/dist/composition/queue-epoch-successor-retained",
) as typeof import("../src/composition/queue-epoch-successor-retained");
const instanceApi = load("../src/queue-instance") as {
  processBirth(pid?: number): string;
  durable(file: string, value: unknown, exclusive?: boolean): void;
  priorProcessAlive(value: unknown): boolean | null;
};
const reference = (file: string) => ({
  path: file,
  sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
});

async function successorFixture(t: import("node:test").TestContext) {
  const stateHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "retained-successor-"),
  );
  const base = path.join(stateHome, "fmcad");
  fs.mkdirSync(base);
  const previousStateHome = process.env["XDG_STATE_HOME"];
  process.env["XDG_STATE_HOME"] = stateHome;
  t.after(() => {
    if (previousStateHome === undefined) delete process.env["XDG_STATE_HOME"];
    else process.env["XDG_STATE_HOME"] = previousStateHome;
  });
  const f = (
    load(
      path.join(process.cwd(), "tests/fixtures/dead-epoch-successor.cjs"),
    ) as (
      base: string,
      repo: string,
      options: { inFlight: boolean },
    ) => import("./fixtures/epoch-fixture-types").DeadEpochFixture
  )(base, process.cwd(), { inFlight: true });
  const isolated = load("../src/queue-isolated-epoch") as {
    openIsolatedEpoch(
      dir: string,
      options: { recover: false },
    ): { block(id: string, error: { code: string }): void };
  };
  isolated
    .openIsolatedEpoch(f.dir, { recover: false })
    .block(f.priorJob.id, { code: "SYNTHETIC_UNKNOWN" });
  f.authority.predecessor.state = reference(f.authority.predecessor.state.path);
  instanceApi.durable(path.join(f.audit, "authority.json"), f.authority);
  f.authorityEntry = reference(path.join(f.audit, "authority.json"));
  f.approval.stateHash = f.authority.predecessor.state.sha256;
  fs.rmSync(path.join(f.audit, "isolated-scratch-qualification"), {
    recursive: true,
  });
  const child = spawn(
    process.execPath,
    [
      path.join(
        f.authority.candidateRoot,
        "src/queue-epoch-successor-worker.js",
      ),
    ],
    { stdio: ["pipe", "ignore", "ignore"] },
  );
  await once(child, "spawn");
  assert.ok(child.pid);
  const owner = {
    pid: child.pid,
    birth: instanceApi.processBirth(child.pid),
    nonce: randomUUID(),
    protocol: 2,
  };
  t.after(async () => {
    const resumedClaim = path.join(
      f.audit,
      "retained-evaluator-handoff",
      "worker-claim.json",
    );
    if (fs.existsSync(resumedClaim)) {
      const owned = JSON.parse(fs.readFileSync(resumedClaim, "utf8"));
      if (instanceApi.priorProcessAlive(owned) === true)
        process.kill(owned.pid, "SIGKILL");
    }
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit");
      const stat = fs.readFileSync(`/proc/${child.pid}/stat`, "utf8");
      if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("T"))
        child.kill("SIGKILL"); // Explicit cleanup of this test's SDK-free child only.
      else child.stdin.end();
      await exit;
    }
    fs.rmSync(stateHome, { recursive: true, force: true });
  });
  const put = (name: string, value: unknown) =>
    instanceApi.durable(path.join(f.audit, name), value);
  const originalApproval = path.join(base, "original-approval.json");
  instanceApi.durable(originalApproval, f.approval);
  put("intent.json", {
    version: 1,
    requestId: f.requestId,
    clientId: f.clientId,
    ownerTokenHash: hash(f.token),
    nonce: f.nonce,
    approval: reference(originalApproval),
    previousOwner: f.previousOwner,
  });
  put("launch-intent.json", { nonce: f.nonce, authority: f.authorityEntry });
  put("worker-claim.json", {
    pid: owner.pid,
    birth: owner.birth,
    nonce: f.nonce,
  });
  put("worker-ready.json", {
    nonce: f.nonce,
    owner,
    buildHash: f.authority.buildHash,
    sdkRequestsSent: 0,
  });
  put("complete.json", {
    kind: "dead-epoch-successor-metadata-ready",
    owner,
    authority: f.authorityEntry,
    requestId: f.requestId,
    buildHash: f.authority.buildHash,
    sourceCommit: f.authority.sourceCommit,
    sdkRequestsSent: 0,
    historicalOutcome: "unknown",
  });
  put("retired-owner.json", f.previousOwner);
  put("previous-active-succession.json", {
    version: 1,
    authority: f.authorityEntry,
  });
  for (const name of [
    "released-atomic-migration.lock.json",
    "released-recovery.lock.json",
  ])
    put(name, {
      kind: "dead-epoch-successor",
      nonce: f.nonce,
      audit: f.audit,
      clientId: f.clientId,
    });
  fs.writeFileSync(path.join(f.audit, "worker.stdout.log"), "");
  fs.writeFileSync(path.join(f.audit, "worker.stderr.log"), "");
  instanceApi.durable(path.join(f.dir, "broker.lock"), owner);
  instanceApi.durable(path.join(f.dir, "active-epoch-succession.json"), {
    version: 1,
    authority: f.authorityEntry,
  });
  instanceApi.durable(
    path.join(f.dir, "broker-lifecycle-" + owner.nonce + ".json"),
    {
      owner,
      buildHash: f.authority.buildHash,
      configHash: f.authority["configHash"],
      stage: "ready",
    },
  );
  const observation = path.join(f.audit, "dead-epoch-current-observation");
  fs.mkdirSync(observation, { mode: 0o700 });
  const originalBinding = {
    purpose: "atomic-recovery-audit-v1",
    clientId: f.clientId,
    expectedProcess: f.authority.expectedProcess,
    successorAuthorityHash: f.authorityEntry.sha256,
  };
  const reader = (
    load(
      "../src/queue-atomic-recovery-audit",
    ) as typeof import("../src/queue-atomic-recovery-audit")
  ).prepareRecoveryAudit(
    f.authority.candidateRoot,
    f.auditIdentity,
    originalBinding,
  );
  const evidence = fixture(t, {
    directory: observation,
    key: {
      jobId: f.pointer.quarantinedJobIds[0]!,
      observationJobId: f.pointer.quarantinedJobIds[1]!,
      requestId: f.requestId + ":observe",
      clientId: f.clientId,
    },
    identity: f.auditIdentity,
    binding: originalBinding,
    instance: f.authority.expectedProcess,
    buildHash: f.authority.buildHash,
    source: reader.artifact.script,
    originHash: reader.artifact.artifactHash,
    sourceSha256: reader.sourceSha256,
  });
  const files: Record<string, ReturnType<typeof reference>> = {};
  for (const name of fs.readdirSync(f.audit))
    if (fs.lstatSync(path.join(f.audit, name)).isFile())
      files[name] = reference(path.join(f.audit, name));
  for (const name of fs.readdirSync(observation))
    files["observation/" + name] = reference(path.join(observation, name));
  for (const name of [
    "broker.lock",
    "isolated-admission-epoch.json",
    "queue-state.json",
    "instance.json",
    "active-epoch-succession.json",
    "broker-lifecycle-" + owner.nonce + ".json",
  ])
    files["root/" + name] = reference(path.join(f.dir, name));
  const evaluatorQualification = path.join(
    base,
    "evaluator-qualification.json",
  );
  const evaluatorSource = "e".repeat(40);
  instanceApi.durable(evaluatorQualification, {
    ...JSON.parse(fs.readFileSync(f.authority.qualification.path, "utf8")),
    sourceCommit: evaluatorSource,
  });
  const approval = {
    version: 1,
    purpose: "retained-successor-response-acceptance-v1",
    authority: f.authorityEntry,
    requestId: f.requestId,
    clientId: f.clientId,
    owner,
    expectedProcess: f.authority.expectedProcess,
    candidateRoot: f.authority.candidateRoot,
    buildHash: f.authority.buildHash,
    sourceCommit: evaluatorSource,
    qualification: reference(evaluatorQualification),
    files,
  };
  const approvalFile = path.join(base, "retained-approval.json");
  instanceApi.durable(approvalFile, approval);
  const status = {
    buildHash: f.authority.buildHash,
    sourceCommit: f.authority.sourceCommit,
    stopping: false,
    held: "Qualified isolated scratch process is unavailable; metadata only, no SDK or replacement authority",
    control: {
      instanceId: owner.nonce,
      buildHash: f.authority.buildHash,
      activeOperations: 0,
      activeIds: [],
      phase: "RECOVERY_BLOCKED",
      unresolved: true,
    },
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
    dir: f.dir,
    auth: { clientId: f.clientId, clientToken: f.token },
    async call(action: "queue-summary") {
      assert.equal(action, "queue-summary");
      return structuredClone(status);
    },
  };
  const ports = {
    evaluatorRoot: () => f.authority.candidateRoot,
    process: (expected: { pid: number; birth: string }) => ({
      state: "present" as const,
      ...expected,
      observedAtUtc: new Date().toISOString(),
    }),
    admissionFreeze(
      input: Parameters<typeof recovery.inspectRetainedDispatchCut>[0],
    ) {
      // This owned synthetic process only waits for its parent's stdin: it has
      // no broker, SDK, client route or command source to dispatch. This is not
      // a proof about the live 923c metadata worker.
      const file = path.join(base, "synthetic-no-dispatch.json");
      if (!fs.existsSync(file))
        instanceApi.durable(file, {
          kind: "owned-synthetic-no-dispatch-capability",
          owner,
          authority: f.authorityEntry,
        });
      return {
        mechanism: "owned-synthetic-no-dispatch-capability",
        evidence: reference(file),
        cut: recovery.inspectRetainedDispatchCut(input, {
          sourceCommit: f.authority.sourceCommit,
          buildHash: f.authority.buildHash,
          configHash: String(f.authority["configHash"]),
        }),
      };
    },
  };
  return {
    ...f,
    base,
    owner,
    child,
    evidence,
    approval,
    approvalFile,
    status,
    client,
    ports,
  };
}

test("retained metadata retirement is SDK1 terminal, append-only, and kills only its owned synthetic Node", async (t) => {
  const f = await successorFixture(t),
    oldResult = fs.readFileSync(path.join(f.evidence.directory, "result.json"));
  const preview = await recovery.recoverRetainedSuccessor(
    f.client,
    f.approvalFile,
    false,
    f.ports,
  );
  assert.equal(preview.sdkRequestsSent, 1);
  assert.ok("retirementPerformed" in preview);
  assert.equal(preview.retirementPerformed, false);
  const exited = once(f.child, "exit"),
    result = await recovery.recoverRetainedSuccessor(
      f.client,
      f.approvalFile,
      true,
      f.ports,
    );
  const [, signal] = await exited;
  assert.equal(signal, "SIGKILL");
  assert.equal(result["currentRpcTerminal"], true);
  assert.equal(result["sdkRequestsSent"], 1);
  assert.equal(result["historicalOutcome"], "unknown");
  assert.deepEqual(
    fs.readFileSync(path.join(f.evidence.directory, "result.json")),
    oldResult,
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(f.dir, "broker.lock"), "utf8")),
    f.owner,
  );
  const resumed = await recovery.resumeRetainedSuccessor(
    f.client,
    f.cfg,
    f.approvalFile,
    f.ports,
  );
  assert.ok("sdkRequestsSent" in resumed);
  assert.equal(resumed["sdkRequestsSent"], 0);
  assert.equal(resumed["originalCurrentScopeSdkRequestsSent"], 1);
  assert.equal(fs.existsSync(path.join(f.dir, "recovery.lock")), true);
  assert.equal(fs.existsSync(path.join(f.dir, "atomic-migration.lock")), true);
  const { request } = load("../src/queue-connection") as {
    request(dir: string, message: Record<string, unknown>): Promise<unknown>;
  };
  const client = {
    ...f.client,
    call: (action: "queue-summary") =>
      request(f.dir, { action, auth: f.client.auth }),
  };
  const readiness = (await client.call("queue-summary")) as Record<
    string,
    unknown
  >;
  assert.equal(
    (readiness["control"] as { phase: string }).phase,
    "RECOVERY_BLOCKED",
    JSON.stringify(readiness),
  );
  assert.equal(readiness["sourceCommit"], f.approval.sourceCommit);
  assert.notEqual(readiness["sourceCommit"], f.authority.sourceCommit);
  for (const action of [
    "submit",
    "audit-atomic",
    "capture-audit-facts",
    "resume",
  ]) {
    await assert.rejects(
      request(f.dir, { action, auth: f.client.auth }),
      (error: unknown) =>
        Boolean(
          error &&
          typeof error === "object" &&
          "code" in error &&
          ["EPOCH_PROCESS_UNAVAILABLE", "MIGRATION_IN_PROGRESS"].includes(
            String(error.code),
          ),
        ),
    );
  }
  for (const changed of [
    "foreign",
    "stale",
    "process",
    "busy",
    "raw",
    "result-conflict",
    "subsequent-dispatch",
    "missing-remote",
  ]) {
    await t.test("retained acceptance refuses " + changed, async () => {
      const rawFile = path.join(f.evidence.directory, "received-response.json"),
        resultFile = path.join(f.evidence.directory, "result.json"),
        remoteFile = path.join(
          f.evidence.directory,
          "remote-synthetic-rpc.json",
        ),
        extra = path.join(
          f.audit,
          "retained-evaluator-handoff",
          "later-sdk-start.json",
        );
      const saved = new Map(
        [rawFile, resultFile, remoteFile].map((file) => [
          file,
          fs.readFileSync(file),
        ]),
      );
      const target =
        changed === "foreign"
          ? { ...client, auth: { ...client.auth, clientToken: "foreign" } }
          : changed === "busy"
            ? {
                ...client,
                async call(action: "queue-summary") {
                  const status = (await client.call(action)) as {
                    control: { activeOperations: number };
                  };
                  status.control.activeOperations = 1;
                  return status;
                },
              }
            : client;
      const ports = {
        ...f.ports,
        ...(changed === "stale"
          ? {
              process: (e: { pid: number; birth: string }) => ({
                state: "present" as const,
                ...e,
                observedAtUtc: new Date(Date.now() - 60000).toISOString(),
              }),
            }
          : {}),
        ...(changed === "process"
          ? {
              process: (e: { pid: number; birth: string }) => ({
                state: "present" as const,
                ...e,
                birth: "reused",
                observedAtUtc: new Date().toISOString(),
              }),
            }
          : {}),
      };
      try {
        if (changed === "raw") fs.appendFileSync(rawFile, "\n");
        if (changed === "result-conflict")
          fs.writeFileSync(resultFile, JSON.stringify({ status: "complete" }));
        if (changed === "subsequent-dispatch") fs.writeFileSync(extra, "{}");
        if (changed === "missing-remote") fs.unlinkSync(remoteFile);
        await assert.rejects(
          recovery.acceptRetainedSuccessor(target, f.approvalFile, true, ports),
        );
        assert.equal(
          fs.existsSync(
            path.join(f.evidence.directory, "retained-acceptance.json"),
          ),
          false,
        );
        assert.equal(
          fs.existsSync(path.join(f.audit, "observed-current.json")),
          false,
        );
      } finally {
        for (const [file, bytes] of saved) fs.writeFileSync(file, bytes);
        if (fs.existsSync(extra)) fs.unlinkSync(extra);
      }
    });
  }
  const accepted = await recovery.acceptRetainedSuccessor(
    client,
    f.approvalFile,
    true,
    f.ports,
  );
  assert.equal(accepted["sdkRequestsSent"], 0);
  assert.equal(accepted["originalSdkRequestsSent"], 1);
  assert.equal(fs.existsSync(path.join(f.dir, "recovery.lock")), false);
  assert.equal(fs.existsSync(path.join(f.dir, "atomic-migration.lock")), false);
  assert.deepEqual(
    fs.readFileSync(path.join(f.evidence.directory, "result.json")),
    oldResult,
  );
  const summary = (await client.call("queue-summary")) as {
    deadEpochSuccessor: { currentFactsAvailable: boolean };
  };
  assert.equal(summary.deadEpochSuccessor.currentFactsAvailable, true);
});

for (const changed of [
  "foreign",
  "stale-process",
  "reused-process",
  "active",
  "subsequent-dispatch",
  "scope-cut",
]) {
  test("retained metadata recovery refuses " + changed, async (t) => {
    const f = await successorFixture(t);
    if (changed === "foreign") f.client.auth.clientToken = "foreign";
    if (changed === "active") f.status.control.activeOperations = 1;
    if (changed === "subsequent-dispatch")
      fs.mkdirSync(path.join(f.audit, "isolated-scratch-qualification"));
    if (changed === "scope-cut")
      fs.appendFileSync(path.join(f.dir, "queue-state.json"), "\n");
    const ports = {
      ...f.ports,
      ...(changed === "stale-process"
        ? {
            process: (e: { pid: number; birth: string }) => ({
              state: "present" as const,
              ...e,
              observedAtUtc: new Date(Date.now() - 60000).toISOString(),
            }),
          }
        : {}),
      ...(changed === "reused-process"
        ? {
            process: (e: { pid: number; birth: string }) => ({
              state: "present" as const,
              ...e,
              birth: "foreign",
              observedAtUtc: new Date().toISOString(),
            }),
          }
        : {}),
    };
    await assert.rejects(
      recovery.recoverRetainedSuccessor(f.client, f.approvalFile, true, ports),
    );
    assert.equal(instanceApi.priorProcessAlive(f.owner), true);
    assert.equal(
      fs.existsSync(path.join(f.audit, "retained-evaluator-handoff")),
      false,
    );
  });
}

test("production retirement refuses when whole-source dispatch coverage is unavailable", async (t) => {
  const f = await successorFixture(t);
  await assert.rejects(
    recovery.recoverRetainedSuccessor(f.client, f.approvalFile, true, {
      evaluatorRoot: f.ports.evaluatorRoot,
      process: f.ports.process,
    }),
    /source-bound durable-before-send|Whole-source SDK closure/,
  );
  assert.equal(instanceApi.priorProcessAlive(f.owner), true);
  assert.equal(
    fs.existsSync(path.join(f.audit, "retained-evaluator-handoff")),
    false,
  );
  const stat = fs.readFileSync(`/proc/${f.owner.pid}/stat`, "utf8");
  assert.equal(stat.slice(stat.lastIndexOf(")") + 2).startsWith("T"), false);
});

for (const failure of [
  "late-live-sdk-dispatch",
  "partial-freeze-persistence",
]) {
  test(
    "retained freeze preserves a pending state without kill or automatic continue: " +
      failure,
    async (t) => {
      const f = await successorFixture(t),
        original = fs.readFileSync(
          path.join(f.evidence.directory, "result.json"),
        );
      let turns = 0;
      const ports = {
        ...f.ports,
        admissionFreeze(
          input: Parameters<typeof recovery.inspectRetainedDispatchCut>[0],
        ) {
          if (++turns === 2) {
            if (failure === "late-live-sdk-dispatch") {
              const dir = path.join(f.dir, "jobs", "late-live-sdk");
              fs.mkdirSync(dir, { recursive: true });
              instanceApi.durable(path.join(dir, "start.json"), {
                instance: f.authority.expectedProcess,
                binding: {
                  rpcId: "unaccounted",
                  buildHash: f.authority.buildHash,
                  auditExpectedProcess: f.authority.expectedProcess,
                },
              });
            } else
              fs.mkdirSync(
                path.join(f.audit, "retained-evaluator-handoff", "frozen.json"),
              );
          }
          return f.ports.admissionFreeze(input);
        },
      };
      const result = await recovery.recoverRetainedSuccessor(
        f.client,
        f.approvalFile,
        true,
        ports,
      );
      assert.ok("automaticKillAllowed" in result);
      assert.equal(result.automaticKillAllowed, false);
      assert.equal(result.automaticContinueAllowed, false);
      assert.equal(instanceApi.priorProcessAlive(f.owner), true);
      const stat = fs.readFileSync(`/proc/${f.owner.pid}/stat`, "utf8");
      assert.equal(stat.slice(stat.lastIndexOf(")") + 2).startsWith("T"), true);
      assert.equal(
        fs.existsSync(
          path.join(
            f.audit,
            "retained-evaluator-handoff",
            "retirement-effect-start.json",
          ),
        ),
        false,
      );
      assert.equal(
        fs.existsSync(
          path.join(f.audit, "retained-evaluator-handoff", "after.json"),
        ),
        false,
      );
      assert.deepEqual(
        fs.readFileSync(path.join(f.evidence.directory, "result.json")),
        original,
      );
      if (failure === "late-live-sdk-dispatch") {
        const receipt = await recovery.recoverRetainedSuccessor(
          {
            ...f.client,
            async call() {
              throw new Error("Never call a stopped worker");
            },
          },
          f.approvalFile,
          true,
          ports,
        );
        assert.ok("kind" in receipt);
        assert.equal(receipt["kind"], "retained-metadata-handoff-receipts");
      } else
        assert.throws(() =>
          recovery.readRetainedHandoff(f.client, f.approvalFile),
        );
    },
  );
}

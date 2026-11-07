// Synthetic, caller-owned temporary directories only. No real Fusion or SDK.
import * as fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import syntheticClosedScratch from "./closed-scratch-artifacts.cjs";
type Epoch = Parameters<typeof syntheticClosedScratch>[1];
function fixture(root: string, repo: string, admissionMode?: string) {
  const runtimeRequire = createRequire(__filename);
  const api = runtimeRequire(repo + "/src/queue-instance") as {
    buildHash(): string;
    processBirth(): string;
    durable(file: string, value: unknown, exclusive?: boolean): void;
    readJson(file: string): Record<string, unknown>;
    priorProcessAlive(value: unknown): boolean | null;
  };
  const { predecessorSnapshot, reference } = runtimeRequire(
    repo + "/src/queue-epoch-lineage",
  ) as {
    predecessorSnapshot(
      dir: string,
      audit: string,
    ): { pointer: { sha256: string }; state: { sha256: string } };
    reference(file: string): { path: string; sha256: string };
  };
  const { authorizeClosedSuccessor } = runtimeRequire(
    repo + "/src/queue-closed-epoch-successor",
  ) as {
    authorizeClosedSuccessor(
      ports: unknown,
      message: unknown,
      clientId: string,
    ): unknown;
  };
  const original = runtimeRequire("./dead-epoch-successor.cjs") as (
    root: string,
    repo: string,
    options: { oldProcessAlive: boolean },
  ) => Record<string, unknown> & {
    authorityEntry: { path: string };
    audit: string;
    dir: string;
    requestId: string;
    cfg: unknown;
    clientId: string;
    token: string;
  };
  const f = original(root, repo, { oldProcessAlive: true });
  fs.unlinkSync(f.authorityEntry.path);
  fs.unlinkSync(path.join(f.audit, "installed-qualification.json"));
  fs.rmSync(path.join(f.audit, "isolated-scratch-qualification"), {
    recursive: true,
    force: true,
  });
  const state = (
    runtimeRequire(repo + "/src/queue-isolated-epoch") as {
      openIsolatedEpoch(
        dir: string,
        options: { recover: false },
      ): { epoch: Epoch };
    }
  ).openIsolatedEpoch(f.dir, { recover: false });
  const epoch = state.epoch,
    buildHash = api.buildHash(),
    sourceCommit = "f".repeat(40);
  if (admissionMode) {
    epoch.restoreActiveCreationId = null;
    api.durable(path.join(f.dir, "isolated-admission-epoch.json"), epoch);
  }
  const identityFile = path.join(epoch.root, "instance.json");
  api.durable(identityFile, {
    ...api.readJson(identityFile),
    buildHash,
    sourceCommit,
  });
  const marker = {
    pid: process.pid,
    birth: api.processBirth(),
    nonce: randomUUID(),
    protocol: 2,
  };
  api.durable(path.join(f.dir, "broker.lock"), marker);
  const closed = syntheticClosedScratch(f.dir, epoch, repo, admissionMode);
  const qfile = path.join(root, "installed-qualification.json");
  api.durable(
    qfile,
    {
      passed: true,
      productionAdmission: true,
      sourceCommit,
      buildHash,
      liveSdkRequestsSent: 0,
      deadEpochSuccessorReadQualified: true,
      deadEpochSuccessorRestoreQualified: true,
      closedEpochSuccessorQualified: true,
    },
    true,
  );
  const snapshot = predecessorSnapshot(f.dir, f.audit),
    approvalFile = path.join(root, "approval.json");
  const approval = {
    version: 1,
    purpose: "closed-isolated-epoch-successor-v1",
    clientId: epoch.ownerClientId,
    requestId: f.requestId,
    epochId: epoch.epochId,
    pointerHash: snapshot.pointer.sha256,
    stateHash: snapshot.state.sha256,
    closedProofHash: closed.sha256,
    sourceCommit,
    buildHash,
    qualification: reference(qfile),
  };
  api.durable(approvalFile, approval, true);
  const p = {
    dir: f.dir,
    state,
    marker,
    buildHash,
    runtime: repo,
    clients: () => api.readJson(path.join(f.dir, "clients.json")),
    assertControl: (value: unknown) =>
      assert.deepEqual(value, { synthetic: true }),
    fence() {
      assert.equal(api.priorProcessAlive(marker), true);
    },
  };
  const message = () => ({
    action: "authorize-closed-successor",
    approval: reference(approvalFile),
    control: { synthetic: true },
  });
  return {
    ...f,
    state,
    epoch,
    p,
    approval,
    approvalFile,
    qfile,
    message,
    authorize: (clientId = epoch.ownerClientId) =>
      authorizeClosedSuccessor(p, message(), clientId),
  };
}
export = fixture;

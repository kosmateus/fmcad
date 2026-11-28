import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { record, type Owner, type Document } from "./contracts";
import { queueExecution } from "./queue-backend";

export const legacyTerminalDispositionFile = "legacy/terminal-disposition.json";
export interface LegacyTerminalBackend {
  identity: string;
  mode: "fusion";
  protocol: "addin";
}
export interface LegacyTerminalSourceBinding {
  driverSource: string;
  buildHash: string;
  sourceHashes: Record<string, { path: string; sha256: string }>;
}
export interface LegacyTerminalPorts {
  readOriginal(
    owner: Owner,
    requestId: string,
    jobId: string,
  ): Promise<unknown>;
  producerAlive(identity: { pid: number; birth: string }): boolean | null;
  sourceBinding: LegacyTerminalSourceBinding;
}
const digest = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
function bytes(file: string): Buffer {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    assert.ok(
      stat.isFile() && stat.size <= 16 * 1024 * 1024,
      "Disposition evidence must be a regular file",
    );
    assert.equal(
      fs.realpathSync(file),
      file,
      "Disposition evidence must not traverse symlinks",
    );
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
const json = (file: string) =>
  record(JSON.parse(bytes(file).toString("utf8")) as unknown);
const text = (value: unknown): string => {
  assert.equal(typeof value, "string");
  assert.ok(value);
  return value as string;
};
function originalContext(directory: string, backend: LegacyTerminalBackend) {
  assert.equal(fs.realpathSync(directory), directory);
  assert.equal(backend.mode, "fusion");
  assert.equal(backend.protocol, "addin");
  const report = json(path.join(directory, "report.json"));
  assert.equal(report["directory"], directory);
  assert.equal(report["mode"], backend.mode);
  assert.equal(report["protocol"], backend.protocol);
  assert.equal(report["backendIdentity"], backend.identity);
  assert.equal(report["status"], "failed");
  assert.equal(report["cleanup"], "deferred");
  const owner = record(report["owner"]) as unknown as Owner;
  assert.equal(owner.scenarioId, "native-legacy-0");
  assert.equal(owner.clientId, `scenario:${owner.runId}:${owner.scenarioId}`);
  const document = record(report["document"]) as unknown as Document;
  text(document.creationId);
  text(document.name);
  const lease = json(path.join(directory, "legacy/lease.json"));
  assert.equal(lease["version"], 1);
  assert.deepEqual(lease["owner"], owner);
  assert.deepEqual(lease["document"], document);
  assert.equal(lease["directory"], directory);
  assert.equal(lease["source"], "tests/scenarios/legacy-owned-driver.ts");
  assert.equal(lease["testCase"], "native-legacy-cli");
  assert.equal(lease["mode"], "owned-unsaved-script");
  assert.equal(lease["protocol"], "addin");
  const names = fs.readdirSync(path.join(directory, "legacy/intents"));
  assert.equal(
    names.length,
    1,
    "Exactly one accepted legacy intent is supported",
  );
  const name = names[0]!;
  assert.match(name, /^[a-f0-9-]{36}\.json$/u);
  const intentFile = "legacy/intents/" + name;
  const receiptFile = "legacy/queue-receipts/" + name;
  const intent = json(path.join(directory, intentFile));
  const requestId = owner.clientId + ":legacy:" + name.slice(0, -5);
  assert.equal(report["scope"], "exclusive-instance");
  assert.equal(
    report["error"],
    "Original legacy request remains unsettled; cleanup deferred: " + requestId,
  );
  assert.equal(report["cleanupHold"], undefined);
  assert.equal(intent["version"], 1);
  assert.deepEqual(intent["owner"], owner);
  assert.equal(intent["requestId"], requestId);
  assert.equal(intent["admissionRequested"], true);
  assert.equal(intent["completed"], true);
  assert.equal(intent["exitCode"], 1);
  assert.match(text(intent["argvHash"]), /^[a-f0-9]{64}$/u);
  assert.equal(intent["settlement"], undefined);
  assert.deepEqual(intent["settlementFailure"], {
    requestId,
    clientId: owner.clientId,
    reason: "lookup-unavailable",
  });
  const receipt = json(path.join(directory, receiptFile));
  assert.equal(receipt["version"], 1);
  assert.deepEqual(receipt["owner"], owner);
  assert.equal(receipt["requestId"], requestId);
  const jobId = text(receipt["jobId"]);
  const launch = json(path.join(directory, "legacy/launch.json"));
  assert.equal(launch["state"], "completed");
  assert.equal(launch["code"], 1);
  const index = json(path.join(path.dirname(directory), "index.json"));
  assert.equal(index["runId"], owner.runId);
  assert.equal(index["backendIdentity"], backend.identity);
  const parent = record(index["processIdentity"]);
  const completion = json(path.join(directory, "legacy/completion.json"));
  assert.deepEqual(completion["owner"], owner);
  assert.deepEqual(completion["document"], document);
  assert.equal(completion["status"], "failed");
  assert.equal(completion["safeForCleanup"], true);
  assert.equal(
    completion["reportPath"],
    path.join(directory, "legacy/readback.json"),
  );
  return {
    owner,
    document,
    requestId,
    jobId,
    intent,
    launch,
    parent,
    files: [
      "../index.json",
      "report.json",
      "creation.json",
      "legacy/lease.json",
      "legacy/launch.json",
      "legacy/completion.json",
      "legacy/readback.json",
      "legacy/stdout.log",
      "legacy/stderr.log",
      intentFile,
      receiptFile,
    ],
  };
}
function rawTerminal(raw: unknown, c: ReturnType<typeof originalContext>) {
  const value = record(raw),
    job = record(value["job"]),
    execution = record(value["execution"]);
  assert.equal(job["id"], c.jobId);
  assert.equal(job["clientId"], c.owner.clientId);
  assert.equal(job["requestId"], c.requestId);
  assert.equal(job["kind"], "command");
  for (const item of [job, execution]) {
    assert.equal(item["state"], "failed");
    assert.equal(item["code"], "LOCAL_PREPARATION_FAILED");
    assert.equal(item["executionOutcome"], "not_started");
    assert.equal(item["mayHaveMutated"], false);
  }
  assert.equal(execution["sdkSettled"], true);
  assert.equal(job["startedAt"], undefined);
  assert.ok(Number.isSafeInteger(job["finishedAt"]));
  assert.equal(value["stdout"], "");
  const operation = record(job["operationResult"]);
  assert.equal(operation["version"], 1);
  assert.equal(operation["requestId"], c.requestId);
  assert.equal(operation["jobId"], c.jobId);
  assert.equal(operation["acceptance"], "accepted");
  assert.equal(operation["executionOutcome"], "not_started");
  assert.equal(operation["mayHaveMutated"], false);
  assert.equal(operation["code"], "LOCAL_PREPARATION_FAILED");
  assert.equal(record(operation["validation"])["status"], "not_checked");
  // Preparation never reached Python. An absent checker is not a checker PASS.
  assert.deepEqual(value["pythonChecks"], []);
  return queueExecution(raw, c.owner, c.requestId);
}
function sourceBinding(
  binding: LegacyTerminalSourceBinding,
  backend: LegacyTerminalBackend,
) {
  assert.match(binding.driverSource, /^[a-f0-9]{40}$/u);
  assert.match(binding.buildHash, /^[a-f0-9]{64}$/u);
  assert.equal(backend.identity, "fusion:addin:" + binding.buildHash);
  for (const base of ["runner", "legacy-owned-driver", "legacy-handoff"])
    for (const name of [
      `tests/scenarios/${base}.ts`,
      `dist/tests/scenarios/${base}.js`,
    ])
      assert.ok(
        binding.sourceHashes[name],
        "Missing original source binding: " + name,
      );
  for (const entry of Object.values(binding.sourceHashes)) {
    assert.match(entry.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(
      digest(bytes(entry.path)),
      entry.sha256,
      "Original source changed",
    );
  }
}
function dead(value: Record<string, unknown>, ports: LegacyTerminalPorts) {
  assert.ok(Number.isSafeInteger(value["pid"]) && Number(value["pid"]) > 0);
  assert.equal(
    ports.producerAlive({
      pid: Number(value["pid"]),
      birth: text(value["birth"]),
    }),
    false,
    "Original producer may still submit work",
  );
}
export async function publishLegacyTerminalDisposition(
  directory: string,
  backend: LegacyTerminalBackend,
  ports: LegacyTerminalPorts,
) {
  const c = originalContext(directory, backend);
  sourceBinding(ports.sourceBinding, backend);
  dead(c.intent, ports);
  dead(c.launch, ports);
  dead(c.parent, ports);
  const artifacts = Object.fromEntries(
    c.files.map((file) => [file, digest(bytes(path.join(directory, file)))]),
  );
  const raw = await ports.readOriginal(c.owner, c.requestId, c.jobId);
  rawTerminal(raw, c);
  const proof = {
    version: 1,
    kind: "accepted-terminal-legacy",
    backend,
    owner: c.owner,
    document: c.document,
    requestId: c.requestId,
    jobId: c.jobId,
    expectedModified: false,
    sourceBinding: ports.sourceBinding,
    artifacts,
    raw,
    finishedAt: new Date().toISOString(),
  };
  // No append or overwrite, and no changes to the historical lookup failure.
  for (const [file, hash] of Object.entries(artifacts))
    assert.equal(digest(bytes(path.join(directory, file))), hash);
  dead(c.intent, ports);
  dead(c.launch, ports);
  dead(c.parent, ports);
  const fd = fs.openSync(
    path.join(directory, legacyTerminalDispositionFile),
    "wx",
    0o600,
  );
  try {
    fs.writeFileSync(fd, JSON.stringify(proof, null, 2) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const parent = fs.openSync(path.join(directory, "legacy"), "r");
  try {
    fs.fsyncSync(parent);
  } finally {
    fs.closeSync(parent);
  }
  return validateLegacyTerminalDisposition(directory, backend);
}
export function validateLegacyTerminalDisposition(
  directory: string,
  backend: LegacyTerminalBackend,
) {
  const file = path.join(directory, legacyTerminalDispositionFile),
    content = bytes(file),
    proof = record(JSON.parse(content.toString("utf8")) as unknown);
  const c = originalContext(directory, backend);
  assert.equal(proof["version"], 1);
  assert.equal(proof["kind"], "accepted-terminal-legacy");
  assert.deepEqual(proof["backend"], backend);
  assert.deepEqual(proof["owner"], c.owner);
  assert.deepEqual(proof["document"], c.document);
  assert.equal(proof["requestId"], c.requestId);
  assert.equal(proof["jobId"], c.jobId);
  assert.equal(proof["expectedModified"], false);
  sourceBinding(proof["sourceBinding"] as LegacyTerminalSourceBinding, backend);
  const artifacts = record(proof["artifacts"]);
  assert.deepEqual(Object.keys(artifacts).sort(), c.files.slice().sort());
  for (const name of c.files)
    assert.equal(
      digest(bytes(path.join(directory, name))),
      artifacts[name],
      "Original artifact changed: " + name,
    );
  const result = rawTerminal(proof["raw"], c);
  const finishedAt = text(proof["finishedAt"]);
  assert.ok(Number.isFinite(Date.parse(finishedAt)));
  return {
    owner: c.owner,
    document: c.document,
    requestId: c.requestId,
    jobId: c.jobId,
    expectedModified: false as const,
    dispositionHash: digest(content),
    finishedAt,
    originalRequest: { requestId: c.requestId, phase: "legacy-cli", result },
  };
}

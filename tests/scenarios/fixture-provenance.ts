import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { childProcessIdentity } from "./legacy-handoff";
import { record, text } from "./contracts";
import type { Document, Owner, SavedFile, ScenarioBackend } from "./contracts";
import { close, marker } from "./programs";
import { savedIdentityTransition } from "./saved-identity";
import {
  validateCleanupResolution,
  validateCleanupResolutionForClose,
  readCleanupRecoveryRequests,
} from "./cleanup-hold-resolution";
import {
  recoveredFile,
  resultValue,
  saveIntent,
  type RequestEvidence,
} from "./saved-files";

export interface ProcessIdentity {
  readonly pid: number;
  readonly birth: string;
}

type FixtureState = "open" | "closed" | "unsettled";
export interface SupplementalCloseReceipt {
  readonly requestId: string;
  readonly clientId: string;
  readonly jobId: string;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly inventoryFence: Record<string, unknown>;
}
type CloseProofBackend = Pick<
  ScenarioBackend,
  "identity" | "mode" | "qualification" | "protocol"
> & {
  lookup: NonNullable<ScenarioBackend["lookup"]>;
};
export interface SupplementalRuntimeBinding {
  readonly buildHash: string;
  readonly instanceId: string;
}
export interface SupplementalClosePorts {
  readonly readRuntimeBinding: () => Promise<SupplementalRuntimeBinding>;
  readonly readOriginalResult: (
    owner: Owner,
    requestId: string,
  ) => Promise<unknown>;
}
export interface PreparedSupplementalClose {
  readonly sourceFile: string;
  readonly executionSourceFile: string;
  readonly directory: string;
  readonly source: string;
  readonly owner: Owner;
  readonly requestId: string;
  readonly document: Document;
  readonly runtime: SupplementalRuntimeBinding;
}
export type OwnedUnsavedFixtureProof =
  | {
      readonly document: Document;
      /** Visible peer only: neither a live target nor cleanup authority. */
      readonly state: "retained";
      readonly supplementalClose?: never;
      readonly terminalReceipt: {
        readonly requestId: string;
        readonly jobId: string;
      };
    }
  | {
      readonly document: Document;
      readonly state: FixtureState;
      readonly supplementalClose?: SupplementalCloseReceipt;
      /** Admission frontier only; never authorizes a close or a mutation. */
      readonly lastSettledReceipt?: {
        readonly requestId: string;
        readonly jobId: string;
      };
    }
  | {
      readonly document: Document;
      readonly state: "saved";
      readonly savedDocument: Document & { readonly file: SavedFile };
      readonly savedState: FixtureState;
      readonly supplementalClose?: never;
    };

export function currentProcessIdentity(): ProcessIdentity {
  return {
    pid: process.pid,
    birth: childProcessIdentity.processBirth(),
  };
}

export function exactScenarioRequestId(
  requestId: string,
  clientId: string,
): boolean {
  const sequence = requestId.slice(clientId.length + 1),
    number = Number(sequence);
  return (
    requestId === clientId + ":" + sequence &&
    /^(0|[1-9]\d*)$/u.test(sequence) &&
    Number.isSafeInteger(number) &&
    String(number) === sequence
  );
}

// Multi-request reports and aggregate indexes share the existing original-report
// reader's 16 MiB budget. Small identity/receipt sidecars retain their 1 MiB cap.
const scenarioReportMaxBytes = 16 * 1024 * 1024;
function readJson(
  filename: string,
  maxBytes = 1024 * 1024,
): Record<string, unknown> {
  const fd = fs.openSync(
    filename,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
  );
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes)
      throw new Error("Invalid scenario provenance record");
    return record(JSON.parse(fs.readFileSync(fd, "utf8")) as unknown);
  } finally {
    fs.closeSync(fd);
  }
}

function boundedBytes(filename: string, maxBytes = 1024 * 1024): Buffer {
  const fd = fs.openSync(
    filename,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const stat = fs.fstatSync(fd);
    assert.ok(stat.isFile() && stat.size <= maxBytes);
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");
function immutableRecord(filename: string, value: string): void {
  const temporary = filename + "." + randomUUID() + ".tmp";
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, value);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.linkSync(temporary, filename);
  } finally {
    fs.unlinkSync(temporary);
  }
}
function runtimeBinding(
  value: unknown,
  backend: Pick<ScenarioBackend, "identity">,
) {
  const status = record(value),
    buildHash = text(status["buildHash"]);
  assert.equal(
    backend.identity.split(":")[2],
    buildHash,
    "Runtime build differs from creator backend",
  );
  return { buildHash, instanceId: text(status["instanceId"]) };
}
function supplementalOrigin(
  directory: string,
  backend: Pick<
    ScenarioBackend,
    "identity" | "mode" | "qualification" | "protocol"
  >,
  runtime?: SupplementalRuntimeBinding,
) {
  const report = readJson(
      path.join(directory, "report.json"),
      scenarioReportMaxBytes,
    ),
    owner = record(report["owner"]),
    document = record(report["document"]);
  assert.equal(
    path.resolve(text(report["directory"])),
    path.resolve(directory),
  );
  assert.equal(report["backendIdentity"], backend.identity);
  assert.equal(report["mode"], backend.mode);
  assert.equal(report["qualification"], backend.qualification);
  assert.equal(report["protocol"], backend.protocol);
  const nativeBinding = fs.existsSync(
    path.join(directory, "cleanup-native-result-binding.json"),
  );
  const terminalDisposition = fs.existsSync(
    path.join(directory, "legacy", "terminal-disposition.json"),
  );
  const resolution =
    report["cleanupHold"] === undefined &&
    !nativeBinding &&
    !terminalDisposition
      ? undefined
      : (() => {
          assert.ok(
            runtime,
            "A supplemental close does not resolve cleanupHold without a verified resolution",
          );
          return validateCleanupResolution(directory, backend, runtime);
        })();
  assert.equal(document["file"], undefined);
  assert.ok(Array.isArray(report["requests"]));
  const requests = nativeBinding
      ? (() => {
          assert.ok(
            resolution && runtime,
            "Native result overlay requires a fully validated cleanup resolution",
          );
          return readCleanupRecoveryRequests(directory, backend, runtime);
        })()
      : report["requests"].map(record),
    creates = requests.filter((r) => r["phase"] === "create");
  assert.equal(creates.length, 1);
  for (const entry of requests) {
    const result = record(entry["result"]),
      receipt = record(result["brokerReceipt"]);
    assert.equal(result["sdkSettled"], true, "Original work is unsettled");
    assert.ok(["succeeded", "failed"].includes(text(result["state"])));
    assert.equal(receipt["clientId"], owner["clientId"]);
    assert.equal(receipt["requestId"], entry["requestId"]);
  }
  return {
    resolution,
    report,
    owner: {
      runId: text(owner["runId"]),
      scenarioId: text(owner["scenarioId"]),
      clientId: text(owner["clientId"]),
    },
    document: {
      creationId: text(document["creationId"]),
      name: text(document["name"]),
    },
    requests,
    creationJobId: text(
      record(record(creates[0]!["result"])["brokerReceipt"])["jobId"],
    ),
  };
}

function validateSupplementalOriginals(
  directory: string,
  origin: ReturnType<typeof supplementalOrigin>,
  value: unknown,
): void {
  assert.ok(Array.isArray(value) && value.length === origin.requests.length);
  for (let index = 0; index < origin.requests.length; index++) {
    const entry = origin.requests[index]!,
      captured = record(value[index]),
      authenticated = record(captured["ownerLookup"]);
    assert.deepEqual(
      authenticated,
      entry["result"],
      "Original report differs from authenticated receipt",
    );
    const raw = record(captured["original"]),
      job = record(raw["job"]),
      execution = record(raw["execution"]),
      receipt = record(authenticated["brokerReceipt"]);
    assert.equal(job["id"], receipt["jobId"]);
    assert.equal(job["requestId"], entry["requestId"]);
    assert.equal(job["clientId"], origin.owner.clientId);
    assert.equal(job["state"], authenticated["state"]);
    assert.equal(execution["sdkSettled"], true);
    assert.equal(raw["stdout"], authenticated["stdout"]);
    assert.deepEqual(job["operationResult"], receipt["operationResult"]);
    assert.equal(
      record(entry["intent"])["kind"],
      "script",
      "Supplemental origin requires script-bound original work",
    );
    const provenance = record(raw["provenance"]);
    assert.equal(provenance["status"], "available");
    assert.ok(Array.isArray(provenance["inputs"]));
    const sources = provenance["inputs"]
      .map(record)
      .filter((input) => input["kind"] === "source");
    assert.equal(sources.length, 1);
    const source = sources[0]!,
      filename = path.join(
        directory,
        `request-${text(entry["requestId"]).split(":").at(-1)}.py`,
      ),
      bytes = boundedBytes(filename);
    assert.equal(source["originalPath"], filename);
    assert.equal(source["sha256"], sha256(bytes));
    assert.equal(source["bytes"], bytes.length);
  }
}

/** Prepare evidence before a new, guarded close; this never grants cleanup authority. */
export async function prepareSupplementalCloseProof(
  directory: string,
  backend: CloseProofBackend,
  requestId: string,
  ports: SupplementalClosePorts,
): Promise<PreparedSupplementalClose> {
  const runtime = runtimeBinding(await ports.readRuntimeBinding(), backend),
    origin = supplementalOrigin(directory, backend, runtime),
    proof = verifiedFixture(
      path.dirname(directory),
      path.basename(directory),
      backend,
    );
  assert.ok(
    proof && proof.state !== "closed" && proof.state !== "saved",
    "Creator proof is unavailable",
  );
  assert.ok(exactScenarioRequestId(requestId, origin.owner.clientId));
  assert.ok(
    Number(requestId.slice(origin.owner.clientId.length + 1)) >
      Math.max(
        ...origin.requests.flatMap((r) => {
          if (
            (origin.resolution?.holdKind === "settled-legacy-doc-list" ||
              origin.resolution?.holdKind === "rejected-import-observation") &&
            r === origin.requests.at(-1) &&
            r["phase"] === "legacy-cli" &&
            r["requestId"] === record(origin.report["cleanupHold"])["requestId"]
          )
            return [];
          const originalId = text(r["requestId"]);
          assert.ok(
            exactScenarioRequestId(originalId, origin.owner.clientId),
            "Original close ordering requires numeric request IDs or an exact resolved readonly CLI original",
          );
          return [Number(originalId.slice(origin.owner.clientId.length + 1))];
        }),
      ),
  );
  assert.equal(
    await backend.lookup(origin.owner, requestId),
    null,
    "Never prepare an already admitted request",
  );
  if (origin.resolution) {
    assert.deepEqual(
      validateCleanupResolutionForClose(directory, backend, runtime),
      origin.resolution,
    );
    assert.ok(
      Number(requestId.split(":").at(-1)) >
        Number(origin.resolution.inspectionRequestId.split(":").at(-1)),
      "Close must follow the resolution inspection request",
    );
  }
  const expectedModified = origin.resolution?.inspectedModified ?? false,
    source = close(origin.document, expectedModified);
  const originals = [];
  for (const entry of origin.requests) {
    const originalId = text(entry["requestId"]),
      authenticated = await backend.lookup(origin.owner, originalId);
    assert.ok(authenticated, "Original owner cannot retrieve original work");
    assert.deepEqual(
      authenticated,
      entry["result"],
      "Original report differs from authenticated receipt",
    );
    originals.push({
      ownerLookup: authenticated,
      original: await ports.readOriginalResult(origin.owner, originalId),
    });
  }
  if (!origin.resolution)
    validateSupplementalOriginals(directory, origin, originals);
  assert.deepEqual(
    runtimeBinding(await ports.readRuntimeBinding(), backend),
    runtime,
  );
  if (origin.resolution)
    assert.deepEqual(
      validateCleanupResolutionForClose(directory, backend, runtime),
      origin.resolution,
    );
  const executionSourceFile = path.join(
    directory,
    `request-${requestId.split(":").at(-1)}.py`,
  );
  assert.equal(
    fs.existsSync(executionSourceFile),
    false,
    "Execution source already exists",
  );
  const intent = {
    version: 1,
    owner: origin.owner,
    document: origin.document,
    creationJobId: origin.creationJobId,
    creationHash: sha256(boundedBytes(path.join(directory, "creation.json"))),
    sourceReportHash: sha256(
      boundedBytes(path.join(directory, "report.json"), scenarioReportMaxBytes),
    ),
    backendIdentity: backend.identity,
    runtime,
    originals: origin.resolution ? undefined : originals,
    resolutionDigest: origin.resolution?.digest,
    expectedModified: origin.resolution ? expectedModified : undefined,
    requestId,
    sourceHash: sha256(source),
    executionSourceFile,
    preparedAt: Date.now(),
  };
  immutableRecord(
    path.join(directory, "supplemental-close.intent.json"),
    JSON.stringify(intent) + "\n",
  );
  immutableRecord(path.join(directory, "supplemental-close.py"), source);
  return Object.freeze({
    sourceFile: path.join(directory, "supplemental-close.py"),
    executionSourceFile,
    directory,
    source,
    owner: origin.owner,
    requestId,
    document: origin.document,
    runtime,
  });
}

function validateSupplementalClose(
  directory: string,
  backend: Pick<
    ScenarioBackend,
    "identity" | "mode" | "qualification" | "protocol"
  >,
  candidate?: Record<string, unknown>,
): SupplementalCloseReceipt {
  const intent = readJson(
      path.join(directory, "supplemental-close.intent.json"),
    ),
    runtime = runtimeBinding(intent["runtime"], backend),
    origin = supplementalOrigin(directory, backend, runtime),
    proof =
      candidate ?? readJson(path.join(directory, "supplemental-close.json"));
  assert.equal(intent["version"], 1);
  assert.deepEqual(intent["owner"], origin.owner);
  assert.deepEqual(intent["document"], origin.document);
  assert.equal(intent["creationJobId"], origin.creationJobId);
  assert.equal(
    intent["creationHash"],
    sha256(boundedBytes(path.join(directory, "creation.json"))),
  );
  assert.equal(
    intent["sourceReportHash"],
    sha256(
      boundedBytes(path.join(directory, "report.json"), scenarioReportMaxBytes),
    ),
  );
  assert.equal(intent["backendIdentity"], backend.identity);
  assert.equal(intent["resolutionDigest"], origin.resolution?.digest);
  const expectedModified = origin.resolution?.inspectedModified ?? false;
  assert.equal(
    intent["expectedModified"],
    origin.resolution ? expectedModified : undefined,
  );
  if (!origin.resolution)
    validateSupplementalOriginals(directory, origin, intent["originals"]);
  assert.equal(
    proof["intentHash"],
    sha256(
      boundedBytes(path.join(directory, "supplemental-close.intent.json")),
    ),
  );
  assert.deepEqual(proof["runtime"], intent["runtime"]);
  const source = boundedBytes(path.join(directory, "supplemental-close.py"));
  assert.equal(
    source.toString("utf8"),
    close(origin.document, expectedModified),
  );
  assert.equal(intent["sourceHash"], sha256(source));
  const original = record(proof["original"]),
    job = record(original["job"]),
    execution = record(original["execution"]),
    witness = record(proof["ownerLookup"]),
    witnessReceipt = record(witness["brokerReceipt"]);
  const requestId = text(intent["requestId"]),
    jobId = text(job["id"]);
  assert.ok(exactScenarioRequestId(requestId, origin.owner.clientId));
  assert.ok(
    !origin.requests.some(
      (r) =>
        r["requestId"] === requestId ||
        record(record(r["result"])["brokerReceipt"])["jobId"] === jobId,
    ),
  );
  assert.equal(job["requestId"], requestId);
  assert.equal(
    job["clientId"],
    origin.owner.clientId,
    "Standalone client is not the original owner",
  );
  assert.equal(job["kind"], "command");
  assert.equal(job["state"], "succeeded");
  assert.equal(execution["sdkSettled"], true);
  assert.equal(execution["state"], "succeeded");
  assert.equal(execution["exitCode"], 0);
  assert.equal(execution["publicationOutcome"], "published");
  assert.equal(witness["requestId"], requestId);
  assert.equal(witness["state"], "succeeded");
  assert.equal(witness["sdkSettled"], true);
  assert.equal(witness["exitCode"], 0);
  assert.equal(witnessReceipt["requestId"], requestId);
  assert.equal(witnessReceipt["clientId"], origin.owner.clientId);
  assert.equal(witnessReceipt["jobId"], jobId);
  assert.equal(witnessReceipt["state"], "succeeded");
  assert.deepEqual(witnessReceipt["operationResult"], job["operationResult"]);
  const operation = record(job["operationResult"]);
  assert.equal(operation["requestId"], requestId);
  assert.equal(operation["jobId"], jobId);
  assert.equal(operation["acceptance"], "accepted");
  assert.equal(operation["executionOutcome"], "succeeded");
  const submittedAt = job["submittedAt"],
    startedAt = job["startedAt"],
    finishedAt = job["finishedAt"],
    preparedAt = intent["preparedAt"],
    publishedAt = proof["publishedAt"];
  assert.ok(
    typeof preparedAt === "number" &&
      typeof submittedAt === "number" &&
      typeof startedAt === "number" &&
      typeof finishedAt === "number" &&
      typeof publishedAt === "number",
  );
  assert.ok(
    [preparedAt, submittedAt, startedAt, finishedAt, publishedAt].every(
      Number.isFinite,
    ),
  );
  assert.ok(
    preparedAt <= submittedAt &&
      submittedAt <= startedAt &&
      startedAt <= finishedAt &&
      finishedAt <= publishedAt,
    "Cleanup chronology differs from prepared intent",
  );
  if (origin.resolution) {
    assert.notEqual(
      jobId,
      origin.resolution.inspectionJobId,
      "Close reused the inspection job",
    );
    assert.ok(
      startedAt >= origin.resolution.inspectedAt &&
        startedAt <= origin.resolution.expiresAt,
      "Close falls outside the verified inspection window",
    );
    assert.ok(
      Number(requestId.split(":").at(-1)) >
        Number(origin.resolution.inspectionRequestId.split(":").at(-1)),
      "Close reused the inspection request",
    );
  }
  const provenance = record(original["provenance"]);
  assert.equal(provenance["status"], "available");
  assert.ok(
    Array.isArray(provenance["inputs"]) && provenance["inputs"].length === 1,
  );
  const input = record(provenance["inputs"][0]);
  assert.equal(input["kind"], "source");
  assert.equal(input["sha256"], sha256(source));
  assert.equal(input["bytes"], source.length);
  const executionSourceFile = path.join(
    directory,
    `request-${requestId.split(":").at(-1)}.py`,
  );
  assert.equal(intent["executionSourceFile"], executionSourceFile);
  assert.equal(input["originalPath"], executionSourceFile);
  assert.equal(sha256(boundedBytes(executionSourceFile)), sha256(source));
  assert.equal(original["stdout"], witness["stdout"]);
  const lines = text(original["stdout"])
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(marker));
  assert.equal(lines.length, 1);
  const value = record(JSON.parse(lines[0]!.slice(marker.length)) as unknown),
    inventoryFence = record(value["inventoryFence"]);
  assert.equal(value["creationId"], origin.document.creationId);
  assert.equal(value["closed"], true);
  assert.equal(inventoryFence["version"], 1);
  assertFencedClosedDocumentInventory(
    inventoryFence["before"],
    inventoryFence["after"],
    origin.document,
    "Supplemental cleanup changed another document",
  );
  const rows = documentRows(inventoryFence["before"]);
  assert.equal(
    rows.find((r) => r["creationId"] === origin.document.creationId)?.[
      "modified"
    ],
    expectedModified,
  );
  for (const entries of [rows, documentRows(inventoryFence["after"])])
    assert.equal(
      new Set(entries.map((r) => r["creationId"])).size,
      entries.length,
    );
  return Object.freeze({
    requestId,
    clientId: origin.owner.clientId,
    jobId,
    startedAt,
    finishedAt,
    inventoryFence,
  });
}

/** Publish only a newly prepared close verified through the original authenticated owner. */
export async function publishSupplementalCloseProof(
  directory: string,
  backend: CloseProofBackend,
  ports: SupplementalClosePorts,
): Promise<SupplementalCloseReceipt> {
  const runtime = runtimeBinding(await ports.readRuntimeBinding(), backend),
    origin = supplementalOrigin(directory, backend, runtime),
    intent = readJson(path.join(directory, "supplemental-close.intent.json"));
  const ownerLookup = await backend.lookup(
    origin.owner,
    text(intent["requestId"]),
  );
  assert.ok(ownerLookup, "Original owner cannot retrieve the close receipt");
  assert.deepEqual(runtime, intent["runtime"]);
  const original = await ports.readOriginalResult(
    origin.owner,
    text(intent["requestId"]),
  );
  assert.deepEqual(
    runtimeBinding(await ports.readRuntimeBinding(), backend),
    runtime,
  );
  const proof = {
    intentHash: sha256(
      boundedBytes(path.join(directory, "supplemental-close.intent.json")),
    ),
    original,
    ownerLookup,
    runtime,
    publishedAt: Date.now(),
  };
  const validated = validateSupplementalClose(directory, backend, proof);
  immutableRecord(
    path.join(directory, "supplemental-close.json"),
    JSON.stringify(proof) + "\n",
  );
  return validated;
}

function activeProcess(index: Record<string, unknown>): boolean {
  const value = record(index["processIdentity"]);
  if (
    !Number.isSafeInteger(value["pid"]) ||
    typeof value["birth"] !== "string" ||
    !value["birth"]
  )
    return false;
  return (
    childProcessIdentity.priorProcessAlive({
      pid: value["pid"] as number,
      birth: value["birth"],
    }) === true
  );
}

function retainedPeerReceipt(
  report: Record<string, unknown>,
  owner: Record<string, unknown>,
  requests: Record<string, unknown>[],
): { requestId: string; jobId: string } | undefined {
  try {
    if (
      report["status"] !== "failed" ||
      report["cleanup"] !== "deferred" ||
      report["cleanupHold"] === undefined
    )
      return undefined;
    const last = requests.at(-1);
    if (
      !last ||
      record(report["cleanupHold"])["requestId"] !== last["requestId"]
    )
      return undefined;
    const jobs = new Set<string>();
    let previousSequence = -1;
    let terminal;
    for (const entry of requests) {
      if (
        ["save", "cleanup"].includes(text(entry["phase"])) ||
        !["script", "cad", "cad-fenced"].includes(
          text(record(entry["intent"])["kind"]),
        )
      )
        return undefined;
      const requestId = text(entry["requestId"]),
        sequence = Number(requestId.slice(text(owner["clientId"]).length + 1)),
        result = record(entry["result"]),
        receipt = record(result["brokerReceipt"]),
        operation = record(receipt["operationResult"]),
        jobId = text(receipt["jobId"]),
        state = result["state"],
        outcome = operation["executionOutcome"];
      if (
        !exactScenarioRequestId(requestId, text(owner["clientId"])) ||
        sequence !== previousSequence + 1 ||
        result["requestId"] !== requestId ||
        !["succeeded", "failed"].includes(String(state)) ||
        result["sdkSettled"] !== true ||
        typeof result["mayHaveMutated"] !== "boolean" ||
        receipt["requestId"] !== requestId ||
        receipt["clientId"] !== owner["clientId"] ||
        receipt["state"] !== state ||
        !jobId ||
        jobs.has(jobId) ||
        operation["version"] !== 1 ||
        operation["requestId"] !== requestId ||
        operation["jobId"] !== jobId ||
        operation["acceptance"] !== "accepted" ||
        operation["mayHaveMutated"] !== result["mayHaveMutated"] ||
        (state === "succeeded"
          ? outcome !== "succeeded"
          : !["failed", "not_started"].includes(String(outcome))) ||
        (outcome === "not_started" && result["mayHaveMutated"] !== false)
      )
        return undefined;
      jobs.add(jobId);
      previousSequence = sequence;
      terminal = { requestId, jobId };
    }
    return terminal;
  } catch {
    return undefined;
  }
}

function verifiedFixture(
  runRoot: string,
  scenarioId: string,
  backend: Pick<
    ScenarioBackend,
    "identity" | "mode" | "qualification" | "protocol"
  >,
): OwnedUnsavedFixtureProof | undefined {
  try {
    const runId = path.basename(runRoot),
      directory = path.join(runRoot, scenarioId),
      index = readJson(
        path.join(runRoot, "index.json"),
        scenarioReportMaxBytes,
      );
    if (
      !/^[a-f0-9-]{36}$/u.test(runId) ||
      index["runId"] !== runId ||
      index["mode"] !== backend.mode ||
      index["qualification"] !== backend.qualification ||
      index["protocol"] !== backend.protocol ||
      index["backendIdentity"] !== backend.identity ||
      !Array.isArray(index["scenarioIds"]) ||
      !index["scenarioIds"].includes(scenarioId)
    )
      return undefined;

    const report = readJson(
        path.join(directory, "report.json"),
        scenarioReportMaxBytes,
      ),
      owner = record(report["owner"]),
      requests = report["requests"];
    if (
      path.resolve(text(report["directory"])) !== path.resolve(directory) ||
      owner["runId"] !== runId ||
      owner["scenarioId"] !== scenarioId ||
      owner["clientId"] !== "scenario:" + runId + ":" + scenarioId ||
      !["running", "passed", "failed"].includes(String(report["status"])) ||
      !["owned-document", "exclusive-instance"].includes(
        String(report["scope"]),
      ) ||
      report["mode"] !== backend.mode ||
      report["qualification"] !== backend.qualification ||
      report["protocol"] !== backend.protocol ||
      report["backendIdentity"] !== backend.identity ||
      !Array.isArray(requests)
    )
      return undefined;
    const requestIds = requests.map((value: unknown) =>
      text(record(value)["requestId"]),
    );
    if (new Set(requestIds).size !== requestIds.length) return undefined;
    if (
      requestIds.some(
        (requestId) =>
          !exactScenarioRequestId(requestId, text(owner["clientId"])),
      )
    ) {
      const last = record(requests.at(-1)),
        clientId = text(owner["clientId"]);
      const id = text(last["requestId"]),
        prefix = clientId + ":legacy:";
      if (
        last["phase"] !== "legacy-cli" ||
        !id.startsWith(prefix) ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(
          id.slice(prefix.length),
        ) ||
        requestIds
          .slice(0, -1)
          .some((requestId) => !exactScenarioRequestId(requestId, clientId)) ||
        record(report["cleanupHold"])["requestId"] !== id ||
        record(report["cleanupHold"])["reason"] !==
          "Native import child retained an uncertain outcome; inspect original requests" ||
        !fs.existsSync(
          path.join(directory, "cleanup-legacy-readonly-binding.json"),
        )
      )
        return undefined;
      const runtime = runtimeBinding(
        readJson(path.join(directory, "cleanup-hold-resolution.json"))[
          "runtime"
        ],
        backend,
      );
      const resolution = validateCleanupResolution(directory, backend, runtime);
      assert.equal(
        resolution.holdKind,
        /^native-import-\d+$/u.test(scenarioId)
          ? "rejected-import-observation"
          : "settled-legacy-doc-list",
      );
      assert.deepEqual(
        readCleanupRecoveryRequests(directory, backend, runtime),
        requests,
      );
    }

    const creates = requests
      .map(record)
      .filter((entry) => entry["phase"] === "create");
    if (creates.length !== 1) return undefined;
    const create = creates[0]!,
      requestId = text(create["requestId"]),
      result = record(create["result"]),
      receipt = record(result["brokerReceipt"]);
    if (
      record(create["intent"])["kind"] !== "script" ||
      result["requestId"] !== requestId ||
      result["state"] !== "succeeded" ||
      result["sdkSettled"] !== true ||
      result["mayHaveMutated"] !== true ||
      (result["exitCode"] !== undefined && result["exitCode"] !== 0) ||
      receipt["requestId"] !== requestId ||
      receipt["clientId"] !== owner["clientId"] ||
      receipt["state"] !== "succeeded" ||
      typeof receipt["jobId"] !== "string" ||
      !receipt["jobId"]
    )
      return undefined;

    // The create phase may follow capture or other setup requests. Keep its
    // exact original receipt binding instead of inferring identity from an ordinal.
    if (
      receipt["operationResult"] !== undefined &&
      receipt["operationResult"] !== null
    ) {
      const original = record(receipt["operationResult"]);
      if (
        original["version"] !== 1 ||
        original["requestId"] !== requestId ||
        original["jobId"] !== receipt["jobId"] ||
        original["acceptance"] !== "accepted" ||
        original["executionOutcome"] !== "succeeded" ||
        original["mayHaveMutated"] !== true
      )
        return undefined;
    }

    const lines = text(result["stdout"])
      .split(/\r?\n/u)
      .filter((line) => line.startsWith(marker));
    if (lines.length !== 1) return undefined;
    const identity = record(
      JSON.parse(lines[0]!.slice(marker.length)) as unknown,
    );
    const document: Document = {
      creationId: text(identity["creationId"]),
      name: text(identity["name"]),
    };
    const documentValue = record(report["document"]),
      creation = readJson(path.join(directory, "creation.json")),
      baseline = record(index["before"]);
    assert.deepEqual(
      creation,
      identity,
      "Original create body differs from its immutable creation receipt",
    );
    if (
      identity["requestId"] !== requestId ||
      identity["clientId"] !== owner["clientId"] ||
      identity["activeCreationId"] !== document.creationId ||
      creation["creationId"] !== document.creationId ||
      creation["name"] !== document.name ||
      creation["requestId"] !== requestId ||
      creation["clientId"] !== owner["clientId"] ||
      !Array.isArray(baseline["documents"]) ||
      baseline["documents"].some(
        (value: unknown) => record(value)["creationId"] === document.creationId,
      )
    )
      return undefined;
    const typedOwner: Owner = {
        runId,
        scenarioId,
        clientId: text(owner["clientId"]),
      },
      evidence = requests as readonly RequestEvidence[],
      transition = savedIdentityTransition(
        directory,
        document,
        typedOwner,
        evidence,
      );
    if (transition) {
      assert.deepEqual(report["savedIdentityTransition"], transition);
      assert.equal(documentValue["creationId"], transition.creationId);
      assert.equal(documentValue["name"], transition.name);
      assert.ok(
        !baseline["documents"].some(
          (value: unknown) =>
            record(value)["creationId"] === transition.creationId,
        ),
        "Saved successor already belonged to the creator baseline",
      );
      return savedFixtureProof(
        directory,
        index,
        report,
        document,
        typedOwner,
        evidence,
        text(receipt["jobId"]),
      );
    }
    if (
      report["savedIdentityTransition"] !== undefined ||
      documentValue["creationId"] !== document.creationId ||
      documentValue["name"] !== document.name ||
      documentValue["file"] !== undefined
    )
      return undefined;
    if (requests.some((entry) => entry["phase"] === "save"))
      return Object.freeze({
        document: Object.freeze(document),
        state: "unsettled",
      });
    if (fs.existsSync(path.join(directory, "supplemental-close.json"))) {
      try {
        const supplementalClose = validateSupplementalClose(directory, backend);
        return Object.freeze({
          document: Object.freeze(document),
          state: "closed",
          supplementalClose,
        });
      } catch {
        return Object.freeze({
          document: Object.freeze(document),
          state: "unsettled",
        });
      }
    }
    const cleanupEntries = requests
      .map(record)
      .filter((entry) => entry["phase"] === "cleanup");
    let state: FixtureState;
    if (
      report["cleanupHold"] === undefined &&
      cleanupEntries.length === 1 &&
      exactClosedFixtureReceipt(
        cleanupEntries[0]!,
        owner,
        document.creationId,
        text(receipt["jobId"]),
      )
    ) {
      state = "closed";
    } else if (
      report["cleanup"] === "pending" &&
      report["cleanupHold"] === undefined &&
      index["status"] === "running" &&
      activeProcess(index) &&
      (cleanupEntries.length === 0 ||
        (cleanupEntries.length === 1 &&
          exactPendingCleanupIntent(cleanupEntries[0]!, owner)))
    ) {
      state = "open";
    } else {
      const terminalReceipt = retainedPeerReceipt(
        report,
        owner,
        requests.map(record),
      );
      if (terminalReceipt)
        return Object.freeze({
          document: Object.freeze(document),
          state: "retained",
          terminalReceipt: Object.freeze(terminalReceipt),
        });
      state = "unsettled";
    }
    const last = requests.at(-1),
      lastResult = last?.["result"],
      lastReceipt =
        lastResult && record(lastResult)["sdkSettled"] === true
          ? record(lastResult)["brokerReceipt"]
          : undefined;
    const lastSettledReceipt =
      state === "open" &&
      lastReceipt &&
      record(lastReceipt)["requestId"] === last?.["requestId"] &&
      record(lastReceipt)["clientId"] === owner["clientId"] &&
      ["succeeded", "failed"].includes(String(record(lastReceipt)["state"]))
        ? Object.freeze({
            requestId: text(record(lastReceipt)["requestId"]),
            jobId: text(record(lastReceipt)["jobId"]),
          })
        : undefined;
    return Object.freeze({
      document: Object.freeze(document),
      state,
      ...(lastSettledReceipt ? { lastSettledReceipt } : {}),
    });
  } catch {
    return undefined;
  }
}

function savedFixtureProof(
  directory: string,
  index: Record<string, unknown>,
  report: Record<string, unknown>,
  original: Document,
  owner: Owner,
  requests: readonly RequestEvidence[],
  creationJobId: string,
): OwnedUnsavedFixtureProof {
  const partial = (): OwnedUnsavedFixtureProof =>
    Object.freeze({ document: Object.freeze(original), state: "unsettled" });
  const declared = record(report["document"]);
  if (declared["file"] === undefined) return partial();
  const document = {
      creationId: text(declared["creationId"]),
      name: text(declared["name"]),
    },
    folder = saveIntent(directory, original, owner, requests);
  assert.ok(folder, "Saved successor lacks its original save intent");
  assert.deepEqual(report["fixture"], folder);
  const save = requests.find((entry) => entry.phase === "save");
  assert.ok(save?.result?.brokerReceipt);
  const jobs = new Set([creationJobId, save.result.brokerReceipt.jobId]),
    readbacks = requests.filter((entry) => entry.phase === "save-observe");
  assert.equal(jobs.size, 2, "Save reused the original creation job");
  if (!readbacks.length) return partial();
  for (const entry of readbacks) {
    const result = entry.result;
    if (!result?.sdkSettled || result.state !== "succeeded") return partial();
    assert.equal(result.requestId, entry.requestId);
    assert.ok(exactScenarioRequestId(entry.requestId, owner.clientId));
    assert.ok(
      Number(entry.requestId.slice(owner.clientId.length + 1)) >
        Number(save.requestId.slice(owner.clientId.length + 1)),
    );
    assert.equal(record(record(entry)["intent"])["kind"], "script");
    const receipt = record(result.brokerReceipt);
    assert.equal(receipt["requestId"], entry.requestId);
    assert.equal(receipt["clientId"], owner.clientId);
    assert.equal(receipt["state"], "succeeded");
    const jobId = text(receipt["jobId"]);
    assert.ok(!jobs.has(jobId), "Saved readback reused another lifecycle job");
    jobs.add(jobId);
    const value = resultValue(entry);
    assert.ok(value);
    assert.equal(value["creationId"], document.creationId);
    if (value["fileId"] !== undefined || value["complete"] === true)
      assert.equal(value["saved"], true);
  }
  const file = recoveredFile(document, folder, requests);
  if (!file) return partial();
  // Version is pinned by the producer readback, not re-measured by inventory.
  assert.deepEqual(declared["file"], file);
  const savedDocument = Object.freeze({ ...document, file }),
    closeEntries = requests.filter((entry) => entry.phase === "cleanup-close");
  let savedState: FixtureState;
  if (
    report["cleanupHold"] === undefined &&
    closeEntries.length === 1 &&
    exactClosedFixtureReceipt(
      record(closeEntries[0]),
      record(owner),
      savedDocument.creationId,
      creationJobId,
      "cleanup-close",
    )
  ) {
    assert.ok(!jobs.has(text(closeEntries[0]!.result?.brokerReceipt?.jobId)));
    savedState = "closed";
  } else if (
    report["cleanup"] === "pending" &&
    report["cleanupHold"] === undefined &&
    index["status"] === "running" &&
    activeProcess(index) &&
    (closeEntries.length === 0 ||
      (closeEntries.length === 1 &&
        exactPendingCleanupIntent(
          record(closeEntries[0]),
          record(owner),
          "cleanup-close",
        )))
  ) {
    savedState = "open";
  } else savedState = "unsettled";
  return Object.freeze({
    document: Object.freeze(original),
    state: "saved",
    savedDocument,
    savedState,
  });
}

function exactClosedFixtureReceipt(
  entry: Record<string, unknown>,
  owner: Record<string, unknown>,
  creationId: string,
  creationJobId: string,
  phase: "cleanup" | "cleanup-close" = "cleanup",
): boolean {
  try {
    const clientId = text(owner["clientId"]),
      requestId = text(entry["requestId"]),
      sequence = requestId.slice(clientId.length + 1),
      result = record(entry["result"]),
      receipt = record(result["brokerReceipt"]),
      lines = text(result["stdout"])
        .split(/\r?\n/u)
        .filter((line) => line.startsWith(marker));
    if (
      !exactScenarioRequestId(requestId, clientId) ||
      requestId !== clientId + ":" + sequence ||
      requestId === clientId + ":0" ||
      entry["phase"] !== phase ||
      record(entry["intent"])["kind"] !== "script" ||
      result["requestId"] !== requestId ||
      result["state"] !== "succeeded" ||
      result["sdkSettled"] !== true ||
      result["mayHaveMutated"] !== true ||
      receipt["requestId"] !== requestId ||
      receipt["clientId"] !== clientId ||
      receipt["state"] !== "succeeded" ||
      typeof receipt["jobId"] !== "string" ||
      !receipt["jobId"] ||
      receipt["jobId"] === creationJobId ||
      lines.length !== 1
    )
      return false;
    const closed = record(
      JSON.parse(lines[0]!.slice(marker.length)) as unknown,
    );
    return closed["creationId"] === creationId && closed["closed"] === true;
  } catch {
    return false;
  }
}

function exactPendingCleanupIntent(
  entry: Record<string, unknown>,
  owner: Record<string, unknown>,
  phase: "cleanup" | "cleanup-close" = "cleanup",
): boolean {
  try {
    const clientId = text(owner["clientId"]),
      requestId = text(entry["requestId"]);
    return (
      entry["phase"] === phase &&
      record(entry["intent"])["kind"] === "script" &&
      entry["result"] === undefined &&
      exactScenarioRequestId(requestId, clientId) &&
      requestId !== clientId + ":0"
    );
  } catch {
    return false;
  }
}

/** Read exact creation and cleanup receipts from existing scenario reports. */
export function discoverOwnedUnsavedFixtureProofs(
  root: string,
  backend: Pick<
    ScenarioBackend,
    "identity" | "mode" | "qualification" | "protocol"
  >,
): ReadonlyMap<string, OwnedUnsavedFixtureProof> {
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Expected a regular scenario artifact root");
  const fixtures = new Map<string, OwnedUnsavedFixtureProof>(),
    ambiguous = new Set<string>();
  for (const runId of fs.readdirSync(root)) {
    if (!/^[a-f0-9-]{36}$/u.test(runId)) continue;
    const runRoot = path.join(root, runId),
      runStat = fs.lstatSync(runRoot);
    if (!runStat.isDirectory() || runStat.isSymbolicLink()) continue;
    let index: Record<string, unknown>;
    try {
      index = readJson(
        path.join(runRoot, "index.json"),
        scenarioReportMaxBytes,
      );
    } catch {
      continue;
    }
    if (
      !Array.isArray(index["scenarioIds"]) ||
      index["backendIdentity"] !== backend.identity
    )
      continue;
    for (const scenarioId of index["scenarioIds"]) {
      if (
        typeof scenarioId !== "string" ||
        !/^[a-z0-9][a-z0-9_-]{0,100}$/u.test(scenarioId)
      )
        continue;
      const document = verifiedFixture(runRoot, scenarioId, backend);
      if (!document || ambiguous.has(document.document.creationId)) continue;
      if (fixtures.has(document.document.creationId)) {
        fixtures.delete(document.document.creationId);
        ambiguous.add(document.document.creationId);
      } else fixtures.set(document.document.creationId, document);
    }
  }
  return fixtures;
}

/** Read currently open, receipt-bound fixtures for callers that need live peers. */
export function discoverOwnedUnsavedFixtures(
  root: string,
  backend: Pick<
    ScenarioBackend,
    "identity" | "mode" | "qualification" | "protocol"
  >,
): ReadonlyMap<string, Document> {
  return new Map(
    [...discoverOwnedUnsavedFixtureProofs(root, backend)]
      .filter(([, proof]) => proof.state === "open")
      .map(([creationId, proof]) => [creationId, proof.document]),
  );
}

function documentRows(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value), "Missing document inventory");
  const documents = value.map(record),
    ids = documents.map((document) => text(document["creationId"]));
  assert.equal(new Set(ids).size, ids.length, "Duplicate document identity");
  return documents;
}

function stableDocuments(documents: Record<string, unknown>[]) {
  return documents
    .map((document) => {
      const stable = { ...document };
      delete stable["active"];
      return stable;
    })
    .sort((left, right) =>
      text(left["creationId"]).localeCompare(text(right["creationId"])),
    );
}

function assertSavedDocument(
  current: Record<string, unknown>[],
  expected: Document & { readonly file: SavedFile },
): void {
  const matches = current.filter(
    (document) => document["creationId"] === expected.creationId,
  );
  assert.equal(
    matches.length,
    1,
    "Exact saved successor is missing or duplicated",
  );
  assert.equal(matches[0]!["name"], expected.name);
  assert.equal(matches[0]!["saved"], true);
  assert.equal(matches[0]!["fileId"], expected.file.fileId);
}

function observedTransfer(
  creationId: string,
  current: Record<string, unknown>[],
  proofs: ReadonlyMap<string, OwnedUnsavedFixtureProof>,
  allowUnsettled: boolean,
): boolean {
  const proof = [...proofs.values()].find(
    (candidate) =>
      candidate.state === "saved" &&
      (candidate.document.creationId === creationId ||
        candidate.savedDocument.creationId === creationId),
  );
  if (proof?.state !== "saved") return false;
  if (proof.savedState === "closed")
    return !current.some(
      (document) =>
        document["creationId"] === proof.document.creationId ||
        document["creationId"] === proof.savedDocument.creationId,
    );
  if (
    creationId !== proof.document.creationId ||
    creationId === proof.savedDocument.creationId ||
    (proof.savedState !== "open" && !allowUnsettled)
  )
    return false;
  assertSavedDocument(current, proof.savedDocument);
  return true;
}

/** Check causality inside one SDK turn while retaining baseline and target identity. */
export function assertFencedDocumentInventory(
  beforeValue: unknown,
  afterValue: unknown,
  target: Document,
  baselineValue: unknown,
  verifiedPeers: ReadonlyMap<string, OwnedUnsavedFixtureProof>,
  message: string,
): void {
  const before = documentRows(beforeValue),
    after = documentRows(afterValue),
    proofs = new Map(verifiedPeers),
    peerTarget = proofs.get(target.creationId);
  if (peerTarget) {
    assert.deepEqual(
      peerTarget.document,
      target,
      "Owned target conflicts with peer receipt",
    );
    assert.equal(
      peerTarget.state,
      "open",
      "Owned target lacks live open provenance",
    );
  }
  proofs.set(target.creationId, { document: target, state: "open" });
  assertOwnedUnsavedDocument(before, target);
  assertOwnedUnsavedDocument(after, target);
  assertReceiptBoundDocumentInventory(baselineValue, before, proofs, message);
  assertReceiptBoundDocumentInventory(baselineValue, after, proofs, message);
  assert.deepEqual(
    stableDocuments(
      before.filter((document) => document["creationId"] !== target.creationId),
    ),
    stableDocuments(
      after.filter((document) => document["creationId"] !== target.creationId),
    ),
    message,
  );
}

/** Check an unsaved owned close against the same-turn pre/post inventory fence. */
export function assertFencedClosedDocumentInventory(
  beforeValue: unknown,
  afterValue: unknown,
  target: Document,
  message: string,
): void {
  const before = documentRows(beforeValue),
    after = documentRows(afterValue);
  assertOwnedUnsavedDocument(before, target);
  assert.equal(
    after.some((document) => document["creationId"] === target.creationId),
    false,
    "Owned fixture remains open after cleanup",
  );
  const beforeOthers = before.filter(
    (document) => document["creationId"] !== target.creationId,
  );
  assert.deepEqual(
    stableDocuments(beforeOthers),
    stableDocuments(after),
    message,
  );
}

/** Admit only exact live peer fixtures or fixtures closed by their exact receipt. */
export function assertReceiptBoundDocumentInventory(
  beforeValue: unknown,
  currentValue: unknown,
  proofs: ReadonlyMap<string, OwnedUnsavedFixtureProof>,
  message: string,
  allowVisibleUnsettledPeers = false,
  observedCreationIds: ReadonlySet<string> = new Set(),
): void {
  const before = documentRows(beforeValue),
    current = documentRows(currentValue);
  for (const creationId of observedCreationIds) {
    if (
      !current.some((document) => document["creationId"] === creationId) &&
      !observedTransfer(creationId, current, proofs, allowVisibleUnsettledPeers)
    )
      assert.equal(
        proofs.get(creationId)?.state,
        "closed",
        "An observed fixture disappeared without its exact close receipt",
      );
  }
  const admittedPeers = new Set<string>();
  for (const [creationId, proof] of proofs) {
    assert.equal(proof.document.creationId, creationId);
    if (proof.state === "saved") {
      const successorId = proof.savedDocument.creationId;
      if (creationId !== successorId)
        assert.equal(
          current.some((document) => document["creationId"] === creationId),
          false,
          "Both original and saved successor identities remain visible",
        );
      if (proof.savedState === "closed") {
        assert.equal(
          current.some((document) => document["creationId"] === successorId),
          false,
          "The receipt-closed saved successor remains visible",
        );
      } else if (
        proof.savedState === "unsettled" &&
        (!allowVisibleUnsettledPeers ||
          !current.some((document) => document["creationId"] === successorId))
      ) {
        continue;
      } else assertSavedDocument(current, proof.savedDocument);
      admittedPeers.add(creationId);
      admittedPeers.add(successorId);
      continue;
    }
    // An unresolved baseline fixture has no ownership exemption. A read-only
    // observer may admit a new peer only while its exact identity is visible.
    if (proof.state === "unsettled") {
      if (
        !allowVisibleUnsettledPeers ||
        before.some((document) => document["creationId"] === creationId)
      )
        continue;
      // Historical creation receipts are not evidence that a fixture was ever
      // visible in this run. Prior observations above still fence disappearance.
      if (!current.some((document) => document["creationId"] === creationId))
        continue;
      assert.equal(
        current.filter((document) => document["creationId"] === creationId)
          .length,
        1,
        "An unsettled peer disappeared without its exact close receipt",
      );
      assertOwnedUnsavedDocument(current, proof.document);
      admittedPeers.add(creationId);
      continue;
    }
    if (
      proof.state !== "open" &&
      proof.state !== "closed" &&
      proof.state !== "retained"
    )
      continue;
    admittedPeers.add(creationId);
    const matches = current.filter(
      (document) => document["creationId"] === creationId,
    );
    if (proof.state === "closed") {
      assert.equal(matches.length, 0, "A closed peer fixture remains open");
      continue;
    }
    assert.equal(matches.length, 1, "A live receipt-proven fixture is missing");
    assertOwnedUnsavedDocument(current, proof.document);
  }
  assert.deepEqual(
    stableDocuments(
      current.filter(
        (document) => !admittedPeers.has(text(document["creationId"])),
      ),
    ),
    stableDocuments(
      before.filter(
        (document) => !admittedPeers.has(text(document["creationId"])),
      ),
    ),
    message,
  );
}

export function assertOwnedUnsavedDocument(
  value: unknown,
  expected: Document,
  requireActive = false,
): void {
  const matches = documentRows(value).filter(
    (document) => document["creationId"] === expected.creationId,
  );
  assert.equal(
    matches.length,
    1,
    "Exact fixture identity is missing or duplicated",
  );
  assert.equal(
    matches[0]!["name"],
    expected.name,
    "Fixture identity now refers to another document name",
  );
  assert.equal(matches[0]!["saved"], false, "Fixture unexpectedly saved");
  assert.equal(matches[0]!["fileId"], null, "Fixture acquired a cloud file");
  if (requireActive)
    assert.equal(matches[0]!["active"], true, "Fixture is not active");
}

export function originalActiveDocument(
  activeCreationId: unknown,
  baselineValue: unknown,
  owned: ReadonlyMap<string, Document>,
): Document | undefined {
  const baseline = documentRows(baselineValue);
  if (activeCreationId === null || activeCreationId === undefined)
    return undefined;
  const creationId = text(activeCreationId);
  if (owned.has(creationId)) return undefined;
  const matches = baseline.filter(
    (document) => document["creationId"] === creationId,
  );
  assert.equal(
    matches.length,
    1,
    "Original active document is not part of the verified baseline",
  );
  return Object.freeze({
    creationId,
    name: text(matches[0]!["name"]),
  });
}

export function assertPreservedDocumentInventory(
  beforeValue: unknown,
  currentValue: unknown,
  owned: ReadonlyMap<string, Document>,
  message: string,
): void {
  const before = documentRows(beforeValue),
    current = documentRows(currentValue);
  for (const document of current) {
    const creationId = text(document["creationId"]),
      expected = owned.get(creationId);
    if (!expected) continue;
    assert.equal(document["name"], expected.name, "Owned fixture name changed");
    assert.equal(document["saved"], false, "Owned fixture unexpectedly saved");
    assert.equal(
      document["fileId"],
      null,
      "Owned fixture acquired a cloud file",
    );
  }
  assert.deepEqual(
    stableDocuments(
      current.filter((document) => !owned.has(text(document["creationId"]))),
    ),
    stableDocuments(
      before.filter((document) => !owned.has(text(document["creationId"]))),
    ),
    message,
  );
}

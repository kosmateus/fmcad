import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  record,
  text,
  type Document,
  type Owner,
  type ScenarioBackend,
} from "./contracts";
import * as programs from "./programs";
import { childProcessIdentity } from "./legacy-handoff";
import { queueExecution } from "./queue-backend";

export interface CleanupRuntimeBinding {
  readonly buildHash: string;
  readonly instanceId: string;
}
export interface CleanupHoldPorts {
  readRuntimeBinding(): Promise<CleanupRuntimeBinding>;
  readOriginalResult(owner: Owner, requestId: string): Promise<unknown>;
}
export interface CleanupRecoveryPorts {
  readRuntimeBinding(): Promise<CleanupRuntimeBinding>;
  readJobResult(
    owner: Owner,
    requestId: string,
    jobId: string,
  ): Promise<unknown>;
}
export async function recordFailedCleanupInspection(
  backend: Pick<
    ScenarioBackend,
    "identity" | "mode" | "qualification" | "protocol"
  >,
  directory: string,
  ports: CleanupRecoveryPorts,
  jobId: string,
): Promise<void> {
  assert.ok(
    !fs.existsSync(path.join(directory, canonical)),
    "Resolution already exists",
  );
  assert.ok(
    !fs.existsSync(path.join(directory, reinspectionIntent)),
    "Never reset a reinspection attempt",
  );
  const c = context(directory, backend),
    runtime = await ports.readRuntimeBinding();
  runtimeBinding(runtime, backend);
  noProducer(directory, c.document);
  const intent = json(path.join(directory, inspectionIntent));
  const held = c.requests.at(-1)!,
    heldReceipt = record(record(held["result"])["brokerReceipt"]);
  const holdOriginal = await ports.readJobResult(
    c.owner,
    text(held["requestId"]),
    text(heldReceipt["jobId"]),
  );
  const requestId = text(intent["requestId"]);
  const raw = await ports.readJobResult(c.owner, requestId, jobId);
  const failure = {
    version: 1,
    owner: c.owner,
    requestId,
    jobId,
    runtime,
    reportHash: c.reportHash,
    intentHash: hash(read(path.join(directory, inspectionIntent))),
    holdOriginal,
    raw,
  };
  validateFailedInspection(directory, backend, runtime, failure);
  assert.deepEqual(await ports.readRuntimeBinding(), runtime);
  noProducer(directory, c.document);
  immutable(path.join(directory, failedInspection), failure);
}
export function createCleanupRecoveryAdapter(
  backend: ScenarioBackend,
  directory: string,
  ports: CleanupRecoveryPorts,
): { backend: ScenarioBackend; ports: CleanupHoldPorts } {
  assert.ok(backend.lookup, "Underlying original lookup is mandatory");
  const c = context(directory, backend),
    jobs = new Map<string, string>(),
    attempted = new Set<string>();
  const sameOwner = (owner: Owner) =>
    assert.deepEqual(owner, c.owner, "Foreign cleanup owner");
  const sameRequest = (requestId: string) =>
    assert.ok(
      requestId.startsWith(c.owner.clientId + ":") &&
        /^[0-9]+$/u.test(requestId.slice(c.owner.clientId.length + 1)),
      "Foreign cleanup request",
    );
  const bind = (requestId: string, result: unknown) => {
    sameRequest(requestId);
    assert.equal(record(result)["requestId"], requestId);
    const receipt = record(record(result)["brokerReceipt"]);
    assert.equal(receipt["requestId"], requestId);
    assert.equal(receipt["clientId"], c.owner.clientId);
    const jobId = text(receipt["jobId"]);
    assert.ok(jobId, "Missing exact original job binding");
    assert.ok(
      !jobs.has(requestId) || jobs.get(requestId) === jobId,
      "Original job binding changed",
    );
    jobs.set(requestId, jobId);
  };
  for (const row of c.requests) bind(text(row["requestId"]), row["result"]);
  if (fs.existsSync(path.join(directory, failedInspection))) {
    const failure = json(path.join(directory, failedInspection));
    assert.equal(failure["reportHash"], c.reportHash);
    assert.deepEqual(failure["owner"], c.owner);
    const requestId = text(failure["requestId"]);
    assert.equal(
      json(path.join(directory, inspectionIntent))["requestId"],
      requestId,
    );
    assert.equal(record(record(failure["raw"])["job"])["id"], failure["jobId"]);
    bind(requestId, queueExecution(failure["raw"], c.owner, requestId));
  }
  const readOriginalResult = async (
    owner: Owner,
    requestId: string,
  ): Promise<unknown> => {
    sameOwner(owner);
    sameRequest(requestId);
    assert.equal(
      hash(read(path.join(directory, "report.json"))),
      c.reportHash,
      "Original report changed after adapter binding",
    );
    if (!jobs.has(requestId)) {
      const found = await backend.lookup!(owner, requestId);
      assert.ok(found, "Missing exact admitted job binding; never replay");
      bind(requestId, found);
    }
    const jobId = jobs.get(requestId)!;
    const raw = await ports.readJobResult(owner, requestId, jobId),
      job = record(record(raw)["job"]);
    assert.equal(job["id"], jobId, "Foreign original job");
    assert.equal(job["requestId"], requestId, "Foreign original request");
    assert.equal(job["clientId"], owner.clientId, "Foreign original client");
    return raw;
  };
  const recovered: ScenarioBackend = {
    identity: backend.identity,
    mode: backend.mode,
    qualification: backend.qualification,
    protocol: backend.protocol,
    capabilities: backend.capabilities,
    fusionPath: backend.fusionPath.bind(backend),
    async lookup(owner, requestId) {
      sameOwner(owner);
      sameRequest(requestId);
      if (!jobs.has(requestId)) {
        const found = await backend.lookup!(owner, requestId);
        if (!found) {
          assert.ok(
            !attempted.has(requestId),
            "Admitted request outcome is unverified; never replay",
          );
          return null;
        }
        bind(requestId, found);
      }
      return queueExecution(
        await readOriginalResult(owner, requestId),
        owner,
        requestId,
      );
    },
    async execute(request) {
      sameOwner(request.owner);
      sameRequest(request.requestId);
      assert.equal(request.directory, directory);
      assert.deepEqual(request.target, c.document);
      assert.ok(
        !jobs.has(request.requestId) && !attempted.has(request.requestId),
        "Never replay an original or attempted request",
      );
      assert.equal(
        await backend.lookup!(request.owner, request.requestId),
        null,
        "Request is already admitted",
      );
      attempted.add(request.requestId);
      const result = await backend.execute(request);
      if (result.brokerReceipt) bind(request.requestId, result);
      return result;
    },
  };
  return {
    backend: recovered,
    ports: {
      readRuntimeBinding: ports.readRuntimeBinding.bind(ports),
      readOriginalResult,
    },
  };
}
export interface VerifiedCleanupResolution {
  readonly digest: string;
  readonly owner: Owner;
  readonly document: Document;
  readonly inspectedModified: boolean;
  readonly runtime: CleanupRuntimeBinding;
  readonly inspectionRequestId: string;
  readonly inspectionJobId: string;
  readonly inspectedAt: number;
  readonly expiresAt: number;
}
const canonical = "cleanup-hold-resolution.json";
const inspectionIntent = "cleanup-hold-inspection-intent.json";
const reinspectionIntent = "cleanup-hold-reinspection-intent.json";
const failedInspection = "cleanup-hold-inspection-failure.json";
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const read = (filename: string): string => {
  assert.equal(
    fs.realpathSync(filename),
    filename,
    "Evidence path is not canonical",
  );
  const fd = fs.openSync(
    filename,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    assert.ok(fs.fstatSync(fd).isFile(), "Expected regular evidence file");
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
};
const json = (filename: string) =>
  record(JSON.parse(read(filename)) as unknown);
const immutable = (filename: string, value: unknown) => {
  const fd = fs.openSync(filename, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
};
function marker(
  stdout: unknown,
  prefix = programs.marker,
): Record<string, unknown> {
  const lines = text(stdout)
    .split("\n")
    .filter((line) => line.startsWith(prefix));
  assert.equal(lines.length, 1, "Missing or ambiguous original marker");
  return record(JSON.parse(lines[0]!.slice(prefix.length)) as unknown);
}
function context(
  directory: string,
  backend: Pick<
    ScenarioBackend,
    "identity" | "mode" | "qualification" | "protocol"
  >,
) {
  assert.equal(path.resolve(directory), directory);
  assert.equal(fs.realpathSync(directory), directory);
  const reportBytes = read(path.join(directory, "report.json")),
    report = record(JSON.parse(reportBytes) as unknown);
  const identity = record(report["owner"]);
  const owner: Owner = {
    runId: text(identity["runId"]),
    scenarioId: text(identity["scenarioId"]),
    clientId: text(identity["clientId"]),
  };
  assert.match(owner.runId, /^[a-f0-9-]{36}$/u);
  assert.match(owner.scenarioId, /^[a-z0-9][a-z0-9_-]{0,100}$/u);
  assert.equal(owner.clientId, `scenario:${owner.runId}:${owner.scenarioId}`);
  assert.equal(path.basename(directory), owner.scenarioId);
  assert.equal(path.basename(path.dirname(directory)), owner.runId);
  const indexBytes = read(path.join(directory, "..", "index.json"));
  assert.equal(record(JSON.parse(indexBytes) as unknown)["runId"], owner.runId);
  assert.equal(report["directory"], directory);
  assert.equal(report["status"], "failed");
  assert.equal(report["cleanup"], "deferred");
  assert.equal(report["mode"], backend.mode);
  assert.equal(report["qualification"], backend.qualification);
  assert.equal(report["protocol"], backend.protocol);
  assert.equal(report["backendIdentity"], backend.identity);
  assert.equal(backend.mode, "fusion");
  assert.equal(backend.qualification, "broker");
  assert.equal(backend.protocol, "addin");
  assert.equal(
    report["file"],
    undefined,
    "Saved fixture cannot resolve an unsaved hold",
  );
  const doc = record(report["document"]);
  const document: Document = {
    creationId: text(doc["creationId"]),
    name: text(doc["name"]),
  };
  assert.match(document.creationId, /^[a-f0-9-]{36}$/u);
  assert.equal(
    document.name,
    `FMCAD_SCENARIO_${owner.runId}_${owner.scenarioId}`,
  );
  assert.equal(doc["file"], undefined);
  const hold = record(report["cleanupHold"]);
  assert.ok(
    text(hold["requestId"]) && text(hold["reason"]),
    "Missing cleanup hold",
  );
  assert.ok(Array.isArray(report["requests"]) && report["requests"].length > 0);
  const requests = report["requests"].map(record);
  assert.equal(
    requests.at(-1)?.["requestId"],
    hold["requestId"],
    "Hold is not the final original request",
  );
  const ids = requests.map((row) => text(row["requestId"]));
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids)
    assert.match(id, new RegExp("^" + owner.clientId + ":[0-9]+$", "u"));
  const creationBytes = read(path.join(directory, "creation.json"));
  const creation = record(JSON.parse(creationBytes) as unknown);
  assert.equal(creation["creationId"], document.creationId);
  assert.equal(creation["name"], document.name);
  assert.equal(creation["clientId"], owner.clientId);
  const creates = requests.filter((row) => row["phase"] === "create");
  assert.equal(creates.length, 1);
  assert.equal(
    record(creates[0]!["result"])["state"],
    "succeeded",
    "Owned creation did not succeed",
  );
  assert.equal(creation["requestId"], creates[0]!["requestId"]);
  assert.deepEqual(marker(record(creates[0]!["result"])["stdout"]), creation);
  return {
    owner,
    document,
    report,
    requests,
    hold,
    reportHash: hash(reportBytes),
    creationHash: hash(creationBytes),
    indexHash: hash(indexBytes),
  };
}
function runtimeBinding(
  value: CleanupRuntimeBinding,
  backend: Pick<ScenarioBackend, "identity">,
) {
  assert.match(value.buildHash, /^[a-f0-9]{64}$/u);
  assert.ok(value.instanceId);
  assert.equal(backend.identity, "fusion:addin:" + value.buildHash);
}
function original(
  directory: string,
  owner: Owner,
  row: Record<string, unknown>,
  raw: unknown,
) {
  const value = record(raw),
    job = record(value["job"]),
    execution = record(value["execution"]),
    result = record(row["result"]);
  const receipt = record(result["brokerReceipt"]),
    id = text(row["requestId"]);
  assert.equal(job["requestId"], id);
  assert.equal(job["clientId"], owner.clientId);
  assert.equal(receipt["requestId"], id);
  assert.equal(receipt["clientId"], owner.clientId);
  assert.equal(job["id"], receipt["jobId"]);
  assert.ok(text(job["id"]));
  assert.ok(
    job["state"] === "succeeded" || job["state"] === "failed",
    "Original request is not terminal",
  );
  assert.equal(execution["sdkSettled"], true, "Original SDK is unsettled");
  assert.equal(result["sdkSettled"], true);
  assert.equal(result["state"], job["state"]);
  assert.equal(execution["state"], job["state"]);
  assert.equal(receipt["state"], job["state"]);
  assert.equal(value["stdout"], result["stdout"]);
  for (const key of ["submittedAt", "startedAt", "finishedAt"])
    assert.ok(
      typeof job[key] === "number" && Number.isFinite(job[key]) && job[key] > 0,
    );
  assert.ok(
    Number(job["submittedAt"]) <= Number(job["startedAt"]) &&
      Number(job["startedAt"]) <= Number(job["finishedAt"]),
  );
  const sourceFile = path.join(directory, `request-${id.split(":").at(-1)}.py`),
    source = read(sourceFile);
  const provenance = record(value["provenance"]);
  assert.equal(provenance["status"], "available");
  assert.ok(Array.isArray(provenance["inputs"]));
  if (source) {
    const inputs = provenance["inputs"]
      .map(record)
      .filter(
        (input) =>
          input["kind"] === "source" && input["originalPath"] === sourceFile,
      );
    assert.equal(inputs.length, 1, "Missing authenticated original source");
    assert.equal(inputs[0]!["sha256"], hash(source));
    assert.equal(inputs[0]!["bytes"], Buffer.byteLength(source));
  } else {
    assert.equal(
      record(row["intent"])["kind"],
      "cad",
      "Script source is missing",
    );
    assert.match(text(provenance["inputIdentity"]), /^[a-f0-9]{64}$/u);
  }
  return { source, job, value };
}
// Only inert Python literals may vary within the exact generated admission program.
// No identifiers, calls, attributes, operators or comments can enter these slots.
function literal(value: string) {
  let rest = value;
  const token =
    /^(?:\s+|"(?:[^"\\\r\n]|\\.)*"|-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|True\b|False\b|None\b|[\[\]{},:])/u;
  while (rest) {
    const match = token.exec(rest);
    assert.ok(match, "Non-literal admission parameter");
    rest = rest.slice(match[0].length);
  }
}
function admissionSource(
  source: string,
  document: Document,
  operation: string,
  requestId: string,
) {
  const normalize = (input: string) =>
    input
      .split("\n")
      .map((line) => {
        const assignment =
          /^(    _fmcad_(?:expected_baseline|expected_peers|closed_peers|saved_transfers): [^=]+ = )(.*)$/u.exec(
            line,
          );
        if (assignment) {
          literal(assignment[2]!);
          return assignment[1] + "[]";
        }
        const call =
          /^(    _fmcad_result = FMCAD.call\("[^"\\]+", )(.*)(\))$/u.exec(line);
        if (call) {
          literal(call[2]!);
          return call[1] + "{}, None" + call[3];
        }
        return line;
      })
      .join("\n");
  assert.equal(
    normalize(source),
    normalize(
      programs.cadFence(document, operation, {}, [], [], [], "root", requestId),
    ),
    "Hold source is not the supported admission program",
  );
}
function inventory(value: unknown, document: Document) {
  assert.ok(Array.isArray(value));
  const rows = value.map(record),
    ids = rows.map((row) => text(row["creationId"]));
  assert.equal(new Set(ids).size, ids.length);
  const own = rows.filter((row) => row["creationId"] === document.creationId);
  assert.equal(own.length, 1);
  assert.equal(own[0]!["name"], document.name);
  assert.equal(own[0]!["saved"], false);
  assert.equal(own[0]!["fileId"], null);
  assert.equal(typeof own[0]!["modified"], "boolean");
  return own[0]!;
}
function admissionProof(c: ReturnType<typeof context>, source: string) {
  const last = c.requests.at(-1)!,
    result = record(last["result"]);
  assert.match(
    text(c.hold["reason"]),
    /^Fenced CAD turn failed; leave the owned document for inspection: (?:Inventory re-admission lacks exact peer lifecycle receipts|A previously admitted peer lost its exact lifecycle proof)(?:\n|$)/u,
  );
  assert.equal(result["state"], "succeeded");
  const output = marker(result["stdout"], "FMCAD_RESULT ");
  assert.equal(output["success"], true);
  assert.deepEqual(output["helperCallsOnly"], []);
  const payload = record(output["result"]),
    admission = record(payload["admission"]);
  assert.equal(payload["success"], true);
  assert.equal(payload["creationId"], c.document.creationId);
  assert.equal(payload["document"], c.document.name);
  assert.equal(admission["status"], "inventory-changed");
  assert.equal(admission["requestId"], last["requestId"]);
  assert.equal(admission["helperCalls"], 0);
  assert.equal(admission["mutationStarted"], false);
  const fence = record(payload["inventoryFence"]);
  assert.equal(fence["version"], 1);
  inventory(fence["before"], c.document);
  assert.deepEqual(fence["after"], fence["before"]);
  admissionSource(
    source,
    c.document,
    text(payload["operation"]),
    text(last["requestId"]),
  );
}
type HoldProof =
  { kind: "admission-only" } | { kind: "owned-observation"; bodyToken: string };
function holdProof(c: ReturnType<typeof context>, source: string): HoldProof {
  if (text(c.hold["reason"]).startsWith("Fenced CAD turn failed;")) {
    admissionProof(c, source);
    return { kind: "admission-only" };
  }
  assert.equal(
    c.owner.scenarioId,
    "native-pose-methods-0",
    "Unsupported observation hold",
  );
  assert.match(
    text(c.hold["reason"]),
    /^Owned unsaved fixture guard failed; inspect original identity before cleanup: A non-fixture document changed during the owned unsaved case/u,
  );
  const last = c.requests.at(-1)!;
  assert.equal(last["phase"], "observe-native-pose-methods-guard-3");
  assert.equal(record(last["result"])["state"], "succeeded");
  assert.equal(
    source,
    programs.unsavedState(c.document),
    "Observation is not the exact readonly unsaved guard",
  );
  const observation = marker(record(last["result"])["stdout"]);
  assert.equal(observation["creationId"], c.document.creationId);
  inventory(observation["documents"], c.document);
  const shapes = c.requests.filter(
    (row) => record(row["intent"])["kind"] === "cad",
  );
  assert.equal(
    shapes.length,
    1,
    "Pose history contains additional direct CAD operations",
  );
  const shape = shapes[0]!;
  assert.equal(shape["phase"], "cad-native-pose-methods-2");
  assert.equal(
    c.requests.indexOf(shape),
    c.requests.length - 2,
    "Shape is not immediately before the held observation",
  );
  assert.equal(record(shape["result"])["state"], "succeeded");
  const output = record(
    JSON.parse(text(record(shape["result"])["stdout"])) as unknown,
  );
  assert.equal(output["success"], true);
  assert.equal(output["operation"], "shape.box");
  assert.equal(output["document"], c.document.name);
  const result = record(output["result"]);
  assert.equal(result["recipe"], "box");
  assert.equal(record(result["feature"])["name"], "PoseBody");
  assert.ok(Array.isArray(result["bodies"]) && result["bodies"].length === 1);
  const body = record(result["bodies"][0]);
  assert.equal(body["kind"], "body");
  assert.equal(record(body["component"])["name"], "root");
  assert.ok(text(body["token"]));
  return { kind: "owned-observation", bodyToken: text(body["token"]) };
}
function holdModified(
  c: ReturnType<typeof context>,
  proof: HoldProof,
): boolean {
  const result = record(c.requests.at(-1)!["result"]);
  const observed =
    proof.kind === "admission-only"
      ? record(
          record(marker(result["stdout"], "FMCAD_RESULT ")["result"])[
            "inventoryFence"
          ],
        )["before"]
      : marker(result["stdout"])["documents"];
  return inventory(observed, c.document)["modified"] as boolean;
}
function noProducer(directory: string, document: Document) {
  // Cleanup is a terminal lifecycle operation. Unknown liveness is not proof of exit.
  const root = path.dirname(path.dirname(directory));
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const filename = path.join(root, entry.name, "index.json");
    if (!fs.existsSync(filename)) continue;
    const index = json(filename),
      processIdentity = record(index["processIdentity"]);
    const own = path.dirname(directory) === path.dirname(filename);
    if (!own && index["status"] !== "running") continue;
    const references =
      read(filename).includes(document.creationId) ||
      fs
        .readdirSync(path.dirname(filename), { withFileTypes: true })
        .some((child) => {
          if (!child.isDirectory()) return false;
          const report = path.join(
            path.dirname(filename),
            child.name,
            "report.json",
          );
          return (
            fs.existsSync(report) && read(report).includes(document.creationId)
          );
        });
    if (!own && !references) continue;
    assert.equal(
      childProcessIdentity.priorProcessAlive({
        pid: Number(processIdentity["pid"]),
        birth: text(processIdentity["birth"]),
      }),
      false,
      "A producer is active or its exit is unverified",
    );
  }
}
function inspectionSource(
  document: Document,
  proof: HoldProof,
  expectedModified?: boolean,
) {
  return programs.program(`import adsk.core, adsk.fusion, json
app = adsk.core.Application.get()
def inventory() -> list[dict[str, str | bool | None]]:
    return [dict(creationId=d.creationId,name=d.name,saved=d.isSaved,modified=d.isModified,fileId=d.dataFile.id if d.dataFile else None,active=d == app.activeDocument) for d in app.documents]
before = inventory()
matches = [d for d in app.documents if d.creationId == ${JSON.stringify(document.creationId)}]
assert len(matches) == 1, 'Owned creationId is unavailable'
doc = matches[0]
assert doc.name == ${JSON.stringify(document.name)}, 'Owned identity changed'
assert sum(d.name == doc.name for d in app.documents) == 1, 'Ambiguous owned name'
assert not doc.isSaved and doc.dataFile is None, 'Owned fixture became saved'
${expectedModified === undefined ? "assert doc.isModified, 'Held modified fixture unexpectedly became clean'" : `assert doc.isModified == ${expectedModified ? "True" : "False"}, 'Held fixture modified state changed since authenticated hold'`}
${
  proof.kind === "owned-observation"
    ? `design = doc.products.itemByProductType('DesignProductType')
assert isinstance(design, adsk.fusion.Design), 'Owned design is unavailable'
assert design.rootComponent.bRepBodies.count == 1, 'Unexpected owned body count'
entities = design.findEntityByToken(${JSON.stringify(proof.bodyToken)})
assert len(entities) == 1, 'Owned original body token is unavailable or ambiguous'
body = entities[0]
assert isinstance(body, adsk.fusion.BRepBody) and body.isValid, 'Original body is not a valid owned BRepBody'
assert body.parentComponent == design.rootComponent, 'Body escaped the owned root'
assert body == design.rootComponent.bRepBodies.item(0), 'Original body is not the sole owned body'
assert abs(body.volume - 1.68) < 0.000001, 'Owned pose body volume changed'`
    : ""
}
after = inventory()
assert before == after, 'Inventory changed during inspection'
${programs.emit(`dict(creationId=doc.creationId,saved=doc.isSaved,modified=doc.isModified,fileId=None,${proof.kind === "owned-observation" ? `body=dict(token=${JSON.stringify(proof.bodyToken)},count=design.rootComponent.bRepBodies.count,volume=body.volume),` : ""}inventoryFence=dict(version=1,before=before,after=after))`)}`);
}
function inspectionCheck(raw: Record<string, unknown>) {
  assert.ok(
    Array.isArray(raw["pythonChecks"]) && raw["pythonChecks"].length === 1,
    "Inspection lacks its production checker receipt",
  );
  const check = record(raw["pythonChecks"][0]);
  assert.equal(check["status"], "passed");
  assert.deepEqual(check["diagnostics"], []);
  assert.deepEqual(check["reasons"], []);
  const checker = record(check["provenance"]);
  assert.equal(checker["checkerVersion"], "1.40.2");
  assert.equal(
    checker["definitionsHash"],
    "83dc3697aa61a47ada93c323e2f719c7be3d72091938415f666089a96b159179",
  );
}
function validateFailedInspection(
  directory: string,
  backend: Pick<
    ScenarioBackend,
    "identity" | "mode" | "qualification" | "protocol"
  >,
  runtime: CleanupRuntimeBinding,
  value: unknown,
) {
  const failure = record(value),
    c = context(directory, backend),
    intent = json(path.join(directory, inspectionIntent));
  assert.equal(failure["version"], 1);
  assert.deepEqual(failure["owner"], c.owner);
  assert.deepEqual(failure["runtime"], runtime);
  assert.equal(failure["reportHash"], c.reportHash);
  assert.equal(
    failure["intentHash"],
    hash(read(path.join(directory, inspectionIntent))),
  );
  assert.equal(
    intent["version"],
    1,
    "Only the retained modified-only inspection failure is supported",
  );
  assert.deepEqual(intent["owner"], c.owner);
  assert.deepEqual(intent["runtime"], runtime);
  assert.equal(intent["reportHash"], c.reportHash);
  const held = original(
    directory,
    c.owner,
    c.requests.at(-1)!,
    failure["holdOriginal"],
  );
  const holdEvidence = holdProof(c, held.source);
  assert.equal(holdEvidence.kind, "admission-only");
  assert.equal(
    holdModified(c, holdEvidence),
    false,
    "Unexpected modified-to-clean drift is not a pristine hold",
  );
  const requestId = text(intent["requestId"]);
  assert.equal(failure["requestId"], requestId);
  assert.ok(requestId.startsWith(c.owner.clientId + ":"));
  assert.match(requestId.slice(c.owner.clientId.length + 1), /^[0-9]+$/u);
  assert.ok(
    Number(requestId.split(":").at(-1)) >
      Math.max(
        ...c.requests.map((row) =>
          Number(text(row["requestId"]).split(":").at(-1)),
        ),
      ),
  );
  const result = queueExecution(failure["raw"], c.owner, requestId);
  const proof = original(
    directory,
    c.owner,
    { requestId, result, intent: { kind: "script" } },
    failure["raw"],
  );
  assert.equal(proof.job["id"], failure["jobId"]);
  assert.equal(
    proof.job["state"],
    "failed",
    "An uncertain or successful inspection is not this failure disposition",
  );
  assert.equal(
    record(proof.value["execution"])["code"],
    "SDK_EXECUTION_FAILED",
  );
  assert.ok(
    text(proof.value["stdout"]).startsWith(
      "Held modified fixture unexpectedly became clean\n",
    ),
    "Inspection failed for another reason",
  );
  const source = inspectionSource(c.document, holdEvidence);
  assert.equal(
    proof.source,
    source,
    "Failed inspection is not the retained readonly program",
  );
  assert.equal(intent["sourceHash"], hash(source));
  inspectionCheck(proof.value);
  assert.ok(Number(proof.job["startedAt"]) >= Number(held.job["finishedAt"]));
  return {
    requestId,
    jobId: text(proof.job["id"]),
    finishedAt: Number(proof.job["finishedAt"]),
    raw: failure["raw"],
  };
}
export function validateCleanupResolution(
  directory: string,
  backend: Pick<
    ScenarioBackend,
    "identity" | "mode" | "qualification" | "protocol"
  >,
  runtime: CleanupRuntimeBinding,
): VerifiedCleanupResolution {
  const bytes = read(path.join(directory, canonical));
  return verifiedDecision(directory, backend, runtime, bytes);
}
/** Authoring-only guard. Historical closure readers must use the validator above. */
export function validateCleanupResolutionForClose(
  directory: string,
  backend: Pick<
    ScenarioBackend,
    "identity" | "mode" | "qualification" | "protocol"
  >,
  runtime: CleanupRuntimeBinding,
): VerifiedCleanupResolution {
  const verified = validateCleanupResolution(directory, backend, runtime);
  noProducer(directory, verified.document);
  assert.ok(
    Date.now() < verified.expiresAt,
    "Inspection is stale; do not replay",
  );
  return verified;
}
function verifiedDecision(
  directory: string,
  backend: Pick<
    ScenarioBackend,
    "identity" | "mode" | "qualification" | "protocol"
  >,
  runtime: CleanupRuntimeBinding,
  bytes: string,
): VerifiedCleanupResolution {
  const decision = record(JSON.parse(bytes) as unknown);
  const c = context(directory, backend);
  runtimeBinding(runtime, backend);
  assert.ok(decision["version"] === 1 || decision["version"] === 2);
  assert.equal(decision["reportHash"], c.reportHash);
  assert.equal(decision["creationHash"], c.creationHash);
  assert.equal(decision["indexHash"], c.indexHash);
  assert.deepEqual(decision["runtime"], runtime);
  assert.deepEqual(decision["owner"], c.owner);
  assert.deepEqual(decision["document"], c.document);
  assert.ok(Array.isArray(decision["originals"]));
  assert.equal(decision["originals"].length, c.requests.length);
  for (let i = 0; i < c.requests.length; i++)
    original(directory, c.owner, c.requests[i]!, decision["originals"][i]);
  const hold = original(
    directory,
    c.owner,
    c.requests.at(-1)!,
    decision["originals"].at(-1),
  );
  const holdEvidence = holdProof(c, hold.source);
  assert.deepEqual(decision["holdProof"], holdEvidence);
  const expectedModified = holdModified(c, holdEvidence);
  if (decision["version"] === 1)
    assert.equal(
      expectedModified,
      true,
      "Legacy modified-only decision has a pristine hold",
    );
  else assert.equal(decision["expectedModified"], expectedModified);
  const source = inspectionSource(
    c.document,
    holdEvidence,
    decision["version"] === 1 ? undefined : expectedModified,
  );
  const inspection = record(decision["inspection"]),
    row = record(inspection["row"]);
  const intentFile =
    decision["version"] === 1
      ? inspectionIntent
      : text(inspection["intentFile"]);
  assert.ok(
    intentFile === inspectionIntent || intentFile === reinspectionIntent,
  );
  let priorFinishedAt = 0;
  if (intentFile === reinspectionIntent) {
    assert.equal(decision["version"], 2);
    assert.equal(
      decision["failedInspectionHash"],
      hash(read(path.join(directory, failedInspection))),
    );
    const prior = validateFailedInspection(
      directory,
      backend,
      runtime,
      json(path.join(directory, failedInspection)),
    );
    assert.ok(
      Number(text(row["requestId"]).split(":").at(-1)) >
        Number(prior.requestId.split(":").at(-1)),
    );
    assert.notEqual(
      record(record(inspection["raw"])["job"])["id"],
      prior.jobId,
    );
    priorFinishedAt = prior.finishedAt;
  } else assert.equal(decision["failedInspectionHash"], undefined);
  const intent = json(path.join(directory, intentFile));
  assert.equal(intent["version"], decision["version"]);
  assert.deepEqual(intent["owner"], c.owner);
  assert.deepEqual(intent["runtime"], runtime);
  assert.equal(intent["reportHash"], c.reportHash);
  if (decision["version"] === 2)
    assert.equal(intent["expectedModified"], expectedModified);
  assert.equal(intent["requestId"], row["requestId"]);
  assert.ok(text(row["requestId"]).startsWith(c.owner.clientId + ":"));
  assert.ok(
    !c.requests.some((original) => original["requestId"] === row["requestId"]),
  );
  assert.equal(intent["sourceHash"], hash(source));
  const proof = original(directory, c.owner, row, inspection["raw"]);
  assert.equal(proof.source, source);
  assert.equal(proof.job["state"], "succeeded");
  inspectionCheck(proof.value);
  const value = marker(proof.value["stdout"]),
    fence = record(value["inventoryFence"]);
  assert.equal(value["creationId"], c.document.creationId);
  assert.equal(value["saved"], false);
  assert.equal(value["fileId"], null);
  const own = inventory(fence["before"], c.document);
  assert.equal(fence["version"], 1);
  assert.deepEqual(fence["after"], fence["before"]);
  assert.equal(value["modified"], own["modified"]);
  assert.equal(value["modified"], expectedModified);
  if (holdEvidence.kind === "owned-observation") {
    const body = record(value["body"]);
    assert.equal(body["token"], holdEvidence.bodyToken);
    assert.equal(body["count"], 1);
    assert.ok(
      typeof body["volume"] === "number" &&
        Math.abs(body["volume"] - 1.68) < 0.000001,
    );
  }
  const inspectedAt = Number(proof.job["finishedAt"]),
    expiresAt = Number(decision["expiresAt"]);
  assert.equal(expiresAt, inspectedAt + 300_000);
  assert.ok(inspectedAt <= Date.now(), "Inspection clock is in the future");
  assert.ok(Number(proof.job["startedAt"]) >= priorFinishedAt);
  assert.ok(
    Number(proof.job["startedAt"]) >=
      Math.max(
        ...decision["originals"].map((raw) =>
          Number(record(record(raw)["job"])["finishedAt"]),
        ),
      ),
  );
  return {
    digest: hash(bytes),
    owner: c.owner,
    document: c.document,
    runtime,
    inspectedModified: own["modified"] as boolean,
    inspectionRequestId: text(row["requestId"]),
    inspectionJobId: text(proof.job["id"]),
    inspectedAt,
    expiresAt,
  };
}
export async function resolveCleanupHold(
  backend: ScenarioBackend,
  directory: string,
  ports: CleanupHoldPorts,
): Promise<VerifiedCleanupResolution> {
  assert.ok(backend.lookup, "Original lookup is mandatory");
  const c = context(directory, backend),
    runtime = await ports.readRuntimeBinding();
  runtimeBinding(runtime, backend);
  noProducer(directory, c.document);
  if (fs.existsSync(path.join(directory, canonical))) {
    return validateCleanupResolutionForClose(directory, backend, runtime);
  }
  const originals: unknown[] = [];
  for (const row of c.requests) {
    const id = text(row["requestId"]),
      current = await backend.lookup(c.owner, id);
    assert.deepEqual(
      current,
      row["result"],
      "Authenticated lookup differs from original report",
    );
    const raw = await ports.readOriginalResult(c.owner, id);
    original(directory, c.owner, row, raw);
    originals.push(raw);
  }
  const holdEvidence = holdProof(
    c,
    original(directory, c.owner, c.requests.at(-1)!, originals.at(-1)).source,
  );
  const expectedModified = holdModified(c, holdEvidence);
  const source = inspectionSource(c.document, holdEvidence, expectedModified);
  const prior = fs.existsSync(path.join(directory, inspectionIntent))
    ? validateFailedInspection(
        directory,
        backend,
        runtime,
        json(path.join(directory, failedInspection)),
      )
    : undefined;
  if (prior) {
    assert.deepEqual(
      await backend.lookup(c.owner, prior.requestId),
      queueExecution(prior.raw, c.owner, prior.requestId),
    );
    assert.deepEqual(
      await ports.readOriginalResult(c.owner, prior.requestId),
      prior.raw,
    );
  }
  assert.deepEqual(await ports.readRuntimeBinding(), runtime);
  noProducer(directory, c.document);
  const requestId =
    c.owner.clientId +
    ":" +
    (Math.max(
      ...(prior ? [Number(prior.requestId.split(":").at(-1))] : []),
      ...c.requests.map((row) =>
        Number(text(row["requestId"]).split(":").at(-1)),
      ),
    ) +
      1);
  assert.equal(
    await backend.lookup(c.owner, requestId),
    null,
    "Inspection ID already exists",
  );
  const intentFile = prior ? reinspectionIntent : inspectionIntent;
  immutable(path.join(directory, intentFile), {
    version: 2,
    nonce: randomUUID(),
    owner: c.owner,
    requestId,
    runtime,
    reportHash: c.reportHash,
    expectedModified,
    sourceHash: hash(source),
  });
  const result = await backend.execute({
    owner: c.owner,
    requestId,
    source,
    target: c.document,
    directory,
  });
  assert.deepEqual(await backend.lookup(c.owner, requestId), result);
  const raw = await ports.readOriginalResult(c.owner, requestId),
    row = { requestId, result, intent: { kind: "script" } };
  original(directory, c.owner, row, raw);
  assert.deepEqual(await ports.readRuntimeBinding(), runtime);
  assert.equal(
    context(directory, backend).reportHash,
    c.reportHash,
    "Original report changed during inspection",
  );
  noProducer(directory, c.document);
  const inspectedAt = Number(record(record(raw)["job"])["finishedAt"]);
  const decision = {
    version: 2,
    owner: c.owner,
    document: c.document,
    reportHash: c.reportHash,
    creationHash: c.creationHash,
    indexHash: c.indexHash,
    runtime,
    originals,
    holdProof: holdEvidence,
    expectedModified,
    ...(prior
      ? {
          failedInspectionHash: hash(
            read(path.join(directory, failedInspection)),
          ),
        }
      : {}),
    inspection: { row, raw, intentFile },
    expiresAt: inspectedAt + 300_000,
  };
  assert.ok(Date.now() < decision.expiresAt, "Inspection is stale");
  // Validate all inspection assertions before granting any immutable authorization.
  verifiedDecision(
    directory,
    backend,
    runtime,
    JSON.stringify(decision) + "\n",
  );
  immutable(path.join(directory, canonical), decision);
  return validateCleanupResolution(directory, backend, runtime);
}

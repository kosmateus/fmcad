import { pythonLiteral } from "../../packages/node-adapters/src/python/artifact";
import {
  emit,
  program,
  snapshot as documentSnapshot,
  create as createDocument,
} from "./programs";
import { nativeCadRuntime } from "./native-cad-runtime";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  discoverOwnedUnsavedFixtureProofs,
  exactScenarioRequestId,
  type OwnedUnsavedFixtureProof,
} from "./fixture-provenance";
import { record, text, type Owner, type ScenarioBackend } from "./contracts";
import { resultValue, type RequestEvidence } from "./saved-files";

export interface OriginalViewPolicy {
  readonly baseline: readonly Record<string, unknown>[];
  readonly peers: readonly OwnedUnsavedFixtureProof[];
}
export interface CaptureViewPlan extends OriginalViewPolicy {
  readonly roots: Readonly<Record<string, Record<string, unknown>>>;
  readonly blocked: readonly string[];
  readonly ancestry?: Readonly<
    Record<string, readonly Record<string, unknown>[]>
  >;
  readonly blockedReasons?: Readonly<Record<string, string>>;
}

export type OriginalViewReader = (
  owner: Owner,
  jobId: string,
) => Promise<unknown>;

function regularBytes(filename: string, limit = 4 * 1024 * 1024): Buffer {
  const fd = fs.openSync(
    filename,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const stat = fs.fstatSync(fd);
    assert.ok(
      stat.isFile() && stat.size <= limit,
      "Invalid original view source record",
    );
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
const readRecord = (filename: string): Record<string, unknown> =>
  record(JSON.parse(regularBytes(filename).toString("utf8")) as unknown);
const digest = (bytes: Buffer | string): string =>
  createHash("sha256").update(bytes).digest("hex");

/** Read an original public receipt, never a command submission or SDK probe. */
async function publicOriginalView(
  owner: Owner,
  jobId: string,
  backend: ScenarioBackend,
): Promise<unknown> {
  assert.equal(
    backend.mode,
    "fusion",
    "Peer camera ancestry requires original broker evidence",
  );
  const load = createRequire(path.join(process.cwd(), "package.json"));
  const { resolveQualifiedLiveRuntime } = load(
    "./tests/helpers/qualified-live-runtime",
  ) as { resolveQualifiedLiveRuntime(): { dist: string } };
  const { readQueueResult } = load("./tests/helpers/live-broker") as {
    readQueueResult(input: {
      cliPath: string;
      backend: string;
      clientId: string;
      jobId: string;
      cwd: string;
    }): Promise<unknown>;
  };
  return readQueueResult({
    cliPath: path.join(resolveQualifiedLiveRuntime().dist, "bin/fmcad.js"),
    backend: backend.protocol,
    clientId: owner.clientId,
    jobId,
    cwd: process.cwd(),
  });
}

interface ViewClaim {
  readonly directory: string;
  readonly owner: Owner;
  readonly report: Record<string, unknown>;
  readonly creation: Record<string, unknown>;
  readonly index: Record<string, unknown>;
}

/** Claims can veto an unverified active peer, but never grant an exemption. */
function viewClaims(
  root: string,
  backend: ScenarioBackend,
): Map<string, ViewClaim[]> {
  const claims = new Map<string, ViewClaim[]>();
  for (const runId of fs.readdirSync(root)) {
    if (!/^[a-f0-9-]{36}$/u.test(runId)) continue;
    const run = path.join(root, runId);
    if (fs.lstatSync(run).isSymbolicLink()) continue;
    let index: Record<string, unknown>;
    try {
      index = readRecord(path.join(run, "index.json"));
    } catch {
      continue;
    }
    if (index["mode"] !== backend.mode || !Array.isArray(index["scenarioIds"]))
      continue;
    for (const id of index["scenarioIds"]) {
      if (typeof id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,100}$/u.test(id))
        continue;
      const directory = path.join(run, id);
      let report: Record<string, unknown>, creation: Record<string, unknown>;
      try {
        report = readRecord(path.join(directory, "report.json"));
      } catch {
        continue;
      }
      try {
        creation = readRecord(path.join(directory, "creation.json"));
      } catch {
        creation = {};
      }
      const owner = {
        runId,
        scenarioId: id,
        clientId: "scenario:" + runId + ":" + id,
      };
      const claim = { directory, owner, report, creation, index };
      const ids = new Set([
        creation["creationId"],
        record(report["document"] ?? {})["creationId"],
      ]);
      // A historical failed identity check is a veto, not a saved-transfer
      // proof. Never let its reported successor masquerade as a user document.
      if (Array.isArray(report["requests"])) {
        for (const entry of report["requests"].map(record)) {
          const result = record(entry["result"] ?? {});
          if (typeof result["stdout"] !== "string") continue;
          for (const match of result["stdout"].matchAll(
            /doc-id mismatch for document [^\r\n]*: expected ([a-f0-9-]{36}), got ([a-f0-9-]{36})/gu,
          )) {
            if (ids.has(match[1])) ids.add(match[2]);
          }
        }
      }
      for (const value of ids) {
        if (typeof value !== "string" || !value) continue;
        claims.set(value, [...(claims.get(value) ?? []), claim]);
      }
    }
  }
  return claims;
}

function viewIdentity(
  snapshot: Record<string, unknown>,
): Record<string, unknown> {
  const active = record(snapshot["active"]),
    camera = record(snapshot["camera"]),
    document = record(camera["document"]);
  assert.equal(document["creationId"], active["creationId"]);
  assert.equal(document["name"], active["name"]);
  assert.equal(document["dataFileId"], active["fileId"]);
  return {
    creationId: text(active["creationId"]),
    name: text(active["name"]),
    fileId: active["fileId"],
  };
}

async function boundViewRecord(
  directory: string,
  owner: Owner,
  capture: RequestEvidence,
  readOriginal: OriginalViewReader,
): Promise<{
  snapshot: Record<string, unknown>;
  binding: Record<string, unknown>;
}> {
  const requestId = capture.requestId;
  assert.ok(
    exactScenarioRequestId(requestId, owner.clientId) ||
      (owner.scenarioId === "coordinator" &&
        requestId === owner.clientId + ":before" &&
        capture.phase === "before"),
  );
  const snapshot = resultValue(capture);
  assert.ok(snapshot, "Unsettled original camera capture");
  const result = record(capture.result),
    receipt = record(result["brokerReceipt"]),
    jobId = text(receipt["jobId"]);
  assert.equal(receipt["clientId"], owner.clientId);
  assert.equal(receipt["requestId"], requestId);
  assert.equal(receipt["state"], "succeeded");
  const original = record(await readOriginal(owner, jobId)),
    job = record(original["job"]),
    execution = record(original["execution"]);
  assert.equal(job["id"], jobId);
  assert.equal(job["clientId"], owner.clientId);
  assert.equal(job["requestId"], requestId);
  assert.equal(job["state"], "succeeded");
  assert.equal(execution["sdkSettled"], true);
  assert.equal(execution["state"], "succeeded");
  assert.equal(original["stdout"], result["stdout"]);
  assert.deepEqual(job["operationResult"], receipt["operationResult"]);
  const outcome = record(job["operationResult"]);
  assert.equal(outcome["requestId"], requestId);
  assert.equal(outcome["jobId"], jobId);
  assert.equal(outcome["acceptance"], "accepted");
  assert.equal(outcome["executionOutcome"], "succeeded");
  assert.equal(outcome["version"], 1);
  const sourceFile = path.join(
      directory,
      "request-" + requestId.slice(owner.clientId.length + 1) + ".py",
    ),
    bytes = regularBytes(sourceFile);
  const provenance = record(original["provenance"]);
  assert.equal(provenance["status"], "available");
  assert.ok(Array.isArray(provenance["inputs"]));
  const sources = provenance["inputs"]
    .map(record)
    .filter((input) => input["kind"] === "source");
  assert.equal(sources.length, 1);
  assert.equal(sources[0]!["sha256"], digest(bytes));
  assert.equal(sources[0]!["bytes"], bytes.length);
  assert.equal(sources[0]!["originalPath"], sourceFile);
  return {
    snapshot,
    binding: {
      owner,
      requestId,
      jobId,
      sourceFile,
      sourceSha256: digest(bytes),
      source: bytes.toString("utf8"),
      startedAt: job["startedAt"],
      finishedAt: job["finishedAt"],
    },
  };
}

/** Bind a stored capture to its original public result and immutable source. */
export async function verifiedViewCapture(
  directory: string,
  owner: Owner,
  capture: RequestEvidence,
  backend: ScenarioBackend,
  readOriginal: OriginalViewReader = (who, jobId) =>
    publicOriginalView(who, jobId, backend),
): Promise<{
  snapshot: Record<string, unknown>;
  binding: Record<string, unknown>;
}> {
  assert.equal(capture.phase, "original-user-view-capture");
  const { snapshot, binding } = await boundViewRecord(
    directory,
    owner,
    capture,
    readOriginal,
  );
  const strict = snapshot["restorationProfile"] === "motion-absolute-1e-7";
  assert.ok(strict || snapshot["restorationProfile"] === "style-relative-1e-5");
  let plan: CaptureViewPlan | undefined;
  try {
    plan = readRecord(
      path.join(directory, "view-capture-plan.json"),
    ) as unknown as CaptureViewPlan;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  assert.equal(
    binding["source"],
    captureOriginalView(strict, plan),
    "Original camera capture source changed",
  );
  viewIdentity(snapshot);
  return {
    snapshot,
    binding,
  };
}

/** Resolve only camera ancestry. A lifecycle hold grants no inventory/cleanup rights. */
export async function prepareCaptureView(
  root: string,
  backend: ScenarioBackend,
  baseline: readonly Record<string, unknown>[],
  readOriginal: OriginalViewReader = (owner, jobId) =>
    publicOriginalView(owner, jobId, backend),
): Promise<CaptureViewPlan> {
  const peers = discoverOwnedUnsavedFixtureProofs(root, backend),
    claims = viewClaims(root, backend);
  const originalResults = new Map<string, Promise<unknown>>();
  const historyProofs = new Map<
    string,
    ReadonlyMap<string, OwnedUnsavedFixtureProof>
  >();
  const lookup: OriginalViewReader = (owner, jobId) => {
    const key = owner.clientId + "\0" + jobId;
    let result = originalResults.get(key);
    if (!result) {
      result = readOriginal(owner, jobId);
      originalResults.set(key, result);
    }
    return result;
  };
  const roots: Record<string, Record<string, unknown>> = {},
    blocked = new Set<string>(),
    ancestry: Record<string, Record<string, unknown>[]> = {},
    blockedReasons: Record<string, string> = {};
  const resolve = async (
    id: string,
    seen: ReadonlySet<string>,
    chain: Record<string, unknown>[],
  ): Promise<Record<string, unknown>> => {
    assert.ok(!seen.has(id), "Cyclic original user view ancestry");
    const proof =
      peers.get(id) ??
      [...peers.values()].find(
        (value) =>
          value.state === "saved" && value.savedDocument.creationId === id,
      );
    const matches = claims.get(proof?.document.creationId ?? id) ?? [];
    assert.equal(
      matches.length,
      1,
      "Missing or ambiguous original camera owner",
    );
    const claim = matches[0]!,
      report = claim.report;
    assert.deepEqual(report["owner"], claim.owner);
    assert.equal(
      path.resolve(text(report["directory"])),
      path.resolve(claim.directory),
    );
    assert.equal(report["backendIdentity"], claim.index["backendIdentity"]);
    assert.equal(claim.index["runId"], claim.owner.runId);
    assert.equal(report["mode"], backend.mode);
    assert.equal(report["protocol"], claim.index["protocol"]);
    assert.equal(report["qualification"], claim.index["qualification"]);
    assert.ok(Array.isArray(report["requests"]));
    const entries = report["requests"].map(record);
    const creates = entries.filter((entry) => entry["phase"] === "create"),
      captures = entries.filter(
        (entry) => entry["phase"] === "original-user-view-capture",
      );
    assert.equal(creates.length, 1);
    assert.ok(captures.length <= 1, "Ambiguous original camera capture");
    const create = creates[0]!;
    assert.ok(
      exactScenarioRequestId(text(create["requestId"]), claim.owner.clientId),
    );
    assert.equal(record(create["intent"])["kind"], "script");
    assert.deepEqual(
      resultValue(create as unknown as RequestEvidence),
      claim.creation,
    );
    const document = {
      creationId: text(claim.creation["creationId"]),
      name: text(claim.creation["name"]),
    };
    if (proof) assert.deepEqual(proof.document, document);
    const historyIdentity = text(claim.index["backendIdentity"]),
      protocol = claim.index["protocol"];
    assert.ok(protocol === "addin" || protocol === "mcp");
    assert.equal(claim.index["qualification"], "broker");
    let historical = historyProofs.get(historyIdentity);
    if (!historical) {
      historical = discoverOwnedUnsavedFixtureProofs(root, {
        identity: historyIdentity,
        mode: backend.mode,
        qualification: "broker",
        protocol,
      });
      historyProofs.set(historyIdentity, historical);
    }
    const identityProof = historical.get(document.creationId);
    assert.ok(identityProof, "Missing original verified peer identity proof");
    assert.deepEqual(identityProof.document, document);
    if (id !== document.creationId)
      assert.ok(
        identityProof.state === "saved" &&
          identityProof.savedDocument.creationId === id,
        "Peer alias lacks an exact saved identity transfer",
      );
    const observed = baseline.find((row) => row["creationId"] === id);
    if (observed && identityProof.state === "saved") {
      assert.equal(
        observed["creationId"],
        identityProof.savedDocument.creationId,
      );
      assert.equal(observed["name"], identityProof.savedDocument.name);
      assert.equal(observed["fileId"], identityProof.savedDocument.file.fileId);
      assert.equal(observed["saved"], true);
    } else if (observed) {
      assert.equal(observed["name"], document.name);
      assert.equal(observed["saved"], false);
      assert.equal(observed["fileId"], null);
    }
    assert.equal(claim.creation["requestId"], create["requestId"]);
    assert.equal(claim.creation["clientId"], claim.owner.clientId);
    assert.equal(claim.creation["activeCreationId"], document.creationId);
    const creation = await boundViewRecord(
      claim.directory,
      claim.owner,
      create as unknown as RequestEvidence,
      lookup,
    );
    assert.deepEqual(creation.snapshot, claim.creation);
    assert.equal(
      creation.binding["source"],
      createDocument(
        document.name,
        backend.fusionPath(path.join(claim.directory, "creation.json")),
        {
          requestId: text(create["requestId"]),
          clientId: claim.owner.clientId,
        },
      ),
      "Original peer creation source changed",
    );
    let origin: {
        snapshot: Record<string, unknown>;
        binding: Record<string, unknown>;
      },
      user: Record<string, unknown>;
    if (captures.length) {
      const capture = captures[0]!;
      assert.equal(record(capture["intent"])["kind"], "script");
      assert.ok(
        Number(
          text(capture["requestId"]).slice(claim.owner.clientId.length + 1),
        ) <
          Number(
            text(create["requestId"]).slice(claim.owner.clientId.length + 1),
          ),
      );
      origin = await verifiedViewCapture(
        claim.directory,
        claim.owner,
        capture as unknown as RequestEvidence,
        backend,
        lookup,
      );
      user = viewIdentity(origin.snapshot);
    } else {
      const coordinator = path.join(
          path.dirname(claim.directory),
          "_coordinator",
        ),
        owner = {
          ...claim.owner,
          scenarioId: "coordinator",
          clientId: "scenario:" + claim.owner.runId + ":coordinator",
        };
      const intent = readRecord(path.join(coordinator, "before.intent.json"));
      assert.deepEqual(intent, {
        requestId: owner.clientId + ":before",
        phase: "before",
      });
      const result = readRecord(path.join(coordinator, "before.result.json"));
      origin = await boundViewRecord(
        coordinator,
        owner,
        {
          requestId: owner.clientId + ":before",
          phase: "before",
          result,
        } as unknown as RequestEvidence,
        lookup,
      );
      assert.equal(
        origin.binding["source"],
        documentSnapshot(),
        "Coordinator identity capture source changed",
      );
      assert.ok(Array.isArray(origin.snapshot["documents"]));
      const matches = origin.snapshot["documents"]
        .map(record)
        .filter((row) => row["creationId"] === origin.snapshot["active"]);
      assert.equal(
        matches.length,
        1,
        "Coordinator lacks an exact original active identity",
      );
      const row = matches[0]!;
      user = {
        creationId: text(row["creationId"]),
        name: text(row["name"]),
        fileId: row["fileId"],
      };
    }
    const { snapshot, binding } = origin;
    assert.notEqual(
      binding["jobId"],
      record(record(create["result"])["brokerReceipt"])["jobId"],
    );
    assert.ok(
      typeof binding["finishedAt"] === "number" &&
        typeof creation.binding["startedAt"] === "number" &&
        binding["finishedAt"] < creation.binding["startedAt"],
      "Original identity capture must finish before exact creation",
    );
    assert.ok(Array.isArray(snapshot["documents"]));
    assert.equal(
      snapshot["documents"]
        .map(record)
        .some((row) => row["creationId"] === document.creationId),
      false,
      "Creation adopted a pre-existing document",
    );
    chain.push({
      document,
      owner: binding["owner"],
      requestId: binding["requestId"],
      jobId: binding["jobId"],
      sourceFile: binding["sourceFile"],
      sourceSha256: binding["sourceSha256"],
      finishedAt: binding["finishedAt"],
      creationJobId: creation.binding["jobId"],
      creationStartedAt: creation.binding["startedAt"],
    });
    const userId = text(user["creationId"]);
    if (!claims.has(userId)) return user;
    return resolve(userId, new Set([...seen, id]), chain);
  };
  const candidates = new Set([
    ...peers.keys(),
    ...baseline.map((row) => text(row["creationId"])),
  ]);
  for (const id of candidates) {
    if (!claims.has(id) && !peers.has(id)) continue;
    const proof = peers.get(id);
    const ids =
      proof?.state === "saved" ? [id, proof.savedDocument.creationId] : [id];
    try {
      const chain: Record<string, unknown>[] = [],
        user = await resolve(id, new Set(), chain);
      for (const key of ids) {
        roots[key] = user;
        ancestry[key] = chain;
      }
    } catch (error) {
      for (const key of ids) {
        blocked.add(key);
        blockedReasons[key] =
          error instanceof Error ? error.message : String(error);
      }
    }
  }
  for (const id of claims.keys())
    if (!peers.has(id) && !roots[id]) blocked.add(id);
  return {
    baseline,
    peers: [...peers.values()],
    roots,
    blocked: [...blocked],
    ancestry,
    blockedReasons,
  };
}

const inventory = `import adsk.core, adsk.fusion, json, math
from collections.abc import Mapping, Sequence
from typing import cast
app = adsk.core.Application.get()
def identity(d: adsk.core.Document) -> JsonRecord:
    file = d.dataFile
    return dict(name=d.name, creationId=d.creationId, fileId=file.id if file else None)
def doc_rows() -> list[JsonRecord]:
    return [dict(**identity(d), saved=d.isSaved, modified=d.isModified) for d in sorted(app.documents, key=lambda d: (d.creationId, d.name))]
def checked_doc(key: JsonValue) -> adsk.core.Document:
    matches = [d for d in app.documents if identity(d) == key]
    assert len(matches) == 1, 'Original document name/creationId/fileId guard failed'
    return matches[0]
def native_camera() -> JsonRecord:
    c = app.activeViewport.camera
    types = adsk.core.CameraTypes
    orthographic = cast(adsk.core.CameraTypes, types.OrthographicCameraType)
    perspective = cast(adsk.core.CameraTypes, types.PerspectiveCameraType)
    perspective_ortho = cast(adsk.core.CameraTypes, types.PerspectiveWithOrthoFacesCameraType)
    if c.cameraType == orthographic:
        name = 'OrthographicCameraType'
    elif c.cameraType == perspective:
        name = 'PerspectiveCameraType'
    else:
        assert c.cameraType == perspective_ortho, 'Unsupported original camera projection'
        name = 'PerspectiveWithOrthoFacesCameraType'
    result: JsonRecord = dict(eye=list(c.eye.asArray()), target=list(c.target.asArray()), up=list(c.upVector.asArray()), cameraType=name)
    if c.cameraType == orthographic:
        ok, width, height = c.getExtents()
        assert ok, 'Cannot read original camera extents'
        result['extents'] = [width, height]
    else:
        result['perspectiveAngle'] = c.perspectiveAngle
    return result
def document_context(d: adsk.core.Document) -> CadContext:
    file = d.dataFile
    return CadContext(d.name, doc_id=d.creationId, doc_file_id=file.id if file else None)
def object_value(value: JsonValue) -> Mapping[str, JsonValue]:
    assert isinstance(value, Mapping), 'Expected original view object'
    return value
def sequence_value(value: JsonValue) -> Sequence[JsonValue]:
    assert isinstance(value, Sequence) and not isinstance(value, str), 'Expected original view array'
    return value
def number_value(value: JsonValue) -> float:
    assert isinstance(value, (int, float)) and not isinstance(value, bool), 'Expected original view number'
    assert math.isfinite(value), 'Nonfinite original view number'
    return float(value)
`;

export function captureOriginalView(
  strictCamera = false,
  plan?: CaptureViewPlan,
): string {
  if (plan) return captureUserContext(strictCamera, plan);
  return (
    nativeCadRuntime(["camera.save", "camera.restore"]) +
    "\n" +
    program(`${inventory}
assert app.userInterface.activeCommand in ('', 'SelectCommand'), 'Close interactive command first'
assert app.activeDocument is not None, 'An active Design document is required for restorable camera capture'
original = app.activeDocument
ctx = document_context(original)
assert ctx.doc == original
before = doc_rows()
assert app.activeViewport.parentDocument == original, 'Original viewport document mismatch'
state = object_value(ctx.call('camera.save', {}))['state']
assert doc_rows() == before and app.activeDocument == original
${emit("dict(documents=before, active=identity(original), workspace=app.userInterface.activeWorkspace.id, camera=state, nativeCamera=native_camera(), restorationProfile=" + pythonLiteral(strictCamera ? "motion-absolute-1e-7" : "style-relative-1e-5") + ")")}`)
  );
}

const peerGuard = `
def view_text(value: JsonValue) -> str:
    assert isinstance(value, str) and value, 'Missing view identity'
    return value
def view_rows(value: JsonValue) -> dict[str, JsonRecord]:
    rows: dict[str, JsonRecord] = {}
    for item in sequence_value(value):
        row = object_value(item)
        key = view_text(row['creationId'])
        assert key not in rows, 'Duplicate view document identity'
        rows[key] = {field: row[field] for field in ('creationId', 'name', 'fileId', 'saved', 'modified')}
    return rows
def checked_view_inventory(policy: Mapping[str, JsonValue]) -> list[JsonRecord]:
    current = doc_rows()
    rows = view_rows(current)
    baseline = view_rows(policy['baseline'])
    admitted: set[str] = set()
    for value in sequence_value(policy['peers']):
        proof = object_value(value)
        expected = object_value(proof['document'])
        key = view_text(expected['creationId'])
        assert key not in admitted, 'Ambiguous view peer identity'
        state = proof['state']
        if state == 'unsettled':
            continue
        if state == 'saved':
            successor = object_value(proof['savedDocument'])
            successor_id = view_text(successor['creationId'])
            assert key == successor_id or key not in rows, 'Original and saved view peer both visible'
            if proof['savedState'] == 'unsettled':
                continue
            if proof['savedState'] == 'closed':
                assert successor_id not in rows, 'Closed saved view peer remains visible'
            else:
                assert proof['savedState'] == 'open'
                row = rows[successor_id]
                assert row['name'] == successor['name'] and row['saved'] is True
                assert row['fileId'] == object_value(successor['file'])['fileId'], 'Saved view peer file identity changed'
            admitted.update((key, successor_id))
        elif state == 'closed':
            assert key not in rows, 'Closed view peer remains visible'
            admitted.add(key)
        else:
            assert state == 'open', 'Unverified view peer state'
            row = rows[key]
            assert row['name'] == expected['name'] and row['saved'] is False and row['fileId'] is None, 'View peer identity changed'
            admitted.add(key)
    assert {key: row for key, row in rows.items() if key not in admitted} == {key: row for key, row in baseline.items() if key not in admitted}, 'Unproven user document transition during view operation'
    return current
def checked_user_identity(key: JsonValue, policy: Mapping[str, JsonValue]) -> None:
    user_id = object_value(key)['creationId']
    for value in sequence_value(policy['peers']):
        proof = object_value(value)
        assert user_id != object_value(proof['document'])['creationId'], 'User camera target cannot be a peer exemption'
        if proof['state'] == 'saved':
            assert user_id != object_value(proof['savedDocument'])['creationId'], 'User camera target cannot be a saved peer exemption'
`;

const cameraComparison = `
def view_same(actual: JsonValue, expected: JsonValue, strict: bool = False) -> None:
    if isinstance(expected, (int, float)) and not isinstance(expected, bool):
        a, b = number_value(actual), number_value(expected)
        tolerance = 1e-7 if strict else max(1e-7, abs(b)*0.00001)
        assert abs(a-b) <= tolerance, 'A newer or changed user camera must not be overwritten'
    elif isinstance(expected, Mapping):
        obj = object_value(actual)
        assert set(obj) == set(expected), 'User camera fields changed'
        for key, value in expected.items(): view_same(obj[key], value, strict)
    elif isinstance(expected, Sequence) and not isinstance(expected, str):
        values = sequence_value(actual)
        assert len(values) == len(expected), 'User camera dimensions changed'
        for a, b in zip(values, expected): view_same(a, b, strict)
    else:
        assert type(actual) is type(expected) and actual == expected, 'User camera identity changed'
`;

function captureUserContext(
  strictCamera: boolean,
  plan: CaptureViewPlan,
): string {
  return (
    nativeCadRuntime(["camera.save", "camera.restore"]) +
    "\n" +
    program(`${inventory}
${peerGuard}
${cameraComparison}
view_plan: JsonRecord = ${pythonLiteral(plan)}
assert app.userInterface.activeCommand in ('', 'SelectCommand'), 'Close interactive command first'
assert app.activeDocument is not None, 'An active Design document is required for restorable camera capture'
observed = app.activeDocument
observed_key = identity(observed)
observed_id = observed.creationId
assert observed_id not in sequence_value(view_plan['blocked']), 'Active peer lacks source-bound user view ancestry'
before = checked_view_inventory(view_plan)
observed_native = native_camera()
observed_workspace = app.userInterface.activeWorkspace.id
roots = object_value(view_plan['roots'])
user_key = roots.get(observed_id, observed_key)
checked_user_identity(user_key, view_plan)
user_doc = checked_doc(user_key)
assert app.activeViewport.parentDocument == observed
state: JsonValue = None
user_native: JsonValue = None
workspace_id = observed_workspace
try:
    if user_doc != observed:
        print('FMCAD_VIEW_EFFECT ' + json.dumps(dict(stage='activate-user', document=identity(user_doc))))
        assert user_doc.activate(), 'Cannot activate source-bound user document'
    assert app.activeViewport.parentDocument == user_doc
    ctx = document_context(user_doc)
    state = object_value(ctx.call('camera.save', {}))['state']
    user_native = native_camera()
    workspace_id = app.userInterface.activeWorkspace.id
    assert doc_rows() == before, 'Documents changed during fresh user camera capture'
finally:
    if app.activeDocument != observed:
        print('FMCAD_VIEW_EFFECT ' + json.dumps(dict(stage='restore-observed-focus', document=observed_key)))
        assert checked_doc(observed_key).activate(), 'Cannot restore original observed focus'
    original_workspace = app.userInterface.workspaces.itemById(observed_workspace)
    assert original_workspace is not None
    if app.userInterface.activeWorkspace.id != observed_workspace:
        assert original_workspace.activate(), 'Cannot restore original observed workspace'
    assert identity(app.activeDocument) == observed_key and doc_rows() == before
    view_same(native_camera(), observed_native, ${strictCamera ? "True" : "False"})
${emit("dict(documents=before, active=identity(user_doc), observedActive=observed_key, workspace=workspace_id, camera=state, nativeCamera=user_native, restorationProfile=" + pythonLiteral(strictCamera ? "motion-absolute-1e-7" : "style-relative-1e-5") + ")")}`)
  );
}

export function restoreOriginalView(
  snapshot: Record<string, unknown>,
  policy?: OriginalViewPolicy,
): string {
  let body = `${inventory}
snapshot: JsonRecord = ${pythonLiteral(snapshot)}
${policy ? peerGuard + cameraComparison + "\nview_policy: JsonRecord = " + pythonLiteral(policy) + "\nview_before = checked_view_inventory(view_policy)" : ""}
assert app.userInterface.activeCommand in ('', 'SelectCommand'), 'Interactive command open during restore'
${policy ? "" : "assert doc_rows() == snapshot['documents'], 'Other documents changed before original view restoration'"}
${policy ? "checked_user_identity(snapshot['active'], view_policy)" : ""}
original = checked_doc(snapshot['active'])
assert original.activate()
assert doc_rows() == ${policy ? "view_before" : "snapshot['documents']"}
workspace_id = snapshot['workspace']
assert isinstance(workspace_id, str)
workspace = app.userInterface.workspaces.itemById(workspace_id)
assert workspace is not None
if app.userInterface.activeWorkspace.id != workspace.id:
    assert workspace.activate()
assert app.activeDocument == original and doc_rows() == ${policy ? "view_before" : "snapshot['documents']"}
assert app.activeViewport.parentDocument == original
ctx = document_context(original)
${policy ? "view_same(object_value(ctx.call('camera.save', {}))['state'], snapshot['camera'], snapshot.get('restorationProfile') == 'motion-absolute-1e-7')\nview_same(native_camera(), snapshot['nativeCamera'], snapshot.get('restorationProfile') == 'motion-absolute-1e-7')" : ""}
ctx.call('camera.restore', dict(state=snapshot['camera']))
assert doc_rows() == ${policy ? "view_before" : "snapshot['documents']"}
actual = object_value(object_value(ctx.call('camera.save', {}))['state'])
expected = object_value(snapshot['camera'])
def near(a_value: JsonValue, b_value: JsonValue, absolute: float = 1e-10) -> None:
    a, b = number_value(a_value), number_value(b_value)
    assert abs(a-b) <= max(absolute, abs(b)*0.00001), 'Original camera readback differs'
for key in ('eye', 'target', 'up', 'extents'):
    if expected.get(key):
        actual_values = sequence_value(actual[key])
        expected_values = sequence_value(expected[key])
        assert len(actual_values) == len(expected_values)
        for a, b in zip(actual_values, expected_values):
            near(a, b, 1e-7)
assert actual['cameraType'] == expected['cameraType']
assert actual['document'] == expected['document']
assert actual['units'] == expected['units']
if 'perspectiveAngle' in expected:
    near(actual['perspectiveAngle'], expected['perspectiveAngle'])
native = native_camera()
if snapshot.get('restorationProfile') == 'motion-absolute-1e-7':
    def exact_numbers(a: JsonValue, b: JsonValue) -> None:
        if isinstance(b, (int, float)) and not isinstance(b, bool):
            assert abs(number_value(a)-number_value(b)) <= 1e-7, 'Original motion camera readback differs'
        elif isinstance(b, Mapping):
            actual_object = object_value(a)
            assert set(actual_object) == set(b)
            for key in b: exact_numbers(actual_object[key], b[key])
        elif isinstance(b, Sequence) and not isinstance(b, str):
            actual_values = sequence_value(a)
            assert len(actual_values) == len(b)
            for av, bv in zip(actual_values, b): exact_numbers(av, bv)
        else:
            assert a == b
    exact_numbers(native, snapshot['nativeCamera'])
assert identity(app.activeDocument) == snapshot['active']
assert app.userInterface.activeWorkspace.id == snapshot['workspace']
${emit("dict(restored=True, documents=doc_rows(), active=identity(app.activeDocument), workspace=app.userInterface.activeWorkspace.id, camera=actual, nativeCamera=native)")}`;
  if (policy) {
    const start = body.indexOf("original = checked_doc(snapshot['active'])");
    assert.ok(start > 0);
    const protectedBody = body.slice(start);
    body =
      body.slice(0, start) +
      `restore_observed = app.activeDocument
assert restore_observed is not None
restore_observed_key = identity(restore_observed)
restore_workspace_id = app.userInterface.activeWorkspace.id
restore_complete = False
print('FMCAD_VIEW_EFFECT ' + json.dumps(dict(stage='restore-user-view', document=snapshot['active'])))
try:
${protectedBody
  .split("\n")
  .map((line) => "    " + line)
  .join("\n")}
    restore_complete = True
finally:
    if not restore_complete:
        print('FMCAD_VIEW_EFFECT ' + json.dumps(dict(stage='restore-failed-focus', document=restore_observed_key)))
        if app.activeDocument != restore_observed:
            assert checked_doc(restore_observed_key).activate(), 'Cannot recover observed focus after partial restore'
        restore_workspace = app.userInterface.workspaces.itemById(restore_workspace_id)
        assert restore_workspace is not None
        if app.userInterface.activeWorkspace.id != restore_workspace_id:
            assert restore_workspace.activate(), 'Cannot recover observed workspace after partial restore'
        assert identity(app.activeDocument) == restore_observed_key and doc_rows() == view_before
`;
  }
  return (
    nativeCadRuntime(["camera.save", "camera.restore"]) + "\n" + program(body)
  );
}

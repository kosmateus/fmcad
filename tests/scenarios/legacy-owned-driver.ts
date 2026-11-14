// Retained legacy CLI assertions under the existing ScenarioSession owner lifecycle.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type {
  SpawnSyncOptionsWithStringEncoding,
  SpawnSyncReturns,
} from "node:child_process";
import { ownedLease, writeHandoff } from "./legacy-handoff";
import { record, text as requiredText, number } from "./contracts";
import { parsePublicQueueJob } from "../live-import-receipts";
const root = path.resolve(__dirname, "../../..");
const load = createRequire(path.join(root, "package.json"));
const { spawnSync, fixture } = load("./tests/helpers/live-broker") as {
  spawnSync(
    command: string,
    args: string[],
    options: SpawnSyncOptionsWithStringEncoding,
  ): SpawnSyncReturns<string>;
  fixture(name: string, creationId?: string): void;
};
const lease = ownedLease();
assert.ok(
  lease &&
    lease.mode === "owned-unsaved-script" &&
    lease.source === "tests/scenarios/legacy-owned-driver.ts",
  "Legacy commands require the explicit owned unsaved child handoff",
);
const name = lease.document.name;
fixture(name, lease.document.creationId);
const reportPath = path.join(lease.directory, "legacy", "readback.json");
const exportParent = path.join(lease.directory, "legacy", "artifacts");
fs.mkdirSync(exportParent, { mode: 0o700 });
const exportDir = path.join(exportParent, name);
const shotPath = path.join(exportParent, name + ".png");
interface LegacyDocument {
  name: string;
  creationId: string;
  modified: boolean;
  saved: boolean;
  active: boolean;
}
interface LegacySnapshot {
  documents: LegacyDocument[];
  active: string | null;
  designType?: number;
  timelineCount: number;
  marker: number;
  bodies: number;
  units: string;
  parameters: { name: string; expression: string; value: number }[];
  planes: { name: string; origin: number[]; normal: number[] }[];
}
interface LegacyReport {
  name: string;
  startedAt: string;
  scope: string;
  backend: string;
  tests: {
    name: string;
    status: string;
    reason?: string;
    error?: string;
    stack?: string;
  }[];
  commands: {
    args: string[];
    status: number | null;
    stdout: string;
    stderr: string;
    error?: string;
  }[];
  files: { path: string; bytes: number }[];
  testDocumentRemainsOpen: string | boolean;
  before?: LegacySnapshot;
  created?: LegacySnapshot;
  finishedAt?: string;
}
const report: LegacyReport = {
  name,
  startedAt: new Date().toISOString(),
  scope: "Legacy local document commands only; no cloud or licensing approval",
  tests: [],
  commands: [],
  files: [],
  testDocumentRemainsOpen: "unknown",
  backend: lease.protocol,
};
let unsafe = false;
let owned = false;
const coordinator = record(
  JSON.parse(
    fs.readFileSync(path.join(lease.directory, "..", "index.json"), "utf8"),
  ) as unknown,
);
assert.equal(coordinator["runId"], lease.owner.runId);
const before = record(coordinator["before"]);
function documents(value: unknown): LegacyDocument[] {
  assert.ok(Array.isArray(value));
  return value.map((entry) => {
    const d = record(entry);
    for (const key of ["modified", "saved", "active"])
      assert.equal(typeof d[key], "boolean");
    return {
      name: requiredText(d["name"]),
      creationId: requiredText(d["creationId"]),
      modified: d["modified"] === true,
      saved: d["saved"] === true,
      active: d["active"] === true,
    };
  });
}
assert.ok(Array.isArray(before["documents"]));
const initial = before["documents"].map((entry): Record<string, unknown> => {
  const d = record(entry);
  return { ...d, active: d["creationId"] === before["active"] };
});
const baseline: LegacySnapshot = {
  documents: documents(initial),
  active:
    before["active"] === null
      ? null
      : requiredText(initial.find((d) => d["active"])?.["name"]),
  timelineCount: 0,
  marker: 0,
  bodies: 0,
  units: "",
  parameters: [],
  planes: [],
};
function item<T>(rows: T[], predicate: (row: T) => boolean): T {
  const value = rows.find(predicate);
  assert.ok(value, "Native legacy readback omitted expected item");
  return value;
}
function persist() {
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
}
function cli(args: string[]) {
  assert.equal(
    unsafe,
    false,
    "Original legacy request is uncertain; never issue another command",
  );
  const result = spawnSync(
    process.execPath,
    ["bin/fmcad.js", ...args, "--timeout", "30000"],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 45000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  report.commands.push({
    args,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.error?.message ? { error: result.error.message } : {}),
  });
  if (result.error || result.signal || result.status === null) unsafe = true;
  const terminals = (result.stderr || "")
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("FMCAD_QUEUE_RESULT "));
  try {
    assert.equal(
      terminals.length,
      1,
      "Actual native legacy CLI must retain one terminal original receipt",
    );
    const receipt = parsePublicQueueJob(
      JSON.parse(terminals[0]!.slice("FMCAD_QUEUE_RESULT ".length)) as unknown,
      "Legacy CLI receipt",
    );
    assert.equal(receipt.clientId, lease!.owner.clientId);
    assert.ok(receipt.requestId.startsWith(lease!.owner.clientId + ":legacy:"));
    assert.ok(["succeeded", "failed"].includes(receipt.state));
    assert.equal(receipt.executionOutcome, receipt.state);
    assert.equal(receipt.operationResult["executionOutcome"], receipt.state);
  } catch (error) {
    unsafe = true;
    throw error;
  }
  persist();
  assert.equal(
    result.status,
    0,
    result.stderr || result.stdout || result.error?.message,
  );
  return result.stdout;
}
function snapshot(requireOwned = false) {
  const script = `import adsk.core, adsk.fusion, json
def run(_context: str) -> None:
    app = adsk.core.Application.get()
    docs = [{"name": d.name, "creationId": d.creationId, "modified": d.isModified, "saved": d.isSaved, "active": d == app.activeDocument} for d in app.documents]
    state = {"documents": docs, "active": app.activeDocument.name if app.activeDocument else None}
    if state["active"] == ${JSON.stringify(name)}:
        design = adsk.fusion.Design.cast(app.activeProduct)
        state["designType"] = int(design.designType)
        state["timelineCount"] = design.timeline.count
        state["marker"] = design.timeline.markerPosition
        state["bodies"] = design.rootComponent.bRepBodies.count
        state["units"] = design.unitsManager.defaultLengthUnits
        state["parameters"] = [{"name": p.name, "expression": p.expression, "value": p.value} for p in design.userParameters]
        state["planes"] = [{"name": p.name, "origin": p.geometry.origin.asArray(), "normal": p.geometry.normal.asArray()} for p in design.rootComponent.constructionPlanes]
    print("LIVE_STATE " + json.dumps(state))
`;
  const text = cli([
    "call",
    "fusion_mcp_execute",
    JSON.stringify({
      featureType: "script",
      object: { readOnly: true, script },
    }),
  ]);
  const line = text.split("\n").find((s) => s.startsWith("LIVE_STATE "));
  assert.ok(line, text);
  const value = record(JSON.parse(line.slice(11)) as unknown);
  const state: LegacySnapshot = {
    documents: documents(value["documents"]),
    active: value["active"] === null ? null : requiredText(value["active"]),
    timelineCount: number(value["timelineCount"]),
    marker: number(value["marker"]),
    bodies: number(value["bodies"]),
    units: requiredText(value["units"]),
    parameters: [],
    planes: [],
  };
  if (value["parameters"] !== undefined) {
    assert.ok(Array.isArray(value["parameters"]));
    state.parameters = value["parameters"].map((entry) => {
      const p = record(entry);
      return {
        name: requiredText(p["name"]),
        expression: requiredText(p["expression"]),
        value: number(p["value"]),
      };
    });
  }
  if (value["planes"] !== undefined) {
    assert.ok(Array.isArray(value["planes"]));
    state.planes = value["planes"].map((entry) => {
      const p = record(entry);
      assert.ok(Array.isArray(p["origin"]) && Array.isArray(p["normal"]));
      return {
        name: requiredText(p["name"]),
        origin: p["origin"].map(number),
        normal: p["normal"].map(number),
      };
    });
  }
  if (requireOwned) {
    assert.ok(owned, "Test document ownership not established");
    assert.equal(
      item(state.documents, (doc) => doc.name === name).creationId,
      lease!.document.creationId,
    );
    assert.equal(
      item(state.documents, (doc) => doc.name === name).saved,
      false,
    );
    assert.equal(state.active, name, "Active document is not the owned test");
    assert.equal(state.documents.filter((d) => d.name === name).length, 1);
  }
  return state;
}
function doc(...args: string[]) {
  snapshot(true);
  const text = cli([...args, "--doc", name]);
  assert.ok(text.includes("DOC name=" + name), text);
  return text;
}
function group(label: string, fn: () => void, enabled = true) {
  if (!enabled) {
    report.tests.push({
      name: label,
      status: "not-tested",
      reason: "Prerequisite failed",
    });
    persist();
    return false;
  }
  try {
    fn();
    report.tests.push({ name: label, status: "passed" });
    console.log("PASS " + label);
    persist();
    return true;
  } catch (error) {
    report.tests.push({
      name: label,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
    });
    console.error(
      "FAIL " +
        label +
        ": " +
        (error instanceof Error ? error.message : String(error)),
    );
    persist();
    return false;
  }
}

const listed = group("doc list and baseline", () => {
  cli(["doc", "list"]);
  // Baseline was captured by the existing coordinator before owned creation.
  report.before = baseline;
  assert.ok(!baseline.documents.some((d) => d.name === name));
});
const created = group(
  "doc new and ownership",
  () => {
    const parent = record(
      JSON.parse(
        fs.readFileSync(path.join(lease!.directory, "report.json"), "utf8"),
      ) as unknown,
    );
    assert.ok(Array.isArray(parent["requests"]));
    const creation = item(
      parent["requests"].map(record),
      (request) => request["phase"] === "create",
    );
    const result = record(creation["result"]);
    assert.equal(
      result["exitCode"],
      0,
      String(result["stderr"] || result["stdout"] || ""),
    );
    assert.equal(result["sdkSettled"], true);
    const receipt = record(result["brokerReceipt"]);
    assert.equal(receipt["requestId"], creation["requestId"]);
    assert.equal(receipt["clientId"], lease!.owner.clientId);
    assert.equal(receipt["state"], "succeeded");
    const state = snapshot();
    assert.equal(state.documents.length, baseline.documents.length + 1);
    assert.equal(state.documents.filter((d) => d.name === name).length, 1);
    owned = true;
    fixture(name, item(state.documents, (d) => d.name === name).creationId);
    assert.equal(
      item(state.documents, (d) => d.name === name).creationId,
      lease!.document.creationId,
    );
    report.created = state;
    assert.ok(cli(["doc", "list"]).includes(name));
  },
  listed,
);
group(
  "param_add/list/set/rename/delete",
  () => {
    doc("param_add", "migration_width", "10 mm", "mm", "live migration test");
    assert.match(doc("param_list"), /PARAM name=migration_width expr=10 mm/);
    doc("param_set", "migration_width", "20 mm");
    assert.equal(
      item(snapshot(true).parameters, (p) => p.name === "migration_width")
        .value,
      2,
    );
    doc("param_rename", "migration_width", "migration_width_renamed");
    assert.match(doc("param_list"), /PARAM name=migration_width_renamed/);
    doc("param_delete", "migration_width_renamed");
    assert.doesNotMatch(doc("param_list"), /PARAM name=migration_width/);
  },
  created,
);
const offset = group(
  "plane_add offset/list",
  () => {
    doc("plane_add", "MigrationOffset", "offset", "XY", "10 mm");
    assert.match(doc("plane_list"), /PLANE name=MigrationOffset/);
    assert.equal(
      item(snapshot(true).planes, (p) => p.name === "MigrationOffset")
        .origin[2],
      1,
    );
  },
  created,
);
const mid = group(
  "plane_add mid parallel planes",
  () => {
    doc("plane_add", "MigrationMid", "mid", "XY", "MigrationOffset");
    assert.equal(
      item(snapshot(true).planes, (p) => p.name === "MigrationMid").origin[2],
      0.5,
    );
  },
  offset,
);
group(
  "plane_rename/delete/list",
  () => {
    doc("plane_rename", "MigrationMid", "MigrationMidRenamed");
    assert.match(doc("plane_list"), /PLANE name=MigrationMidRenamed/);
    doc("plane_delete", "MigrationMidRenamed");
    assert.doesNotMatch(doc("plane_list"), /PLANE name=MigrationMid/);
  },
  mid,
);
group(
  "plane_add angle in default design",
  () => {
    doc("plane_add", "MigrationAngle", "angle", "XY", "X", "30 deg");
    assert.match(doc("plane_list"), /PLANE name=MigrationAngle/);
  },
  created,
);
group(
  "comp_add/list",
  () => {
    doc("comp_add", "MigrationComponent");
    assert.match(doc("comp_list"), /COMP name=MigrationComponent parent=/);
  },
  created,
);
group(
  "units cm/mm/in",
  () => {
    for (const unit of ["cm", "mm", "in"]) {
      doc("units", unit);
      assert.equal(snapshot(true).units, unit);
    }
  },
  created,
);
const box = group(
  "run box 10 mm; stats/bbox/bodies",
  () => {
    doc("run", "box", "--args", "[10]");
    const stats = doc("stats");
    assert.match(stats, /BODIES=1 /);
    assert.doesNotMatch(stats, /TIMELINE_ISSUE/);
    assert.match(doc("bbox"), /size=\(10\.0 x 10\.0 x 10\.0\) mm/);
    assert.match(doc("bodies"), /volume=1000\.00 mm3/);
  },
  created,
);
const rollback = group(
  "rollback and restore end",
  () => {
    const before = snapshot(true);
    assert.ok(before.timelineCount > 0);
    doc("rollback", String(before.timelineCount - 1));
    assert.equal(snapshot(true).bodies, 0);
    doc("rollback", String(before.timelineCount));
    const after = snapshot(true);
    assert.equal(after.marker, before.timelineCount);
    assert.equal(after.bodies, 1);
  },
  box,
);
group(
  "shot PNG",
  () => {
    snapshot(true);
    assert.ok(fs.statSync(path.dirname(shotPath)).isDirectory());
    cli([
      "shot",
      "--out",
      shotPath,
      "--dir",
      "iso-top-right",
      "--width",
      "800",
      "--height",
      "600",
    ]);
    assert.equal(
      fs.readFileSync(shotPath).subarray(0, 8).toString("hex"),
      "89504e470d0a1a0a",
    );
    report.files.push({ path: shotPath, bytes: fs.statSync(shotPath).size });
  },
  box && rollback,
);
for (const format of ["step", "stl"]) {
  group(
    "export " + format.toUpperCase(),
    () => {
      assert.ok(fs.statSync(exportParent).isDirectory());
      fs.mkdirSync(exportDir, { recursive: true });
      const out = path.join(exportDir, name + "." + format);
      assert.ok(!fs.existsSync(out));
      doc("export", format, "--out", out);
      const bytes = fs.statSync(out).size;
      assert.ok(bytes > 0);
      report.files.push({ path: out, bytes });
    },
    box && rollback,
  );
}
report.tests.push({
  name: "undo/redo",
  status: "not-tested",
  reason: "Optional; omitted to avoid global undo-stack effects",
});
if (owned && !unsafe) snapshot(true);
report.finishedAt = new Date().toISOString();
persist();
writeHandoff(
  path.join(lease.directory, "legacy/completion.json"),
  {
    owner: lease.owner,
    document: lease.document,
    safeForCleanup: !unsafe,
    reportPath,
    exportParent,
    status: report.tests.some((test) => test.status === "failed")
      ? "failed"
      : "passed",
  },
  true,
);
console.log("REPORT " + reportPath);
process.exitCode = report.tests.some((t) => t.status === "failed") ? 1 : 0;

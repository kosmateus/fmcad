import * as fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ScenarioBackend } from "./contracts";
import { record, text } from "./contracts";
import type { ScenarioReport } from "./runner";
import { resultValue } from "./saved-files";
import * as programs from "./programs";
import * as saved from "./saved-programs";

function read(filename: string): Record<string, unknown> {
  if (
    !fs.lstatSync(filename).isFile() ||
    fs.lstatSync(filename).isSymbolicLink()
  )
    throw new Error("Expected a regular run manifest");
  return record(JSON.parse(fs.readFileSync(filename, "utf8")) as unknown);
}

function inventory(value: unknown, identity: string): string {
  if (!Array.isArray(value)) throw new Error("Missing recovery inventory");
  return JSON.stringify(
    value
      .map(record)
      .map((item) => {
        const { complete: _complete, ...stable } = item;
        return stable;
      })
      .sort((a, b) => text(a[identity]).localeCompare(text(b[identity]))),
  );
}

/** Audit only after all created scenarios have settled their own cleanup. */
export async function auditRecovery(
  backend: ScenarioBackend,
  report: ScenarioReport,
): Promise<void> {
  const root = path.dirname(report.directory),
    filename = path.join(root, "index.json");
  if (!fs.existsSync(filename)) return; // A directly invoked runScenario has no coordinator.
  const index = read(filename);
  if (
    index["runId"] !== report.owner.runId ||
    index["mode"] !== backend.mode ||
    index["protocol"] !== backend.protocol
  )
    throw new Error("Foreign recovery run manifest");
  const ids = Array.isArray(index["scenarioIds"])
    ? index["scenarioIds"].map(text)
    : Array.isArray(index["reports"])
      ? index["reports"]
          .map(record)
          .map((row) => text(record(row["owner"])["scenarioId"]))
      : [];
  if (!ids.length || ids.some((id) => !/^[a-z0-9][a-z0-9_-]{0,100}$/.test(id)))
    throw new Error("Invalid recovery scenario inventory");
  for (const id of ids) {
    const item = path.join(root, id, "report.json");
    if (!fs.existsSync(item)) continue;
    const row = read(item),
      owner = record(row["owner"]);
    if (
      owner["runId"] !== report.owner.runId ||
      owner["scenarioId"] !== id ||
      row["backendIdentity"] !== backend.identity
    )
      throw new Error("Foreign recovery scenario report");
    if (row["cleanup"] !== "complete" && row["status"] !== "unsupported")
      return;
  }
  const owner = {
    runId: report.owner.runId,
    scenarioId: "coordinator",
    clientId: "scenario:" + report.owner.runId + ":coordinator",
  };
  const original = async (phase: string): Promise<Record<string, unknown>> => {
    const requestId = owner.clientId + ":" + phase;
    const result = await backend.lookup?.(owner, requestId);
    const value = resultValue({
      requestId,
      phase,
      ...(result ? { result } : {}),
    });
    if (!value)
      throw new Error("Original coordinator evidence unavailable: " + phase);
    return value;
  };
  const observe = async (source: string): Promise<Record<string, unknown>> => {
    const requestId = owner.clientId + ":recovery-" + randomUUID();
    const result = await backend.execute({
      owner,
      requestId,
      source,
      directory: path.join(root, "_coordinator"),
    });
    const value = resultValue({ requestId, phase: "recovery-audit", result });
    if (!value) throw new Error("Recovery audit did not settle");
    return value;
  };
  try {
    const before = await original("before");
    const after = await observe(programs.snapshot());
    if (
      inventory(before["documents"], "creationId") !==
      inventory(after["documents"], "creationId")
    )
      throw new Error("Document inventory changed during deferred cleanup");
    const count = Array.isArray(index["cloudBefore"])
      ? index["cloudBefore"].length
      : 0;
    for (let i = 0; i < count; i++) {
      const initial = await original("files-before-" + i);
      const current = await observe(
        saved.inventory({
          projectId: text(initial["projectId"]),
          folderId: text(initial["folderId"]),
        }),
      );
      if (
        inventory(initial["files"], "fileId") !==
        inventory(current["files"], "fileId")
      )
        throw new Error("Cloud file inventory changed during deferred cleanup");
    }
    if (typeof before["active"] === "string")
      await observe(programs.restoreActive(before["active"]));
    index["recoveryAudit"] = { status: "complete" };
  } catch (error) {
    index["recoveryAudit"] = { status: "failed", error: String(error) };
    throw error;
  } finally {
    fs.writeFileSync(filename + ".new", JSON.stringify(index, null, 2) + "\n", {
      mode: 0o600,
    });
    fs.renameSync(filename + ".new", filename);
  }
}

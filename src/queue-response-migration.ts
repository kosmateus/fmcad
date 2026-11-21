import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
const load = createRequire(__filename);
const { readJson, durableBytes, readBytes } = load(
  "./dist/node-adapters/persistence/records",
) as typeof import("../packages/node-adapters/src/persistence/records");
const { resultDirectory, projectDirectory, regularDirectory } = load(
  "./dist/node-adapters/persistence/owned-results",
) as typeof import("../packages/node-adapters/src/persistence/owned-results");

export interface ResponseMigrationOptions {
  dir: string;
  project: string;
  apply?: boolean;
}
export interface MigratedResponse {
  jobId: string;
  name: string;
  source: string;
  target: string;
  sha256: string;
  bytes: number;
}
export interface ResponseMigrationResult {
  project: string;
  applied: boolean;
  files: MigratedResponse[];
  skippedNonterminal: number;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid queue response migration record");
  return value as Record<string, unknown>;
}

function digest(file: string) {
  const bytes = readBytes(file, 128 * 1024 * 1024);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
}
function syncDirectory(directory: string) {
  const fd = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
export function migrateProjectResponses({
  dir,
  project,
  apply = false,
}: ResponseMigrationOptions): ResponseMigrationResult {
  const stopped = () => {
    if (fs.existsSync(path.join(dir, "broker.lock")))
      throw new Error("Stop the broker before migrating response files");
  };
  stopped();
  project = fs.realpathSync(project);
  const state = record(
    readJson(path.join(dir, "queue-state.json"), 128 * 1024 * 1024),
  );
  const result: ResponseMigrationResult = {
    project,
    applied: apply,
    files: [],
    skippedNonterminal: 0,
  };
  for (const raw of Object.values(record(state["jobs"] || {}))) {
    const data = record(raw);
    const request =
      data["request"] && typeof data["request"] === "object"
        ? record(data["request"])
        : {};
    if (typeof request["cwd"] !== "string") continue;
    if (typeof data["id"] !== "string" || typeof data["state"] !== "string")
      throw new Error("Invalid response job identity or state");
    const job = {
      id: data["id"],
      state: data["state"],
      request: { cwd: request["cwd"] },
    };
    let cwd;
    try {
      cwd = fs.realpathSync(job.request.cwd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const relative = path.relative(project, cwd);
    if (
      relative === ".." ||
      relative.startsWith(".." + path.sep) ||
      path.isAbsolute(relative)
    )
      continue;
    if (projectDirectory(cwd) !== project) continue;
    if (
      !["succeeded", "failed", "cancelled", "expired", "completed"].includes(
        job.state,
      )
    ) {
      result.skippedNonterminal++;
      continue;
    }
    for (const name of ["stdout.txt", "stderr.txt", "rpc-result.json"]) {
      const source = path.join(dir, "jobs", job.id, name);
      if (!fs.existsSync(source)) continue;
      regularDirectory(dir, ["jobs", job.id]);
      const before = digest(source),
        directory = resultDirectory(job, apply);
      if (!directory)
        throw new Error("Response job has no owned project directory");
      const target = path.join(directory, name);
      if (fs.existsSync(target) && digest(target).sha256 !== before.sha256)
        throw new Error("Conflicting project response: " + target);
      if (apply) {
        stopped();
        if (!fs.existsSync(target)) {
          durableBytes(target, readBytes(source, 128 * 1024 * 1024), true);
        }
        syncDirectory(directory);
        stopped();
        if (
          digest(source).sha256 !== before.sha256 ||
          digest(target).sha256 !== before.sha256
        )
          throw new Error("Response changed during migration");
        fs.unlinkSync(source);
        syncDirectory(path.dirname(source));
      }
      result.files.push({ jobId: job.id, name, source, target, ...before });
    }
  }
  return result;
}

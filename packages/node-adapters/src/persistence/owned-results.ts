import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { OwnedResultReference } from "../../../core/src/ports/execution-store";
import { failure, readBytes, syncDirectory } from "./records";

const names = new Set(["stdout.txt", "stderr.txt", "rpc-result.json"]);
const digest = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
const id = (value: string): boolean => /^[a-zA-Z0-9_-]+$/.test(value);

function resultExists(file: string): boolean {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      failure(
        "INVALID_ARTIFACT",
        "Response artifact must be a regular file, not a symlink",
      );
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function projectDirectory(cwd: string | undefined): string | null {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return null;
  const original = fs.realpathSync(cwd);
  let current = original;
  while (true) {
    try {
      const stat = fs.lstatSync(path.join(current, ".cad"));
      if (stat.isSymbolicLink() || !stat.isDirectory())
        failure("INVALID_ARTIFACT", "Project .cad must be a regular directory");
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return original;
    current = parent;
  }
}

/** Verify each component, not just the final O_NOFOLLOW file. */
export function regularDirectory(
  root: string,
  components: string[],
  create = false,
): string {
  let current = fs.realpathSync(root);
  for (const component of components) {
    if (!id(component) && component !== ".cad")
      failure("INVALID_ARTIFACT", "Invalid artifact directory");
    current = path.join(current, component);
    if (create) {
      try {
        fs.mkdirSync(current, { mode: 0o700 });
        syncDirectory(path.dirname(current));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      failure(
        "INVALID_ARTIFACT",
        "Artifact directories must be regular directories, not symlinks",
      );
  }
  return current;
}

export interface ResultJob {
  id: string;
  request?: { cwd?: string };
}

export function resultDirectory(job: ResultJob, create = false): string | null {
  if (!id(job.id)) failure("INVALID_ARTIFACT", "Invalid task ID");
  const project = projectDirectory(job.request?.cwd);
  if (!project) return null;
  // Resolve paths without creating directories on reads of old global history.
  if (!create) {
    try {
      return regularDirectory(project, [".cad", "results", job.id]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return path.join(project, ".cad", "results", job.id);
  }
  return regularDirectory(project, [".cad", "results", job.id], true);
}

export function responsePath(
  dir: string,
  job: ResultJob,
  name: string,
  write = false,
): string {
  if (!id(job.id)) failure("INVALID_ARTIFACT", "Invalid task ID");
  if (!names.has(name))
    failure("INVALID_ARTIFACT", "Invalid response artifact name");
  const local = resultDirectory(job, write);
  if (local && (write || resultExists(path.join(local, name))))
    return path.join(local, name);
  // Legacy compatibility never authorizes a caller-provided path.
  try {
    return path.join(regularDirectory(dir, ["jobs", job.id]), name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return path.join(fs.realpathSync(dir), "jobs", job.id, name);
  }
}

function scope(dir: string, cwd?: string): string {
  return digest(projectDirectory(cwd) ?? fs.realpathSync(dir));
}

export function describeOwnedResult(
  dir: string,
  job: ResultJob,
  name: OwnedResultReference["name"],
): { path: string; bytes: number; artifact: OwnedResultReference } {
  const file = responsePath(dir, job, name);
  const bytes = readBytes(file, 128 * 1024 * 1024, fs, file);
  return describeBytes(dir, job, name, file, bytes);
}

function describeBytes(
  dir: string,
  job: ResultJob,
  name: OwnedResultReference["name"],
  file: string,
  bytes: Buffer,
): { path: string; bytes: number; artifact: OwnedResultReference } {
  const local = resultDirectory(job);
  return {
    path: file,
    bytes: bytes.length,
    artifact: {
      version: 1,
      jobId: job.id,
      name,
      scope: scope(dir, job.request?.cwd),
      storage: local && file === path.join(local, name) ? "project" : "legacy",
      bytes: bytes.length,
      sha256: digest(bytes),
    },
  };
}

export function readOwnedResult(
  dir: string,
  expected: { jobId: string; cwd?: string },
  reference: OwnedResultReference,
  maxBytes = 16 * 1024 * 1024,
): Buffer {
  if (
    !reference ||
    Object.keys(reference).sort().join(",") !==
      "bytes,jobId,name,scope,sha256,storage,version" ||
    reference.version !== 1 ||
    !id(reference.jobId) ||
    reference.jobId !== expected.jobId ||
    !names.has(reference.name) ||
    !["project", "legacy"].includes(reference.storage) ||
    !Number.isSafeInteger(reference.bytes) ||
    reference.bytes < 0 ||
    reference.bytes > maxBytes ||
    !/^[a-f0-9]{64}$/.test(reference.sha256) ||
    reference.scope !== scope(dir, expected.cwd)
  ) {
    failure(
      "INVALID_ARTIFACT",
      "Owned artifact reference does not match this job/project or read limit",
    );
  }
  const project = projectDirectory(expected.cwd);
  if (reference.storage === "project" && !project)
    failure("INVALID_ARTIFACT", "Project scope required");
  const directory =
    reference.storage === "project"
      ? regularDirectory(project!, [".cad", "results", expected.jobId])
      : regularDirectory(dir, ["jobs", expected.jobId]);
  const file = path.join(directory, reference.name);
  const bytes = readBytes(file, maxBytes, fs, file);
  if (bytes.length !== reference.bytes || digest(bytes) !== reference.sha256)
    failure("INVALID_ARTIFACT", "Owned artifact hash/size mismatch");
  return bytes;
}

/** Composition seam for the broker; descriptors and inline reads share validation. */
export function jobOutputs(
  dir: string,
  job: ResultJob,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const outputs: Record<string, unknown> = {};
  for (const [key, name] of [
    ["stdout", "stdout.txt"],
    ["stderr", "stderr.txt"],
    ["rpc", "rpc-result.json"],
  ] as const) {
    const file = responsePath(dir, job, name);
    if (!resultExists(file)) {
      if (key !== "rpc") result[key] = "";
      continue;
    }
    // Workers may append logs while callers poll. Inline bytes must come from
    // one bounded prefix snapshot, not a descriptor followed by a second read.
    const bytes = readBytes(file, 128 * 1024 * 1024, fs, file, key !== "rpc");
    if (bytes.length <= 1024 * 1024) {
      result[key] =
        key === "rpc"
          ? (JSON.parse(bytes.toString("utf8")) as unknown)
          : bytes.toString("utf8");
    } else outputs[key] = describeBytes(dir, job, name, file, bytes);
  }
  if (Object.keys(outputs).length) result["outputs"] = outputs;
  return result;
}

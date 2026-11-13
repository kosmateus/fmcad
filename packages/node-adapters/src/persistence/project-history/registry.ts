import { randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import type {
  ProjectRegistryEntry,
  ProjectRegistryLifecycleInput,
  ProjectRegistrySnapshot,
  RegisterProjectInput,
} from "../../../../core/src/domain/project-registry";
import type { ProjectRegistryStore } from "../../../../core/src/ports/project-registry";

const REGISTRY_VERSION = 1;
const MAX_REGISTRY_BYTES = 4 * 1024 * 1024;

export interface ProjectRegistryOptions {
  readonly filePath?: string;
  readonly dataHome?: string;
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly lockTimeoutMs?: number;
  readonly now?: () => number;
}

export class ProjectRegistryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProjectRegistryError";
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new ProjectRegistryError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function absoluteDataHome(options: ProjectRegistryOptions): string {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const configured = options.dataHome ?? env["XDG_DATA_HOME"];
  if (!configured) return join(home, ".local", "share");
  return isAbsolute(configured) ? configured : resolve(home, configured);
}

function defaultRegistryPath(options: ProjectRegistryOptions): string {
  return join(
    absoluteDataHome(options),
    "fmcad",
    "control-center",
    "projects.json",
  );
}

function ensureDirectoryChain(directory: string): void {
  const absolute = resolve(directory);
  const root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        fail(
          "REGISTRY_PATH_INVALID",
          `Registry directory must not be a symlink: ${current}`,
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(current, { mode: 0o700 });
    }
  }
}

function assertDirectoryChain(directory: string): boolean {
  const absolute = resolve(directory);
  const root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        fail(
          "REGISTRY_PATH_INVALID",
          `Registry directory must not be a symlink: ${current}`,
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  return true;
}

function checkRegistryFile(file: string): boolean {
  try {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile())
      fail(
        "REGISTRY_PATH_INVALID",
        "Project registry must be a regular non-symlink file",
      );
    if (stat.size > MAX_REGISTRY_BYTES)
      fail("REGISTRY_CORRUPT", "Project registry exceeds its supported size");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function readRegistryFile(file: string): ProjectRegistrySnapshot {
  if (!assertDirectoryChain(dirname(file)))
    return { version: 1, revision: 0, projects: [] };
  if (!checkRegistryFile(file))
    return { version: 1, revision: 0, projects: [] };
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    fail("REGISTRY_READ_FAILED", "Project registry could not be read", error);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_REGISTRY_BYTES)
      fail(
        "REGISTRY_CORRUPT",
        "Project registry is not a bounded regular file",
      );
    const bytes = Buffer.alloc(stat.size + 1);
    const read = readSync(fd, bytes, 0, bytes.length, 0);
    if (read !== stat.size)
      fail("REGISTRY_READ_FAILED", "Project registry changed while being read");
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.subarray(0, read).toString("utf8")) as unknown;
    } catch (error) {
      fail("REGISTRY_CORRUPT", "Project registry is not valid JSON", error);
    }
    return validateSnapshot(parsed);
  } finally {
    closeSync(fd);
  }
}

function validateSnapshot(value: unknown): ProjectRegistrySnapshot {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("version" in value) ||
    value.version !== REGISTRY_VERSION ||
    !("revision" in value) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !("projects" in value) ||
    !Array.isArray(value.projects)
  ) {
    fail(
      "REGISTRY_CORRUPT",
      "Project registry version or root shape is invalid",
    );
  }
  const projects: ProjectRegistryEntry[] = [];
  const ids = new Set<string>();
  const paths = new Set<string>();
  const databaseIds = new Set<string>();
  for (const item of value.projects) {
    if (
      item === null ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      !("projectId" in item) ||
      typeof item.projectId !== "string" ||
      !item.projectId.trim() ||
      item.projectId.length > 256 ||
      !("path" in item) ||
      typeof item.path !== "string" ||
      !isAbsolute(item.path) ||
      !("databaseId" in item) ||
      typeof item.databaseId !== "string" ||
      !item.databaseId.trim() ||
      !("monitoring" in item) ||
      typeof item.monitoring !== "boolean" ||
      !("archivedAtMs" in item) ||
      (item.archivedAtMs !== null &&
        (!Number.isFinite(item.archivedAtMs) || item.archivedAtMs < 0)) ||
      (item.archivedAtMs !== null && item.monitoring) ||
      !("updatedAtMs" in item) ||
      !Number.isFinite(item.updatedAtMs) ||
      item.updatedAtMs < 0 ||
      !("lastResetAtMs" in item) ||
      (item.lastResetAtMs !== null &&
        (!Number.isFinite(item.lastResetAtMs) || item.lastResetAtMs < 0))
    ) {
      fail("REGISTRY_CORRUPT", "Project registry entry is invalid");
    }
    if (
      ids.has(item.projectId) ||
      paths.has(item.path) ||
      databaseIds.has(item.databaseId)
    ) {
      fail(
        "REGISTRY_CORRUPT",
        "Project registry contains duplicate identities or paths",
      );
    }
    ids.add(item.projectId);
    paths.add(item.path);
    databaseIds.add(item.databaseId);
    projects.push({
      projectId: item.projectId,
      path: item.path,
      databaseId: item.databaseId,
      monitoring: item.monitoring,
      archivedAtMs: item.archivedAtMs,
      updatedAtMs: item.updatedAtMs,
      lastResetAtMs: item.lastResetAtMs,
    });
  }
  return {
    version: 1,
    revision: value.revision as number,
    projects: projects.sort((a, b) => a.projectId.localeCompare(b.projectId)),
  };
}

function canonicalProjectPath(projectPath: string): string {
  if (!isAbsolute(projectPath))
    fail("PROJECT_PATH_INVALID", "Project path must be absolute");
  try {
    const canonical = realpathSync(resolve(projectPath));
    if (!statSync(canonical).isDirectory())
      fail(
        "PROJECT_PATH_INVALID",
        "Registered project path must be a directory",
      );
    return canonical;
  } catch (error) {
    if (error instanceof ProjectRegistryError) throw error;
    fail(
      "PROJECT_MISSING",
      "Project path is missing; it was not rediscovered elsewhere",
      error,
    );
  }
}

function validateInput(input: RegisterProjectInput): ProjectRegistryEntry {
  if (
    !input.projectId.trim() ||
    input.projectId.length > 256 ||
    !input.databaseId.trim() ||
    typeof input.monitoring !== "boolean" ||
    !Number.isFinite(input.nowMs) ||
    input.nowMs < 0 ||
    (input.archivedAtMs !== null &&
      (!Number.isFinite(input.archivedAtMs) || input.archivedAtMs < 0)) ||
    (input.archivedAtMs !== null && input.monitoring)
  ) {
    fail("REGISTRY_ENTRY_INVALID", "Project registry input is invalid");
  }
  return {
    projectId: input.projectId,
    path: canonicalProjectPath(input.projectPath),
    databaseId: input.databaseId,
    monitoring: input.monitoring,
    archivedAtMs: input.archivedAtMs,
    updatedAtMs: input.nowMs,
    lastResetAtMs: null,
  };
}

function syncDirectory(directory: string): void {
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function atomicWrite(file: string, snapshot: ProjectRegistrySnapshot): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let created = false;
  let primary: unknown;
  try {
    const fd = openSync(temporary, "wx", 0o600);
    created = true;
    try {
      writeFileSync(fd, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, file);
    syncDirectory(dirname(file));
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    if (created) {
      try {
        unlinkSync(temporary);
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "ENOENT" &&
          primary === undefined
        )
          throw error;
      }
    }
  }
}

/** Small explicit project catalog; it never discovers projects by scanning disks. */
export function openProjectRegistry(
  options: ProjectRegistryOptions = {},
): ProjectRegistryStore {
  const file = resolve(options.filePath ?? defaultRegistryPath(options));
  const directory = dirname(file);
  const lockFile = `${file}.lock`;
  const now = options.now ?? Date.now;

  // Liveness permits waiting only, never stealing or deleting another lock.
  // An empty file may be the short exclusive-create/write publication window.
  function writerCanFinish(allowSameProcess: boolean): boolean {
    let fd: number;
    try {
      fd = openSync(lockFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 4096) return false;
      if (stat.size === 0) return true;
      const bytes = Buffer.alloc(stat.size);
      if (readSync(fd, bytes, 0, bytes.length, 0) !== stat.size) return true;
      let owner: unknown;
      try {
        owner = JSON.parse(bytes.toString("utf8")) as unknown;
      } catch {
        return false;
      }
      if (
        !owner ||
        typeof owner !== "object" ||
        !("pid" in owner) ||
        typeof owner.pid !== "number" ||
        !Number.isSafeInteger(owner.pid) ||
        owner.pid <= 0 ||
        (!allowSameProcess && owner.pid === process.pid)
      )
        return false;
      try {
        process.kill(owner.pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    } finally {
      closeSync(fd);
    }
  }

  function withWriteLock<T>(operation: () => T, waitForWriter = true): T {
    ensureDirectoryChain(directory);
    let lockFd: number;
    const wait = new Int32Array(new SharedArrayBuffer(4));
    for (;;) {
      try {
        lockFd = openSync(lockFile, "wx", 0o600);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // Independent processes release their own short synchronous writes.
        // Never reclaim or remove an existing lock, including an orphaned one.
        const retryable = writerCanFinish(!waitForWriter);
        if (waitForWriter && retryable) {
          Atomics.wait(wait, 0, 0, 10);
          continue;
        }
        throw Object.assign(
          new ProjectRegistryError(
            "REGISTRY_BUSY",
            "Project registry has another writer or an unreconciled lock; it was not overwritten",
            { cause: error },
          ),
          { retryable },
        );
      }
    }
    const ownedLock = fstatSync(lockFd);
    try {
      writeFileSync(
        lockFd,
        JSON.stringify({ pid: process.pid, startedAtMs: now() }),
      );
      fsyncSync(lockFd);
      return operation();
    } finally {
      closeSync(lockFd);
      try {
        const lockStat = lstatSync(lockFile);
        if (
          lockStat.isSymbolicLink() ||
          !lockStat.isFile() ||
          lockStat.dev !== ownedLock.dev ||
          lockStat.ino !== ownedLock.ino
        )
          fail(
            "REGISTRY_PATH_INVALID",
            "Project registry lock changed unexpectedly",
          );
        unlinkSync(lockFile);
        syncDirectory(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  function mutate(
    transform: (current: ProjectRegistrySnapshot) => {
      snapshot: ProjectRegistrySnapshot;
      changed: boolean;
    },
  ): ProjectRegistrySnapshot {
    return withWriteLock(() => {
      const current = readRegistryFile(file);
      const result = transform(current);
      if (!result.changed) return current;
      if (current.revision >= Number.MAX_SAFE_INTEGER)
        fail(
          "REGISTRY_REVISION_EXHAUSTED",
          "Project registry revision is exhausted",
        );
      const snapshot = validateSnapshot({
        version: 1,
        revision: current.revision + 1,
        projects: result.snapshot.projects,
      });
      atomicWrite(file, snapshot);
      return snapshot;
    });
  }

  return {
    readonlyPath: file,

    read(): ProjectRegistrySnapshot {
      return readRegistryFile(file);
    },

    withRegistrationFence<T>(
      operation: (snapshot: ProjectRegistrySnapshot) => T,
    ): T {
      return withWriteLock(() => {
        const result = operation(readRegistryFile(file));
        if (result && typeof result === "object" && "then" in result)
          fail(
            "REGISTRY_FENCE_ASYNC",
            "Registration fence operations must remain synchronous",
          );
        return result;
      }, false);
    },

    lookup(projectId: string): ProjectRegistryEntry | null {
      const entry = readRegistryFile(file).projects.find(
        (project) => project.projectId === projectId,
      );
      if (!entry) return null;
      try {
        const canonical = canonicalProjectPath(entry.path);
        if (canonical !== entry.path)
          fail(
            "PROJECT_PATH_MISMATCH",
            "Registered project path changed identity",
          );
      } catch (error) {
        if (
          error instanceof ProjectRegistryError &&
          error.code === "PROJECT_MISSING"
        )
          throw error;
        throw error;
      }
      return entry;
    },

    register(input: RegisterProjectInput): ProjectRegistrySnapshot {
      const entry = validateInput(input);
      return mutate((current) => {
        const byId = current.projects.find(
          (project) => project.projectId === entry.projectId,
        );
        if (byId) {
          if (byId.path !== entry.path)
            fail(
              byId.databaseId === entry.databaseId
                ? "PROJECT_COPY_REQUIRES_EXPLICIT_RESOLUTION"
                : "PROJECT_PATH_MISMATCH",
              "Project path changed; rename or copied-project resolution must be explicit",
            );
          if (byId.databaseId !== entry.databaseId)
            fail(
              "PROJECT_DATABASE_CHANGED",
              "Project history database was replaced or reset; explicit acknowledgement is required",
            );
          const updated = {
            ...byId,
            monitoring: entry.monitoring,
            archivedAtMs: entry.archivedAtMs,
            updatedAtMs: entry.updatedAtMs,
          };
          const changed =
            byId.monitoring !== updated.monitoring ||
            byId.archivedAtMs !== updated.archivedAtMs;
          return {
            snapshot: {
              version: 1,
              revision: current.revision,
              projects: current.projects.map((item) =>
                item.projectId === entry.projectId ? updated : item,
              ),
            },
            changed,
          };
        }
        const samePath = current.projects.find(
          (item) => item.path === entry.path,
        );
        if (samePath)
          fail(
            "PROJECT_ID_CONFLICT",
            "This project path is already assigned a different canonical project ID",
          );
        const sameDatabase = current.projects.find(
          (item) => item.databaseId === entry.databaseId,
        );
        if (sameDatabase)
          fail(
            "PROJECT_COPY_REQUIRES_EXPLICIT_RESOLUTION",
            "This database identity is already registered; copied project roots are not auto-registered",
          );
        return {
          snapshot: {
            version: 1,
            revision: current.revision,
            projects: [...current.projects, entry],
          },
          changed: true,
        };
      });
    },

    setLifecycle(
      projectId: string,
      lifecycle: ProjectRegistryLifecycleInput,
      expected?: ProjectRegistryEntry,
    ): ProjectRegistrySnapshot {
      if (
        typeof lifecycle.monitoring !== "boolean" ||
        !Number.isFinite(lifecycle.nowMs) ||
        lifecycle.nowMs < 0 ||
        (lifecycle.archivedAtMs !== null &&
          (!Number.isFinite(lifecycle.archivedAtMs) ||
            lifecycle.archivedAtMs < 0)) ||
        (lifecycle.archivedAtMs !== null && lifecycle.monitoring)
      )
        fail("REGISTRY_ENTRY_INVALID", "Project lifecycle state is invalid");
      return mutate((current) => {
        const entry = current.projects.find(
          (project) => project.projectId === projectId,
        );
        if (!entry) fail("PROJECT_NOT_REGISTERED", "Project is not registered");
        if (
          expected &&
          (entry.projectId !== expected.projectId ||
            entry.path !== expected.path ||
            entry.databaseId !== expected.databaseId ||
            entry.monitoring !== expected.monitoring ||
            entry.archivedAtMs !== expected.archivedAtMs ||
            entry.updatedAtMs !== expected.updatedAtMs ||
            entry.lastResetAtMs !== expected.lastResetAtMs)
        )
          fail(
            "REGISTRY_REVISION_CONFLICT",
            "Registered project changed since the lifecycle mutation was prepared",
          );
        const updated = {
          ...entry,
          monitoring: lifecycle.monitoring,
          archivedAtMs: lifecycle.archivedAtMs,
          updatedAtMs: lifecycle.nowMs,
        };
        const changed =
          entry.monitoring !== updated.monitoring ||
          entry.archivedAtMs !== updated.archivedAtMs;
        return {
          snapshot: {
            version: 1,
            revision: current.revision,
            projects: current.projects.map((item) =>
              item.projectId === projectId ? updated : item,
            ),
          },
          changed,
        };
      });
    },

    moveProject(
      projectId: string,
      projectPath: string,
      databaseId: string,
      nowMs: number,
    ): ProjectRegistrySnapshot {
      const newPath = canonicalProjectPath(projectPath);
      if (!Number.isFinite(nowMs) || nowMs < 0)
        fail(
          "REGISTRY_ENTRY_INVALID",
          "Project path update timestamp is invalid",
        );
      return mutate((current) => {
        const entry = current.projects.find(
          (project) => project.projectId === projectId,
        );
        if (!entry) fail("PROJECT_NOT_REGISTERED", "Project is not registered");
        if (entry.databaseId !== databaseId)
          fail(
            "PROJECT_DATABASE_CHANGED",
            "Database identity changed during project move",
          );
        try {
          canonicalProjectPath(entry.path);
          fail(
            "PROJECT_COPY_REQUIRES_EXPLICIT_RESOLUTION",
            "Old project path still exists; a second copy is not a rename",
          );
        } catch (error) {
          if (
            !(error instanceof ProjectRegistryError) ||
            error.code !== "PROJECT_MISSING"
          )
            throw error;
        }
        if (
          current.projects.some(
            (item) => item.path === newPath && item.projectId !== projectId,
          )
        )
          fail(
            "PROJECT_ID_CONFLICT",
            "Destination path belongs to another registered project",
          );
        return {
          snapshot: {
            version: 1,
            revision: current.revision,
            projects: current.projects.map((item) =>
              item.projectId === projectId
                ? { ...item, path: newPath, updatedAtMs: nowMs }
                : item,
            ),
          },
          changed: entry.path !== newPath,
        };
      });
    },

    acknowledgeDatabaseReset(
      projectId: string,
      databaseId: string,
      nowMs: number,
    ): ProjectRegistrySnapshot {
      if (!Number.isFinite(nowMs) || nowMs < 0)
        fail("REGISTRY_ENTRY_INVALID", "Database reset timestamp is invalid");
      return mutate((current) => {
        const entry = current.projects.find(
          (project) => project.projectId === projectId,
        );
        if (!entry) fail("PROJECT_NOT_REGISTERED", "Project is not registered");
        canonicalProjectPath(entry.path);
        if (entry.databaseId === databaseId)
          return { snapshot: current, changed: false };
        if (current.projects.some((item) => item.databaseId === databaseId))
          fail(
            "PROJECT_COPY_REQUIRES_EXPLICIT_RESOLUTION",
            "Replacement database identity belongs to another registered project",
          );
        return {
          snapshot: {
            version: 1,
            revision: current.revision,
            projects: current.projects.map((item) =>
              item.projectId === projectId
                ? {
                    ...item,
                    databaseId,
                    monitoring: false,
                    archivedAtMs: null,
                    updatedAtMs: nowMs,
                    lastResetAtMs: nowMs,
                  }
                : item,
            ),
          },
          changed: true,
        };
      });
    },
  };
}

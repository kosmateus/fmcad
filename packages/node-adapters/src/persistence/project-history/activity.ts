import { realpathSync } from "node:fs";
import path from "node:path";
import type { ProjectRegistryStore } from "../../../../core/src/ports/project-registry";
import type {
  ProjectHistoryStore,
  ProjectHistorySynchronousResult,
} from "../../../../core/src/ports/project-history";
import { openProjectRegistry } from "./registry";
import { openRegisteredProjectHistoryStore } from "./sqlite";

export interface ProjectActivityProof {
  readonly version: 1;
  readonly projectId: string;
  readonly databaseId: string;
  readonly projectRoot: string;
}
export interface ProjectActivityOptions {
  readonly registry?: ProjectRegistryStore;
  /** Closing a presence record cannot create new work or restore monitoring. */
  readonly closingPresence?: boolean;
}
function fail(message: string): never {
  throw Object.assign(new Error(message), {
    code: "PROJECT_ACTIVITY_BLOCKED",
    notStarted: true,
  });
}
/** Use the existing registry enrollment lock and SQLite writer fence, never a parallel authority. */
export function withProjectActivitiesFence<T>(
  directories: readonly string[],
  operation: (
    proofs: readonly ProjectActivityProof[],
  ) => ProjectHistorySynchronousResult<T>,
  options: ProjectActivityOptions = {},
): T {
  if (!directories.length) return operation([]);
  const registry = options.registry ?? openProjectRegistry();
  if (!registry.withRegistrationFence)
    fail("Project registration cannot be fenced");
  // Canonicalization is required before enrollment lookup. A nonexistent input
  // cannot be registered concurrently because registration also requires it.
  const roots = directories.map((value) => {
    if (typeof value !== "string" || !path.isAbsolute(value))
      fail("Project activity requires an absolute directory");
    try {
      return realpathSync(value);
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return path.resolve(value);
      throw error;
    }
  });
  return registry.withRegistrationFence((snapshot) => {
    const selected = roots
      .map(
        (root) =>
          snapshot.projects
            .filter(
              (project) =>
                root === project.path ||
                root.startsWith(project.path + path.sep),
            )
            .sort((a, b) => b.path.length - a.path.length)[0],
      )
      .filter((project) => project !== undefined);
    const projects = [
      ...new Map(
        selected.map((project) => [project.projectId, project]),
      ).values(),
    ].sort((a, b) => a.path.localeCompare(b.path));
    const stores: ProjectHistoryStore[] = [];
    try {
      for (const project of projects)
        stores.push(
          openRegisteredProjectHistoryStore(registry, {
            projectId: project.projectId,
            projectRoot: project.path,
            readOnly: false,
          }),
        );
      const proofs: ProjectActivityProof[] = [];
      function enter(index: number): T {
        const store = stores[index];
        if (!store) return operation(proofs);
        let callbackFailure: { error: unknown } | undefined;
        try {
          return store.withActivityFence<T>((fence) => {
            try {
              const state = fence.snapshot();
              const enrolled = projects[index];
              if (
                !enrolled ||
                state.projectId !== enrolled.projectId ||
                state.databaseId !== enrolled.databaseId
              )
                fail("Project activity identity changed");
              if (
                !options.closingPresence &&
                (!enrolled.monitoring ||
                  enrolled.archivedAtMs !== null ||
                  !state.lifecycle.monitoring ||
                  state.lifecycle.archivedAtMs !== null)
              )
                fail("Archived project must be restored before new activity");
              proofs.push({
                version: 1,
                projectId: state.projectId,
                databaseId: state.databaseId,
                projectRoot: enrolled.path,
              });
              return enter(index + 1) as ProjectHistorySynchronousResult<T>;
            } catch (error) {
              callbackFailure = { error };
              throw error;
            }
          });
        } catch (error) {
          // SQLite's transaction adapter classifies storage failures. Keep an
          // admission refusal or original submit failure distinct from COMMIT
          // failure, which may follow an already persisted queue acceptance.
          if (callbackFailure) throw callbackFailure.error;
          throw error;
        }
      }
      return enter(0);
    } finally {
      for (const store of stores.reverse()) store.close();
    }
  });
}
export function withProjectActivityFence<T>(
  directory: string | undefined,
  operation: (
    proof: ProjectActivityProof | null,
  ) => ProjectHistorySynchronousResult<T>,
  options: ProjectActivityOptions = {},
): T {
  return withProjectActivitiesFence(
    directory ? [directory] : [],
    (proofs) => operation(proofs[0] ?? null),
    options,
  );
}
export function projectActivityCapability() {
  return {
    version: 1 as const,
    queueAdmission: "project-history" as const,
    registryPath: openProjectRegistry().readonlyPath,
  };
}

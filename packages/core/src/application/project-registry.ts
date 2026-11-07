import type {
  ProjectRegistryEntry,
  ProjectRegistryLifecycleInput,
  ProjectRegistrySnapshot,
  RegisterProjectInput,
} from "../domain/project-registry";
import type { ProjectRegistryStore } from "../ports/project-registry";

export type ProjectRegistryPathState = "available" | "missing";

export interface ProjectRegistryProject extends ProjectRegistryEntry {
  readonly pathState: ProjectRegistryPathState;
}

/** Registry records stay visible when paths disappear; no disk discovery occurs. */
export function listRegisteredProjects(
  store: ProjectRegistryStore,
  pathExists: (path: string) => boolean,
): readonly ProjectRegistryProject[] {
  return store.read().projects.map((project) => ({
    ...project,
    pathState: pathExists(project.path) ? "available" : "missing",
  }));
}

export function registerProject(
  store: ProjectRegistryStore,
  input: RegisterProjectInput,
): ProjectRegistrySnapshot {
  if (
    !input.projectId.trim() ||
    input.projectId.length > 256 ||
    !input.databaseId.trim() ||
    !Number.isFinite(input.nowMs) ||
    input.nowMs < 0
  ) {
    throw new Error("Project registry identity or timestamp is invalid");
  }
  return store.register(input);
}

export function setRegisteredProjectLifecycle(
  store: ProjectRegistryStore,
  projectId: string,
  lifecycle: ProjectRegistryLifecycleInput,
): ProjectRegistrySnapshot {
  if (
    !projectId.trim() ||
    typeof lifecycle.monitoring !== "boolean" ||
    !Number.isFinite(lifecycle.nowMs) ||
    lifecycle.nowMs < 0 ||
    (lifecycle.archivedAtMs !== null &&
      (!Number.isFinite(lifecycle.archivedAtMs) ||
        lifecycle.archivedAtMs < 0)) ||
    (lifecycle.archivedAtMs !== null && lifecycle.monitoring)
  ) {
    throw new Error("Project registry lifecycle state is invalid");
  }
  return store.setLifecycle(projectId, lifecycle);
}

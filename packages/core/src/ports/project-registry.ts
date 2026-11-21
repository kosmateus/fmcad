import type {
  ProjectRegistryEntry,
  ProjectRegistryLifecycleInput,
  ProjectRegistrySnapshot,
  RegisterProjectInput,
} from "../domain/project-registry";

/** Explicit local catalog; implementations do not scan for projects. */
export interface ProjectRegistryStore {
  readonly readonlyPath: string;
  read(): ProjectRegistrySnapshot;
  lookup(projectId: string): ProjectRegistryEntry | null;
  /** Serialize project enrollment with synchronous activity admission. */
  withRegistrationFence?<T>(
    operation: (snapshot: ProjectRegistrySnapshot) => T,
  ): T;
  register(input: RegisterProjectInput): ProjectRegistrySnapshot;
  setLifecycle(
    projectId: string,
    lifecycle: ProjectRegistryLifecycleInput,
    expected?: ProjectRegistryEntry,
  ): ProjectRegistrySnapshot;
  moveProject(
    projectId: string,
    projectPath: string,
    databaseId: string,
    nowMs: number,
  ): ProjectRegistrySnapshot;
  acknowledgeDatabaseReset(
    projectId: string,
    databaseId: string,
    nowMs: number,
  ): ProjectRegistrySnapshot;
}

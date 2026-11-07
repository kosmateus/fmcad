export interface ProjectRegistryEntry {
  readonly projectId: string;
  readonly path: string;
  readonly databaseId: string;
  readonly monitoring: boolean;
  readonly archivedAtMs: number | null;
  readonly updatedAtMs: number;
  readonly lastResetAtMs: number | null;
}

export interface ProjectRegistrySnapshot {
  readonly version: 1;
  readonly revision: number;
  readonly projects: readonly ProjectRegistryEntry[];
}

export interface RegisterProjectInput {
  readonly projectId: string;
  readonly projectPath: string;
  readonly databaseId: string;
  readonly monitoring: boolean;
  readonly archivedAtMs: number | null;
  readonly nowMs: number;
}

export interface ProjectRegistryLifecycleInput {
  readonly monitoring: boolean;
  readonly archivedAtMs: number | null;
  readonly nowMs: number;
}

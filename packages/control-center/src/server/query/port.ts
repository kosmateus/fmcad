import type {
  ConsoleArtifactKind,
  ConsoleArtifactRequest,
  ConsoleArtifactState,
  ConsoleDataCollection,
  ConsoleQueryRecord,
  ConsoleQueryScope,
  ConsoleRevision,
  ConsoleSourceStatus,
} from "../../contracts/index.js";

export interface ConsoleArtifactStoreContext {
  clientId: string;
  requestId: string;
  sessionId: string | null;
  projectId: string;
  documentId: string;
  instanceId: string | null;
  purpose: string | null;
}

export interface ConsoleOwnedArtifactReference {
  projectId: string;
  taskId: string;
  artifactId: string;
  kind: ConsoleArtifactKind;
  /** Server-only retained binding captured with this snapshot; never sent to UI. */
  locator?: ConsoleArtifactLocator;
}

/** Immutable backing reference captured with the query snapshot. */
export type ConsoleArtifactLocator =
  | {
      type: "project-file";
      path: string;
      bytes?: number | null;
      sha256: string | null;
    }
  | {
      type: "owned-result";
      reference: {
        version: 1;
        jobId: string;
        scope: string;
        storage: "project" | "legacy";
        name: "stdout.txt" | "stderr.txt" | "rpc-result.json";
        bytes: number;
        sha256: string;
      };
    }
  | {
      type: "artifact-store";
      context: ConsoleArtifactStoreContext;
      sha256: string;
    }
  | { type: "inline-event"; content: string }
  | { type: "missing" | "expired" | "error" | "forbidden" };

/**
 * One immutable, already-retained read model at one scope-local epoch/revision.
 * A global read is a single authoritative view; callers must not sum project
 * snapshots or repeat host-wide observations for each project.
 */
export interface ConsoleQueryDataSnapshot {
  revision: ConsoleRevision;
  capturedAt: number;
  scope: ConsoleQueryScope;
  collections: Partial<
    Record<ConsoleDataCollection, readonly ConsoleQueryRecord[]>
  >;
  sources: Partial<Record<ConsoleDataCollection, ConsoleSourceStatus>>;
  artifacts?: readonly ConsoleOwnedArtifactReference[];
}

export interface ConsoleArtifactRead {
  state: ConsoleArtifactState;
  content: string | null;
  /** UTF-8 byte range, not JavaScript UTF-16 code units. */
  offset: number;
  length: number;
  totalLength: number | null;
  reason?: string;
}

/**
 * Adapter port only. Revisions are local to the exact requested scope; the
 * global registry supplies its own revision and must not reuse a project DB's
 * cursor. `readArtifact` resolves an exact retained artifact under its owned
 * project root, rejects traversal/symlinks, and bounds reads. No caller path.
 * Core query code does not resolve paths or import Node APIs.
 */
export interface ConsoleQueryReadPort {
  readSnapshot(scope: ConsoleQueryScope): Promise<ConsoleQueryDataSnapshot>;
  readArtifact(
    reference: ConsoleOwnedArtifactReference,
    request: ConsoleArtifactRequest,
  ): Promise<ConsoleArtifactRead>;
}

export interface ConsoleQueryApiOptions {
  now?: () => number;
  snapshotTtlMs?: number;
  maxSnapshots?: number;
  maxSnapshotBytes?: number;
  maxPageBytes?: number;
  maxPageSize?: number;
  maxArtifactRange?: number;
  maxSubscribers?: number;
  revisionHistory?: number;
  maxExportBytes?: number;
}

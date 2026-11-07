/** Serialized snapshots stay versioned by the queue domain, not the filesystem. */
export interface ExecutionSnapshotStore {
  restore(): string | null;
  commit(serialized: string): void;
}

export interface ExecutionRecordStore {
  write(file: string, value: unknown, exclusive?: boolean): void;
  read(file: string, maxBytes?: number): unknown;
}

export interface OwnedResultReference {
  version: 1;
  jobId: string;
  scope: string;
  storage: "project" | "legacy";
  name: "stdout.txt" | "stderr.txt" | "rpc-result.json";
  bytes: number;
  sha256: string;
}

export interface OwnedResultReader {
  read(reference: OwnedResultReference, maxBytes: number): Uint8Array;
}

export interface UniquePublisher {
  publish(target: string, contents: string | Uint8Array): Promise<void>;
}

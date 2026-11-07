import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  SaveBinding,
  SaveRecord,
  SaveRequest,
  SaveJournal,
  SaveEvidence,
} from "../../../core/src/application/documents/save";

export interface SaveJournalRecords {
  hash(value: unknown): string;
  read(directory: string, binding: SaveBinding): Promise<unknown[]>;
  write(
    directory: string,
    binding: SaveBinding,
    sequence: number,
    value: { operation: string; state: string; result: SaveEvidence },
  ): Promise<SaveRecord>;
}
export function documentSaveDirectory(
  data: SaveRequest,
  binding: SaveBinding,
  hash: SaveJournalRecords["hash"],
): string {
  return path.join(
    path.resolve(data.reportPath),
    "document-save",
    hash([binding.requestId, binding.operationId]),
  );
}
const code = (error: unknown): string | undefined =>
  error !== null && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
/** Existing immutable journal codec is injected; this adapter does not introduce another format. */
export async function openSaveJournal(
  data: SaveRequest,
  binding: SaveBinding,
  create: boolean,
  recordsPort: SaveJournalRecords,
  io: typeof fs = fs,
): Promise<SaveJournal> {
  const hash = recordsPort.hash;
  const directory = documentSaveDirectory(data, binding, hash);
  if (create) {
    await io.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await io.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(
        "document save receipt directory must be a real directory",
      );
  }
  const load = async (): Promise<{
    records: SaveRecord[];
    binding: SaveBinding;
  }> => {
    try {
      return {
        records: validate(await recordsPort.read(directory, binding)),
        binding,
      };
    } catch (error) {
      if (code(error) === "ENOENT") return { records: [], binding };
      if (
        !(error instanceof Error) ||
        !error.message.includes("Operation journal identity mismatch")
      )
        throw error;
      // Legacy display names participated in the old hash; never weaken the persisted binding.
      const first = JSON.parse(
        await io.readFile(path.join(directory, "00000000.json"), "utf8"),
      ) as {
        binding?: SaveBinding & {
          target: SaveBinding["target"] & { name?: string };
        };
      };
      const legacy = first.binding,
        target = legacy?.target;
      if (
        legacy?.operation !== "document.save.once" ||
        legacy.requestId !== binding.requestId ||
        legacy.operationId !== binding.operationId ||
        typeof target?.name !== "string" ||
        target.creationId !== binding.target.creationId ||
        target.fileId !== binding.target.fileId ||
        target.projectId !== binding.target.projectId ||
        target.version !== binding.target.version ||
        legacy.requestHash !==
          hash({
            requestId: legacy.requestId,
            operationId: legacy.operationId,
            target,
          })
      )
        throw error;
      return {
        records: validate(await recordsPort.read(directory, legacy)),
        binding: legacy,
      };
    }
  };
  const submitLock = path.join(directory, "submit.lock");
  return {
    load,
    async submissionExists() {
      try {
        await io.lstat(submitLock);
        return true;
      } catch (error) {
        if (code(error) === "ENOENT") return false;
        throw error;
      }
    },
    async acquireSubmission() {
      let lock;
      try {
        lock = await io.open(submitLock, "wx", 0o600);
      } catch (error) {
        if (code(error) === "EEXIST") return null;
        throw error;
      }
      return async () => {
        await lock.close();
        await io.unlink(submitLock).catch(() => {});
      };
    },
    async append(recordBinding, records, evidence) {
      const lockPath = path.join(directory, "journal.lock");
      let lock;
      try {
        lock = await io.open(lockPath, "wx", 0o600);
      } catch (error) {
        if (code(error) === "EEXIST")
          throw new Error(
            "document save receipt writer is active; observe the original request",
          );
        throw error;
      }
      try {
        const current = await load();
        if (current.records.length !== records.length)
          throw new Error(
            "document save receipt changed concurrently; do not resubmit",
          );
        records.push(
          await recordsPort.write(directory, recordBinding, records.length, {
            operation: "document.save.once",
            state: evidence.status,
            result: evidence,
          }),
        );
      } finally {
        await lock.close();
        await io.unlink(lockPath).catch(() => {});
      }
    },
  };
}
function validate(records: unknown[]): SaveRecord[] {
  const states = new Set([
    "submit_uncertain",
    "accepted",
    "pending",
    "complete",
    "failed",
    "blocked",
    "unknown",
    "noop",
  ]);
  for (const record of records) {
    const raw = record as {
      operation?: unknown;
      result?: { status?: unknown };
    };
    if (
      raw.operation !== "document.save.once" ||
      !raw.result ||
      typeof raw.result.status !== "string" ||
      !states.has(raw.result.status)
    )
      throw new Error(
        "document save receipt state is corrupt or belongs to another operation",
      );
  }
  // The operation owns this existing status check. The shared journal validates
  // only sequence and binding; it must not assert a document-save result type.
  return records as SaveRecord[];
}

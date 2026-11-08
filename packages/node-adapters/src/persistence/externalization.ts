import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type {
  ExternalizationRequest,
  ExternalizationStored,
  ExternalizationRecord,
  ExternalizationJournal,
  ExternalizationResult,
} from "../../../core/src/application/documents/externalization";

interface Binding {
  operation: string;
  operationId: string;
  requestHash: string;
  sessionNonce: string;
  source: unknown;
}
export interface ExternalizationRecords {
  hash(value: unknown): string;
  manifest(data: ExternalizationRequest): unknown;
  publish(target: string, content: string, io: typeof fs): Promise<unknown>;
  read(
    directory: string,
    binding: Binding,
    io: typeof fs,
  ): Promise<ExternalizationRecord[]>;
  write(
    directory: string,
    binding: Binding,
    sequence: number,
    value: { event: string; result: ExternalizationResult },
    io: typeof fs,
  ): Promise<ExternalizationRecord>;
}
const code = (error: unknown): string | undefined =>
  error !== null && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
export async function openExternalizationJournal(
  data: ExternalizationRequest,
  port: ExternalizationRecords,
  io: typeof fs = fs,
): Promise<ExternalizationJournal | null> {
  const immutable = port.manifest(data),
    requestHash = port.hash(immutable);
  const directory = path.join(path.resolve(data.reportPath), data.operationId),
    manifestPath = path.join(directory, "manifest.json");
  let stored: ExternalizationStored | undefined;
  try {
    stored = JSON.parse(
      await io.readFile(manifestPath, "utf8"),
    ) as ExternalizationStored;
  } catch (error) {
    if (code(error) !== "ENOENT") throw error;
    if (data.phase === "inspect") return null;
    await io.mkdir(directory, { recursive: true, mode: 0o700 });
  }
  if (stored) {
    if (
      stored.operationId !== data.operationId ||
      typeof stored.sessionNonce !== "string" ||
      stored.sessionNonce.length === 0
    )
      throw new Error(
        "Externalization manifest owner mismatch; outcome unknown",
      );
    if (
      stored.requestHash !== requestHash ||
      port.hash(stored.manifest) !== requestHash
    )
      throw new Error(
        "Immutable externalization manifest differs; no new operation/replay",
      );
  } else {
    if (data.resume || data.phase === "inspect")
      throw new Error("Existing immutable operation required");
    stored = {
      manifest: immutable,
      requestHash,
      operationId: data.operationId,
      sessionNonce: randomBytes(16).toString("hex"),
      copyProtocol: 1,
    };
    await port.publish(manifestPath, JSON.stringify(stored) + "\n", io);
  }
  const binding: Binding = {
    operation: "component.externalize",
    operationId: data.operationId,
    requestHash,
    sessionNonce: stored.sessionNonce,
    source: data.source,
  };
  const records = await port.read(directory, binding, io);
  for (const record of records) {
    if (
      record.result?.operationId !== data.operationId ||
      record.result.operation !== "component.externalize" ||
      record.result.schemaVersion !== 1
    )
      throw new Error("Externalization result owner mismatch; outcome unknown");
  }
  let sequence = records.length;
  const lockPath = path.join(directory, "run.lock");
  return {
    stored,
    records,
    async writerActive() {
      try {
        await io.lstat(lockPath);
        return true;
      } catch (error) {
        if (code(error) === "ENOENT") return false;
        throw error;
      }
    },
    async acquire() {
      let lock;
      try {
        lock = await io.open(lockPath, "wx", 0o600);
      } catch (error) {
        if (code(error) === "EEXIST") return null;
        throw error;
      }
      // The caller derived its continuation before acquiring this lock. A
      // writer may have settled in between; stale evidence is not authority
      // to repeat its mutation. Require a fresh invocation to read that result.
      try {
        const current = await port.read(directory, binding, io);
        const manifest = JSON.parse(
          await io.readFile(manifestPath, "utf8"),
        ) as unknown;
        if (
          port.hash(current) !== port.hash(records) ||
          port.hash(manifest) !== port.hash(stored)
        )
          throw new Error(
            "Externalization evidence changed before admission; inspect, do not replay",
          );
      } catch (original) {
        try {
          await lock.close();
          await io.unlink(lockPath);
        } catch (cleanup) {
          throw new AggregateError(
            [original, cleanup],
            "Externalization admission and lock cleanup failed",
            { cause: original },
          );
        }
        throw original;
      }
      return async () => {
        await lock.close();
        await io.unlink(lockPath).catch(() => {});
      };
    },
    async persist(event, result) {
      const record = await port.write(
        directory,
        binding,
        sequence++,
        { event, result },
        io,
      );
      records.push(record);
    },
  };
}

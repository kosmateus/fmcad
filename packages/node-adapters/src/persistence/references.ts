import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type {
  ReferenceInput,
  ReferencePlan,
  ReferenceReport,
} from "../../../core/src/application/documents/references";
import type { ReferenceApplyPlan } from "../../../core/src/application/documents/references-apply";

interface Identity {
  runId: string;
  requestHash: string;
  commandId: string;
  backend: string;
  sessionNonce: string;
  documentIdentity: { expected: unknown; resolved: unknown };
}
export interface Receipt extends Record<string, unknown> {
  version: number;
  operation: string;
  sequence: number;
  requestId: string;
  runId: string;
  requestHash: string;
  commandId: string;
  sessionNonce: string;
  documentIdentity: unknown;
  result?: ReferenceReport;
  invocationStatus?: string;
  inProgress?: unknown;
}
interface ReferenceStorage {
  hash(value: unknown): string;
  publish(target: string, value: string, io: typeof fs): Promise<unknown>;
}
const code = (error: unknown): string | undefined =>
  error !== null && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Retains the shipped immutable JSON formats; no new receipt or plan database. */
export function referenceStore(port: ReferenceStorage) {
  function requestIdentity(
    input: ReferenceInput,
    requestHash: string,
    backend?: string | null,
  ): Identity {
    return {
      runId: input.requestId,
      requestHash,
      commandId: "fmcad_references_" + randomBytes(16).toString("hex"),
      backend: backend ?? "unknown",
      sessionNonce: randomBytes(16).toString("hex"),
      documentIdentity: {
        expected: {
          projectId: input.root.projectId,
          fileId: input.root.fileId,
          version: input.root.version,
        },
        resolved: null,
      },
    };
  }
  async function writeRequestRecord(
    root: string,
    requestId: string,
    identity: Identity,
    sequence: number,
    value: Record<string, unknown>,
    io = fs,
  ): Promise<Receipt> {
    const directory = path.join(root, "requests", requestId);
    await io.mkdir(directory, { recursive: true, mode: 0o700 });
    const target = path.join(
      directory,
      String(sequence).padStart(8, "0") + ".json",
    );
    const record: Receipt = {
      version: 1,
      operation: "references.refresh",
      sequence,
      requestId,
      runId: identity.runId,
      requestHash: identity.requestHash,
      commandId: identity.commandId,
      backend: identity.backend,
      sessionNonce: identity.sessionNonce,
      documentIdentity: clone(identity.documentIdentity),
      at: new Date().toISOString(),
      ...clone(value),
    };
    await port.publish(target, JSON.stringify(record, null, 2) + "\n", io);
    return record;
  }
  async function loadJournal(
    root: string,
    requestId: string,
    io = fs,
  ): Promise<{
    dir: string;
    records: Receipt[];
    report?: Receipt;
    writerActive?: boolean;
  }> {
    const dir = path.join(root, "requests", requestId);
    let names: string[];
    try {
      names = (await io.readdir(dir))
        .filter((name) => /^\d{8}\.json$/.test(name))
        .sort();
    } catch (error) {
      if (code(error) === "ENOENT") return { dir, records: [] };
      throw error;
    }
    const records: Receipt[] = [];
    for (let index = 0; index < names.length; index++) {
      const expected = String(index).padStart(8, "0") + ".json";
      if (names[index] !== expected)
        throw new Error(
          "Reference request journal has a sequence gap; inspect, do not replay",
        );
      const record = JSON.parse(
        await io.readFile(path.join(dir, expected), "utf8"),
      ) as Receipt;
      if (
        record.version !== 1 ||
        record.operation !== "references.refresh" ||
        record.requestId !== requestId ||
        record.sequence !== index
      )
        throw new Error(
          "Reference request journal identity/sequence mismatch; outcome unknown",
        );
      const first = records[0];
      if (
        first &&
        (record.requestHash !== first.requestHash ||
          record.commandId !== first.commandId ||
          record.sessionNonce !== first.sessionNonce ||
          port.hash(record.documentIdentity) !==
            port.hash(first.documentIdentity))
      )
        throw new Error("Reference journal identity changed; outcome unknown");
      records.push(record);
    }
    let writerActive = false;
    try {
      await io.lstat(path.join(dir, "run.lock"));
      writerActive = true;
    } catch (error) {
      if (code(error) !== "ENOENT") throw error;
    }
    const report = records.at(-1);
    return { dir, records, ...(report ? { report } : {}), writerActive };
  }
  async function writePlan(
    root: string,
    plan: ReferencePlan,
    io = fs,
  ): Promise<string> {
    const planId = port.hash(plan),
      directory = path.join(root, "plans");
    await io.mkdir(directory, { recursive: true, mode: 0o700 });
    const target = path.join(directory, `${planId}.json`);
    try {
      await port.publish(
        target,
        JSON.stringify({ ...plan, planId }, null, 2) + "\n",
        io,
      );
    } catch (error) {
      if (code(error) !== "EEXIST") throw error;
      const existing = JSON.parse(await io.readFile(target, "utf8")) as Record<
        string,
        unknown
      >;
      if (
        existing["planId"] !== planId ||
        port.hash(
          Object.fromEntries(
            Object.entries(existing).filter(([key]) => key !== "planId"),
          ),
        ) !== planId
      )
        throw new Error(
          "Immutable planId collision or corrupted existing plan",
        );
    }
    return planId;
  }
  async function readPlan(
    root: string,
    planId: string,
    io = fs,
  ): Promise<ReferencePlan> {
    const plan = JSON.parse(
      await io.readFile(path.join(root, "plans", `${planId}.json`), "utf8"),
    ) as ReferencePlan & { planId: string };
    const { planId: stored, ...content } = plan;
    if (stored !== planId || port.hash(content) !== planId)
      throw new Error("Immutable reference plan checksum mismatch");
    return content;
  }
  async function acquire(
    input: ReferenceInput,
    plan: ReferenceApplyPlan,
    requestHash: string,
    backend?: string | null,
    io = fs,
  ) {
    const rootPath = path.resolve(input.reportPath),
      identity = requestIdentity(input, requestHash, backend);
    const root = plan.documents.find((doc) => doc.fileId === plan.root.fileId);
    identity.documentIdentity.resolved = root
      ? {
          projectId: root.projectId,
          fileId: root.fileId,
          version: root.version,
          creationId: root["creationId"] ?? null,
        }
      : null;
    const directory = path.join(rootPath, "requests", input.requestId),
      lockPath = path.join(directory, "run.lock");
    await io.mkdir(directory, { recursive: true, mode: 0o700 });
    let lock;
    try {
      lock = await io.open(lockPath, "wx", 0o600);
    } catch (error) {
      if (code(error) === "EEXIST") return null;
      throw error;
    }
    let sequence = 0;
    return {
      append: async (value: Record<string, unknown>) => {
        await writeRequestRecord(
          rootPath,
          input.requestId,
          identity,
          sequence++,
          value,
          io,
        );
      },
      release: async () => {
        await lock.close();
        await io.unlink(lockPath).catch(() => {});
      },
    };
  }
  async function acquireRead(
    input: ReferenceInput,
    requestHash: string,
    result: ReferenceReport,
    backend?: string | null,
    io = fs,
  ) {
    const rootPath = path.resolve(input.reportPath),
      directory = path.join(rootPath, "requests", input.requestId),
      lockPath = path.join(directory, "run.lock");
    await io.mkdir(directory, { recursive: true, mode: 0o700 });
    let lock;
    try {
      lock = await io.open(lockPath, "wx", 0o600);
    } catch (error) {
      if (code(error) === "EEXIST")
        throw new Error(
          "request journal writer exists; inspect before retrying",
        );
      throw error;
    }
    const identity = requestIdentity(input, requestHash, backend),
      documents = result["documents"] as Record<string, unknown>[] | undefined;
    const root = documents?.find((doc) => doc["fileId"] === input.root.fileId);
    if (root)
      identity.documentIdentity.resolved = {
        projectId: root["projectId"],
        fileId: root["fileId"],
        version: root["version"],
        creationId: root["creationId"] ?? null,
      };
    return {
      append: async (value: Record<string, unknown>) => {
        await writeRequestRecord(
          rootPath,
          input.requestId,
          identity,
          0,
          value,
          io,
        );
      },
      release: async () => {
        await lock.close();
        await io.unlink(lockPath).catch(() => {});
      },
    };
  }
  return {
    requestIdentity,
    writeRequestRecord,
    loadJournal,
    writePlan,
    readPlan,
    acquire,
    acquireRead,
  };
}

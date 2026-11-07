import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type {
  StageEntry,
  StageJournalPort,
  StageScope,
  StageEvidencePort,
} from "../../../core/src/application/stage-journal";
import { durable, readBytes } from "./records";
import { regularDirectory } from "./owned-results";
import { readAdmission, readAcceptedInput } from "./accepted-inputs";

/** Additive evidence beside existing operation receipts. No ownership store. */
export function openStageJournal(
  operationDirectory: string,
  scope: StageScope,
  validate: (entries: StageEntry[], scope: StageScope) => void,
  limits: {
    readonly maxEntries?: number;
    readonly maxDirectoryEntries?: number;
    readonly maxEntryBytes?: number;
    readonly maxTotalBytes?: number;
  } = {},
): StageJournalPort {
  const maxEntries = limits.maxEntries ?? 10_000;
  const maxDirectoryEntries = limits.maxDirectoryEntries ?? maxEntries + 16;
  const maxEntryBytes = limits.maxEntryBytes ?? 16 * 1024 * 1024;
  const maxTotalBytes = limits.maxTotalBytes ?? 64 * 1024 * 1024;
  if (
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 1 ||
    maxEntries > 10_000 ||
    !Number.isSafeInteger(maxDirectoryEntries) ||
    maxDirectoryEntries < maxEntries ||
    maxDirectoryEntries > 10_016 ||
    !Number.isSafeInteger(maxEntryBytes) ||
    maxEntryBytes < 1 ||
    maxEntryBytes > 16 * 1024 * 1024 ||
    !Number.isSafeInteger(maxTotalBytes) ||
    maxTotalBytes < maxEntryBytes ||
    maxTotalBytes > 64 * 1024 * 1024
  )
    throw new Error("Stage journal bounds are invalid");
  let fault = false;
  const directory = () => regularDirectory(operationDirectory, ["stages"]);
  const read = (): StageEntry[] => {
    let dir: string;
    try {
      dir = directory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const names: string[] = [];
    const listing = fs.opendirSync(dir);
    let scanned = 0;
    try {
      for (
        let entry = listing.readSync();
        entry !== null;
        entry = listing.readSync()
      ) {
        scanned++;
        if (scanned > maxDirectoryEntries)
          throw Object.assign(
            new Error("Stage journal directory entry limit exceeded"),
            {
              code: "STAGE_JOURNAL_BOUND_EXCEEDED",
            },
          );
        if (/^\d{8}\.json$/.test(entry.name)) {
          if (names.length >= maxEntries)
            throw Object.assign(
              new Error("Stage journal entry limit exceeded"),
              {
                code: "STAGE_JOURNAL_BOUND_EXCEEDED",
              },
            );
          names.push(entry.name);
        }
      }
    } finally {
      listing.closeSync();
    }
    names.sort();
    let totalBytes = 0;
    const entries = names.map((name, index) => {
      if (name !== `${String(index).padStart(8, "0")}.json`) {
        const actual = Number(name.slice(0, 8));
        throw Object.assign(new Error("Stage journal sequence gap"), {
          code: "STAGE_JOURNAL_SEQUENCE_GAP",
          fromPosition: index,
          toPosition: Number.isSafeInteger(actual) ? actual - 1 : index,
        });
      }
      const file = path.join(dir, name);
      const bytes = readBytes(file, maxEntryBytes, fs, file);
      totalBytes += bytes.length;
      if (totalBytes > maxTotalBytes)
        throw Object.assign(new Error("Stage journal byte limit exceeded"), {
          code: "STAGE_JOURNAL_BOUND_EXCEEDED",
        });
      try {
        return JSON.parse(bytes.toString("utf8")) as StageEntry;
      } catch {
        throw Object.assign(new Error("Stage journal record is corrupt"), {
          code: "STAGE_JOURNAL_CORRUPT",
        });
      }
    });
    validate(entries, scope);
    return entries;
  };
  return {
    read,
    append(entry) {
      if (fault)
        throw new Error(
          "Stage durability uncertain; reopen and inspect, never resend",
        );
      const entries = read();
      validate([...entries, entry], scope);
      if (entry.sequence >= maxEntries)
        throw new Error("Stage journal limit exceeded");
      const dir = regularDirectory(operationDirectory, ["stages"], true);
      try {
        durable(
          path.join(dir, `${String(entry.sequence).padStart(8, "0")}.json`),
          entry,
          true,
        );
      } catch (error) {
        fault = true;
        throw error;
      }
    },
  };
}

/** Digest the owner's immutable receipt binding (known before dispatch), not
 * future receipt contents. The owner resolves it in its existing receipt store. */
export function stageReceiptReference(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
export function stageEvidence(
  brokerDirectory: string,
  receipt: StageEvidencePort["receipt"],
): StageEvidencePort {
  return {
    accepted(scope) {
      const admission = readAdmission(brokerDirectory, scope);
      if (admission.status !== "available") return "missing";
      if (admission.inputIdentity !== scope.inputIdentity)
        throw new Error("Foreign accepted-input identity");
      if (!admission.inputs.length) return "missing";
      return admission.inputs.every(
        (input) =>
          readAcceptedInput(brokerDirectory, input).status === "available",
      )
        ? "available"
        : "missing";
    },
    receipt(scope, stage, reference) {
      if (!/^[a-f0-9]{64}$/.test(reference)) return { status: "corrupt" };
      return receipt(scope, stage, reference);
    },
  };
}

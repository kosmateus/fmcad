import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import {
  formatJsonError,
  validateBatchReport,
  summarizeBatchReport,
  type BatchJournal,
  type BatchReport,
  type CadData,
} from "@fmcad/core";
import { publishComplete } from "./publish.js";
import { readBytes } from "./records.js";

export async function openBatchJournal(
  reportPath: string,
): Promise<BatchJournal> {
  await fs.mkdir(reportPath, { recursive: true });
  const lockPath = path.join(reportPath, "run.lock");
  const lock = await fs.open(lockPath, "wx", 0o600).catch((error: unknown) => {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "EEXIST"
    )
      throw new Error(
        "Run is locked; inspect operator/model state before removing a stale lock",
      );
    throw error;
  });
  return {
    latest: async () => {
      const files = (await fs.readdir(reportPath))
        .filter((name) => /^\d{8}\.json$/.test(name))
        .sort();
      if (!files.length) return undefined;
      if (
        files.some(
          (name, index) => name !== `${String(index).padStart(8, "0")}.json`,
        )
      )
        throw new Error(
          "Incomplete report history; operator inspection required",
        );
      return JSON.parse(
        await fs.readFile(path.join(reportPath, files.at(-1)!), "utf8"),
      ) as BatchReport;
    },
    assertEmpty: async () => {
      if ((await fs.readdir(reportPath)).some((name) => name !== "run.lock"))
        throw new Error(
          "Unrecognized report files; operator inspection required",
        );
    },
    publish: (report) =>
      publishComplete(
        path.join(
          reportPath,
          `${String(report.sequence).padStart(8, "0")}.json`,
        ),
        JSON.stringify(report, null, 2) + "\n",
      ),
    close: async (preserveLock) => {
      await lock.close();
      if (!preserveLock) await fs.unlink(lockPath);
    },
  };
}
export async function readBatchSummary(data: CadData) {
  if (typeof data["reportPath"] !== "string" || !data["reportPath"].trim())
    throw new Error("reportPath must be a nonempty directory path");
  const step = data["step"];
  if (
    step !== undefined &&
    (typeof step !== "number" || !Number.isSafeInteger(step) || step < 1)
  )
    throw new Error("step must be a 1-based positive integer");
  const reportPath = path.resolve(data["reportPath"]);
  const files = (await fs.readdir(reportPath))
    .filter((name) => /^\d{8}\.json$/.test(name))
    .sort();
  if (!files.length) throw new Error("Missing numbered batch report");
  if (
    files.some(
      (name, index) => name !== `${String(index).padStart(8, "0")}.json`,
    )
  )
    throw new Error("Incomplete report history; operator inspection required");
  let report: BatchReport;
  try {
    report = validateBatchReport(
      JSON.parse(
        await fs.readFile(path.join(reportPath, files.at(-1)!), "utf8"),
      ) as unknown,
      files.length,
      "Invalid version-1 report schema or request/context hash",
    );
  } catch (error) {
    throw new Error(
      `Corrupt batch report ${files.at(-1)}: ${error instanceof SyntaxError ? formatJsonError(error) : error instanceof Error ? error.message : String(error)}`,
    );
  }
  const summary = summarizeBatchReport({ ...report, reportPath });
  if (step !== undefined) {
    if (step > summary.steps.length)
      throw new Error(`step out of range: expected 1..${summary.steps.length}`);
    summary.steps = [summary.steps[step - 1]!];
  }
  return summary;
}
export function readBatchReportSync(reportPath: string): {
  report: BatchReport;
  bytes: Buffer;
} {
  if (typeof reportPath !== "string" || !reportPath.trim())
    throw new Error("reportPath must be a nonempty directory path");
  reportPath = path.resolve(reportPath);
  if (fsSync.realpathSync(reportPath) !== reportPath)
    throw new Error("Batch report directory is not canonical");
  const files = fsSync
    .readdirSync(reportPath)
    .filter((name) => /^\d{8}\.json$/.test(name))
    .sort();
  if (
    !files.length ||
    files.some(
      (name, index) => name !== `${String(index).padStart(8, "0")}.json`,
    )
  )
    throw new Error("Missing or incomplete numbered batch report");
  const file = path.join(reportPath, files.at(-1)!);
  const bytes = readBytes(file, 16 * 1024 * 1024, fsSync, file);
  let report: BatchReport;
  try {
    report = validateBatchReport(
      JSON.parse(bytes.toString("utf8")) as unknown,
      files.length,
      "Invalid batch report schema or request/context hash",
    );
  } catch (error) {
    throw new Error(
      `Corrupt batch report ${files.at(-1)}: ${error instanceof SyntaxError ? formatJsonError(error) : error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { report, bytes };
}

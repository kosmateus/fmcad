import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { runtimeRequire, runtimeRoot, isRecord } from "./runtime.js";
import { checkedPath, stagedFiles } from "./install-queue-phases.js";

interface QueueInstanceModule {
  buildHash(root?: string): string;
  durable(file: string, value: unknown, exclusive?: boolean): void;
  readJson(file: string): unknown;
}

interface ReportFile {
  path: string;
  sha256: string;
}

interface VerificationReport extends Record<string, unknown> {
  verified: boolean;
  testExitCode: number;
  counts: {
    fail: number;
    pass: number;
    tests: number;
    cancelled: number;
    skipped: number;
  };
  runtime: string;
  afterBuildHash: string;
  runtimeFiles: ReportFile[];
  testFiles: ReportFile[];
  validationScope: string;
}

interface PythonVerification extends Record<string, unknown> {
  verified: boolean;
  runtime: string;
  afterBuildHash: string;
  tests: number;
  validationScope: string;
}

interface ExportOptions {
  verification: string;
  archive: string;
  pythonVerification?: string;
}

interface ExportDependencies {
  projectRoot?: string;
  destinationRoot?: string;
  now?: () => Date;
  createId?: () => string;
  buildHash?: (root: string) => string;
}

const { buildHash, durable, readJson } = runtimeRequire(
  "../../src/queue-instance.js",
) as QueueInstanceModule;

export function exportQueuePhases(
  options: ExportOptions,
  dependencies: ExportDependencies = {},
): Record<string, unknown> {
  const projectRoot = dependencies.projectRoot ?? runtimeRoot;
  const destinationRoot = dependencies.destinationRoot ?? projectRoot;
  const now = dependencies.now ?? (() => new Date());
  const createId = dependencies.createId ?? randomUUID;
  const currentBuildHash = dependencies.buildHash ?? buildHash;
  const report = asVerificationReport(readJson(options.verification));
  if (
    !report.verified ||
    report.testExitCode !== 0 ||
    report.counts.fail !== 0 ||
    report.counts.tests < 1 ||
    report.counts.pass !== report.counts.tests ||
    report.counts.cancelled !== 0 ||
    report.counts.skipped !== 0 ||
    currentBuildHash(report.runtime) !== report.afterBuildHash
  ) {
    throw new Error("Runtime no longer matches the passing verification");
  }
  const python = options.pythonVerification
    ? asPythonVerification(readJson(options.pythonVerification))
    : null;
  if (
    python &&
    (!python.verified ||
      python.runtime !== report.runtime ||
      python.afterBuildHash !== report.afterBuildHash)
  ) {
    throw new Error("Python verification does not match this candidate");
  }
  const destination = path.join(
    destinationRoot,
    "tmp",
    `queue-phases-candidate-${now().toISOString().replace(/[:.]/g, "-")}-${createId()}`,
  );
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const hashes: ReportFile[] = [];
  for (const item of [...report.runtimeFiles, ...report.testFiles]) {
    const bytes = fs.readFileSync(checkedPath(report.runtime, item.path));
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== item.sha256)
      throw new Error(`Verified source changed: ${item.path}`);
    const file = checkedPath(path.join(destination, "files"), item.path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
    hashes.push(item);
  }
  const copies: Array<[string, string]> = [
    [options.archive, "baseline.tgz"],
    [options.verification, "verification.json"],
    [
      path.join(projectRoot, "scripts/install-queue-phases.js"),
      "scripts/install-queue-phases.js",
    ],
    [
      path.join(projectRoot, "scripts/verify-queue-phases.js"),
      "scripts/verify-queue-phases.js",
    ],
    [
      path.join(projectRoot, "scripts/verify-queue-phases-python.py"),
      "scripts/verify-queue-phases-python.py",
    ],
    [
      path.join(projectRoot, "docs/QUEUE_PHASES_20261020.md"),
      "docs/QUEUE_PHASES_20261020.md",
    ],
  ];
  // The public launchers import compiled devtools and their runtime helper.
  // Export those exact local dependencies alongside the launchers.
  for (const relative of stagedFiles(projectRoot, ["dist/scripts"]))
    copies.push([checkedPath(projectRoot, relative), relative]);
  for (const [source, name] of copies) {
    const target = path.join(destination, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  }
  if (options.pythonVerification) {
    fs.copyFileSync(
      options.pythonVerification,
      path.join(destination, "python-verification.json"),
      fs.constants.COPYFILE_EXCL,
    );
  }
  const manifest = {
    state: "verified_candidate_not_installed",
    path: destination,
    files: hashes,
    verifiedBuildHash: report.afterBuildHash,
    passedTests: report.counts.pass,
    validationScope: report.validationScope,
    fusionCalls: 0,
    ...(python
      ? {
          passedPythonTests: python.tests,
          pythonValidationScope: python.validationScope,
        }
      : {}),
    installCommand: [
      "node",
      path.join(projectRoot, "scripts/install-queue-phases.js"),
      "--stage",
      path.join(destination, "files"),
      "--archive",
      path.join(destination, "baseline.tgz"),
      "--apply",
    ],
  };
  durable(path.join(destination, "candidate.json"), manifest, true);
  return manifest;
}

export function parseArguments(args: string[]): ExportOptions {
  const options: Partial<ExportOptions> = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const argumentValue = args[index + 1];
    if (
      (arg !== "--verification" &&
        arg !== "--archive" &&
        arg !== "--python-verification") ||
      !argumentValue
    ) {
      throw new Error(
        "Use --verification REPORT --archive BASELINE_TGZ [--python-verification REPORT]",
      );
    }
    const key = arg.slice(2);
    index++;
    const value = path.resolve(argumentValue);
    if (key === "verification") options.verification = value;
    else if (key === "archive") options.archive = value;
    else options.pythonVerification = value;
  }
  return options as ExportOptions;
}

export function main(args: string[]): void {
  const manifest = exportQueuePhases(parseArguments(args));
  console.log(JSON.stringify(manifest, null, 2));
}

function asVerificationReport(value: unknown): VerificationReport {
  if (
    !isRecord(value) ||
    !isRecord(value["counts"]) ||
    !Array.isArray(value["runtimeFiles"]) ||
    !Array.isArray(value["testFiles"])
  ) {
    throw new TypeError("Invalid verification report");
  }
  return value as VerificationReport;
}

function asPythonVerification(value: unknown): PythonVerification {
  if (!isRecord(value))
    throw new TypeError("Invalid Python verification report");
  return value as PythonVerification;
}

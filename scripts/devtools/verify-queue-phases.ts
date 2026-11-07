import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { runtimeRequire, runtimeRoot } from "./runtime.js";

interface QueueInstanceModule {
  buildHash(root?: string): string;
  durable(file: string, value: unknown, exclusive?: boolean): void;
}

interface InstallerModule {
  RUNTIME_FILES: string[];
  TEST_FILES: string[];
}

interface VerifyDependencies {
  installedRoot?: string;
  outputDirectory?: string;
  stateDirectory?: string;
  now?: () => Date;
  createId?: () => string;
  buildHash?: (root: string) => string;
  spawn?: (
    args: string[],
    options: {
      cwd: string;
      timeout: number;
      maxBuffer: number;
      env: NodeJS.ProcessEnv;
    },
  ) => SpawnSyncReturns<string>;
}

const { buildHash, durable } = runtimeRequire(
  "../../src/queue-instance.js",
) as QueueInstanceModule;
const { RUNTIME_FILES, TEST_FILES } = runtimeRequire(
  "./install-queue-phases.js",
) as InstallerModule;

export interface FileHash {
  path: string;
  sha256: string;
}

export function executableFiles(runtime: string): FileHash[] {
  const rows: FileHash[] = [];
  const visit = (relative: string): void => {
    const file = path.join(runtime, relative);
    const stat = fs.lstatSync(file);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort())
        visit(path.join(relative, name));
    } else if (stat.isFile()) {
      rows.push({
        path: relative,
        sha256: createHash("sha256")
          .update(fs.readFileSync(file))
          .digest("hex"),
      });
    } else {
      throw new Error(`Unexpected executable file type: ${relative}`);
    }
  };
  for (const entry of ["package.json", "bin", "src", "assets"]) visit(entry);
  return rows;
}

export function parseTestCounts(text: string): Record<string, number | null> {
  const count = (key: string): number | null => {
    const match = text.match(new RegExp(`^.*?\\b${key} (\\d+)\\s*$`, "m"));
    return match ? Number(match[1]) : null;
  };
  return Object.fromEntries(
    ["tests", "pass", "fail", "cancelled", "skipped"].map((key) => [
      key,
      count(key),
    ]),
  );
}

export function verifyQueuePhases(
  options: { runtime: string },
  dependencies: VerifyDependencies = {},
): Record<string, unknown> {
  const installed = dependencies.installedRoot ?? runtimeRoot;
  const now = dependencies.now ?? (() => new Date());
  const createId = dependencies.createId ?? randomUUID;
  const currentBuildHash = dependencies.buildHash ?? buildHash;
  const startedAt = now().toISOString();
  const output =
    dependencies.outputDirectory ??
    path.join(
      installed,
      ".cad",
      "evidence",
      "console-bvv",
      `${startedAt.replace(/[:.]/g, "-")}-${createId()}`,
    );
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  const state =
    dependencies.stateDirectory ??
    fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-verify-"));
  const executableBefore = executableFiles(options.runtime);
  const before = currentBuildHash(options.runtime);
  const args = ["--test", "--test-reporter=spec", ...TEST_FILES];
  const result = (
    dependencies.spawn ??
    ((spawnArgs, spawnOptions) =>
      spawnSync(process.execPath, spawnArgs, {
        ...spawnOptions,
        encoding: "utf8",
      }))
  )(args, {
    cwd: options.runtime,
    timeout: 180000,
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      FORCE_COLOR: "0",
      XDG_STATE_HOME: state,
      FMCAD_UPSTREAM_TEST_ROOT: installed,
    },
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  fs.writeFileSync(path.join(output, "node.stdout.log"), stdout, {
    flag: "wx",
    mode: 0o600,
  });
  fs.writeFileSync(path.join(output, "node.stderr.log"), stderr, {
    flag: "wx",
    mode: 0o600,
  });
  const text = stdout.replace(/\x1b\[[0-9;]*m/g, "");
  const counts = parseTestCounts(text);
  const after = currentBuildHash(options.runtime);
  const sha = (file: string): string =>
    createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const report = {
    startedAt,
    endedAt: now().toISOString(),
    runtime: options.runtime,
    installedRuntimeTested: options.runtime === installed,
    nodeVersion: process.version,
    command: [process.execPath, ...args],
    testExitCode: result.status,
    signal: result.signal,
    error: result.error
      ? { code: errorCode(result.error), message: result.error.message }
      : null,
    counts,
    verified:
      result.status === 0 &&
      counts.fail === 0 &&
      counts.tests !== null &&
      before === after,
    beforeBuildHash: before,
    afterBuildHash: after,
    executableFiles: executableBefore,
    runtimeFiles: RUNTIME_FILES.map((file) => ({
      path: file,
      sha256: sha(path.join(options.runtime, file)),
    })),
    testFiles: TEST_FILES.map((file) => ({
      path: file,
      sha256: sha(path.join(options.runtime, file)),
    })),
    installerSha256: sha(
      path.join(installed, "scripts/install-queue-phases.js"),
    ),
    originalDependencyLockSha256: sha(
      path.join(installed, "package-lock.json"),
    ),
    validationScope:
      "Controlled fake SDK, real local CLI workers and private broker IPC; no live Autodesk/Fusion operations or product validation.",
    fusionCalls: 0,
    offlineStateDirectory: state,
    output,
  };
  durable(path.join(output, "verification.json"), report, true);
  return { ...report, executableFiles: report.executableFiles.length };
}

export function main(args: string[]): void {
  const options: { runtime: string } = { runtime: runtimeRoot };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg !== "--runtime" || !value) throw new Error("Use --runtime PATH");
    index++;
    options.runtime = fs.realpathSync(value);
  }
  const report = verifyQueuePhases(options);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.verified ? 0 : 1;
}

function errorCode(error: Error): string | undefined {
  if (!("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

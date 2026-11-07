import fs from "node:fs";
import { runtimeRequire } from "./runtime.js";

interface MigrationFile {
  bytes: number;
}

interface MigrationResult {
  project: string;
  applied: boolean;
  files: MigrationFile[];
  skippedNonterminal: number;
}

interface ResponseMigrationModule {
  migrateProjectResponses(options: {
    dir: string;
    project: string;
    apply?: boolean;
  }): MigrationResult;
}

interface QueueConnectionModule {
  queueDirectory(): string;
}

const { queueDirectory } = runtimeRequire(
  "../../src/queue-connection.js",
) as QueueConnectionModule;
const { migrateProjectResponses } = runtimeRequire(
  "../../src/queue-response-migration.js",
) as ResponseMigrationModule;

interface Options {
  project?: string;
  dir: string;
  apply: boolean;
  report?: string;
}

export function migrateResponses(
  args: string[],
  defaultDirectory = queueDirectory(),
): Record<string, unknown> {
  const options: Options = { dir: defaultDirectory, apply: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--apply") options.apply = true;
    else if (
      (arg === "--project" || arg === "--queue-dir" || arg === "--report") &&
      args[index + 1]
    ) {
      const key = arg;
      const value = args[++index];
      if (typeof value !== "string") throw new Error("Missing option value");
      if (key === "--report") options.report = value;
      else if (key === "--project") options.project = value;
      else options.dir = value;
    } else {
      throw new Error(
        "Usage: node scripts/migrate-project-responses.js --project PATH [--apply] [--queue-dir PATH] [--report PATH]",
      );
    }
  }
  if (!options.project) throw new Error("--project is required");
  const result = migrateProjectResponses({
    dir: options.dir,
    project: options.project,
    apply: options.apply,
  });
  if (options.report)
    fs.writeFileSync(options.report, JSON.stringify(result, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
  return {
    project: result.project,
    applied: result.applied,
    files: result.files.length,
    bytes: result.files.reduce((sum, file) => sum + file.bytes, 0),
    skippedNonterminal: result.skippedNonterminal,
    report: options.report,
  };
}

export function main(args: string[]): void {
  try {
    const output = migrateResponses(args);
    console.log(JSON.stringify(output, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

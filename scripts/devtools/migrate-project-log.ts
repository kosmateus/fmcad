import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { runtimeRequire } from "./runtime.js";

interface LoggerModule {
  workspaceLog(cwd: string, config: unknown): string | null;
  locations(): unknown;
}

interface MigrationOutput {
  file: string;
  hour: string;
  content: string;
}

interface MigrationManifest {
  source: string;
  sha256: string;
  lines: number;
  outputs: Array<{ file: string; hour: string; sha256: string }>;
}

const { workspaceLog, locations } = runtimeRequire(
  "../../src/opencode/project-logger.cjs",
) as LoggerModule;
const digest = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

export function migrate(root: string): MigrationManifest {
  const project = path.resolve(root);
  const current = workspaceLog(project, locations());
  if (!current)
    throw new Error("An existing explicit project directory is required");
  const source = path.join(project, "fmcad.log");
  const fd = fs.openSync(
    source,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  let text: string;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1)
      throw new Error("Source must be a regular unlinked log");
    text = fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
  const hours = new Map<string, string>();
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const hour = line.match(/^(\d{4}-\d\d-\d\dT\d\d):/)?.[1];
    if (!hour)
      throw new Error(
        "Source contains an unrecognized log timestamp; no migration performed",
      );
    hours.set(hour, (hours.get(hour) ?? "") + line);
  }
  if (!hours.size) throw new Error("Source log is empty");
  for (const directory of [
    path.dirname(path.dirname(current)),
    path.dirname(current),
  ]) {
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Unsafe log directory");
  }
  const latest = [...hours.keys()].sort().at(-1);
  const outputs: MigrationOutput[] = [...hours].map(([hour, content]) => ({
    hour,
    content,
    file:
      hour === latest
        ? current
        : path.join(
            path.dirname(current),
            `fmcad-${hour.replace("T", "_")}.log`,
          ),
  }));
  for (const output of outputs) {
    if (!fs.existsSync(output.file)) continue;
    const stat = fs.lstatSync(output.file);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      fs.readFileSync(output.file, "utf8") !== output.content
    ) {
      throw new Error(`Destination conflict: ${output.file}`);
    }
  }
  for (const output of outputs) {
    if (fs.existsSync(output.file)) continue;
    const outputFd = fs.openSync(output.file, "wx", 0o600);
    try {
      fs.writeFileSync(outputFd, output.content);
      fs.fsyncSync(outputFd);
    } finally {
      fs.closeSync(outputFd);
    }
  }
  if (digest(fs.readFileSync(source)) !== digest(text))
    throw new Error("Source changed during migration; retained original");
  const manifest: MigrationManifest = {
    source,
    sha256: digest(text),
    lines: text.split("\n").length - (text.endsWith("\n") ? 1 : 0),
    outputs: outputs.map(({ file, content, hour }) => ({
      file,
      hour,
      sha256: digest(content),
    })),
  };
  const manifestPath = path.join(path.dirname(current), "migration.json");
  if (!fs.existsSync(manifestPath))
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
  fs.unlinkSync(source);
  return manifest;
}

export function main(args: string[]): void {
  try {
    if (!args[0])
      throw new Error(
        "Usage: node scripts/migrate-project-log.js PROJECT_DIRECTORY",
      );
    console.log(JSON.stringify(migrate(args[0]), null, 2));
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error))
    return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

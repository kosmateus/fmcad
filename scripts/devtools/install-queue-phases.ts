import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createHash, randomUUID } from "node:crypto";
import {
  runtimeRequire,
  runtimeRoot,
  isRecord,
  errorCode,
  errorMessage,
} from "./runtime.js";

interface QueueInstanceModule {
  durable(file: string, value: unknown, exclusive?: boolean): void;
  readJson(file: string): unknown;
  processBirth(): string;
  buildHash(root?: string): string;
}

interface QueueConnectionModule {
  queueDirectory(): string;
}

interface QueueClient {
  register(): Promise<unknown>;
  call(action: string): Promise<unknown>;
}

interface QueueClientModule {
  QueueClient: new (clientId: string) => QueueClient;
}

const { durable, readJson, processBirth, buildHash } = runtimeRequire(
  "../../src/queue-instance.js",
) as QueueInstanceModule;
const { queueDirectory } = runtimeRequire(
  "../../src/queue-connection.js",
) as QueueConnectionModule;
const RUNTIME_FILES = [
  "assets/cad/identity.py",
  "assets/cad/document_snapshot.py",
  "assets/cad/document.py",
  "assets/addin-bridge.py",
  "assets/queue_document.py",
  "assets/review.py",
  "src/addin-bridge.js",
  "src/docops.js",
  "src/queue-instance.js",
  "src/queue-document.js",
  "src/queue-state.js",
  "src/queue-phased.js",
  "src/queue-broker.js",
  "src/queue-client.js",
  "src/queue-cli.js",
  "src/queue-connection.js",
  "src/review.js",
  "src/i18n.js",
];
const TEST_FILES = [
  "tests/recovery-isolation.test.js",
  "tests/phased-queue.test.js",
  "tests/build-preflight-rejection.test.js",
  "tests/upstream-queue-regressions.test.js",
  "tests/install-queue-phases.test.js",
  "tests/idle-build-refresh.test.js",
];
const sha = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");
const terminal = (state: unknown): boolean =>
  ["succeeded", "failed", "cancelled", "expired"].includes(String(state));

function failure(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export function archiveFiles(file: string): Map<string, Buffer> {
  const tar = zlib.gunzipSync(fs.readFileSync(file));
  const result = new Map<string, Buffer>();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (start: number, end: number): string =>
      header.subarray(start, end).toString("utf8").replace(/\0.*$/s, "");
    const name = [text(345, 500), text(0, 100)]
      .filter(Boolean)
      .join("/")
      .replace(/^package\//, "");
    const size = Number.parseInt(text(124, 136).trim() || "0", 8);
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      offset + 512 + size > tar.length
    ) {
      throw failure("INVALID_ARCHIVE", "Invalid npm baseline archive");
    }
    const type = header[156];
    if (type === 0 || type === 48)
      result.set(name, tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return result;
}

export function inspectSources(
  root: string,
  stage: string,
  archive: string,
): Array<Record<string, unknown>> {
  const baseline = archiveFiles(archive);
  const files: Array<Record<string, unknown>> = [];
  for (const name of [...RUNTIME_FILES, ...TEST_FILES]) {
    const staged = path.join(stage, name);
    const target = path.join(root, name);
    if (!fs.lstatSync(staged).isFile())
      throw failure("INVALID_STAGE", `Missing staged file: ${name}`);
    const current = fs.existsSync(target) ? fs.readFileSync(target) : null;
    const next = fs.readFileSync(staged);
    const original = baseline.get(name) ?? null;
    if (current && sha(current) === sha(next)) continue;
    if (
      (current && (!original || sha(current) !== sha(original))) ||
      (!current && original)
    ) {
      throw failure(
        "CONCURRENT_SOURCE_CHANGE",
        `Installed file differs from the frozen baseline: ${name}`,
      );
    }
    files.push({
      name,
      beforeSha256: current ? sha(current) : null,
      afterSha256: sha(next),
    });
  }
  return files;
}

export function assertQuiescent(value: unknown): void {
  if (!isRecord(value))
    throw failure(
      "QUEUE_NOT_QUIESCENT",
      "Active/unresolved/leased/queued work exists; original owners must resolve or explicitly hand it off. No source changed.",
    );
  const jobsValue = value["jobs"];
  const jobs = isRecord(jobsValue)
    ? Object.values(jobsValue)
    : jobsValue
      ? [jobsValue]
      : [];
  if (
    value["active"] ||
    value["blocked"] ||
    value["lease"] ||
    value["held"] ||
    value["controlBlocked"] ||
    value["stopping"] ||
    jobs.some((job) => !isRecord(job) || !terminal(job["state"]))
  ) {
    throw failure(
      "QUEUE_NOT_QUIESCENT",
      "Active/unresolved/leased/queued work exists; original owners must resolve or explicitly hand it off. No source changed.",
    );
  }
}

function atomicFile(target: string, bytes: Buffer, mode = 0o644): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.install`;
  let published = false;
  try {
    const fd = fs.openSync(temporary, "wx", mode);
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, target);
    published = true;
    const parent = fs.openSync(path.dirname(target), "r");
    try {
      fs.fsyncSync(parent);
    } finally {
      fs.closeSync(parent);
    }
  } finally {
    if (!published && fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export interface InstallOptions {
  root: string;
  stage: string;
  archive: string;
  dir?: string;
  apply?: boolean;
  control: (action: string) => Promise<unknown>;
}

export async function install(
  options: InstallOptions,
): Promise<Record<string, unknown>> {
  const root = fs.realpathSync(options.root);
  const stage = fs.realpathSync(options.stage);
  const dir = options.dir ?? queueDirectory();
  const apply = options.apply ?? false;
  const control = options.control;
  if (root === stage)
    throw failure("INVALID_STAGE", "Installed and staged roots must differ");
  let files = inspectSources(root, stage, options.archive);
  const markerFile = path.join(dir, "broker.lock");
  const recoveryFile = path.join(dir, "recovery.lock");
  const stateFile = path.join(dir, "queue-state.json");
  if (fs.existsSync(recoveryFile))
    throw failure(
      "RECOVERY_IN_PROGRESS",
      "Another recovery/installation owns the startup fence",
    );
  if (fs.existsSync(markerFile)) assertQuiescent(await control("status"));
  else if (fs.existsSync(stateFile)) assertQuiescent(readJson(stateFile));
  const report: Record<string, unknown> = {
    state: apply ? "installing" : "ready",
    root,
    stage,
    archive: options.archive,
    files,
    activeBrokerReplaced: false,
    fusionCalls: 0,
  };
  if (!apply || !files.length) return report;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fence = {
    pid: process.pid,
    birth: processBirth(),
    nonce: randomUUID(),
    purpose: "tested-queue-phase-installation",
  };
  durable(recoveryFile, fence, true);
  let retainFence = false;
  try {
    if (fs.existsSync(markerFile)) {
      assertQuiescent(await control("status"));
      await control("stop");
      const deadline = Date.now() + 15000;
      while (fs.existsSync(markerFile) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 25));
      if (fs.existsSync(markerFile))
        throw failure(
          "BROKER_NOT_STOPPED",
          "Original broker did not stop; installation was not started",
        );
      report["activeBrokerReplaced"] = true;
    }
    if (fs.existsSync(stateFile)) assertQuiescent(readJson(stateFile));
    files = inspectSources(root, stage, options.archive);
    const backup = path.join(
      root,
      "tmp",
      `queue-phases-install-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`,
    );
    fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
    Object.assign(report, { files, backup, beforeBuildHash: buildHash(root) });
    for (const file of files) {
      const name = stringField(file, "name");
      const beforeSha256 = stringOrNullField(file, "beforeSha256");
      if (beforeSha256)
        atomicFile(
          path.join(backup, name),
          fs.readFileSync(path.join(root, name)),
          0o600,
        );
    }
    durable(path.join(backup, "manifest.json"), report, true);
    const applied: Array<Record<string, unknown>> = [];
    try {
      for (const file of files) {
        const name = stringField(file, "name");
        const beforeSha256 = stringOrNullField(file, "beforeSha256");
        const target = path.join(root, name);
        const current = fs.existsSync(target)
          ? sha(fs.readFileSync(target))
          : null;
        if (current !== beforeSha256)
          throw failure(
            "CONCURRENT_SOURCE_CHANGE",
            `File changed immediately before installation: ${name}`,
          );
        applied.push(file);
        atomicFile(target, fs.readFileSync(path.join(stage, name)));
      }
      report["state"] = "installed";
      report["afterBuildHash"] = buildHash(root);
      report["brokerLeftStopped"] = true;
      durable(path.join(backup, "manifest.json"), report);
    } catch (error) {
      for (const file of applied.reverse()) {
        try {
          const name = stringField(file, "name");
          const beforeSha256 = stringOrNullField(file, "beforeSha256");
          const afterSha256 = stringField(file, "afterSha256");
          const target = path.join(root, name);
          const current = fs.existsSync(target)
            ? sha(fs.readFileSync(target))
            : null;
          if (current === beforeSha256) continue;
          if (current !== afterSha256) {
            retainFence = true;
            continue;
          }
          if (beforeSha256)
            atomicFile(target, fs.readFileSync(path.join(backup, name)));
          else fs.unlinkSync(target);
        } catch {
          retainFence = true;
        }
      }
      Object.assign(report, {
        state: retainFence
          ? "manual_source_reconciliation_required"
          : "restored_before_startup",
        error: { code: errorCode(error), message: errorMessage(error) },
      });
      durable(path.join(backup, "manifest.json"), report);
      throw error;
    }
    return report;
  } finally {
    if (!retainFence) {
      const currentFence = readJson(recoveryFile);
      if (isRecord(currentFence) && currentFence["nonce"] === fence.nonce)
        fs.unlinkSync(recoveryFile);
    }
  }
}

export async function main(argv: string[]): Promise<void> {
  const options: {
    root: string;
    stage: string | null;
    archive: string | null;
    apply: boolean;
  } = {
    root: runtimeRoot,
    stage: null,
    archive: null,
    apply: false,
  };
  try {
    for (let index = 0; index < argv.length; index++) {
      const arg = argv[index];
      const argumentValue = argv[index + 1];
      if (arg === "--apply") options.apply = true;
      else if ((arg === "--stage" || arg === "--archive") && argumentValue) {
        index++;
        const value = path.resolve(argumentValue);
        if (arg === "--stage") options.stage = value;
        else options.archive = value;
      } else {
        throw failure(
          "INVALID_ARGUMENT",
          "Use --stage PATH --archive NPM_TGZ [--apply]",
        );
      }
    }
    if (!options.stage || !options.archive)
      throw failure("INVALID_ARGUMENT", "--stage and --archive are required");
    let client: QueueClient | undefined;
    const control = async (action: string): Promise<unknown> => {
      if (!client) {
        const { QueueClient: Client } = runtimeRequire(
          "../../src/queue-client.js",
        ) as QueueClientModule;
        client = new Client("fmcad-recovery-isolation-20261020");
        await client.register();
      }
      return client.call(action);
    };
    console.log(
      JSON.stringify(
        await install({
          root: options.root,
          stage: options.stage,
          archive: options.archive,
          apply: options.apply,
          control,
        }),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        state: "not_installed",
        code: errorCode(error),
        message: errorMessage(error),
      }),
    );
    process.exitCode = 1;
  }
}

function stringField(value: Record<string, unknown>, key: string): string {
  const result = value[key];
  if (typeof result !== "string")
    throw new TypeError(`Missing string field ${key}`);
  return result;
}

function stringOrNullField(
  value: Record<string, unknown>,
  key: string,
): string | null {
  const result = value[key];
  if (result === null || typeof result === "string") return result;
  throw new TypeError(`Missing nullable string field ${key}`);
}

export { RUNTIME_FILES, TEST_FILES };

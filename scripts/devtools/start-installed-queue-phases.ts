import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { runtimeRequire, runtimeRoot, isRecord } from "./runtime.js";

interface QueueClient {
  register(options?: { autoStart?: boolean }): Promise<unknown>;
  call(action: string, values?: Record<string, unknown>): Promise<unknown>;
}

interface QueueClientModule {
  QueueClient: new (
    clientId: string,
    options?: Record<string, unknown>,
  ) => QueueClient;
}

interface QueueConnectionModule {
  queueDirectory(): string;
}

interface QueueInstanceModule {
  durable(file: string, value: unknown, exclusive?: boolean): void;
  readJson(file: string): unknown;
  buildHash(root?: string): string;
  sameInstance(left: unknown, right: unknown): boolean;
}

interface ConfigModule {
  loadConfig(options: { routing: "queue" }): {
    cfg: Record<string, unknown>;
    path: string;
  };
}

interface StartDependencies {
  buildHash?: (root: string) => string;
  sameInstance?: (left: unknown, right: unknown) => boolean;
  now?: () => Date;
  createId?: () => string;
  loadConfig?: () => { cfg: Record<string, unknown>; path: string };
  createClient?: (
    cfg: Record<string, unknown>,
    configPath: string,
  ) => QueueClient;
  spawn?: (
    command: readonly string[],
    options: { cwd: string; timeout: number; maxBuffer: number },
  ) => SpawnSyncReturns<string>;
}

export interface StartOptions {
  root: string;
  directory: string;
  verificationFile?: string;
  maintenanceFile?: string;
  handoff: Record<string, unknown>;
  installation: Record<string, unknown>;
  verification: Record<string, unknown>;
  maintenance?: Record<string, unknown>;
}

const { queueDirectory } = runtimeRequire(
  "../../src/queue-connection.js",
) as QueueConnectionModule;
const { durable, readJson, buildHash, sameInstance } = runtimeRequire(
  "../../src/queue-instance.js",
) as QueueInstanceModule;

export async function startInstalledQueuePhases(
  options: StartOptions,
  dependencies: StartDependencies = {},
): Promise<Record<string, unknown>> {
  const handoff = options.handoff;
  const install = options.installation;
  const verification = options.verification;
  const maintenance = options.maintenance ?? handoff;
  const currentBuildHash = dependencies.buildHash ?? buildHash;
  const matchesInstance = dependencies.sameInstance ?? sameInstance;
  const now = dependencies.now ?? (() => new Date());
  const createId = dependencies.createId ?? randomUUID;
  assert.equal(maintenance.brokerStopped, true);
  assert.equal(install.state, "installed");
  assert.equal(verification.installedRuntimeTested, true);
  assert.equal(verification.verified, true);
  assert.equal(verification.runtime, options.root);
  const readyBuild = currentBuildHash(options.root);
  const displayOverlays: Array<Record<string, unknown>> = [];
  if (verification.afterBuildHash !== readyBuild) {
    assert(
      Array.isArray(verification.executableFiles),
      "A complete verified source inventory is required for UI-only rebasing",
    );
    for (const row of verification.executableFiles) {
      const file = asRecord(row);
      const relative = stringField(file, "path");
      const target = path.join(options.root, relative);
      const digest = fs.existsSync(target) ? hashFile(target) : null;
      if (digest === file.sha256) continue;
      assert(
        /^src\/(console-[^/]+\.js|console-tabs\/[^/]+\.js)$/.test(relative),
        `Non-display source changed after verification: ${relative}`,
      );
      displayOverlays.push({
        path: relative,
        verifiedSha256: file.sha256,
        currentSha256: digest,
      });
    }
    const known = new Set(
      verification.executableFiles.map((row) =>
        stringField(asRecord(row), "path"),
      ),
    );
    const checkNew = (relative: string): void => {
      const target = path.join(options.root, relative);
      const stat = fs.lstatSync(target);
      if (stat.isDirectory()) {
        for (const name of fs.readdirSync(target))
          checkNew(path.join(relative, name));
      } else if (!known.has(relative)) {
        assert(
          /^src\/(console-[^/]+\.js|console-tabs\/[^/]+\.js)$/.test(relative),
          `New non-display executable source: ${relative}`,
        );
      }
    };
    for (const entry of ["package.json", "bin", "src", "assets"])
      checkNew(entry);
  }
  const overlays: Array<Record<string, unknown>> = [];
  const approvedVerifiedOverlays = new Set([
    "src/queue-broker.js",
    "src/queue-phased.js",
    "src/queue-client.js",
    "tests/phased-queue.test.js",
    "tests/build-preflight-rejection.test.js",
  ]);
  assert(Array.isArray(install.files));
  for (const row of install.files) {
    const file = asRecord(row);
    const name = stringField(file, "name");
    const digest = hashFile(path.join(options.root, name));
    if (digest === file.afterSha256) continue;
    assert(
      approvedVerifiedOverlays.has(name),
      `Unexpected installed patch change: ${name}`,
    );
    const reports = [
      ...asArray(verification.runtimeFiles),
      ...asArray(verification.testFiles),
    ].map(asRecord);
    assert.equal(reports.find((value) => value.path === name)?.sha256, digest);
    overlays.push({
      path: name,
      installationSha256: file.afterSha256,
      verifiedSha256: digest,
      authority:
        "User-authorized queue hardening, preserving the other agent response-location changes; covered by this fresh installed-runtime verification",
    });
  }
  assert.equal(
    asRecord(handoff.result).code,
    "OPERATOR_LOCAL_PREFLIGHT_NOT_STARTED",
  );
  assert.equal(handoff.pendingRemoteRequests, 0);
  assert.equal(handoff.brokerStopped, true);
  const evidenceFile = stringField(handoff, "evidenceFile");
  const evidence = asRecord(readJson(evidenceFile));
  const expectedInstance = evidence.instance;
  const config = dependencies.loadConfig
    ? dependencies.loadConfig()
    : (runtimeRequire("../../src/config.js") as ConfigModule).loadConfig({
        routing: "queue",
      });
  const createClient =
    dependencies.createClient ??
    ((cfg, configPath) => {
      const { QueueClient } = runtimeRequire(
        "../../src/queue-client.js",
      ) as QueueClientModule;
      return new QueueClient("fmcad-recovery-isolation-20261020", {
        cfg,
        configPath,
      });
    });
  const client = createClient(config.cfg, config.path);
  await client.register({ autoStart: true });
  let state = asRecord(await client.call("status"));
  assert.equal(state.buildHash, readyBuild);
  assert.equal(state.blocked, null);
  assert.equal(state.held, null);
  assert(
    matchesInstance(
      asRecord(
        asRecord(readJson(path.join(options.directory, "instance.json")))
          .instance,
      ),
      expectedInstance,
    ),
    "Fresh operational probe changed Fusion identity",
  );
  let resumed = false;
  if (!maintenance.originallyPaused) {
    const saved = asRecord(
      readJson(path.join(options.directory, "queue-state.json")),
    );
    const originalIds = asArray(maintenance.originalControlRequestIds);
    const allowed = new Set<unknown>([
      ...originalIds,
      maintenance.operatorPauseId,
    ]);
    const requests = isRecord(saved.controlRequests)
      ? Object.entries(saved.controlRequests)
      : [];
    const unexpectedPause = requests.some(
      ([id, value]) =>
        !allowed.has(id) && isRecord(value) && value.paused === true,
    );
    assert.equal(
      unexpectedPause,
      false,
      "Another user pause must not be removed",
    );
    const control = asRecord(await client.call("control-status"));
    await client.call("resume", {
      control: {
        requestId: createId(),
        instanceId: control.instanceId,
        expectedGeneration: control.generation,
      },
    });
    resumed = true;
  }
  const report: Record<string, unknown> = {
    at: now().toISOString(),
    buildHash: readyBuild,
    originalInstallationBuild: install.afterBuildHash,
    verificationFile: options.verificationFile,
    verificationBuild: verification.afterBuildHash,
    displayOnlyChangesAfterVerification: displayOverlays,
    patchFileHashesPreservedExceptApprovedResponseOverlays: true,
    responsePathOverlays: overlays,
    freshInstance: {
      pid: asRecord(expectedInstance).pid,
      birth: asRecord(expectedInstance).birth,
      version: asRecord(expectedInstance).version,
    },
    resumedOwnMaintenancePause: resumed,
    originalManualPausePreserved: maintenance.originallyPaused,
    maintenanceReport: options.maintenanceFile ?? null,
    fusionRestarted: false,
    modelOperations: 0,
    replay: false,
  };
  if (resumed) {
    const command = [
      path.join(options.root, "bin/fmcad.js"),
      "tools",
      "--client",
      "fmcad-recovery-isolation-20261020",
      "--request-id",
      createId(),
      "--timeout",
      "15000",
      "--purpose",
      "Verify installed broker metadata transport after user-authorized local-preflight recovery",
    ];
    const result = (
      dependencies.spawn ??
      ((args, spawnOptions) =>
        spawnSync(process.execPath, [...args], {
          ...spawnOptions,
          encoding: "utf8",
        }))
    )(command, {
      cwd: options.root,
      timeout: 120000,
      maxBuffer: 16 * 1024 * 1024,
    });
    report.metadataCommand = {
      exitCode: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      signal: result.signal,
    };
    assert.equal(
      result.status,
      0,
      `${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
    const line = String(result.stderr ?? "")
      .split(/\r?\n/)
      .find((value) => value.startsWith("FMCAD_QUEUE_RESULT "));
    assert(line);
    const metadataJob = JSON.parse(
      line.slice("FMCAD_QUEUE_RESULT ".length),
    ) as unknown;
    report.metadataJob = metadataJob;
    assert.equal(asRecord(metadataJob).state, "succeeded");
  }
  state = asRecord(await client.call("status"));
  const queue = {
    active: state.active,
    blocked: state.blocked,
    held: state.held,
    lease: state.lease,
    paused: state.paused,
    revision: state.revision,
  };
  Object.assign(report, { queue, operatorScopeReleased: true });
  assert.equal(state.blocked, null);
  assert.equal(state.held, null);
  const file = path.join(
    options.directory,
    `installed-queue-phases-ready-${createId()}.json`,
  );
  durable(file, report, true);
  return {
    reportFile: file,
    buildHash: report.buildHash,
    resumed,
    queue,
    metadataJob: report.metadataJob,
    modelOperations: 0,
    fusionRestarted: false,
    operatorScopeReleased: true,
  };
}

export async function main(args: string[]): Promise<void> {
  try {
    assert([6, 8].includes(args.length));
    assert.equal(args[0], "--handoff");
    assert.equal(args[2], "--installation");
    assert.equal(args[4], "--verification");
    if (args.length === 8) assert.equal(args[6], "--maintenance");
    const root = runtimeRoot;
    const directory = queueDirectory();
    const { readJson } = runtimeRequire("../../src/queue-instance.js") as Pick<
      QueueInstanceModule,
      "readJson"
    >;
    const argument = (index: number): string => {
      const value = args[index];
      if (typeof value !== "string")
        throw new TypeError("Missing required argument");
      return value;
    };
    const verificationFile = path.resolve(argument(5));
    const options: StartOptions & {
      verificationFile: string;
      maintenanceFile?: string;
    } = {
      root,
      directory,
      handoff: asRecord(readJson(path.resolve(argument(1)))),
      installation: asRecord(readJson(path.resolve(argument(3)))),
      verification: asRecord(readJson(verificationFile)),
      verificationFile,
      ...(args.length === 8
        ? {
            maintenance: asRecord(readJson(path.resolve(argument(7)))),
            maintenanceFile: path.resolve(argument(7)),
          }
        : {}),
    };
    const result = await startInstalledQueuePhases(options);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

function hashFile(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value), "Expected an object record");
  return value;
}

function asArray(value: unknown): unknown[] {
  assert.ok(Array.isArray(value), "Expected an array");
  return value;
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string")
    throw new TypeError(`Missing string field ${key}`);
  return field;
}

export { runtimeRoot };

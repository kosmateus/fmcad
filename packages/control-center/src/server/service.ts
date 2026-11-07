import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  chmodSync,
  writeFileSync,
} from "node:fs";
import { get } from "node:http";
import { connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { CONTROL_CENTER_PROTOCOL_VERSION } from "./protocol.js";
import { processBirthIdentity, processIsAlive } from "./identity.js";

const DISCOVERY_FILE = "service.json";
const LOCK_DIRECTORY = "service.start-lock";
const LOCK_STALE_MS = 30_000;
const READY_TIMEOUT_MS = 15_000;
const LOCK_WAIT_MS = 30_000;
const POLL_INTERVAL_MS = 75;
const MAX_LOG_BYTES = 512 * 1024;
const LEGACY_SAFE_ENV = new Set([
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "SYSTEMROOT",
  "WINDIR",
  "PATH",
  "PATHEXT",
  "TMP",
  "TEMP",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "FMCAD_CONFIG",
]);

export interface EnsureServiceOptions {
  /** controlCenter.port; omitted means the canonical default port 4748. */
  readonly port?: number;
  /** Installed fmcad tree used to constrain executable and composition paths. */
  readonly installationRoot: string;
  /** Real executable identity, normally runtimeBuildIdentity(...). */
  readonly buildIdentity: string;
  /** Trusted module exporting createControlCenterComposition(context). */
  readonly compositionModule: string;
  /** Dedicated process entrypoint; defaults to the package process-main.js. */
  readonly processEntrypoint?: string;
  /** User data path; defaults to $XDG_DATA_HOME/fmcad/control-center. */
  readonly stateDirectory?: string;
  /** OS temporary root for bounded private service diagnostics. */
  readonly temporaryRoot?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  readonly readinessTimeoutMs?: number;
  readonly diagnostics?: (message: string) => void;
}

export interface ServiceIdentity {
  readonly port: number;
  readonly protocolVersion: typeof CONTROL_CENTER_PROTOCOL_VERSION;
  readonly buildIdentity: string;
  readonly pid: number;
  readonly processBirth: string;
  readonly instanceNonce: string;
}

export interface EnsureServiceResult {
  readonly url: string;
  readonly port: number;
  readonly started: boolean;
  readonly identity: ServiceIdentity;
}

interface Discovery {
  readonly version: typeof CONTROL_CENTER_PROTOCOL_VERSION;
  readonly protocolVersion: number;
  readonly port: number;
  readonly buildIdentity: string;
  readonly pid: number;
  readonly processBirth: string;
  readonly instanceNonce: string;
  readonly probeSecret: string;
}

interface LockOwner {
  readonly pid: number;
  readonly birth: string;
  readonly nonce: string;
}

export class ControlCenterServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ControlCenterServiceError";
  }
}

export function defaultServiceDirectory(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  const selected = env["XDG_DATA_HOME"];
  const dataHome = selected
    ? isAbsolute(selected)
      ? selected
      : resolve(home, selected)
    : join(home, ".local", "share");
  return join(dataHome, "fmcad", "control-center");
}

function validatePort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new ControlCenterServiceError(
      "INVALID_PORT",
      "controlCenter.port must be an integer from 1 through 65535",
    );
}

function ensurePrivateDirectory(path: string): void {
  if (!isAbsolute(path))
    throw new ControlCenterServiceError(
      "INVALID_STATE_PATH",
      "Service state directory must be absolute",
    );
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new ControlCenterServiceError(
      "INVALID_STATE_PATH",
      "Service state path must be a real directory",
    );
  if (process.platform !== "win32") {
    if (typeof process.getuid === "function" && stat.uid !== process.getuid())
      throw new ControlCenterServiceError(
        "INVALID_STATE_PATH",
        "Service state directory belongs to another user",
      );
    if ((stat.mode & 0o077) !== 0) {
      try {
        chmodPrivate(path);
      } catch (error) {
        throw new ControlCenterServiceError(
          "INVALID_STATE_PATH",
          "Service state directory is not private",
          { cause: error },
        );
      }
    }
  }
}

function chmodPrivate(path: string): void {
  chmodSync(path, 0o700);
}

function privateFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new ControlCenterServiceError(
      "INVALID_DISCOVERY",
      "Service discovery must be a regular file",
    );
  if (process.platform !== "win32") {
    if (typeof process.getuid === "function" && stat.uid !== process.getuid())
      throw new ControlCenterServiceError(
        "INVALID_DISCOVERY",
        "Service discovery belongs to another user",
      );
    if ((stat.mode & 0o077) !== 0)
      throw new ControlCenterServiceError(
        "INVALID_DISCOVERY",
        "Service discovery permissions are not private",
      );
  }
}

function pathInside(root: string, file: string): string {
  const realRoot = realpathSync(root);
  const realFile = realpathSync(file);
  const fromRoot = relative(realRoot, realFile);
  if (
    !fromRoot ||
    fromRoot.startsWith(`..${sep}`) ||
    fromRoot === ".." ||
    isAbsolute(fromRoot)
  )
    throw new ControlCenterServiceError(
      "INVALID_SERVICE_PATH",
      "Service module must be inside the installed fmcad tree",
    );
  const fileStat = lstatSync(file);
  if (fileStat.isSymbolicLink() || !fileStat.isFile())
    throw new ControlCenterServiceError(
      "INVALID_SERVICE_PATH",
      "Service module must be a regular file",
    );
  return realFile;
}

function validateOptions(options: EnsureServiceOptions): {
  port: number;
  stateDirectory: string;
  diagnosticsRoot: string;
  diagnosticsDirectory: string;
  installationRoot: string;
  processEntrypoint: string;
  compositionModule: string;
  env: NodeJS.ProcessEnv;
  readinessTimeoutMs: number;
} {
  const port = options.port ?? 4748;
  validatePort(port);
  if (!/^[a-f0-9]{64}$/.test(options.buildIdentity))
    throw new ControlCenterServiceError(
      "INVALID_BUILD",
      "Service build identity must be a SHA-256 hex digest",
    );
  if (!isAbsolute(options.installationRoot))
    throw new ControlCenterServiceError(
      "INVALID_INSTALLATION",
      "Installed fmcad root must be absolute",
    );
  const installationRoot = realpathSync(options.installationRoot);
  const processEntrypoint = pathInside(
    installationRoot,
    options.processEntrypoint ?? join(__dirname, "process-main.js"),
  );
  const compositionModule = pathInside(
    installationRoot,
    options.compositionModule,
  );
  const stateDirectory =
    options.stateDirectory ??
    defaultServiceDirectory(options.env, options.home);
  const env = options.env ?? process.env;
  const selectedTemporaryRoot =
    options.temporaryRoot ??
    (isAbsolute(env["TMPDIR"] ?? "") ? env["TMPDIR"]! : tmpdir());
  if (!isAbsolute(selectedTemporaryRoot))
    throw new ControlCenterServiceError(
      "INVALID_TEMP_PATH",
      "Control Center temporary root must be absolute",
    );
  const userKey =
    typeof process.getuid === "function"
      ? String(process.getuid())
      : createHash("sha256")
          .update(options.home ?? homedir())
          .digest("hex")
          .slice(0, 16);
  const diagnosticsRoot = join(
    selectedTemporaryRoot,
    `fmcad-control-center-${userKey}`,
  );
  const diagnosticsKey = createHash("sha256")
    .update(resolve(stateDirectory))
    .digest("hex")
    .slice(0, 24);
  const diagnosticsDirectory = join(diagnosticsRoot, diagnosticsKey);
  const readinessTimeoutMs = options.readinessTimeoutMs ?? READY_TIMEOUT_MS;
  if (
    !Number.isInteger(readinessTimeoutMs) ||
    readinessTimeoutMs < 250 ||
    readinessTimeoutMs > 60_000
  )
    throw new ControlCenterServiceError(
      "INVALID_TIMEOUT",
      "Service readiness timeout is out of range",
    );
  return {
    port,
    stateDirectory,
    diagnosticsRoot,
    diagnosticsDirectory,
    installationRoot,
    processEntrypoint,
    compositionModule,
    env,
    readinessTimeoutMs,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseDiscovery(path: string): Discovery {
  privateFile(path);
  const stat = statSync(path);
  if (stat.size > 8 * 1024)
    throw new ControlCenterServiceError(
      "INVALID_DISCOVERY",
      "Service discovery file is too large",
    );
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new ControlCenterServiceError(
      "INVALID_DISCOVERY",
      "Service discovery file is unreadable",
      { cause: error },
    );
  }
  if (
    !isRecord(value) ||
    value["version"] !== CONTROL_CENTER_PROTOCOL_VERSION ||
    !Number.isSafeInteger(value["protocolVersion"]) ||
    !Number.isInteger(value["port"]) ||
    (value["port"] as number) < 1 ||
    (value["port"] as number) > 65535 ||
    typeof value["buildIdentity"] !== "string" ||
    !/^[a-f0-9]{64}$/.test(value["buildIdentity"]) ||
    !Number.isSafeInteger(value["pid"]) ||
    (value["pid"] as number) < 1 ||
    typeof value["processBirth"] !== "string" ||
    value["processBirth"].length > 512 ||
    typeof value["instanceNonce"] !== "string" ||
    !/^[a-f0-9]{64}$/.test(value["instanceNonce"]) ||
    typeof value["probeSecret"] !== "string" ||
    !/^[a-f0-9]{64}$/.test(value["probeSecret"])
  )
    throw new ControlCenterServiceError(
      "INVALID_DISCOVERY",
      "Service discovery file has an unsupported identity",
    );
  return value as unknown as Discovery;
}

function readLockOwner(path: string): LockOwner | null {
  try {
    const ownerPath = join(path, "owner.json");
    const stat = lstatSync(ownerPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2048)
      throw new ControlCenterServiceError(
        "INVALID_LOCK",
        "Service startup lock owner is not a private file",
      );
    if (
      process.platform !== "win32" &&
      ((typeof process.getuid === "function" &&
        stat.uid !== process.getuid()) ||
        (stat.mode & 0o077) !== 0)
    )
      throw new ControlCenterServiceError(
        "INVALID_LOCK",
        "Service startup lock owner permissions are not private",
      );
    const text = readFileSync(ownerPath, "utf8");
    const value: unknown = JSON.parse(text);
    if (
      !isRecord(value) ||
      !Number.isSafeInteger(value["pid"]) ||
      typeof value["birth"] !== "string" ||
      typeof value["nonce"] !== "string"
    )
      return null;
    return value as unknown as LockOwner;
  } catch (error) {
    if (error instanceof ControlCenterServiceError) throw error;
    return null;
  }
}

async function sleep(duration: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, duration));
}

async function acquireStartLock(directory: string): Promise<() => void> {
  const lockPath = join(directory, LOCK_DIRECTORY);
  const deadline = Date.now() + LOCK_WAIT_MS;
  const nonce = randomBytes(16).toString("hex");
  for (;;) {
    let created = false;
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      created = true;
      const owner: LockOwner = {
        pid: process.pid,
        birth: processBirthIdentity() ?? `process:${process.pid}`,
        nonce,
      };
      writeFileSync(join(lockPath, "owner.json"), JSON.stringify(owner), {
        mode: 0o600,
        flag: "wx",
      });
      return () => {
        const current = readLockOwner(lockPath);
        if (current?.nonce !== nonce) return;
        rmSync(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if (created) rmSync(lockPath, { recursive: true, force: true });
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let stale = false;
    try {
      const stat = lstatSync(lockPath);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new ControlCenterServiceError(
          "INVALID_LOCK",
          "Service startup lock is not a private directory",
        );
      if (
        process.platform !== "win32" &&
        ((typeof process.getuid === "function" &&
          stat.uid !== process.getuid()) ||
          (stat.mode & 0o077) !== 0)
      )
        throw new ControlCenterServiceError(
          "INVALID_LOCK",
          "Service startup lock permissions are not private",
        );
      const owner = readLockOwner(lockPath);
      if (owner) stale = !processIsAlive(owner.pid, owner.birth);
      else stale = Date.now() - stat.mtimeMs > LOCK_STALE_MS;
      if (stale) {
        const quarantine = `${lockPath}.stale-${randomBytes(8).toString("hex")}`;
        try {
          renameSync(lockPath, quarantine);
          rmSync(quarantine, { recursive: true, force: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        continue;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (Date.now() >= deadline)
      throw new ControlCenterServiceError(
        "START_LOCK_TIMEOUT",
        "Timed out waiting for Control Center startup lock",
      );
    await sleep(POLL_INTERVAL_MS);
  }
}

function readDiscoveryIfPresent(path: string): Discovery | null {
  if (!existsSync(path)) return null;
  return parseDiscovery(path);
}

function probe(
  port: number,
  secret: string,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const host = port === 80 ? "localhost" : `localhost:${port}`;
    const request = get(
      {
        host: "127.0.0.1",
        port,
        path: "/__fmcad/health",
        headers: {
          host,
          authorization: `Bearer ${secret}`,
          connection: "close",
        },
        timeout: timeoutMs,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer | string) => {
          const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += part.length;
          if (size > 8 * 1024) {
            response.destroy(new Error("health response too large"));
            return;
          }
          chunks.push(part);
        });
        response.once("error", reject);
        response.once("end", () => {
          if (response.statusCode !== 200)
            return reject(
              new Error(`health endpoint returned HTTP ${response.statusCode}`),
            );
          try {
            resolve(
              JSON.parse(
                Buffer.concat(chunks, size).toString("utf8"),
              ) as unknown,
            );
          } catch {
            reject(new Error("health endpoint returned invalid JSON"));
          }
        });
      },
    );
    const timer = setTimeout(
      () => request.destroy(new Error("health probe timed out")),
      timeoutMs,
    );
    request.once("close", () => clearTimeout(timer));
    request.once("timeout", () =>
      request.destroy(new Error("health probe timed out")),
    );
    request.once("error", reject);
    request.end();
  });
}

function validHealth(value: unknown, expected: Discovery): boolean {
  return (
    isRecord(value) &&
    value["service"] === "fmcad-control-center" &&
    value["protocolVersion"] === expected.protocolVersion &&
    value["buildIdentity"] === expected.buildIdentity &&
    value["port"] === expected.port &&
    value["pid"] === expected.pid &&
    value["processBirth"] === expected.processBirth &&
    value["instanceNonce"] === expected.instanceNonce
  );
}

async function verifiedDiscovery(
  discovery: Discovery,
  requestedPort: number,
  buildIdentity: string,
): Promise<boolean> {
  if (!processIsAlive(discovery.pid, discovery.processBirth)) return false;
  let health: unknown;
  try {
    health = await probe(discovery.port, discovery.probeSecret, 1000);
  } catch {
    if (processBirthIdentity(discovery.pid) === null) return false;
    throw new ControlCenterServiceError(
      "IDENTITY_UNVERIFIED",
      "The process recorded for Control Center could not prove its service identity",
    );
  }
  if (
    isRecord(health) &&
    health["service"] === "fmcad-control-center" &&
    health["protocolVersion"] !== discovery.protocolVersion
  )
    throw new ControlCenterServiceError(
      "PROTOCOL_CONFLICT",
      "Control Center discovery and HTTP protocol identities disagree",
    );
  if (!validHealth(health, discovery)) {
    if (processBirthIdentity(discovery.pid) === null) return false;
    throw new ControlCenterServiceError(
      "IDENTITY_UNVERIFIED",
      "The process recorded for Control Center could not prove its service identity",
    );
  }
  if (discovery.protocolVersion !== CONTROL_CENTER_PROTOCOL_VERSION)
    throw new ControlCenterServiceError(
      "PROTOCOL_CONFLICT",
      "Control Center service protocol does not match this client",
    );
  if (discovery.port !== requestedPort)
    throw new ControlCenterServiceError(
      "PORT_CONFLICT",
      `Control Center is already configured for port ${discovery.port}; requested ${requestedPort}`,
    );
  if (discovery.buildIdentity !== buildIdentity)
    throw new ControlCenterServiceError(
      "BUILD_CONFLICT",
      "Control Center service build does not match this client",
    );
  return true;
}

function assertPortFree(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const hosts = ["127.0.0.1", "::1"];
    let index = 0;
    const next = (): void => {
      if (index >= hosts.length) return resolve();
      const host = hosts[index++]!;
      const socket = connect({ host, port });
      socket.setTimeout(400);
      socket.once("connect", () => {
        socket.destroy();
        reject(
          new ControlCenterServiceError(
            "FOREIGN_PORT",
            `Port ${port} is occupied by a process not registered as this Control Center service`,
          ),
        );
      });
      socket.once("timeout", () => {
        socket.destroy();
        reject(
          new ControlCenterServiceError(
            "PORT_PROBE_FAILED",
            `Could not verify availability of port ${port}`,
          ),
        );
      });
      socket.once("error", (error: NodeJS.ErrnoException) => {
        socket.destroy();
        if (
          [
            "ECONNREFUSED",
            "EHOSTUNREACH",
            "ENETUNREACH",
            "EAFNOSUPPORT",
            "EADDRNOTAVAIL",
          ].includes(error.code ?? "")
        )
          next();
        else
          reject(
            new ControlCenterServiceError(
              "PORT_PROBE_FAILED",
              `Could not verify availability of port ${port}`,
              { cause: error },
            ),
          );
      });
    };
    next();
  });
}

function serviceEnvironment(
  source: NodeJS.ProcessEnv,
  values: Record<string, string>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of LEGACY_SAFE_ENV)
    if (source[key] !== undefined) env[key] = source[key];
  Object.assign(env, values);
  return env;
}

function startChild(
  entrypoint: string,
  installationRoot: string,
  stateDirectory: string,
  diagnosticsDirectory: string,
  compositionModule: string,
  buildIdentity: string,
  port: number,
  nonce: string,
  probeSecret: string,
  sourceEnv: NodeJS.ProcessEnv,
): ReturnType<typeof spawn> {
  const logPath = join(diagnosticsDirectory, "service.log");
  try {
    if (existsSync(logPath)) {
      const prior = lstatSync(logPath);
      if (!prior.isFile() || prior.isSymbolicLink())
        throw new ControlCenterServiceError(
          "INVALID_LOG",
          "Control Center diagnostic path must be a regular file",
        );
    }
    if (existsSync(logPath) && statSync(logPath).size > MAX_LOG_BYTES) {
      const rotated = `${logPath}.1`;
      rmSync(rotated, { force: true });
      renameSync(logPath, rotated);
    }
  } catch {
    /* Logging is best-effort; service startup remains separate from CAD transport. */
  }
  const fd = openSync(
    logPath,
    fsConstants.O_WRONLY |
      fsConstants.O_APPEND |
      fsConstants.O_CREAT |
      (fsConstants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    fchmodSync(fd, 0o600);
    const launchConfig = {
      port,
      stateDirectory,
      installationRoot,
      compositionModule,
      buildIdentity,
      instanceNonce: nonce,
      probeSecret,
    };
    const configPath = join(stateDirectory, `.service-launch-${nonce}.json`);
    const configFd = openSync(
      configPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      writeFileSync(configFd, JSON.stringify(launchConfig));
    } catch (error) {
      rmSync(configPath, { force: true });
      throw error;
    } finally {
      closeSync(configFd);
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        process.execPath,
        [entrypoint, "--fmcad-service-config", configPath],
        {
          cwd: installationRoot,
          detached: true,
          stdio: ["ignore", "ignore", fd],
          windowsHide: true,
          env: serviceEnvironment(sourceEnv, {}),
        },
      );
    } catch (error) {
      rmSync(configPath, { force: true });
      throw error;
    }
    const removeLaunchConfig = (): void => rmSync(configPath, { force: true });
    child.once("error", removeLaunchConfig);
    child.once("exit", removeLaunchConfig);
    child.unref();
    return child;
  } finally {
    closeSync(fd);
  }
}

function serviceIdentity(record: Discovery): ServiceIdentity {
  return {
    port: record.port,
    protocolVersion: CONTROL_CENTER_PROTOCOL_VERSION,
    buildIdentity: record.buildIdentity,
    pid: record.pid,
    processBirth: record.processBirth,
    instanceNonce: record.instanceNonce,
  };
}

export async function ensureService(
  options: EnsureServiceOptions,
): Promise<EnsureServiceResult> {
  const config = validateOptions(options);
  ensurePrivateDirectory(config.stateDirectory);
  ensurePrivateDirectory(config.diagnosticsRoot);
  ensurePrivateDirectory(config.diagnosticsDirectory);
  const release = await acquireStartLock(config.stateDirectory);
  try {
    const discoveryPath = join(config.stateDirectory, DISCOVERY_FILE);
    const existing = readDiscoveryIfPresent(discoveryPath);
    if (existing) {
      if (await verifiedDiscovery(existing, config.port, options.buildIdentity))
        return {
          url: `http://localhost:${config.port}`,
          port: config.port,
          started: false,
          identity: serviceIdentity(existing),
        };
      rmSync(discoveryPath, { force: true });
    }

    await assertPortFree(config.port);
    const nonce = randomBytes(32).toString("hex");
    const probeSecret = randomBytes(32).toString("hex");
    const child = startChild(
      config.processEntrypoint,
      config.installationRoot,
      config.stateDirectory,
      config.diagnosticsDirectory,
      config.compositionModule,
      options.buildIdentity,
      config.port,
      nonce,
      probeSecret,
      config.env,
    );
    let childExit: string | null = null;
    let childFailure: Error | null = null;
    child.once("exit", (code, signal) => {
      childExit = signal ? `signal ${signal}` : `exit ${code}`;
    });
    child.once("error", (error) => {
      childFailure = error;
    });
    const deadline = Date.now() + config.readinessTimeoutMs;
    for (;;) {
      if (childFailure !== null)
        throw new ControlCenterServiceError(
          "START_FAILED",
          "Could not start Control Center service process",
          { cause: childFailure },
        );
      if (childExit !== null)
        throw new ControlCenterServiceError(
          "START_FAILED",
          `Control Center service process exited during startup (${childExit})`,
        );
      const record = readDiscoveryIfPresent(
        join(config.stateDirectory, DISCOVERY_FILE),
      );
      if (record) {
        if (
          record.port !== config.port ||
          record.buildIdentity !== options.buildIdentity ||
          record.protocolVersion !== CONTROL_CENTER_PROTOCOL_VERSION ||
          record.instanceNonce !== nonce ||
          record.probeSecret !== probeSecret ||
          record.pid !== child.pid
        )
          throw new ControlCenterServiceError(
            "START_IDENTITY_MISMATCH",
            "Started Control Center service published an unexpected identity",
          );
        if (
          !(await verifiedDiscovery(record, config.port, options.buildIdentity))
        )
          throw new ControlCenterServiceError(
            "START_IDENTITY_UNVERIFIED",
            "Started Control Center service identity could not be verified",
          );
        options.diagnostics?.(
          `Control Center available at http://localhost:${config.port}`,
        );
        return {
          url: `http://localhost:${config.port}`,
          port: config.port,
          started: true,
          identity: serviceIdentity(record),
        };
      }
      if (Date.now() >= deadline) {
        await assertPortFree(config.port).catch((error: unknown) => {
          if (
            error instanceof ControlCenterServiceError &&
            error.code === "FOREIGN_PORT"
          )
            throw error;
        });
        throw new ControlCenterServiceError(
          "START_TIMEOUT",
          "Timed out waiting for Control Center service readiness",
        );
      }
      await sleep(POLL_INTERVAL_MS);
    }
  } finally {
    release();
  }
}

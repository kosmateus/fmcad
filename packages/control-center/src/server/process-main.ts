import { randomBytes } from "node:crypto";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createControlCenterHttpServer,
  type ControlCenterHttpOptions,
} from "./http.js";
import type {
  ControlCenterComposition,
  ControlCenterCompositionContext,
  ControlCenterCompositionModule,
} from "./composition.js";
import { CONTROL_CENTER_PROTOCOL_VERSION } from "./protocol.js";
import { processBirthIdentity } from "./identity.js";

const DISCOVERY_FILE = "service.json";
const MAX_DISCOVERY_BYTES = 8 * 1024;

interface DiscoveryRecord {
  version: typeof CONTROL_CENTER_PROTOCOL_VERSION;
  protocolVersion: typeof CONTROL_CENTER_PROTOCOL_VERSION;
  port: number;
  buildIdentity: string;
  pid: number;
  processBirth: string;
  instanceNonce: string;
  probeSecret: string;
}

interface LaunchConfig {
  readonly port: number;
  readonly stateDirectory: string;
  readonly installationRoot: string;
  readonly compositionModule: string;
  readonly buildIdentity: string;
  readonly instanceNonce: string;
  readonly probeSecret: string;
}

function readLaunchConfig(): LaunchConfig {
  if (process.argv[2] !== "--fmcad-service-config" || !process.argv[3])
    throw new Error("Missing Control Center launch configuration");
  const configPath = process.argv[3];
  if (!isAbsolute(configPath))
    throw new Error("Control Center launch configuration path is invalid");
  const stat = lstatSync(configPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024)
    throw new Error(
      "Control Center launch configuration is not a private file",
    );
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
    throw new Error(
      "Control Center launch configuration permissions are not private",
    );
  if (
    process.platform !== "win32" &&
    typeof process.getuid === "function" &&
    stat.uid !== process.getuid()
  )
    throw new Error(
      "Control Center launch configuration belongs to another user",
    );
  const value: unknown = JSON.parse(readFileSync(configPath, "utf8"));
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error("Control Center launch configuration is invalid");
  const input = value as Record<string, unknown>;
  const expectedKeys = [
    "port",
    "stateDirectory",
    "installationRoot",
    "compositionModule",
    "buildIdentity",
    "instanceNonce",
    "probeSecret",
  ];
  if (Object.keys(input).some((key) => !expectedKeys.includes(key)))
    throw new Error(
      "Control Center launch configuration contains unsupported fields",
    );
  const {
    port,
    stateDirectory,
    installationRoot,
    compositionModule,
    buildIdentity,
    instanceNonce,
    probeSecret,
  } = input;
  if (
    !Number.isInteger(port) ||
    (port as number) < 1 ||
    (port as number) > 65535 ||
    typeof stateDirectory !== "string" ||
    typeof installationRoot !== "string" ||
    typeof compositionModule !== "string" ||
    typeof buildIdentity !== "string" ||
    !/^[a-f0-9]{64}$/.test(buildIdentity) ||
    typeof instanceNonce !== "string" ||
    !/^[a-f0-9]{64}$/.test(instanceNonce) ||
    typeof probeSecret !== "string" ||
    !/^[a-f0-9]{64}$/.test(probeSecret) ||
    !isAbsolute(stateDirectory) ||
    !isAbsolute(installationRoot) ||
    !isAbsolute(compositionModule)
  )
    throw new Error("Control Center launch configuration is invalid");
  const root = realpathSync(installationRoot);
  const module = realpathSync(compositionModule);
  const moduleRelative = relative(root, module);
  const moduleStat = lstatSync(compositionModule);
  const realState = realpathSync(stateDirectory);
  const stateStat = lstatSync(stateDirectory);
  if (
    !stateStat.isDirectory() ||
    stateStat.isSymbolicLink() ||
    (process.platform !== "win32" &&
      typeof process.getuid === "function" &&
      stateStat.uid !== process.getuid()) ||
    dirname(realpathSync(configPath)) !== realState ||
    basename(configPath) !== `.service-launch-${instanceNonce}.json` ||
    (process.platform !== "win32" && (stateStat.mode & 0o077) !== 0)
  )
    throw new Error(
      "Control Center launch configuration is outside the private service directory",
    );
  if (
    !moduleStat.isFile() ||
    moduleStat.isSymbolicLink() ||
    !moduleRelative ||
    moduleRelative === ".." ||
    moduleRelative.startsWith(`..${sep}`)
  )
    throw new Error(
      "Control Center composition module is outside the installed package",
    );
  rmSync(configPath);
  return {
    port: port as number,
    stateDirectory,
    installationRoot: root,
    compositionModule: module,
    buildIdentity,
    instanceNonce,
    probeSecret,
  };
}

function readConfig(): Omit<
  ControlCenterHttpOptions,
  "query" | "resolvePrincipal" | "assets"
> & {
  readonly stateDirectory: string;
  readonly installationRoot: string;
  readonly compositionModule: string;
} {
  const {
    port,
    stateDirectory,
    installationRoot,
    compositionModule,
    buildIdentity,
    instanceNonce,
    probeSecret,
  } = readLaunchConfig();
  return {
    stateDirectory,
    installationRoot,
    compositionModule,
    identity: {
      port,
      buildIdentity,
      protocolVersion: CONTROL_CENTER_PROTOCOL_VERSION,
      pid: process.pid,
      processBirth: processBirthIdentity() ?? `process:${process.pid}`,
      instanceNonce,
      probeSecret,
    },
  };
}

function writeDiscovery(directory: string, record: DiscoveryRecord): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
    throw new Error("Control Center state path is not a private directory");
  const destination = join(directory, DISCOVERY_FILE);
  const temporary = join(
    directory,
    `.service-${process.pid}-${randomBytes(8).toString("hex")}.tmp`,
  );
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(record));
    closeSync(fd);
    renameSync(temporary, destination);
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      // The descriptor may already be closed.
    }
    rmSync(temporary, { force: true });
    throw error;
  }
}

function removeOwnDiscovery(directory: string, nonce: string): void {
  const path = join(directory, DISCOVERY_FILE);
  try {
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > MAX_DISCOVERY_BYTES
    )
      return;
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      value !== null &&
      typeof value === "object" &&
      "instanceNonce" in value &&
      value.instanceNonce === nonce
    )
      rmSync(path, { force: true });
  } catch {
    // A replaced or malformed discovery record is not ours to remove.
  }
}

async function run(): Promise<void> {
  const config = readConfig();
  let server: ReturnType<typeof createControlCenterHttpServer> | undefined;
  let composition: ControlCenterComposition | undefined;
  try {
    const module = (await import(
      pathToFileURL(config.compositionModule).href
    )) as ControlCenterCompositionModule;
    if (typeof module.createControlCenterComposition !== "function")
      throw new Error(
        "Composition module does not export createControlCenterComposition",
      );
    const context: ControlCenterCompositionContext = {
      port: config.identity.port,
      installationRoot: config.installationRoot,
      stateDirectory: config.stateDirectory,
      buildIdentity: config.identity.buildIdentity,
      protocolVersion: config.identity.protocolVersion,
      instanceNonce: config.identity.instanceNonce,
    };
    composition = await module.createControlCenterComposition(context);
    server = createControlCenterHttpServer({
      identity: config.identity,
      query: composition.query,
      resolvePrincipal: composition.resolvePrincipal,
      ...(composition.projectActions !== undefined
        ? { projectActions: composition.projectActions }
        : {}),
      ...(composition.assets ? { assets: composition.assets } : {}),
    });
    await server.start();
    const discovery: DiscoveryRecord = {
      version: CONTROL_CENTER_PROTOCOL_VERSION,
      protocolVersion: CONTROL_CENTER_PROTOCOL_VERSION,
      port: config.identity.port,
      buildIdentity: config.identity.buildIdentity,
      pid: config.identity.pid,
      processBirth: config.identity.processBirth,
      instanceNonce: config.identity.instanceNonce,
      probeSecret: config.identity.probeSecret,
    };
    writeDiscovery(config.stateDirectory, discovery);
    let closing = false;
    const close = (exitCode = 0): void => {
      if (closing) return;
      closing = true;
      void server!
        .close()
        .catch(() => {})
        .finally(async () => {
          try {
            await composition!.close?.();
          } catch {
            /* Cleanup must not skip discovery release or process termination. */
          }
          removeOwnDiscovery(
            config.stateDirectory,
            config.identity.instanceNonce,
          );
          process.exit(exitCode);
        });
    };
    process.once("SIGINT", () => close());
    process.once("SIGTERM", () => close());
    process.once("uncaughtException", () => {
      process.stderr.write(
        "Control Center service process failed unexpectedly.\n",
      );
      close(1);
    });
    process.once("unhandledRejection", () => {
      process.stderr.write(
        "Control Center service process failed unexpectedly.\n",
      );
      close(1);
    });
  } catch (error) {
    if (server) await server.close().catch(() => {});
    try {
      await composition?.close?.();
    } catch {
      // Preserve the startup error as the process diagnostic.
    }
    throw error;
  }
}

function safeFailureCode(error: unknown): string {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = error.code;
    if (typeof code === "string" && /^[A-Z0-9_-]{1,64}$/.test(code))
      return code;
  }
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name))
    return error.name;
  return "UNKNOWN";
}

void run().catch((error: unknown) => {
  process.stderr.write(
    `Control Center service failed to start (${safeFailureCode(error)}).\n`,
  );
  process.exitCode = 1;
});

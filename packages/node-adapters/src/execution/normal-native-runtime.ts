import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { decodeAdmissionJson } from "./admission-json";
import { nativePhysicalGuard } from "./physical-generation-provision";
import type { VerifiedPhysicalOperatorProfile } from "./physical-generation-profile";

const powershell = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const normalStartupTimeoutMs = 5000;
const normalStartupRetryIntervalMs = 100;
const discoverPaths = `
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$directory = Join-Path $env:LOCALAPPDATA 'AutodeskFusionMCP\\physical'
$file = Join-Path $directory 'normal-runtime.json'
if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { Write-Output 'null'; exit 0 }
$config = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
$startingFile = Join-Path $directory 'normal-starting.json'
$starting = if (Test-Path -LiteralPath $startingFile -PathType Leaf) {
  Get-Content -LiteralPath $startingFile -Raw | ConvertFrom-Json
} else { $null }
$process = $null
try { $process = Get-Process -Id $config.descriptor.physicalRuntime.pid -ErrorAction Stop }
catch {
  if ($_.FullyQualifiedErrorId -notmatch '^NoProcessFoundForGivenId,') { throw }
}
if ($null -eq $process) {
  if ($null -eq $starting) { throw 'Normal runtime PID is absent without a startup record' }
  @{state='starting'; config=$config; starting=$starting; localAppData=$env:LOCALAPPDATA;
    installedForkDirectory=(Join-Path $env:APPDATA 'Autodesk\\Autodesk Fusion 360\\API\\AddIns\\AutodeskFusionMCP')} | ConvertTo-Json -Depth 12 -Compress
  exit 0
}
$python = Join-Path (Split-Path -Parent $process.Path) 'Python\\python.exe'
@{config=$config; nativePython=$python; localAppData=$env:LOCALAPPDATA;
  installedForkDirectory=(Join-Path $env:APPDATA 'Autodesk\\Autodesk Fusion 360\\API\\AddIns\\AutodeskFusionMCP')} | ConvertTo-Json -Depth 12 -Compress
`;
function refused(): never {
  throw Object.assign(new Error("Normal native runtime discovery failed"), {
    code: "NATIVE_RUNTIME_DISCOVERY_REJECTED", notStarted: true,
  });
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) refused();
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value) refused();
  return value;
}
function exactKeys(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) refused();
}
function normalConfig(value: unknown, localAppData: string, installedForkDirectory: string,
  mapPath: (value: string) => string): Record<string, unknown> {
  const config = object(value);
  exactKeys(config, ["kind", "version", "provisionPath", "installedForkDirectory",
    "nativePrivateDirectory", "descriptor"]);
  if (config["kind"] !== "fmcad-normal-native-runtime" || config["version"] !== 1 ||
      config["installedForkDirectory"] !== installedForkDirectory) refused();
  const installed = text(config["installedForkDirectory"]);
  mapPath(installed);
  const provisionPath = text(config["provisionPath"]);
  const nativePrivateDirectory = text(config["nativePrivateDirectory"]);
  const nativeDirectory = path.win32.join(localAppData, "AutodeskFusionMCP", "physical");
  if (!path.win32.isAbsolute(provisionPath) || path.win32.normalize(provisionPath) !== provisionPath ||
      path.win32.dirname(provisionPath) !== path.win32.join(nativeDirectory, "normal-provisions") ||
      !path.win32.isAbsolute(nativePrivateDirectory) ||
      path.win32.normalize(nativePrivateDirectory) !== nativePrivateDirectory ||
      nativePrivateDirectory !== path.win32.join(localAppData, "AutodeskFusionMCP", "clients")) refused();
  const descriptor = object(config["descriptor"]);
  exactKeys(descriptor, ["handoffId", "generation", "endpointURL", "physicalRuntime"]);
  text(descriptor["endpointURL"]);
  const generation = object(descriptor["generation"]);
  exactKeys(generation, ["instance", "epoch"]);
  const instance = text(generation["instance"]);
  const epoch = text(generation["epoch"]);
  if (descriptor["handoffId"] !== `normal-start-${instance}-${epoch}` ||
      path.win32.basename(provisionPath) !== `${instance}.json`) refused();
  const physicalRuntime = object(descriptor["physicalRuntime"]);
  exactKeys(physicalRuntime, ["pid", "birth", "version", "source", "build"]);
  const pid = physicalRuntime["pid"];
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) refused();
  text(physicalRuntime["birth"]);
  text(physicalRuntime["version"]);
  text(physicalRuntime["source"]);
  text(physicalRuntime["build"]);
  return config;
}
function startingConfig(metadata: Record<string, unknown>,
  mapPath: (value: string) => string): Record<string, unknown> {
  exactKeys(metadata, ["state", "config", "starting", "localAppData", "installedForkDirectory"]);
  if (metadata["state"] !== "starting") refused();
  const localAppData = text(metadata["localAppData"]);
  if (!path.win32.isAbsolute(localAppData) || path.win32.normalize(localAppData) !== localAppData) refused();
  const installed = text(metadata["installedForkDirectory"]);
  const current = normalConfig(metadata["config"], localAppData, installed, mapPath);
  const startup = object(metadata["starting"]);
  exactKeys(startup, ["config", "previous"]);
  const previous = normalConfig(startup["previous"], localAppData, installed, mapPath);
  const next = normalConfig(startup["config"], localAppData, installed, mapPath);
  const previousGeneration = object(object(previous["descriptor"])["generation"]);
  const nextGeneration = object(object(next["descriptor"])["generation"]);
  if (!isDeepStrictEqual(current, previous) ||
      previousGeneration["instance"] === nextGeneration["instance"] ||
      previousGeneration["epoch"] === nextGeneration["epoch"]) refused();
  return next;
}
export function mapWindowsRuntimePath(value: string): string {
  if (!/^[A-Za-z]:\\/.test(value) || path.win32.normalize(value) !== value)
    refused();
  return "/mnt/" + value[0]!.toLowerCase() + "/" + value.slice(3).replaceAll("\\", "/");
}
async function invoke(file: string, args: string[], input: string, env: NodeJS.ProcessEnv, cwd?: string) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(file, args, { env, cwd, stdio: ["pipe", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => child.kill(), 15000);
    child.stdout.on("data", (bytes: Buffer) => {
      size += bytes.length;
      if (size > 4 * 1024 * 1024) child.kill();
      else chunks.push(bytes);
    });
    child.on("error", reject);
    child.on("close", (status) => {
      clearTimeout(timer);
      if (status !== 0 || size > 4 * 1024 * 1024) reject(new Error("Native discovery process failed"));
      else resolve(Buffer.concat(chunks).toString("utf8").trim());
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/** Local metadata only. Does not issue a grant, create a store or enter the SDK. */
export async function discoverNormalNativeRuntime(
  directory: string,
  dependencies: {
    environment?: NodeJS.ProcessEnv;
    run?: typeof invoke;
    mapPath?: typeof mapWindowsRuntimePath;
    startupTimeoutMs?: number;
  } = {},
): Promise<VerifiedPhysicalOperatorProfile | undefined> {
  const environment = dependencies.environment ?? process.env;
  if (process.platform !== "linux" || !environment["WSL_DISTRO_NAME"]) return undefined;
  const run = dependencies.run ?? invoke;
  const mapPath = dependencies.mapPath ?? mapWindowsRuntimePath;
  const retryTimeoutMs = dependencies.startupTimeoutMs ?? normalStartupTimeoutMs;
  if (!Number.isSafeInteger(retryTimeoutMs) || retryTimeoutMs < 0 ||
      retryTimeoutMs > normalStartupTimeoutMs) refused();
  let expectedStartupConfig: Record<string, unknown> | undefined;
  let startupDeadline: number | undefined;
  let metadata: Record<string, unknown>;
  while (true) {
    const raw = decodeAdmissionJson(await run(powershell,
      ["-NoProfile", "-NonInteractive", "-Command", discoverPaths], "", environment));
    if (raw === null) {
      if (expectedStartupConfig) refused();
      return undefined;
    }
    metadata = object(raw);
    if ("state" in metadata) {
      const next = startingConfig(metadata, mapPath);
      if (expectedStartupConfig && !isDeepStrictEqual(expectedStartupConfig, next)) refused();
      if (!expectedStartupConfig) {
        expectedStartupConfig = next;
        startupDeadline = Date.now() + retryTimeoutMs;
      }
      if (startupDeadline === undefined) refused();
      const remaining = startupDeadline - Date.now();
      if (remaining <= 0) refused();
      await new Promise(resolve => setTimeout(resolve, Math.min(normalStartupRetryIntervalMs, remaining)));
      if (Date.now() >= startupDeadline) refused();
      continue;
    }
    if (expectedStartupConfig && !isDeepStrictEqual(metadata["config"], expectedStartupConfig)) refused();
    break;
  }
  const config = object(metadata["config"]);
  if (config["kind"] !== "fmcad-normal-native-runtime" || config["version"] !== 1)
    refused();
  const installed = text(metadata["installedForkDirectory"]);
  if (config["installedForkDirectory"] !== installed) refused();
  const mappedInstalled = mapPath(installed);
  const nativePython = text(metadata["nativePython"]);
  const localAppData = text(metadata["localAppData"]);
  const nativeDirectory = path.win32.join(localAppData, "AutodeskFusionMCP", "physical");
  const provisionPath = text(config["provisionPath"]);
  const nativePrivateDirectory = text(config["nativePrivateDirectory"]);
  if (path.win32.dirname(provisionPath) !== path.win32.join(nativeDirectory, "normal-provisions") ||
      nativePrivateDirectory !== path.win32.join(localAppData, "AutodeskFusionMCP", "clients"))
    refused();
  const files: Record<string, string> = {};
  function digest(file: string) {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink()) refused();
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  }
  function collect(folder: string) {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.name === "__pycache__") continue;
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) collect(file);
      else files[path.relative(mappedInstalled, file)] = digest(file);
    }
  }
  collect(mappedInstalled);
  const nativeProvision = {
    nativePython, mappedNativePython: mapPath(nativePython),
    nativePythonSha256: digest(mapPath(nativePython)),
    installedForkDirectory: installed, mappedInstalledForkDirectory: mappedInstalled,
    installedPackageFiles: files, provisionPath, localAppData, nativePrivateDirectory,
    mappedPrivateDirectory: mapPath(nativePrivateDirectory),
    linuxGrantDirectory: directory,
  };
  const descriptor = object(config["descriptor"]);
  const env = {
    SystemRoot: "C:\\Windows", LOCALAPPDATA: localAppData,
    FUSION_MCP_ADMISSION_PROVISION: provisionPath,
    WSLENV: "SystemRoot:LOCALAPPDATA:FUSION_MCP_ADMISSION_PROVISION:WSL_DISTRO_NAME",
    WSL_DISTRO_NAME: environment["WSL_DISTRO_NAME"],
    ...(environment["WSL_INTEROP"] ? { WSL_INTEROP: environment["WSL_INTEROP"] } : {}),
  };
  const verified = decodeAdmissionJson(await run(nativeProvision.mappedNativePython,
    ["-I", "-S", "-B", "-c", nativePhysicalGuard +
      "\nfrom lib.normal_runtime import discover\nprint(json.dumps(discover()))\n"],
    JSON.stringify({ pins: nativeProvision, descriptor, attempt: randomUUID() }) + "\n", env,
    mappedInstalled));
  if (!isDeepStrictEqual(verified, config)) refused();
  return {
    clientId: "fmcad-normal-broker", transport: "windows-curl",
    runtime: {
      ...descriptor,
      kind: "fmcad-physical-grant", version: 1,
    } as VerifiedPhysicalOperatorProfile["runtime"],
    nativeProvision,
  };
}

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { decodeAdmissionJson } from "./admission-json";
import type { PhysicalGenerationDescriptor } from "./physical-generation";

/** Trusted local composition only; never accepted from public invocation DTOs. */
export interface NativePhysicalGenerationProvisionOptions {
  nativePython: string;
  mappedNativePython: string;
  nativePythonSha256: string;
  installedForkDirectory: string;
  mappedInstalledForkDirectory: string;
  installedPackageFiles: Readonly<Record<string, string>>;
  provisionPath: string;
  localAppData: string;
  nativePrivateDirectory: string;
  mappedPrivateDirectory: string;
  linuxGrantDirectory: string;
  timeoutMs?: number;
}

export class PhysicalGenerationProvisionError extends Error {
  constructor(
    readonly grantIssuance: "notStarted" | "unknown",
    readonly guardCode?: string,
  ) {
    super(`Private physical grant provisioning failed (${grantIssuance})`);
    this.name = "PhysicalGenerationProvisionError";
  }
}

const nativeGuardCodes = new Set([
  "NATIVE_RUNTIME_MAPPING",
  "NATIVE_INTERPRETER_DIGEST",
  "NATIVE_PACKAGE_DIGEST",
  "NATIVE_PACKAGE_CONTENTS",
  "NATIVE_AUTHORITY_NAMESPACE",
  "NATIVE_PROVISION_RUNTIME",
  "NATIVE_PROVISION_GENERATION",
  "NATIVE_PROCESS_UNAVAILABLE",
  "NATIVE_PROCESS_BIRTH",
  "NATIVE_CACHE_PRESENT",
]);
class NativeBootstrapRefusal extends Error {
  constructor(readonly guardCode: string) {
    super("Private native bootstrap refused");
  }
}

// No fork imports until stdlib-only validation completes, in EVERY process.
// run_module invokes the supported CLI with its ordinary argument parser, but
// unlike a separate precheck + -m process it cannot skip the process-local guard.
export const nativePhysicalGuard = `
import ctypes,hashlib,json,os,runpy,sys
from ctypes import wintypes as wt
from pathlib import Path
def deny(code):
    print(json.dumps({"guard":code}))
    raise SystemExit(78)
raw_envelope=sys.stdin.buffer.readline(4194305)
if len(raw_envelope)>4194304:
    raise RuntimeError("Envelope too large")
e=json.loads(raw_envelope)
p=e["pins"]
root=Path(p["installedForkDirectory"])
exe=Path(p["nativePython"])
def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()
if sys.platform!="win32" or Path(sys.executable).resolve()!=exe.resolve() or Path.cwd().resolve()!=root.resolve():
    deny("NATIVE_RUNTIME_MAPPING")
if digest(exe)!=p["nativePythonSha256"]:
    deny("NATIVE_INTERPRETER_DIGEST")
for name,sha in p["installedPackageFiles"].items():
    if digest(root/name)!=sha:
        deny("NATIVE_PACKAGE_DIGEST")
expected_files={str(Path(name)).lower() for name in p["installedPackageFiles"]}
actual_files={str(file.relative_to(root)).lower() for file in root.rglob("*") if file.is_file() and "__pycache__" not in file.relative_to(root).parts}
if actual_files!=expected_files:
    deny("NATIVE_PACKAGE_CONTENTS")
if os.environ.get("LOCALAPPDATA")!=p["localAppData"] or os.environ.get("FUSION_MCP_ADMISSION_PROVISION")!=p["provisionPath"]:
    deny("NATIVE_AUTHORITY_NAMESPACE")
d=e["descriptor"]
r=d["physicalRuntime"]
provision=json.loads(Path(p["provisionPath"]).read_bytes().decode("utf-8"))
for key in ("pid","birth","source","build"):
    if provision[key]!=r[key]:
        deny("NATIVE_PROVISION_RUNTIME")
if (provision["instance"],provision["epoch"])!=(d["generation"]["instance"],d["generation"]["epoch"]):
    deny("NATIVE_PROVISION_GENERATION")
k=ctypes.WinDLL("kernel32",use_last_error=True)
k.OpenProcess.argtypes=[wt.DWORD,wt.BOOL,wt.DWORD]
k.OpenProcess.restype=wt.HANDLE
k.GetProcessTimes.argtypes=[wt.HANDLE,ctypes.POINTER(wt.FILETIME),ctypes.POINTER(wt.FILETIME),ctypes.POINTER(wt.FILETIME),ctypes.POINTER(wt.FILETIME)]
k.CloseHandle.argtypes=[wt.HANDLE]
handle=k.OpenProcess(0x1000,False,r["pid"])
if not handle:
    deny("NATIVE_PROCESS_UNAVAILABLE")
try:
    times=[wt.FILETIME() for _ in range(4)]
    if not k.GetProcessTimes(handle,*(ctypes.byref(t) for t in times)):
        deny("NATIVE_PROCESS_BIRTH")
    if str((times[0].dwHighDateTime<<32)|times[0].dwLowDateTime)!=r["birth"]:
        deny("NATIVE_PROCESS_BIRTH")
finally:
    k.CloseHandle(handle)
cache=Path(p["nativePrivateDirectory"])/e["attempt"]/"unused-python-cache"
if cache.exists():
    deny("NATIVE_CACHE_PRESENT")
sys.pycache_prefix=str(cache)
sys.path.insert(0,str(root))
`;

const nativeBootstrap = `${nativePhysicalGuard}
if e["action"]=="grant":
    sys.argv=["lib.physical_lifecycle","grant","--request",e["request"],"--output",e["output"],"--timeout",str(e["timeout"])]
    runpy.run_module("lib.physical_lifecycle",run_name="__main__")
elif e["action"]=="prepare":
    from lib.physical_authority import private_directory,_read_private_bytes
    parent=Path(p["nativePrivateDirectory"])
    private_directory(parent)
    directory=parent/e["attempt"]
    if directory.exists():
        raise RuntimeError("Attempt already exists")
    private_directory(directory)
    raw=e["descriptorRaw"].encode("utf-8")
    if json.loads(raw)!=d:
        raise RuntimeError("Descriptor changed")
    fd=os.open(directory/"request.json",os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,"wb") as f:
        f.write(raw)
        f.flush()
        os.fsync(f.fileno())
    verified=_read_private_bytes(directory/"request.json")
    if verified!=raw:
        raise RuntimeError("Descriptor changed")
    print(hashlib.sha256(verified).hexdigest())
elif e["action"]=="verify":
    from lib.physical_authority import _read_private_bytes
    raw=_read_private_bytes(Path(e["output"]))
    if len(raw)>1048576:
        raise RuntimeError("Grant too large")
    print(hashlib.sha256(raw).hexdigest())
else:
    raise RuntimeError("Unsupported private action")
`;

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function privateDirectoryIdentity(fd: number) {
  const info = fs.fstatSync(fd, { bigint: true });
  if (
    !info.isDirectory() ||
    info.uid !== BigInt(process.getuid?.() ?? -1) ||
    (info.mode & 0o077n) !== 0n
  )
    throw new Error("Private Linux directory required");
  return info;
}

function readMappedFile(file: string): Buffer {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.size > 1_048_576)
      throw new Error("Invalid private grant file");
    const buffer = Buffer.alloc(1_048_577);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (size > 1_048_576) throw new Error("Private file grew");
    return buffer.subarray(0, size);
  } finally {
    fs.closeSync(fd);
  }
}

/** One-shot supported local mailbox adapter. Uncertain outcomes retain their
 * private files; neither CLI calls nor grant issuance are automatically retried. */
export function createNativePhysicalGenerationProvision(
  options: NativePhysicalGenerationProvisionOptions,
) {
  const pinned = structuredClone(options);
  const timeout = pinned.timeoutMs ?? 30_000;
  const validSha = (value: string) => /^[a-f0-9]{64}$/.test(value);
  for (const value of [
    pinned.nativePython,
    pinned.installedForkDirectory,
    pinned.provisionPath,
    pinned.localAppData,
    pinned.nativePrivateDirectory,
  ])
    if (!/^[a-z]:\\/i.test(value) || !path.win32.isAbsolute(value))
      throw new PhysicalGenerationProvisionError("notStarted");
  for (const value of [
    pinned.mappedNativePython,
    pinned.mappedInstalledForkDirectory,
    pinned.mappedPrivateDirectory,
    pinned.linuxGrantDirectory,
  ])
    if (!path.posix.isAbsolute(value))
      throw new PhysicalGenerationProvisionError("notStarted");
  if (
    process.platform !== "linux" ||
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > 300_000 ||
    !validSha(pinned.nativePythonSha256) ||
    !Object.hasOwn(pinned.installedPackageFiles, "lib/physical_lifecycle.py") ||
    !Object.hasOwn(pinned.installedPackageFiles, "lib/physical_authority.py")
  )
    throw new PhysicalGenerationProvisionError("notStarted");
  for (const [name, sha] of Object.entries(pinned.installedPackageFiles))
    if (
      !validSha(sha) ||
      path.posix.isAbsolute(name) ||
      path.posix.normalize(name) !== name ||
      name.includes("\\") ||
      name.split("/").some((part) => !part || part === "." || part === "..")
    )
      throw new PhysicalGenerationProvisionError("notStarted");

  let used = false;
  return {
    async provision(
      descriptor: PhysicalGenerationDescriptor,
    ): Promise<{ grantFile: string; grantDigest: string }> {
      if (used) throw new PhysicalGenerationProvisionError("unknown");
      used = true;
      let issuanceStarted = false;
      let directoryFd: number | undefined;
      const snapshot = structuredClone(descriptor);
      const invoke = (action: object): Promise<string> => {
        // Before launch as well as inside the native process: never execute a
        // mismapped interpreter or import a mismapped installed package.
        if (
          digest(readMappedFile(pinned.mappedNativePython)) !==
          pinned.nativePythonSha256
        )
          throw new Error("Native executable differs");
        for (const [name, sha] of Object.entries(pinned.installedPackageFiles))
          if (
            digest(
              fs.readFileSync(
                path.join(pinned.mappedInstalledForkDirectory, name),
              ),
            ) !== sha
          )
            throw new Error("Installed package differs");
        return new Promise((resolve, reject) => {
          const child = spawn(
            pinned.mappedNativePython,
            ["-I", "-S", "-B", "-c", nativeBootstrap],
            {
              cwd: pinned.mappedInstalledForkDirectory,
              env: {
                SystemRoot: "C:\\Windows",
                LOCALAPPDATA: pinned.localAppData,
                FUSION_MCP_ADMISSION_PROVISION: pinned.provisionPath,
                WSLENV:
                  "SystemRoot:LOCALAPPDATA:FUSION_MCP_ADMISSION_PROVISION",
                ...(process.env["WSL_INTEROP"]
                  ? { WSL_INTEROP: process.env["WSL_INTEROP"] }
                  : {}),
                ...(process.env["WSL_DISTRO_NAME"]
                  ? { WSL_DISTRO_NAME: process.env["WSL_DISTRO_NAME"] }
                  : {}),
              },
              shell: false,
              windowsHide: true,
              stdio: ["pipe", "pipe", "ignore"],
            },
          );
          let output = Buffer.alloc(0);
          let overflow = false;
          const timer = setTimeout(() => {
            child.kill();
            reject(new Error("Private subprocess timeout"));
          }, timeout + 5_000);
          child.stdout.on("data", (data: Buffer) => {
            if (output.length + data.length > 4096) {
              overflow = true;
              child.kill();
            } else output = Buffer.concat([output, data]);
          });
          child.stdin.on("error", () => {});
          child.once("error", () => {
            clearTimeout(timer);
            reject(new Error("Private subprocess unavailable"));
          });
          child.once("close", (code) => {
            clearTimeout(timer);
            if (code === 78 && !overflow) {
              try {
                const refusal = decodeAdmissionJson(
                  new TextDecoder("utf-8", { fatal: true }).decode(output),
                ) as Record<string, unknown>;
                if (
                  refusal &&
                  Object.keys(refusal).join(",") === "guard" &&
                  typeof refusal["guard"] === "string" &&
                  nativeGuardCodes.has(refusal["guard"])
                ) {
                  reject(new NativeBootstrapRefusal(refusal["guard"]));
                  return;
                }
              } catch {
                // Only the bounded, allowlisted guard code can cross this boundary.
              }
              reject(new Error("Private subprocess failed"));
            } else if (code !== 0 || overflow)
              reject(new Error("Private subprocess failed"));
            else {
              try {
                resolve(
                  new TextDecoder("utf-8", {
                    fatal: true,
                    ignoreBOM: true,
                  }).decode(output),
                );
              } catch {
                reject(new Error("Invalid private subprocess output"));
              }
            }
          });
          child.stdin.end(
            JSON.stringify({ pins: pinned, descriptor: snapshot, ...action }),
          );
        });
      };
      try {
        if (
          path.posix.normalize(pinned.linuxGrantDirectory) !==
            pinned.linuxGrantDirectory ||
          fs.realpathSync(pinned.linuxGrantDirectory) !==
            pinned.linuxGrantDirectory
        )
          throw new Error("Canonical private directory required");
        directoryFd = fs.openSync(
          pinned.linuxGrantDirectory,
          fs.constants.O_RDONLY |
            fs.constants.O_DIRECTORY |
            fs.constants.O_NOFOLLOW,
        );
        const originalDirectory = privateDirectoryIdentity(directoryFd);
        const directoryAtOpen = fs.lstatSync(pinned.linuxGrantDirectory, {
          bigint: true,
        });
        if (
          fs.realpathSync(pinned.linuxGrantDirectory) !==
            pinned.linuxGrantDirectory ||
          directoryAtOpen.dev !== originalDirectory.dev ||
          directoryAtOpen.ino !== originalDirectory.ino
        )
          throw new Error("Canonical directory identity changed");
        const raw = Buffer.from(JSON.stringify(snapshot));
        if (raw.length > 1_048_576) throw new Error("Descriptor too large");
        const attempt = randomUUID();
        const nativeDirectory = path.win32.join(
          pinned.nativePrivateDirectory,
          attempt,
        );
        const request = path.win32.join(nativeDirectory, "request.json");
        const output = path.win32.join(nativeDirectory, "grant.json");
        const requestDigest = (
          await invoke({
            action: "prepare",
            attempt,
            descriptorRaw: raw.toString("utf8"),
          })
        ).trim();
        if (requestDigest !== digest(raw))
          throw new Error("Descriptor digest mismatch");
        issuanceStarted = true;
        const acknowledgment = decodeAdmissionJson(
          await invoke({
            action: "grant",
            attempt,
            request,
            output,
            timeout: timeout / 1000,
          }),
        );
        if (
          !acknowledgment ||
          typeof acknowledgment !== "object" ||
          Array.isArray(acknowledgment) ||
          Object.keys(acknowledgment).sort().join(",") !== "handoffId,state" ||
          (acknowledgment as Record<string, unknown>)["state"] !== "granted" ||
          (acknowledgment as Record<string, unknown>)["handoffId"] !==
            snapshot.handoffId
        )
          throw new Error("Unbound grant acknowledgment");
        const grantDigest = (
          await invoke({ action: "verify", attempt, output })
        ).trim();
        if (!validSha(grantDigest)) throw new Error("Invalid grant digest");
        const rawGrant = readMappedFile(
          path.posix.join(pinned.mappedPrivateDirectory, attempt, "grant.json"),
        );
        if (digest(rawGrant) !== grantDigest)
          throw new Error("Grant digest mismatch");
        const beforeWrite = privateDirectoryIdentity(directoryFd);
        if (
          beforeWrite.dev !== originalDirectory.dev ||
          beforeWrite.ino !== originalDirectory.ino
        )
          throw new Error("Private directory identity changed");
        const name = `${attempt}.grant.json`;
        const fdRelative = `/proc/self/fd/${directoryFd}/${name}`;
        const fd = fs.openSync(
          fdRelative,
          fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_NOFOLLOW,
          0o600,
        );
        try {
          fs.writeFileSync(fd, rawGrant);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        if (digest(readMappedFile(fdRelative)) !== grantDigest)
          throw new Error("Private copy digest mismatch");
        const returnedDirectory = fs.lstatSync(pinned.linuxGrantDirectory, {
          bigint: true,
        });
        privateDirectoryIdentity(directoryFd);
        if (
          returnedDirectory.isSymbolicLink() ||
          fs.realpathSync(pinned.linuxGrantDirectory) !==
            pinned.linuxGrantDirectory ||
          returnedDirectory.dev !== originalDirectory.dev ||
          returnedDirectory.ino !== originalDirectory.ino
        )
          throw new Error("Private directory pathname changed");
        return {
          grantFile: path.posix.join(pinned.linuxGrantDirectory, name),
          grantDigest,
        };
      } catch (error) {
        throw new PhysicalGenerationProvisionError(
          issuanceStarted ? "unknown" : "notStarted",
          error instanceof NativeBootstrapRefusal ? error.guardCode : undefined,
        );
      } finally {
        if (directoryFd !== undefined) fs.closeSync(directoryFd);
      }
    },
  };
}

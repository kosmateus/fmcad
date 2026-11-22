import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { PhysicalGenerationDescriptor } from "./physical-generation";

/** Trusted local composition only; never accepted from public invocation DTOs. */
export interface NativePhysicalGenerationProvisionOptions {
  nativePython: string;
  mappedNativePython: string;
  installedForkDirectory: string;
  mappedInstalledForkDirectory: string;
  provisionPath: string;
  localAppData: string;
  nativePrivateDirectory: string;
  mappedPrivateDirectory: string;
  linuxGrantDirectory: string;
  timeoutMs?: number;
}

export class PhysicalGenerationProvisionError extends Error {
  constructor(readonly grantIssuance: "notStarted" | "unknown") {
    super(`Private physical grant provisioning failed (${grantIssuance})`);
    this.name = "PhysicalGenerationProvisionError";
  }
}

// Executed by native Windows Python, from the approved installed package.
// The descriptor travels through stdin, never argv/environment or diagnostics.
const prepareRequest = `
import hashlib,json,os,sys
from pathlib import Path
from lib.physical_authority import private_directory,_read_private_bytes
root=Path(sys.argv[1])
directory=root/sys.argv[2]
if sys.platform!="win32" or not root.is_absolute():
    raise RuntimeError("Native Windows private directory required")
if Path(sys.executable).resolve()!=Path(sys.argv[3]).resolve() or Path.cwd().resolve()!=Path(sys.argv[4]).resolve():
    raise RuntimeError("Native runtime mapping differs")
private_directory(root)
if directory.exists():
    raise RuntimeError("Attempt already exists")
private_directory(directory)
raw=sys.stdin.buffer.read(1048577)
if len(raw)>1048576:
    raise RuntimeError("Descriptor too large")
json.loads(raw)
request=directory/"request.json"
fd=os.open(request,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,"wb") as f:
    f.write(raw)
    f.flush()
    os.fsync(f.fileno())
verified=_read_private_bytes(request)
if verified!=raw:
    raise RuntimeError("Descriptor changed")
print(hashlib.sha256(verified).hexdigest())
`;

const verifyGrant = `
import hashlib,sys
from pathlib import Path
from lib.physical_authority import _read_private_bytes
if sys.platform!="win32":
    raise RuntimeError("Native Windows required")
raw=_read_private_bytes(Path(sys.argv[1]))
if len(raw)>1048576:
    raise RuntimeError("Grant too large")
print(hashlib.sha256(raw).hexdigest())
`;

function privateDirectory(directory: string): void {
  const info = fs.lstatSync(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    throw new Error("Private Linux directory required");
}

function readMappedFile(file: string): Buffer {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.size > 1_048_576)
      throw new Error("Invalid private grant file");
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** One-shot local mailbox adapter. An uncertain CLI outcome is never retried,
 * and its private files are retained for the original operation's recovery. */
export function createNativePhysicalGenerationProvision(
  options: NativePhysicalGenerationProvisionOptions,
) {
  const pinned = { ...options };
  const timeout = pinned.timeoutMs ?? 30_000;
  for (const value of [
    pinned.nativePython,
    pinned.installedForkDirectory,
    pinned.provisionPath,
    pinned.localAppData,
    pinned.nativePrivateDirectory,
  ])
    if (!path.win32.isAbsolute(value) || !/^[a-z]:\\/i.test(value))
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
    timeout > 300_000
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
      const invoke = (args: string[], input?: Buffer): Promise<string> =>
        new Promise((resolve, reject) => {
          // No inherited Python configuration or credential-bearing environment.
          const child = spawn(
            pinned.mappedNativePython,
            ["-E", "-B", ...args],
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
          let output = "";
          let overflow = false;
          const timer = setTimeout(() => {
            child.kill();
            reject(new Error("Private subprocess timeout"));
          }, timeout + 5_000);
          child.stdout.on("data", (data: Buffer) => {
            if (output.length + data.length > 256) {
              overflow = true;
              child.kill();
            } else output += data.toString("utf8");
          });
          child.stdin.on("error", () => {
            // Early exit is handled by close/error without exposing stdin.
          });
          child.once("error", () => {
            clearTimeout(timer);
            reject(new Error("Private subprocess unavailable"));
          });
          child.once("close", (code) => {
            clearTimeout(timer);
            if (code !== 0 || overflow)
              reject(new Error("Private subprocess failed"));
            else resolve(output.trim());
          });
          child.stdin.end(input);
        });
      try {
        privateDirectory(pinned.linuxGrantDirectory);
        const raw = Buffer.from(JSON.stringify(structuredClone(descriptor)));
        if (raw.length > 1_048_576) throw new Error("Descriptor too large");
        const attempt = randomUUID();
        const nativeDirectory = path.win32.join(
          pinned.nativePrivateDirectory,
          attempt,
        );
        const request = path.win32.join(nativeDirectory, "request.json");
        const nativeGrant = path.win32.join(nativeDirectory, "grant.json");
        const requestDigest = await invoke(
          [
            "-c",
            prepareRequest,
            pinned.nativePrivateDirectory,
            attempt,
            pinned.nativePython,
            pinned.installedForkDirectory,
          ],
          raw,
        );
        if (requestDigest !== createHash("sha256").update(raw).digest("hex"))
          throw new Error("Descriptor digest mismatch");
        issuanceStarted = true;
        await invoke([
          "-m",
          "lib.physical_lifecycle",
          "grant",
          "--request",
          request,
          "--output",
          nativeGrant,
          "--timeout",
          String(timeout / 1000),
        ]);
        const grantDigest = await invoke(["-c", verifyGrant, nativeGrant]);
        if (!/^[a-f0-9]{64}$/.test(grantDigest))
          throw new Error("Invalid grant digest");
        const rawGrant = readMappedFile(
          path.posix.join(pinned.mappedPrivateDirectory, attempt, "grant.json"),
        );
        if (createHash("sha256").update(rawGrant).digest("hex") !== grantDigest)
          throw new Error("Grant digest mismatch");
        privateDirectory(pinned.linuxGrantDirectory);
        const grantFile = path.posix.join(
          pinned.linuxGrantDirectory,
          `${attempt}.grant.json`,
        );
        const fd = fs.openSync(
          grantFile,
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
        if (
          createHash("sha256")
            .update(readMappedFile(grantFile))
            .digest("hex") !== grantDigest
        )
          throw new Error("Private copy digest mismatch");
        return { grantFile, grantDigest };
      } catch {
        throw new PhysicalGenerationProvisionError(
          issuanceStarted ? "unknown" : "notStarted",
        );
      }
    },
  };
}

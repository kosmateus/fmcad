import { readFileSync } from "node:fs";
import { arch, release } from "node:os";
import { posix } from "node:path";

export class UnsupportedPlatformError extends Error {
  readonly code = "FMCAD_UNSUPPORTED_PLATFORM";
  constructor(message: string) {
    super(`Unsupported fmcad platform: ${message}`);
    this.name = "UnsupportedPlatformError";
  }
}

export interface PlatformFacts {
  readonly platform: string;
  readonly architecture: string;
  readonly nodeVersion: string;
  readonly osRelease: string;
  readonly distribution: string;
  readonly distributionVersion: string;
  readonly wslDistro?: string;
}

export function detectPlatform(): PlatformFacts {
  let text = "";
  try {
    text = readFileSync("/etc/os-release", "utf8");
  } catch {
    /* reported by capability check */
  }
  const field = (name: string): string =>
    text.match(new RegExp(`^${name}=["']?([^"'\\n]+)`, "m"))?.[1] ?? "";
  return {
    platform: process.platform,
    architecture: arch(),
    nodeVersion: process.versions.node,
    osRelease: release(),
    distribution: field("ID"),
    distributionVersion: field("VERSION_ID"),
    ...(process.env["WSL_DISTRO_NAME"]
      ? { wslDistro: process.env["WSL_DISTRO_NAME"] }
      : {}),
  };
}

export function assertPlatformCapability(
  facts: PlatformFacts,
  capability: "local" | "fusion",
): void {
  const [major, minor] = facts.nodeVersion.split(".").map(Number);
  if (!((major === 22 && minor !== undefined && minor >= 13) || major === 24)) {
    throw new UnsupportedPlatformError("Node 22.13+ or 24.x is required");
  }
  if (
    facts.platform !== "linux" ||
    facts.architecture !== "x64" ||
    facts.distribution !== "ubuntu" ||
    !["22.04", "24.04"].includes(facts.distributionVersion)
  ) {
    throw new UnsupportedPlatformError(
      "local operations require Ubuntu 22.04/24.04 x64; native Windows/macOS adapters are not supported",
    );
  }
  if (
    capability === "fusion" &&
    (!facts.wslDistro ||
      !/microsoft.*wsl2|wsl2.*microsoft/i.test(facts.osRelease))
  ) {
    throw new UnsupportedPlatformError(
      "Fusion requires WSL2 on Windows 11 with external Fusion; plain Linux has no Windows path mapping",
    );
  }
}

/** Mapping is explicit; a Linux host never acquires a fictional Ubuntu UNC root. */
export function toWindowsPath(file: string, facts: PlatformFacts): string {
  if (
    facts.platform !== "linux" ||
    !facts.wslDistro ||
    !/microsoft/i.test(facts.osRelease)
  ) {
    throw new UnsupportedPlatformError(
      "Windows paths require a detected WSL distribution",
    );
  }
  if (!posix.isAbsolute(file))
    throw new Error("Windows mapping requires an absolute Linux path");
  if (file.includes("\0")) throw new Error("Path contains NUL");
  const normalized = posix.normalize(file);
  const drive = normalized.match(/^\/mnt\/([a-zA-Z])(?:\/(.*))?$/);
  if (drive)
    return `${drive[1]!.toUpperCase()}:\\${(drive[2] ?? "").replaceAll("/", "\\")}`;
  if (!/^[^\\/\0]+$/.test(facts.wslDistro))
    throw new Error("Invalid WSL distribution name");
  return `\\\\wsl$\\${facts.wslDistro}${normalized.replaceAll("/", "\\")}`;
}

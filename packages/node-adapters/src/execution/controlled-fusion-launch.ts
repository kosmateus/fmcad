import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { decodeAdmissionJson } from "./admission-json";
import { controlledFusionLaunchNative } from "./controlled-fusion-launch-native";
import { bootstrapInstalledFilesDigest } from "./bootstrap-entry-evidence";
import type {
  ControlledNativeAdapter,
  ControlledFile,
  ControlledLaunch,
  ControlledLaunchPaths,
  ControlledProcess,
} from "./controlled-fusion-launch-types";

export interface ControlledFusionLaunchPins {
  readonly nativePython: string;
  readonly mappedNativePython: string;
  readonly nativePythonSha256: string;
  /** Qualified immutable helper package, not the currently installed add-in. */
  readonly sourceDirectory: string;
  readonly mappedSourceDirectory: string;
  readonly installedDirectory: string;
  readonly mappedInstalledDirectory: string;
  readonly installedSource: string;
  readonly installedBuild: string;
  readonly installedFiles: Readonly<Record<string, string>>;
  readonly executable: string;
  readonly mappedExecutable: string;
  readonly executableSha256: string;
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
  readonly paths: ControlledLaunchPaths;
  /** Additional ORIGINAL native audit refs emitted by trusted ROOT ports. */
  readonly originalPaths: readonly string[];
  /** Explicit trusted mappings for every profile/output/ROOT-port audit path. */
  readonly mappedOriginalPaths: Readonly<Record<string, string>>;
  readonly receiptTimeoutMs: number;
  readonly normalCloseTimeoutMs: number;
  readonly mainWindowClass: string;
}
export class ControlledFusionNativeError extends Error {
  readonly outcome = "UNKNOWN";
  constructor(
    readonly action: string,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(
      `Controlled native ${action} outcome unproven; preserve originals, no replay`,
    );
  }
}
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const sha = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Closed native object required");
  return value as Record<string, unknown>;
}
function closed(value: unknown, keys: readonly string[]) {
  const record = object(value);
  if (Object.keys(record).sort().join() !== [...keys].sort().join())
    throw new Error("Closed native fields differ");
  return record;
}
function windowsPath(value: string): string {
  if (
    !/^[A-Za-z]:\\/.test(value) ||
    value.includes("\0") ||
    path.win32.normalize(value) !== value
  )
    throw new Error("Canonical local Windows path required");
  return value.toLowerCase();
}
function identity(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const numbers: unknown = decodeAdmissionJson(value);
    return (
      Array.isArray(numbers) &&
      numbers.length === 11 &&
      numbers.every(
        (item: unknown) => Number.isSafeInteger(item) && (item as number) >= 0,
      )
    );
  } catch {
    return false;
  }
}
function validateSource(
  value: unknown,
  files: Readonly<Record<string, string>>,
) {
  const source = closed(value, ["helper", "installed"]);
  for (const key of ["helper", "installed"]) {
    const snapshot = source[key];
    if (snapshot === null && key === "installed") continue;
    const inventory = closed(snapshot, ["files", "directories"]);
    const actual = object(inventory["files"]);
    if (
      Object.keys(actual).sort().join("\0") !==
      Object.keys(files).sort().join("\0")
    )
      throw new Error("Full source inventory differs");
    for (const [name, hash] of Object.entries(files)) {
      const file = closed(actual[name], ["sha256", "identity"]);
      if (file["sha256"] !== hash || !identity(file["identity"]))
        throw new Error("Source bytes/identity unavailable");
    }
    const directories = object(inventory["directories"]);
    if (
      !Object.keys(directories).length ||
      Object.values(directories).some((item) => !identity(item))
    )
      throw new Error("Source directory identities unavailable");
  }
  return source;
}

/**
 * Concrete Windows operator primitives. Construction is trusted local ROOT
 * composition only. No public tool, CLI option or invocation supplies these pins.
 * Cancellation never kills an uncertain native operation; callers await its
 * bounded result then revoke their one-shot transcript. Missing/partial output
 * never causes a retry.
 */
export function createControlledFusionLaunchAdapter(
  options: ControlledFusionLaunchPins,
): ControlledNativeAdapter {
  const pins = structuredClone(options);
  for (const value of [
    pins.nativePython,
    pins.sourceDirectory,
    pins.installedDirectory,
    pins.executable,
    pins.workingDirectory,
    ...Object.values(pins.paths),
    ...pins.originalPaths,
  ])
    windowsPath(value);
  if (
    !sha(pins.nativePythonSha256) ||
    !sha(pins.executableSha256) ||
    !/^[a-f0-9]{40}$/.test(pins.installedSource) ||
    !Number.isSafeInteger(pins.receiptTimeoutMs) ||
    pins.receiptTimeoutMs < 1 ||
    pins.receiptTimeoutMs > 180000 ||
    !Number.isSafeInteger(pins.normalCloseTimeoutMs) ||
    pins.normalCloseTimeoutMs < 1 ||
    pins.normalCloseTimeoutMs > 180000 ||
    !pins.mainWindowClass ||
    pins.mainWindowClass.length > 256 ||
    pins.mainWindowClass.includes("\0") ||
    pins.arguments.some(
      (argument) => typeof argument !== "string" || argument.includes("\0"),
    )
  )
    throw new Error("Qualified native launch pins required");
  const names = Object.keys(pins.installedFiles);
  if (
    pins.installedBuild !== bootstrapInstalledFilesDigest(pins.installedFiles)
  )
    throw new Error("Qualified native build/full-manifest digest differs");
  if (
    ![
      "AutodeskFusionMCP.py",
      "addon_runtime.py",
      "lib/bootstrap_entry.py",
    ].every((name) => names.includes(name)) ||
    names.some(
      (name) =>
        !name ||
        name.includes("\\") ||
        name.includes(":") ||
        path.posix.normalize(name) !== name ||
        name.startsWith("/") ||
        name.split("/").some((part) => part === ".." || part === ".") ||
        !sha(pins.installedFiles[name]),
    ) ||
    new Set(names.map((name) => name.toLowerCase())).size !== names.length
  )
    throw new Error("Closed qualified source manifest required");
  const filePaths = Object.entries(pins.paths)
    .filter(([key]) => key !== "receiptDirectory")
    .map(([, value]) => value);
  if (
    new Set(filePaths.map(windowsPath)).size !== filePaths.length ||
    path.win32.dirname(pins.paths.entry) !== pins.paths.receiptDirectory ||
    path.win32.dirname(pins.paths.returned) !== pins.paths.receiptDirectory
  )
    throw new Error("Fresh disjoint original paths required");
  for (const value of filePaths) {
    for (const root of [pins.sourceDirectory, pins.installedDirectory]) {
      const relative = path.win32.relative(root, value);
      if (
        relative !== ".." &&
        !relative.startsWith("..\\") &&
        !path.win32.isAbsolute(relative)
      )
        throw new Error("Outputs must not alias installed source");
    }
  }
  let expectedSource: Record<string, unknown> | null = null;
  let launchAttempted = false,
    profileAttempted = false;
  const published = new Set<string>();
  const allowed = new Set([
    ...Object.values(pins.paths),
    ...pins.originalPaths,
  ]);
  for (const nativePath of allowed) {
    if (
      nativePath !== pins.paths.receiptDirectory &&
      (typeof pins.mappedOriginalPaths[nativePath] !== "string" ||
        !path.isAbsolute(pins.mappedOriginalPaths[nativePath]!))
    )
      throw new Error("Explicit mapped original path required");
  }
  function mappedStamp(mapped: string, expectedHash?: string): string {
    const before = fs.lstatSync(mapped, { bigint: true });
    if (before.isSymbolicLink()) throw new Error("Mapped alias refused");
    if (!before.isFile()) throw new Error("Mapped regular file required");
    const fd = fs.openSync(
      mapped,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    try {
      const opened = fs.fstatSync(fd, { bigint: true });
      if (opened.dev !== before.dev || opened.ino !== before.ino)
        throw new Error("Mapped path/FD identity differs");
      const bytes = fs.readFileSync(fd);
      const after = fs.fstatSync(fd, { bigint: true });
      const current = fs.lstatSync(mapped, { bigint: true });
      const stamp = (info: typeof opened) =>
        [
          info.dev,
          info.ino,
          info.mode,
          info.nlink,
          info.size,
          info.mtimeNs,
          info.ctimeNs,
        ].join(":");
      if (
        stamp(before) !== stamp(opened) ||
        stamp(opened) !== stamp(after) ||
        stamp(after) !== stamp(current) ||
        (expectedHash && digest(bytes) !== expectedHash)
      )
        throw new Error("Mapped bytes or identity changed");
      return stamp(after);
    } finally {
      fs.closeSync(fd);
    }
  }
  function sourceMappedFiles(root: string, directories?: string[]): string[] {
    const found: string[] = [];
    const visit = (directory: string) => {
      if (fs.lstatSync(directory).isSymbolicLink())
        throw new Error("Mapped source alias refused");
      directories?.push(directory);
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const name = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(name);
        else if (entry.isFile())
          found.push(path.relative(root, name).split(path.sep).join("/"));
        else throw new Error("Mapped source special file refused");
      }
    };
    visit(root);
    if (
      found.sort().join("\0") !==
      Object.keys(pins.installedFiles).sort().join("\0")
    )
      throw new Error("Mapped full source inventory changed");
    return found;
  }
  function file(value: unknown, expectedPath?: string): ControlledFile {
    const result = closed(value, [
      "nativePath",
      "sha256",
      "identity",
      "base64",
    ]);
    if (
      typeof result["nativePath"] !== "string" ||
      !allowed.has(result["nativePath"]) ||
      (expectedPath &&
        windowsPath(result["nativePath"]) !== windowsPath(expectedPath)) ||
      !sha(result["sha256"]) ||
      !identity(result["identity"]) ||
      typeof result["base64"] !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        result["base64"],
      )
    )
      throw new Error("Original native file fields differ");
    const bytes = Buffer.from(result["base64"], "base64");
    if (bytes.length > 8388608 || digest(bytes) !== result["sha256"])
      throw new Error("Original native bytes differ");
    return Object.freeze({
      nativePath: result["nativePath"],
      sha256: result["sha256"],
      identity: result["identity"],
      bytes,
    });
  }
  function process(value: unknown): ControlledProcess {
    const result = closed(value, ["pid", "birth"]);
    if (
      !Number.isSafeInteger(result["pid"]) ||
      (result["pid"] as number) <= 0 ||
      typeof result["birth"] !== "string" ||
      !/^[0-9]+$/.test(result["birth"])
    )
      throw new Error("Exact native process tuple required");
    return Object.freeze({
      pid: result["pid"] as number,
      birth: result["birth"],
    });
  }
  function inputProcess(value: ControlledProcess): ControlledProcess {
    return process(value);
  }
  function reference(value: ControlledFile) {
    if (
      !allowed.has(value.nativePath) ||
      digest(value.bytes) !== value.sha256 ||
      !identity(value.identity)
    )
      throw new Error("Pinned original bytes/identity required");
    return {
      nativePath: value.nativePath,
      sha256: value.sha256,
      identity: value.identity,
    };
  }
  async function invoke(action: string, request: unknown): Promise<unknown> {
    if (
      digest(fs.readFileSync(pins.mappedNativePython)) !==
        pins.nativePythonSha256 ||
      digest(fs.readFileSync(pins.mappedExecutable)) !== pins.executableSha256
    )
      throw new ControlledFusionNativeError(
        action,
        "",
        "Mapped native executable bytes differ before spawn",
      );
    const nativePins = {
      nativePython: pins.nativePython,
      nativePythonSha256: pins.nativePythonSha256,
      sourceDirectory: pins.sourceDirectory,
      installedDirectory: pins.installedDirectory,
      installedFiles: pins.installedFiles,
      executable: pins.executable,
      executableSha256: pins.executableSha256,
      arguments: pins.arguments,
      workingDirectory: pins.workingDirectory,
      paths: pins.paths,
      originalPaths: pins.originalPaths,
      receiptTimeoutMs: pins.receiptTimeoutMs,
      normalCloseTimeoutMs: pins.normalCloseTimeoutMs,
      mainWindowClass: pins.mainWindowClass,
    };
    const raw = await new Promise<{ stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(
          pins.mappedNativePython,
          ["-I", "-S", "-B", "-c", controlledFusionLaunchNative],
          {
            cwd: pins.mappedSourceDirectory,
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...processEnv(), PYTHONDONTWRITEBYTECODE: "1" },
          },
        );
        let stdout = "",
          stderr = "",
          overflow = false;
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (text: string) => {
          if (stdout.length + text.length <= 32 * 1024 * 1024) stdout += text;
          else overflow = true;
        });
        child.stderr.on("data", (text: string) => {
          if (stderr.length + text.length <= 1024 * 1024) stderr += text;
          else overflow = true;
        });
        child.on("error", () =>
          reject(new ControlledFusionNativeError(action, stdout, stderr)),
        );
        child.stdin.on("error", () => {
          /* close/error owns the terminal result; never resend */
        });
        child.on("close", (code) =>
          code !== 0 || overflow
            ? reject(new ControlledFusionNativeError(action, stdout, stderr))
            : resolve({ stdout, stderr }),
        );
        child.stdin.end(
          JSON.stringify({ pins: nativePins, action, request, expectedSource }),
        );
      },
    );
    try {
      const envelope = closed(decodeAdmissionJson(raw.stdout), [
        "kind",
        "action",
        "source",
        "result",
      ]);
      if (
        envelope["kind"] !== "controlled-fusion-native-v1" ||
        envelope["action"] !== action
      )
        throw new Error("Wrong original native response");
      const source = validateSource(envelope["source"], pins.installedFiles);
      if (
        action !== "dead" &&
        action !== "normal-close" &&
        source["installed"] === null
      )
        throw new Error("Installed source closure absent");
      if (
        expectedSource &&
        (!isDeepStrictEqual(source["helper"], expectedSource["helper"]) ||
          (expectedSource["installed"] !== null &&
            !isDeepStrictEqual(
              source["installed"],
              expectedSource["installed"],
            )))
      )
        throw new Error("Native source closure changed");
      expectedSource = source;
      return envelope["result"];
    } catch {
      throw new ControlledFusionNativeError(action, raw.stdout, raw.stderr);
    }
  }
  async function nothing(action: string, request: unknown) {
    if ((await invoke(action, request)) !== null)
      throw new ControlledFusionNativeError(
        action,
        "",
        "Unexpected native result",
      );
  }
  return Object.freeze({
    paths: Object.freeze({ ...pins.paths }),
    installedDirectory: pins.installedDirectory,
    installedSource: pins.installedSource,
    installedBuild: pins.installedBuild,
    installedFiles: Object.freeze({ ...pins.installedFiles }),
    nativePathMappings: Object.freeze({
      ...pins.mappedOriginalPaths,
      [pins.sourceDirectory]: pins.mappedSourceDirectory,
      [pins.installedDirectory]: pins.mappedInstalledDirectory,
      [pins.nativePython]: pins.mappedNativePython,
      [pins.executable]: pins.mappedExecutable,
    }),
    preflight: () => nothing("preflight", {}),
    requestNormalCloseAndWait: (value) =>
      nothing("normal-close", { process: inputProcess(value) }),
    confirmDead: (value) => nothing("dead", { process: inputProcess(value) }),
    readProfileAfterDeath: async (value) =>
      file(
        await invoke("read-profile", { process: inputProcess(value) }),
        pins.paths.profile,
      ),
    async applyProfileAfterDeath(old, original, bytes) {
      if (profileAttempted)
        throw new Error("Profile application cannot be replayed");
      profileAttempted = true;
      const result = closed(
        await invoke("replace-profile", {
          old: inputProcess(old),
          original: reference(original),
          base64: Buffer.from(bytes).toString("base64"),
        }),
        ["profile", "backup"],
      );
      return {
        profile: file(result["profile"], pins.paths.profile),
        backup: file(result["backup"], pins.paths.profileBackup),
      };
    },
    async launch(old, profile, nonce): Promise<ControlledLaunch> {
      if (launchAttempted) throw new Error("Native launch cannot be replayed");
      launchAttempted = true;
      if (!/^[a-f0-9]{32}$/.test(nonce))
        throw new Error("Fresh private launch nonce required");
      const result = closed(
        await invoke("launch", {
          old: inputProcess(old),
          profile: reference(profile),
          nonce,
        }),
        ["process", "journal", "attempt", "sourceClosure"],
      );
      return Object.freeze({
        process: process(result["process"]),
        journal: file(result["journal"], pins.paths.launchJournal),
        attempt: file(result["attempt"], pins.paths.launchAttempt),
        sourceClosure: file(result["sourceClosure"], pins.paths.sourceClosure),
      });
    },
    assertProcess: (value) =>
      nothing("assert-process", { process: inputProcess(value) }),
    async readOriginal(nativePath) {
      if (!allowed.has(nativePath))
        throw new Error("Original native path is not pinned");
      return file(await invoke("read", { path: nativePath }), nativePath);
    },
    async publishOriginal(nativePath, bytes) {
      if (
        ![pins.paths.intent, pins.paths.transcript].includes(nativePath) ||
        published.has(nativePath)
      )
        throw new Error("Exclusive publication cannot be replayed");
      published.add(nativePath);
      return file(
        await invoke("publish", {
          path: nativePath,
          base64: Buffer.from(bytes).toString("base64"),
        }),
        nativePath,
      );
    },
    async assertOriginal(expected) {
      const actual = file(
        await invoke("read", { path: reference(expected).nativePath }),
        expected.nativePath,
      );
      if (
        actual.sha256 !== expected.sha256 ||
        actual.identity !== expected.identity
      )
        throw new Error("Original native file changed");
    },
    assertSource: () => nothing("preflight", {}),
    captureSynchronousFence(files) {
      if (!expectedSource || expectedSource["installed"] === null)
        throw new Error(
          "Async native source preflight required before sync capture",
        );
      const expected = new Map<string, { hash: string; stamp: string }>();
      const directories = new Map<string, string>();
      const directoryStamp = (directory: string) => {
        const info = fs.lstatSync(directory, { bigint: true });
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new Error("Mapped directory differs");
        return [info.dev, info.ino, info.mode, info.mtimeNs, info.ctimeNs].join(
          ":",
        );
      };
      const add = (mapped: string, hash: string) => {
        expected.set(mapped, { hash, stamp: mappedStamp(mapped, hash) });
      };
      for (const root of [
        pins.mappedSourceDirectory,
        pins.mappedInstalledDirectory,
      ]) {
        const names: string[] = [];
        for (const name of sourceMappedFiles(root, names))
          add(path.join(root, ...name.split("/")), pins.installedFiles[name]!);
        for (const directory of names)
          directories.set(directory, directoryStamp(directory));
      }
      add(pins.mappedNativePython, pins.nativePythonSha256);
      add(pins.mappedExecutable, pins.executableSha256);
      for (const file of files) {
        reference(file);
        const mapped = pins.mappedOriginalPaths[file.nativePath];
        if (!mapped)
          throw new Error("Original native/mapped reference unavailable");
        add(mapped, file.sha256);
      }
      let revoked = false;
      return () => {
        if (revoked) throw new Error("Mapped snapshot fence revoked");
        try {
          const currentDirectories: string[] = [];
          sourceMappedFiles(pins.mappedSourceDirectory, currentDirectories);
          sourceMappedFiles(pins.mappedInstalledDirectory, currentDirectories);
          if (
            [...new Set(currentDirectories)].sort().join("\0") !==
            [...directories.keys()].sort().join("\0")
          )
            throw new Error("Mapped source directory inventory differs");
          for (const [directory, stamp] of directories)
            if (directoryStamp(directory) !== stamp)
              throw new Error("Mapped source directory identity changed");
          for (const [mapped, original] of expected)
            if (mappedStamp(mapped, original.hash) !== original.stamp)
              throw new Error("Mapped original file identity changed");
        } catch (error) {
          revoked = true;
          throw error;
        }
      };
    },
    async awaitReceipts(value) {
      const result = closed(
        await invoke("receipts", { process: inputProcess(value) }),
        ["entry", "returned"],
      );
      return {
        entry: file(result["entry"], pins.paths.entry),
        returned: file(result["returned"], pins.paths.returned),
      };
    },
  } satisfies ControlledNativeAdapter);
}

// Keep the local helper named process(...) separate from Node's environment.
function processEnv() {
  return { ...globalThis.process.env };
}

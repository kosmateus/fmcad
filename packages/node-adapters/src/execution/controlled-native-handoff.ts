import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { isDeepStrictEqual as same } from "node:util";
import { decodeAdmissionJson } from "./admission-json";
import { bootstrapInstalledFilesDigest } from "./bootstrap-entry-evidence";
import { ControlledFusionNativeError } from "./controlled-fusion-launch";
import { controlledNativeHandoffProgram } from "./controlled-native-handoff-program";
import type {
  ControlledFile,
  ControlledLaunch,
  ControlledProcess,
} from "./controlled-fusion-launch-types";

export interface QualifiedHandoffPackage {
  readonly directory: string;
  readonly source: string;
  readonly build: string;
  readonly files: Readonly<Record<string, string>>;
}
export interface ControlledNativeHandoffOptions {
  readonly nativePython: string;
  readonly mappedNativePython: string;
  readonly nativePythonSha256: string;
  readonly helperDirectory: string;
  readonly mappedHelperDirectory: string;
  readonly mappedInstalledDirectory: string;
  readonly manifest: {
    readonly nativePath: string;
    readonly mappedPath: string;
    readonly sha256: string;
  };
  readonly qualified: QualifiedHandoffPackage;
  /** Complete, authenticated ROOT discovery closure, never caller flags. */
  readonly allDiscoveryRoots: readonly string[];
  readonly old: ControlledProcess;
  readonly nextGeneration: {
    readonly instance: string;
    readonly epoch: string;
  };
  readonly expectedProvisionSha256: string;
  readonly executable: string;
  readonly executableSha256: string;
  readonly paths: {
    readonly stage: string;
    readonly backup: string;
    readonly installClosure: string;
    readonly installReceipt: string;
    readonly provision: string;
    readonly provisionBackup: string;
    readonly rebindReceipt: string;
    readonly database: string;
    readonly launchJournal: string;
    readonly launchAttempt: string;
  };
  readonly mappedPaths: Readonly<Record<string, string>>;
  readonly heldLease: {
    assertCurrent(): Promise<void>;
    /** Actual synchronous owner/generation/revocation guard, not OS polling. */
    fence(): void;
  };
}
export interface NativeRebindWitness {
  readonly process: ControlledProcess;
  readonly reference: ControlledFile;
  assertCurrent(): Promise<void>;
  fence(): void;
}
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function record(
  value: unknown,
  keys?: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Closed native handoff object required");
  const result = value as Record<string, unknown>;
  if (keys && Object.keys(result).sort().join() !== [...keys].sort().join())
    throw new Error("Native handoff fields differ");
  return result;
}
function nativePath(value: string): string {
  if (
    !/^[a-z]:\\/i.test(value) ||
    path.win32.normalize(value) !== value ||
    value.includes("\0")
  )
    throw new Error("Canonical local Windows path required");
  return value.toLowerCase();
}
function below(root: string, name: string): boolean {
  const relative = path.win32.relative(nativePath(root), nativePath(name));
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith("..\\") &&
      !path.win32.isAbsolute(relative))
  );
}
function processTuple(value: ControlledProcess) {
  if (
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    !/^[0-9]+$/.test(value.birth) ||
    Object.keys(value).sort().join() !== "birth,pid"
  )
    throw new Error("Exact native process tuple required");
  return { pid: value.pid, birth: value.birth };
}
function reference(value: ControlledFile) {
  if (
    !digest(value.sha256) ||
    hash(value.bytes) !== value.sha256 ||
    !value.identity
  )
    throw new Error("Original private bytes required");
  return {
    nativePath: value.nativePath,
    sha256: value.sha256,
    identity: value.identity,
  };
}
function detached(file: ControlledFile): ControlledFile {
  return Object.freeze({ ...file, bytes: Buffer.from(file.bytes) });
}
function sync(fence: () => void) {
  const result: unknown = fence();
  if (result !== undefined) {
    void Promise.resolve(result).catch(() => {});
    throw new Error(
      "Native handoff fence must be synchronous, not a Promise/flag",
    );
  }
}

/**
 * Concrete private ROOT ports. No public invocation may construct this factory.
 * A successful DTO/digest is NOT authority: the held lease, qualified package,
 * original controlled-launch object and existing native baseline remain required.
 * No mutation is retried; incomplete installs/rebinds preserve their artifacts.
 */
export function createControlledFusionNativeHandoff(
  options: ControlledNativeHandoffOptions,
) {
  const { heldLease, ...data } = options;
  const pins = structuredClone(data);
  processTuple(pins.old);
  for (const name of [
    pins.nativePython,
    pins.helperDirectory,
    pins.qualified.directory,
    pins.manifest.nativePath,
    pins.executable,
    ...pins.allDiscoveryRoots,
    ...Object.values(pins.paths),
  ])
    nativePath(name);
  if (
    !digest(pins.nativePythonSha256) ||
    !digest(pins.manifest.sha256) ||
    !digest(pins.executableSha256) ||
    !digest(pins.expectedProvisionSha256) ||
    !/^[a-f0-9]{40}$/.test(pins.qualified.source) ||
    bootstrapInstalledFilesDigest(pins.qualified.files) !==
      pins.qualified.build ||
    !pins.nextGeneration.instance ||
    !pins.nextGeneration.epoch ||
    !pins.allDiscoveryRoots.length ||
    !pins.allDiscoveryRoots.some((root) =>
      below(root, pins.qualified.directory),
    )
  )
    throw new Error("Trusted complete qualified handoff pins required");
  const names = Object.keys(pins.qualified.files);
  if (
    names.length !== 100 ||
    names.some(
      (name) =>
        !digest(pins.qualified.files[name]) ||
        name.includes("\\") ||
        name.includes(":") ||
        path.posix.normalize(name) !== name ||
        name.startsWith("/") ||
        name.split("/").some((part) => part === ".." || part === "."),
    ) ||
    ![
      "AutodeskFusionMCP.py",
      "addon_runtime.py",
      "lib/bootstrap_entry.py",
    ].every((name) => names.includes(name))
  )
    throw new Error("Complete qualified 100-file package required");
  for (const root of pins.allDiscoveryRoots)
    for (const outside of [
      pins.helperDirectory,
      pins.paths.stage,
      pins.paths.backup,
    ])
      if (below(root, outside))
        throw new Error(
          "Qualified input/staging/backup must be outside ALL discovery roots",
        );
  if (
    new Set(Object.values(pins.paths).map(nativePath)).size !==
      Object.keys(pins.paths).length ||
    path.win32.parse(pins.paths.backup).root.toLowerCase() !==
      path.win32.parse(pins.qualified.directory).root.toLowerCase() ||
    path.win32.parse(pins.paths.stage).root.toLowerCase() !==
      path.win32.parse(pins.qualified.directory).root.toLowerCase()
  )
    throw new Error("Disjoint same-volume atomic handoff paths required");
  for (const original of [
    pins.executable,
    pins.manifest.nativePath,
    pins.paths.installClosure,
    pins.paths.installReceipt,
    pins.paths.provision,
    pins.paths.provisionBackup,
    pins.paths.rebindReceipt,
    pins.paths.launchJournal,
    pins.paths.launchAttempt,
  ])
    if (!path.isAbsolute(pins.mappedPaths[original] ?? ""))
      throw new Error("Trusted original native/mapped path required");
  const snapshot = (value: unknown): ControlledFile => {
    const row = record(value, ["nativePath", "sha256", "identity", "base64"]);
    if (
      typeof row["nativePath"] !== "string" ||
      !pins.mappedPaths[row["nativePath"]] ||
      !digest(row["sha256"]) ||
      typeof row["identity"] !== "string" ||
      typeof row["base64"] !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        row["base64"],
      )
    )
      throw new Error("Original native snapshot malformed");
    const bytes = Buffer.from(row["base64"], "base64");
    if (hash(bytes) !== row["sha256"])
      throw new Error("Original native snapshot bytes differ");
    return Object.freeze({
      nativePath: row["nativePath"],
      sha256: row["sha256"],
      identity: row["identity"],
      bytes,
    });
  };
  async function invoke(action: string, input: unknown): Promise<unknown> {
    await heldLease.assertCurrent();
    sync(() => heldLease.fence());
    if (
      hash(fs.readFileSync(pins.mappedNativePython)) !==
        pins.nativePythonSha256 ||
      hash(fs.readFileSync(pins.mappedPaths[pins.executable]!)) !==
        pins.executableSha256 ||
      hash(fs.readFileSync(pins.manifest.mappedPath)) !== pins.manifest.sha256
    )
      throw new ControlledFusionNativeError(
        action,
        "",
        "Native interpreter/original manifest differs",
      );
    const raw = await new Promise<{ stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(
          pins.mappedNativePython,
          ["-I", "-S", "-B", "-c", controlledNativeHandoffProgram],
          {
            cwd: pins.mappedHelperDirectory,
            env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        let stdout = "",
          stderr = "",
          overflow = false;
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (text: string) => {
          if (stdout.length + text.length > 16 * 1024 * 1024) overflow = true;
          else stdout += text;
        });
        child.stderr.on("data", (text: string) => {
          if (stderr.length + text.length > 1024 * 1024) overflow = true;
          else stderr += text;
        });
        child.on("error", () =>
          reject(new ControlledFusionNativeError(action, stdout, stderr)),
        );
        child.stdin.on("error", () => {
          /* terminal close owns outcome, never resend */
        });
        child.on("close", (code) =>
          code === 0 && !overflow
            ? resolve({ stdout, stderr })
            : reject(new ControlledFusionNativeError(action, stdout, stderr)),
        );
        child.stdin.end(JSON.stringify({ pins, action, input }));
      },
    );
    await heldLease.assertCurrent();
    sync(() => heldLease.fence());
    try {
      const envelope = record(decodeAdmissionJson(raw.stdout), [
        "kind",
        "action",
        "result",
      ]);
      if (
        envelope["kind"] !== "controlled-native-handoff-v1" ||
        envelope["action"] !== action
      )
        throw new Error("Foreign native handoff response");
      return envelope["result"];
    } catch {
      throw new ControlledFusionNativeError(action, raw.stdout, raw.stderr);
    }
  }
  let installAttempted = false,
    rebindAttempted = false;
  let installation:
    { receipt: ControlledFile; closure: ControlledFile } | undefined;
  const witnesses = new WeakMap<
    NativeRebindWitness,
    {
      launch: ControlledLaunch;
      receipt: ControlledFile;
      backup: ControlledFile;
      provision: ControlledFile;
      revoked: boolean;
    }
  >();
  function checkInput(input: {
    old: ControlledProcess;
    qualifiedPackagePins: QualifiedHandoffPackage;
  }) {
    if (
      !same(processTuple(input.old), pins.old) ||
      !same(input.qualifiedPackagePins, pins.qualified)
    )
      throw new Error("Current original old tuple/qualified package differs");
  }
  function capture(files: readonly ControlledFile[]): () => void {
    const stamp = (name: string, expected: string) => {
      const before = fs.lstatSync(name, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink())
        throw new Error("Mapped original file required");
      const fd = fs.openSync(
        name,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
      );
      try {
        const opened = fs.fstatSync(fd, { bigint: true });
        const bytes = fs.readFileSync(fd);
        const after = fs.fstatSync(fd, { bigint: true }),
          current = fs.lstatSync(name, { bigint: true });
        const key = (s: typeof opened) =>
          [s.dev, s.ino, s.mode, s.nlink, s.size, s.mtimeNs, s.ctimeNs].join(
            ":",
          );
        if (
          key(before) !== key(opened) ||
          key(opened) !== key(after) ||
          key(after) !== key(current) ||
          hash(bytes) !== expected
        )
          throw new Error("Mapped current bytes/FD identity differs");
        return key(after);
      } finally {
        fs.closeSync(fd);
      }
    };
    const entries = new Map<string, { hash: string; identity: string }>();
    const directories = new Map<string, string>();
    const directoryStamp = (name: string) => {
      const stat = fs.lstatSync(name, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("Mapped source directory differs");
      return [stat.dev, stat.ino, stat.mode, stat.mtimeNs, stat.ctimeNs].join(
        ":",
      );
    };
    const add = (name: string, sha: string) =>
      entries.set(name, { hash: sha, identity: stamp(name, sha) });
    const tree = (root: string, remember = false) => {
      const found: string[] = [];
      const currentDirectories: string[] = [];
      const visit = (directory: string) => {
        if (fs.lstatSync(directory).isSymbolicLink())
          throw new Error("Mapped source alias");
        currentDirectories.push(directory);
        if (remember) directories.set(directory, directoryStamp(directory));
        else if (directories.get(directory) !== directoryStamp(directory))
          throw new Error("Mapped source directory identity changed");
        for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
          const name = path.join(directory, item.name);
          if (item.isDirectory()) visit(name);
          else if (item.isFile())
            found.push(path.relative(root, name).split(path.sep).join("/"));
          else throw new Error("Mapped source special file");
        }
      };
      visit(root);
      if (!same(found.sort(), [...names].sort()))
        throw new Error("Mapped full manifest differs");
      if (
        !remember &&
        currentDirectories.length !==
          [...directories.keys()].filter(
            (name) => name === root || name.startsWith(root + path.sep),
          ).length
      )
        throw new Error("Mapped source directory inventory differs");
      return found;
    };
    for (const root of [
      pins.mappedHelperDirectory,
      pins.mappedInstalledDirectory,
    ])
      for (const name of tree(root, true))
        add(path.join(root, ...name.split("/")), pins.qualified.files[name]!);
    add(pins.mappedNativePython, pins.nativePythonSha256);
    add(pins.mappedPaths[pins.executable]!, pins.executableSha256);
    add(pins.manifest.mappedPath, pins.manifest.sha256);
    for (const file of files) {
      const mapped = pins.mappedPaths[file.nativePath];
      if (!mapped) throw new Error("Mapped original unavailable");
      add(mapped, file.sha256);
    }
    // Deliberately no live database or queue-state entry in this lifetime fence.
    return () => {
      tree(pins.mappedHelperDirectory);
      tree(pins.mappedInstalledDirectory);
      for (const [name, original] of entries)
        if (stamp(name, original.hash) !== original.identity)
          throw new Error("Mapped original identity changed");
    };
  }
  async function assertOriginalRebindWitness(witness: NativeRebindWitness) {
    const original = witnesses.get(witness);
    if (!original || original.revoked || !installation)
      throw new Error("Original private native rebind witness required");
    try {
      if (
        (await invoke("assert-current", {
          launch: {
            process: original.launch.process,
            journal: reference(original.launch.journal),
          },
          receipt: reference(original.receipt),
          backup: reference(original.backup),
          provision: reference(original.provision),
          installReceipt: reference(installation.receipt),
          installClosure: reference(installation.closure),
        })) !== null
      )
        throw new Error("Native current assertion malformed");
    } catch (error) {
      original.revoked = true;
      throw error;
    }
  }
  return Object.freeze({
    assertOriginalRebindWitness,
    async qualifyNativeInstallationAfterDeath(input: {
      old: ControlledProcess;
      qualifiedPackagePins: QualifiedHandoffPackage;
    }): Promise<ControlledFile> {
      if (installAttempted)
        throw new Error("Native install cannot be replayed");
      installAttempted = true;
      checkInput(input);
      const result = record(await invoke("install", {}), [
        "receipt",
        "closure",
      ]);
      const completed = {
        receipt: snapshot(result["receipt"]),
        closure: snapshot(result["closure"]),
      };
      if (
        completed.receipt.nativePath !== pins.paths.installReceipt ||
        completed.closure.nativePath !== pins.paths.installClosure
      )
        throw new Error("Original installation references differ");
      const body = record(
        decodeAdmissionJson(
          Buffer.from(completed.receipt.bytes).toString("utf8"),
        ),
      );
      if (
        body["kind"] !== "controlled-native-install-receipt-v1" ||
        body["authority"] !== "NONE" ||
        !same(body["qualified"], pins.qualified) ||
        !same(body["oldProcess"], pins.old) ||
        !same(body["originals"], reference(completed.closure))
      )
        throw new Error("Original installation receipt fields differ");
      installation = completed;
      return detached(installation.receipt);
    },
    async rebindNative(input: {
      old: ControlledProcess;
      launched: ControlledLaunch;
      qualifiedPackagePins: QualifiedHandoffPackage;
    }): Promise<NativeRebindWitness> {
      if (rebindAttempted || !installation)
        throw new Error(
          "Original completed install and one native rebind required",
        );
      rebindAttempted = true;
      checkInput(input);
      const launch: ControlledLaunch = {
        ...input.launched,
        process: processTuple(input.launched.process),
        journal: {
          ...input.launched.journal,
          bytes: Buffer.from(input.launched.journal.bytes),
        },
        attempt: detached(input.launched.attempt),
        sourceClosure: detached(input.launched.sourceClosure),
      };
      if (
        launch.journal.nativePath !== pins.paths.launchJournal ||
        launch.attempt.nativePath !== pins.paths.launchAttempt
      )
        throw new Error("Original private launch paths differ");
      const common = {
        launch: { process: launch.process, journal: reference(launch.journal) },
        installReceipt: reference(installation.receipt),
        installClosure: reference(installation.closure),
      };
      const prepared = record(await invoke("prepare-rebind", common), [
        "provision",
        "database",
      ]);
      snapshot(prepared["provision"]);
      const database = record(prepared["database"], [
        "nativePath",
        "sha256",
        "identity",
      ]);
      if (
        database["nativePath"] !== pins.paths.database ||
        !digest(database["sha256"]) ||
        typeof database["identity"] !== "string"
      )
        throw new Error("Original quiescent database snapshot differs");
      const result = record(
        await invoke("commit-rebind", { ...common, prepared }),
        ["receipt", "backup", "provision"],
      );
      const receipt = snapshot(result["receipt"]),
        backup = snapshot(result["backup"]),
        provision = snapshot(result["provision"]);
      if (
        receipt.nativePath !== pins.paths.rebindReceipt ||
        backup.nativePath !== pins.paths.provisionBackup ||
        provision.nativePath !== pins.paths.provision
      )
        throw new Error("Original rebind references differ");
      const body = record(
        decodeAdmissionJson(Buffer.from(receipt.bytes).toString("utf8")),
      );
      if (
        body["kind"] !== "controlled-native-rebind-receipt-v1" ||
        body["authority"] !== "NONE" ||
        !same(body["affectedFields"], [
          "birth",
          "build",
          "epoch",
          "instance",
          "pid",
          "source",
        ]) ||
        !same(body["qualified"], pins.qualified) ||
        !same(body["oldProcess"], pins.old) ||
        !same(body["process"], launch.process) ||
        !same(body["nextGeneration"], pins.nextGeneration) ||
        !same(body["after"], reference(provision)) ||
        !same(body["backup"], reference(backup)) ||
        !same(body["databaseBefore"], body["databaseAfter"])
      )
        throw new Error("Original six-field rebind receipt differs");
      const local: { fence?: () => void } = {};
      const witness: NativeRebindWitness = Object.freeze({
        process: Object.freeze({ ...launch.process }),
        get reference() {
          return detached(receipt);
        },
        assertCurrent: async () => assertOriginalRebindWitness(witness),
        fence() {
          const original = witnesses.get(witness);
          if (!original || original.revoked || !local.fence)
            throw new Error("Native rebind witness revoked");
          try {
            sync(() => heldLease.fence());
            sync(local.fence);
            sync(() => heldLease.fence());
          } catch (error) {
            original.revoked = true;
            throw error;
          }
        },
      });
      witnesses.set(witness, {
        launch,
        receipt,
        backup,
        provision,
        revoked: false,
      });
      await assertOriginalRebindWitness(witness);
      local.fence = capture([
        receipt,
        backup,
        provision,
        installation.receipt,
        installation.closure,
        launch.journal,
        launch.attempt,
      ]);
      await assertOriginalRebindWitness(witness);
      witness.fence();
      return witness;
    },
  });
}

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  readdirSync,
  type BigIntStats,
  type Dirent,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface RuntimePathsOptions {
  readonly anchor: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  readonly config?: string;
  readonly temporaryRoot?: string;
}

function absoluteSetting(
  value: string | undefined,
  fallback: string,
  home: string,
): string {
  return value ? (isAbsolute(value) ? value : resolve(home, value)) : fallback;
}

/** Resolve from an executing module, never from the caller's working directory. */
export function findInstallationRoot(anchor: string): string {
  if (!isAbsolute(anchor)) throw new Error("Runtime anchor must be absolute");
  let directory = dirname(anchor);
  for (;;) {
    const manifest = join(directory, "package.json");
    if (existsSync(manifest)) {
      const data: unknown = JSON.parse(readFileSync(manifest, "utf8"));
      if (
        data !== null &&
        typeof data === "object" &&
        "name" in data &&
        data.name === "fmcad"
      ) {
        return directory;
      }
    }
    const parent = dirname(directory);
    if (parent === directory)
      throw new Error(`Cannot locate fmcad installation from ${anchor}`);
    directory = parent;
  }
}

export function resolveRuntimePaths(options: RuntimePathsOptions) {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const installation = findInstallationRoot(options.anchor);
  const configHome = absoluteSetting(
    env["XDG_CONFIG_HOME"],
    join(home, ".config"),
    home,
  );
  const selected = options.config ?? env["FMCAD_CONFIG"];
  const config = selected
    ? isAbsolute(selected)
      ? selected
      : resolve(configHome, selected)
    : join(configHome, "fmcad", "config.json");
  const state = join(
    absoluteSetting(env["XDG_STATE_HOME"], join(home, ".local", "state"), home),
    "fmcad",
  );
  const cache = join(
    absoluteSetting(env["XDG_CACHE_HOME"], join(home, ".cache"), home),
    "fmcad",
  );
  const data = join(
    absoluteSetting(env["XDG_DATA_HOME"], join(home, ".local", "share"), home),
    "fmcad",
  );
  const assets = existsSync(join(installation, "assets"))
    ? join(installation, "assets")
    : join(installation, "dist", "assets");
  const runtime = existsSync(join(installation, "dist", "runtime", "python"))
    ? join(installation, "dist", "runtime", "python")
    : join(installation, "runtime", "python");
  return {
    installation,
    assets,
    runtime,
    formatter: existsSync(
      join(installation, "scripts", "console-source-format.py"),
    )
      ? join(installation, "scripts", "console-source-format.py")
      : join(installation, "dist", "scripts", "console-source-format.py"),
    config,
    state,
    cache,
    data,
    scripts: join(dirname(config), "scripts"),
    temporaryRoot: options.temporaryRoot ?? tmpdir(),
  };
}

export type RuntimePaths = ReturnType<typeof resolveRuntimePaths>;

/** Explicit project input is required: results must not follow incidental cwd. */
export function projectResultsPath(project: string): string {
  if (!isAbsolute(project)) throw new Error("Project path must be absolute");
  return join(project, ".cad", "results");
}

export function createPrivateDiagnosticsDirectory(paths: RuntimePaths): string {
  mkdirSync(paths.temporaryRoot, { recursive: true });
  return mkdtempSync(join(paths.temporaryRoot, "fmcad-diagnostics-"));
}

export type ChildEntrypoint =
  "queue-worker" | "queue-autostart-worker" | "queue-broker";

export function resolveChildEntrypoint(
  paths: RuntimePaths,
  name: ChildEntrypoint,
): string {
  // The built artifact takes precedence; source launchers remain transitional.
  const directories = existsSync(join(paths.installation, "dist", "processes"))
    ? ["dist/processes"]
    : ["src", "dist/src"];
  for (const directory of directories) {
    const file = join(paths.installation, directory, `${name}.js`);
    if (existsSync(file)) return file;
  }
  throw new Error(`Missing installed fmcad child entrypoint: ${name}`);
}

/** Fingerprint actual executable bytes, including Python/assets, not checkout metadata. */
export function runtimeBuildIdentity(paths: RuntimePaths): string {
  const hash = createHash("sha256");
  const directories = existsSync(join(paths.installation, "dist", "processes"))
    ? [
        "dist",
        relative(paths.installation, paths.assets),
        relative(paths.installation, paths.runtime),
        "bin",
        "scripts/console-source-format.py",
      ]
    : [
        "bin",
        "src",
        "assets",
        "runtime",
        "dist/runtime",
        "scripts/console-source-format.py",
      ];
  const visited = new Set<string>();
  const buffer = Buffer.allocUnsafe(512 * 1024);
  const reject = (file: string): never => {
    throw Object.assign(
      new Error(
        `Runtime identity input is a symlink or changed during reading: ${file}`,
      ),
      { code: "UNPINNED_BUILD" },
    );
  };
  const stableFile = (before: BigIntStats, after: BigIntStats) =>
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.nlink === after.nlink &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs;
  const excluded = (file: string) =>
    file.endsWith(".map") ||
    file.endsWith(".d.ts") ||
    file.endsWith(".pyc") ||
    file.endsWith(".pyo");
  const entries = (file: string) =>
    readdirSync(file, { withFileTypes: true })
      .filter((entry) => entry.name !== "__pycache__")
      .sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
      );
  const entryKind = (entry: Dirent) =>
    entry.isDirectory()
      ? "directory"
      : entry.isFile()
        ? "file"
        : entry.isSymbolicLink()
          ? "symlink"
          : "other";
  function hashFile(file: string, name: string, pinnedParent: boolean): void {
    let fd: number | undefined;
    try {
      const expected = constants.O_NOFOLLOW
        ? undefined
        : lstatSync(file, { bigint: true });
      if (expected && !expected.isFile()) reject(file);
      fd = openSync(
        file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile() || (expected && !stableFile(expected, before)))
        reject(file);
      if (
        process.platform === "linux" &&
        !pinnedParent &&
        readlinkSync(`/proc/self/fd/${fd}`) !== resolve(file)
      )
        reject(file);
      hash.update(name + "\0");
      let remaining = Number(before.size);
      if (!Number.isSafeInteger(remaining) || remaining < 0) reject(file);
      while (remaining > 0) {
        const requested = Math.min(remaining, buffer.length);
        const read = readSync(fd, buffer, 0, requested, null);
        if (!read) reject(file);
        hash.update(buffer.subarray(0, read));
        remaining -= read;
      }
      if (!stableFile(before, fstatSync(fd, { bigint: true }))) reject(file);
      hash.update("\0");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") reject(file);
      throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  function visit(
    file: string,
    hint?: Dirent,
    input = file,
    name = relative(paths.installation, file).split(sep).join("/"),
    pinnedParent = false,
  ): void {
    if (visited.has(file)) return;
    if (hint?.isSymbolicLink()) reject(file);
    // Dirent is only a traversal hint. O_NOFOLLOW + fstat authenticate the
    // opened regular file; every executable byte is read on every call.
    if (hint?.isFile() && !excluded(file)) {
      visited.add(file);
      hashFile(input, name, pinnedParent);
      return;
    }
    const stat = lstatSync(input, { bigint: true, throwIfNoEntry: false });
    if (!stat) return;
    visited.add(file);
    if (stat.isSymbolicLink()) reject(file);
    if (stat.isDirectory()) {
      let fd: number | undefined;
      try {
        // A Linux directory fd pins the parent used by every child open. A
        // racing parent symlink cannot redirect those reads outside this tree.
        if (process.platform === "linux") {
          fd = openSync(
            input,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          );
          if (!stableFile(stat, fstatSync(fd, { bigint: true }))) reject(file);
        }
        const directory = fd === undefined ? input : `/proc/self/fd/${fd}`;
        const original = entries(directory);
        for (const entry of original)
          visit(
            join(file, entry.name),
            entry,
            join(directory, entry.name),
            name ? name + "/" + entry.name : entry.name,
            fd !== undefined,
          );
        const after = lstatSync(input, { bigint: true });
        if (
          !after.isDirectory() ||
          after.dev !== stat.dev ||
          after.ino !== stat.ino ||
          after.mode !== stat.mode
        )
          reject(file);
        // All entries were enumerated in this invocation. Re-enumerate only to
        // resolve a mid-walk directory change; ignored __pycache__ churn must
        // not change the executable fingerprint.
        if (!stableFile(stat, after)) {
          const current = entries(directory);
          if (
            current.length !== original.length ||
            current.some(
              (entry, index) =>
                entry.name !== original[index]?.name ||
                entryKind(entry) !== entryKind(original[index]!),
            )
          )
            reject(file);
        }
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    } else if (stat.isFile()) {
      if (!excluded(file)) hashFile(input, name, pinnedParent);
    } else reject(file);
  }
  visit(join(paths.installation, "package.json"));
  for (const directory of directories)
    visit(join(paths.installation, directory));
  return hash.digest("hex");
}

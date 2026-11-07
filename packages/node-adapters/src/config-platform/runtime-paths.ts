import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
  function visit(file: string): void {
    if (!existsSync(file) || visited.has(file)) return;
    visited.add(file);
    const stat = lstatSync(file);
    if (stat.isSymbolicLink())
      throw Object.assign(
        new Error(`Runtime identity cannot follow symlink: ${file}`),
        { code: "UNPINNED_BUILD" },
      );
    if (stat.isDirectory()) {
      for (const entry of readdirSync(file).sort()) {
        if (entry !== "__pycache__") visit(join(file, entry));
      }
    } else if (
      stat.isFile() &&
      !file.endsWith(".map") &&
      !file.endsWith(".d.ts") &&
      !file.endsWith(".pyc") &&
      !file.endsWith(".pyo")
    ) {
      hash.update(relative(paths.installation, file).split(sep).join("/"));
      hash.update("\0");
      hash.update(readFileSync(file));
      hash.update("\0");
    }
  }
  visit(join(paths.installation, "package.json"));
  for (const directory of directories)
    visit(join(paths.installation, directory));
  return hash.digest("hex");
}

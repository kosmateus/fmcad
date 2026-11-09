import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid package record");
  return value as Record<string, unknown>;
}

/** Online setup only. Consumer tests still install and execute with --offline.
 * npm ci downloads locked tarballs but need not cache registry metadata used by
 * a fresh consumer resolving dependencies without the repository's root lock.
 * A disposable dependency-only install prepares both metadata and tarballs.
 */
export function prepareOfflineTestCache(root: string): void {
  const manifest = record(
    JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf8"),
    ) as unknown,
  );
  const dependencies = record(manifest["dependencies"]);
  const devDependencies = record(manifest["devDependencies"]);
  if (!Object.keys(dependencies).length)
    throw new Error("No runtime dependencies");
  const opencodeV1 = devDependencies["@opencode-ai/plugin"];
  if (typeof opencodeV1 !== "string" || !opencodeV1)
    throw new Error("Missing supported OpenCode V1 host dependency");
  const cacheDependencies = {
    ...dependencies,
    "@opencode-ai/plugin": opencodeV1,
  };
  const packageSpecs = Object.entries(cacheDependencies).map(
    ([name, version]) => {
      if (typeof version !== "string" || !version)
        throw new Error(`Invalid cache dependency: ${name}`);
      return `${name}@${version}`;
    },
  );
  const cache = process.env["npm_config_cache"];
  const cacheArgs = cache ? ["--cache", cache] : [];
  const directory = mkdtempSync(path.join(tmpdir(), "fmcad-consumer-cache-"));
  try {
    writeFileSync(
      path.join(directory, "package.json"),
      JSON.stringify({ private: true }),
    );
    execFileSync(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--no-save",
        ...cacheArgs,
        "--prefix",
        directory,
        ...packageSpecs,
      ],
      {
        cwd: directory,
        stdio: "inherit",
        timeout: 180_000,
      },
    );
    console.log("Prepared npm cache for offline consumer installation tests.");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (require.main === module)
  prepareOfflineTestCache(path.resolve(__dirname, "../../.."));

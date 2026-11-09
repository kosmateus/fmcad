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
  const runtimeDependencies = record(manifest["dependencies"]);
  if (!Object.keys(runtimeDependencies).length)
    throw new Error("No runtime dependencies");
  const developmentDependencies = record(manifest["devDependencies"]);
  const v1Host = developmentDependencies["@opencode-ai/plugin"];
  if (typeof v1Host !== "string" || !v1Host)
    throw new Error("Missing supported OpenCode V1 host dependency");
  // The installed V1 object-loader test resolves this optional host package in
  // its own consumer. Warm its metadata too; production dependencies are unchanged.
  const dependencies = {
    ...runtimeDependencies,
    "@opencode-ai/plugin": v1Host,
  };
  const directory = mkdtempSync(path.join(tmpdir(), "fmcad-consumer-cache-"));
  try {
    writeFileSync(
      path.join(directory, "package.json"),
      JSON.stringify({ private: true, dependencies }),
    );
    execFileSync(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--prefix",
        directory,
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

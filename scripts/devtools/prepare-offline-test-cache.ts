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
  if (!Object.keys(dependencies).length)
    throw new Error("No runtime dependencies");
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

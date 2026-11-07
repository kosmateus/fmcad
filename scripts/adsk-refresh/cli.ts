import { refresh, verifyCache, type ApiLock } from "./refresh.js";
import { readFile } from "node:fs/promises";
import path from "node:path";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (!(
    (args.length === 2 && (args[0] === "--full" || args[0] === "--dev")) ||
    (args.length === 3 && args[0] === "--pinned")
  ))
    throw new Error(
      "Usage: adsk-refresh --pinned LOCK OUTPUT | --full OUTPUT | --dev EXPLICIT_CACHE",
    );
  let lock: ApiLock | undefined;
  if (args[0] === "--pinned") {
    const value: unknown = JSON.parse(
      await readFile(path.resolve(args[1]!), "utf8"),
    );
    if (
      !value ||
      typeof value !== "object" ||
      !("commit" in value) ||
      !("snapshot" in value) ||
      typeof value.commit !== "string" ||
      typeof value.snapshot !== "string"
    )
      throw new Error("Invalid API lock file");
    lock = { commit: value.commit, snapshot: value.snapshot };
  }
  const root = path.resolve(args[args.length - 1]!);
  const manifest =
    args[0] === "--dev"
      ? (await verifyCache(root)).manifest
      : await refresh(root, undefined, undefined, lock);
  console.error(
    `${args[0] === "--dev" ? "Verified explicit cached" : "Refreshed"} adsk ${manifest.commit}; ${manifest.apiRelease}; Autodesk rights unverified`,
  );
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

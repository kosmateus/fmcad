import * as fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import type { verifyCache } from "../../scripts/adsk-refresh/refresh";
import { record } from "./contracts";

async function main(): Promise<void> {
  const root = path.resolve(__dirname, "../../..");
  const load = createRequire(path.join(root, "package.json"));
  const verifier = load("./dist/scripts/adsk-refresh/refresh") as {
    verifyCache: typeof verifyCache;
  };
  const cached = await verifier.verifyCache(
    path.join(root, "dist/runtime/python/typing"),
  );
  const lock = record(
    JSON.parse(
      fs.readFileSync(
        path.join(root, "scripts/adsk-refresh/api-lock.json"),
        "utf8",
      ),
    ) as unknown,
  );
  if (
    cached.manifest.commit !== lock["commit"] ||
    path.basename(cached.directory) !== lock["snapshot"]
  )
    throw new Error(
      "Verified API cache differs from the simulator's pinned contract",
    );
  const child = spawnSync(
    "python3",
    [
      "-B",
      path.join(root, "tests/support/fusion-simulator/verify_api.py"),
      cached.directory,
    ],
    { stdio: "inherit" },
  );
  if (child.error) throw child.error;
  if (child.status !== 0)
    throw new Error("Simulator API signature validation failed");
}
if (require.main === module)
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });

import { spawnSync } from "node:child_process";
import { join } from "node:path";

/** Used for compiler-owned programs and exact checker-side reconstruction. */
export function eraseRegisteredPython(
  root: string,
  typedSource: string,
): string {
  const result = spawnSync(
    "python3",
    [
      "-I",
      "-S",
      "-B",
      join(root, "runtime/python/entrypoints/erase_registered.py"),
    ],
    {
      input: JSON.stringify(typedSource),
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: Math.max(1024 * 1024, Buffer.byteLength(typedSource) * 4),
    },
  );
  if (result.error || result.status !== 0)
    throw new Error(
      "Registered Python erasure failed: " +
        (result.error?.message ?? result.stderr),
    );
  const source: unknown = JSON.parse(result.stdout);
  if (typeof source !== "string")
    throw new Error("Invalid erased Python result");
  return source;
}

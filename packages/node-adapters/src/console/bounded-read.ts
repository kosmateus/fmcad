import fs from "node:fs";
import type { ReadObservation } from "@fmcad/core";

/** No subprocess/SDK calls; nonregular sources and symlinks fail closed. */
export async function readBounded(
  file: string,
  limit: number,
): Promise<ReadObservation<Buffer>> {
  let handle: Awaited<ReturnType<typeof fs.promises.open>> | undefined;
  try {
    if (!Number.isSafeInteger(limit) || limit <= 0)
      throw new Error("Invalid source byte limit");
    handle = await fs.promises.open(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("Source must be a regular file");
    if (before.size > limit) throw new Error(`Source exceeds ${limit} bytes`);
    const bytes = Buffer.alloc(Math.min(limit + 1, before.size + 1));
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(
        bytes,
        length,
        bytes.length - length,
        null,
      );
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > limit) throw new Error(`Source exceeds ${limit} bytes`);
    const after = await handle.stat();
    const value = bytes.subarray(0, length);
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      return {
        status: "stale",
        value,
        observedAt: before.mtimeMs,
        reason: "Source changed during read",
      };
    return { status: "available", value, observedAt: before.mtimeMs };
  } catch (error) {
    return {
      status:
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "missing"
          : "error",
      value: null,
      observedAt: null,
      reason: error instanceof Error ? error.message : "Source unavailable",
    };
  } finally {
    await handle?.close();
  }
}
export async function readSource(file: string, limit: number): Promise<Buffer> {
  const result = await readBounded(file, limit);
  if (result.status !== "available")
    throw Object.assign(new Error(result.reason), {
      code: result.status === "missing" ? "ENOENT" : "SOURCE_UNAVAILABLE",
    });
  return result.value;
}

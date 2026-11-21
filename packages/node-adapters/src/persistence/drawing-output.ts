import type * as fs from "node:fs";

/** An exclusively created output belongs to this invocation until publication. */
export function publishDirectory<T>(
  directory: string,
  io: Pick<typeof fs, "mkdirSync" | "lstatSync" | "rmSync">,
  write: () => T,
): T {
  io.mkdirSync(directory, { recursive: false });
  const owner = io.lstatSync(directory);
  try {
    return write();
  } catch (original) {
    try {
      const current = io.lstatSync(directory);
      if (
        !current.isDirectory() ||
        current.dev !== owner.dev ||
        current.ino !== owner.ino
      )
        throw new Error("Drawing output ownership changed; cleanup deferred");
      io.rmSync(directory, { recursive: true, force: true });
    } catch (cleanup) {
      throw new AggregateError(
        [original, cleanup],
        "Drawing publication failed and cleanup is incomplete",
        { cause: original },
      );
    }
    throw original;
  }
}

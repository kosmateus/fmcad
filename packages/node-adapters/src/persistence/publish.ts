import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export async function withCleanup<T>(
  action: () => Promise<T>,
  cleanup: () => Promise<unknown>,
): Promise<T> {
  let primary: (Error & { cleanupErrors?: unknown[] }) | undefined;
  try {
    return await action();
  } catch (error) {
    primary = error as Error;
    throw error;
  } finally {
    try {
      await cleanup();
    } catch (error) {
      if (!primary) throw error;
      (primary.cleanupErrors ??= []).push(error);
      primary.message += `; cleanup failed: ${(error as Error).message}`;
    }
  }
}

export async function checkPublishTarget(
  target: string,
  io = fs,
): Promise<void> {
  const parent = path.dirname(target);
  if (!(await io.stat(parent)).isDirectory())
    throw new Error(`Output parent is not a directory: ${parent}`);
  await io.access(parent, fs.constants.W_OK | fs.constants.X_OK);
  try {
    await io.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Output already exists; refusing to replace: ${target}`);
}

export async function publishComplete(
  target: string,
  contents: string | Uint8Array,
  io = fs,
): Promise<void> {
  const parent = path.dirname(target);
  const temporary = path.join(parent, `.snapshot-${randomUUID()}`);
  const file = await io.open(temporary, "wx", 0o600);
  await withCleanup(
    async () => {
      await withCleanup(
        async () => {
          await file.writeFile(contents);
          await file.sync();
        },
        () => file.close(),
      );
      await io.link(temporary, target);
    },
    () => io.unlink(temporary),
  );
  const directory = await io.open(parent, "r");
  await withCleanup(
    () => directory.sync(),
    () => directory.close(),
  );
}

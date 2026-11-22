import * as fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

function refused(): never {
  throw Object.assign(
    new Error("Fresh checkpoint receipt could not be sealed"),
    {
      code: "STORAGE_UNAVAILABLE",
    },
  );
}

/** Only the live checkpoint-turn owner calls this after authentic release.
 * Authentication is repeated on the bytes from this descriptor, before chmod.
 * Historical readers never call this function. No bytes or inode are replaced. */
export function sealFreshCheckpointReceipt(
  input: {
    directory: string;
    jobId: string;
    rpcId: string;
    receiptPath: string;
    /** Synchronous, original turn/receipt authentication; not just JSON equality. */
    authenticateOriginal(bytes: Uint8Array): void;
  },
  io: typeof fs = fs,
): void {
  const descriptors: number[] = [];
  try {
    input = Object.freeze({ ...input });
    const root = path.resolve(input.directory);
    if (
      root !== input.directory ||
      io.realpathSync(root) !== root ||
      ![input.jobId, input.rpcId].every((id) =>
        /^[A-Za-z0-9_-]{1,256}$/.test(id),
      ) ||
      input.receiptPath !==
        path.join(root, "jobs", input.jobId, `remote-${input.rpcId}.json`)
    )
      refused();
    for (let parent = root; ; parent = path.dirname(parent)) {
      const stat = io.lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) refused();
      if (parent === path.dirname(parent)) break;
    }
    const uid = process.getuid?.();
    const identity = (stat: fs.Stats) => [stat.dev, stat.ino, stat.uid];
    const stamp = (stat: fs.Stats) => [
      ...identity(stat),
      stat.nlink,
      stat.size,
      stat.mtimeMs,
      stat.ctimeMs,
      stat.mode,
    ];
    const privateDirectory = (stat: fs.Stats) => {
      if (
        !stat.isDirectory() ||
        (stat.mode & 0o7777) !== 0o700 ||
        (uid !== undefined && stat.uid !== uid)
      )
        refused();
    };
    const chain: { named: string; fd: number }[] = [];
    const pinned = (fd: number, named: string) =>
      process.platform === "linux" ? `/proc/self/fd/${fd}` : named;
    let current = root;
    for (const component of ["", "jobs", input.jobId]) {
      const named = component ? path.join(current, component) : root;
      const opened = chain.length
        ? path.join(pinned(chain[chain.length - 1]!.fd, current), component)
        : root;
      const before = io.lstatSync(named);
      privateDirectory(before);
      const fd = io.openSync(
        opened,
        io.constants.O_RDONLY |
          io.constants.O_DIRECTORY |
          io.constants.O_NOFOLLOW |
          io.constants.O_NONBLOCK,
      );
      descriptors.push(fd);
      const actual = io.fstatSync(fd);
      privateDirectory(actual);
      if (!isDeepStrictEqual(identity(before), identity(actual))) refused();
      chain.push({ named, fd });
      current = named;
    }
    const parent = chain[chain.length - 1]!;
    const file = path.join(
      pinned(parent.fd, parent.named),
      `remote-${input.rpcId}.json`,
    );
    const before = io.lstatSync(input.receiptPath);
    const fileStat = (stat: fs.Stats, final = false) => {
      const mode = stat.mode & 0o7777;
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        (uid !== undefined && stat.uid !== uid) ||
        (mode !== 0o600 && (final || mode !== 0o644)) ||
        !Number.isSafeInteger(stat.size) ||
        stat.size <= 0 ||
        stat.size > 16 * 1024 * 1024
      )
        refused();
    };
    fileStat(before);
    const fd = io.openSync(
      file,
      io.constants.O_RDONLY | io.constants.O_NOFOLLOW | io.constants.O_NONBLOCK,
    );
    descriptors.push(fd);
    const opened = io.fstatSync(fd);
    fileStat(opened);
    if (!isDeepStrictEqual(stamp(before), stamp(opened))) refused();
    const checkPaths = (
      finalMode = false,
      verifiedStamp?: readonly number[],
    ) => {
      for (const entry of chain) {
        const named = io.lstatSync(entry.named),
          actual = io.fstatSync(entry.fd);
        privateDirectory(named);
        privateDirectory(actual);
        if (!isDeepStrictEqual(identity(named), identity(actual))) refused();
      }
      const named = io.lstatSync(input.receiptPath),
        actual = io.fstatSync(fd);
      fileStat(named, finalMode);
      fileStat(actual, finalMode);
      if (
        !isDeepStrictEqual(stamp(named), stamp(actual)) ||
        !isDeepStrictEqual(identity(actual), identity(opened)) ||
        (verifiedStamp !== undefined &&
          !isDeepStrictEqual(stamp(actual), verifiedStamp))
      )
        refused();
    };
    const bytes = () => {
      const buffer = Buffer.alloc(opened.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = io.readSync(
          fd,
          buffer,
          length,
          buffer.length - length,
          length,
        );
        if (count === 0) break;
        length += count;
      }
      if (length !== opened.size) refused();
      return buffer.subarray(0, length);
    };
    checkPaths();
    const original = bytes();
    const digest = createHash("sha256").update(original).digest("hex");
    const authentication: unknown = input.authenticateOriginal(
      Buffer.from(original),
    );
    if (authentication !== undefined) {
      void Promise.resolve(authentication).catch(() => {});
      refused();
    }
    checkPaths();
    if (
      !isDeepStrictEqual(stamp(io.fstatSync(fd)), stamp(opened)) ||
      createHash("sha256").update(bytes()).digest("hex") !== digest
    )
      refused();
    io.fchmodSync(fd, 0o600);
    io.fsyncSync(fd);
    checkPaths();
    const final = io.fstatSync(fd);
    fileStat(final, true);
    const finalDigest = createHash("sha256").update(bytes()).digest("hex");
    const afterRead = io.fstatSync(fd);
    fileStat(afterRead, true);
    if (
      final.size !== opened.size ||
      final.mtimeMs !== opened.mtimeMs ||
      !isDeepStrictEqual(stamp(final), stamp(afterRead)) ||
      finalDigest !== digest
    )
      refused();
    checkPaths(true, stamp(afterRead));
  } catch {
    refused();
  } finally {
    let failed = false;
    for (const fd of descriptors.reverse()) {
      try {
        io.closeSync(fd);
      } catch {
        failed = true;
      }
    }
    if (failed) refused();
  }
}

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export interface RuntimeVerificationRealm {
  keyId: string;
  keyReference: { path: string; sha256: string };
}
const REALM = "runtime-verification";
const KEY = "verification.key";
const METADATA = "realm.json";
const PREFIX = "RUNTIME_VERIFICATION_REALM_";
type Problem = "MISSING" | "INCOMPLETE" | "UNSAFE" | "UNAVAILABLE";
function refuse(problem: Problem): never {
  // Never propagate filesystem/JSON errors, input values or secret bytes.
  throw Object.assign(
    new Error(`Runtime verification realm ${problem.toLowerCase()}`),
    {
      code: PREFIX + problem,
    },
  );
}
function missing(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
function identity(stat: fs.Stats) {
  return [stat.dev, stat.ino, stat.uid, stat.mode];
}
function stamp(stat: fs.Stats) {
  return [...identity(stat), stat.nlink, stat.size, stat.mtimeMs, stat.ctimeMs];
}
function privateStat(stat: fs.Stats, directory: boolean) {
  if (
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid!() ||
    (stat.mode & 0o7777) !== (directory ? 0o700 : 0o600) ||
    (!directory && stat.nlink !== 1)
  )
    refuse("UNSAFE");
  return stat;
}
interface Anchor {
  fd: number;
  named: string;
  pinned: string;
  original: fs.Stats;
}
function anchor(named: string, through = named): Anchor {
  const original = privateStat(fs.lstatSync(through), true);
  const fd = fs.openSync(
    through,
    fs.constants.O_RDONLY |
      fs.constants.O_DIRECTORY |
      fs.constants.O_NOFOLLOW |
      fs.constants.O_NONBLOCK,
  );
  try {
    const result = { fd, named, pinned: `/proc/self/fd/${fd}`, original };
    checkAnchor(result);
    return result;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}
function checkAnchor(directory: Anchor) {
  if (
    !isDeepStrictEqual(
      identity(privateStat(fs.fstatSync(directory.fd), true)),
      identity(directory.original),
    ) ||
    !isDeepStrictEqual(
      identity(privateStat(fs.lstatSync(directory.named), true)),
      identity(directory.original),
    ) ||
    fs.realpathSync(directory.pinned) !== directory.named
  )
    refuse("UNSAFE");
}
function metadata(digest: string) {
  return {
    kind: "fmcad-runtime-verification-realm",
    version: 1,
    keyId: `fmcad-rebaseline-${digest}`,
    sha256: digest,
  };
}
interface Opened {
  fd: number;
  named: string;
  original: fs.Stats;
}
function checkFile(file: Opened) {
  const actual = privateStat(fs.fstatSync(file.fd), false);
  if (
    !isDeepStrictEqual(stamp(actual), stamp(file.original)) ||
    !isDeepStrictEqual(
      stamp(privateStat(fs.lstatSync(file.named), false)),
      stamp(actual),
    )
  )
    refuse("UNSAFE");
}
function openFile(realm: Anchor, name: string): Opened {
  const named = path.join(realm.named, name);
  const before = privateStat(fs.lstatSync(named), false);
  const fd = fs.openSync(
    path.join(realm.pinned, name),
    fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW,
  );
  try {
    const result = { fd, named, original: before };
    checkFile(result);
    return result;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}
function bounded(file: Opened, minimum: number, maximum: number) {
  if (file.original.size < minimum || file.original.size > maximum)
    refuse("INCOMPLETE");
  const bytes = Buffer.alloc(file.original.size + 1);
  let count = 0;
  while (count < bytes.length) {
    const read = fs.readSync(file.fd, bytes, count, bytes.length - count, null);
    if (!read) break;
    count += read;
  }
  checkFile(file);
  if (count !== file.original.size) {
    bytes.fill(0);
    refuse("INCOMPLETE");
  }
  return bytes.subarray(0, count);
}
/** Exclusive creation only. A crash may leave an incomplete file; neither API
 * replaces it, rotates a key, discovers temporary entries or deletes anything. */
function createOnce(realm: Anchor, name: string, produce: () => Buffer) {
  const named = path.join(realm.named, name);
  let fd: number;
  try {
    fd = fs.openSync(
      path.join(realm.pinned, name),
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW |
        fs.constants.O_NONBLOCK,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw error;
  }
  let bytes: Buffer | undefined;
  try {
    const original = privateStat(fs.fstatSync(fd), false);
    if (
      original.size !== 0 ||
      !isDeepStrictEqual(
        stamp(original),
        stamp(privateStat(fs.lstatSync(named), false)),
      )
    )
      refuse("UNSAFE");
    checkAnchor(realm);
    bytes = produce();
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    const complete = privateStat(fs.fstatSync(fd), false);
    if (
      complete.size !== bytes.length ||
      !isDeepStrictEqual(identity(original), identity(complete)) ||
      !isDeepStrictEqual(
        stamp(complete),
        stamp(privateStat(fs.lstatSync(named), false)),
      )
    )
      refuse("UNSAFE");
    checkAnchor(realm);
  } finally {
    bytes?.fill(0);
    fs.closeSync(fd);
  }
}
function exists(named: string) {
  try {
    fs.lstatSync(named);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}
function access(store: string, initialize: boolean): RuntimeVerificationRealm {
  const opened: number[] = [];
  try {
    if (
      process.platform !== "linux" ||
      typeof process.getuid !== "function" ||
      typeof store !== "string" ||
      !path.isAbsolute(store) ||
      path.resolve(store) !== store ||
      fs.realpathSync(store) !== store
    )
      refuse("UNSAFE");
    const root = anchor(store);
    opened.push(root.fd);
    const realmName = path.join(store, REALM);
    if (initialize) {
      try {
        fs.mkdirSync(path.join(root.pinned, REALM), { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } else if (!exists(realmName)) refuse("MISSING");
    checkAnchor(root);
    // Never re-resolve the store path to open its child. A store rename/swap
    // after checkAnchor(root) must not select a different, foreign realm.
    const realm = anchor(realmName, path.join(root.pinned, REALM));
    opened.push(realm.fd);
    if (initialize) {
      // A metadata record without a key is never a reason to rotate/create one.
      const keyExisted = exists(path.join(realm.pinned, KEY));
      if (!keyExisted) {
        if (exists(path.join(realm.pinned, METADATA))) refuse("INCOMPLETE");
        createOnce(realm, KEY, () => randomBytes(32));
      }
      // If an observed existing key vanishes, the readonly open below refuses.
      // It must never fall through to O_CREAT and silently rotate the key.
    }
    if (!exists(path.join(realm.named, KEY))) refuse("INCOMPLETE");
    const key = openFile(realm, KEY);
    opened.push(key.fd);
    const bytes = bounded(key, 32, 32);
    let digest: string;
    try {
      digest = createHash("sha256").update(bytes).digest("hex");
    } finally {
      bytes.fill(0);
    }
    const expected = metadata(digest);
    if (initialize) {
      // Durable key and directory linkage precede metadata publication.
      fs.fsyncSync(key.fd);
      fs.fsyncSync(realm.fd);
      fs.fsyncSync(root.fd);
      checkFile(key);
      checkAnchor(realm);
      checkAnchor(root);
      createOnce(realm, METADATA, () => Buffer.from(JSON.stringify(expected)));
    }
    if (!exists(path.join(realm.named, METADATA))) refuse("INCOMPLETE");
    const record = openFile(realm, METADATA);
    opened.push(record.fd);
    const encoded = bounded(record, 1, 512);
    // The exact canonical schema rejects duplicate keys, extra fields, invalid
    // UTF-8 and malformed JSON without exposing parser fragments in errors.
    if (!encoded.equals(Buffer.from(JSON.stringify(expected))))
      refuse("INCOMPLETE");
    // Read opens only existing O_RDONLY FDs. fsync does not write file content
    // or change mtime, but is necessary before confirming concurrently visible
    // bytes: visibility alone does not prove the writer's directory fsync.
    fs.fsyncSync(key.fd);
    fs.fsyncSync(record.fd);
    fs.fsyncSync(realm.fd);
    fs.fsyncSync(root.fd);
    checkFile(key);
    checkFile(record);
    checkAnchor(realm);
    checkAnchor(root);
    return {
      keyId: expected.keyId,
      keyReference: { path: path.join(realmName, KEY), sha256: digest },
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === "string" && code.startsWith(PREFIX)) throw error;
    if (code === "ELOOP" || code === "ENOTDIR") refuse("UNSAFE");
    if (missing(error)) refuse("INCOMPLETE");
    return refuse("UNAVAILABLE");
  } finally {
    let failed = false;
    for (const fd of opened.reverse()) {
      try {
        fs.closeSync(fd);
      } catch {
        failed = true;
      }
    }
    if (failed) refuse("UNAVAILABLE");
  }
}

/** Explicit administrative provisioning only; never call during broker startup.
 * Establishes a local verification key, NOT native/Windows approval or a grant. */
export function initializeRuntimeVerificationRealm(
  store: string,
): RuntimeVerificationRealm {
  return access(store, true);
}
/** No mkdir, key generation, content writes, rename, unlink or automatic repair.
 * Missing/partial realms fail closed. Existing read-only FDs are fsynced before
 * returning a reference; key bytes are never returned. */
export function readRuntimeVerificationRealm(
  store: string,
): RuntimeVerificationRealm {
  return access(store, false);
}

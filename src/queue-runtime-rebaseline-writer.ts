import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import type { NativeRebaselineWriter } from "../packages/node-adapters/src/execution/runtime-rebaseline-native";
import { literalRuntimeHead } from "./queue-runtime-rebaseline";

const load = createRequire(__filename);
const { claimBrokerLifetime } = load(
  "./dist/node-adapters/execution/broker-lifetime",
) as typeof import("../packages/node-adapters/src/execution/broker-lifetime");
const { processBirth, priorProcessAlive, reclaim } = load(
  "./queue-instance",
) as ReturnType<
  typeof import("../packages/node-adapters/src/execution/queue-instance").createQueueInstance
>;
const { durable, readBytes, MAX_JSON_RECORD_BYTES } = load(
  "./dist/node-adapters/persistence/records",
) as typeof import("../packages/node-adapters/src/persistence/records");
const { decodeAdmissionJson } = load(
  "./dist/node-adapters/execution/admission-json",
) as typeof import("../packages/node-adapters/src/execution/admission-json");

export interface RuntimeRebaselineWriterOptions {
  readonly store: string;
  readonly buildHash: string;
  readonly configHash: string;
}
export interface RuntimeRebaselineWriterScope extends NativeRebaselineWriter {
  readonly generation: string;
  /** Computed only after the real claim and any supported Node-only reclaim. */
  readonly head: ReturnType<typeof literalRuntimeHead>;
  assertHeld(): void;
}
type Owner = {
  pid: number;
  birth: string;
  nonce: string;
  protocol: 2;
};
function failure(code: string): never {
  throw Object.assign(
    new Error("Administrative runtime writer is unavailable"),
    { code },
  );
}
function sanitized(error: unknown): Error & { code: string } {
  const publicCodes = new Set([
    "INVALID_RUNTIME_REBASELINE_WRITER",
    "UNSAFE_DIRECTORY",
    "UNSAFE_ARTIFACT",
    "RUNTIME_REBASELINE_WRITER_CHANGED",
    "RUNTIME_REBASELINE_PUBLICATION_PENDING",
    "RUNTIME_REBASELINE_WRITER_BUSY",
    "RUNTIME_REBASELINE_WRITER_CLOSED",
    "RUNTIME_REBASELINE_WRITER_RETAINED",
    "RUNTIME_REBASELINE_WRITER_FAILED",
    "BROKER_OWNER_UNPROVEN",
    "BROKER_ALIVE",
    "LOCK_CHANGED",
    "EIO",
    "ENOENT",
    "EEXIST",
    "EACCES",
    "EPERM",
    "ENOSPC",
    "EROFS",
  ]);
  const code =
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    publicCodes.has(error.code)
      ? error.code
      : "RUNTIME_REBASELINE_WRITER_FAILED";
  return Object.assign(
    new Error("Administrative runtime writer did not complete"),
    { code },
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** A real Node-only administrative claim, not a native provision/SDK grant.
 * The callback constructs native authority and reads expected head inside this
 * scope. No queue Domain, recovery callback, native transport or key port exists.
 * Fresh administrative operations only: an existing publication or dead
 * administrative publisher is retained and denied, not resumed. Authenticated
 * recovery of a real failed publication is outside this API. */
export async function withRuntimeRebaselineWriter<T>(
  options: RuntimeRebaselineWriterOptions,
  work: (writer: RuntimeRebaselineWriterScope) => Promise<T>,
): Promise<T> {
  let directoryFd: number | undefined, ownerFd: number | undefined;
  let active = false;
  try {
    if (
      process.platform !== "linux" ||
      !process.getuid ||
      !options ||
      !path.isAbsolute(options.store) ||
      path.resolve(options.store) !== options.store ||
      !/^[a-f0-9]{64}$/.test(options.buildHash) ||
      !/^[a-f0-9]{64}$/.test(options.configHash) ||
      typeof work !== "function"
    )
      failure("INVALID_RUNTIME_REBASELINE_WRITER");
    const store = options.store,
      uid = BigInt(process.getuid());
    const initial = fs.lstatSync(store, { bigint: true });
    function privateDirectory(stat: fs.BigIntStats) {
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.uid !== uid ||
        (stat.mode & 0o077n) !== 0n
      )
        failure("UNSAFE_DIRECTORY");
    }
    privateDirectory(initial);
    if (fs.realpathSync(store) !== store) failure("UNSAFE_DIRECTORY");
    directoryFd = fs.openSync(
      store,
      fs.constants.O_RDONLY |
        fs.constants.O_DIRECTORY |
        fs.constants.O_NOFOLLOW,
    );
    const anchored = `/proc/self/fd/${directoryFd}`;
    function assertDirectory() {
      const held = fs.fstatSync(directoryFd!, { bigint: true });
      const named = fs.lstatSync(store, { bigint: true });
      privateDirectory(held);
      privateDirectory(named);
      if (
        held.dev !== initial.dev ||
        held.ino !== initial.ino ||
        named.dev !== initial.dev ||
        named.ino !== initial.ino ||
        fs.realpathSync(anchored) !== store ||
        fs.realpathSync(store) !== store
      )
        failure("RUNTIME_REBASELINE_WRITER_CHANGED");
    }
    function optional(name: string): Buffer | null {
      assertDirectory();
      const file = path.join(anchored, name);
      let info: fs.BigIntStats;
      try {
        info = fs.lstatSync(file, { bigint: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.uid !== uid ||
        (info.mode & 0o077n) !== 0n
      )
        failure("UNSAFE_ARTIFACT");
      const bytes = readBytes(
        file,
        MAX_JSON_RECORD_BYTES,
        fs,
        path.join(store, name),
      );
      assertDirectory();
      return bytes;
    }
    function absent(name: string) {
      assertDirectory();
      try {
        fs.lstatSync(path.join(anchored, name));
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
        throw error;
      }
    }
    function requireNoPublication() {
      if (!absent("runtime-rebaseline-publication.json"))
        failure("RUNTIME_REBASELINE_PUBLICATION_PENDING");
    }
    assertDirectory();
    requireNoPublication();
    if (!absent("recovery.lock")) failure("RUNTIME_REBASELINE_WRITER_BUSY");
    const previousBytes = optional("broker.lock");
    if (previousBytes) {
      const previous = decodeAdmissionJson(previousBytes.toString("utf8"));
      if (
        !record(previous) ||
        previous["protocol"] !== 2 ||
        Object.keys(previous).sort().join(",") !== "birth,nonce,pid,protocol" ||
        !Number.isSafeInteger(previous["pid"]) ||
        Number(previous["pid"]) <= 0 ||
        typeof previous["birth"] !== "string" ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}:(?:0|[1-9]\d*)$/.test(
          previous["birth"],
        ) ||
        typeof previous["nonce"] !== "string" ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
          previous["nonce"],
        )
      )
        failure("BROKER_OWNER_UNPROVEN");
      const lifecycleBytes = optional(
        `broker-lifecycle-${previous["nonce"]}.json`,
      );
      if (lifecycleBytes) {
        const lifecycle = decodeAdmissionJson(lifecycleBytes.toString("utf8"));
        if (!record(lifecycle)) failure("BROKER_OWNER_UNPROVEN");
        if (String(lifecycle["stage"]).startsWith("runtime-rebaseline"))
          failure("RUNTIME_REBASELINE_WRITER_RETAINED");
      }
      const owner = previous as Owner;
      const alive = priorProcessAlive(owner);
      if (alive !== false)
        failure(alive === true ? "BROKER_ALIVE" : "BROKER_OWNER_UNPROVEN");
      assertDirectory();
      // Supported reclaim archives the exact dead Node owner. Deliberately omit
      // recoverCurrent: no legacy snapshot restoration or UNKNOWN settlement.
      reclaim(store);
      assertDirectory();
    }
    requireNoPublication();
    const lifetime = claimBrokerLifetime({
      // The actual exclusive link and final unlink use our held directory FD.
      dir: anchored,
      socket: path.join(store, "queue.sock"),
      buildHash: options.buildHash,
      configHash: options.configHash,
      processBirth,
      disposeClient() {},
    });
    const owner = lifetime.owner;
    const lockName = path.join(anchored, "broker.lock");
    ownerFd = fs.openSync(
      lockName,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    const ownerIdentity = fs.fstatSync(ownerFd, { bigint: true });
    const lifecycleName = `broker-lifecycle-${owner.nonce}.json`;
    const lifecycle = {
      owner,
      buildHash: options.buildHash,
      configHash: options.configHash,
      stage: "runtime-rebaseline",
      safeToRecover: false,
      store: {
        path: store,
        device: Number(initial.dev),
        inode: Number(initial.ino),
      },
    };
    function assertOwner() {
      assertDirectory();
      const held = fs.fstatSync(ownerFd!, { bigint: true });
      const named = fs.lstatSync(lockName, { bigint: true });
      if (
        !held.isFile() ||
        held.uid !== uid ||
        (held.mode & 0o077n) !== 0n ||
        named.isSymbolicLink() ||
        fs.realpathSync(`/proc/self/fd/${ownerFd}`) !==
          path.join(store, "broker.lock")
      )
        failure("RUNTIME_REBASELINE_WRITER_CHANGED");
      for (const key of ["dev", "ino", "size", "mtimeNs", "ctimeNs"] as const)
        if (
          held[key] !== ownerIdentity[key] ||
          named[key] !== ownerIdentity[key]
        )
          failure("RUNTIME_REBASELINE_WRITER_CHANGED");
      lifetime.assertOwner();
    }
    assertOwner();
    if (!absent("recovery.lock")) failure("RUNTIME_REBASELINE_WRITER_BUSY");
    // Durable before callback entry, hence before any native external action.
    durable(path.join(anchored, lifecycleName), lifecycle, true);
    active = true;
    function assertHeld() {
      if (!active) failure("RUNTIME_REBASELINE_WRITER_CLOSED");
      assertOwner();
      const bytes = optional(lifecycleName);
      if (
        !bytes ||
        !isDeepStrictEqual(
          decodeAdmissionJson(bytes.toString("utf8")),
          lifecycle,
        )
      )
        failure("RUNTIME_REBASELINE_WRITER_CHANGED");
    }
    assertHeld();
    const head = literalRuntimeHead(store);
    assertHeld();
    let innerActive = false;
    let innerFailed = false;
    const pending = new Set<Promise<unknown>>();
    const writer: RuntimeRebaselineWriterScope = Object.freeze({
      generation: owner.nonce,
      head: Object.freeze({
        ...head,
        manifest: Object.freeze({ ...head.manifest }),
      }),
      assertHeld,
      withExclusiveWriter<R>(
        invoke: (held: {
          readonly generation: string;
          assertHeld(): void;
        }) => Promise<R>,
      ): Promise<R> {
        assertHeld();
        if (innerActive) failure("RUNTIME_REBASELINE_WRITER_BUSY");
        innerActive = true;
        let leaseActive = true;
        const lease = Object.freeze({
          generation: owner.nonce,
          assertHeld() {
            if (!leaseActive) failure("RUNTIME_REBASELINE_WRITER_CLOSED");
            assertHeld();
          },
        });
        const task = (async () => {
          try {
            assertHeld();
            const value = await invoke(lease);
            assertHeld();
            return value;
          } catch (error) {
            innerFailed = true;
            throw error;
          } finally {
            leaseActive = false;
            innerActive = false;
          }
        })();
        pending.add(task);
        void task.finally(() => pending.delete(task)).catch(() => {});
        return task;
      },
    });
    const result = await work(writer);
    assertHeld();
    if (innerActive || pending.size) failure("RUNTIME_REBASELINE_WRITER_BUSY");
    if (innerFailed) failure("RUNTIME_REBASELINE_WRITER_FAILED");
    requireNoPublication();
    durable(path.join(anchored, lifecycleName), {
      ...lifecycle,
      stage: "runtime-rebaseline-complete",
      safeToRecover: true,
    });
    assertOwner();
    // Remains the original claimed lifetime: no initialize/provision/listen.
    lifetime.abortBeforeInitialize();
    active = false;
    return result;
  } catch (error) {
    // No failure/timeout/parent-death cleanup can remove this publisher's lock
    // or the independent native publication marker. No old outcome is retried.
    active = false;
    throw sanitized(error);
  } finally {
    if (ownerFd !== undefined) fs.closeSync(ownerFd);
    if (directoryFd !== undefined) fs.closeSync(directoryFd);
  }
}

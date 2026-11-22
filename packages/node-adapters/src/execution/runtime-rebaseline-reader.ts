import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { isDeepStrictEqual as same } from "node:util";
import { decodeAdmissionJson } from "./admission-json";
import { nativePhysicalGuard } from "./physical-generation-provision";
import type {
  NativePhysicalActivation,
  NativePhysicalGenerationProvisionOptions,
} from "./physical-generation-provision";
import type { PhysicalGenerationDescriptor } from "./physical-generation";
import {
  authenticateRuntimeConsumedReceipt,
  NativeRuntimeBarrierError,
  type NativeRebaselineReference,
  type NativeRuntimeActivationPublication,
  type NativeRuntimeActivationCompletion,
  type NativeRuntimeRebaselinePins,
} from "./runtime-rebaseline-native";
import { runtimeRebaselineManifestNames } from "../persistence/runtime-rebaseline-scope";

type Data = Record<string, unknown>;
export interface NativeRuntimeRebaselineReaderOptions {
  store: string;
  pins: NativeRuntimeRebaselinePins;
  runtimeVersion: string;
  native: Pick<
    NativePhysicalGenerationProvisionOptions,
    | "nativePython"
    | "mappedNativePython"
    | "nativePythonSha256"
    | "installedForkDirectory"
    | "mappedInstalledForkDirectory"
    | "installedPackageFiles"
    | "provisionPath"
    | "localAppData"
    | "nativePrivateDirectory"
    | "timeoutMs"
  >;
  publicationAuthority: {
    keyId: string;
    keyReference: NativeRebaselineReference;
    nativeOperatorFile: string;
  };
}
export interface NativeRuntimeRebaselineReaderPorts {
  store: string;
  pins: NativeRuntimeRebaselinePins;
  verifyConsumed(
    publication: NativeRuntimeActivationPublication,
    completion: NativeRuntimeActivationCompletion,
  ): Promise<void>;
  getVerifiedActivation(
    descriptor: PhysicalGenerationDescriptor,
  ): Promise<NativePhysicalActivation | undefined>;
}

/** Same verified operator bytes go directly to the supported private authority.
 * QUERY only: no retired-process requirement, artifact directory or request file. */
const queryScript = `${nativePhysicalGuard}
import stat
from lib.physical_authority import _read_private_bytes,_check_windows_acl
from lib.admission_json import decode_json
parent=Path(e["operatorFile"]).parent
info=parent.lstat()
if parent.resolve()!=parent or not stat.S_ISDIR(info.st_mode) or getattr(info,"st_file_attributes",0)&0x400:
    deny("NATIVE_OPERATOR_DIRECTORY_CHANGED")
_check_windows_acl(parent)
operator=decode_json(_read_private_bytes(Path(e["operatorFile"])).decode("utf-8"))
if Path(operator["database"]).resolve()!=Path(e["admissionStore"]).resolve():
    deny("NATIVE_ADMISSION_STORE_CHANGED")
expected_runtime={"handoffId":e["runtimePins"]["handoffId"],"generation":d["generation"],
                  "physicalRuntime":r,"endpointURL":e["runtimePins"]["endpoint"]}
if operator["runtime"]!=expected_runtime:
    deny("NATIVE_OPERATOR_RUNTIME_CHANGED")
verifier=operator["publicationVerifier"]
if verifier["keyId"]!=e["keyId"] or hashlib.sha256(bytes.fromhex(verifier["keyHex"])).hexdigest()!=e["keyDigest"]:
    deny("NATIVE_VERIFICATION_KEY_CHANGED")
from lib.rebaseline_fence import OperatorAuthority,query_fence
authority=OperatorAuthority(operator)
result=query_fence(authority,decode_json(e["requestJson"]))
print(json.dumps(result,sort_keys=True,ensure_ascii=True))
`;
const sha = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
function deny(): never {
  throw new NativeRuntimeBarrierError("RUNTIME_BARRIER_CHANGED");
}
function object(value: unknown): Data {
  if (!value || typeof value !== "object" || Array.isArray(value)) deny();
  return value as Data;
}
function privateDirectory(directory: string) {
  const info = fs.lstatSync(directory);
  if (
    !path.isAbsolute(directory) ||
    path.resolve(directory) !== directory ||
    fs.realpathSync(directory) !== directory ||
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    info.mode & 0o077
  )
    deny();
  return info;
}
function read(file: string, sync = false): Buffer {
  privateDirectory(path.dirname(file));
  if (fs.realpathSync(file) !== file) deny();
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.uid !== BigInt(process.getuid?.() ?? -1) ||
      before.mode & 0o077n ||
      before.size > 128n * 1024n * 1024n
    )
      deny();
    const value = fs.readFileSync(fd);
    if (sync) fs.fsyncSync(fd);
    const after = fs.fstatSync(fd, { bigint: true }),
      named = fs.lstatSync(file, { bigint: true });
    for (const key of ["dev", "ino", "size", "mtimeNs", "ctimeNs"] as const)
      if (before[key] !== after[key] || after[key] !== named[key]) deny();
    if (BigInt(value.length) !== before.size) deny();
    return value;
  } finally {
    fs.closeSync(fd);
  }
}
function optional(file: string): Buffer | null {
  try {
    fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return read(file);
}
function decode(value: Buffer): Data {
  return object(
    decodeAdmissionJson(
      new TextDecoder("utf-8", { fatal: true }).decode(value),
    ),
  );
}
function reference(value: unknown): NativeRebaselineReference {
  const result = object(value);
  if (
    typeof result["path"] !== "string" ||
    typeof result["sha256"] !== "string" ||
    !/^[a-f0-9]{64}$/.test(result["sha256"])
  )
    deny();
  return { path: result["path"], sha256: result["sha256"] };
}
function pinnedNative(options: NativeRuntimeRebaselineReaderOptions) {
  const n = options.native;
  if (sha(fs.readFileSync(n.mappedNativePython)) !== n.nativePythonSha256)
    deny();
  if (
    fs.realpathSync(n.mappedInstalledForkDirectory) !==
    n.mappedInstalledForkDirectory
  )
    deny();
  const actual: string[] = [];
  function inventory(directory: string, prefix = "") {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "__pycache__") continue;
      if (entry.isSymbolicLink()) deny();
      const name = prefix + entry.name;
      if (entry.isDirectory())
        inventory(path.join(directory, entry.name), name + "/");
      else if (entry.isFile()) actual.push(name);
      else deny();
    }
  }
  inventory(n.mappedInstalledForkDirectory);
  if (!same(actual.sort(), Object.keys(n.installedPackageFiles).sort())) deny();
  for (const [file, digest] of Object.entries(n.installedPackageFiles)) {
    if (
      path.posix.normalize(file) !== file ||
      path.posix.isAbsolute(file) ||
      file.split("/").some((part) => !part || part === "..") ||
      file.includes("\\") ||
      !/^[a-f0-9]{64}$/.test(digest) ||
      sha(fs.readFileSync(path.join(n.mappedInstalledForkDirectory, file))) !==
        digest
    )
      deny();
  }
}
async function query(
  options: NativeRuntimeRebaselineReaderOptions,
  requestId: string,
): Promise<Data> {
  pinnedNative(options);
  const n = options.native;
  return new Promise((resolve, reject) => {
    const fail = () =>
      reject(new NativeRuntimeBarrierError("RUNTIME_BARRIER_UNPROVEN"));
    const child = spawn(
      n.mappedNativePython,
      ["-I", "-S", "-B", "-c", queryScript],
      {
        cwd: n.mappedInstalledForkDirectory,
        shell: false,
        windowsHide: true,
        env: {
          SystemRoot: "C:\\Windows",
          LOCALAPPDATA: n.localAppData,
          FUSION_MCP_ADMISSION_PROVISION: n.provisionPath,
          WSLENV: "SystemRoot:LOCALAPPDATA:FUSION_MCP_ADMISSION_PROVISION",
          ...(process.env["WSL_INTEROP"]
            ? { WSL_INTEROP: process.env["WSL_INTEROP"] }
            : {}),
          ...(process.env["WSL_DISTRO_NAME"]
            ? { WSL_DISTRO_NAME: process.env["WSL_DISTRO_NAME"] }
            : {}),
        },
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    let output = Buffer.alloc(0),
      overflow = false;
    const timer = setTimeout(() => {
      overflow = true;
      child.kill();
      fail();
    }, n.timeoutMs ?? 30_000);
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.stdout.on("data", (bytes: Buffer) => {
      if (output.length + bytes.length > 4_194_304) {
        overflow = true;
        child.kill();
      } else output = Buffer.concat([output, bytes]);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || overflow) return fail();
      try {
        resolve(decode(output));
      } catch {
        fail();
      }
    });
    child.stdin.end(
      JSON.stringify({
        pins: n,
        attempt: randomUUID(),
        descriptor: {
          physicalRuntime: {
            ...options.pins.process,
            version: options.runtimeVersion,
            source: options.pins.source,
            build: options.pins.build,
          },
          generation: options.pins.generation,
        },
        action: "query",
        operatorFile: options.publicationAuthority.nativeOperatorFile,
        admissionStore: options.pins.admissionStore,
        runtimePins: options.pins,
        keyId: options.publicationAuthority.keyId,
        keyDigest: options.publicationAuthority.keyReference.sha256,
        requestJson: JSON.stringify({ requestId }),
      }) + "\n",
    );
  });
}

function capture(
  options: NativeRuntimeRebaselineReaderOptions,
  publication: NativeRuntimeActivationPublication,
  completion: NativeRuntimeActivationCompletion,
) {
  const info = privateDirectory(options.store);
  const files: Record<string, Buffer | null> = {};
  const immutable: Record<string, Buffer> = {};
  function tracked(file: string) {
    const value = read(file);
    files[file] = value;
    immutable[file] = value;
    return value;
  }
  function verified(value: unknown) {
    const ref = reference(value),
      bytes = tracked(ref.path);
    if (sha(bytes) !== ref.sha256) deny();
    return bytes;
  }
  verified(options.publicationAuthority.keyReference);
  const requestId = completion.binding.requestId;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) deny();
  const archive = path.join(options.store, "runtime-rebaselines", requestId);
  if (
    publication.store !== options.store ||
    publication.storeDevice !== info.dev ||
    publication.storeInode !== info.ino ||
    publication.activationFile !==
      path.join(options.store, "runtime-rebaseline-head.json") ||
    publication.record.path !== path.join(archive, "record.json")
  )
    deny();
  if (
    optional(
      path.join(options.store, "runtime-rebaseline-publication.json"),
    ) !== null
  )
    deny();
  const record = decode(verified(publication.record));
  if (!same(decode(tracked(path.join(archive, "completion.json"))), completion))
    deny();
  const binding = object(record["binding"]);
  if (
    !same(
      Object.fromEntries(
        Object.keys(options.pins).map((key) => [key, binding[key]]),
      ),
      options.pins,
    ) ||
    object(record["request"])["requestId"] !== requestId ||
    object(record["request"])["expectedHead"] !== publication.expectedHead
  )
    deny();
  const pointer = optional(
    path.join(options.store, "isolated-admission-epoch.json"),
  );
  const names = runtimeRebaselineManifestNames(options.store, pointer);
  for (const name of names) {
    const file = path.join(options.store, name),
      bytes = optional(file);
    files[file] = bytes;
    if (name === "runtime-rebaseline-head.json") {
      if (bytes?.toString("utf8") !== publication.activationBytes) deny();
      immutable[file] = bytes;
    }
    if (name.endsWith("queue-state.pending.json") && bytes !== null) deny();
    if (
      (name === "queue-state.json" ||
        (name.includes("/") && !name.endsWith(".pending.json"))) &&
      !bytes
    )
      deny();
  }
  if (
    !same(
      pointer,
      files[path.join(options.store, "isolated-admission-epoch.json")],
    )
  )
    deny();
  const frozen = object(record["frozen"]);
  const frozenPointer = frozen["isolated-admission-epoch.json"];
  const originalNames = runtimeRebaselineManifestNames(
    options.store,
    frozenPointer === null ? null : verified(frozenPointer),
  );
  if (
    !same(Object.keys(frozen).sort(), [...originalNames].sort()) ||
    !same(
      Object.keys(publication.expectedFiles).sort(),
      [...originalNames].sort(),
    )
  )
    deny();
  for (const [name, value] of Object.entries(frozen)) {
    if (value === null) {
      if (publication.expectedFiles[name] !== null) deny();
    } else {
      const ref = reference(value);
      if (
        ref.path !== path.join(archive, name) ||
        ref.sha256 !== publication.expectedFiles[name]
      )
        deny();
      verified(ref);
    }
  }
  for (const ref of record["evidence"] as unknown[]) verified(ref);
  for (const ref of completion.evidence) verified(ref);
  verified(completion.nativeReceipt.reference);
  return { device: info.dev, inode: info.ino, files, immutable, record };
}
function sameImmutable(
  a: ReturnType<typeof capture>,
  b: ReturnType<typeof capture>,
) {
  return (
    a.device === b.device &&
    a.inode === b.inode &&
    same(a.immutable, b.immutable)
  );
}
function resync(snapshot: ReturnType<typeof capture>) {
  const directories = new Set<string>();
  for (const [file, value] of Object.entries(snapshot.files)) {
    if (value === null) continue;
    if (!read(file, true).equals(value)) deny();
    let directory = path.dirname(file);
    for (;;) {
      if ((fs.statSync(directory).mode & 0o077) !== 0) break;
      directories.add(directory);
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  for (const directory of [...directories].sort(
    (a, b) => b.length - a.length,
  )) {
    privateDirectory(directory);
    const fd = fs.openSync(
      directory,
      fs.constants.O_RDONLY |
        fs.constants.O_DIRECTORY |
        fs.constants.O_NOFOLLOW,
    );
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
}
function createPorts(
  options: NativeRuntimeRebaselineReaderOptions,
): NativeRuntimeRebaselineReaderPorts {
  const pinned = structuredClone(options);
  if (
    process.platform !== "linux" ||
    !pinned.runtimeVersion ||
    !pinned.publicationAuthority.keyId ||
    !path.win32.isAbsolute(pinned.publicationAuthority.nativeOperatorFile) ||
    !same(Object.keys(pinned).sort(), [
      "native",
      "pins",
      "publicationAuthority",
      "runtimeVersion",
      "store",
    ]) ||
    (pinned.native.timeoutMs !== undefined &&
      (!Number.isSafeInteger(pinned.native.timeoutMs) ||
        pinned.native.timeoutMs < 1 ||
        pinned.native.timeoutMs > 300_000))
  )
    deny();
  privateDirectory(pinned.store);
  const key = read(pinned.publicationAuthority.keyReference.path);
  if (
    key.length !== 32 ||
    sha(key) !== pinned.publicationAuthority.keyReference.sha256
  )
    deny();
  for (const file of [
    "lib/rebaseline_fence.py",
    "lib/physical_authority.py",
    "lib/request_admission.py",
  ])
    if (!Object.hasOwn(pinned.native.installedPackageFiles, file)) deny();
  type Approval = {
    publication: NativeRuntimeActivationPublication;
    completion: NativeRuntimeActivationCompletion;
    snapshot: ReturnType<typeof capture>;
  };
  let approved: Approval | undefined;
  async function verify(
    publication: NativeRuntimeActivationPublication,
    completion: NativeRuntimeActivationCompletion,
  ) {
    const snapshot = capture(pinned, publication, completion);
    resync(snapshot);
    const terminal = await query(pinned, completion.binding.requestId);
    const fence = object(terminal["binding"]),
      binding = object(snapshot.record["binding"]);
    if (
      terminal["kind"] !== "fmcad-provision-fence" ||
      terminal["version"] !== 1 ||
      typeof fence["fenceNonce"] !== "string" ||
      !fence["fenceNonce"] ||
      fence["requestId"] !== completion.binding.requestId ||
      fence["oldHead"] !== publication.expectedHead ||
      fence["handoffId"] !== pinned.pins.handoffId ||
      !same(fence["store"], {
        path: pinned.store,
        device: snapshot.device,
        inode: snapshot.inode,
      }) ||
      !same(fence["generation"], pinned.pins.generation) ||
      !same(fence["physicalRuntime"], {
        ...pinned.pins.process,
        version: pinned.runtimeVersion,
        source: pinned.pins.source,
        build: pinned.pins.build,
      }) ||
      fence["endpointURL"] !== pinned.pins.endpoint ||
      fence["writerGeneration"] !== binding["writerGeneration"] ||
      fence["initiatorOperatorId"] !== snapshot.record["operatorId"]
    )
      deny();
    const authenticated = authenticateRuntimeConsumedReceipt(
      key,
      fence,
      completion.binding.requestId,
      publication,
      terminal,
    );
    if (
      !same(authenticated.binding, completion.binding) ||
      completion.evidence.length !== 2 ||
      !completion.evidence.some((ref) =>
        same(ref, completion.nativeReceipt.reference),
      ) ||
      completion.nativeReceipt.kind !==
        "native-runtime-rebaseline-consume-v1" ||
      !read(completion.nativeReceipt.reference.path).equals(
        authenticated.receiptBytes,
      ) ||
      !completion.evidence.some(
        (ref) =>
          !same(ref, completion.nativeReceipt.reference) &&
          read(ref.path).equals(authenticated.attestationBytes),
      )
    )
      deny();
    pinnedNative(pinned);
    if (!same(capture(pinned, publication, completion), snapshot)) deny();
    resync(snapshot);
    pinnedNative(pinned);
    if (!same(capture(pinned, publication, completion), snapshot)) deny();
    return { snapshot, activation: authenticated.activation };
  }
  return Object.freeze({
    store: pinned.store,
    pins: structuredClone(pinned.pins),
    async verifyConsumed(
      publication: NativeRuntimeActivationPublication,
      completion: NativeRuntimeActivationCompletion,
    ) {
      publication = structuredClone(publication);
      completion = structuredClone(completion);
      const result = await verify(publication, completion);
      approved = { publication, completion, snapshot: result.snapshot };
    },
    async getVerifiedActivation(descriptor: PhysicalGenerationDescriptor) {
      const current = approved;
      if (!current) return undefined;
      descriptor = structuredClone(descriptor);
      if (
        descriptor.kind !== "fmcad-physical-grant" ||
        descriptor.version !== 1 ||
        descriptor.brokerOwner.queueDirectory !== pinned.store ||
        descriptor.handoffId !== pinned.pins.handoffId ||
        !same(descriptor.generation, pinned.pins.generation) ||
        !same(descriptor.physicalRuntime, {
          ...pinned.pins.process,
          version: pinned.runtimeVersion,
          source: pinned.pins.source,
          build: pinned.pins.build,
        }) ||
        descriptor.endpointURL !== pinned.pins.endpoint ||
        !sameImmutable(
          capture(pinned, current.publication, current.completion),
          current.snapshot,
        )
      )
        deny();
      const result = await verify(current.publication, current.completion);
      if (
        approved !== current ||
        !sameImmutable(result.snapshot, current.snapshot) ||
        !same(
          capture(pinned, current.publication, current.completion),
          result.snapshot,
        )
      )
        deny();
      return result.activation;
    },
  });
}
/** Only trusted local composition receives the private native operator/key.
 * Returned ports have no writer lease, publication, BEGIN or CONSUME capability. */
export function createNativeRuntimeRebaselineReaderPorts(
  options: NativeRuntimeRebaselineReaderOptions,
): NativeRuntimeRebaselineReaderPorts {
  const protect = async <T>(work: () => Promise<T>) => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof NativeRuntimeBarrierError) throw error;
      throw new NativeRuntimeBarrierError("RUNTIME_BARRIER_UNPROVEN");
    }
  };
  try {
    const ports = createPorts(options);
    return Object.freeze({
      store: ports.store,
      pins: ports.pins,
      verifyConsumed: (
        publication: NativeRuntimeActivationPublication,
        completion: NativeRuntimeActivationCompletion,
      ) => protect(() => ports.verifyConsumed(publication, completion)),
      getVerifiedActivation: (descriptor: PhysicalGenerationDescriptor) =>
        protect(() => ports.getVerifiedActivation(descriptor)),
    });
  } catch (error) {
    if (error instanceof NativeRuntimeBarrierError) throw error;
    throw new NativeRuntimeBarrierError("RUNTIME_BARRIER_UNPROVEN");
  }
}

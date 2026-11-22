import fs from "node:fs";
import path from "node:path";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import {
  decodeAdmissionJson,
  decodeRuntimeRebaselineRecordJson,
} from "./admission-json";
import type {
  NativePhysicalGenerationProvisionOptions,
  NativePhysicalActivation,
} from "./physical-generation-provision";
import type { PhysicalGenerationDescriptor } from "./physical-generation";
import { nativePhysicalGuard } from "./physical-generation-provision";
import { runtimeRebaselineManifestNames } from "../persistence/runtime-rebaseline-scope";

export interface NativeRebaselineReference {
  path: string;
  sha256: string;
}

export interface NativeRuntimeRebaselinePins {
  handoffId: string;
  admissionStore: string;
  generation: { epoch: string; instance: string };
  process: { pid: number; birth: string };
  source: string;
  build: string;
  endpoint: string;
}

export interface NativeRuntimeBarrierBinding extends NativeRuntimeRebaselinePins {
  retiredProcess: { pid: number; birth: string };
  retirement: "process_dead";
  ingress: "pinned_all_sdk_ingress";
  grantCount: 0;
  admissionCount: 0;
  writerGeneration: string;
}

export interface NativeRuntimeActivationPublication {
  store: string;
  storeDevice: number;
  storeInode: number;
  expectedHead: string;
  expectedFiles: Record<string, string | null>;
  activationFile: string;
  activationBytes: string;
  record: NativeRebaselineReference;
}

export interface NativeRuntimeRebaselineRequest {
  requestId: string;
  expectedHead: string;
  handoffId: string;
}

export interface NativeRuntimeBarrierLease {
  readonly initiatorOperatorId: string;
  readonly fenceState: "pending" | "consumed";
  assertWriterAndProvisionLock(): void;
  verifyCurrentBarrier(): Promise<{
    binding: NativeRuntimeBarrierBinding;
    evidence: NativeRebaselineReference[];
  }>;
  publishActivation(
    publication: NativeRuntimeActivationPublication,
  ): Promise<void>;
  consumeActivation(
    publication: NativeRuntimeActivationPublication,
  ): Promise<NativeRuntimeActivationCompletion>;
  verifyNativeConsumeReceipt(
    publication: NativeRuntimeActivationPublication,
    completion: NativeRuntimeActivationCompletion,
  ): Promise<void>;
}

export interface NativeRuntimeActivationCompletion {
  binding: {
    requestId: string;
    newHead: string;
    publicationDigest: string;
    initiatorOperatorId: string;
  };
  evidence: NativeRebaselineReference[];
  nativeReceipt: {
    kind: "native-runtime-rebaseline-consume-v1";
    reference: NativeRebaselineReference;
  };
}

export interface NativeRuntimeRebaselineAuthorityPorts {
  store: string;
  operatorId: string;
  pins: NativeRuntimeRebaselinePins;
  getVerifiedActivation(
    descriptor: PhysicalGenerationDescriptor,
  ): Promise<NativePhysicalActivation | undefined>;
  withExclusiveBarrier<T>(
    request: NativeRuntimeRebaselineRequest,
    invokeMode: "publish-or-resume" | "verify-completed",
    work: (lease: NativeRuntimeBarrierLease) => Promise<T>,
  ): Promise<T>;
}

/** A maintained local writer capability, supplied only by trusted composition.
 * The native persistent fence is independent of this parent's process lifetime. */
export interface NativeRebaselineWriter {
  withExclusiveWriter<T>(
    work: (lease: { generation: string; assertHeld(): void }) => Promise<T>,
  ): Promise<T>;
}

/** References to the original immutable operator outputs, not caller verdicts. */
export interface NativeRebaselineOriginalEvidence {
  retiredProcess: NativeRebaselineReference;
  coldProcess: NativeRebaselineReference;
  completedHandoff: NativeRebaselineReference;
  committedHandoff: NativeRebaselineReference;
  preservedRows: NativeRebaselineReference;
  sourceArchive: NativeRebaselineReference;
}

export interface NativeRuntimeRebaselineOptions {
  store: string;
  operatorId: string;
  pins: NativeRuntimeRebaselinePins;
  native: Omit<
    NativePhysicalGenerationProvisionOptions,
    "getVerifiedActivation" | "assertBrokerOwner"
  >;
  runtimeVersion: string;
  originalEvidence: NativeRebaselineOriginalEvidence;
  evidenceDirectory: string;
  writer: NativeRebaselineWriter;
  publicationAuthority: {
    keyId: string;
    keyReference: NativeRebaselineReference;
    nativeOperatorFile: string;
  };
}

const nativeFenceScript = `${nativePhysicalGuard}
from lib.physical_authority import _read_private_bytes,private_directory
from lib.admission_json import decode_json
private_directory(Path(e["operatorFile"]).parent)
operator=decode_json(_read_private_bytes(Path(e["operatorFile"])).decode("utf-8"))
if Path(operator["database"]).resolve()!=Path(e["admissionStore"]).resolve():
    deny("NATIVE_ADMISSION_STORE_CHANGED")
expected_runtime={"handoffId":e["runtimePins"]["handoffId"],"generation":d["generation"],
                  "physicalRuntime":r,"endpointURL":e["runtimePins"]["endpoint"]}
if operator["runtime"]!=expected_runtime:
    deny("NATIVE_OPERATOR_RUNTIME_CHANGED")
# Original retirement is re-observed, not accepted merely from archived JSON.
old=e["retiredProcess"]
old_handle=k.OpenProcess(0x1000,False,old["pid"])
if old_handle:
    try:
        old_times=[wt.FILETIME() for _ in range(4)]
        if not k.GetProcessTimes(old_handle,*(ctypes.byref(t) for t in old_times)):
            deny("NATIVE_RETIRED_PROCESS_UNPROVEN")
        birth=str((old_times[0].dwHighDateTime<<32)|old_times[0].dwLowDateTime)
        if birth==old["birth"]:
            k.GetExitCodeProcess.argtypes=[wt.HANDLE,ctypes.POINTER(wt.DWORD)]
            exit_code=wt.DWORD()
            if not k.GetExitCodeProcess(old_handle,ctypes.byref(exit_code)) or exit_code.value==259:
                deny("NATIVE_RETIRED_PROCESS_ALIVE")
    finally:
        k.CloseHandle(old_handle)
elif ctypes.get_last_error()!=87:
    deny("NATIVE_RETIRED_PROCESS_UNPROVEN")
private_directory(Path(p["nativePrivateDirectory"]))
directory=Path(p["nativePrivateDirectory"])/e["attempt"]
if directory.exists():
    deny("NATIVE_ATTEMPT_REUSED")
private_directory(directory)
raw=e["requestJson"].encode("utf-8")
request=directory/"request.json"
fd=os.open(request,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,"wb") as f:
    f.write(raw)
    f.flush()
    os.fsync(f.fileno())
if _read_private_bytes(request)!=raw:
    deny("NATIVE_REQUEST_CHANGED")
# Construct the private capability from the SAME verified bytes, never reopen
# its pathname in a CLI. The supported module still performs its own native
# process/store/registration/fence transaction checks.
from lib.rebaseline_fence import OperatorAuthority,begin_fence,query_fence,consume_fence
authority=OperatorAuthority(operator)
operation={"begin":begin_fence,"query":query_fence,"consume":consume_fence}[e["action"]]
result=operation(authority,decode_json(raw.decode("utf-8")))
print(json.dumps(result,sort_keys=True,ensure_ascii=True))
`;

async function nativeFence(
  options: NativeRuntimeRebaselineOptions,
  retiredProcess: { pid: number; birth: string },
  action: "begin" | "query" | "consume",
  request: unknown,
): Promise<Record<string, unknown>> {
  const native = options.native;
  if (
    sha(fs.readFileSync(native.mappedNativePython)) !==
    native.nativePythonSha256
  )
    refuse();
  for (const [file, digest] of Object.entries(native.installedPackageFiles)) {
    if (
      path.posix.normalize(file) !== file ||
      path.posix.isAbsolute(file) ||
      file.split("/").some((part) => !part || part === "..") ||
      file.includes("\\") ||
      !/^[a-f0-9]{64}$/.test(digest) ||
      sha(
        fs.readFileSync(path.join(native.mappedInstalledForkDirectory, file)),
      ) !== digest
    )
      refuse();
  }
  return new Promise((resolve, reject) => {
    const fail = () =>
      reject(new NativeRuntimeBarrierError("RUNTIME_BARRIER_UNPROVEN"));
    const child = spawn(
      native.mappedNativePython,
      ["-I", "-S", "-B", "-c", nativeFenceScript],
      {
        cwd: native.mappedInstalledForkDirectory,
        env: {
          SystemRoot: "C:\\Windows",
          LOCALAPPDATA: native.localAppData,
          FUSION_MCP_ADMISSION_PROVISION: native.provisionPath,
          WSLENV: "SystemRoot:LOCALAPPDATA:FUSION_MCP_ADMISSION_PROVISION",
          ...(process.env["WSL_INTEROP"]
            ? { WSL_INTEROP: process.env["WSL_INTEROP"] }
            : {}),
          ...(process.env["WSL_DISTRO_NAME"]
            ? { WSL_DISTRO_NAME: process.env["WSL_DISTRO_NAME"] }
            : {}),
        },
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    let output = Buffer.alloc(0);
    let overflow = false;
    const timer = setTimeout(() => {
      overflow = true;
      child.kill();
      fail();
    }, native.timeoutMs ?? 30_000);
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.stdout.on("data", (bytes: Buffer) => {
      if (overflow) return;
      if (output.length + bytes.length > 4_194_304) {
        overflow = true;
        child.kill();
      } else output = Buffer.concat([output, bytes]);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || overflow) return fail();
      try {
        resolve(
          object(
            decodeAdmissionJson(
              new TextDecoder("utf-8", { fatal: true }).decode(output),
            ),
          ),
        );
      } catch {
        fail();
      }
    });
    child.stdin.end(
      JSON.stringify({
        pins: native,
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
        retiredProcess,
        action,
        operatorFile: options.publicationAuthority.nativeOperatorFile,
        admissionStore: options.pins.admissionStore,
        runtimePins: options.pins,
        requestJson: JSON.stringify(request),
      }) + "\n",
    );
  });
}

export class NativeRuntimeBarrierError extends Error {
  constructor(
    readonly code: "RUNTIME_BARRIER_UNPROVEN" | "RUNTIME_BARRIER_CHANGED",
  ) {
    super("The private native runtime barrier could not be verified");
    this.name = "NativeRuntimeBarrierError";
  }
}

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function refuse(
  code: NativeRuntimeBarrierError["code"] = "RUNTIME_BARRIER_UNPROVEN",
): never {
  throw new NativeRuntimeBarrierError(code);
}

function privateDirectory(directory: string): void {
  if (
    !path.isAbsolute(directory) ||
    path.resolve(directory) !== directory ||
    fs.realpathSync(directory) !== directory
  )
    refuse();
  const info = fs.lstatSync(directory, { bigint: true });
  if (
    !info.isDirectory() ||
    info.uid !== BigInt(process.getuid?.() ?? -1) ||
    (info.mode & 0o077n) !== 0n
  )
    refuse();
}

/** Every reference is opened once and read through that exact regular fd. */
function privateBytes(reference: NativeRebaselineReference): Buffer {
  if (
    !reference ||
    typeof reference.path !== "string" ||
    typeof reference.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(reference.sha256)
  )
    refuse();
  return readPrivateRegular(reference.path, reference.sha256);
}

function readPrivateRegular(
  file: string,
  expectedSha?: string,
  sync = false,
): Buffer {
  if (fs.realpathSync(file) !== file) refuse();
  privateDirectory(path.dirname(file));
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
      (before.mode & 0o077n) !== 0n ||
      before.size > 128n * 1024n * 1024n
    )
      refuse();
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let count = 0;
    while (count < buffer.length) {
      const read = fs.readSync(fd, buffer, count, buffer.length - count, count);
      if (!read) break;
      count += read;
    }
    const bytes = buffer.subarray(0, count);
    if (sync) fs.fsyncSync(fd);
    const after = fs.fstatSync(fd, { bigint: true });
    const named = fs.lstatSync(file, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      BigInt(bytes.length) !== before.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      after.dev !== named.dev ||
      after.ino !== named.ino ||
      (expectedSha !== undefined && sha(bytes) !== expectedSha)
    )
      refuse("RUNTIME_BARRIER_CHANGED");
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse();
  return value as Record<string, unknown>;
}

function privateObject(reference: NativeRebaselineReference) {
  return object(
    decodeAdmissionJson(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        privateBytes(reference),
      ),
    ),
  );
}

/** Archival facts are checked for cross-binding here; current process/store,
 * package bytes and persistent provision fence must still be independently
 * observed by the native verifier before they can become an attestation. */
function originalFacts(options: NativeRuntimeRebaselineOptions) {
  const evidence = options.originalEvidence;
  const retired = privateObject(evidence.retiredProcess);
  const cold = privateObject(evidence.coldProcess);
  const completed = privateObject(evidence.completedHandoff);
  const committed = privateObject(evidence.committedHandoff);
  const rows = privateObject(evidence.preservedRows);
  privateBytes(evidence.sourceArchive);
  const pins = options.pins;
  if (
    retired["exited"] !== true ||
    retired["oldPidPresent"] !== false ||
    retired["forceUsed"] !== false ||
    !Number.isSafeInteger(retired["oldPid"]) ||
    Number(retired["oldPid"]) <= 0 ||
    typeof retired["oldBirth"] !== "string" ||
    !retired["oldBirth"] ||
    cold["pid"] !== pins.process.pid ||
    cold["birth"] !== pins.process.birth ||
    typeof cold["exe"] !== "string" ||
    completed["state"] !== "completed" ||
    committed["state"] !== "committed" ||
    completed["handoffId"] !== pins.handoffId ||
    !isDeepStrictEqual(completed, { ...committed, state: "completed" }) ||
    !isDeepStrictEqual(committed["nextGeneration"], pins.generation) ||
    rows["databasePath"] !== pins.admissionStore ||
    rows["sameDatabase"] !== true ||
    rows["allOldAdmissionRowsPreserved"] !== true ||
    rows["allOldHistoryRowsPreserved"] !== true ||
    rows["exactlyOneCommittedHandoffRow"] !== true ||
    !isDeepStrictEqual(rows["handoffReceipt"], committed) ||
    rows["grantIssued"] !== false ||
    rows["sdkProgramSubmitted"] !== false
  )
    refuse();
  return {
    retiredProcess: {
      pid: Number(retired["oldPid"]),
      birth: retired["oldBirth"],
    },
    processImage: cold["exe"],
    committed,
    references: Object.values(evidence).map((ref) => ({ ...ref })),
  };
}

function currentFile(file: string): Buffer | null {
  try {
    fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  // Only absence of the directory entry is optional. A dangling symlink or a
  // file lost after this observation is an unproven read, never absent metadata.
  return readPrivateRegular(file);
}

function syncDirectory(directory: string): void {
  const fd = fs.openSync(
    directory,
    fs.constants.O_RDONLY |
      fs.constants.O_DIRECTORY |
      fs.constants.O_NOFOLLOW |
      fs.constants.O_NONBLOCK,
  );
  try {
    const info = fs.fstatSync(fd, { bigint: true });
    const named = fs.lstatSync(directory, { bigint: true });
    if (
      !info.isDirectory() ||
      info.uid !== BigInt(process.getuid?.() ?? -1) ||
      (info.mode & 0o077n) !== 0n ||
      info.dev !== named.dev ||
      info.ino !== named.ino ||
      fs.realpathSync(directory) !== directory
    )
      refuse();
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function syncReference(reference: NativeRebaselineReference): void {
  if (!/^[a-f0-9]{64}$/.test(reference.sha256)) refuse();
  readPrivateRegular(reference.path, reference.sha256, true);
  syncDirectory(path.dirname(reference.path));
}

function syncWithin(directory: string, root: string): void {
  if (directory !== root && !directory.startsWith(root + path.sep)) refuse();
  for (;;) {
    privateDirectory(directory);
    syncDirectory(directory);
    if (directory === root) return;
    directory = path.dirname(directory);
  }
}

/** Only called while the real writer capability and persistent native fence
 * are held. No syscall here delegates Linux durability to Windows UNC. */
function publishPosix(
  options: NativeRuntimeRebaselineOptions,
  request: NativeRuntimeRebaselineRequest,
  publication: NativeRuntimeActivationPublication,
  assertHeld: () => void,
  requireExistingNew = false,
): void {
  assertHeld();
  privateDirectory(options.store);
  const info = fs.statSync(options.store);
  const activationFile = path.join(
    options.store,
    "runtime-rebaseline-head.json",
  );
  const recordFile = path.join(
    options.store,
    "runtime-rebaselines",
    request.requestId,
    "record.json",
  );
  const pointer = currentFile(
    path.join(options.store, "isolated-admission-epoch.json"),
  );
  const headInputs = runtimeRebaselineManifestNames(options.store, pointer);
  if (
    publication.store !== options.store ||
    publication.storeDevice !== info.dev ||
    publication.storeInode !== info.ino ||
    publication.expectedHead !== request.expectedHead ||
    publication.activationFile !== activationFile ||
    publication.record.path !== recordFile ||
    !isDeepStrictEqual(
      Object.keys(publication.expectedFiles).sort(),
      [...headInputs].sort(),
    )
  )
    refuse();
  const record = object(
    decodeRuntimeRebaselineRecordJson(
      new TextDecoder("utf-8", { fatal: true }).decode(
        privateBytes(publication.record),
      ),
    ),
  );
  const frozen = object(record["frozen"]);
  if (!isDeepStrictEqual(Object.keys(frozen).sort(), [...headInputs].sort()))
    refuse();
  for (const name of headInputs) {
    const value = frozen[name];
    if (value === null) {
      if (publication.expectedFiles[name] !== null) refuse();
    } else {
      const reference = object(value);
      if (
        reference["sha256"] !== publication.expectedFiles[name] ||
        reference["path"] !== path.join(path.dirname(recordFile), name)
      )
        refuse();
    }
  }
  const receipt = object(record["receipt"]);
  const activation = object(decodeAdmissionJson(publication.activationBytes));
  if (
    !isDeepStrictEqual(record["request"], request) ||
    record["store"] !== options.store ||
    record["storeDevice"] !== info.dev ||
    record["storeInode"] !== info.ino ||
    !isDeepStrictEqual(activation, {
      version: 1,
      newHead: receipt["newHead"],
      record: publication.record,
    }) ||
    typeof receipt["newHead"] !== "string" ||
    !/^[a-f0-9]{64}$/.test(receipt["newHead"])
  )
    refuse();

  const current = Object.fromEntries(
    headInputs.map((name) => [
      name,
      currentFile(path.join(options.store, name)),
    ]),
  );
  if (!isDeepStrictEqual(pointer, current["isolated-admission-epoch.json"]))
    refuse("RUNTIME_BARRIER_CHANGED");
  if (!current["queue-state.json"]) refuse();
  for (const name of headInputs) {
    if (name.endsWith("queue-state.pending.json") && current[name] !== null)
      refuse();
    if (name.includes("/") && !name.endsWith(".pending.json") && !current[name])
      refuse();
    if (name.includes("/"))
      privateDirectory(path.dirname(path.join(options.store, name)));
  }
  const alreadyNew =
    current["runtime-rebaseline-head.json"]?.equals(
      Buffer.from(publication.activationBytes),
    ) ?? false;
  if (requireExistingNew && !alreadyNew) refuse("RUNTIME_BARRIER_CHANGED");
  const manifest = Object.fromEntries(
    headInputs.map((name) => [
      name,
      current[name] === null ? null : sha(current[name]!),
    ]),
  );
  for (const name of headInputs) {
    if (alreadyNew && name === "runtime-rebaseline-head.json") continue;
    if (manifest[name] !== publication.expectedFiles[name])
      refuse("RUNTIME_BARRIER_CHANGED");
  }
  if (
    !alreadyNew &&
    sha(
      Buffer.from(
        JSON.stringify({
          store: options.store,
          device: info.dev,
          inode: info.ino,
          manifest,
        }),
      ),
    ) !== publication.expectedHead
  )
    refuse("RUNTIME_BARRIER_CHANGED");
  syncReference(publication.record);
  // These immutable refs are recorded by 3bp.4, not reconstructed by a resumer.
  for (const value of Object.values(frozen)) {
    if (value !== null) {
      const reference = object(value) as unknown as NativeRebaselineReference;
      syncReference(reference);
      syncWithin(path.dirname(reference.path), path.dirname(recordFile));
    }
  }
  for (const value of record["evidence"] as NativeRebaselineReference[])
    syncReference(value);
  syncDirectory(path.dirname(path.dirname(recordFile)));
  assertHeld();
  if (!alreadyNew) {
    const temporary = path.join(
      options.store,
      `.runtime-rebaseline-${request.requestId}.tmp`,
    );
    // Same-ID resume may reuse only the exact immutable temporary. Never
    // truncate or discard a different/partial file after an interrupted write.
    immutable(
      options.store,
      path.basename(temporary),
      Buffer.from(publication.activationBytes),
    );
    assertHeld();
    fs.renameSync(temporary, activationFile);
  }
  syncReference({
    path: activationFile,
    sha256: sha(Buffer.from(publication.activationBytes)),
  });
  syncDirectory(options.store);
  assertHeld();
}

function immutable(
  directory: string,
  name: string,
  bytes: Buffer,
): NativeRebaselineReference {
  privateDirectory(directory);
  const file = path.join(directory, name);
  const expected = { path: file, sha256: sha(bytes) };
  if (fs.existsSync(file)) {
    if (!privateBytes(expected).equals(bytes)) refuse();
  } else {
    const fd = fs.openSync(
      file,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    syncDirectory(directory);
  }
  syncReference(expected);
  return expected;
}

/** Python _encode: sorted ASCII protocol keys and ensure_ascii=True strings. */
function pythonEncoding(value: unknown): string {
  function sorted(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(sorted);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, entry]) => [key, sorted(entry)]),
      );
    return item;
  }
  return JSON.stringify(sorted(value)).replace(
    /[\u007f-\uffff]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function authenticatedCompletion(
  pinned: NativeRuntimeRebaselineOptions,
  key: Buffer,
  fenceBinding: Record<string, unknown>,
  requestId: string,
  publication: NativeRuntimeActivationPublication,
  terminal: Record<string, unknown>,
): NativeRuntimeActivationCompletion {
  const authenticated = authenticateRuntimeConsumedReceipt(
    key,
    fenceBinding,
    requestId,
    publication,
    terminal,
  );
  const receiptRef = immutable(
    pinned.evidenceDirectory,
    `${requestId}-native-consumed.json`,
    authenticated.receiptBytes,
  );
  const attestationRef = immutable(
    pinned.evidenceDirectory,
    `${requestId}-completion.json`,
    authenticated.attestationBytes,
  );
  return {
    binding: authenticated.binding,
    evidence: [receiptRef, attestationRef],
    nativeReceipt: {
      kind: "native-runtime-rebaseline-consume-v1",
      reference: receiptRef,
    },
  };
}

/** Literal receipt authentication shared by writer and read-only QUERY.
 * Deliberately no filesystem writes, output directory or publication port. */
export function authenticateRuntimeConsumedReceipt(
  key: Buffer,
  fenceBinding: Record<string, unknown>,
  requestId: string,
  publication: NativeRuntimeActivationPublication,
  terminal: Record<string, unknown>,
) {
  const publicationJson = JSON.stringify(publication);
  const publicationDigest = sha(Buffer.from(publicationJson));
  const receiptJson = terminal["receiptJson"];
  if (
    terminal["state"] !== "consumed" ||
    !isDeepStrictEqual(terminal["binding"], fenceBinding) ||
    terminal["publicationJson"] !== publicationJson ||
    typeof receiptJson !== "string" ||
    terminal["receiptDigest"] !== sha(Buffer.from(receiptJson)) ||
    typeof terminal["receiptMac"] !== "string" ||
    !/^[a-f0-9]{64}$/.test(terminal["receiptMac"])
  )
    refuse();
  const expectedMac = createHmac("sha256", key)
    .update("fmcad-native-consume-v1\0")
    .update(receiptJson)
    .digest();
  if (!timingSafeEqual(expectedMac, Buffer.from(terminal["receiptMac"], "hex")))
    refuse();
  const receipt = object(decodeAdmissionJson(receiptJson));
  const activation = object(decodeAdmissionJson(publication.activationBytes));
  const binding = {
    requestId,
    newHead: String(activation["newHead"]),
    publicationDigest,
    initiatorOperatorId: String(fenceBinding["initiatorOperatorId"]),
  };
  if (
    receipt["kind"] !== "fmcad-rebaseline-consumed" ||
    receipt["version"] !== 1 ||
    !isDeepStrictEqual(receipt["fence"], fenceBinding) ||
    !isDeepStrictEqual(receipt["activation"], {
      ...binding,
      fenceNonce: fenceBinding["fenceNonce"],
      record: publication.record,
    })
  )
    refuse();
  return {
    binding,
    receiptBytes: Buffer.from(receiptJson),
    attestationBytes: Buffer.from(JSON.stringify(binding)),
    activation: {
      requestId,
      fenceNonce: String(fenceBinding["fenceNonce"]),
      newHead: binding.newHead,
      publicationDigest,
      receiptDigest: sha(Buffer.from(receiptJson)),
    },
  };
}

/** Private local composition. No JSON decoder can produce this writer or the
 * native operator credential, and no returned method exposes a signing oracle. */
function nativeRuntimeRebaselineAuthorityPorts(
  options: NativeRuntimeRebaselineOptions,
): NativeRuntimeRebaselineAuthorityPorts {
  const { writer } = options;
  const pinned = {
    ...structuredClone({ ...options, writer: undefined }),
    writer,
  };
  const native = pinned.native;
  if (
    process.platform !== "linux" ||
    typeof writer?.withExclusiveWriter !== "function" ||
    !pinned.operatorId ||
    !pinned.runtimeVersion ||
    !/^[a-f0-9]{64}$/.test(native.nativePythonSha256) ||
    !Object.hasOwn(native.installedPackageFiles, "lib/rebaseline_fence.py") ||
    !Object.hasOwn(native.installedPackageFiles, "lib/physical_authority.py") ||
    !Object.hasOwn(native.installedPackageFiles, "lib/request_admission.py") ||
    !Number.isSafeInteger(pinned.pins.process.pid) ||
    pinned.pins.process.pid <= 0 ||
    typeof pinned.pins.process.birth !== "string" ||
    !pinned.pins.process.birth ||
    !path.win32.isAbsolute(pinned.publicationAuthority.nativeOperatorFile) ||
    (native.timeoutMs !== undefined &&
      (!Number.isSafeInteger(native.timeoutMs) ||
        native.timeoutMs < 1 ||
        native.timeoutMs > 300_000))
  )
    refuse();
  privateDirectory(pinned.store);
  privateDirectory(pinned.evidenceDirectory);
  const key = privateBytes(pinned.publicationAuthority.keyReference);
  if (key.length !== 32 || !pinned.publicationAuthority.keyId) refuse();
  const facts = originalFacts(pinned);
  let lastApproved:
    | {
        request: NativeRuntimeRebaselineRequest;
        publication: NativeRuntimeActivationPublication;
        completion: NativeRuntimeActivationCompletion;
        fenceBinding: Record<string, unknown>;
      }
    | undefined;
  return {
    store: pinned.store,
    operatorId: pinned.operatorId,
    pins: structuredClone(pinned.pins),
    async getVerifiedActivation(descriptor) {
      const approved = lastApproved;
      if (!approved) return undefined;
      descriptor = structuredClone(descriptor);
      const assertApprovedCurrent = () => {
        if (lastApproved !== approved) refuse("RUNTIME_BARRIER_CHANGED");
        privateDirectory(pinned.store);
        const info = fs.statSync(pinned.store);
        if (
          descriptor.kind !== "fmcad-physical-grant" ||
          descriptor.version !== 1 ||
          descriptor.brokerOwner.queueDirectory !== pinned.store ||
          descriptor.handoffId !== pinned.pins.handoffId ||
          !isDeepStrictEqual(descriptor.generation, pinned.pins.generation) ||
          !isDeepStrictEqual(descriptor.physicalRuntime, {
            ...pinned.pins.process,
            version: pinned.runtimeVersion,
            source: pinned.pins.source,
            build: pinned.pins.build,
          }) ||
          descriptor.endpointURL !== pinned.pins.endpoint ||
          approved.publication.storeDevice !== info.dev ||
          approved.publication.storeInode !== info.ino ||
          !currentFile(
            path.join(pinned.store, "runtime-rebaseline-head.json"),
          )?.equals(Buffer.from(approved.publication.activationBytes))
        )
          refuse();
      };
      assertApprovedCurrent();
      originalFacts(pinned);
      privateBytes(approved.publication.record);
      for (const reference of approved.completion.evidence)
        privateBytes(reference);
      const raw = privateBytes(approved.completion.nativeReceipt.reference);
      const terminal = await nativeFence(
        pinned,
        facts.retiredProcess,
        "query",
        { requestId: approved.request.requestId },
      );
      const verified = authenticatedCompletion(
        pinned,
        key,
        approved.fenceBinding,
        approved.request.requestId,
        approved.publication,
        terminal,
      );
      if (!isDeepStrictEqual(verified, approved.completion)) refuse();
      const activation = object(
        object(
          decodeAdmissionJson(
            new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
              raw,
            ),
          ),
        )["activation"],
      );
      const activationTuple = {
        requestId: String(activation["requestId"]),
        fenceNonce: String(activation["fenceNonce"]),
        newHead: String(activation["newHead"]),
        publicationDigest: String(activation["publicationDigest"]),
        receiptDigest: sha(raw),
      };
      // The authenticated response may have been captured before a concurrent
      // pointer/context change. No await may separate this final read from the
      // tuple returned to the private issuer.
      privateBytes(approved.publication.record);
      for (const reference of approved.completion.evidence)
        privateBytes(reference);
      assertApprovedCurrent();
      return activationTuple;
    },
    async withExclusiveBarrier(request, invokeMode, work) {
      const intent = structuredClone(request);
      if (
        !/^[A-Za-z0-9_-]{1,128}$/.test(intent.requestId) ||
        !/^[a-f0-9]{64}$/.test(intent.expectedHead) ||
        intent.handoffId !== pinned.pins.handoffId ||
        !["publish-or-resume", "verify-completed"].includes(invokeMode)
      )
        refuse();
      return writer.withExclusiveWriter(async (writerLease) => {
        writerLease.assertHeld();
        if (!writerLease.generation) refuse();
        const markerFile = path.join(
          pinned.store,
          "runtime-rebaseline-publication.json",
        );
        const marker = {
          version: 1,
          requestId: intent.requestId,
          expectedHead: intent.expectedHead,
          phase: "preparing",
        };
        const existing = currentFile(markerFile);
        if (existing) {
          const value = object(
            decodeAdmissionJson(
              new TextDecoder("utf-8", { fatal: true }).decode(existing),
            ),
          );
          if (
            value["requestId"] !== intent.requestId ||
            value["expectedHead"] !== intent.expectedHead ||
            value["version"] !== 1
          )
            refuse();
        } else if (invokeMode === "publish-or-resume") {
          immutable(
            pinned.store,
            "runtime-rebaseline-publication.json",
            Buffer.from(JSON.stringify(marker)),
          );
        }
        // The marker survives every uncertain native outcome. There is no
        // finally-clear, timeout-clear, parent-death clear or force-clear.
        let observed = await nativeFence(
          pinned,
          facts.retiredProcess,
          "query",
          { requestId: intent.requestId },
        );
        if (
          isDeepStrictEqual(observed, {
            kind: "fmcad-provision-fence",
            version: 1,
            state: "absent",
            requestId: intent.requestId,
          })
        ) {
          if (invokeMode === "verify-completed") refuse();
          observed = await nativeFence(pinned, facts.retiredProcess, "begin", {
            ...intent,
            store: {
              path: pinned.store,
              device: fs.statSync(pinned.store).dev,
              inode: fs.statSync(pinned.store).ino,
            },
            writerGeneration: writerLease.generation,
            intentReferences: facts.references,
          });
        }
        const fenceBinding = object(observed["binding"]);
        let phase = observed["state"] as "pending" | "consumed";
        if (invokeMode === "verify-completed" && phase !== "consumed") refuse();
        const storeInfo = fs.statSync(pinned.store);
        if (
          observed["kind"] !== "fmcad-provision-fence" ||
          observed["version"] !== 1 ||
          !["pending", "consumed"].includes(String(observed["state"])) ||
          fenceBinding["requestId"] !== intent.requestId ||
          fenceBinding["handoffId"] !== intent.handoffId ||
          fenceBinding["oldHead"] !== intent.expectedHead ||
          !isDeepStrictEqual(fenceBinding["store"], {
            path: pinned.store,
            device: storeInfo.dev,
            inode: storeInfo.ino,
          }) ||
          !isDeepStrictEqual(
            fenceBinding["generation"],
            pinned.pins.generation,
          ) ||
          !isDeepStrictEqual(fenceBinding["physicalRuntime"], {
            ...pinned.pins.process,
            version: pinned.runtimeVersion,
            source: pinned.pins.source,
            build: pinned.pins.build,
          }) ||
          fenceBinding["endpointURL"] !== pinned.pins.endpoint ||
          !isDeepStrictEqual(
            fenceBinding["intentReferences"],
            facts.references,
          ) ||
          typeof fenceBinding["initiatorOperatorId"] !== "string" ||
          !fenceBinding["initiatorOperatorId"] ||
          typeof fenceBinding["writerGeneration"] !== "string" ||
          !fenceBinding["writerGeneration"]
        )
          refuse();
        const intentEvidence = (name: string, bytes: Buffer) => {
          if (phase === "pending")
            return immutable(pinned.evidenceDirectory, name, bytes);
          const reference = {
            path: path.join(pinned.evidenceDirectory, name),
            sha256: sha(bytes),
          };
          privateBytes(reference);
          return reference;
        };
        const fenceReference = intentEvidence(
          `${intent.requestId}-native-intent.json`,
          Buffer.from(JSON.stringify(fenceBinding)),
        );
        const binding: NativeRuntimeBarrierBinding = {
          ...pinned.pins,
          retiredProcess: facts.retiredProcess,
          retirement: "process_dead",
          ingress: "pinned_all_sdk_ingress",
          grantCount: 0,
          admissionCount: 0,
          writerGeneration: fenceBinding["writerGeneration"],
        };
        const bindingReference = intentEvidence(
          `${intent.requestId}-barrier.json`,
          Buffer.from(JSON.stringify(binding)),
        );
        let active = true;
        let settled = false;
        const assertHeld = () => {
          if (!active) refuse();
          writerLease.assertHeld();
          // Presence alone is not native authority. It prevents a fresh Linux
          // writer from changing local metadata after this parent dies.
          if (!settled && invokeMode === "publish-or-resume") {
            const value = currentFile(markerFile);
            if (!value || !existingMarker(value, intent)) refuse();
          }
        };
        const verify = async () => {
          if (settled || phase !== "pending") refuse();
          assertHeld();
          originalFacts(pinned);
          const current = await nativeFence(
            pinned,
            facts.retiredProcess,
            "query",
            { requestId: intent.requestId },
          );
          if (
            !isDeepStrictEqual(current["binding"], fenceBinding) ||
            current["state"] !== "pending"
          )
            refuse();
          assertHeld();
          return {
            binding: structuredClone(binding),
            evidence: structuredClone([
              ...facts.references,
              fenceReference,
              bindingReference,
            ]),
          };
        };
        const queryCompletion = async (
          publication: NativeRuntimeActivationPublication,
        ) => {
          assertHeld();
          const terminal = await nativeFence(
            pinned,
            facts.retiredProcess,
            "query",
            { requestId: intent.requestId },
          );
          return authenticatedCompletion(
            pinned,
            key,
            fenceBinding,
            intent.requestId,
            publication,
            terminal,
          );
        };
        const assertExistingNew = (
          publication: NativeRuntimeActivationPublication,
        ) => {
          assertHeld();
          privateDirectory(pinned.store);
          const info = fs.statSync(pinned.store);
          if (
            publication.store !== pinned.store ||
            publication.storeDevice !== info.dev ||
            publication.storeInode !== info.ino ||
            publication.activationFile !==
              path.join(pinned.store, "runtime-rebaseline-head.json") ||
            !currentFile(publication.activationFile)?.equals(
              Buffer.from(publication.activationBytes),
            )
          )
            refuse("RUNTIME_BARRIER_CHANGED");
          privateBytes(publication.record);
        };
        try {
          return await work({
            initiatorOperatorId: fenceBinding["initiatorOperatorId"],
            get fenceState() {
              return phase;
            },
            assertWriterAndProvisionLock: assertHeld,
            verifyCurrentBarrier: verify,
            async publishActivation(publication) {
              publication = structuredClone(publication);
              if (invokeMode !== "publish-or-resume") refuse();
              if (phase === "pending") await verify();
              else {
                assertExistingNew(publication);
                await queryCompletion(publication);
              }
              publishPosix(
                pinned,
                intent,
                publication,
                assertHeld,
                phase === "consumed",
              );
            },
            async consumeActivation(publication) {
              publication = structuredClone(publication);
              if (invokeMode !== "publish-or-resume") refuse();
              let completion: NativeRuntimeActivationCompletion | undefined;
              if (phase === "pending") await verify();
              else {
                assertExistingNew(publication);
                completion = await queryCompletion(publication);
              }
              // Resume exact NEW re-fsyncs instead of depending on old ACKs.
              publishPosix(
                pinned,
                intent,
                publication,
                assertHeld,
                phase === "consumed",
              );
              if (phase === "pending") {
                const publicationJson = JSON.stringify(publication);
                const publicationDigest = sha(Buffer.from(publicationJson));
                const mac = createHmac("sha256", key)
                  .update("fmcad-posix-publication-v1\0")
                  .update(
                    pythonEncoding({
                      binding: fenceBinding,
                      publicationDigest,
                    }),
                  )
                  .digest("hex");
                await nativeFence(pinned, facts.retiredProcess, "consume", {
                  requestId: intent.requestId,
                  fenceNonce: fenceBinding["fenceNonce"],
                  publicationJson,
                  attestation: {
                    keyId: pinned.publicationAuthority.keyId,
                    mac,
                  },
                });
                completion = await queryCompletion(publication);
              }
              if (!completion) refuse();
              phase = "consumed";
              assertHeld();
              if (fs.existsSync(markerFile)) {
                fs.unlinkSync(markerFile);
                syncDirectory(pinned.store);
              }
              settled = true;
              return completion;
            },
            async verifyNativeConsumeReceipt(publication, completion) {
              publication = structuredClone(publication);
              completion = structuredClone(completion);
              assertHeld();
              privateDirectory(pinned.store);
              const info = fs.statSync(pinned.store);
              if (
                publication.store !== pinned.store ||
                publication.storeDevice !== info.dev ||
                publication.storeInode !== info.ino ||
                publication.activationFile !==
                  path.join(pinned.store, "runtime-rebaseline-head.json") ||
                !currentFile(publication.activationFile)?.equals(
                  Buffer.from(publication.activationBytes),
                )
              )
                refuse();
              privateBytes(publication.record);
              const terminal = await nativeFence(
                pinned,
                facts.retiredProcess,
                "query",
                { requestId: intent.requestId },
              );
              const verified = authenticatedCompletion(
                pinned,
                key,
                fenceBinding,
                intent.requestId,
                publication,
                terminal,
              );
              if (!isDeepStrictEqual(verified, completion)) refuse();
              privateBytes(completion.nativeReceipt.reference);
              // Completed query never publishes, consumes or requires zero
              // ordinary work. Core re-fsyncs completion/dependencies before
              // this final authenticated query, then this marker may settle.
              assertHeld();
              if (!settled && fs.existsSync(markerFile)) {
                fs.unlinkSync(markerFile);
                syncDirectory(pinned.store);
                settled = true;
              }
              lastApproved = structuredClone({
                request: intent,
                publication,
                completion,
                fenceBinding,
              });
            },
          });
        } finally {
          active = false;
        }
      });
    },
  };
}

function existingMarker(
  bytes: Buffer,
  request: NativeRuntimeRebaselineRequest,
): boolean {
  const value = object(
    decodeAdmissionJson(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ),
  );
  return (
    value["version"] === 1 &&
    value["requestId"] === request.requestId &&
    value["expectedHead"] === request.expectedHead
  );
}

export function createNativeRuntimeRebaselineAuthorityPorts(
  options: NativeRuntimeRebaselineOptions,
): NativeRuntimeRebaselineAuthorityPorts {
  try {
    const ports = nativeRuntimeRebaselineAuthorityPorts(options);
    const nativeOperation = async <T>(work: () => Promise<T>): Promise<T> => {
      try {
        return await work();
      } catch (error) {
        if (error instanceof NativeRuntimeBarrierError) throw error;
        throw new NativeRuntimeBarrierError("RUNTIME_BARRIER_UNPROVEN");
      }
    };
    return {
      ...ports,
      getVerifiedActivation: (descriptor) =>
        nativeOperation(() => ports.getVerifiedActivation(descriptor)),
      async withExclusiveBarrier(request, invokeMode, work) {
        let callbackFailed = false;
        let callbackError: unknown;
        try {
          return await ports.withExclusiveBarrier(
            request,
            invokeMode,
            async (lease) => {
              try {
                return await work({
                  initiatorOperatorId: lease.initiatorOperatorId,
                  get fenceState() {
                    return lease.fenceState;
                  },
                  assertWriterAndProvisionLock() {
                    try {
                      lease.assertWriterAndProvisionLock();
                    } catch (error) {
                      if (error instanceof NativeRuntimeBarrierError)
                        throw error;
                      throw new NativeRuntimeBarrierError(
                        "RUNTIME_BARRIER_UNPROVEN",
                      );
                    }
                  },
                  verifyCurrentBarrier: () =>
                    nativeOperation(() => lease.verifyCurrentBarrier()),
                  publishActivation: (publication) =>
                    nativeOperation(() => lease.publishActivation(publication)),
                  consumeActivation: (publication) =>
                    nativeOperation(() => lease.consumeActivation(publication)),
                  verifyNativeConsumeReceipt: (publication, completion) =>
                    nativeOperation(() =>
                      lease.verifyNativeConsumeReceipt(publication, completion),
                    ),
                });
              } catch (error) {
                callbackFailed = true;
                callbackError = error;
                throw error;
              }
            },
          );
        } catch (error) {
          if (callbackFailed && error === callbackError) throw error;
          if (error instanceof NativeRuntimeBarrierError) throw error;
          throw new NativeRuntimeBarrierError("RUNTIME_BARRIER_UNPROVEN");
        }
      },
    };
  } catch (error) {
    if (error instanceof NativeRuntimeBarrierError) throw error;
    throw new NativeRuntimeBarrierError("RUNTIME_BARRIER_UNPROVEN");
  }
}

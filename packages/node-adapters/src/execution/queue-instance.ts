import * as fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  prepareEncodedWireArtifact,
  prepareWireArtifact,
} from "../python/source-units";
import { verifyPythonArtifact } from "../python/artifact";
import { pythonArtifactManifest } from "../python/context-binding";
import { queueDocumentSnapshotSource } from "../python/document-probe";
import {
  durable,
  readJson,
  readBytes,
  MAX_JSON_RECORD_BYTES,
} from "../persistence/records";
import type { PythonArtifactManifest } from "../../../core/src/domain/python-artifact";
import {
  decodeAdmissionJson,
  validateOpaqueJsonObject,
} from "./admission-json";
import type { BootstrapStartupAudit } from "./bootstrap-entry-evidence";

const PROBE_OBSERVATION_SCHEMA = "fmcad-instance-probe-v1";
const PUBLIC_PYTHON_RESULT_SCHEMA = "fmcad-public-python-result-v1";

export interface ProcessIdentity {
  pid: number;
  birth: string;
}
export interface FusionIdentity extends ProcessIdentity {
  version: string;
  activeCommand?: string;
  documents: unknown[];
  /** Observation data only, never process/startup qualification or authority. */
  startupAudit?: StartupSdkAudit;
}
export type StartupSdkAudit = BootstrapStartupAudit;
export interface BrokerPhysicalConfig {
  backend?: unknown;
  url?: unknown;
  headers?: unknown;
  timeoutMs?: unknown;
  tool?: unknown;
  transport?: unknown;
  curlPath?: unknown;
  protocolVersion?: unknown;
}
interface NativeReceiptIdentity {
  commandId?: string;
  runId?: string;
  requestHash?: string;
  sessionNonce?: string;
  resolvedIdentity?: { creationId?: unknown };
}
interface SavedCurrent {
  saved?: unknown;
  modified?: unknown;
  isComplete?: unknown;
  creationId?: unknown;
  fileId?: unknown;
  fileName?: unknown;
  projectId?: unknown;
  folderId?: unknown;
}
interface WorkflowValue extends NativeReceiptIdentity {
  nativeReceiptIdentity?: NativeReceiptIdentity;
  identity?: NativeReceiptIdentity;
  current?: SavedCurrent;
  target?: { name?: unknown; projectId?: unknown; folderId?: unknown };
  operation?: string;
  accepted?: unknown;
  pending?: unknown;
  status?: string;
  targetObserved?: unknown;
  destroyed?: unknown;
  outcome?: unknown;
  executionOutcome?: unknown;
  completed?: unknown;
  result?: WorkflowValue;
  data?: WorkflowValue;
  workflowOutcome?: WorkflowValue;
  structuredContent?: WorkflowValue;
  content?: { type?: unknown; text?: unknown }[];
  text?: unknown;
  stdout?: unknown;
}
export interface ProbeOutput {
  failed?: unknown;
  text?: string;
  data?: unknown;
  rawResponse?: string;
}
export interface ProbeReceiptObservation {
  readonly path: string;
  readonly sha256: string;
  /** Exact original bytes that were decoded and checked, not a reconstructed DTO. */
  readonly bytes: Uint8Array;
}
interface ProbeArguments {
  featureType: string;
  object: { script: string; readOnly: boolean };
}
type PreparedProbeSend = (() => Promise<ProbeOutput>) & {
  fence?: () => unknown;
};
export interface ProbeClient {
  server: { timeoutMs: number };
  prepareCallTool?: (
    args: ProbeArguments,
    tool: string,
    manifest: PythonArtifactManifest,
  ) => Promise<PreparedProbeSend>;
  callTool(args: ProbeArguments, tool: string): Promise<ProbeOutput>;
}
export interface ProbeOptions {
  /** Private fixed-program selection, never read from config/IPC/RPC flags. */
  startupAudit?: true;
  assertCurrent?: () => void;
  receiptPath?: string;
  binding?: unknown;
  requireIdle?: boolean;
  onObservation?: (
    identity: FusionIdentity,
    receipt?: ProbeReceiptObservation,
  ) => unknown;
  diagnosticPath?: string;
  documentSelector?: unknown;
  mapPath?: (file: string) => string;
}

/** The facade anchor preserves installation discovery in source and packaged trees. */
export function createQueueInstance(
  anchor: string,
  platform: Pick<
    typeof import("../config-platform"),
    | "resolveRuntimePaths"
    | "runtimeBuildIdentity"
    | "toWindowsPath"
    | "detectPlatform"
  >,
) {
  const {
    resolveRuntimePaths,
    runtimeBuildIdentity,
    toWindowsPath,
    detectPlatform,
  } = platform;
  const fail = (code: string, message: string): never => {
    throw Object.assign(new Error(message), { code });
  };
  const hash = (value: string | Uint8Array): string =>
    createHash("sha256").update(value).digest("hex");

  function brokerConfigHash(cfg: BrokerPhysicalConfig) {
    // The broker identity binds physical backend settings, not local client
    // routing, queue policy or Control Center preferences.
    return hash(
      JSON.stringify({
        backend: cfg.backend,
        url: cfg.url,
        headers: cfg.headers,
        timeoutMs: cfg.timeoutMs,
        tool: cfg.tool,
        transport: cfg.transport,
        curlPath: cfg.curlPath,
        protocolVersion: cfg.protocolVersion,
        // Keep the historical canonical identity field; public routing is always queue.
        routing: "direct",
        queue: {},
      }),
    );
  }

  function processBirth(pid = process.pid) {
    // Linux start ticks plus boot id distinguish reused PIDs and machine boots.
    if (process.platform !== "linux")
      fail(
        "UNSUPPORTED_HOST",
        "Broker ownership currently requires Linux /proc birth identity",
      );
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (["Z", "X"].includes(fields[0]!)) fail("ESRCH", "Process has exited");
    const ticks = fields[19];
    if (!/^\d+$/.test(ticks!))
      fail("INVALID_PROCESS_IDENTITY", "Process birth ticks are unavailable");
    return `${fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${ticks}`;
  }

  function priorProcessAlive(identity: ProcessIdentity | null | undefined) {
    if (
      !identity ||
      !Number.isSafeInteger(identity.pid) ||
      identity.pid <= 0 ||
      typeof identity.birth !== "string"
    )
      return null;
    if (identity.birth.includes(":")) {
      try {
        return processBirth(identity.pid) === identity.birth;
      } catch (error) {
        return ["ENOENT", "ESRCH"].includes(
          (error as NodeJS.ErrnoException).code as string,
        )
          ? false
          : null;
      }
    }
    // Fusion's Windows birth value is a FILETIME. CIM CreationDate is rounded to
    // milliseconds; Get-Process.StartTime preserves the exact FILETIME used by Fusion.
    try {
      const script = `$p=Get-Process -Id ${identity.pid} -ErrorAction SilentlyContinue; if ($null -eq $p) { 'absent' } else { $p.StartTime.ToFileTimeUtc().ToString() }`;
      const value = execFileSync(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        { encoding: "utf8", timeout: 3000, windowsHide: true },
      ).trim();
      if (value === "absent") return false;
      return /^\d+$/.test(value) ? value === identity.birth : null;
    } catch {
      return null;
    }
  }

  function reclaim(
    dir: string,
    recoverCurrent?: () => void,
    /** Administrative admission only; runs under recovery.lock, never recovery. */
    assertReclaimable?: (owner: unknown) => void,
  ) {
    const directoryFd = assertReclaimable
      ? fs.openSync(
          dir,
          fs.constants.O_RDONLY |
            fs.constants.O_DIRECTORY |
            fs.constants.O_NOFOLLOW,
        )
      : undefined;
    const operationDir =
      directoryFd === undefined ? dir : `/proc/self/fd/${directoryFd}`;
    try {
      return reclaimHeld();
    } finally {
      if (directoryFd !== undefined) fs.closeSync(directoryFd);
    }
    function reclaimHeld() {
      const file = path.join(operationDir, "broker.lock");
      const marker = readJson(file) as ProcessIdentity & { nonce?: string };
      if (
        !Number.isSafeInteger(marker.pid) ||
        marker.pid <= 0 ||
        typeof marker.birth !== "string"
      )
        fail("INVALID_LOCK", "Invalid broker ownership marker");
      let dead = false;
      try {
        dead = processBirth(marker.pid) !== marker.birth;
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code === "ENOENT" ||
          (error as NodeJS.ErrnoException).code === "ESRCH"
        )
          dead = true;
        else throw error;
      }
      if (!dead)
        fail(
          "BROKER_ALIVE",
          "The original broker PID and birth identity are still alive",
        );
      // An exclusive recovery claim prevents two recovery commands removing a new lock.
      const claim = path.join(operationDir, "recovery.lock");
      const recoveryOwner = {
        pid: process.pid,
        birth: processBirth(),
        ...(assertReclaimable ? { nonce: randomUUID() } : {}),
      };
      durable(claim, recoveryOwner, true);
      let ownerFd: number | undefined;
      let recoveryFd: number | undefined;
      let assertRecoveryClaim: (() => void) | undefined;
      try {
        if (assertReclaimable) {
          recoveryFd = fs.openSync(
            claim,
            fs.constants.O_RDONLY |
              fs.constants.O_NOFOLLOW |
              fs.constants.O_NONBLOCK,
          );
          const identity = fs.fstatSync(recoveryFd, { bigint: true });
          const bytes = readBytes(claim, MAX_JSON_RECORD_BYTES);
          assertRecoveryClaim = () => {
            const held = fs.fstatSync(recoveryFd!, { bigint: true });
            const named = fs.lstatSync(claim, { bigint: true });
            if (
              !held.isFile() ||
              named.isSymbolicLink() ||
              held.uid !== BigInt(process.getuid!()) ||
              (held.mode & 0o077n) !== 0n
            )
              fail(
                "LOCK_CHANGED",
                "Recovery ownership changed during recovery",
              );
            for (const key of [
              "dev",
              "ino",
              "size",
              "mtimeNs",
              "ctimeNs",
            ] as const)
              if (held[key] !== identity[key] || named[key] !== identity[key])
                fail(
                  "LOCK_CHANGED",
                  "Recovery ownership changed during recovery",
                );
            if (
              !bytes.equals(Buffer.from(JSON.stringify(recoveryOwner))) ||
              !readBytes(claim, MAX_JSON_RECORD_BYTES).equals(bytes)
            )
              fail(
                "LOCK_CHANGED",
                "Recovery ownership changed during recovery",
              );
          };
          assertRecoveryClaim();
        }
        // A graceful close must not race with a new serve while recovery owns the directory.
        const current = readJson(file);
        if (JSON.stringify(current) !== JSON.stringify(marker))
          fail("LOCK_CHANGED", "Broker ownership changed during recovery");
        let assertGuarded = () => {};
        if (assertReclaimable) {
          ownerFd = fs.openSync(
            file,
            fs.constants.O_RDONLY |
              fs.constants.O_NOFOLLOW |
              fs.constants.O_NONBLOCK,
          );
          const identity = fs.fstatSync(ownerFd, { bigint: true });
          const bytes = readBytes(file, MAX_JSON_RECORD_BYTES);
          assertGuarded = () => {
            assertRecoveryClaim!();
            const held = fs.fstatSync(ownerFd!, { bigint: true });
            const named = fs.lstatSync(file, { bigint: true });
            if (!held.isFile() || named.isSymbolicLink())
              fail("LOCK_CHANGED", "Broker ownership changed during recovery");
            for (const key of [
              "dev",
              "ino",
              "size",
              "mtimeNs",
              "ctimeNs",
            ] as const)
              if (held[key] !== identity[key] || named[key] !== identity[key])
                fail(
                  "LOCK_CHANGED",
                  "Broker ownership changed during recovery",
                );
            if (
              !readBytes(file, MAX_JSON_RECORD_BYTES).equals(bytes) ||
              !isDeepStrictEqual(readJson(file), marker)
            )
              fail("LOCK_CHANGED", "Broker ownership changed during recovery");
            const verdict: unknown = assertReclaimable(current);
            if (verdict !== undefined) {
              // Never await a guard or permit an async admission to outlive the
              // claim. Observe a rejected Promise without leaking its contents.
              void Promise.resolve(verdict).catch(() => {});
              fail(
                "INVALID_RECLAIM_GUARD",
                "Administrative reclaim admission must be synchronous",
              );
            }
          };
          assertGuarded();
        }
        // The broker composition may classify interrupted current-epoch work.
        // Keep both ownership markers until that durable recovery has completed,
        // so no new broker can observe or race a partially recovered snapshot.
        recoverCurrent?.();
        assertGuarded();
        const reclaimedFile = path.join(dir, `reclaimed-${randomUUID()}.json`);
        const reclaimedArtifact = path.join(
          operationDir,
          path.basename(reclaimedFile),
        );
        durable(reclaimedArtifact, marker, true);
        const lifecycleFile = path.join(
          operationDir,
          `broker-lifecycle-${String(marker.nonce)}.json`,
        );
        const lifecycleValue = fs.existsSync(lifecycleFile)
          ? readJson(lifecycleFile)
          : {};
        const lifecycle = isRecord(lifecycleValue) ? lifecycleValue : {};
        // A bounded local rejection never replaces the last actual SDK owner.
        assertGuarded();
        if (!(
          lifecycle["stage"] === "rejected" &&
          lifecycle["code"] === "NORMAL_RESTART_UNPROVEN" &&
          lifecycle["probeNotSubmitted"] === true &&
          lifecycle["safeToRecover"] === true
        ))
          durable(path.join(operationDir, "broker-reclaimed-head.json"), {
            ownerReference: {
              path: reclaimedFile,
              sha256: hash(fs.readFileSync(reclaimedArtifact)),
            },
          });
        assertGuarded();
        fs.unlinkSync(file);
        const fd = fs.openSync(operationDir, "r");
        try {
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        return {
          reclaimed: true,
          previous: { pid: marker.pid, birth: marker.birth },
          reconciliationRequired: true,
        };
      } finally {
        try {
          if (ownerFd !== undefined) fs.closeSync(ownerFd);
        } finally {
          if (!assertReclaimable) fs.unlinkSync(claim);
          else {
            try {
              if (assertRecoveryClaim) {
                assertRecoveryClaim();
                fs.unlinkSync(claim);
              }
            } finally {
              if (recoveryFd !== undefined) fs.closeSync(recoveryFd);
            }
          }
        }
      }
    }
  }

  function buildHash(root?: string) {
    const paths = resolveRuntimePaths({ anchor: anchor });
    return runtimeBuildIdentity(
      root
        ? {
            ...paths,
            installation: root,
            assets: path.join(root, "assets"),
            runtime: path.join(root, "runtime/python"),
          }
        : paths,
    );
  }

  function fusionPath(file: string) {
    return toWindowsPath(file, detectPlatform());
  }

  // Shared by the read-only probe and remote terminal receipts. Never substitute PID alone.
  const identityPython = `import os as _qi_os, sys as _qi_sys, adsk.core as _qi_core
from typing import Protocol as _qi_Protocol, cast as _qi_cast, Sequence as _qi_Sequence
class _qi_ProcessHandle(_qi_Protocol):
    restype: object
    def __call__(self) -> object: ...
class _qi_ProcessTimes(_qi_Protocol):
    argtypes: _qi_Sequence[object]
    def __call__(self, handle: object, creation: object, exit: object, kernel: object, user: object) -> int: ...
class _qi_Kernel(_qi_Protocol):
    GetCurrentProcess: _qi_ProcessHandle
    GetProcessTimes: _qi_ProcessTimes
def _qi_identity() -> dict[str, object]:
    _app = _qi_core.Application.get()
    if _qi_os.name == 'nt':
        import ctypes as _ct
        from ctypes import wintypes as _wt
        # Audited Win32 ABI: GetProcessTimes(HANDLE, FILETIME*, FILETIME*, FILETIME*, FILETIME*).
        _kernel = _qi_cast(_qi_Kernel, _ct.WinDLL('kernel32', use_last_error=True))
        _kernel.GetCurrentProcess.restype = _wt.HANDLE
        _kernel.GetProcessTimes.argtypes = [_wt.HANDLE] + [_ct.POINTER(_wt.FILETIME)] * 4
        _times = [_wt.FILETIME() for _ in range(4)]
        if not _kernel.GetProcessTimes(_kernel.GetCurrentProcess(), _ct.byref(_times[0]), _ct.byref(_times[1]), _ct.byref(_times[2]), _ct.byref(_times[3])):
            raise OSError(_ct.get_last_error(), 'GetProcessTimes')
        _birth = str((_times[0].dwHighDateTime << 32) | _times[0].dwLowDateTime)
    elif _qi_sys.platform.startswith('linux'):
        with open('/proc/self/stat') as _f: _stat = _f.read()
        with open('/proc/sys/kernel/random/boot_id') as _f: _boot = _f.read().strip()
        _birth = _boot + ':' + _stat[_stat.rfind(')') + 2:].split()[19]
    else:
        raise RuntimeError('Actual process birth identity unavailable on this Fusion host')
    return {'pid':_qi_os.getpid(), 'birth':_birth, 'version':_app.version,
            'activeCommand':_app.userInterface.activeCommand}
`;

  const startupAuditPython = String.raw`
import hashlib as _qs_hashlib, math as _qs_math
from pathlib import Path as _qs_Path
def _qs_fail(_code: str, _field: str) -> None:
    raise RuntimeError('BOOTSTRAP_STARTUP_AUDIT_' + _code + ': ' + _field)
def _qs_text(_raw: object, _field: str, _limit: int, _path: bool = False) -> str:
    if type(_raw) is not str:
        raise TypeError('BOOTSTRAP_STARTUP_AUDIT_VALUE_UNVERIFIED: ' + _field)
    if not _raw or len(_raw) > _limit or len(_raw.encode('utf-8')) > _limit or '\0' in _raw or (_path and not _qs_Path(_raw).is_absolute()):
        _qs_fail('VALUE_UNVERIFIED', _field)
    return _raw
def _qs_bool(_raw: object, _field: str) -> bool:
    if type(_raw) is not bool:
        raise TypeError('BOOTSTRAP_STARTUP_AUDIT_VALUE_UNVERIFIED: ' + _field)
    return _raw
def _qs_count(_raw: object) -> int:
    if type(_raw) is not int or _raw < 0:
        raise TypeError('BOOTSTRAP_STARTUP_AUDIT_VALUE_UNVERIFIED: scripts.count')
    if _raw > 1024:
        _qs_fail('COUNT_BUDGET_EXCEEDED', 'scripts.count')
    return _raw
def _qs_enum(_raw: object) -> int:
    # SDK enum getters are numeric at runtime; never coerce unknown/bool values.
    if type(_raw) is not int:
        raise TypeError('BOOTSTRAP_STARTUP_AUDIT_ENUM_UNVERIFIED: ScriptSourceLocations')
    return _raw
def _qs_pairs(_items: list[tuple[str, object]]) -> dict[str, object]:
    _result: dict[str, object] = {}
    for _key, _item in _items:
        if _key in _result:
            _qs_fail('MANIFEST_UNVERIFIED', 'duplicate JSON key')
        _result[_key] = _item
    return _result
def _qs_bad(_text: str) -> object:
    _qs_fail('MANIFEST_UNVERIFIED', 'nonfinite JSON')
    return None
def _qs_float(_text: str) -> float:
    _number = float(_text)
    if not _qs_math.isfinite(_number):
        _qs_fail('MANIFEST_UNVERIFIED', 'nonfinite JSON')
    return _number
def _qs_size(_value: object) -> int:
    return len(_qi_json.dumps(_value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8'))
def _qs_audit(_app: _qi_core.Application) -> dict[str, object]:
    _version = _qs_text(_app.version, 'Application.version', 65536)
    _parent = _qs_text(_app.preferences.apiPreferences.defaultPathForScriptsAndAddIns,
                      'defaultPathForScriptsAndAddIns', 65536, True)
    _scripts = _qi_cast('_qi_core.Scripts | None', _app.scripts)
    if _scripts is None:
        raise TypeError('BOOTSTRAP_STARTUP_AUDIT_VALUE_UNVERIFIED: Application.scripts')
    _before = _qs_count(_scripts.count)
    _locations: dict[int, str] = {}
    for _name, _candidate in (
        ('AppStoreScriptSourceLocation', _qi_core.ScriptSourceLocations.AppStoreScriptSourceLocation),
        ('OtherInstalledScriptSourceLocation', _qi_core.ScriptSourceLocations.OtherInstalledScriptSourceLocation),
        ('UserDefinedScriptSourceLocation', _qi_core.ScriptSourceLocations.UserDefinedScriptSourceLocation),
        ('InternalScriptSourceLocation', _qi_core.ScriptSourceLocations.InternalScriptSourceLocation),
        ('SamplesScriptSourceLocation', _qi_core.ScriptSourceLocations.SamplesScriptSourceLocation),
        ('LinkedScriptSourceLocation', _qi_core.ScriptSourceLocations.LinkedScriptSourceLocation)):
        _enum = _qs_enum(_candidate)
        if _enum in _locations:
            raise TypeError('BOOTSTRAP_STARTUP_AUDIT_ENUM_UNVERIFIED: ScriptSourceLocations')
        _locations[_enum] = _name
    _rows: list[dict[str, object]] = []
    _budget = 0
    for _index in range(_before):
        # SDK documentation explicitly permits null for an invalid item index.
        _script = _qi_cast('_qi_core.Script | None', _scripts.item(_index))
        if _script is None:
            raise TypeError('BOOTSTRAP_STARTUP_AUDIT_VALUE_UNVERIFIED: scripts.item')
        _folder = _qs_text(_script.folder, 'folder', 65536, True)
        _location = _qs_enum(_script.location)
        if _location not in _locations:
            raise TypeError('BOOTSTRAP_STARTUP_AUDIT_ENUM_UNVERIFIED: location')
        _addin = _qs_bool(_script.isAddIn, 'isAddIn')
        _startup = _qs_bool(_script.isRunOnStartup, 'isRunOnStartup') if _addin else None
        _running = _qs_bool(_script.isRunning, 'isRunning')
        _visible = _qs_bool(_script.isVisible, 'isVisible')
        _manifest = _qs_text(_script.manifestContent, 'manifestContent', 256 * 1024)
        _parsed = _qi_cast(object, _qi_json.loads(_manifest, object_pairs_hook=_qs_pairs,
                          parse_constant=_qs_bad, parse_float=_qs_float))
        if type(_parsed) is not dict:
            _qs_fail('MANIFEST_UNVERIFIED', 'manifestContent')
        _row: dict[str, object] = {
            'index': _index, 'folder': _folder,
            'location': {'name': _locations[_location], 'value': _location},
            'isAddIn': _addin, 'isRunOnStartup': _startup,
            'isRunning': _running, 'isVisible': _visible,
            'manifest': {'content': _manifest, 'sha256': _qs_hashlib.sha256(_manifest.encode('utf-8')).hexdigest(),
                         'parseStatus': 'json-object'}}
        _budget += _qs_size(_row)
        if _budget > 4 * 1024 * 1024:
            _qs_fail('BYTE_BUDGET_EXCEEDED', 'scripts')
        _rows.append(_row)
    _after = _qs_count(_scripts.count)
    if _before != _after:
        _qs_fail('COLLECTION_CHANGED', 'scripts.count')
    _parent_after = _qs_text(_app.preferences.apiPreferences.defaultPathForScriptsAndAddIns,
                            'defaultPathForScriptsAndAddInsAfter', 65536, True)
    if _parent != _parent_after:
        _qs_fail('PREFERENCES_CHANGED', 'defaultPathForScriptsAndAddIns')
    _audit: dict[str, object] = {
        'kind': 'fmcad-startup-sdk-audit', 'version': 1, 'applicationVersion': _version,
        'preferences': {'defaultPathForScriptsAndAddIns': _parent},
        'scripts': {'countBefore': _before, 'countAfter': _after, 'items': _rows}}
    if _qs_size(_audit) > 4 * 1024 * 1024:
        _qs_fail('BYTE_BUDGET_EXCEEDED', 'audit')
    return _audit
`;
  const probeScript = (
    metadata: boolean,
    startupAudit = false,
  ) => `${identityPython}
import json as _qi_json
${startupAudit ? startupAuditPython : ""}
def run(_context: str) -> dict[str, object]:
    _value = _qi_identity()
    _app = _qi_core.Application.get()
    _documents: list[dict[str, object]] = []
    _value['documents'] = _documents
    for _i in range(_app.documents.count):
        _doc = _app.documents.item(_i)
        _row: dict[str, object] = {'id':_doc.creationId, 'fileId':None,
            'isSaved':_doc.isSaved, 'isModified':_doc.isModified}
        _data, _error = _document_data_file(_doc)
        _row['fileId'] = _data.id if _data else None${metadata ? "\n        _row['version'] = _data.versionNumber if _data else None" : ""}
        if _error:
            _row['dataFileError'] = _error
        _documents.append(_row)${startupAudit ? "\n    _value['startupAudit'] = _qs_audit(_app)" : ""}
${startupAudit ? "    # Optional startup data stays in the original bound receipt, not console stdout." : "    print('FMCAD_QUEUE_INSTANCE ' + _qi_json.dumps(_value))"}
    return _value
`;

  const sameInstance = (
    a: FusionIdentity | null | undefined,
    b: FusionIdentity | null | undefined,
  ) =>
    !!(
      a &&
      b &&
      a.pid === b.pid &&
      a.birth === b.birth &&
      a.version === b.version
    );
  const idle = (identity: FusionIdentity | null | undefined) =>
    !!identity && ["", "SelectCommand"].includes(identity.activeCommand!);
  function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }
  function isStartupAudit(value: unknown): value is StartupSdkAudit {
    const exact = (
      row: unknown,
      keys: readonly string[],
    ): row is Record<string, unknown> =>
      isRecord(row) &&
      isDeepStrictEqual(Object.keys(row).sort(), [...keys].sort());
    const text = (
      raw: unknown,
      limit: number,
      absolute = false,
    ): raw is string =>
      typeof raw === "string" &&
      !!raw &&
      !raw.includes("\0") &&
      Buffer.byteLength(raw, "utf8") <= limit &&
      Buffer.from(raw, "utf8").toString("utf8") === raw &&
      (!absolute ||
        path.posix.isAbsolute(raw) ||
        /^[a-z]:[\\/]/i.test(raw) ||
        raw.startsWith("\\\\"));
    const size = (raw: unknown) =>
      Buffer.byteLength(
        JSON.stringify(raw).replace(
          /[\u007f-\uffff]/g,
          (character) =>
            "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"),
        ),
        "utf8",
      );
    if (
      !exact(value, [
        "kind",
        "version",
        "applicationVersion",
        "preferences",
        "scripts",
      ]) ||
      value["kind"] !== "fmcad-startup-sdk-audit" ||
      value["version"] !== 1 ||
      !text(value["applicationVersion"], 65536) ||
      !exact(value["preferences"], ["defaultPathForScriptsAndAddIns"]) ||
      !text(
        value["preferences"]["defaultPathForScriptsAndAddIns"],
        65536,
        true,
      ) ||
      !exact(value["scripts"], ["countBefore", "countAfter", "items"])
    )
      return false;
    const scripts = value["scripts"];
    if (
      !Number.isSafeInteger(scripts["countBefore"]) ||
      (scripts["countBefore"] as number) < 0 ||
      (scripts["countBefore"] as number) > 1024 ||
      scripts["countAfter"] !== scripts["countBefore"] ||
      !Array.isArray(scripts["items"]) ||
      scripts["items"].length !== scripts["countBefore"]
    )
      return false;
    const names = new Set([
      "AppStoreScriptSourceLocation",
      "OtherInstalledScriptSourceLocation",
      "UserDefinedScriptSourceLocation",
      "InternalScriptSourceLocation",
      "SamplesScriptSourceLocation",
      "LinkedScriptSourceLocation",
    ]);
    const locations = new Map<string, number>();
    const values = new Map<number, string>();
    for (const [index, row] of scripts["items"].entries()) {
      if (
        !exact(row, [
          "index",
          "folder",
          "location",
          "isAddIn",
          "isRunOnStartup",
          "isRunning",
          "isVisible",
          "manifest",
        ]) ||
        row["index"] !== index ||
        !text(row["folder"], 65536, true) ||
        typeof row["isAddIn"] !== "boolean" ||
        (row["isAddIn"]
          ? typeof row["isRunOnStartup"] !== "boolean"
          : row["isRunOnStartup"] !== null) ||
        typeof row["isRunning"] !== "boolean" ||
        typeof row["isVisible"] !== "boolean" ||
        !exact(row["location"], ["name", "value"]) ||
        typeof row["location"]["name"] !== "string" ||
        !names.has(row["location"]["name"]) ||
        !Number.isSafeInteger(row["location"]["value"]) ||
        !exact(row["manifest"], ["content", "sha256", "parseStatus"])
      )
        return false;
      const location = row["location"];
      const name = location["name"] as string,
        number = location["value"] as number;
      if (
        (locations.has(name) && locations.get(name) !== number) ||
        (values.has(number) && values.get(number) !== name)
      )
        return false;
      locations.set(name, number);
      values.set(number, name);
      const manifest = row["manifest"];
      if (
        !text(manifest["content"], 256 * 1024) ||
        manifest["parseStatus"] !== "json-object" ||
        manifest["sha256"] !== hash(manifest["content"])
      )
        return false;
      try {
        validateOpaqueJsonObject(manifest["content"]);
      } catch {
        return false;
      }
    }
    return size(value) <= 4 * 1024 * 1024;
  }
  function isProbeIdentity(value: unknown): value is FusionIdentity {
    if (
      !isRecord(value) ||
      !Number.isSafeInteger(value["pid"]) ||
      (value["pid"] as number) <= 0 ||
      typeof value["birth"] !== "string" ||
      !value["birth"] ||
      typeof value["version"] !== "string" ||
      !value["version"] ||
      typeof value["activeCommand"] !== "string" ||
      !Array.isArray(value["documents"])
    )
      return false;
    return value["documents"].every((document) => {
      if (
        !isRecord(document) ||
        typeof document["id"] !== "string" ||
        !document["id"] ||
        !(
          document["fileId"] === null ||
          (typeof document["fileId"] === "string" && document["fileId"])
        ) ||
        typeof document["isSaved"] !== "boolean" ||
        typeof document["isModified"] !== "boolean"
      )
        return false;
      const error = document["dataFileError"];
      return (
        error === undefined ||
        (isRecord(error) &&
          typeof error["type"] === "string" &&
          typeof error["message"] === "string")
      );
    });
  }
  function nativeWorkflowIdentity(input: unknown) {
    const value = input as WorkflowValue | null | undefined;
    if (!value || typeof value !== "object") return null;
    const identity = value.nativeReceiptIdentity || value.identity || value;
    const command = identity?.commandId;
    if (
      typeof command !== "string" ||
      typeof identity.runId !== "string" ||
      !identity.runId
    )
      return null;
    if (
      /^fmcad_atomic_[a-f0-9]{32}$/.test(command) &&
      /^[a-f0-9]{64}$/.test(identity.requestHash || "") &&
      /^[a-f0-9]{32}$/.test(identity.sessionNonce || "") &&
      identity.resolvedIdentity?.creationId
    ) {
      return { kind: "atomic-batch", identity };
    }
    return null;
  }
  function cloudSaveProcessing(value: WorkflowValue) {
    const current = value.current,
      target = value.target;
    return (
      value.operation === "document.save_as" &&
      value.accepted === true &&
      value.pending === true &&
      value.status === "pending" &&
      value.targetObserved === true &&
      current?.saved === true &&
      current.modified === false &&
      current.isComplete === false &&
      (
        ["creationId", "fileId", "fileName", "projectId", "folderId"] as const
      ).every((key) => typeof current[key] === "string" && current[key]) &&
      target?.name === current.fileName &&
      target!.projectId === current.projectId &&
      target!.folderId === current.folderId
    );
  }
  const workflowNonterminal = (value: WorkflowValue | null | undefined) =>
    !!(
      value &&
      typeof value === "object" &&
      !(value.destroyed === true && nativeWorkflowIdentity(value)) &&
      (value.outcome === "unknown" ||
        value.executionOutcome === "unknown" ||
        (["started", "running", "pending"].includes(value.status!) &&
          !cloudSaveProcessing(value)) ||
        value.completed === false ||
        (value.status === "unknown" &&
          /^(batch\.|ui\.|references\.refresh$|document\.save_as$|review$)/.test(
            value.operation || "",
          )))
    );

  function workflowOutputNonterminal(input: unknown, depth = 0): boolean {
    const value = input as WorkflowValue | null | undefined;
    if (!value || typeof value !== "object" || depth > 8) return false;
    if (workflowNonterminal(value)) return true;
    for (const key of [
      "result",
      "data",
      "workflowOutcome",
      "structuredContent",
    ] as const) {
      const nested = value[key];
      if (
        nested &&
        workflowOutputNonterminal(
          { ...nested, operation: nested.operation || value.operation },
          depth + 1,
        )
      )
        return true;
    }
    for (const item of Array.isArray(value.content) ? value.content : []) {
      if (
        item?.type === "text" &&
        workflowOutputNonterminal({ text: item.text }, depth + 1)
      )
        return true;
    }
    for (const line of String(value.text || value.stdout || "").split(
      /\r?\n/,
    )) {
      const text = line.replace(/^(?:FMCAD_(?:RESULT|BRIDGE_RESULT)) /, "");
      try {
        const parsed = JSON.parse(text);
        if (workflowOutputNonterminal(parsed, depth + 1)) return true;
      } catch {
        /* Non-JSON console output is not a typed workflow result. */
      }
    }
    return false;
  }

  async function prepareProbe(
    client: ProbeClient,
    {
      receiptPath,
      binding,
      requireIdle = true,
      onObservation,
      assertCurrent,
      diagnosticPath,
      documentSelector,
      startupAudit,
      mapPath = fusionPath,
    }: ProbeOptions = {},
  ) {
    const previousTimeout = client.server.timeoutMs;
    client.server.timeoutMs = Math.min(previousTimeout, 15000);
    let output: ProbeOutput;
    try {
      if (startupAudit !== undefined && startupAudit !== true)
        fail(
          "INSTANCE_UNAVAILABLE",
          "Closed startup audit option must be true or absent",
        );
      if (startupAudit && (!receiptPath || !client.prepareCallTool))
        fail(
          "INSTANCE_UNAVAILABLE",
          "Startup audit requires the original bound receipt and prepared fixed probe",
        );
      if (receiptPath) {
        if (!isRecord(binding) || Object.keys(binding).length === 0)
          fail(
            "INSTANCE_UNAVAILABLE",
            "A source-bound instance probe requires a non-empty receipt binding",
          );
        if (
          ["terminal", "outcome", "instance", "probeObservation"].some((key) =>
            Object.hasOwn(binding as Record<string, unknown>, key),
          )
        )
          fail(
            "INSTANCE_UNAVAILABLE",
            "Instance probe receipt binding uses a reserved field",
          );
        if (fs.existsSync(receiptPath))
          fail(
            "INSTANCE_UNAVAILABLE",
            "Instance probe receipt path is not fresh",
          );
      }
      // Canonical source already includes identity and queue-document helpers.
      // Compose once; receipt binding and final artifact preparation stay below.
      const documentCode = queueDocumentSnapshotSource(
        resolveRuntimePaths({ anchor: anchor }).runtime,
      );
      const identitySource = probeScript(
        isRecord(documentSelector) &&
          documentSelector["kind"] === "saved-document-metadata",
        startupAudit,
      );
      const snapshotAnchor = startupAudit
        ? "    return _value"
        : "    print('FMCAD_QUEUE_INSTANCE '";
      const wrapper =
        documentSelector !== undefined
          ? identitySource.replace(
              snapshotAnchor,
              `    _value['documentState'] = _qd_capture(_app, _qi_cast(dict[str, object] | None, _qi_json.loads(${JSON.stringify(JSON.stringify(documentSelector))})))\n${snapshotAnchor}`,
            )
          : identitySource;
      const code = documentCode + "\n" + wrapper;
      const prepared = receiptPath
        ? prepareReceiptScript(code, true, receiptPath, binding, {
            mapPath,
            captureProbeObservation: true,
          })
        : prepareWireArtifact(
            resolveRuntimePaths({ anchor: anchor }).runtime,
            code,
          );
      verifyPythonArtifact(prepared);
      const script = prepared.script;
      const args = {
        featureType: "script",
        object: { script, readOnly: true },
      };
      const send: PreparedProbeSend = client.prepareCallTool
        ? await client.prepareCallTool(
            args,
            "fusion_mcp_execute",
            pythonArtifactManifest(prepared),
          )
        : () => client.callTool(args, "fusion_mcp_execute");
      let consumed = false;
      const execute = async () => {
        assertCurrent?.();
        if (consumed)
          fail("PREPARED_RPC_CONSUMED", "An instance probe cannot be replayed");
        consumed = true;
        client.server.timeoutMs = Math.min(previousTimeout, 15000);
        try {
          output = await send();
        } catch (error) {
          assertCurrent?.();
          if (diagnosticPath) {
            const details: Record<string, unknown> = {
              stage: "instance_probe",
              at: new Date().toISOString(),
              code:
                (error as NodeJS.ErrnoException).code ||
                "PROBE_TRANSPORT_ERROR",
              message: (error as Error).message,
            };
            const rawResponse = (error as { rawResponse?: unknown })
              .rawResponse;
            const nativeError = (error as { nativeError?: unknown })
              .nativeError;
            if (typeof rawResponse === "string")
              details["rawResponse"] = rawResponse;
            if (nativeError !== undefined) details["nativeError"] = nativeError;
            durable(diagnosticPath, details);
          }
          throw error;
        } finally {
          client.server.timeoutMs = previousTimeout;
        }
        // The original remote receipt, if any, is left untouched. A stale
        // caller must not publish its reply as a local observation.
        assertCurrent?.();
        return inspect(output);
      };
      return Object.assign(execute, { fence: () => send.fence?.() });
    } catch (error) {
      assertCurrent?.();
      if (diagnosticPath && fs.existsSync(path.dirname(diagnosticPath)))
        durable(diagnosticPath, {
          stage: "instance_probe",
          at: new Date().toISOString(),
          code:
            (error as NodeJS.ErrnoException).code || "PROBE_TRANSPORT_ERROR",
          message: (error as Error).message,
        });
      throw error;
    } finally {
      client.server.timeoutMs = previousTimeout;
    }
    async function inspect(output: ProbeOutput) {
      const diagnostic = {
        stage: "instance_probe",
        at: new Date().toISOString(),
        failed: output.failed,
        text: String(output.text || "").slice(-16384),
        data: output.data,
        rawResponse: output.rawResponse,
      };
      if (diagnosticPath) durable(diagnosticPath, diagnostic);
      if (output.failed)
        fail("INSTANCE_UNAVAILABLE", "Read-only Fusion instance probe failed");
      const structured =
        output.data &&
        typeof output.data === "object" &&
        !Array.isArray(output.data)
          ? (output.data as Record<string, unknown>)
          : undefined;
      const stdout =
        typeof structured?.["stdout"] === "string" ? structured["stdout"] : "";
      const marker = "FMCAD_QUEUE_INSTANCE ";
      const lines = [output.text || "", stdout].flatMap((text) =>
        text.split(/\r?\n/).filter((line) => line.startsWith(marker)),
      );
      const wireEvidence = {
        wireMarkerPresent: lines.length > 0,
        wireStdoutPresent: stdout.length > 0,
      };
      if (diagnosticPath)
        durable(diagnosticPath, { ...diagnostic, ...wireEvidence });
      let receiptObservation: FusionIdentity | undefined;
      let receiptOriginal: ProbeReceiptObservation | undefined;
      if (receiptPath) {
        let receipt: Record<string, unknown> = {};
        let originalBytes: Buffer | undefined;
        try {
          const value: unknown = startupAudit
            ? decodeAdmissionJson(
                new TextDecoder("utf-8", { fatal: true }).decode(
                  (originalBytes = readBytes(
                    receiptPath,
                    MAX_JSON_RECORD_BYTES,
                  )),
                ),
              )
            : readJson(receiptPath);
          if (!isRecord(value)) throw new Error("Receipt is not an object");
          receipt = value;
        } catch {
          if (diagnosticPath)
            durable(diagnosticPath, {
              ...diagnostic,
              ...wireEvidence,
              observationSource: null,
              receiptBindingVerified: false,
              receiptOutcome: null,
            });
          fail(
            "INSTANCE_UNAVAILABLE",
            "Source-bound Fusion instance probe receipt is unavailable",
          );
        }
        const expectedBinding = binding as Record<string, unknown>;
        const receiptFields = [
          "terminal",
          "outcome",
          "instance",
          "probeObservation",
        ];
        const allowedReceiptFields = new Set([
          ...Object.keys(expectedBinding),
          ...receiptFields,
        ]);
        const bindingMatches =
          receiptFields.every((key) => Object.hasOwn(receipt, key)) &&
          Object.keys(receipt).every((key) => allowedReceiptFields.has(key)) &&
          Object.entries(expectedBinding).every(([key, value]) =>
            isDeepStrictEqual(receipt[key], value),
          );
        const observation = receipt["probeObservation"];
        const identity = isRecord(observation)
          ? observation["identity"]
          : undefined;
        const terminalIdentity = receipt["instance"];
        const validObservation =
          isRecord(observation) &&
          Object.keys(observation).length === 2 &&
          observation["schema"] === PROBE_OBSERVATION_SCHEMA &&
          isProbeIdentity(identity);
        const validTerminalIdentity = isRecord(terminalIdentity);
        const identitiesMatch =
          validObservation &&
          validTerminalIdentity &&
          terminalIdentity["pid"] === identity.pid &&
          terminalIdentity["birth"] === identity.birth &&
          terminalIdentity["version"] === identity.version &&
          terminalIdentity["activeCommand"] === identity.activeCommand;
        const receiptValid =
          bindingMatches &&
          receipt["terminal"] === true &&
          receipt["outcome"] === "succeeded" &&
          validObservation &&
          identitiesMatch;
        if (diagnosticPath)
          durable(diagnosticPath, {
            ...diagnostic,
            ...wireEvidence,
            observationSource: null,
            receiptObservationValid: receiptValid,
            receiptBindingVerified: bindingMatches,
            receiptTerminal: receipt["terminal"] === true,
            receiptOutcome: receipt["outcome"] ?? null,
            receiptObservationSchema: isRecord(observation)
              ? (observation["schema"] ?? null)
              : null,
          });
        if (!receiptValid)
          fail(
            "INSTANCE_UNAVAILABLE",
            "Source-bound Fusion instance probe receipt is incomplete or mismatched",
          );
        receiptObservation = identity as FusionIdentity;
        if (originalBytes)
          receiptOriginal = Object.freeze({
            path: receiptPath,
            sha256: hash(originalBytes),
            bytes: Uint8Array.from(originalBytes),
          });
      }
      if (!lines.length && !receiptObservation)
        fail(
          "INSTANCE_UNAVAILABLE",
          "Fusion instance probe returned no identity",
        );
      const results = lines.map((line) => {
        let value: unknown;
        try {
          value = JSON.parse(line.slice(marker.length));
        } catch {
          fail(
            "INSTANCE_UNAVAILABLE",
            "Malformed Fusion instance probe marker",
          );
        }
        const result = value as FusionIdentity;
        if (
          !Number.isSafeInteger(result.pid) ||
          !result.birth ||
          !result.version ||
          !Array.isArray(result.documents)
        )
          fail("INSTANCE_UNAVAILABLE", "Incomplete Fusion identity");
        return result;
      });
      if (results.some((result) => !isDeepStrictEqual(result, results[0])))
        fail("INSTANCE_UNAVAILABLE", "Conflicting Fusion instance identities");
      const wireIdentityConflict =
        !!receiptObservation &&
        results.some(
          (result) => !isDeepStrictEqual(result, receiptObservation),
        );
      if (wireIdentityConflict) {
        if (diagnosticPath)
          durable(diagnosticPath, {
            ...diagnostic,
            ...wireEvidence,
            observationSource: null,
            receiptObservationValid: true,
            receiptBindingVerified: true,
            receiptTerminal: true,
            receiptOutcome: "succeeded",
            receiptObservationSchema: PROBE_OBSERVATION_SCHEMA,
            wireIdentityConflict: true,
          });
        fail(
          "INSTANCE_UNAVAILABLE",
          "Wire identity conflicts with the bound receipt observation",
        );
      }
      const result = receiptObservation ?? results[0]!;
      if (
        startupAudit &&
        (!receiptObservation ||
          !isDeepStrictEqual(
            Object.keys(result).sort(),
            [
              "pid",
              "birth",
              "version",
              "activeCommand",
              "documents",
              "startupAudit",
              ...(documentSelector !== undefined ? ["documentState"] : []),
            ].sort(),
          ) ||
          !isStartupAudit(result.startupAudit) ||
          result.startupAudit.applicationVersion !== result.version)
      )
        fail(
          "INSTANCE_UNAVAILABLE",
          "Original bound startup SDK audit is missing or malformed",
        );
      if (diagnosticPath)
        durable(diagnosticPath, {
          ...diagnostic,
          ...(lines[0] ? { text: lines[0] } : {}),
          transportText: diagnostic.text,
          ...wireEvidence,
          ...(receiptObservation
            ? {
                observationSource: "bound-terminal-receipt",
                receiptBindingVerified: true,
                receiptTerminal: true,
                receiptOutcome: "succeeded",
                receiptObservationSchema: PROBE_OBSERVATION_SCHEMA,
              }
            : { observationSource: "wire-marker" }),
        });
      if (onObservation) await onObservation(result, receiptOriginal);
      if (startupAudit) assertCurrent?.();
      if (requireIdle && !idle(result))
        throw Object.assign(
          new Error("An interactive Fusion command is open"),
          {
            code: "FUSION_BUSY",
            probeCompleted: true,
            observation: result,
          },
        );
      return result;
    }
  }

  async function probe(client: ProbeClient, options?: ProbeOptions) {
    return (await prepareProbe(client, options))();
  }

  function receiptWrapper(
    code: string,
    official: boolean,
    receiptPath: string,
    binding: unknown,
    mapPath: (file: string) => string,
    captureProbeObservation = false,
    capturePublicPythonResult = false,
  ) {
    if (capturePublicPythonResult) {
      if (!isRecord(binding) || Object.keys(binding).length === 0)
        fail(
          "INVALID_RECEIPT_CAPTURE",
          "Public Python result capture requires a non-empty receipt binding",
        );
      if (
        ["terminal", "outcome", "instance", "publicPythonResult"].some((key) =>
          Object.hasOwn(binding as Record<string, unknown>, key),
        )
      )
        fail(
          "INVALID_RECEIPT_CAPTURE",
          "Public Python result binding uses a reserved receipt field",
        );
    }
    if (capturePublicPythonResult && !official)
      fail(
        "INVALID_RECEIPT_CAPTURE",
        "Public Python result capture requires an official run entrypoint",
      );
    if (captureProbeObservation && capturePublicPythonResult)
      fail(
        "INVALID_RECEIPT_CAPTURE",
        "Probe observations and public Python results use separate receipt captures",
      );
    const receiptPathGuard = captureProbeObservation
      ? "if _qi_os.path.exists(_qr_path): raise RuntimeError('Probe receipt path already exists')\n"
      : capturePublicPythonResult
        ? "if _qi_os.path.exists(_qr_path): raise RuntimeError('Public result receipt path already exists')\n"
        : "";
    const receiptCaptureDeclaration = captureProbeObservation
      ? "\n_qr_probe_observation: dict[str, object] | None = None"
      : capturePublicPythonResult
        ? "\n_qr_public_python_result: dict[str, object] | None = None"
        : "";
    const receiptCaptureFinalWrite = captureProbeObservation
      ? `\n    if _qr_probe_observation is not None:\n        _qr_record['probeObservation'] = {'schema':${JSON.stringify(PROBE_OBSERVATION_SCHEMA)}, 'identity':_qr_probe_observation}`
      : capturePublicPythonResult
        ? "\n    if _qr_public_python_result is not None:\n        _qr_record['publicPythonResult'] = _qr_public_python_result"
        : "";
    const executeOfficialEntry = !official
      ? ""
      : captureProbeObservation
        ? [
            "    _qr_run = _qr_namespace['run']",
            "    if not callable(_qr_run):",
            "        raise TypeError('Script run entrypoint must be callable')",
            "    _qr_run_result = _qr_cast(_qr_Callable[[str], object], _qr_run)(_context)",
            "    _qr_probe_observation = _qr_object(_qr_run_result)",
            `    _qr_observation = {'schema':${JSON.stringify(PROBE_OBSERVATION_SCHEMA)}, 'identity':_qr_probe_observation}`,
            "    _qr_store(_qr_path, dict(_qr_binding, terminal=False, probeObservation=_qr_observation))",
            "",
          ].join("\n")
        : capturePublicPythonResult
          ? [
              "    _qr_run = _qr_namespace['run']",
              "    if not callable(_qr_run):",
              "        raise TypeError('Script run entrypoint must be callable')",
              "    _qr_run_result = _qr_cast(_qr_Callable[[str], object], _qr_run)(_context)",
              "    _qr_public_python_value = _qr_object(_qr_run_result)",
              "    if (set(_qr_public_python_value) != {'success', 'stdout', 'stderr'}",
              "            or type(_qr_public_python_value['success']) is not bool",
              "            or not isinstance(_qr_public_python_value['stdout'], str)",
              "            or not isinstance(_qr_public_python_value['stderr'], str)):",
              "        raise TypeError('Public Python result must contain success, stdout and stderr')",
              "    _qr_public_python_value = {key: _qr_public_python_value[key] for key in ('success', 'stdout', 'stderr')}",
              `    _qr_public_python_result = {'schema':${JSON.stringify(PUBLIC_PYTHON_RESULT_SCHEMA)}, 'value':_qr_public_python_value}`,
              "    _qr_store(_qr_path, dict(_qr_binding, terminal=False, publicPythonResult=_qr_public_python_result))",
              "",
            ].join("\n")
          : [
              "    _qr_run = _qr_namespace['run']",
              "    if not callable(_qr_run):",
              "        raise TypeError('Script run entrypoint must be callable')",
              "    _qr_cast(_qr_Callable[[str], object], _qr_run)(_context)",
              "",
            ].join("\n");
    const body = `${identityPython}
import json as _qr_json, uuid as _qr_uuid, traceback as _qr_traceback
from typing import cast as _qr_cast, Callable as _qr_Callable
def _qr_object(_value: object) -> dict[str, object]:
    if not isinstance(_value, dict):
        raise TypeError('Receipt data must be an object')
    _untyped = _qr_cast(dict[object, object], _value)
    _result: dict[str, object] = {}
    for _key, _item in _untyped.items():
        if not isinstance(_key, str):
            raise TypeError('Receipt object keys must be strings')
        _result[_key] = _item
    return _result
_qr_binding_value = _qr_cast(object, _qr_json.loads(${JSON.stringify(JSON.stringify(binding))}))
_qr_binding = _qr_object(_qr_binding_value)
_qr_path = ${JSON.stringify(mapPath(receiptPath))}
${receiptPathGuard}_qr_outcome = 'failed'
_qr_error: dict[str, str] | None = None${receiptCaptureDeclaration}
def _qr_store(_path: str, _record: dict[str, object]) -> None:
    _temp = _path + '.' + str(_qr_uuid.uuid4()) + '.tmp'
    with open(_temp, 'x', encoding='utf-8') as _file:
        _qr_json.dump(_record, _file, allow_nan=False)
        _file.flush()
        _qi_os.fsync(_file.fileno())
    _qi_os.replace(_temp, _path)
    if _qi_os.name != 'nt':
        _fd = _qi_os.open(_qi_os.path.dirname(_path), _qi_os.O_RDONLY)
        try: _qi_os.fsync(_fd)
        finally: _qi_os.close(_fd)
_qr_native_registered: dict[str, object] = {}
def _qr_native_start(_kind: str, _identity: object) -> None:
    if _kind != 'atomic-batch' or not isinstance(_identity, dict) or _qr_native_registered:
        raise RuntimeError('Invalid or repeated native workflow declaration')
    _identity_value = _qr_object(_qr_cast(object, _identity))
    _qr_native_registered.update(kind=_kind, identity=_qr_cast(object, _qr_json.loads(_qr_json.dumps(_identity_value, allow_nan=False))))
    _record = dict(_qr_binding, terminal=False, stage='native-start', instance=_qi_identity(), native=dict(_qr_native_registered))
    _qr_store(_qr_path + '.native-start.json', _record)
def _qr_native_complete(_kind: str, _identity: object, _state: object) -> None:
    if (_qr_native_registered.get('kind') != _kind or _qr_native_registered.get('identity') != _identity
            or not isinstance(_state, dict)):
        raise RuntimeError('Native completion identity differs from its declaration')
    _state = _qr_object(_qr_cast(object, _state))
    _not_started = (_state.get('accepted') is False and _state.get('createdCount') == 0
                    and _state.get('executeCount') == 0)
    if _state.get('destroyed') is not True and not _not_started:
        raise RuntimeError('Native completion requires destroy or a proven unaccepted command')
    _summary: dict[str, object] = {k:_state.get(k) for k in ('destroyed','completed','outcome','accepted','createdCount','executeCount','terminationReason')}
    _summary['notStarted'] = _not_started
    _record = dict(_qr_binding, terminal=True, stage='native-completion', instance=_qi_identity(),
                   outcome='succeeded' if _state.get('completed') is True else 'failed',
                   native=dict(_qr_native_registered, state=_summary))
    _qr_store(_qr_path + '.native-end.json', _record)
try:
    _qr_expected_process_value = _qr_binding.get('auditExpectedProcess')
    if _qr_expected_process_value is not None:
        _qr_expected_process = _qr_object(_qr_expected_process_value)
        if set(_qr_expected_process) != {'pid', 'birth'}:
            raise RuntimeError('Exact audit process identity required')
        _qr_actual_process = _qi_identity()
        if any(_qr_actual_process.get(_qr_key) != _qr_expected_process.get(_qr_key) for _qr_key in ('pid','birth')):
            raise RuntimeError('Audit endpoint process changed; no audit body executed')
    _qr_expected_instance_value = _qr_binding.get('auditExpectedInstance')
    if _qr_expected_instance_value is not None:
        _qr_expected_instance = _qr_object(_qr_expected_instance_value)
        _qr_actual_instance = _qi_identity()
        if any(_qr_actual_instance.get(_qr_key) != _qr_expected_instance.get(_qr_key) for _qr_key in ('pid','birth','version')):
            raise RuntimeError('Audit endpoint instance changed; no audit body executed')
    _qr_expected_document_value = _qr_binding.get('auditExpectedDocument')
    _qr_expected_saved_value = _qr_binding.get('auditExpectedSavedDocument')
    _qr_first_save_value = _qr_binding.get('auditFirstSave')
    if _qr_first_save_value is not None and (_qr_first_save_value is not True
            or _qr_binding.get('purpose') != 'saved-fixture-first-save-v1'
            or _qr_expected_document_value is None or _qr_expected_saved_value is not None):
        raise RuntimeError('Separate first-save scope requires the exact unsaved origin')
    if _qr_expected_saved_value is not None:
        if _qr_expected_document_value is not None or _qr_binding.get('purpose') != 'saved-fixture-modeling-v1':
            raise RuntimeError('Separate owner-qualified saved fixture scope required')
        _qr_expected_saved = _qr_object(_qr_expected_saved_value)
        _qr_saved_version_value = _qr_expected_saved.get('version')
        if (set(_qr_expected_saved) != {'name','creationId','fileId','projectId','folderId','version'}
                or any(not isinstance(_qr_expected_saved.get(_qr_key), str) or not _qr_expected_saved.get(_qr_key)
                       for _qr_key in ('name','creationId','fileId','projectId','folderId'))
                or type(_qr_saved_version_value) is not int or _qr_saved_version_value <= 0):
            raise RuntimeError('Exact saved fixture identity and version required')
        _qr_saved_documents = _qi_core.Application.get().documents
        _qr_saved_matches: list[_qi_core.Document] = []
        for _qr_saved_index in range(_qr_saved_documents.count):
            _qr_saved_candidate = _qr_saved_documents.item(_qr_saved_index)
            if _qr_saved_candidate.creationId == _qr_expected_saved['creationId']:
                _qr_saved_matches.append(_qr_saved_candidate)
        if len(_qr_saved_matches) != 1:
            raise RuntimeError('Saved fixture creation identity changed; no model body executed')
        _qr_saved_document = _qr_saved_matches[0]
        _qr_saved_file = _qr_cast('_qi_core.DataFile | None', _qr_saved_document.dataFile)
        if (not _qr_saved_document.isValid or not _qr_saved_document.isSaved or _qr_saved_file is None
                or _qr_saved_document.name != _qr_expected_saved['name']
                or _qr_saved_document.allDocumentReferences.count != 0):
            raise RuntimeError('Saved fixture was renamed, unsaved or linked; no model body executed')
        _qr_saved_folder = _qr_cast('_qi_core.DataFolder | None', _qr_saved_file.parentFolder)
        _qr_saved_project = _qr_cast('_qi_core.DataProject | None', _qr_saved_folder.parentProject) if _qr_saved_folder is not None else None
        if (_qr_saved_folder is None or _qr_saved_project is None
                or _qr_saved_file.id != _qr_expected_saved['fileId']
                or _qr_saved_project.id != _qr_expected_saved['projectId']
                or _qr_saved_folder.id != _qr_expected_saved['folderId']
                or _qr_saved_file.versionNumber != _qr_expected_saved['version']
                or _qr_saved_file.isComplete is not True):
            raise RuntimeError('Saved fixture cloud lineage/version is incomplete or changed; no model body executed')
    _qr_selected_document: _qi_core.Document | None = None
    if _qr_expected_document_value is not None:
        _qr_expected_document = _qr_object(_qr_expected_document_value)
        if set(_qr_expected_document) != {'name', 'creationId', 'fileId'} or _qr_expected_document.get('fileId') is not None:
            raise RuntimeError('Exact isolated unsaved document identity required')
        _qr_documents = _qi_core.Application.get().documents
        _qr_document_matches: list[_qi_core.Document] = []
        for _qr_document_index in range(_qr_documents.count):
            _qr_candidate = _qr_documents.item(_qr_document_index)
            if _qr_candidate.creationId == _qr_expected_document.get('creationId'):
                _qr_document_matches.append(_qr_candidate)
        if len(_qr_document_matches) != 1:
            raise RuntimeError('Isolated document identity changed; no model body executed')
        _qr_selected_document = _qr_document_matches[0]
        # Same nullable dataFile contract as the qualified scratch _AaDoc proof.
        _qr_selected_file = _qr_cast('_qi_core.DataFile | None', _qr_selected_document.dataFile)
        if (not _qr_selected_document.isValid or _qr_selected_document.name != _qr_expected_document.get('name')
                or _qr_selected_document.isSaved or _qr_selected_file is not None
                or _qr_selected_document.allDocumentReferences.count != 0):
            raise RuntimeError('Isolated document was renamed, saved or linked; no model body executed')
    if _qr_first_save_value is True:
        _qr_first_save_app = _qi_core.Application.get()
        if (_qr_selected_document is None or _qr_selected_document.isModified is not False
                or _qr_first_save_app.activeDocument != _qr_selected_document
                or _qr_first_save_app.userInterface.activeCommand not in ('', 'SelectCommand')):
            raise RuntimeError('First save requires the unchanged fresh origin already active and idle')
    _qr_namespace: dict[str, object] = {'__name__':'__main__', '__file__':'<fmcad-queue>',
                     '__fmcad_native_lifecycle__':{'start':_qr_native_start,'complete':_qr_native_complete}}
    exec(compile(${JSON.stringify(code)}, '<fmcad-queue>', 'exec'), _qr_namespace, _qr_namespace)
${executeOfficialEntry}    _qr_outcome = 'succeeded'
except BaseException as _qr_exception:
    _qr_error = {'type':type(_qr_exception).__name__, 'message':str(_qr_exception),
                 'traceback':_qr_traceback.format_exc()[-16384:]}
    raise
finally:
    _qr_record = dict(_qr_binding)
    _qr_record.update({'terminal':True, 'outcome':_qr_outcome, 'instance':_qi_identity()})${receiptCaptureFinalWrite}
    if _qr_error is not None: _qr_record['error'] = _qr_error
    _qr_store(_qr_path, _qr_record)
`;
    const entry = official ? "run(_context: str)" : "_qr_execute()";
    return (
      "def " +
      entry +
      " -> None:\n" +
      body
        .split("\n")
        .map((line) => "    " + line)
        .join("\n") +
      "\n" +
      (official ? "" : "_qr_execute()\n")
    );
  }

  function prepareReceiptScript(
    code: string,
    official: boolean,
    receiptPath: string,
    binding: unknown,
    {
      mapPath = fusionPath,
      captureProbeObservation = false,
      capturePublicPythonResult = false,
    }: {
      mapPath?: (file: string) => string;
      captureProbeObservation?: boolean;
      capturePublicPythonResult?: boolean;
    } = {},
  ) {
    return (official ? prepareEncodedWireArtifact : prepareWireArtifact)(
      resolveRuntimePaths({ anchor: anchor }).runtime,
      receiptWrapper(
        code,
        official,
        receiptPath,
        binding,
        mapPath,
        captureProbeObservation,
        capturePublicPythonResult,
      ),
      {
        request: binding,
        context: { entrypoints: official ? ["<fmcad-queue>"] : [] },
      },
    );
  }

  function wrapScript(...args: Parameters<typeof prepareReceiptScript>) {
    return prepareReceiptScript(...args).script;
  }

  return {
    durable,
    readJson,
    processBirth,
    priorProcessAlive,
    reclaim,
    buildHash,
    brokerConfigHash,
    fusionPath,
    probe,
    prepareProbe,
    sameInstance,
    idle,
    workflowNonterminal,
    workflowOutputNonterminal,
    nativeWorkflowIdentity,
    wrapScript,
    prepareReceiptScript,
    hash,
    fail,
  };
}

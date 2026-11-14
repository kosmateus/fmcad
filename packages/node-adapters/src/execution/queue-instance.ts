import * as fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { prepareWireArtifact } from "../python/source-units";
import { verifyPythonArtifact } from "../python/artifact";
import { pythonArtifactManifest } from "../python/context-binding";
import { queueDocumentSnapshotSource } from "../python/document-probe";
import { durable, readJson } from "../persistence/records";
import type { PythonArtifactManifest } from "../../../core/src/domain/python-artifact";

export interface ProcessIdentity {
  pid: number;
  birth: string;
}
export interface FusionIdentity extends ProcessIdentity {
  version: string;
  activeCommand?: string;
  documents: unknown[];
}
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
  receiptPath?: string;
  binding?: unknown;
  requireIdle?: boolean;
  onObservation?: (identity: FusionIdentity) => unknown;
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

  function reclaim(dir: string) {
    const file = path.join(dir, "broker.lock");
    const marker = readJson(file) as ProcessIdentity;
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
    const claim = path.join(dir, "recovery.lock");
    durable(claim, { pid: process.pid, birth: processBirth() }, true);
    try {
      // A graceful close must not race with a new serve while recovery owns the directory.
      const current = readJson(file);
      if (JSON.stringify(current) !== JSON.stringify(marker))
        fail("LOCK_CHANGED", "Broker ownership changed during recovery");
      durable(path.join(dir, `reclaimed-${randomUUID()}.json`), marker, true);
      fs.unlinkSync(file);
      const fd = fs.openSync(dir, "r");
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
      fs.unlinkSync(claim);
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

  const probeScript = `${identityPython}
import json as _qi_json
def run(_context: str) -> None:
    _value = _qi_identity()
    _app = _qi_core.Application.get()
    _documents: list[dict[str, object]] = []
    _value['documents'] = _documents
    for _i in range(_app.documents.count):
        _doc = _app.documents.item(_i)
        _row: dict[str, object] = {'id':_doc.creationId, 'fileId':None,
            'isSaved':_doc.isSaved, 'isModified':_doc.isModified}
        _data, _error = _document_data_file(_doc)
        _row['fileId'] = _data.id if _data else None
        if _error:
            _row['dataFileError'] = _error
        _documents.append(_row)
    print('FMCAD_QUEUE_INSTANCE ' + _qi_json.dumps(_value))
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
      diagnosticPath,
      documentSelector,
      mapPath = fusionPath,
    }: ProbeOptions = {},
  ) {
    const previousTimeout = client.server.timeoutMs;
    client.server.timeoutMs = Math.min(previousTimeout, 15000);
    let output: ProbeOutput;
    try {
      // Canonical source already includes identity and queue-document helpers.
      // Compose once; receipt binding and final artifact preparation stay below.
      const documentCode = queueDocumentSnapshotSource(
        resolveRuntimePaths({ anchor: anchor }).runtime,
      );
      const wrapper =
        documentSelector !== undefined
          ? probeScript.replace(
              "    print('FMCAD_QUEUE_INSTANCE '",
              `    _value['documentState'] = _qd_capture(_app, _qi_cast(dict[str, object] | None, _qi_json.loads(${JSON.stringify(JSON.stringify(documentSelector))})))\n    print('FMCAD_QUEUE_INSTANCE '`,
            )
          : probeScript;
      const code = documentCode + "\n" + wrapper;
      const prepared = receiptPath
        ? prepareReceiptScript(code, true, receiptPath, binding, { mapPath })
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
        if (consumed)
          fail("PREPARED_RPC_CONSUMED", "An instance probe cannot be replayed");
        consumed = true;
        client.server.timeoutMs = Math.min(previousTimeout, 15000);
        try {
          output = await send();
        } catch (error) {
          if (diagnosticPath)
            durable(diagnosticPath, {
              stage: "instance_probe",
              at: new Date().toISOString(),
              code:
                (error as NodeJS.ErrnoException).code ||
                "PROBE_TRANSPORT_ERROR",
              message: (error as Error).message,
            });
          throw error;
        } finally {
          client.server.timeoutMs = previousTimeout;
        }
        return inspect(output);
      };
      return Object.assign(execute, { fence: () => send.fence?.() });
    } catch (error) {
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
      if (diagnosticPath)
        durable(diagnosticPath, {
          stage: "instance_probe",
          at: new Date().toISOString(),
          failed: output.failed,
          text: String(output.text || "").slice(-16384),
        });
      if (output.failed)
        fail("INSTANCE_UNAVAILABLE", "Read-only Fusion instance probe failed");
      const text = output.text || "";
      const line = text
        .split(/\r?\n/)
        .find((line) => line.startsWith("FMCAD_QUEUE_INSTANCE "));
      if (!line)
        fail(
          "INSTANCE_UNAVAILABLE",
          "Fusion instance probe returned no identity",
        );
      const result = JSON.parse(
        line!.slice("FMCAD_QUEUE_INSTANCE ".length),
      ) as FusionIdentity;
      if (
        !Number.isSafeInteger(result.pid) ||
        !result.birth ||
        !result.version ||
        !Array.isArray(result.documents)
      )
        fail("INSTANCE_UNAVAILABLE", "Incomplete Fusion identity");
      if (onObservation) await onObservation(result);
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
  ) {
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
_qr_outcome = 'failed'
_qr_error: dict[str, str] | None = None
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
${official ? "    _qr_run = _qr_namespace['run']\n    if not callable(_qr_run):\n        raise TypeError('Script run entrypoint must be callable')\n    _qr_cast(_qr_Callable[[str], object], _qr_run)(_context)\n" : ""}    _qr_outcome = 'succeeded'
except BaseException as _qr_exception:
    _qr_error = {'type':type(_qr_exception).__name__, 'message':str(_qr_exception),
                 'traceback':_qr_traceback.format_exc()[-16384:]}
    raise
finally:
    _qr_record = dict(_qr_binding)
    _qr_record.update({'terminal':True, 'outcome':_qr_outcome, 'instance':_qi_identity()})
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
    { mapPath = fusionPath }: { mapPath?: (file: string) => string } = {},
  ) {
    return prepareWireArtifact(
      resolveRuntimePaths({ anchor: anchor }).runtime,
      receiptWrapper(code, official, receiptPath, binding, mapPath),
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

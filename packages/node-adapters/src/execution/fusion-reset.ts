import * as fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { durable, readJson } from "../persistence/records";
import type { QueueSnapshot } from "@fmcad/core";
import type { ProcessIdentity } from "./queue-instance";

type Exec = typeof execFileSync;
interface WaitOptions {
  exec?: Exec | undefined;
  timeoutMs?: number;
}
interface ResetError extends Error {
  code?: string;
  stopError?: string | undefined;
  restoreError?: string;
  recoveredFusionPid?: number;
}
interface FusionProcess extends ProcessIdentity {
  path: string;
  responding: boolean;
  fusionCount: number;
}
interface BrokerOwner extends ProcessIdentity {
  nonce: string;
}
interface DocumentInventory {
  id: string;
  name: string;
  saved: boolean;
  modified: boolean;
  fileId?: string | null;
  bodies: number;
  sketches: number;
  occurrences: number;
  timeline: number;
  userParameters: number;
  isSaved?: boolean;
  isModified?: boolean;
}
interface InventoryResult {
  pid: number;
  version: string;
  documents: DocumentInventory[];
  closed?: string[];
}
interface InstanceRecord {
  buildHash: string;
  instance: ProcessIdentity & {
    version: string;
    documents: DocumentInventory[];
  };
}
interface Control {
  instanceId: string;
  generation: number;
  phase: string;
  unresolved: unknown;
  activeOperations: number;
  gateClosed: boolean;
  requestId?: string;
}
interface BrokerStatus {
  control?: Control;
  active?: unknown;
  blocked?: unknown;
  held?: unknown;
  lease?: unknown;
  stopping?: unknown;
  jobs?: Record<string, { state: string }>;
  buildHash: string;
}
interface ResetPause {
  requestId: string;
  instanceId: string;
  generation: number;
}
interface ResetMarker extends BrokerOwner {
  protocol: number;
  buildHash: string;
  fusion: ProcessIdentity & { path: string };
  resetPause: ResetPause | null | undefined;
  phase: string;
  at: string;
  recoveredFrom?: string;
}
interface ResetConfig {
  routing: string;
  backend: string;
  queue?: { autoStart?: boolean };
}
interface ResetJob {
  id: string;
  state: string;
}
interface ResetClient {
  dir: string;
  auth: unknown;
  register(options: { autoStart: boolean }): Promise<unknown>;
  submit(request: {
    requestId: string;
    kind: string;
    argv: string[];
    cwd: string;
    timeoutMs: number;
    backend: string;
    inputFiles: string[];
    buildHash: string;
    description: string;
  }): Promise<ResetJob>;
  wait(id: string): Promise<{ job: ResetJob; stdout?: string }>;
  call(action: "status"): Promise<BrokerStatus>;
  call(
    action: "pause" | "resume" | "control-status",
    values?: unknown,
  ): Promise<Control>;
  call(
    action: "console-stop",
    values?: unknown,
  ): Promise<{
    acknowledged?: unknown;
    requestId?: string;
    instanceId?: string;
    buildHash?: string;
  }>;
  call(action: string, values?: unknown): Promise<unknown>;
}
export interface ResetDependencies {
  loadConfig?: (options: object) => { cfg: ResetConfig };
  execFileSync?: Exec | undefined;
}
export interface FusionResetHost {
  QueueClient: new (name: string, options: { cfg: ResetConfig }) => ResetClient;
  QueueState: new (dir: string) => {
    data: QueueSnapshot;
    pause(value: boolean, requestId: string): unknown;
  };
  buildHash(): string;
  processBirth(pid?: number): string;
  ensureBroker(
    cfg: ResetConfig,
    auth: unknown,
    options: { fusionResetNonce: string },
  ): Promise<unknown>;
  reclaim(dir: string): unknown;
  createBrokerControl: typeof import("../../../core/src/application/broker-control").createBrokerControl;
  createBrokerControlPort: typeof import("../broker-ipc/control").createBrokerControlPort;
}

export function createFusionReset(host: FusionResetHost) {
  const { QueueClient, QueueState, buildHash, processBirth } = host;
  const descriptor = {
    usage: "fusion reset --force",
    desc: "Force-restart the verified Fusion process and restart the shared broker. Only known unsaved FMCAD test fixtures may be discarded.",
    example: "fmcad fusion reset --force",
    extra:
      "--force is required. Active, unknown, saved-and-modified or unrecognized unsaved documents block the reset. The broker is paused during restart, then resumed and tested with a read-only queued request.",
  };

  const manuals = {
    "fusion reset": {
      sections: [
        {
          title: "Return Contract",
          text: "Force-stops the exact Fusion PID/birth/executable selected by the broker, starts a replacement process, then restores the shared broker to RUNNING and completes one read-only queue smoke job. A resumed interrupted reset is reported as recoveredInterruptedReset.",
        },
        {
          title: "Data And Queue Safety",
          text: "--force is explicit permission to discard only recognized unsaved FMCAD test fixtures. Saved clean documents are preserved; unknown unsaved work or saved documents with modifications block reset. Active, queued, leased or unresolved broker work blocks reset. The reset marker refuses new queue submissions until a replacement Fusion identity is verified and the broker is ready.",
        },
        {
          title: "Limits",
          text: "Requires Linux/WSL with Windows PowerShell, queue routing and broker auto-start. Fusion startup, broker identity and queue readiness are checked separately; reset does not certify model geometry or physical manufacturing.",
        },
      ],
      examples: [
        {
          label: "Force-restart Fusion and its broker",
          argv: ["fusion", "reset", "--force"],
          requires:
            "Queue is idle and every open document is saved/clean or is a recognized test-owned fixture.",
          output:
            "Previous and current Fusion process identities plus broker RUNNING state and a succeeded read-only queue smoke job.",
        },
      ],
      audit: {
        sources: [
          "src/fusion-reset.js",
          "src/queue-broker.js:reset submission fence and idle stop",
          "src/queue-autostart.js:reset ownership fence",
          "src/queue-instance.js:PID/birth identity",
          "src/cli.js",
          "src/commands.js",
        ],
        tests: ["tests/fusion-reset.test.js", "tests/console-services.test.ts"],
        verified: [
          "Explicit --force parsing",
          "Idle/unknown queue and unsaved-document refusal",
          "Exact Windows PID/birth/path matching",
          "Reset marker fences submissions and stale recovery",
          "Replacement broker must complete a queue job before success",
        ],
        gaps: [],
        bugs: [],
      },
    },
  };

  function fail(code: string, message: string): never {
    throw Object.assign(new Error(message), { code });
  }
  const terminal = new Set(["succeeded", "failed", "cancelled", "expired"]);
  const delay = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));
  const fixturePatterns = [
    /^FMCAD_CAD_TEST_\d{4}-\d{2}-\d{2}T\d{2}_\d{2}_\d{2}_\d{3}Z$/,
    /^FMCAD_(?:DEFINITIONS|GEO|EXT|STYLE)_[0-9a-f]{8}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{12}$/i,
  ];

  function parse(argv: string[]) {
    if (argv.length !== 1 || argv[0] !== "--force") {
      fail(
        "USAGE",
        "Use fmcad fusion reset --force; no reset is attempted without explicit force confirmation.",
      );
    }
    return { force: true };
  }

  function validateQueue(
    status: BrokerStatus | null | undefined,
  ): asserts status is BrokerStatus & { control: Control } {
    const control = status?.control;
    if (
      !status ||
      !control ||
      status.active ||
      status.blocked ||
      status.held ||
      status.lease ||
      status.stopping ||
      control.unresolved ||
      control.activeOperations !== 0 ||
      control.phase !== "RUNNING" ||
      control.gateClosed !== false
    ) {
      fail(
        "QUEUE_BUSY",
        "Fusion reset requires a running, idle broker with no active or unresolved execution.",
      );
    }
    const pending = Object.values(status.jobs || {}).filter(
      (job) => !terminal.has(job.state),
    );
    if (pending.length)
      fail(
        "QUEUE_BUSY",
        "Fusion reset is refused while any job is queued, started or unresolved.",
      );
  }

  function isOwnedFixture(name: string | null | undefined) {
    return fixturePatterns.some((pattern) => pattern.test(name || ""));
  }

  function planDocuments(documents: DocumentInventory[]) {
    if (!Array.isArray(documents))
      fail(
        "DOCUMENT_INVENTORY_INVALID",
        "Fusion did not return a valid document inventory.",
      );
    const closeIds = [];
    const savedIds = [];
    for (const document of documents) {
      if (
        !document ||
        typeof document.id !== "string" ||
        typeof document.name !== "string" ||
        typeof document.saved !== "boolean" ||
        typeof document.modified !== "boolean"
      ) {
        fail(
          "DOCUMENT_INVENTORY_INVALID",
          "Fusion returned an incomplete document identity.",
        );
      }
      if (document.saved) {
        if (
          document.modified ||
          typeof document.fileId !== "string" ||
          !document.fileId
        ) {
          fail(
            "UNSAVED_WORK",
            `Saved document “${document.name}” has unverified or unsaved state; no reset was attempted.`,
          );
        }
        savedIds.push(document.id);
        continue;
      }
      if (isOwnedFixture(document.name)) {
        closeIds.push(document.id);
        continue;
      }
      const blankUntitled =
        document.name === "Bez nazwy" &&
        !document.modified &&
        document.bodies === 0 &&
        document.sketches === 0 &&
        document.occurrences === 0 &&
        document.timeline === 0 &&
        document.userParameters === 0;
      if (!blankUntitled) {
        fail(
          "UNSAVED_WORK",
          `Unrecognized unsaved document “${document.name}”; save or close it before resetting Fusion.`,
        );
      }
    }
    return { closeIds, savedIds };
  }

  function pythonInventoryCode(
    expected: DocumentInventory[],
    closeIds: string[] = [],
    expectedPid: number | null = null,
  ) {
    const encoded = JSON.stringify(
      JSON.stringify({ expected, closeIds, expectedPid }),
    );
    return `import adsk.core as _core, json as _json, os as _os
_expected = _json.loads(${encoded})
_app = _core.Application.get()
if _expected['expectedPid'] is not None and _os.getpid() != _expected['expectedPid']:
    raise RuntimeError('Fusion process identity changed after reset preflight; no fixture was closed.')
def _snapshot(_app=_app):
    _rows = []
    for _doc in _app.documents:
        _design = _doc.design
        _root = _design.rootComponent if _design else None
        _rows.append(dict(id=_doc.creationId, name=_doc.name, saved=bool(_doc.isSaved), modified=bool(_doc.isModified),
            fileId=_doc.dataFile.id if _doc.isSaved else None,
            bodies=_root.bRepBodies.count if _root else 0, sketches=_root.sketches.count if _root else 0,
            occurrences=_root.occurrences.count if _root else 0,
            timeline=_design.timeline.count if _design else 0,
            userParameters=_design.userParameters.count if _design else 0))
    return sorted(_rows, key=lambda _row: _row['id'])
_before = _snapshot()
if _expected['expected'] is not None and _before != _expected['expected']:
    raise RuntimeError('Fusion document inventory changed after reset preflight; no fixture was closed.')
_expected_by_id = { _row['id']: _row for _row in (_expected['expected'] or []) }
_closed = []
for _id in _expected['closeIds']:
    _doc = next((_candidate for _candidate in _app.documents if _candidate.creationId == _id), None)
    if _doc is None or _doc.isSaved or _id not in _expected_by_id or _expected_by_id[_id]['saved']:
        raise RuntimeError('A preflight fixture identity no longer matches; no further document was closed.')
    if _doc.close(False) is not True:
        raise RuntimeError('Fusion did not confirm closing an owned test fixture.')
    _closed.append(_id)
_after = _snapshot()
if any(_id in {_row['id'] for _row in _after} for _id in _closed):
    raise RuntimeError('Fusion did not close every selected test fixture.')
_saved_before = { _row['id']: _row['fileId'] for _row in _before if _row['saved'] }
_saved_after = { _row['id']: _row['fileId'] for _row in _after if _row['saved'] }
if _saved_before != _saved_after or any(_row['modified'] for _row in _after if _row['saved']):
    raise RuntimeError('A saved deliverable changed while closing test fixtures.')
print(_json.dumps(dict(pid=_os.getpid(), version=_app.version, closed=_closed, documents=_after)))
`;
  }

  function psQuote(value: unknown) {
    return "'" + String(value).replace(/'/g, "''") + "'";
  }

  function powershell(script: string, exec: Exec = execFileSync) {
    return exec(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", timeout: 10000, windowsHide: true },
    ).trim();
  }

  function readFusionProcess(pid: number, exec?: Exec) {
    if (!Number.isSafeInteger(pid) || pid <= 0)
      fail("INVALID_PROCESS_IDENTITY", "Fusion PID is invalid.");
    const output = powershell(
      `$ErrorActionPreference='Stop'
$all = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'Fusion360.exe'" -ErrorAction SilentlyContinue)
$p = $all | Where-Object { $_.ProcessId -eq ${pid} } | Select-Object -First 1
if ($null -eq $p) { 'absent' } else {
  $g = Get-Process -Id ${pid} -ErrorAction Stop
  [pscustomobject]@{pid=[int]$p.ProcessId; birth=$g.StartTime.ToFileTimeUtc().ToString(); path=$p.ExecutablePath; responding=[bool]$g.Responding; fusionCount=$all.Count} | ConvertTo-Json -Compress
}`,
      exec,
    );
    if (output === "absent") return null;
    let value: FusionProcess;
    try {
      value = JSON.parse(output) as FusionProcess;
    } catch {
      fail(
        "PROCESS_IDENTITY_INVALID",
        "PowerShell returned invalid Fusion process identity.",
      );
    }
    if (
      !value ||
      value.pid !== pid ||
      typeof value.birth !== "string" ||
      typeof value.path !== "string" ||
      typeof value.responding !== "boolean" ||
      !Number.isSafeInteger(value.fusionCount)
    ) {
      fail(
        "PROCESS_IDENTITY_INVALID",
        "PowerShell returned incomplete Fusion process identity.",
      );
    }
    return value;
  }

  function listFusionProcesses(exec?: Exec) {
    const output = powershell(
      `$ErrorActionPreference='Stop'
$all = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'Fusion360.exe'" -ErrorAction SilentlyContinue)
$rows = @($all | ForEach-Object {
  $g = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
  if ($g) { [pscustomobject]@{pid=[int]$_.ProcessId; birth=$g.StartTime.ToFileTimeUtc().ToString(); path=$_.ExecutablePath; responding=[bool]$g.Responding; fusionCount=$all.Count} }
})
ConvertTo-Json -InputObject $rows -Compress`,
      exec,
    );
    let value: FusionProcess;
    try {
      value = JSON.parse(output) as FusionProcess;
    } catch {
      fail(
        "PROCESS_IDENTITY_INVALID",
        "PowerShell returned an invalid Fusion process list.",
      );
    }
    const values: FusionProcess[] = Array.isArray(value)
      ? (value as FusionProcess[])
      : [value];
    if (
      values.some(
        (process) =>
          !process ||
          !Number.isSafeInteger(process.pid) ||
          typeof process.birth !== "string" ||
          typeof process.path !== "string" ||
          typeof process.responding !== "boolean",
      )
    ) {
      fail(
        "PROCESS_IDENTITY_INVALID",
        "PowerShell returned an incomplete Fusion process list.",
      );
    }
    return values;
  }

  function validateProcess(
    instance: ProcessIdentity | null | undefined,
    process: FusionProcess | null | undefined,
  ) {
    if (
      !instance ||
      !process ||
      instance.pid !== process.pid ||
      instance.birth !== process.birth ||
      process.fusionCount !== 1 ||
      !/^.+\\Autodesk\\webdeploy\\production\\[^\\]+\\Fusion360\.exe$/i.test(
        process.path,
      )
    ) {
      fail(
        "PROCESS_IDENTITY_MISMATCH",
        "The live Fusion PID, birth time or executable path does not exactly match the broker identity.",
      );
    }
    return process;
  }

  async function waitForProcess(
    pid: number,
    birth: string,
    { exec, timeoutMs = 15000 }: WaitOptions = {},
  ) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const current = readFusionProcess(pid, exec);
      if (!current || current.birth !== birth) return;
      await delay(250);
    }
    fail(
      "FUSION_STOP_TIMEOUT",
      "Fusion did not exit after the exact verified process was force-closed.",
    );
  }

  function stopFusion(process: FusionProcess, exec?: Exec) {
    const script = `$ErrorActionPreference='Stop'
$all = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'Fusion360.exe'" -ErrorAction SilentlyContinue)
if ($all.Count -ne 1 -or $all[0].ProcessId -ne ${process.pid}) { throw 'Fusion process set changed; refusing to stop anything.' }
$p = $all[0]
$g = Get-Process -Id ${process.pid} -ErrorAction Stop
if ($g.StartTime.ToFileTimeUtc().ToString() -ne ${psQuote(process.birth)} -or $p.ExecutablePath -ne ${psQuote(process.path)}) { throw 'Fusion PID/birth/path changed; refusing to stop anything.' }
Stop-Process -Id ${process.pid} -Force -ErrorAction Stop`;
    powershell(script, exec);
  }

  async function waitForNewFusion(
    oldProcess: FusionProcess,
    { exec, timeoutMs = 120000 }: WaitOptions = {},
  ) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const processes = listFusionProcesses(exec);
      if (processes.length > 1)
        fail(
          "FUSION_INSTANCE_AMBIGUOUS",
          "More than one Fusion process appeared during reset; no process was selected.",
        );
      const process = processes[0];
      if (
        process &&
        process.birth !== oldProcess.birth &&
        process.path === oldProcess.path &&
        process.responding
      )
        return process;
      await delay(500);
    }
    fail(
      "FUSION_START_TIMEOUT",
      "The replacement Fusion process did not become responsive before the startup deadline.",
    );
  }

  function startFusion(executable: string, exec?: Exec) {
    powershell(
      `$ErrorActionPreference='Stop'
$all = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'Fusion360.exe'" -ErrorAction SilentlyContinue)
if ($all.Count -ne 0) { throw 'A Fusion process already exists; refusing to launch another.' }
Start-Process -FilePath ${psQuote(executable)} -ErrorAction Stop | Out-Null`,
      exec,
    );
  }

  async function recoverFusion(oldProcess: FusionProcess, exec?: Exec) {
    const processes = listFusionProcesses(exec);
    if (processes.length > 1)
      fail(
        "FUSION_INSTANCE_AMBIGUOUS",
        "More than one Fusion process is present; reset recovery cannot select one.",
      );
    const current = processes[0];
    if (current?.birth === oldProcess.birth && current.path === oldProcess.path)
      return current;
    if (!current) startFusion(oldProcess.path, exec);
    return waitForNewFusion(oldProcess, { exec });
  }

  async function queuePython(
    client: ResetClient,
    cfg: ResetConfig,
    code: string,
    description: string,
  ) {
    const argv = [
      "call",
      "execute_python",
      JSON.stringify({ code, persistent: false }),
    ];
    const job = await client.submit({
      requestId: randomUUID(),
      kind: "command",
      argv,
      cwd: process.cwd(),
      timeoutMs: 120000,
      backend: cfg.backend,
      inputFiles: [],
      buildHash: buildHash(),
      description,
    });
    const result = await client.wait(job.id);
    if (result.job.state !== "succeeded" || typeof result.stdout !== "string") {
      fail(
        "RESET_SDK_CHECK_FAILED",
        `Read-only reset verification job ${job.id} did not succeed; inspect its receipt before retrying.`,
      );
    }
    let envelope: { success?: unknown; stdout?: string };
    try {
      envelope = JSON.parse(result.stdout);
    } catch {
      fail(
        "RESET_SDK_CHECK_FAILED",
        "Queued Fusion readback returned malformed output.",
      );
    }
    if (envelope.success !== true || typeof envelope.stdout !== "string")
      fail(
        "RESET_SDK_CHECK_FAILED",
        "Queued Fusion readback did not return a successful script result.",
      );
    try {
      return {
        value: JSON.parse(envelope.stdout) as InventoryResult,
        job: result.job,
      };
    } catch {
      fail(
        "RESET_SDK_CHECK_FAILED",
        "Queued Fusion script returned malformed JSON.",
      );
    }
  }

  async function queueReadinessJob(client: ResetClient, cfg: ResetConfig) {
    const job = await client.submit({
      requestId: randomUUID(),
      kind: "command",
      argv: ["tools"],
      cwd: process.cwd(),
      timeoutMs: 60000,
      backend: cfg.backend,
      inputFiles: [],
      buildHash: buildHash(),
      description:
        "Verify the shared broker accepts and completes a post-reset queue job",
    });
    const result = await client.wait(job.id);
    if (result.job.state !== "succeeded")
      fail(
        "QUEUE_SMOKE_FAILED",
        `Post-reset queue smoke job ${job.id} did not succeed.`,
      );
    return result.job;
  }

  async function waitForBrokerStop(
    client: ResetClient,
    owner: BrokerOwner,
    { timeoutMs = 30000 } = {},
  ) {
    const lockFile = path.join(client.dir, "broker.lock");
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (fs.existsSync(lockFile)) {
        const current = readJson(lockFile) as BrokerOwner;
        if (
          current.pid !== owner.pid ||
          current.birth !== owner.birth ||
          current.nonce !== owner.nonce
        ) {
          fail(
            "BROKER_OWNERSHIP_CHANGED",
            "Broker ownership changed during reset; Fusion was not stopped.",
          );
        }
      } else {
        try {
          if (processBirth(owner.pid) !== owner.birth) return;
        } catch (error) {
          if (
            ["ENOENT", "ESRCH"].includes(
              (error as NodeJS.ErrnoException).code as string,
            )
          )
            return;
          throw error;
        }
      }
      await delay(50);
    }
    fail(
      "BROKER_STOP_UNKNOWN",
      "The old broker did not prove release; Fusion was not stopped.",
    );
  }

  async function stopBroker(
    client: ResetClient,
    marker: ResetMarker,
    oldStatus: BrokerStatus,
  ) {
    const ownerFile = path.join(client.dir, "broker.lock");
    const owner = readJson(ownerFile) as BrokerOwner;
    if (
      !oldStatus.control ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      typeof owner.birth !== "string" ||
      owner.nonce !== oldStatus.control.instanceId ||
      oldStatus.buildHash !== marker.buildHash
    ) {
      fail(
        "BROKER_OWNERSHIP_CHANGED",
        "The live broker identity does not match its durable ownership marker.",
      );
    }
    const pauseControl = {
      requestId: randomUUID(),
      instanceId: oldStatus.control.instanceId,
      expectedGeneration: oldStatus.control.generation,
    };
    const paused = await client.call("pause", { control: pauseControl });
    if (
      paused.instanceId !== oldStatus.control.instanceId ||
      paused.phase !== "PAUSED" ||
      paused.unresolved ||
      paused.activeOperations !== 0 ||
      paused.gateClosed !== true ||
      paused.requestId !== pauseControl.requestId ||
      paused.generation !== pauseControl.expectedGeneration + 1
    ) {
      fail(
        "BROKER_PAUSE_UNCONFIRMED",
        "The broker did not confirm an idle paused state.",
      );
    }
    // Only a confirmed transition from RUNNING belongs to this reset. Preparing
    // a marker, a rejected CAS or finding an existing pause never grants resume.
    marker.resetPause = {
      requestId: pauseControl.requestId,
      instanceId: paused.instanceId,
      generation: paused.generation,
    };
    const markerFile = path.join(client.dir, "fusion-reset.lock");
    if ((readJson(markerFile) as ResetMarker).nonce !== marker.nonce)
      fail(
        "RESET_OWNERSHIP_CHANGED",
        "The reset marker changed before publishing its pause receipt.",
      );
    durable(markerFile, marker);
    const snapshot = await client.call("status");
    if (
      snapshot.control?.instanceId !== oldStatus.control.instanceId ||
      snapshot.control.phase !== "PAUSED" ||
      snapshot.control.generation !== paused.generation ||
      snapshot.blocked ||
      snapshot.held ||
      snapshot.lease ||
      snapshot.active ||
      snapshot.stopping
    ) {
      fail(
        "QUEUE_BUSY",
        "Queue state changed while preparing the broker handoff.",
      );
    }
    let stopError: ResetError | undefined;
    try {
      const control = {
        requestId: randomUUID(),
        instanceId: paused.instanceId,
        expectedGeneration: paused.generation,
      };
      const ack = await client.call("console-stop", { control });
      if (
        ack?.acknowledged !== true ||
        ack.requestId !== control.requestId ||
        ack.instanceId !== control.instanceId ||
        ack.buildHash !== oldStatus.buildHash
      )
        fail(
          "BROKER_STOP_UNCONFIRMED",
          "Broker did not confirm its fenced stop request.",
        );
    } catch (error) {
      stopError = error as ResetError;
    }
    try {
      await waitForBrokerStop(client, owner);
    } catch (error) {
      if (stopError)
        (error as ResetError).stopError = stopError.code || stopError.message;
      throw error;
    }
  }

  async function startBroker(
    client: ResetClient,
    cfg: ResetConfig,
    marker: ResetMarker,
    oldStatus: BrokerStatus | null,
  ) {
    await host.ensureBroker({ ...cfg, routing: "queue" }, client.auth, {
      fusionResetNonce: marker.nonce,
    });
    await client.register({ autoStart: false });
    const status = await client.call("status");
    if (
      !status.control ||
      (oldStatus?.control &&
        status.control.instanceId === oldStatus.control.instanceId) ||
      status.control.phase !== "RUNNING" ||
      status.control.gateClosed !== false ||
      status.control.activeOperations !== 0 ||
      status.control.unresolved ||
      status.blocked ||
      status.held
    ) {
      fail(
        "BROKER_RESTART_INVALID",
        "The replacement broker is not a distinct, idle, RUNNING instance.",
      );
    }
    return status;
  }

  async function resumeBroker(
    client: ResetClient,
    status: BrokerStatus,
    resetNonce?: string,
  ) {
    const control = status.control!;
    const requestId = randomUUID();
    const request = {
      requestId,
      instanceId: control.instanceId,
      expectedGeneration: control.generation,
    };
    let result;
    try {
      result = await client.call("resume", {
        control: request,
        ...(resetNonce ? { resetOwnerNonce: resetNonce } : {}),
      });
    } catch (error) {
      const observed = await client.call("control-status");
      if (
        observed.instanceId !== control.instanceId ||
        observed.unresolved ||
        observed.phase !== "RUNNING"
      )
        throw error;
      result = observed;
    }
    if (
      result.instanceId !== control.instanceId ||
      result.unresolved ||
      result.phase !== "RUNNING" ||
      result.gateClosed !== false ||
      result.activeOperations !== 0
    ) {
      fail(
        "BROKER_NOT_READY",
        "The replacement broker did not resume into a clean RUNNING state.",
      );
    }
    return result;
  }

  async function restoreBroker(
    client: ResetClient,
    cfg: ResetConfig,
    marker: ResetMarker,
  ) {
    if (!marker.resetPause || typeof marker.resetPause !== "object") {
      // A failed pause CAS did not change the broker. Observe only; in particular,
      // do not start a replacement or resume the winning client's pause.
      return client.call("status");
    }
    if (
      (readJson(path.join(client.dir, "fusion-reset.lock")) as ResetMarker)
        .nonce !== marker.nonce
    ) {
      fail(
        "RESET_OWNERSHIP_CHANGED",
        "Restoration cannot change the broker after reset ownership changed.",
      );
    }
    const until = Date.now() + 60000;
    while (Date.now() < until) {
      let status;
      try {
        status = await client.call("status");
      } catch {
        await host.ensureBroker({ ...cfg, routing: "queue" }, client.auth, {
          fusionResetNonce: marker.nonce,
        });
        await client.register({ autoStart: false });
        continue;
      }
      if (status.blocked || status.held || status.control?.unresolved) {
        fail(
          "RECONCILIATION_REQUIRED",
          "Queue restoration found unresolved work; the reset marker remains in place.",
        );
      }
      if (!status.stopping && status.control?.phase === "RUNNING")
        return status;
      if (
        !status.stopping &&
        status.control?.phase === "PAUSED" &&
        status.control.activeOperations === 0
      ) {
        if (!ownsResetPause(marker, status.control)) {
          fail(
            "RESET_PAUSE_UNOWNED",
            "Restoration cannot resume a pause not confirmed as owned by this reset.",
          );
        }
        await resumeBroker(client, status, marker.nonce);
        continue;
      }
      if (
        status.stopping ||
        status.control?.phase === "PAUSING" ||
        (status.control?.activeOperations ?? 0) > 0 ||
        status.active
      ) {
        await delay(100);
        continue;
      }
      fail(
        "BROKER_NOT_READY",
        "Queue restoration reached an unexpected broker phase.",
      );
    }
    fail(
      "BROKER_NOT_READY",
      "Queue did not return to a clean RUNNING state after the aborted reset.",
    );
  }

  function ownsResetPause(marker: ResetMarker, control: Control) {
    const pause = marker.resetPause;
    return !!(
      pause &&
      typeof pause === "object" &&
      typeof pause.requestId === "string" &&
      pause.instanceId === control.instanceId &&
      pause.generation === control.generation
    );
  }

  function ownsPersistedResetPause(marker: ResetMarker, state: QueueSnapshot) {
    const pause = marker.resetPause;
    const receipt =
      pause && typeof pause === "object"
        ? state.controlRequests?.[pause.requestId]
        : undefined;
    return !!(
      receipt?.paused === true &&
      receipt.generation === pause!.generation &&
      state.controlGeneration === pause!.generation
    );
  }

  function removeResetMarker(file: string, nonce: string) {
    const current = readJson(file) as ResetMarker;
    if (current.nonce !== nonce)
      fail(
        "RESET_OWNERSHIP_CHANGED",
        "The Fusion reset ownership marker changed; it was not removed.",
      );
    fs.unlinkSync(file);
  }

  function validateResetRecovery(
    marker: ResetMarker,
    state: QueueSnapshot,
    oldInstance: ProcessIdentity,
    ownerAlive: boolean,
    brokerPresent: boolean,
    process: FusionProcess | null | undefined,
  ) {
    if (ownerAlive)
      fail(
        "FUSION_RESET_IN_PROGRESS",
        "The previous reset process is still alive; no recovery was attempted.",
      );
    if (brokerPresent)
      fail(
        "RESET_RECOVERY_BUSY",
        "A broker still owns the queue; inspect its status before reset recovery.",
      );
    if (
      !marker ||
      marker.protocol !== 1 ||
      !marker.fusion ||
      !Number.isSafeInteger(marker.fusion.pid) ||
      typeof marker.fusion.birth !== "string" ||
      typeof marker.fusion.path !== "string" ||
      !oldInstance ||
      oldInstance.pid !== marker.fusion.pid ||
      oldInstance.birth !== marker.fusion.birth
    ) {
      fail(
        "RESET_RECOVERY_INVALID",
        "Interrupted reset identity does not match the last broker Fusion identity.",
      );
    }
    const recoveringPause = ["unpausing", "queue-unpaused"].includes(
      marker.phase,
    );
    if (
      !state ||
      !(state.paused === true || (recoveringPause && state.paused === false)) ||
      state.active !== null ||
      state.blocked ||
      state.controlBlocked ||
      state.localUnknown ||
      state.lease ||
      Object.values(state.jobs || {}).some((job) => !terminal.has(job.state))
    ) {
      fail(
        "RESET_RECOVERY_BUSY",
        "Interrupted reset recovery requires a paused, quiescent queue with no unresolved or queued jobs.",
      );
    }
    if (state.paused && !ownsPersistedResetPause(marker, state)) {
      fail(
        "RESET_PAUSE_UNOWNED",
        "The queue pause has no generation-bound receipt belonging to the interrupted reset.",
      );
    }
    if (
      !process ||
      process.birth === marker.fusion.birth ||
      !process.responding ||
      process.fusionCount !== 1
    ) {
      fail(
        "FUSION_UNAVAILABLE",
        "A single responsive replacement Fusion process is required for reset recovery.",
      );
    }
    validateProcess({ pid: process.pid, birth: process.birth }, process);
    return process;
  }

  function reclaimDeadResetBroker(dir: string, state: QueueSnapshot) {
    const file = path.join(dir, "broker.lock");
    if (!fs.existsSync(file)) return;
    if (
      !state ||
      state.active !== null ||
      state.blocked ||
      state.controlBlocked ||
      state.localUnknown ||
      state.lease ||
      Object.values(state.jobs || {}).some((job) => !terminal.has(job.state))
    ) {
      fail(
        "RESET_RECOVERY_BUSY",
        "A stale broker cannot be reclaimed while queue work is active, queued or unresolved.",
      );
    }
    const owner = readJson(file) as BrokerOwner;
    if (
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      typeof owner.birth !== "string" ||
      typeof owner.nonce !== "string"
    ) {
      fail(
        "BROKER_RECLAIM_UNPROVEN",
        "The stale broker marker has an invalid process identity.",
      );
    }
    let alive;
    try {
      alive = processBirth(owner.pid) === owner.birth;
    } catch (error) {
      if (
        ["ENOENT", "ESRCH"].includes(
          (error as NodeJS.ErrnoException).code as string,
        )
      )
        alive = false;
      else throw error;
    }
    if (alive)
      fail(
        "BROKER_ALIVE",
        "The broker process is still alive; reset recovery will not reclaim its marker.",
      );
    const lifecycle = readJson(
      path.join(dir, `broker-lifecycle-${owner.nonce}.json`),
    ) as { owner?: BrokerOwner; stage: string };
    if (
      lifecycle.owner?.pid !== owner.pid ||
      lifecycle.owner?.birth !== owner.birth ||
      lifecycle.owner?.nonce !== owner.nonce ||
      !["starting", "ready", "recovery", "rejected"].includes(lifecycle.stage)
    ) {
      fail(
        "BROKER_RECLAIM_UNPROVEN",
        "The stale broker marker has no matching lifecycle record.",
      );
    }
    host.reclaim(dir);
    if (fs.existsSync(file))
      fail(
        "BROKER_RECLAIM_UNPROVEN",
        "The stale broker ownership marker remains after reclamation.",
      );
  }

  function releaseResetPause(
    dir: string,
    markerFile: string,
    marker: ResetMarker,
  ) {
    if ((readJson(markerFile) as ResetMarker).nonce !== marker.nonce)
      fail(
        "RESET_OWNERSHIP_CHANGED",
        "The reset marker changed before releasing its pause.",
      );
    const state = new QueueState(dir);
    if (
      state.data.active !== null ||
      state.data.blocked ||
      state.data.controlBlocked ||
      state.data.localUnknown ||
      state.data.lease ||
      Object.values(state.data.jobs).some((job) => !terminal.has(job.state))
    ) {
      fail(
        "RESET_RECOVERY_BUSY",
        "Reset cannot reopen the queue while any job is queued or unresolved.",
      );
    }
    if (state.data.paused) {
      if (!ownsPersistedResetPause(marker, state.data)) {
        fail(
          "RESET_PAUSE_UNOWNED",
          "The queue pause cannot be attributed to this Fusion reset.",
        );
      }
      marker.phase = "unpausing";
      durable(markerFile, marker);
      state.pause(false, `fusion-reset-resume:${marker.nonce}`);
    } else if (!["unpausing", "queue-unpaused"].includes(marker.phase)) {
      fail(
        "RESET_PAUSE_UNOWNED",
        "The queue was already open; no reset-owned pause could be confirmed.",
      );
    }
    marker.phase = "queue-unpaused";
    durable(markerFile, marker);
  }

  async function recoverInterruptedReset(
    cfg: ResetConfig,
    client: ResetClient,
    deps: ResetDependencies,
    markerFile: string,
    staleMarker: ResetMarker,
  ) {
    const dir = client.dir;
    let ownerAlive;
    try {
      ownerAlive = processBirth(staleMarker.pid) === staleMarker.birth;
    } catch (error) {
      if (
        ["ENOENT", "ESRCH"].includes(
          (error as NodeJS.ErrnoException).code as string,
        )
      )
        ownerAlive = false;
      else throw error;
    }
    if (ownerAlive)
      fail(
        "FUSION_RESET_IN_PROGRESS",
        "The previous reset owner is still alive; no recovery was attempted.",
      );
    const brokerFile = path.join(dir, "broker.lock");
    const oldIdentity = (
      readJson(path.join(dir, "instance.json")) as InstanceRecord
    ).instance;
    const oldProcess = readFusionProcess(
      staleMarker.fusion?.pid,
      deps.execFileSync,
    );
    const oldFusionAlive = !!(
      oldProcess && oldProcess.birth === staleMarker.fusion?.birth
    );
    const state = readJson(
      path.join(dir, "queue-state.json"),
      128 * 1024 * 1024,
    ) as QueueSnapshot;
    if (oldFusionAlive)
      fail(
        "RESET_RECOVERY_BUSY",
        "The original Fusion process is still alive; recovery will not adopt another instance.",
      );
    const processes = listFusionProcesses(deps.execFileSync);
    if (processes.length !== 1)
      fail(
        "FUSION_INSTANCE_AMBIGUOUS",
        "Reset recovery requires exactly one Fusion360 process.",
      );
    const replacement = processes[0];
    reclaimDeadResetBroker(dir, state);
    const latestState = readJson(
      path.join(dir, "queue-state.json"),
      128 * 1024 * 1024,
    ) as QueueSnapshot;
    const verifiedReplacement = validateResetRecovery(
      staleMarker,
      latestState,
      oldIdentity,
      ownerAlive,
      fs.existsSync(brokerFile),
      replacement,
    );

    const claimFile = path.join(dir, "fusion-reset-recovery.lock");
    const claim = {
      pid: process.pid,
      birth: processBirth(),
      nonce: randomUUID(),
      previousNonce: staleMarker.nonce,
    };
    durable(claimFile, claim, true);
    const marker: ResetMarker = {
      protocol: 1,
      pid: claim.pid,
      birth: claim.birth,
      nonce: claim.nonce,
      buildHash: buildHash(),
      fusion: staleMarker.fusion,
      recoveredFrom: staleMarker.nonce,
      resetPause: staleMarker.resetPause,
      phase: staleMarker.phase || "prepared",
      at: staleMarker.at,
    };
    try {
      const current = readJson(markerFile) as ResetMarker;
      if (current.nonce !== staleMarker.nonce || fs.existsSync(brokerFile)) {
        fail(
          "RESET_OWNERSHIP_CHANGED",
          "Reset ownership changed before recovery could claim it.",
        );
      }
      try {
        if (processBirth(current.pid) === current.birth)
          fail(
            "FUSION_RESET_IN_PROGRESS",
            "The previous reset process is still alive.",
          );
      } catch (error) {
        if (
          !["ENOENT", "ESRCH"].includes(
            (error as NodeJS.ErrnoException).code as string,
          )
        )
          throw error;
      }
      const latestState = readJson(
        path.join(dir, "queue-state.json"),
        128 * 1024 * 1024,
      ) as QueueSnapshot;
      const latestProcesses = listFusionProcesses(deps.execFileSync);
      validateResetRecovery(
        current,
        latestState,
        (readJson(path.join(dir, "instance.json")) as InstanceRecord).instance,
        false,
        fs.existsSync(brokerFile),
        latestProcesses.length === 1 ? latestProcesses[0] : null,
      );
      durable(markerFile, marker);
    } finally {
      const currentClaim = readJson(claimFile) as BrokerOwner;
      if (currentClaim.nonce === claim.nonce) fs.unlinkSync(claimFile);
    }

    try {
      releaseResetPause(dir, markerFile, marker);
      const status = await startBroker(client, cfg, marker, null);
      const identity = (
        readJson(path.join(dir, "instance.json")) as InstanceRecord
      ).instance;
      if (
        identity?.pid !== verifiedReplacement.pid ||
        identity.birth !== verifiedReplacement.birth ||
        identity.version !== oldIdentity.version
      ) {
        fail(
          "PROCESS_IDENTITY_MISMATCH",
          "Replacement broker did not observe the responsive Fusion process.",
        );
      }
      const running = status.control!;
      removeResetMarker(markerFile, marker.nonce);
      const smokeJob = await queueReadinessJob(client, cfg);
      const after = await client.call("status");
      if (
        after.control?.instanceId !== running.instanceId ||
        after.control.phase !== "RUNNING" ||
        after.control.unresolved ||
        after.blocked ||
        after.held
      ) {
        fail(
          "BROKER_NOT_READY",
          "Recovered broker did not accept and complete a queue job.",
        );
      }
      return {
        reset: true,
        forced: true,
        recoveredInterruptedReset: true,
        fusion: {
          previous: {
            pid: staleMarker.fusion.pid,
            birth: staleMarker.fusion.birth,
          },
          current: {
            pid: verifiedReplacement.pid,
            birth: verifiedReplacement.birth,
            version: identity.version,
          },
        },
        preservedSavedDocuments: oldIdentity.documents
          .filter((document) => document.isSaved && !document.isModified)
          .map((document) => ({ id: document.id, fileId: document.fileId })),
        broker: {
          instanceId: after.control.instanceId,
          phase: after.control.phase,
          smokeJobId: smokeJob.id,
        },
      };
    } finally {
      try {
        const current = readJson(markerFile) as ResetMarker;
        if (current.nonce === marker.nonce) {
          const running = await client.call("status");
          if (
            running.control?.phase === "RUNNING" &&
            !running.control.unresolved &&
            !running.blocked &&
            !running.held
          ) {
            fs.unlinkSync(markerFile);
          }
        }
      } catch {
        /* Keep the marker if readiness or ownership is uncertain. */
      }
    }
  }

  async function fusionReset(argv: string[], deps: ResetDependencies = {}) {
    parse(argv);
    const { cfg } = deps.loadConfig!({});
    if (cfg.routing !== "queue" || cfg.queue?.autoStart === false) {
      fail(
        "QUEUE_REQUIRED",
        "Fusion reset requires queue routing with broker auto-start enabled so the replacement broker can be verified.",
      );
    }
    const client = new QueueClient(
      `fusion-reset:${process.pid}:${randomUUID()}`,
      { cfg },
    );
    const markerFile = path.join(client.dir, "fusion-reset.lock");
    if (fs.existsSync(markerFile)) {
      const staleMarker = readJson(markerFile) as ResetMarker;
      let ownerAlive;
      try {
        ownerAlive = processBirth(staleMarker.pid) === staleMarker.birth;
      } catch (error) {
        if (
          ["ENOENT", "ESRCH"].includes(
            (error as NodeJS.ErrnoException).code as string,
          )
        )
          ownerAlive = false;
        else throw error;
      }
      if (ownerAlive)
        fail(
          "FUSION_RESET_IN_PROGRESS",
          "Another reset process still owns the broker directory.",
        );
      return recoverInterruptedReset(
        cfg,
        client,
        deps,
        markerFile,
        staleMarker,
      );
    }
    await client.register({ autoStart: false });
    const status = await client.call("status");
    validateQueue(status);
    const { createBrokerControl, createBrokerControlPort } = host;
    const port = createBrokerControlPort(client, {
      async reset(fence) {
        const current = await client.call("status");
        if (current.control?.instanceId !== fence.instanceId)
          fail(
            "INSTANCE_CHANGED",
            "Broker changed before the explicit Fusion reset.",
          );
        if (current.control.generation !== fence.expectedGeneration)
          fail(
            "STATE_CONFLICT",
            "Control generation changed before the explicit Fusion reset.",
          );
        validateQueue(current);
        return performReset(cfg, client, deps, current);
      },
    });
    return createBrokerControl(port).execute("reset", {
      requestId: randomUUID(),
      instanceId: status.control.instanceId,
      expectedGeneration: status.control.generation,
    });
  }

  async function performReset(
    cfg: ResetConfig,
    client: ResetClient,
    deps: ResetDependencies,
    status: BrokerStatus,
  ) {
    const markerFile = path.join(client.dir, "fusion-reset.lock");

    const initial = await queuePython(
      client,
      cfg,
      `import adsk.core as _core, json as _json, os as _os
_app = _core.Application.get()
_rows = []
for _doc in _app.documents:
    _design = _doc.design
    _root = _design.rootComponent if _design else None
    _rows.append(dict(id=_doc.creationId, name=_doc.name, saved=bool(_doc.isSaved), modified=bool(_doc.isModified),
        fileId=_doc.dataFile.id if _doc.isSaved else None,
        bodies=_root.bRepBodies.count if _root else 0, sketches=_root.sketches.count if _root else 0,
        occurrences=_root.occurrences.count if _root else 0,
        timeline=_design.timeline.count if _design else 0,
        userParameters=_design.userParameters.count if _design else 0))
print(_json.dumps(dict(pid=_os.getpid(), version=_app.version, documents=sorted(_rows, key=lambda _row: _row['id']))))`,
      "Read-only Fusion document inventory before reset",
    );
    let inventory = initial.value;
    if (
      !inventory ||
      !Number.isSafeInteger(inventory.pid) ||
      typeof inventory.version !== "string"
    )
      fail(
        "DOCUMENT_INVENTORY_INVALID",
        "Fusion process identity is incomplete.",
      );
    let plan = planDocuments(inventory.documents);
    const closedFixtureIds = [];

    if (plan.closeIds.length) {
      const closed = await queuePython(
        client,
        cfg,
        pythonInventoryCode(inventory.documents, plan.closeIds, inventory.pid),
        "Close only verified unsaved FMCAD test fixtures",
      );
      if (
        closed.value.pid !== inventory.pid ||
        !Array.isArray(closed.value.closed) ||
        closed.value.closed.length !== plan.closeIds.length ||
        closed.value.closed.some((id) => !plan.closeIds.includes(id))
      ) {
        fail(
          "FIXTURE_CLEANUP_UNCONFIRMED",
          "Fusion did not confirm closing exactly the approved test fixtures. No process was stopped.",
        );
      }
      closedFixtureIds.push(...closed.value.closed);
      inventory = {
        pid: closed.value.pid,
        version: closed.value.version,
        documents: closed.value.documents,
      };
      plan = planDocuments(inventory.documents);
      if (plan.closeIds.length)
        fail(
          "FIXTURE_CLEANUP_UNCONFIRMED",
          "A test fixture remained open after its close confirmation.",
        );
    }

    status = await client.call("status");
    validateQueue(status);
    const identityRecord = readJson(
      path.join(client.dir, "instance.json"),
    ) as InstanceRecord;
    if (
      identityRecord.buildHash !== status.buildHash ||
      identityRecord.instance?.pid !== inventory.pid ||
      identityRecord.instance?.version !== inventory.version
    ) {
      fail(
        "PROCESS_IDENTITY_MISMATCH",
        "The live Fusion identity does not match the broker’s current observed instance.",
      );
    }
    const oldProcess = validateProcess(
      identityRecord.instance,
      readFusionProcess(inventory.pid, deps.execFileSync),
    );
    const oldStatus = status;
    const marker: ResetMarker = {
      protocol: 1,
      pid: process.pid,
      birth: processBirth(),
      nonce: randomUUID(),
      buildHash: status.buildHash,
      fusion: {
        pid: oldProcess.pid,
        birth: oldProcess.birth,
        path: oldProcess.path,
      },
      resetPause: null,
      phase: "prepared",
      at: new Date().toISOString(),
    };
    durable(markerFile, marker, true);
    let fusionStopAttempted = false;
    const savedDeliverables = inventory.documents
      .filter((document) => document.saved)
      .map((document) => ({ id: document.id, fileId: document.fileId }));
    try {
      await stopBroker(client, marker, oldStatus);

      const now = readFusionProcess(oldProcess.pid, deps.execFileSync);
      validateProcess(identityRecord.instance, now);
      fusionStopAttempted = true;
      stopFusion(oldProcess, deps.execFileSync);
      await waitForProcess(oldProcess.pid, oldProcess.birth, {
        exec: deps.execFileSync,
      });

      startFusion(oldProcess.path, deps.execFileSync);
      const newProcess = await waitForNewFusion(oldProcess, {
        exec: deps.execFileSync,
      });

      releaseResetPause(client.dir, markerFile, marker);
      const replacement = await startBroker(client, cfg, marker, oldStatus);
      const newIdentity = (
        readJson(path.join(client.dir, "instance.json")) as InstanceRecord
      ).instance;
      if (
        !newIdentity ||
        newIdentity.pid !== newProcess.pid ||
        newIdentity.birth !== newProcess.birth ||
        newIdentity.version !== inventory.version
      ) {
        fail(
          "PROCESS_IDENTITY_MISMATCH",
          "The replacement broker did not observe the exact new Fusion PID/birth/version.",
        );
      }
      const running = replacement.control!;
      removeResetMarker(markerFile, marker.nonce);

      const smokeJob = await queueReadinessJob(client, cfg);
      const after = await client.call("status");
      if (
        after.control?.instanceId !== running.instanceId ||
        after.control.phase !== "RUNNING" ||
        after.control.unresolved ||
        after.blocked ||
        after.held
      ) {
        fail(
          "BROKER_NOT_READY",
          "Post-reset broker status is not clean and RUNNING.",
        );
      }
      return {
        reset: true,
        forced: true,
        fusion: {
          previous: { pid: oldProcess.pid, birth: oldProcess.birth },
          current: {
            pid: newProcess.pid,
            birth: newProcess.birth,
            version: newIdentity.version,
          },
        },
        closedTestFixtures: closedFixtureIds,
        preservedSavedDocuments: savedDeliverables,
        broker: {
          instanceId: after.control.instanceId,
          phase: after.control.phase,
          smokeJobId: smokeJob.id,
        },
      };
    } catch (error) {
      // If Fusion was not stopped, restore the queue against the original instance.
      if (!fusionStopAttempted) {
        try {
          await restoreBroker(client, cfg, marker);
          if (fs.existsSync(markerFile))
            removeResetMarker(markerFile, marker.nonce);
        } catch (restoreError) {
          (error as ResetError).restoreError = (restoreError as Error).message;
        }
      } else if (fusionStopAttempted) {
        // Restore the broker against whichever exact Fusion process survived or started.
        try {
          const recoveredProcess = await recoverFusion(
            oldProcess,
            deps.execFileSync,
          );
          if (recoveredProcess.birth !== oldProcess.birth)
            releaseResetPause(client.dir, markerFile, marker);
          await restoreBroker(client, cfg, marker);
          const restoredIdentity = (
            readJson(path.join(client.dir, "instance.json")) as InstanceRecord
          ).instance;
          if (
            restoredIdentity?.pid !== recoveredProcess.pid ||
            restoredIdentity.birth !== recoveredProcess.birth
          ) {
            fail(
              "PROCESS_IDENTITY_MISMATCH",
              "Queue restoration did not bind to the surviving/replacement Fusion process.",
            );
          }
          if (fs.existsSync(markerFile))
            removeResetMarker(markerFile, marker.nonce);
          (error as ResetError).recoveredFusionPid = recoveredProcess.pid;
        } catch (restoreError) {
          (error as ResetError).restoreError = (restoreError as Error).message;
        }
      }
      throw error;
    }
  }

  return {
    descriptor,
    parse,
    validateQueue,
    isOwnedFixture,
    planDocuments,
    pythonInventoryCode,
    readFusionProcess,
    validateProcess,
    validateResetRecovery,
    releaseResetPause,
    ownsResetPause,
    ownsPersistedResetPause,
    stopBroker,
    restoreBroker,
    fusionReset,
    manuals,
  };
}

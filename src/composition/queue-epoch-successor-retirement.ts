import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { isDeepStrictEqual as same } from "node:util";
import { verifySdkProcessDeathProof } from "./queue-epoch-successor";
import type {
  Client,
  Owner,
  Process,
  Reference,
  Sdk1MetadataWorkerProcess,
  Sdk1MetadataWorkerProcessResult,
  Sdk1MetadataWorkerRetirementComplete,
  Sdk1MetadataWorkerRetirementPending,
  Sdk1MetadataWorkerRetirementPorts,
  Sdk1MetadataWorkerRetirementPreview,
  Sdk1MetadataWorkerRetirementResult,
  Sdk1SdkProcessObservation,
} from "./queue-epoch-successor-types";

type Data = Record<string, unknown>;
const exactSdkProcessAbsentErrorId =
  "NoProcessFoundForGivenId,Microsoft.PowerShell.Commands.GetProcessCommand";
const sdk1SourceCommit = "9bec03576d0464f403c2ab4101a94df92706f3f2";
const sdk1BuildHash =
  "93045c4085916e9f76d540b307d78c0cb6b2baa4d27e8b481bb919e0fb14bb33";
const metadataWorkerRetirementPidfdProgram = `import os,sys,json,hashlib,signal,select,time
def require(condition,message='metadata retirement proof refused'):
 if not condition: raise RuntimeError(message)
p=json.load(sys.stdin); owner=p['owner']; pid=owner['pid']; base='/proc/'+str(pid)
require(isinstance(pid,int) and pid>1 and pid!=os.getpid())
require(hasattr(os,'pidfd_open') and hasattr(signal,'pidfd_send_signal'))
fd=os.pidfd_open(pid)
def digest(file):
 with open(file,'rb') as f: return hashlib.sha256(f.read()).hexdigest()
def verify(stopped=False):
 stat=open(base+'/stat').read(); tail=stat[stat.rfind(')')+2:].split()
 birth=open('/proc/sys/kernel/random/boot_id').read().strip()+':'+tail[19]
 require(birth==owner['birth'] and tail[0]!='Z')
 if p.get('freeze',False) and not stopped: require(tail[0] not in ['T','t'],'previous freeze outcome must be inspected')
 if stopped: require(tail[0]=='T')
 exe=os.path.realpath(base+'/exe'); cmd=open(base+'/cmdline','rb').read().split(b'\\0')
 require(cmd[-1]==b''); cmd=[v.decode() for v in cmd[:-1]]
 require(cmd==[exe,p['runtime']+'/src/queue-epoch-successor-worker.js'])
 children={task:open(base+'/task/'+task+'/children').read().split() for task in os.listdir(base+'/task')}
 require(not any(children.values()))
 if stopped:
  for task in children:
   row=open(base+'/task/'+task+'/stat').read(); require(row[row.rfind(')')+2:].split()[0]=='T')
 sockets={}; stdin=None
 for name in os.listdir(base+'/fd'):
  link=os.readlink(base+'/fd/'+name)
  if link.startswith('socket:['):
   inode=link[8:-1]; sockets[inode]=name
   if name=='0': stdin=inode
 for net in ['tcp','tcp6','udp','udp6']:
  for line in open(base+'/net/'+net).read().splitlines()[1:]:
   parts=line.split(); require(parts[9] not in sockets)
 rows=[]
 for line in open(base+'/net/unix').read().splitlines()[1:]:
  parts=line.split()
  if parts[6] in sockets:
   require(parts[6]==stdin or (len(parts)==8 and parts[7]==p['root']+'/broker.sock' and parts[3]=='00010000' and parts[5]=='01'))
   rows.append(line)
 require(len(rows)==len(sockets))
 for ref in p['refs']: require(digest(ref['path'])==ref['sha256'])
 for directory in p.get('inventory',[]): require(sorted(os.listdir(directory['path']))==directory['entries'])
 return {'pid':pid,'birth':birth,'exe':exe,'exeSha256':digest(exe),'cmdline':cmd,'childrenByTask':children,'socketRows':rows}
before=verify(p.get('stopped',False))
if p.get('freeze',False):
 require(before==p['expectedProcess'])
 signal.pidfd_send_signal(fd,signal.SIGSTOP)
 deadline=time.monotonic()+5
 while True:
  stopped=True
  for task in os.listdir(base+'/task'):
   stat=open(base+'/task/'+task+'/stat').read(); stopped=stopped and stat[stat.rfind(')')+2:].split()[0]=='T'
  if stopped: break
  require(time.monotonic()<deadline,'freeze outcome pending'); time.sleep(.01)
 frozen=verify(True)
 print(json.dumps({'process':frozen,'retired':False,'frozen':True,'mechanism':'pidfd_send_signal:SIGSTOP'}))
elif p['apply']:
 require(before==p['expectedProcess'])
 signal.pidfd_send_signal(fd,signal.SIGKILL)
 poll=select.poll(); poll.register(fd,select.POLLIN); require(poll.poll(30000),'retirement outcome pending')
 print(json.dumps({'process':before,'retired':True,'mechanism':'pidfd_send_signal:SIGKILL','gracefulClose':False}))
else: print(json.dumps({'process':before,'retired':False}))
os.close(fd)
`;
const anchor = path.join(__dirname, "../../queue-epoch-successor.js");
const load = createRequire(anchor);
const api = load("./queue-instance") as {
  hash(value: string | Uint8Array): string;
  readJson(file: string, max: number): unknown;
  priorProcessAlive(value: unknown): boolean | null;
  buildHash(root?: string): string;
};
const files = load("./queue-atomic-migration-files") as {
  directory(dir: string): void;
  exclusive(file: string, value: unknown): void;
};
const lineage = load("./queue-epoch-lineage") as {
  reference(file: string): Reference;
  successionAuthority(
    root: string,
    entry: Reference,
  ): {
    authority: Data;
    pointer: Data;
  };
};
const { bindPythonArtifactManifest } = load(
  "./dist/python/context-binding",
) as {
  bindPythonArtifactManifest(source: string, manifest: unknown): unknown;
};

function fail(message: string): never {
  throw Object.assign(new Error(message), {
    code: "SDK1_METADATA_RETIREMENT_UNPROVEN",
  });
}
function object(value: unknown): Data {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("Exact SDK1 retirement evidence object required");
  return value as Data;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value)
    fail("Exact SDK1 retirement identity required");
  return value;
}
function recordKeys(value: Data, expected: string[]) {
  return (
    Object.keys(value).sort().join(",") === expected.slice().sort().join(",")
  );
}
function read(file: string): Data {
  return object(api.readJson(file, 256 * 1024 * 1024));
}
function ref(file: string): Reference {
  if (
    !path.isAbsolute(file) ||
    fs.realpathSync(file) !== file ||
    !fs.lstatSync(file).isFile()
  )
    fail("Canonical regular SDK1 retirement evidence required");
  return lineage.reference(file);
}
function sameRef(file: string, expected: Reference) {
  if (!same(ref(file), expected))
    fail("SDK1 retirement evidence binding changed");
}
function sha(value: unknown) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function verifyAbsentSdk(
  observed: Sdk1SdkProcessObservation,
  expected: Process,
  fresh = true,
) {
  const timestamp = Date.parse(observed.observedAtUtc);
  if (
    observed.state !== "absent" ||
    observed.pid !== expected.pid ||
    observed.errorId !== exactSdkProcessAbsentErrorId ||
    !Number.isFinite(timestamp) ||
    timestamp > Date.now() ||
    (fresh && Date.now() - timestamp > 30_000)
  )
    fail(
      "Fresh exact-PID OS absence is required; live, reused, denied or unknown SDK process state refuses retirement",
    );
  return observed;
}
export function querySdkProcess(expected: Process): Sdk1SdkProcessObservation {
  if (!Number.isSafeInteger(expected.pid) || expected.pid <= 0)
    fail("Exact old SDK PID required for a fresh OS absence query");
  const script = `$ErrorActionPreference="Stop"; $target=${expected.pid}; try { $p=Get-Process -Id $target -ErrorAction Stop; [pscustomobject]@{state="present";pid=$p.Id;birth=$p.StartTime.ToFileTimeUtc().ToString();observedAtUtc=[DateTime]::UtcNow.ToString("o")}|ConvertTo-Json -Compress } catch { if ($_.FullyQualifiedErrorId -eq "${exactSdkProcessAbsentErrorId}") { [pscustomobject]@{state="absent";pid=$target;errorId=$_.FullyQualifiedErrorId;observedAtUtc=[DateTime]::UtcNow.ToString("o")}|ConvertTo-Json -Compress } else { throw } }`;
  const result = spawnSync(
    "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", timeout: 30000 },
  );
  if (result.error || result.status !== 0)
    fail("Fresh exact old-SDK OS absence is unavailable");
  return object(
    JSON.parse(result.stdout.replace(/^\uFEFF/, "")),
  ) as unknown as Sdk1SdkProcessObservation;
}
function defaultCertify(
  runtime: string,
  sourceCommit: string,
  buildHash: string,
) {
  const pinned =
    (sourceCommit === sdk1SourceCommit && buildHash === sdk1BuildHash) ||
    (sourceCommit === "923c339d3b8c85ca74e0c22511128958a97e7476" &&
      buildHash ===
        "63a7c521b4beb0808afc12815fa3a0ff3ec6dcbd5528bb5557fe284ad5872e14");
  if (!pinned)
    fail("Only the pinned qualified SDK1 metadata-worker runtime is supported");
  if (api.buildHash(runtime) !== buildHash)
    fail("Pinned SDK1 runtime bytes changed");
}
export function inspectMetadataWorkerProcess(
  owner: Sdk1MetadataWorkerProcess,
  runtime: string,
  refs: Reference[],
  apply: boolean,
  root: string,
  inventory: Array<{ path: string; entries: string[] }> = [],
  phase: "inspect" | "freeze" | "retire-frozen" = "inspect",
): Sdk1MetadataWorkerProcessResult {
  const input: Data = {
    owner,
    runtime,
    refs,
    apply,
    root,
    inventory,
    freeze: phase === "freeze",
    stopped: phase === "retire-frozen",
    ...(apply || phase === "freeze"
      ? { expectedProcess: owner.processProof }
      : {}),
  };
  const interpreterPath = fs.realpathSync("/usr/bin/python3"),
    version = spawnSync(interpreterPath, ["-I", "--version"], {
      encoding: "utf8",
      timeout: 5000,
    });
  if (version.error || version.status !== 0)
    fail("Canonical Python interpreter is unavailable");
  const interpreter = {
    path: interpreterPath,
    sha256: createHash("sha256")
      .update(fs.readFileSync(interpreterPath))
      .digest("hex"),
    version: (version.stdout || version.stderr).trim(),
  };
  if (
    (apply || phase === "freeze") &&
    !same(owner.interpreterProof, interpreter)
  )
    fail("Retirement interpreter changed before pidfd effect");
  input["refs"] = [
    ...refs,
    { path: interpreter.path, sha256: interpreter.sha256 },
  ];
  const result = spawnSync(
    interpreterPath,
    ["-I", "-c", metadataWorkerRetirementPidfdProgram],
    {
      input: JSON.stringify(input),
      encoding: "utf8",
      timeout: 35000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0)
    fail(
      "Linux pidfd identity/quiescence or retirement is unproven; never retry a signal blindly",
    );
  const output = object(JSON.parse(result.stdout)) as unknown as {
    process: NonNullable<Sdk1MetadataWorkerProcess["processProof"]>;
    retired: boolean;
    frozen?: boolean;
  };
  return { ...output, interpreter };
}
const defaultPorts: Sdk1MetadataWorkerRetirementPorts = {
  certify: defaultCertify,
  deathQuery: querySdkProcess,
  process: inspectMetadataWorkerProcess,
};

interface CheckedAttempt {
  root: string;
  audit: string;
  requestId: string;
  clientId: string;
  approvalRef: Reference;
  authority: Data;
  authorityRef: Reference;
  owner: Owner;
  runtime: string;
  processDeathProof: Reference;
  refs: Reference[];
  beforeFile: string;
  effectStartFile: string;
  afterFile: string;
}

function verifySdk1Attempt(
  client: Client,
  approvalFile: string,
  sdkProcessDeathProofFile: string,
): CheckedAttempt {
  const root = fs.realpathSync(client.dir);
  if (root !== client.dir) fail("Canonical existing owner root required");
  const approvalPath = fs.realpathSync(approvalFile),
    approvalRef = ref(approvalPath),
    approval = read(approvalPath),
    requestId = text(approval["requestId"]),
    clientId = text(client.auth.clientId),
    tokenHash = api.hash(client.auth.clientToken);
  if (
    approval["version"] !== 1 ||
    approval["purpose"] !== "dead-isolated-epoch-successor-v1" ||
    approval["clientId"] !== clientId ||
    requestId.length > 160
  )
    fail("Original credential-bound successor approval required");
  const audit = path.join(root, "epoch-successions", api.hash(requestId));
  if (fs.realpathSync(audit) !== audit || !fs.lstatSync(audit).isDirectory())
    fail("Existing canonical SDK1 successor audit directory required");
  files.directory(audit);
  const authorityFile = path.join(audit, "authority.json"),
    authorityRef = ref(authorityFile),
    authority = read(authorityFile),
    intentFile = path.join(audit, "intent.json"),
    intent = read(intentFile),
    workerClaimFile = path.join(audit, "worker-claim.json"),
    workerClaim = read(workerClaimFile),
    workerReadyFile = path.join(audit, "worker-ready.json"),
    workerReady = read(workerReadyFile),
    metadataFile = path.join(audit, "complete.json"),
    metadata = read(metadataFile),
    runtime = text(authority["candidateRoot"]),
    expectedProcess = object(authority["expectedProcess"]);
  if (fs.realpathSync(runtime) !== runtime || !path.isAbsolute(runtime))
    fail("Canonical original SDK1 runtime and authority required");
  const clientFile = path.join(root, "clients.json"),
    clients = read(clientFile),
    brokerFile = path.join(root, "broker.lock"),
    currentOwner = read(brokerFile),
    activeFile = path.join(root, "active-epoch-succession.json"),
    active = read(activeFile),
    pointerFile = path.join(root, "isolated-admission-epoch.json"),
    pointer = read(pointerFile),
    retiredOwnerFile = path.join(audit, "retired-owner.json"),
    retiredOwner = read(retiredOwnerFile),
    launchFile = path.join(audit, "launch-intent.json"),
    launch = read(launchFile),
    qualificationRef = object(
      authority["qualification"],
    ) as unknown as Reference,
    qualification = read(text(qualificationRef.path));
  const predecessor = object(authority["predecessor"]),
    approvedQualificationRef = object(
      approval["qualification"],
    ) as unknown as Reference;
  sameRef(text(approvedQualificationRef.path), approvedQualificationRef);
  sameRef(text(qualificationRef.path), qualificationRef);
  if (
    !same(approval["expectedProcess"], expectedProcess) ||
    !same(approval["previousOwner"], authority["previousOwner"]) ||
    approval["candidateRoot"] !== runtime ||
    approval["buildHash"] !== authority["buildHash"] ||
    approval["sourceCommit"] !== authority["sourceCommit"] ||
    approval["predecessorEpochId"] !== predecessor["epochId"] ||
    approval["previousBuildHash"] !== authority["previousBuildHash"] ||
    approval["pointerHash"] !== object(predecessor["pointer"])["sha256"] ||
    approval["stateHash"] !== object(predecessor["state"])["sha256"] ||
    approval["rootStateHash"] !== object(predecessor["rootState"])["sha256"] ||
    approval["rootIdentityHash"] !==
      object(predecessor["rootIdentity"])["sha256"] ||
    approvedQualificationRef.sha256 !== qualificationRef.sha256 ||
    authority["kind"] !== "owner-authenticated-dead-epoch-successor" ||
    authority["requestId"] !== requestId ||
    authority["clientId"] !== clientId ||
    authority["ownerTokenHash"] !== tokenHash ||
    authority["nonce"] !== intent["nonce"] ||
    authority["buildHash"] !== qualification["buildHash"] ||
    authority["sourceCommit"] !== qualification["sourceCommit"] ||
    qualification["passed"] !== true ||
    qualification["productionAdmission"] !== true ||
    qualification["liveSdkRequestsSent"] !== 0 ||
    !same(clients[clientId], tokenHash) ||
    intent["requestId"] !== requestId ||
    intent["clientId"] !== clientId ||
    intent["ownerTokenHash"] !== tokenHash ||
    !same(intent["previousOwner"], authority["previousOwner"]) ||
    !same(intent["approval"], approvalRef) ||
    !same(active, { version: 1, authority: authorityRef }) ||
    // A cold attempt has not published a new admission epoch. Its active
    // authority is separate from the unchanged predecessor's creation lineage.
    api.hash(fs.readFileSync(pointerFile)) !==
      object(predecessor["pointer"])["sha256"] ||
    pointer["epochId"] !== predecessor["epochId"] ||
    pointer["ownerClientId"] !== clientId ||
    pointer["ownerTokenHash"] !== tokenHash ||
    !same(launch, { nonce: intent["nonce"], authority: authorityRef }) ||
    !same(retiredOwner, authority["previousOwner"]) ||
    api.priorProcessAlive(retiredOwner) !== false
  )
    fail(
      "Exact original owner, successor authority, predecessor and qualification required",
    );
  const checked = lineage.successionAuthority(root, authorityRef),
    predecessorPointer = object(checked.pointer),
    quarantinedJobs = predecessorPointer["quarantinedJobIds"],
    owner = object(workerReady["owner"]) as unknown as Owner,
    guard = {
      kind: "dead-epoch-successor",
      nonce: intent["nonce"],
      audit,
      clientId,
    };
  if (
    !Array.isArray(quarantinedJobs) ||
    quarantinedJobs.length < 2 ||
    workerClaim["nonce"] !== intent["nonce"] ||
    workerClaim["pid"] !== owner.pid ||
    workerClaim["birth"] !== owner.birth ||
    owner.protocol !== 2 ||
    workerReady["nonce"] !== intent["nonce"] ||
    workerReady["sdkRequestsSent"] !== 0 ||
    workerReady["buildHash"] !== authority["buildHash"] ||
    !same(currentOwner, owner) ||
    metadata["kind"] !== "dead-epoch-successor-metadata-ready" ||
    metadata["requestId"] !== requestId ||
    !same(metadata["authority"], authorityRef) ||
    !same(metadata["owner"], owner) ||
    metadata["sourceCommit"] !== authority["sourceCommit"] ||
    metadata["buildHash"] !== authority["buildHash"] ||
    metadata["sdkRequestsSent"] !== 0 ||
    metadata["historicalOutcome"] !== "unknown" ||
    metadata["modelingAdmission"] !==
      "blocked-until-current-facts-and-proven-new-scratch" ||
    fs.existsSync(path.join(root, "recovery.lock")) ||
    fs.existsSync(path.join(root, "atomic-migration.lock")) ||
    !same(read(path.join(audit, "released-recovery.lock.json")), guard) ||
    !same(
      read(path.join(audit, "released-atomic-migration.lock.json")),
      guard,
    ) ||
    owner.pid === expectedProcess["pid"] ||
    owner.birth === expectedProcess["birth"]
  )
    fail(
      "Exact live metadata worker and released successor lifecycle required",
    );
  const lifecycleFile = path.join(
      root,
      "broker-lifecycle-" + text(owner.nonce) + ".json",
    ),
    lifecycle = read(lifecycleFile);
  if (
    !same(lifecycle["owner"], owner) ||
    lifecycle["stage"] !== "ready" ||
    lifecycle["buildHash"] !== authority["buildHash"] ||
    lifecycle["configHash"] !== authority["configHash"] ||
    fs
      .readdirSync(root)
      .some((name) => name.startsWith("broker-startup-" + owner.nonce)) ||
    [root, text(predecessorPointer["root"])].some((dir) =>
      fs.existsSync(path.join(dir, "queue-state.pending.json")),
    )
  )
    fail(
      "Metadata-only lifecycle with no pending startup or queue state required",
    );
  if (
    api.priorProcessAlive(object(checked.pointer)["currentInstance"]) !==
      false ||
    api.priorProcessAlive(object(checked.pointer)["originalInstance"]) !== false
  )
    fail("Original predecessor processes must remain proven dead");

  const observationDir = path.join(audit, "dead-epoch-current-observation");
  if (
    fs.realpathSync(observationDir) !== observationDir ||
    !fs.lstatSync(observationDir).isDirectory()
  )
    fail("Canonical original SDK1 observation directory required");
  const observationNames = fs.readdirSync(observationDir).sort(),
    nativeObservation = observationNames.includes("received-response.json");
  if (
    authority["sourceCommit"] === "923c339d3b8c85ca74e0c22511128958a97e7476" &&
    !nativeObservation
  )
    fail(
      "The pinned 923c retirement extension requires the original six-file retained native observation",
    );
  if (
    !nativeObservation &&
    !same(observationNames, [
      "intent.json",
      "result.json",
      "start.json",
      "wire.json",
    ])
  )
    fail(
      "Terminal SDK1 unknown journal without response or active dispatch required",
    );
  const observationIntentFile = path.join(observationDir, "intent.json"),
    observationStartFile = path.join(observationDir, "start.json"),
    observationWireFile = path.join(observationDir, "wire.json"),
    observationResultFile = path.join(observationDir, "result.json"),
    observationIntent = read(observationIntentFile),
    start = read(observationStartFile),
    startBinding = object(start["binding"]),
    pythonCheck = object(start["pythonCheck"]),
    provenance = object(pythonCheck["provenance"]),
    wire = read(observationWireFile),
    outgoing = object(wire["outgoing"]),
    params = object(outgoing["params"]),
    args = object(params["arguments"]),
    artifact = object(wire["artifact"]),
    artifactContext = object(artifact["context"]),
    artifactOrigin = object(artifactContext["origin"]),
    artifactOriginContext = nativeObservation
      ? {}
      : object(artifactOrigin["context"]),
    artifactOriginRequest = nativeObservation
      ? {}
      : object(artifactOrigin["request"]),
    result = read(observationResultFile),
    rpcId = text(startBinding["rpcId"]),
    key = {
      jobId: quarantinedJobs[0],
      observationJobId: quarantinedJobs[1],
      requestId: requestId + ":observe",
      clientId,
    };
  const userUnits = Array.isArray(artifact["units"])
      ? artifact["units"]
          .map(object)
          .filter(
            (unit) =>
              unit["role"] === "user" &&
              unit["sha256"] === startBinding["sourceHash"],
          )
      : [],
    originSegments = Array.isArray(artifactOrigin["segments"])
      ? artifactOrigin["segments"]
          .map(object)
          .filter((segment) => segment["sha256"] === startBinding["sourceHash"])
      : [];
  const originSegmentBound =
    userUnits.length === 1 &&
    originSegments.length === 1 &&
    (() => {
      const unit = userUnits[0]!,
        segment = originSegments[0]!,
        startLine = segment["startLine"],
        endLine = segment["endLine"];
      if (
        typeof unit["source"] !== "string" ||
        !Number.isSafeInteger(startLine) ||
        !Number.isSafeInteger(endLine) ||
        typeof startLine !== "number" ||
        typeof endLine !== "number" ||
        startLine < 1 ||
        endLine < startLine
      )
        return false;
      const lines = unit["source"].split("\n");
      return (
        endLine <= lines.length &&
        api.hash(unit["source"]) === startBinding["sourceHash"] &&
        api.hash(lines.slice(startLine - 1, endLine).join("\n")) ===
          artifactOrigin["sha256"]
      );
    })();
  if (
    !nativeObservation &&
    (observationIntent["version"] !== 1 ||
      !same(observationIntent["key"], key) ||
      !same(observationIntent["binding"], {
        purpose: "atomic-recovery-audit-v1",
        clientId,
        expectedProcess,
        successorAuthorityHash: authorityRef.sha256,
      }) ||
      !sha(observationIntent["sourceSha256"]) ||
      !sha(observationIntent["sourceArtifactHash"]) ||
      startBinding["jobId"] !== key.jobId ||
      !rpcId ||
      !sha(startBinding["requestHash"]) ||
      startBinding["buildHash"] !== authority["buildHash"] ||
      !sha(startBinding["sourceHash"]) ||
      startBinding["purpose"] !== "atomic-recovery-audit-v1" ||
      !sha(startBinding["auditBindingHash"]) ||
      startBinding["pythonOriginHash"] !==
        observationIntent["sourceArtifactHash"] ||
      !same(startBinding["auditExpectedProcess"], expectedProcess) ||
      !same(start["instance"], expectedProcess) ||
      start["receipt"] !==
        path.join(observationDir, "remote-" + rpcId + ".json") ||
      fs.existsSync(text(start["receipt"])) ||
      pythonCheck["status"] !== "passed" ||
      !sha(provenance["artifactHash"]) ||
      !sha(provenance["wireHash"]) ||
      start["originArtifactHash"] !== observationIntent["sourceArtifactHash"] ||
      !recordKeys(outgoing, ["jsonrpc", "id", "method", "params"]) ||
      outgoing["jsonrpc"] !== "2.0" ||
      outgoing["id"] !== "fmcad:" + rpcId ||
      outgoing["method"] !== "tools/call" ||
      !recordKeys(params, ["name", "arguments"]) ||
      params["name"] !== "execute_python" ||
      !recordKeys(args, ["code", "persistent"]) ||
      typeof args["code"] !== "string" ||
      !args["code"] ||
      args["persistent"] !== false ||
      !recordKeys(artifact, [
        "version",
        "runtimeVersion",
        "units",
        "context",
        "request",
        "sourceMap",
        "sha256",
        "artifactHash",
      ]) ||
      artifact["artifactHash"] !== provenance["artifactHash"] ||
      artifact["sha256"] !== provenance["wireHash"] ||
      !same(artifact["request"], startBinding) ||
      !Array.isArray(artifactContext["entrypoints"]) ||
      artifactOrigin["artifactHash"] !==
        observationIntent["sourceArtifactHash"] ||
      !originSegmentBound ||
      !same(artifactOriginContext, {
        kind: "atomic-recovery-audit-v1",
        purpose: "atomic-recovery-audit-v1",
        clientId,
        expectedProcess,
        successorAuthorityHash: authorityRef.sha256,
      }) ||
      !same(artifactOriginRequest["identity"], observationIntent["identity"]) ||
      !recordKeys(result, [
        "kind",
        "jobId",
        "observationJobId",
        "requestId",
        "clientId",
        "status",
        "code",
        "sdkRequestsSent",
        "nativeOutcome",
        "modelValidation",
        "rollbackVerification",
      ]) ||
      result["kind"] !== "dead-epoch-current-observation" ||
      !same(result["jobId"], key.jobId) ||
      !same(result["observationJobId"], key.observationJobId) ||
      result["requestId"] !== key.requestId ||
      result["clientId"] !== clientId ||
      result["status"] !== "failed" ||
      typeof result["code"] !== "string" ||
      !result["code"] ||
      result["sdkRequestsSent"] !== 1 ||
      result["nativeOutcome"] !== "unknown" ||
      result["modelValidation"] !== "not_performed" ||
      result["rollbackVerification"] !== "not_performed")
  )
    fail(
      "Exact source/request-bound historical execute_python SDK1 unknown attempt required",
    );
  if (!nativeObservation)
    try {
      bindPythonArtifactManifest(args["code"] as string, artifact);
    } catch {
      fail(
        "Historical execute_python source does not match its complete artifact manifest",
      );
    }

  let retainedRefs: Reference[] = [];
  if (nativeObservation) {
    if (
      authority["sourceCommit"] !== "923c339d3b8c85ca74e0c22511128958a97e7476"
    )
      fail(
        "Retained six-file SDK1 retirement is restricted to the exact 923c source",
      );
    if (
      !same(
        observationNames,
        [
          "intent.json",
          "result.json",
          "start.json",
          "wire.json",
          "received-response.json",
          "remote-" + rpcId + ".json",
        ].sort(),
      )
    )
      fail(
        "Exact six-file retained native observation required after SDK death",
      );
    const retained = (
      load(
        "./dist/node-adapters/execution/recovery-audit",
      ) as typeof import("../../packages/node-adapters/src/execution/recovery-audit")
    ).verifyRetainedAuditResponse({
      directory: observationDir,
      key: key as Record<string, string>,
      identity: read(
        path.join(
          path.dirname(
            text(object(predecessorPointer["qualificationReceipt"])["path"]),
          ),
          "intent.json",
        ),
      )["identity"],
      binding: {
        purpose: "atomic-recovery-audit-v1",
        clientId,
        expectedProcess,
        successorAuthorityHash: authorityRef.sha256,
      },
      instance: expectedProcess as unknown as Process,
      buildHash: text(authority["buildHash"]),
    });
    const reader = (
      createRequire(path.join(runtime, "src/queue-atomic-recovery-audit.js"))(
        "./queue-atomic-recovery-audit",
      ) as typeof import("../queue-atomic-recovery-audit")
    ).prepareRecoveryAudit(
      runtime,
      observationIntent["identity"],
      object(observationIntent["binding"]),
    );
    if (
      observationIntent["sourceSha256"] !== reader.sourceSha256 ||
      observationIntent["sourceArtifactHash"] !==
        reader.artifact.artifactHash ||
      startBinding["sourceHash"] !== reader.artifact.sha256
    )
      fail(
        "Retained native observation differs from the original source-bound audit builder",
      );
    retainedRefs = Object.values(retained.files);
  }

  const processDeathProofPath = fs.realpathSync(sdkProcessDeathProofFile),
    processDeathProof = ref(processDeathProofPath),
    observation = {
      bindings: {
        authority: authorityRef,
        observationIntent: ref(observationIntentFile),
        observationStart: ref(observationStartFile),
        observationWire: ref(observationWireFile),
        observationResult: ref(observationResultFile),
      },
    };
  if (
    !same(
      verifySdkProcessDeathProof(
        processDeathProofPath,
        expectedProcess as unknown as Process,
        observation.bindings,
      ),
      processDeathProof,
    )
  )
    fail("Exact old SDK PID/birth death proof required");

  const auditEntries = new Set([
    "authority.json",
    "intent.json",
    "launch-intent.json",
    "predecessor-pointer.json",
    "previous-active-succession.json",
    "retired-owner.json",
    "installed-qualification.json",
    "worker-claim.json",
    "worker-ready.json",
    "complete.json",
    "worker.stdout.log",
    "worker.stderr.log",
    "dead-epoch-current-observation",
    "released-recovery.lock.json",
    "released-atomic-migration.lock.json",
    "sdk1-worker-retirement",
  ]);
  if (fs.readdirSync(audit).some((name) => !auditEntries.has(name)))
    fail(
      "Unexpected startup, SDK, scratch, pending or settlement evidence refuses retirement",
    );
  if (
    fs.existsSync(path.join(audit, "abort-unstarted")) ||
    fs.existsSync(path.join(audit, "worker-error.json")) ||
    fs.existsSync(path.join(audit, "launch-error.json"))
  )
    fail(
      "Existing abort or failed startup evidence refuses SDK1 worker retirement",
    );

  const predecessorRefs = [
      predecessor["pointer"],
      predecessor["identity"],
      predecessor["state"],
      predecessor["rootState"],
      predecessor["rootIdentity"],
      ...(Array.isArray(predecessor["grants"]) ? predecessor["grants"] : []),
      ...(Array.isArray(predecessor["qualification"])
        ? predecessor["qualification"]
        : []),
    ].map((value) => object(value) as unknown as Reference),
    refs = [
      approvalRef,
      authorityRef,
      ...predecessorRefs,
      ref(intentFile),
      ref(launchFile),
      ref(retiredOwnerFile),
      ref(clientFile),
      ref(brokerFile),
      ref(activeFile),
      ref(pointerFile),
      ref(path.join(audit, "released-recovery.lock.json")),
      ref(path.join(audit, "released-atomic-migration.lock.json")),
      ref(qualificationRef.path),
      approvedQualificationRef,
      ref(workerClaimFile),
      ref(workerReadyFile),
      ref(metadataFile),
      ref(lifecycleFile),
      ...Object.values(observation.bindings),
      ...retainedRefs,
      processDeathProof,
      ref(path.join(runtime, "src/queue-epoch-successor-worker.js")),
    ];
  const unique = new Map(refs.map((entry) => [entry.path, entry]));
  const abortDir = path.join(audit, "sdk1-worker-retirement");
  return {
    root,
    audit,
    requestId,
    clientId,
    approvalRef,
    authority,
    authorityRef,
    owner,
    runtime,
    processDeathProof,
    refs: [...unique.values()],
    beforeFile: path.join(abortDir, "before.json"),
    effectStartFile: path.join(abortDir, "effect-start.json"),
    afterFile: path.join(abortDir, "after.json"),
  };
}

function verifyStatus(value: unknown, attempt: CheckedAttempt) {
  const status = object(value),
    control = object(status["control"]),
    successor = object(status["deadEpochSuccessor"]),
    features = object(status["features"]);
  if (
    status["buildHash"] !== attempt.authority["buildHash"] ||
    status["sourceCommit"] !== attempt.authority["sourceCommit"] ||
    status["held"] !==
      "Qualified isolated scratch process is unavailable; metadata only, no SDK or replacement authority" ||
    status["stopping"] !== false ||
    successor["requestId"] !== attempt.requestId ||
    successor["currentFactsAvailable"] !== false ||
    !same(successor["expectedProcess"], attempt.authority["expectedProcess"]) ||
    control["instanceId"] !== attempt.owner.nonce ||
    control["buildHash"] !== attempt.authority["buildHash"] ||
    control["activeOperations"] !== 0 ||
    !same(control["activeIds"], []) ||
    control["unresolved"] !== true ||
    control["phase"] !== "RECOVERY_BLOCKED" ||
    features["auditFactsCapture"] !== false ||
    features["atomicRecoveryProcessLossAudit"] !== false
  )
    fail("Fresh metadata-only status is not quiescent or is not owner-bound");
  return status;
}
function verifyProcessSnapshot(
  value: Sdk1MetadataWorkerProcessResult,
  owner: Owner,
  runtime: string,
) {
  const process = object(value.process);
  if (
    value.retired !== false ||
    process["pid"] !== owner.pid ||
    process["birth"] !== owner.birth ||
    !path.isAbsolute(text(process["exe"])) ||
    !sha(process["exeSha256"]) ||
    !same(process["cmdline"], [
      process["exe"],
      path.join(runtime, "src/queue-epoch-successor-worker.js"),
    ]) ||
    Object.values(object(process["childrenByTask"])).some(
      (children) => !Array.isArray(children) || children.length !== 0,
    ) ||
    !Array.isArray(process["socketRows"]) ||
    process["socketRows"].length > 2 ||
    process["socketRows"].some((row) => typeof row !== "string")
  )
    fail(
      "Current metadata worker executable, PID/birth or quiescence proof changed",
    );
  return value;
}
function verifyFreshAbsence(
  ports: Sdk1MetadataWorkerRetirementPorts,
  expectedProcess: Process,
) {
  const absence = verifyAbsentSdk(
    ports.deathQuery(expectedProcess),
    expectedProcess,
  );
  return absence;
}
function verifyRefs(refs: Reference[]) {
  for (const entry of refs) sameRef(entry.path, entry);
}
function interpreterOf(value: Sdk1MetadataWorkerProcessResult) {
  if (!value.interpreter) fail("Exact pidfd interpreter proof required");
  return value.interpreter;
}
function pending(attempt: CheckedAttempt): Sdk1MetadataWorkerRetirementPending {
  return {
    ready: false,
    retirementPending: true,
    noSignalReplay: true,
    requestId: attempt.requestId,
    sdkRequestsSent: 1,
    nativeOutcome: "unknown",
    historicalOutcome: "unknown",
  };
}
function completion(
  attempt: CheckedAttempt,
  ports: Sdk1MetadataWorkerRetirementPorts,
): Sdk1MetadataWorkerRetirementComplete {
  const freshSdkProcess = verifyFreshAbsence(
    ports,
    attempt.authority["expectedProcess"] as Process,
  );
  const before = ref(attempt.beforeFile),
    effectStart = ref(attempt.effectStartFile),
    after = read(attempt.afterFile);
  if (
    after["version"] !== 1 ||
    after["kind"] !== "sdk1-metadata-worker-retirement-complete" ||
    after["status"] !== "retired" ||
    after["requestId"] !== attempt.requestId ||
    after["clientId"] !== attempt.clientId ||
    !same(after["owner"], attempt.owner) ||
    after["sdkRequestsSent"] !== 1 ||
    after["nativeOutcome"] !== "unknown" ||
    after["historicalOutcome"] !== "unknown" ||
    after["protectedBytesUnchanged"] !== true ||
    !same(after["before"], before) ||
    !same(after["effectStart"], effectStart) ||
    !same(after["processDeathProof"], attempt.processDeathProof) ||
    after["mechanism"] !== "pidfd_send_signal:SIGKILL" ||
    after["gracefulClose"] !== false
  )
    fail("Original SDK1 worker-retirement completion proof changed");
  const beforeRecord = read(attempt.beforeFile),
    startRecord = read(attempt.effectStartFile);
  if (
    beforeRecord["kind"] !== "sdk1-metadata-worker-retirement-before" ||
    beforeRecord["requestId"] !== attempt.requestId ||
    beforeRecord["clientId"] !== attempt.clientId ||
    !same(beforeRecord["owner"], attempt.owner) ||
    !same(beforeRecord["processDeathProof"], attempt.processDeathProof) ||
    beforeRecord["sdkRequestsSent"] !== 1 ||
    beforeRecord["nativeOutcome"] !== "unknown" ||
    startRecord["kind"] !== "sdk1-metadata-worker-retirement-effect-start" ||
    startRecord["requestId"] !== attempt.requestId ||
    !same(startRecord["owner"], attempt.owner) ||
    !same(startRecord["before"], before) ||
    !same(startRecord["processDeathProof"], attempt.processDeathProof)
  )
    fail("Original SDK1 worker-retirement preparation proof changed");
  const expectedProcess = attempt.authority["expectedProcess"] as Process,
    sdkProcessAfter = object(
      after["sdkProcessAfter"],
    ) as unknown as Sdk1SdkProcessObservation,
    sdkProcessBeforeEffect = object(
      startRecord["sdkProcessBeforeEffect"],
    ) as unknown as Sdk1SdkProcessObservation;
  verifyAbsentSdk(sdkProcessAfter, expectedProcess, false);
  verifyAbsentSdk(sdkProcessBeforeEffect, expectedProcess, false);
  if (
    Date.parse(sdkProcessAfter.observedAtUtc) <=
      Date.parse(sdkProcessBeforeEffect.observedAtUtc) ||
    freshSdkProcess.pid !== sdkProcessAfter.pid ||
    freshSdkProcess.errorId !== sdkProcessAfter.errorId
  )
    fail("SDK PID absence must be freshly rechecked after metadata retirement");
  const recordedRefs = beforeRecord["references"];
  if (!Array.isArray(recordedRefs))
    fail("Append-only worker evidence list required");
  verifyRefs(recordedRefs as Reference[]);
  verifyRefs(attempt.refs);
  if (api.priorProcessAlive(attempt.owner) !== false)
    fail("Metadata worker retirement outcome is pending; never signal again");
  return after as unknown as Sdk1MetadataWorkerRetirementComplete;
}

export async function retireSdk1MetadataWorker(
  client: Client & { call(action: "queue-summary"): Promise<unknown> },
  approvalFile: string,
  sdkProcessDeathProofFile: string,
  apply: boolean,
  testPorts?: Partial<Sdk1MetadataWorkerRetirementPorts>,
): Promise<Sdk1MetadataWorkerRetirementResult> {
  const ports = { ...defaultPorts, ...testPorts },
    attempt = verifySdk1Attempt(client, approvalFile, sdkProcessDeathProofFile),
    expectedProcess = attempt.authority["expectedProcess"] as Process,
    existingAfter = fs.existsSync(attempt.afterFile),
    existingStart = fs.existsSync(attempt.effectStartFile);
  const retirementDir = path.dirname(attempt.afterFile);
  if ((existingAfter || existingStart) && !fs.existsSync(retirementDir))
    fail("SDK1 retirement journal is incomplete");
  if (fs.existsSync(retirementDir)) files.directory(retirementDir);
  ports.certify(
    attempt.runtime,
    text(attempt.authority["sourceCommit"]),
    text(attempt.authority["buildHash"]),
  );
  if (
    ports.certify === defaultCertify &&
    attempt.authority["sourceCommit"] ===
      "923c339d3b8c85ca74e0c22511128958a97e7476" &&
    attempt.authority["configHash"] !==
      "fb8fba61d742d82c5cea76df8c8e7e235dd2bb09744685835aa4622f88dbd045"
  )
    fail(
      "Only the pinned 923c metadata configuration may use retained native SDK1 retirement",
    );
  const proofAfter = () => verifyFreshAbsence(ports, expectedProcess);
  proofAfter();
  if (existingAfter) return completion(attempt, ports);
  if (existingStart) {
    const start = read(attempt.effectStartFile);
    if (
      start["requestId"] !== attempt.requestId ||
      !same(start["owner"], attempt.owner) ||
      !same(start["processDeathProof"], attempt.processDeathProof) ||
      !same(start["before"], ref(attempt.beforeFile))
    )
      fail("Existing SDK1 retirement effect-start proof changed");
    const workerAlive = api.priorProcessAlive(attempt.owner);
    if (workerAlive === true) return pending(attempt);
    if (workerAlive !== false)
      fail("Metadata worker PID/birth liveness is unavailable");
    if (!apply) return pending(attempt);
    proofAfter();
    return finishAfter(attempt, ports);
  }
  if (fs.existsSync(path.join(attempt.audit, "abort-unstarted")))
    fail("An existing withdrawal/abort journal forbids new worker retirement");
  const snapshot = async () => {
    const status = verifyStatus(await client.call("queue-summary"), attempt),
      sdkProcess = proofAfter(),
      process = verifyProcessSnapshot(
        ports.process(
          attempt.owner,
          attempt.runtime,
          attempt.refs,
          false,
          attempt.root,
        ),
        attempt.owner,
        attempt.runtime,
      );
    verifyRefs(attempt.refs);
    if (api.buildHash(attempt.runtime) !== attempt.authority["buildHash"])
      fail("Qualified metadata worker runtime bytes changed");
    if (api.priorProcessAlive(attempt.owner) !== true)
      fail(
        "Exact current metadata worker PID/birth must be live before retirement",
      );
    return {
      status,
      sdkProcess,
      process: process.process,
      interpreter: interpreterOf(process),
    };
  };
  const first = await snapshot();
  if (!apply)
    return {
      ready: true,
      requestId: attempt.requestId,
      retirementPerformed: false,
      mechanism: "pidfd_send_signal:SIGKILL",
      gracefulClose: false,
      owner: attempt.owner,
      sdkRequestsSent: 1,
      nativeOutcome: "unknown",
      historicalOutcome: "unknown",
    } satisfies Sdk1MetadataWorkerRetirementPreview;
  if (!fs.existsSync(retirementDir))
    fs.mkdirSync(retirementDir, { recursive: false, mode: 0o700 });
  files.directory(retirementDir);
  const before = {
    version: 1,
    kind: "sdk1-metadata-worker-retirement-before",
    requestId: attempt.requestId,
    clientId: attempt.clientId,
    approval: attempt.approvalRef,
    authority: attempt.authorityRef,
    owner: attempt.owner,
    processDeathProof: attempt.processDeathProof,
    sdkProcess: first.sdkProcess,
    process: first.process,
    interpreter: first.interpreter,
    sdkRequestsSent: 1,
    nativeOutcome: "unknown",
    historicalOutcome: "unknown",
    references: attempt.refs,
  };
  if (fs.existsSync(attempt.beforeFile)) {
    const existing = read(attempt.beforeFile),
      existingProcess = object(existing["process"]);
    if (
      existing["kind"] !== "sdk1-metadata-worker-retirement-before" ||
      existing["requestId"] !== attempt.requestId ||
      existing["clientId"] !== attempt.clientId ||
      !same(existing["approval"], attempt.approvalRef) ||
      !same(existing["authority"], attempt.authorityRef) ||
      !same(existing["owner"], attempt.owner) ||
      !same(existing["processDeathProof"], attempt.processDeathProof) ||
      existing["sdkRequestsSent"] !== 1 ||
      existing["nativeOutcome"] !== "unknown" ||
      !same(existingProcess, first.process) ||
      !same(existing["interpreter"], first.interpreter) ||
      !same(existing["references"], attempt.refs)
    )
      fail("Original SDK1 retirement-before proof changed");
    verifyAbsentSdk(
      object(existing["sdkProcess"]) as unknown as Sdk1SdkProcessObservation,
      expectedProcess,
      false,
    );
  } else files.exclusive(attempt.beforeFile, before);
  const second = await snapshot();
  if (
    !same(first.status, second.status) ||
    !same(first.process, second.process) ||
    !same(first.interpreter, second.interpreter)
  )
    fail(
      "Worker, status or quiescence changed during SDK1 retirement preparation",
    );
  const beforeRef = ref(attempt.beforeFile),
    sdkProcessBeforeEffect = proofAfter(),
    effectStart = {
      version: 1,
      kind: "sdk1-metadata-worker-retirement-effect-start",
      requestId: attempt.requestId,
      clientId: attempt.clientId,
      before: beforeRef,
      owner: attempt.owner,
      processDeathProof: attempt.processDeathProof,
      sdkRequestsSent: 1,
      nativeOutcome: "unknown",
      historicalOutcome: "unknown",
      sdkProcessBeforeEffect,
      mechanism: "pidfd_send_signal:SIGKILL",
      gracefulClose: false,
    };
  files.exclusive(attempt.effectStartFile, effectStart);
  verifyRefs(attempt.refs);
  proofAfter();
  const result = ports.process(
    {
      ...attempt.owner,
      processProof: second.process,
      interpreterProof: second.interpreter,
    },
    attempt.runtime,
    [...attempt.refs, beforeRef, ref(attempt.effectStartFile)],
    true,
    attempt.root,
  );
  if (result.retired !== true) fail("pidfd retirement result is unproven");
  return finishAfter(attempt, ports);
}

function finishAfter(
  attempt: CheckedAttempt,
  ports: Sdk1MetadataWorkerRetirementPorts,
) {
  const expectedProcess = attempt.authority["expectedProcess"] as Process;
  const sdkProcessAfter = verifyFreshAbsence(ports, expectedProcess);
  verifyRefs(attempt.refs);
  if (api.priorProcessAlive(attempt.owner) !== false) return pending(attempt);
  const before = ref(attempt.beforeFile),
    effectStart = ref(attempt.effectStartFile),
    after: Sdk1MetadataWorkerRetirementComplete = {
      version: 1,
      kind: "sdk1-metadata-worker-retirement-complete",
      status: "retired",
      requestId: attempt.requestId,
      clientId: attempt.clientId,
      owner: attempt.owner,
      sdkRequestsSent: 1,
      nativeOutcome: "unknown",
      historicalOutcome: "unknown",
      protectedBytesUnchanged: true,
      before,
      effectStart,
      processDeathProof: attempt.processDeathProof,
      sdkProcessAfter,
      mechanism: "pidfd_send_signal:SIGKILL",
      gracefulClose: false,
    };
  files.exclusive(attempt.afterFile, after);
  return after;
}

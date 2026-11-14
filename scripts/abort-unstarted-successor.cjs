#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.metadataRetirementPidfdProgram = void 0;
exports.abortUnstartedSuccessor = abortUnstartedSuccessor;
exports.retireMetadataWorker = retireMetadataWorker;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_module_1 = require("node:module");
const node_util_1 = require("node:util");
const node_child_process_1 = require("node:child_process");
// This fixed program has no shell, PID-only signal, SIGTERM fallback or Fusion
// access. The pidfd is opened BEFORE /proc identity checks and held to exit.
exports.metadataRetirementPidfdProgram = `import os,sys,json,hashlib,signal,select
def require(condition,message='metadata retirement proof refused'):
 if not condition: raise RuntimeError(message)
p=json.load(sys.stdin); owner=p['owner']; pid=owner['pid']; base='/proc/'+str(pid)
require(isinstance(pid,int) and pid>1 and pid!=os.getpid())
require(hasattr(os,'pidfd_open') and hasattr(signal,'pidfd_send_signal'))
fd=os.pidfd_open(pid)
def digest(file):
 with open(file,'rb') as f: return hashlib.sha256(f.read()).hexdigest()
def verify():
 stat=open(base+'/stat').read(); tail=stat[stat.rfind(')')+2:].split()
 birth=open('/proc/sys/kernel/random/boot_id').read().strip()+':'+tail[19]
 require(birth==owner['birth'] and tail[0]!='Z')
 exe=os.path.realpath(base+'/exe'); cmd=open(base+'/cmdline','rb').read().split(b'\\0')
 require(cmd[-1]==b''); cmd=[v.decode() for v in cmd[:-1]]
 require(cmd==[exe,p['runtime']+'/src/queue-epoch-successor-worker.js'])
 children={task:open(base+'/task/'+task+'/children').read().split() for task in os.listdir(base+'/task')}
 require(not any(children.values()))
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
 return {'pid':pid,'birth':birth,'exe':exe,'exeSha256':digest(exe),'cmdline':cmd,'childrenByTask':children,'socketRows':rows}
before=verify()
if p['apply']:
 require(before==p['expectedProcess'])
 signal.pidfd_send_signal(fd,signal.SIGKILL)
 poll=select.poll(); poll.register(fd,select.POLLIN); require(poll.poll(30000),'retirement outcome pending')
 print(json.dumps({'process':before,'retired':True,'mechanism':'pidfd_send_signal:SIGKILL','gracefulClose':False}))
else: print(json.dumps({'process':before,'retired':False}))
os.close(fd)
`;
const linuxRetirementPorts = {
    certify(proof) {
        if (proof["sourceCommit"] !== "48ef3305e47ca412e7bafba00ca383ada0f99723" ||
            proof["buildHash"] !==
                "0d08b1e49c2c29f17e46b03ad6f9777100b771a627db088ab86f2267d2f02880")
            fail("Only the independently certified immutable 48ef metadata closure is supported");
        const runtime = text(proof["runtimeRoot"]);
        const load = (0, node_module_1.createRequire)(node_path_1.default.join(runtime, "src/queue-instance.js"));
        if (load("./queue-instance").buildHash(runtime) !== proof["buildHash"])
            fail("Certified old runtime bytes changed");
    },
    process(owner, runtime, refs, apply, root) {
        // A fresh read-only snapshot is required even by the effect proxy. Node
        // supplies expectedProcess only after the second status/identity validation.
        const input = {
            owner,
            runtime,
            refs,
            apply,
            root,
            ...(apply ? { expectedProcess: owner["processProof"] } : {}),
        };
        const result = (0, node_child_process_1.spawnSync)("python3", ["-c", exports.metadataRetirementPidfdProgram], {
            input: JSON.stringify(input),
            encoding: "utf8",
            timeout: 35000,
            maxBuffer: 8 * 1024 * 1024,
        });
        if (result.error || result.status !== 0)
            fail("Linux pidfd identity/quiescence or retirement is unproven; never retry a signal blindly");
        return object(JSON.parse(result.stdout));
    },
    fusion(expected) {
        const pid = expected["pid"];
        if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0)
            fail("Exact Fusion OS PID required");
        const script = `$ErrorActionPreference="Stop"; $p=Get-Process -Id ${pid} -ErrorAction Stop; [pscustomobject]@{observedAtUtc=[DateTime]::UtcNow.ToString("o");pid=$p.Id;birth=$p.StartTime.ToFileTimeUtc().ToString();version=$p.FileVersion;hasExited=$p.HasExited;responding=$p.Responding}|ConvertTo-Json -Compress`;
        const result = (0, node_child_process_1.spawnSync)("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 30000 });
        if (result.error || result.status !== 0)
            fail("Fresh read-only Fusion OS identity is unavailable");
        return object(JSON.parse(result.stdout.replace(/^\uFEFF/, "")));
    },
};
function fail(message) {
    throw Object.assign(new Error(message), { code: "SUCCESSOR_ABORT_UNPROVEN" });
}
function object(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        fail("Object-shaped original evidence required");
    return value;
}
function text(value) {
    if (typeof value !== "string" || !value)
        fail("Exact original identity required");
    return value;
}
/** Owner-only metadata recovery; never launches a worker or calls Fusion. */
function abortUnstartedSuccessor(client, approvalFile, apply, { retirementInspection = false } = {}) {
    const approval = object(JSON.parse(node_fs_1.default.readFileSync(approvalFile, "utf8")));
    const runtime = text(approval["candidateRoot"]);
    if (!node_path_1.default.isAbsolute(runtime) || node_fs_1.default.realpathSync(runtime) !== runtime)
        fail("Canonical original runtime required");
    const load = (0, node_module_1.createRequire)(node_path_1.default.join(runtime, "src/queue-instance.js"));
    const api = load("./queue-instance");
    const files = load("./queue-atomic-migration-files");
    const lineage = load("./queue-epoch-lineage");
    const root = node_fs_1.default.realpathSync(client.dir);
    files.directory(root);
    const requestId = text(approval["requestId"]);
    if (requestId.length > 160 ||
        approval["purpose"] !== "dead-isolated-epoch-successor-v1")
        fail("Original dead-successor approval required");
    const audit = node_path_1.default.join(root, "epoch-successions", api.hash(requestId));
    files.directory(audit);
    const read = (file) => object(api.readJson(file));
    const ref = (file) => lineage.reference(file);
    const intentFile = node_path_1.default.join(audit, "intent.json"), intent = read(intentFile);
    const approved = object(intent["approval"]), tokenHash = api.hash(client.auth.clientToken);
    // Relocated recovery copies are accepted only when the approved bytes are identical.
    if (intent["clientId"] !== client.auth.clientId ||
        intent["ownerTokenHash"] !== tokenHash ||
        approval["clientId"] !== client.auth.clientId ||
        read(node_path_1.default.join(root, "clients.json"))[client.auth.clientId] !== tokenHash ||
        files.fileHash(approvalFile).sha256 !== approved["sha256"])
        fail("Original existing credential-bound owner and exact approval bytes required");
    const abortDir = node_path_1.default.join(audit, "abort-unstarted"), completeFile = node_path_1.default.join(abortDir, "complete.json");
    if (node_fs_1.default.existsSync(completeFile)) {
        const complete = read(completeFile), original = read(node_path_1.default.join(abortDir, "intent.json"));
        if (complete["kind"] !== "dead-epoch-successor-aborted-before-sdk" ||
            complete["status"] !== "aborted" ||
            complete["requestId"] !== requestId ||
            complete["clientId"] !== client.auth.clientId ||
            !(0, node_util_1.isDeepStrictEqual)(complete["approval"], approved) ||
            !(0, node_util_1.isDeepStrictEqual)(complete["facts"], original["facts"]) ||
            complete["reason"] !== original["reason"] ||
            complete["sdkRequestsSent"] !== 0 ||
            complete["historicalOutcome"] !== "unknown")
            fail("Original abort receipt changed");
        for (const entry of complete["facts"]) {
            const proof = object(entry);
            if (files.fileHash(text(proof["path"])).sha256 !== proof["sha256"])
                fail("Abort evidence changed");
        }
        return complete; // Original terminal receipt only, even after a later handoff.
    }
    const authorityFile = node_path_1.default.join(audit, "authority.json"), entry = ref(authorityFile), authority = read(authorityFile);
    const { pointer } = lineage.successionAuthority(root, entry);
    for (const key of [
        "requestId",
        "clientId",
        "previousOwner",
        "previousBuildHash",
        "candidateRoot",
        "sourceCommit",
        "buildHash",
        "expectedProcess",
    ])
        if (!(0, node_util_1.isDeepStrictEqual)(authority[key], approval[key]))
            fail("Original authority differs from the approved startup");
    const predecessor = object(authority["predecessor"]);
    if (predecessor["epochId"] !== approval["predecessorEpochId"] ||
        object(predecessor["pointer"])["sha256"] !== approval["pointerHash"] ||
        object(predecessor["state"])["sha256"] !== approval["stateHash"] ||
        object(predecessor["rootState"])["sha256"] !== approval["rootStateHash"] ||
        object(predecessor["rootIdentity"])["sha256"] !==
            approval["rootIdentityHash"] ||
        object(authority["qualification"])["sha256"] !==
            object(approval["qualification"])["sha256"])
        fail("Original predecessor or qualification differs from the approval");
    if (!(0, node_util_1.isDeepStrictEqual)(read(node_path_1.default.join(root, "isolated-admission-epoch.json")), pointer) ||
        authority["kind"] !== "owner-authenticated-dead-epoch-successor" ||
        authority["nonce"] !== intent["nonce"] ||
        authority["clientId"] !== client.auth.clientId ||
        authority["ownerTokenHash"] !== tokenHash ||
        authority["requestId"] !== requestId ||
        api.priorProcessAlive(pointer["currentInstance"]) !== false ||
        api.priorProcessAlive(pointer["originalInstance"]) !== false ||
        api.priorProcessAlive(authority["expectedProcess"]) === null)
        fail("Unchanged predecessor and original dead-process authority required");
    const guard = {
        kind: "dead-epoch-successor",
        nonce: intent["nonce"],
        audit,
        clientId: client.auth.clientId,
    };
    const previousFile = node_path_1.default.join(audit, "previous-active-succession.json");
    const previous = node_fs_1.default.existsSync(previousFile) ? read(previousFile) : null;
    if (!(0, node_util_1.isDeepStrictEqual)(previous?.["authority"], pointer["succession"]) ||
        !(0, node_util_1.isDeepStrictEqual)(read(node_path_1.default.join(audit, "launch-intent.json")), {
            nonce: intent["nonce"],
            authority: entry,
        }))
        fail("Exact previous authority and original launch required");
    const workerFile = node_path_1.default.join(audit, "worker-claim.json"), worker = read(workerFile);
    // A ready metadata worker is NOT an unstarted/rejected startup. Its one
    // terminal local observation rejection needs a separate, explicit proof.
    if (node_fs_1.default.existsSync(node_path_1.default.join(audit, "worker-ready.json"))) {
        const reason = "metadata-ready-observation-rejected-before-sdk";
        const readyFile = node_path_1.default.join(audit, "worker-ready.json"), ready = read(readyFile);
        const metadataFile = node_path_1.default.join(audit, "complete.json"), metadata = read(metadataFile);
        const owner = object(ready["owner"]);
        const workerAlive = api.priorProcessAlive(worker);
        if (worker["nonce"] !== intent["nonce"] ||
            ready["nonce"] !== intent["nonce"] ||
            owner["pid"] !== worker["pid"] ||
            owner["birth"] !== worker["birth"] ||
            owner["protocol"] !== 2 ||
            ready["buildHash"] !== authority["buildHash"] ||
            ready["sdkRequestsSent"] !== 0 ||
            workerAlive === null ||
            metadata["kind"] !== "dead-epoch-successor-metadata-ready" ||
            metadata["requestId"] !== requestId ||
            !(0, node_util_1.isDeepStrictEqual)(metadata["authority"], entry) ||
            !(0, node_util_1.isDeepStrictEqual)(metadata["owner"], owner) ||
            metadata["sdkRequestsSent"] !== 0 ||
            metadata["buildHash"] !== authority["buildHash"] ||
            metadata["sourceCommit"] !== authority["sourceCommit"] ||
            metadata["historicalOutcome"] !== "unknown" ||
            metadata["modelingAdmission"] !==
                "blocked-until-current-facts-and-proven-new-scratch")
            fail("Exact SDK0 metadata-ready worker and original completion required");
        const allowed = new Set([
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
            "abort-unstarted",
        ]);
        if (node_fs_1.default.readdirSync(audit).some((name) => !allowed.has(name)))
            fail("Unexpected SDK, scratch, pending or startup evidence forbids metadata-ready retirement");
        const observation = node_path_1.default.join(audit, "dead-epoch-current-observation");
        files.directory(observation);
        if (!(0, node_util_1.isDeepStrictEqual)(node_fs_1.default.readdirSync(observation).sort(), ["intent.json", "result.json"]))
            fail("Only an observation intent and terminal local rejection may exist");
        const observationIntentFile = node_path_1.default.join(observation, "intent.json"), observationIntent = read(observationIntentFile);
        const resultFile = node_path_1.default.join(observation, "result.json"), result = read(resultFile);
        const jobs = pointer["quarantinedJobIds"];
        if (!Array.isArray(jobs) || jobs.length < 2)
            fail("Original holder and observer required");
        const key = {
            jobId: jobs[0],
            observationJobId: jobs[1],
            requestId: requestId + ":observe",
            clientId: client.auth.clientId,
        };
        if (observationIntent["version"] !== 1 ||
            !(0, node_util_1.isDeepStrictEqual)(observationIntent["key"], key) ||
            !(0, node_util_1.isDeepStrictEqual)(observationIntent["binding"], {
                purpose: "atomic-recovery-audit-v1",
                clientId: client.auth.clientId,
                expectedProcess: authority["expectedProcess"],
                successorAuthorityHash: entry.sha256,
            }) ||
            !/^[a-f0-9]{64}$/.test(String(observationIntent["sourceSha256"])) ||
            !/^[a-f0-9]{64}$/.test(String(observationIntent["sourceArtifactHash"])) ||
            !(0, node_util_1.isDeepStrictEqual)(result, {
                kind: "dead-epoch-current-observation",
                ...key,
                status: "failed",
                code: "AUDIT_REQUEST_INVALID",
                sdkRequestsSent: 0,
                nativeOutcome: "unknown",
                modelValidation: "not_performed",
                rollbackVerification: "not_performed",
            }))
            fail("Exact original terminal AUDIT_REQUEST_INVALID observation with SDK0 required");
        const lifecycleFile = node_path_1.default.join(root, "broker-lifecycle-" + text(owner["nonce"]) + ".json");
        const lifecycle = read(lifecycleFile);
        if (!(0, node_util_1.isDeepStrictEqual)(lifecycle["owner"], owner) ||
            lifecycle["stage"] !== "ready" ||
            lifecycle["buildHash"] !== authority["buildHash"] ||
            lifecycle["configHash"] !== authority["configHash"] ||
            node_fs_1.default
                .readdirSync(root)
                .some((name) => name.startsWith("broker-startup-" + text(owner["nonce"]))) ||
            [root, text(pointer["root"])].some((dir) => node_fs_1.default.existsSync(node_path_1.default.join(dir, "queue-state.pending.json"))))
            fail("Metadata-only lifecycle without any startup SDK or pending state required");
        const released = [];
        for (const name of ["recovery.lock", "atomic-migration.lock"]) {
            const releasedFile = node_path_1.default.join(audit, "released-" + name + ".json");
            if (node_fs_1.default.existsSync(node_path_1.default.join(root, name)) ||
                !(0, node_util_1.isDeepStrictEqual)(read(releasedFile), guard))
                fail("Exact already-released successor guards and no live guards required");
            released.push(releasedFile);
        }
        const retiredFile = node_path_1.default.join(audit, "retired-owner.json"), retired = read(retiredFile);
        if (!(0, node_util_1.isDeepStrictEqual)(retired, intent["previousOwner"]) ||
            !(0, node_util_1.isDeepStrictEqual)(retired, authority["previousOwner"]) ||
            api.priorProcessAlive(retired) !== false)
            fail("Exact escrowed dead predecessor marker required");
        const continuing = node_fs_1.default.existsSync(node_path_1.default.join(abortDir, "intent.json"));
        const activeFile = node_path_1.default.join(root, "active-epoch-succession.json");
        const active = node_fs_1.default.existsSync(activeFile) ? read(activeFile) : null;
        if (!(0, node_util_1.isDeepStrictEqual)(active, { version: 1, authority: entry }) &&
            !(continuing && (0, node_util_1.isDeepStrictEqual)(active, previous)))
            fail("Active authority changed before metadata-ready retirement");
        const markerFile = node_path_1.default.join(root, "broker.lock"), marker = node_fs_1.default.existsSync(markerFile) ? read(markerFile) : null;
        const retirementFile = node_path_1.default.join(abortDir, "retirement-after.json");
        const retiredMetadataMarker = workerAlive === false &&
            (0, node_util_1.isDeepStrictEqual)(marker, owner) &&
            node_fs_1.default.existsSync(retirementFile);
        const retirementFacts = [];
        if (node_fs_1.default.existsSync(retirementFile)) {
            const after = read(retirementFile), beforeFile = node_path_1.default.join(abortDir, "retirement-before.json"), startFile = node_path_1.default.join(abortDir, "retirement-effect-start.json");
            if (after["kind"] !== "metadata-worker-retirement-complete" ||
                after["requestId"] !== requestId ||
                after["clientId"] !== client.auth.clientId ||
                !(0, node_util_1.isDeepStrictEqual)(after["owner"], owner) ||
                after["retired"] !== true ||
                after["sdkRequestsSent"] !== 0 ||
                after["protectedBytesUnchanged"] !== true ||
                after["historicalOutcome"] !== "unknown" ||
                !(0, node_util_1.isDeepStrictEqual)(after["before"], ref(beforeFile)) ||
                !(0, node_util_1.isDeepStrictEqual)(after["effectStart"], ref(startFile)))
                fail("Exact completed metadata-only retirement proof required before marker restoration");
            retirementFacts.push(retirementFile, beforeFile, startFile);
        }
        if (workerAlive
            ? !(0, node_util_1.isDeepStrictEqual)(marker, owner)
            : marker !== null &&
                !retiredMetadataMarker &&
                !(!apply && retirementInspection && (0, node_util_1.isDeepStrictEqual)(marker, owner)) &&
                !(continuing && (0, node_util_1.isDeepStrictEqual)(marker, retired)))
            fail("Exact live worker marker or proven graceful marker release required");
        const facts = [
            intentFile,
            authorityFile,
            workerFile,
            readyFile,
            metadataFile,
            lifecycleFile,
            observationIntentFile,
            resultFile,
            retiredFile,
            ...released,
            ...(previous ? [previousFile] : []),
            ...retirementFacts,
        ].map(ref);
        if (!apply)
            return {
                ready: true,
                requestId,
                reason,
                sdkRequestsSent: 0,
                requiresWorkerRetirement: workerAlive,
                retirementPerformed: false,
                applyReady: !workerAlive,
                worker: owner,
                facts,
            };
        if (workerAlive !== false)
            fail("Exact metadata worker must be proven dead through a separately authorized retirement before apply");
        if (retiredMetadataMarker) {
            files.exclusive(node_path_1.default.join(abortDir, "retired-metadata-owner.json"), owner);
            if (!(0, node_util_1.isDeepStrictEqual)(read(markerFile), owner) ||
                api.priorProcessAlive(worker) !== false)
                fail("Metadata process identity changed before marker retirement");
            node_fs_1.default.unlinkSync(markerFile);
        }
        const abortIntent = {
            version: 1,
            kind: "abort-sdk-not-started-dead-successor",
            reason,
            clientId: client.auth.clientId,
            approval: approved,
            facts,
            guard,
        };
        node_fs_1.default.mkdirSync(abortDir, { recursive: true, mode: 0o700 });
        files.directory(abortDir);
        files.exclusive(node_path_1.default.join(abortDir, "intent.json"), abortIntent);
        files.exclusive(node_path_1.default.join(abortDir, "active-before.json"), {
            version: 1,
            authority: entry,
        });
        if (previous)
            api.durable(activeFile, previous);
        else if (node_fs_1.default.existsSync(activeFile))
            node_fs_1.default.unlinkSync(activeFile);
        if (!node_fs_1.default.existsSync(markerFile))
            api.durable(markerFile, retired, true);
        else if (!(0, node_util_1.isDeepStrictEqual)(read(markerFile), retired))
            fail("Restored marker changed");
        const fd = node_fs_1.default.openSync(root, "r");
        try {
            node_fs_1.default.fsyncSync(fd);
        }
        finally {
            node_fs_1.default.closeSync(fd);
        }
        const complete = {
            version: 1,
            kind: "dead-epoch-successor-aborted-before-sdk",
            reason,
            status: "aborted",
            requestId,
            clientId: client.auth.clientId,
            approval: approved,
            facts,
            sdkRequestsSent: 0,
            historicalOutcome: "unknown",
            modelValidation: "not_performed",
        };
        files.exclusive(completeFile, complete);
        return complete;
    }
    const errorFile = node_path_1.default.join(audit, "worker-error.json");
    if (worker["nonce"] !== intent["nonce"] ||
        api.priorProcessAlive(worker) !== false ||
        !(0, node_util_1.isDeepStrictEqual)(read(errorFile), { nonce: intent["nonce"], code: "INSTANCE_CHANGED" }))
        fail("Exact proven-dead rejected worker required");
    const lifecycles = node_fs_1.default
        .readdirSync(root)
        .filter((name) => /^broker-lifecycle-.*\.json$/.test(name))
        .map((name) => node_path_1.default.join(root, name))
        .filter((file) => {
        const owner = object(read(file)["owner"]);
        return (owner["pid"] === worker["pid"] && owner["birth"] === worker["birth"]);
    });
    if (lifecycles.length !== 1)
        fail("Unique rejected worker lifecycle required");
    const lifecycleFile = lifecycles[0], lifecycle = read(lifecycleFile), owner = object(lifecycle["owner"]);
    const prefix = "broker-startup-" + text(owner["nonce"]);
    if (lifecycle["stage"] !== "rejected" ||
        lifecycle["safeToRecover"] !== true ||
        lifecycle["code"] !== "INSTANCE_CHANGED" ||
        lifecycle["buildHash"] !== authority["buildHash"] ||
        lifecycle["configHash"] !== authority["configHash"] ||
        lifecycle["receipt"] !== node_path_1.default.join(root, prefix + ".receipt.json") ||
        !(0, node_util_1.isDeepStrictEqual)(lifecycle["binding"], {
            brokerNonce: owner["nonce"],
            ownerPid: worker["pid"],
            ownerBirth: worker["birth"],
            buildHash: authority["buildHash"],
            stage: "startup",
        }) ||
        node_fs_1.default.readdirSync(root).some((name) => name.startsWith(prefix)))
        fail("Terminal local rejection without any startup probe evidence required");
    for (const name of [
        "worker-ready.json",
        "complete.json",
        "observed-current.json",
        "dead-epoch-current-observation",
        "isolated-scratch-qualification",
        "isolated-scratch-close",
    ])
        if (node_fs_1.default.existsSync(node_path_1.default.join(audit, name)))
            fail("Ready, SDK or scratch evidence forbids abort");
    const retiredFile = node_path_1.default.join(audit, "retired-owner.json"), retired = read(retiredFile);
    if (!(0, node_util_1.isDeepStrictEqual)(retired, intent["previousOwner"]) ||
        !(0, node_util_1.isDeepStrictEqual)(retired, authority["previousOwner"]) ||
        api.priorProcessAlive(retired) !== false)
        fail("Exact escrowed dead predecessor marker required");
    const continuing = node_fs_1.default.existsSync(node_path_1.default.join(abortDir, "intent.json"));
    const activeFile = node_path_1.default.join(root, "active-epoch-succession.json");
    const active = node_fs_1.default.existsSync(activeFile) ? read(activeFile) : null;
    if (!(0, node_util_1.isDeepStrictEqual)(active, { version: 1, authority: entry }) &&
        !(continuing && (0, node_util_1.isDeepStrictEqual)(active, previous)))
        fail("Active authority changed");
    const markerFile = node_path_1.default.join(root, "broker.lock");
    if (node_fs_1.default.existsSync(markerFile) &&
        !(continuing && (0, node_util_1.isDeepStrictEqual)(read(markerFile), retired)))
        fail("A broker marker prevents abort");
    for (const name of ["recovery.lock", "atomic-migration.lock"]) {
        const file = node_path_1.default.join(root, name), released = node_path_1.default.join(abortDir, "released-" + name + ".json");
        if (node_fs_1.default.existsSync(file)
            ? !(0, node_util_1.isDeepStrictEqual)(read(file), guard)
            : !(continuing &&
                node_fs_1.default.existsSync(released) &&
                (0, node_util_1.isDeepStrictEqual)(read(released), guard)))
            fail("Original recovery guards changed");
    }
    const facts = [
        intentFile,
        authorityFile,
        workerFile,
        errorFile,
        lifecycleFile,
        retiredFile,
        ...(previous ? [previousFile] : []),
    ].map(ref);
    const abortIntent = {
        version: 1,
        kind: "abort-unstarted-dead-successor",
        clientId: client.auth.clientId,
        approval: approved,
        facts,
        guard,
    };
    if (!apply)
        return { ready: true, requestId, sdkRequestsSent: 0, facts };
    node_fs_1.default.mkdirSync(abortDir, { recursive: true, mode: 0o700 });
    files.directory(abortDir);
    files.exclusive(node_path_1.default.join(abortDir, "intent.json"), abortIntent);
    files.exclusive(node_path_1.default.join(abortDir, "active-before.json"), {
        version: 1,
        authority: entry,
    });
    if (previous)
        api.durable(activeFile, previous);
    else if (node_fs_1.default.existsSync(activeFile))
        node_fs_1.default.unlinkSync(activeFile);
    if (!node_fs_1.default.existsSync(markerFile))
        api.durable(markerFile, retired, true);
    else if (!(0, node_util_1.isDeepStrictEqual)(read(markerFile), retired))
        fail("Restored marker changed");
    for (const name of ["atomic-migration.lock", "recovery.lock"]) {
        const file = node_path_1.default.join(root, name);
        files.exclusive(node_path_1.default.join(abortDir, "released-" + name + ".json"), guard);
        if (node_fs_1.default.existsSync(file)) {
            if (!(0, node_util_1.isDeepStrictEqual)(read(file), guard))
                fail("Guard changed during abort");
            node_fs_1.default.unlinkSync(file);
        }
        const fd = node_fs_1.default.openSync(root, "r");
        try {
            node_fs_1.default.fsyncSync(fd);
        }
        finally {
            node_fs_1.default.closeSync(fd);
        }
    }
    const complete = {
        version: 1,
        kind: "dead-epoch-successor-aborted-before-sdk",
        status: "aborted",
        requestId,
        clientId: client.auth.clientId,
        approval: approved,
        facts,
        sdkRequestsSent: 0,
        historicalOutcome: "unknown",
        modelValidation: "not_performed",
    };
    files.exclusive(completeFile, complete);
    return complete;
}
/** Separate, explicitly authorized OS retirement. Never calls SDK, rewrites a
 * runtime, sends SIGTERM, clears a historical job or replays an uncertain signal.
 * Ports are replaceable ONLY by direct offline tests, never by CLI/config. */
async function retireMetadataWorker(client, approvalFile, proofFile, apply, ports = linuxRetirementPorts) {
    const approval = object(JSON.parse(node_fs_1.default.readFileSync(approvalFile, "utf8")));
    const runtime = text(approval["candidateRoot"]), load = (0, node_module_1.createRequire)(node_path_1.default.join(runtime, "src/queue-instance.js"));
    const api = load("./queue-instance");
    const files = load("./queue-atomic-migration-files");
    const ref = (file) => {
        if (node_fs_1.default.realpathSync(file) !== file || !node_fs_1.default.lstatSync(file).isFile())
            fail("Canonical regular retirement evidence required");
        return { path: file, sha256: api.hash(node_fs_1.default.readFileSync(file)) };
    };
    const proofRef = ref(node_fs_1.default.realpathSync(proofFile)), proof = object(JSON.parse(node_fs_1.default.readFileSync(proofRef.path, "utf8")));
    const owner = object(proof["worker"]), fusion = object(proof["fusion"]);
    const root = node_fs_1.default.realpathSync(client.dir), requestId = text(approval["requestId"]);
    const audit = node_path_1.default.join(root, "epoch-successions", api.hash(requestId)), dir = node_path_1.default.join(audit, "abort-unstarted");
    const beforeFile = node_path_1.default.join(dir, "retirement-before.json"), startFile = node_path_1.default.join(dir, "retirement-effect-start.json"), afterFile = node_path_1.default.join(dir, "retirement-after.json");
    // Authenticated existing-owner preview is also required for an idempotent read.
    const preview = object(abortUnstartedSuccessor(client, approvalFile, false, {
        retirementInspection: true,
    }));
    if (proof["kind"] !== "metadata-worker-retirement-proof-v1" ||
        proof["qualified"] !== true ||
        !(0, node_util_1.isDeepStrictEqual)(proof["proofGaps"], []) ||
        proof["runtimeRoot"] !== runtime ||
        proof["requestId"] !== requestId ||
        proof["buildHash"] !== approval["buildHash"] ||
        proof["sourceCommit"] !== approval["sourceCommit"] ||
        proof["epochId"] !== approval["predecessorEpochId"] ||
        !(0, node_util_1.isDeepStrictEqual)({ pid: fusion["pid"], birth: fusion["birth"] }, approval["expectedProcess"]) ||
        typeof fusion["version"] !== "string")
        fail("Exact independent whole-process closure proof and original approval required");
    ports.certify(proof);
    if (node_fs_1.default.existsSync(afterFile)) {
        const after = object(api.readJson(afterFile));
        if (!(0, node_util_1.isDeepStrictEqual)(after["proof"], proofRef) ||
            after["requestId"] !== requestId ||
            after["retired"] !== true ||
            after["sdkRequestsSent"] !== 0 ||
            after["historicalOutcome"] !== "unknown")
            fail("Original retirement receipt changed");
        return after; // Historical effect receipt only, never another signal.
    }
    const references = [proofRef];
    for (const key of ["protectedFiles", "sourceFiles", "evidenceFiles"]) {
        const entries = proof[key];
        if (!Array.isArray(entries) || !entries.length)
            fail("Complete independent process/source/history manifest required");
        for (const value of entries) {
            const entry = object(value), pinned = { path: text(entry["path"]), sha256: text(entry["sha256"]) };
            if (!(0, node_util_1.isDeepStrictEqual)(ref(pinned.path), pinned))
                fail("Independent retirement proof is stale or tampered");
            references.push(pinned);
        }
    }
    const osProofRef = references.find((entry) => node_path_1.default.basename(entry.path) === "os-after.json");
    if (!osProofRef)
        fail("Independent exact executable/command-line OS proof required");
    const expectedOS = object(api.readJson(osProofRef.path));
    const executable = text(expectedOS["exe"]);
    references.push({ path: executable, sha256: text(expectedOS["exeSha256"]) });
    const processIdentity = (value) => ({
        pid: value["pid"],
        birth: value["birth"],
        exe: value["exe"],
        exeSha256: value["exeSha256"],
        cmdline: value["cmdline"],
    });
    const ready = object(api.readJson(node_path_1.default.join(audit, "worker-ready.json")));
    const claim = object(api.readJson(node_path_1.default.join(audit, "worker-claim.json")));
    if (!(0, node_util_1.isDeepStrictEqual)(ready["owner"], owner) ||
        proof["workerClaimNonce"] !== claim["nonce"] ||
        owner["pid"] !== claim["pid"] ||
        owner["birth"] !== claim["birth"])
        fail("Certified process is not the exact original metadata worker");
    const verifyRefs = () => {
        for (const entry of references)
            if (!(0, node_util_1.isDeepStrictEqual)(ref(entry.path), entry))
                fail("Retirement evidence changed before/after effect");
    };
    const fusionRead = () => {
        const current = ports.fusion(fusion);
        if (current["pid"] !== fusion["pid"] ||
            current["birth"] !== fusion["birth"] ||
            current["version"] !== fusion["version"] ||
            current["hasExited"] !== false ||
            current["responding"] !== true)
            fail("Fresh Fusion OS process identity changed or is unproven");
        return current;
    };
    const completeAfter = () => {
        if (api.priorProcessAlive(owner) !== false)
            fail("Retirement outcome pending; never repeat a signal");
        verifyRefs();
        const afterFusion = fusionRead();
        const after = {
            version: 1,
            kind: "metadata-worker-retirement-complete",
            requestId,
            clientId: client.auth.clientId,
            proof: proofRef,
            before: ref(beforeFile),
            effectStart: ref(startFile),
            owner,
            retired: true,
            mechanism: "pidfd_send_signal:SIGKILL",
            gracefulClose: false,
            fusion: afterFusion,
            protectedBytesUnchanged: true,
            sdkRequestsSent: 0,
            historicalOutcome: "unknown",
        };
        files.exclusive(afterFile, after);
        return after;
    };
    if (node_fs_1.default.existsSync(startFile)) {
        const start = object(api.readJson(startFile));
        if (!(0, node_util_1.isDeepStrictEqual)(start["proof"], proofRef) ||
            !(0, node_util_1.isDeepStrictEqual)(start["owner"], owner) ||
            !(0, node_util_1.isDeepStrictEqual)(start["before"], ref(beforeFile)))
            fail("Original pending retirement effect changed");
        if (!apply)
            return {
                ready: false,
                retirementPending: true,
                noSignalReplay: true,
                requestId,
            };
        return completeAfter(); // Death + fresh Fusion proof only; NEVER another send.
    }
    if (preview["reason"] !== "metadata-ready-observation-rejected-before-sdk" ||
        !(0, node_util_1.isDeepStrictEqual)(preview["worker"], owner))
        fail("Only the certified SDK-not-started metadata attempt can be retired");
    const snapshot = async () => {
        abortUnstartedSuccessor(client, approvalFile, false);
        ports.certify(proof);
        verifyRefs();
        const status = object(await client.call("queue-summary")), control = object(await client.call("control-status"));
        const successor = object(status["deadEpochSuccessor"]), features = object(status["features"]);
        if (status["buildHash"] !== proof["buildHash"] ||
            status["sourceCommit"] !== proof["sourceCommit"] ||
            status["admissionEpoch"] !== proof["epochId"] ||
            status["held"] !==
                "Qualified isolated scratch process is unavailable; metadata only, no SDK or replacement authority" ||
            status["stopping"] !== false ||
            successor["requestId"] !== requestId ||
            successor["currentFactsAvailable"] !== false ||
            !(0, node_util_1.isDeepStrictEqual)(successor["expectedProcess"], approval["expectedProcess"]) ||
            control["instanceId"] !== owner["nonce"] ||
            control["buildHash"] !== proof["buildHash"] ||
            control["activeOperations"] !== 0 ||
            !(0, node_util_1.isDeepStrictEqual)(control["activeIds"], []) ||
            control["unresolved"] !== true ||
            control["phase"] !== "RECOVERY_BLOCKED" ||
            features["auditFactsCapture"] !== false ||
            features["atomicRecoveryProcessLossAudit"] !== false)
            fail("Certified metadata-only dispatch closure or current quiescence changed");
        const process = object(ports.process(owner, runtime, references, false, root)["process"]);
        if (!(0, node_util_1.isDeepStrictEqual)(processIdentity(process), processIdentity(expectedOS)))
            fail("Independent executable/birth/command-line proof differs from the current process");
        const liveFusion = fusionRead();
        verifyRefs();
        return { status, control, process, fusion: liveFusion };
    };
    const first = await snapshot();
    if (!apply)
        return {
            ready: true,
            requestId,
            retirementPerformed: false,
            mechanism: "pidfd_send_signal:SIGKILL",
            gracefulClose: false,
            proof: proofRef,
            owner,
            snapshot: first,
            sdkRequestsSent: 0,
        };
    node_fs_1.default.mkdirSync(dir, { recursive: true, mode: 0o700 });
    files.directory(dir);
    const before = {
        version: 1,
        kind: "metadata-worker-retirement-before",
        requestId,
        clientId: client.auth.clientId,
        approval: ref(node_fs_1.default.realpathSync(approvalFile)),
        proof: proofRef,
        owner,
        snapshot: first,
        references,
    };
    if (node_fs_1.default.existsSync(beforeFile)) {
        const original = object(api.readJson(beforeFile));
        if (!(0, node_util_1.isDeepStrictEqual)(original["proof"], proofRef) ||
            !(0, node_util_1.isDeepStrictEqual)(original["owner"], owner) ||
            !(0, node_util_1.isDeepStrictEqual)(original["references"], references))
            fail("Original retirement-before proof changed");
    }
    else
        files.exclusive(beforeFile, before);
    const second = await snapshot();
    if (!(0, node_util_1.isDeepStrictEqual)(first.status, second.status) ||
        !(0, node_util_1.isDeepStrictEqual)(first.control, second.control) ||
        !(0, node_util_1.isDeepStrictEqual)(first.process, second.process))
        fail("Process, status or quiescence changed during retirement preparation");
    const effectStart = {
        version: 1,
        kind: "metadata-worker-retirement-effect-start",
        requestId,
        proof: proofRef,
        before: ref(beforeFile),
        owner,
        mechanism: "pidfd_send_signal:SIGKILL",
        gracefulClose: false,
    };
    files.exclusive(startFile, effectStart); // From here any interrupted outcome is UNKNOWN, not a retry license.
    verifyRefs();
    ports.process({ ...owner, processProof: second.process }, runtime, [...references, ref(beforeFile), ref(startFile)], true, root);
    return completeAfter();
}
if (require.main === module) {
    void (async () => {
        try {
            const args = process.argv.slice(2);
            const retirement = args.length === 6 &&
                args[2] === "--retirement-proof" &&
                ["--preflight-retirement", "--confirm-retire-metadata-worker"].includes(args[4]) &&
                args[5] === "true";
            if (args[0] !== "--approval" ||
                !(retirement ||
                    (args.length === 4 &&
                        ["--confirm-abort", "--preflight"].includes(args[2]) &&
                        args[3] === "true")))
                fail("Use --approval FILE with --preflight true / --confirm-abort true, or --retirement-proof FILE --preflight-retirement true / --confirm-retire-metadata-worker true; no client/root overrides");
            const file = node_fs_1.default.realpathSync(args[1]), approval = object(JSON.parse(node_fs_1.default.readFileSync(file, "utf8")));
            const load = (0, node_module_1.createRequire)(node_path_1.default.join(text(approval["candidateRoot"]), "src/queue-client.js"));
            const { QueueClient } = load("./queue-client");
            const client = new QueueClient(undefined, {
                existingCredentialsOnly: true,
            });
            try {
                console.log(JSON.stringify(retirement
                    ? await retireMetadataWorker(client, file, node_fs_1.default.realpathSync(args[3]), args[4] === "--confirm-retire-metadata-worker")
                    : abortUnstartedSuccessor(client, file, args[2] === "--confirm-abort"), null, 2));
            }
            finally {
                client.dispose();
            }
        }
        catch (error) {
            console.error(error);
            process.exitCode = 1;
        }
    })();
}

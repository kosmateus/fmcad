#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.abortUnstartedSuccessor = abortUnstartedSuccessor;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_module_1 = require("node:module");
const node_util_1 = require("node:util");
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
function abortUnstartedSuccessor(client, approvalFile, apply) {
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
if (require.main === module) {
    try {
        const args = process.argv.slice(2);
        if (args.length !== 4 ||
            args[0] !== "--approval" ||
            !["--confirm-abort", "--preflight"].includes(args[2]) ||
            args[3] !== "true")
            fail("Use --approval FILE and --preflight true or --confirm-abort true; no client/root overrides");
        const file = node_fs_1.default.realpathSync(args[1]), approval = object(JSON.parse(node_fs_1.default.readFileSync(file, "utf8")));
        const load = (0, node_module_1.createRequire)(node_path_1.default.join(text(approval["candidateRoot"]), "src/queue-client.js"));
        const { QueueClient } = load("./queue-client");
        const client = new QueueClient(undefined, {
            existingCredentialsOnly: true,
        });
        try {
            console.log(JSON.stringify(abortUnstartedSuccessor(client, file, args[2] === "--confirm-abort"), null, 2));
        }
        finally {
            client.dispose();
        }
    }
    catch (error) {
        console.error(error);
        process.exitCode = 1;
    }
}

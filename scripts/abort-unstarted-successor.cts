#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { isDeepStrictEqual as same } from "node:util";

type Data = Record<string, unknown>;
interface Client {
  dir: string;
  auth: { clientId: string; clientToken: string };
}
interface Api {
  readJson(file: string): unknown;
  hash(value: string | Uint8Array): string;
  durable(file: string, value: unknown, exclusive?: boolean): void;
  priorProcessAlive(value: unknown): boolean | null;
}
function fail(message: string): never {
  throw Object.assign(new Error(message), { code: "SUCCESSOR_ABORT_UNPROVEN" });
}
function object(value: unknown): Data {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("Object-shaped original evidence required");
  return value as Data;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value)
    fail("Exact original identity required");
  return value;
}

/** Owner-only metadata recovery; never launches a worker or calls Fusion. */
export function abortUnstartedSuccessor(
  client: Client,
  approvalFile: string,
  apply: boolean,
) {
  const approval = object(
    JSON.parse(fs.readFileSync(approvalFile, "utf8")) as unknown,
  );
  const runtime = text(approval["candidateRoot"]);
  if (!path.isAbsolute(runtime) || fs.realpathSync(runtime) !== runtime)
    fail("Canonical original runtime required");
  const load = createRequire(path.join(runtime, "src/queue-instance.js"));
  const api = load("./queue-instance") as Api;
  const files = load("./queue-atomic-migration-files") as {
    directory(dir: string): void;
    fileHash(file: string): { sha256: string };
    exclusive(file: string, value: unknown): unknown;
  };
  const lineage = load("./queue-epoch-lineage") as {
    reference(file: string): { path: string; sha256: string };
    successionAuthority(root: string, entry: unknown): { pointer: Data };
  };
  const root = fs.realpathSync(client.dir);
  files.directory(root);
  const requestId = text(approval["requestId"]);
  if (
    requestId.length > 160 ||
    approval["purpose"] !== "dead-isolated-epoch-successor-v1"
  )
    fail("Original dead-successor approval required");
  const audit = path.join(root, "epoch-successions", api.hash(requestId));
  files.directory(audit);
  const read = (file: string) => object(api.readJson(file));
  const ref = (file: string) => lineage.reference(file);
  const intentFile = path.join(audit, "intent.json"),
    intent = read(intentFile);
  const approved = object(intent["approval"]),
    tokenHash = api.hash(client.auth.clientToken);
  // Relocated recovery copies are accepted only when the approved bytes are identical.
  if (
    intent["clientId"] !== client.auth.clientId ||
    intent["ownerTokenHash"] !== tokenHash ||
    approval["clientId"] !== client.auth.clientId ||
    read(path.join(root, "clients.json"))[client.auth.clientId] !== tokenHash ||
    files.fileHash(approvalFile).sha256 !== approved["sha256"]
  )
    fail(
      "Original existing credential-bound owner and exact approval bytes required",
    );
  const abortDir = path.join(audit, "abort-unstarted"),
    completeFile = path.join(abortDir, "complete.json");
  if (fs.existsSync(completeFile)) {
    const complete = read(completeFile),
      original = read(path.join(abortDir, "intent.json"));
    if (
      complete["kind"] !== "dead-epoch-successor-aborted-before-sdk" ||
      complete["status"] !== "aborted" ||
      complete["requestId"] !== requestId ||
      complete["clientId"] !== client.auth.clientId ||
      !same(complete["approval"], approved) ||
      !same(complete["facts"], original["facts"]) ||
      complete["reason"] !== original["reason"] ||
      complete["sdkRequestsSent"] !== 0 ||
      complete["historicalOutcome"] !== "unknown"
    )
      fail("Original abort receipt changed");
    for (const entry of complete["facts"] as unknown[]) {
      const proof = object(entry);
      if (files.fileHash(text(proof["path"])).sha256 !== proof["sha256"])
        fail("Abort evidence changed");
    }
    return complete; // Original terminal receipt only, even after a later handoff.
  }
  const authorityFile = path.join(audit, "authority.json"),
    entry = ref(authorityFile),
    authority = read(authorityFile);
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
    if (!same(authority[key], approval[key]))
      fail("Original authority differs from the approved startup");
  const predecessor = object(authority["predecessor"]);
  if (
    predecessor["epochId"] !== approval["predecessorEpochId"] ||
    object(predecessor["pointer"])["sha256"] !== approval["pointerHash"] ||
    object(predecessor["state"])["sha256"] !== approval["stateHash"] ||
    object(predecessor["rootState"])["sha256"] !== approval["rootStateHash"] ||
    object(predecessor["rootIdentity"])["sha256"] !==
      approval["rootIdentityHash"] ||
    object(authority["qualification"])["sha256"] !==
      object(approval["qualification"])["sha256"]
  )
    fail("Original predecessor or qualification differs from the approval");
  if (
    !same(read(path.join(root, "isolated-admission-epoch.json")), pointer) ||
    authority["kind"] !== "owner-authenticated-dead-epoch-successor" ||
    authority["nonce"] !== intent["nonce"] ||
    authority["clientId"] !== client.auth.clientId ||
    authority["ownerTokenHash"] !== tokenHash ||
    authority["requestId"] !== requestId ||
    api.priorProcessAlive(pointer["currentInstance"]) !== false ||
    api.priorProcessAlive(pointer["originalInstance"]) !== false ||
    api.priorProcessAlive(authority["expectedProcess"]) === null
  )
    fail("Unchanged predecessor and original dead-process authority required");
  const guard = {
    kind: "dead-epoch-successor",
    nonce: intent["nonce"],
    audit,
    clientId: client.auth.clientId,
  };
  const previousFile = path.join(audit, "previous-active-succession.json");
  const previous = fs.existsSync(previousFile) ? read(previousFile) : null;
  if (
    !same(previous?.["authority"], pointer["succession"]) ||
    !same(read(path.join(audit, "launch-intent.json")), {
      nonce: intent["nonce"],
      authority: entry,
    })
  )
    fail("Exact previous authority and original launch required");
  const workerFile = path.join(audit, "worker-claim.json"),
    worker = read(workerFile);
  // A ready metadata worker is NOT an unstarted/rejected startup. Its one
  // terminal local observation rejection needs a separate, explicit proof.
  if (fs.existsSync(path.join(audit, "worker-ready.json"))) {
    const reason = "metadata-ready-observation-rejected-before-sdk";
    const readyFile = path.join(audit, "worker-ready.json"),
      ready = read(readyFile);
    const metadataFile = path.join(audit, "complete.json"),
      metadata = read(metadataFile);
    const owner = object(ready["owner"]);
    const workerAlive = api.priorProcessAlive(worker);
    if (
      worker["nonce"] !== intent["nonce"] ||
      ready["nonce"] !== intent["nonce"] ||
      owner["pid"] !== worker["pid"] ||
      owner["birth"] !== worker["birth"] ||
      owner["protocol"] !== 2 ||
      ready["buildHash"] !== authority["buildHash"] ||
      ready["sdkRequestsSent"] !== 0 ||
      workerAlive === null ||
      metadata["kind"] !== "dead-epoch-successor-metadata-ready" ||
      metadata["requestId"] !== requestId ||
      !same(metadata["authority"], entry) ||
      !same(metadata["owner"], owner) ||
      metadata["sdkRequestsSent"] !== 0 ||
      metadata["buildHash"] !== authority["buildHash"] ||
      metadata["sourceCommit"] !== authority["sourceCommit"] ||
      metadata["historicalOutcome"] !== "unknown" ||
      metadata["modelingAdmission"] !==
        "blocked-until-current-facts-and-proven-new-scratch"
    )
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
    if (fs.readdirSync(audit).some((name) => !allowed.has(name)))
      fail(
        "Unexpected SDK, scratch, pending or startup evidence forbids metadata-ready retirement",
      );
    const observation = path.join(audit, "dead-epoch-current-observation");
    files.directory(observation);
    if (
      !same(fs.readdirSync(observation).sort(), ["intent.json", "result.json"])
    )
      fail("Only an observation intent and terminal local rejection may exist");
    const observationIntentFile = path.join(observation, "intent.json"),
      observationIntent = read(observationIntentFile);
    const resultFile = path.join(observation, "result.json"),
      result = read(resultFile);
    const jobs = pointer["quarantinedJobIds"];
    if (!Array.isArray(jobs) || jobs.length < 2)
      fail("Original holder and observer required");
    const key = {
      jobId: jobs[0],
      observationJobId: jobs[1],
      requestId: requestId + ":observe",
      clientId: client.auth.clientId,
    };
    if (
      observationIntent["version"] !== 1 ||
      !same(observationIntent["key"], key) ||
      !same(observationIntent["binding"], {
        purpose: "atomic-recovery-audit-v1",
        clientId: client.auth.clientId,
        expectedProcess: authority["expectedProcess"],
        successorAuthorityHash: entry.sha256,
      }) ||
      !/^[a-f0-9]{64}$/.test(String(observationIntent["sourceSha256"])) ||
      !/^[a-f0-9]{64}$/.test(String(observationIntent["sourceArtifactHash"])) ||
      !same(result, {
        kind: "dead-epoch-current-observation",
        ...key,
        status: "failed",
        code: "AUDIT_REQUEST_INVALID",
        sdkRequestsSent: 0,
        nativeOutcome: "unknown",
        modelValidation: "not_performed",
        rollbackVerification: "not_performed",
      })
    )
      fail(
        "Exact original terminal AUDIT_REQUEST_INVALID observation with SDK0 required",
      );
    const lifecycleFile = path.join(
      root,
      "broker-lifecycle-" + text(owner["nonce"]) + ".json",
    );
    const lifecycle = read(lifecycleFile);
    if (
      !same(lifecycle["owner"], owner) ||
      lifecycle["stage"] !== "ready" ||
      lifecycle["buildHash"] !== authority["buildHash"] ||
      lifecycle["configHash"] !== authority["configHash"] ||
      fs
        .readdirSync(root)
        .some((name) =>
          name.startsWith("broker-startup-" + text(owner["nonce"])),
        ) ||
      [root, text(pointer["root"])].some((dir) =>
        fs.existsSync(path.join(dir, "queue-state.pending.json")),
      )
    )
      fail(
        "Metadata-only lifecycle without any startup SDK or pending state required",
      );
    const released: string[] = [];
    for (const name of ["recovery.lock", "atomic-migration.lock"]) {
      const releasedFile = path.join(audit, "released-" + name + ".json");
      if (
        fs.existsSync(path.join(root, name)) ||
        !same(read(releasedFile), guard)
      )
        fail(
          "Exact already-released successor guards and no live guards required",
        );
      released.push(releasedFile);
    }
    const retiredFile = path.join(audit, "retired-owner.json"),
      retired = read(retiredFile);
    if (
      !same(retired, intent["previousOwner"]) ||
      !same(retired, authority["previousOwner"]) ||
      api.priorProcessAlive(retired) !== false
    )
      fail("Exact escrowed dead predecessor marker required");
    const continuing = fs.existsSync(path.join(abortDir, "intent.json"));
    const activeFile = path.join(root, "active-epoch-succession.json");
    const active = fs.existsSync(activeFile) ? read(activeFile) : null;
    if (
      !same(active, { version: 1, authority: entry }) &&
      !(continuing && same(active, previous))
    )
      fail("Active authority changed before metadata-ready retirement");
    const markerFile = path.join(root, "broker.lock"),
      marker = fs.existsSync(markerFile) ? read(markerFile) : null;
    if (
      workerAlive
        ? !same(marker, owner)
        : marker !== null && !(continuing && same(marker, retired))
    )
      fail(
        "Exact live worker marker or proven graceful marker release required",
      );
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
      fail(
        "Exact metadata worker must be proven dead through a separately authorized retirement before apply",
      );
    const abortIntent = {
      version: 1,
      kind: "abort-sdk-not-started-dead-successor",
      reason,
      clientId: client.auth.clientId,
      approval: approved,
      facts,
      guard,
    };
    fs.mkdirSync(abortDir, { recursive: true, mode: 0o700 });
    files.directory(abortDir);
    files.exclusive(path.join(abortDir, "intent.json"), abortIntent);
    files.exclusive(path.join(abortDir, "active-before.json"), {
      version: 1,
      authority: entry,
    });
    if (previous) api.durable(activeFile, previous);
    else if (fs.existsSync(activeFile)) fs.unlinkSync(activeFile);
    if (!fs.existsSync(markerFile)) api.durable(markerFile, retired, true);
    else if (!same(read(markerFile), retired)) fail("Restored marker changed");
    const fd = fs.openSync(root, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
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
  const errorFile = path.join(audit, "worker-error.json");
  if (
    worker["nonce"] !== intent["nonce"] ||
    api.priorProcessAlive(worker) !== false ||
    !same(read(errorFile), { nonce: intent["nonce"], code: "INSTANCE_CHANGED" })
  )
    fail("Exact proven-dead rejected worker required");
  const lifecycles = fs
    .readdirSync(root)
    .filter((name) => /^broker-lifecycle-.*\.json$/.test(name))
    .map((name) => path.join(root, name))
    .filter((file) => {
      const owner = object(read(file)["owner"]);
      return (
        owner["pid"] === worker["pid"] && owner["birth"] === worker["birth"]
      );
    });
  if (lifecycles.length !== 1)
    fail("Unique rejected worker lifecycle required");
  const lifecycleFile = lifecycles[0]!,
    lifecycle = read(lifecycleFile),
    owner = object(lifecycle["owner"]);
  const prefix = "broker-startup-" + text(owner["nonce"]);
  if (
    lifecycle["stage"] !== "rejected" ||
    lifecycle["safeToRecover"] !== true ||
    lifecycle["code"] !== "INSTANCE_CHANGED" ||
    lifecycle["buildHash"] !== authority["buildHash"] ||
    lifecycle["configHash"] !== authority["configHash"] ||
    lifecycle["receipt"] !== path.join(root, prefix + ".receipt.json") ||
    !same(lifecycle["binding"], {
      brokerNonce: owner["nonce"],
      ownerPid: worker["pid"],
      ownerBirth: worker["birth"],
      buildHash: authority["buildHash"],
      stage: "startup",
    }) ||
    fs.readdirSync(root).some((name) => name.startsWith(prefix))
  )
    fail(
      "Terminal local rejection without any startup probe evidence required",
    );
  for (const name of [
    "worker-ready.json",
    "complete.json",
    "observed-current.json",
    "dead-epoch-current-observation",
    "isolated-scratch-qualification",
    "isolated-scratch-close",
  ])
    if (fs.existsSync(path.join(audit, name)))
      fail("Ready, SDK or scratch evidence forbids abort");
  const retiredFile = path.join(audit, "retired-owner.json"),
    retired = read(retiredFile);
  if (
    !same(retired, intent["previousOwner"]) ||
    !same(retired, authority["previousOwner"]) ||
    api.priorProcessAlive(retired) !== false
  )
    fail("Exact escrowed dead predecessor marker required");
  const continuing = fs.existsSync(path.join(abortDir, "intent.json"));
  const activeFile = path.join(root, "active-epoch-succession.json");
  const active = fs.existsSync(activeFile) ? read(activeFile) : null;
  if (
    !same(active, { version: 1, authority: entry }) &&
    !(continuing && same(active, previous))
  )
    fail("Active authority changed");
  const markerFile = path.join(root, "broker.lock");
  if (
    fs.existsSync(markerFile) &&
    !(continuing && same(read(markerFile), retired))
  )
    fail("A broker marker prevents abort");
  for (const name of ["recovery.lock", "atomic-migration.lock"]) {
    const file = path.join(root, name),
      released = path.join(abortDir, "released-" + name + ".json");
    if (
      fs.existsSync(file)
        ? !same(read(file), guard)
        : !(
            continuing &&
            fs.existsSync(released) &&
            same(read(released), guard)
          )
    )
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
  if (!apply) return { ready: true, requestId, sdkRequestsSent: 0, facts };
  fs.mkdirSync(abortDir, { recursive: true, mode: 0o700 });
  files.directory(abortDir);
  files.exclusive(path.join(abortDir, "intent.json"), abortIntent);
  files.exclusive(path.join(abortDir, "active-before.json"), {
    version: 1,
    authority: entry,
  });
  if (previous) api.durable(activeFile, previous);
  else if (fs.existsSync(activeFile)) fs.unlinkSync(activeFile);
  if (!fs.existsSync(markerFile)) api.durable(markerFile, retired, true);
  else if (!same(read(markerFile), retired)) fail("Restored marker changed");
  for (const name of ["atomic-migration.lock", "recovery.lock"]) {
    const file = path.join(root, name);
    files.exclusive(path.join(abortDir, "released-" + name + ".json"), guard);
    if (fs.existsSync(file)) {
      if (!same(read(file), guard)) fail("Guard changed during abort");
      fs.unlinkSync(file);
    }
    const fd = fs.openSync(root, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
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
    if (
      args.length !== 4 ||
      args[0] !== "--approval" ||
      !["--confirm-abort", "--preflight"].includes(args[2]!) ||
      args[3] !== "true"
    )
      fail(
        "Use --approval FILE and --preflight true or --confirm-abort true; no client/root overrides",
      );
    const file = fs.realpathSync(args[1]!),
      approval = object(JSON.parse(fs.readFileSync(file, "utf8")) as unknown);
    const load = createRequire(
      path.join(text(approval["candidateRoot"]), "src/queue-client.js"),
    );
    const { QueueClient } = load("./queue-client") as {
      QueueClient: new (
        id: undefined,
        options: { existingCredentialsOnly: true },
      ) => Client & { dispose(): void };
    };
    const client = new QueueClient(undefined, {
      existingCredentialsOnly: true,
    });
    try {
      console.log(
        JSON.stringify(
          abortUnstartedSuccessor(client, file, args[2] === "--confirm-abort"),
          null,
          2,
        ),
      );
    } finally {
      client.dispose();
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

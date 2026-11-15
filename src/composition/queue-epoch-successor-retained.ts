import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { isDeepStrictEqual as same } from "node:util";
import { spawn, spawnSync } from "node:child_process";
import type { Reference, Owner } from "./queue-epoch-successor-types";
import type { RetainedAuditInput } from "../../packages/node-adapters/src/execution/recovery-audit";
type Data = Record<string, unknown>;
const anchor = path.join(__dirname, "../../queue-epoch-successor.js");
const load = createRequire(anchor);
const api = load("./queue-instance") as {
  hash(v: string | Uint8Array): string;
  buildHash(root?: string): string;
  priorProcessAlive(v: unknown): boolean | null;
};
const lineage = load(
  "./queue-epoch-lineage",
) as typeof import("../queue-epoch-lineage");
const files = load(
  "./queue-atomic-migration-files",
) as typeof import("../../packages/node-adapters/src/persistence/migration-files");
const audit = load(
  "./dist/node-adapters/execution/recovery-audit",
) as typeof import("../../packages/node-adapters/src/execution/recovery-audit");
const worker = load(
  "./dist/composition/queue-epoch-successor-retirement",
) as typeof import("./queue-epoch-successor-retirement");
const canonicalHash = (v: unknown): string =>
  (
    load(
      "./dist/core/application/cad/json",
    ) as typeof import("../../packages/core/src/application/cad/json")
  ).hash(v);
function fail(message: string): never {
  throw Object.assign(new Error(message), {
    code: "RETAINED_SUCCESSOR_UNPROVEN",
  });
}
const object = (v: unknown): Data =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Data)
    : fail("Retained successor object required");
const text = (v: unknown): string =>
  typeof v === "string" && v.length > 0
    ? v
    : fail("Retained successor identity required");
const read = (p: string): Data =>
  object(JSON.parse(fs.readFileSync(p, "utf8")) as unknown);
const ref = (p: string): Reference => {
  if (
    !path.isAbsolute(p) ||
    fs.realpathSync(p) !== p ||
    !fs.lstatSync(p).isFile()
  )
    fail("Canonical regular retained successor evidence required");
  return { path: p, sha256: api.hash(fs.readFileSync(p)) };
};
function checkedRef(v: unknown): Reference {
  const r = object(v),
    actual = ref(text(r["path"]));
  if (!same(actual, r)) fail("Retained successor evidence changed");
  return actual;
}
export interface RetainedSuccessorClient {
  dir: string;
  auth: { clientId: string; clientToken: string };
  call(action: "queue-summary"): Promise<unknown>;
}
type ProcessObservation = {
  state: "present";
  pid: number;
  birth: string;
  observedAtUtc: string;
};
export interface RetainedSuccessorPorts {
  process(expected: { pid: number; birth: string }): ProcessObservation;
  inspectWorker: typeof worker.inspectMetadataWorkerProcess;
  evaluatorRoot(): string;
  admissionFreeze(input: FreezeInput): {
    mechanism: string;
    evidence: Reference;
    cut?: DispatchCut;
  };
}
interface DispatchCut {
  files: Reference[];
  inventory: Array<{ path: string; entries: string[] }>;
  sdkRequestsSent: 1;
  allLiveSdkTerminal: true;
  selectedProcess: { pid: number; birth: string };
}
interface FreezeInput {
  owner: Owner;
  status: Data;
  authority: Reference;
  refs: Reference[];
  root: string;
  auditDirectory: string;
  runtime: string;
  sourceCommit: string;
  buildHash: string;
  configHash: string;
  expectedProcess: { pid: number; birth: string };
  auditInput: RetainedAuditInput;
}

/** Submitted journals alone cannot close the 923c unownedPost boundary. A
 * production cut requires separate source-bound coverage for every such route;
 * the isolated SDK-free test profile is not a production qualification. */
export function inspectRetainedDispatchCut(
  input: FreezeInput,
  testProfile?: { sourceCommit: string; buildHash: string; configHash: string },
): DispatchCut {
  const profile = testProfile ?? {
    sourceCommit: "923c339d3b8c85ca74e0c22511128958a97e7476",
    buildHash:
      "63a7c521b4beb0808afc12815fa3a0ff3ec6dcbd5528bb5557fe284ad5872e14",
    configHash:
      "fb8fba61d742d82c5cea76df8c8e7e235dd2bb09744685835aa4622f88dbd045",
  };
  if (
    input.sourceCommit !== profile.sourceCommit ||
    input.buildHash !== profile.buildHash ||
    input.configHash !== profile.configHash ||
    api.buildHash(input.runtime) !== input.buildHash
  )
    fail(
      "No source-bound durable-before-send producer profile for this metadata runtime",
    );
  if (!testProfile)
    fail(
      "Whole-source SDK closure is unproven: 923c unownedPost can send without an owned RPC journal. No freeze, retirement or handoff is permitted from submitted-record inventory alone",
    );
  return (
    load(
      "./dist/node-adapters/execution/retained-audit-inventory",
    ) as typeof import("../../packages/node-adapters/src/execution/retained-audit-inventory")
  ).inspectSubmittedAuditInventory(
    { ...input.auditInput, root: input.root, owner: input.owner },
    { priorProcessAlive: api.priorProcessAlive },
  );
}
function processObservation(expected: {
  pid: number;
  birth: string;
}): ProcessObservation {
  if (!Number.isSafeInteger(expected.pid) || expected.pid <= 0)
    fail("Exact selected SDK PID required");
  const result = spawnSync(
    "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$ErrorActionPreference='Stop'; $p=Get-Process -Id ${expected.pid} -ErrorAction Stop; [pscustomobject]@{state='present';pid=$p.Id;birth=$p.StartTime.ToFileTimeUtc().ToString();observedAtUtc=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json -Compress`,
    ],
    { encoding: "utf8", timeout: 30000 },
  );
  if (result.error || result.status !== 0)
    fail("Selected SDK process cannot be freshly identified");
  return JSON.parse(result.stdout) as ProcessObservation;
}
const defaults: RetainedSuccessorPorts = {
  process: processObservation,
  inspectWorker: worker.inspectMetadataWorkerProcess,
  evaluatorRoot: () =>
    (
      load(
        "./dist/config-platform",
      ) as typeof import("../../packages/node-adapters/src/config-platform")
    ).resolveRuntimePaths({ anchor }).installation,
  admissionFreeze(input) {
    return {
      mechanism: "pidfd-SIGSTOP/source-bound-terminal-dispatch-cut",
      evidence: ref(
        path.join(input.auditDirectory, "installed-qualification.json"),
      ),
      cut: inspectRetainedDispatchCut(input),
    };
  },
};
function freshProcess(
  ports: RetainedSuccessorPorts,
  expected: { pid: number; birth: string },
) {
  const current = ports.process(expected),
    time = Date.parse(current.observedAtUtc);
  if (
    current.state !== "present" ||
    current.pid !== expected.pid ||
    current.birth !== expected.birth ||
    !Number.isFinite(time) ||
    time > Date.now() ||
    Date.now() - time > 30000
  )
    fail(
      "Fresh exact same selected process required; stale or reused SDK PID refuses recovery",
    );
  return current;
}
function qualifiedEvaluator(approval: Data) {
  const runtime = text(approval["candidateRoot"]),
    qRef = checkedRef(approval["qualification"]),
    q = read(qRef.path);
  if (
    fs.realpathSync(runtime) !== runtime ||
    api.buildHash(runtime) !== approval["buildHash"] ||
    q["buildHash"] !== approval["buildHash"] ||
    q["sourceCommit"] !== approval["sourceCommit"] ||
    q["passed"] !== true ||
    q["productionAdmission"] !== true ||
    q["liveSdkRequestsSent"] !== 0 ||
    q["deadEpochSuccessorReadQualified"] !== true ||
    q["deadEpochSuccessorRestoreQualified"] !== true
  )
    fail("Exact qualified immutable evaluator required");
  return { runtime, qualification: qRef };
}

/** Narrow recovery for the one cold, terminal native audit; no scratch dispatch
 * is possible while its current facts are unpublished. It is not a generic
 * license to retire SDK1 workers or to assert freshness from old remote data. */
async function inspect(
  client: RetainedSuccessorClient,
  approvalFile: string,
  ports: RetainedSuccessorPorts,
) {
  const approvalRef = ref(approvalFile),
    approval = read(approvalFile),
    authorityRef = checkedRef(approval["authority"]),
    original = (
      load(
        "./queue-epoch-successor",
      ) as typeof import("./queue-epoch-successor")
    ).assertCurrentPredecessor(client.dir, authorityRef),
    a = original.authority,
    dir = path.dirname(authorityRef.path),
    observation = path.join(dir, "dead-epoch-current-observation"),
    owner = object(approval["owner"]) as unknown as Owner,
    expected = a.expectedProcess || fail("Exact selected SDK process required"),
    candidate = qualifiedEvaluator(approval);
  if (
    client.dir !== fs.realpathSync(client.dir) ||
    approval["version"] !== 1 ||
    approval["purpose"] !== "retained-successor-response-acceptance-v1" ||
    approval["clientId"] !== client.auth.clientId ||
    a.clientId !== client.auth.clientId ||
    a.ownerTokenHash !== api.hash(client.auth.clientToken) ||
    read(path.join(client.dir, "clients.json"))[a.clientId] !==
      a.ownerTokenHash ||
    approval["requestId"] !== a.requestId ||
    !same(approval["expectedProcess"], expected) ||
    !same(read(path.join(client.dir, "broker.lock")), owner) ||
    api.priorProcessAlive(owner) !== true ||
    !same(read(path.join(client.dir, "active-epoch-succession.json")), {
      version: 1,
      authority: authorityRef,
    }) ||
    ref(path.join(client.dir, "isolated-admission-epoch.json")).sha256 !==
      a.predecessor.pointer.sha256 ||
    candidate.runtime !== ports.evaluatorRoot()
  )
    fail(
      "Exact owner, live metadata worker, pending authority and qualified evaluator required",
    );
  const status = object(await client.call("queue-summary")),
    control = object(status["control"]),
    successor = object(status["deadEpochSuccessor"]),
    features = object(status["features"]);
  if (
    status["buildHash"] !== a.buildHash ||
    status["sourceCommit"] !== a.sourceCommit ||
    status["stopping"] !== false ||
    status["held"] !==
      "Qualified isolated scratch process is unavailable; metadata only, no SDK or replacement authority" ||
    control["instanceId"] !== owner.nonce ||
    control["buildHash"] !== a.buildHash ||
    control["activeOperations"] !== 0 ||
    !same(control["activeIds"], []) ||
    control["phase"] !== "RECOVERY_BLOCKED" ||
    control["unresolved"] !== true ||
    successor["requestId"] !== a.requestId ||
    successor["currentFactsAvailable"] !== false ||
    !same(successor["expectedProcess"], expected) ||
    features["auditFactsCapture"] !== false ||
    features["atomicRecoveryProcessLossAudit"] !== false
  )
    fail("Whole current metadata scope must be cold, blocked and quiescent");
  const names = [
    "authority.json",
    "complete.json",
    "installed-qualification.json",
    "intent.json",
    "launch-intent.json",
    "predecessor-pointer.json",
    "previous-active-succession.json",
    "released-atomic-migration.lock.json",
    "released-recovery.lock.json",
    "retired-owner.json",
    "worker-claim.json",
    "worker-ready.json",
    "worker.stderr.log",
    "worker.stdout.log",
    "dead-epoch-current-observation",
  ];
  if (!same(fs.readdirSync(dir).sort(), names.sort()))
    fail(
      "Subsequent startup, SDK dispatch or current-facts publication refuses retained recovery",
    );
  const observationNames = [
    "intent.json",
    "start.json",
    "wire.json",
    "received-response.json",
    "result.json",
  ];
  const originalIntent = read(path.join(observation, "intent.json")),
    start = read(path.join(observation, "start.json")),
    physical = object(start["binding"]);
  observationNames.push("remote-" + text(physical["rpcId"]) + ".json");
  if (!same(fs.readdirSync(observation).sort(), observationNames.sort()))
    fail(
      "Unexpected response, dispatch, acceptance or conflicting journal refuses retained recovery",
    );
  const metadata = read(path.join(dir, "complete.json")),
    ready = read(path.join(dir, "worker-ready.json")),
    claim = read(path.join(dir, "worker-claim.json")),
    startup = read(path.join(dir, "intent.json")),
    lifecycle = read(
      path.join(client.dir, "broker-lifecycle-" + owner.nonce + ".json"),
    );
  if (
    !same(metadata["authority"], authorityRef) ||
    !same(metadata["owner"], owner) ||
    metadata["sdkRequestsSent"] !== 0 ||
    metadata["requestId"] !== a.requestId ||
    metadata["buildHash"] !== a.buildHash ||
    metadata["sourceCommit"] !== a.sourceCommit ||
    metadata["historicalOutcome"] !== "unknown" ||
    !same(ready["owner"], owner) ||
    ready["sdkRequestsSent"] !== 0 ||
    ready["buildHash"] !== a.buildHash ||
    ready["nonce"] !== a.nonce ||
    claim["pid"] !== owner.pid ||
    claim["birth"] !== owner.birth ||
    claim["nonce"] !== startup["nonce"] ||
    startup["nonce"] !== a.nonce ||
    startup["requestId"] !== a.requestId ||
    startup["clientId"] !== a.clientId ||
    startup["ownerTokenHash"] !== a.ownerTokenHash ||
    !same(lifecycle["owner"], owner) ||
    lifecycle["buildHash"] !== a.buildHash ||
    lifecycle["configHash"] !== a["configHash"] ||
    lifecycle["stage"] !== "ready"
  )
    fail(
      "The complete metadata startup and lifecycle must belong to this exact worker",
    );
  const originalApproval = checkedRef(startup["approval"]);
  const originalApproved = read(originalApproval.path),
    originalQualification = checkedRef(originalApproved["qualification"]);
  if (
    originalApproved["requestId"] !== a.requestId ||
    originalApproved["clientId"] !== a.clientId ||
    originalApproved["buildHash"] !== a.buildHash ||
    originalApproved["sourceCommit"] !== a.sourceCommit ||
    !same(originalApproved["expectedProcess"], expected) ||
    originalQualification.sha256 !== a.qualification.sha256 ||
    api.buildHash(text(a["candidateRoot"])) !== a.buildHash ||
    !same(read(path.join(dir, "launch-intent.json")), {
      nonce: a.nonce,
      authority: authorityRef,
    }) ||
    !same(read(path.join(dir, "retired-owner.json")), a.previousOwner)
  )
    fail("Original startup, qualification and immutable runtime differ");
  const jobs = original.pointer["quarantinedJobIds"];
  if (!Array.isArray(jobs) || jobs.length !== 2)
    fail("Exact historical quarantined pair required");
  const auditInput = {
    directory: observation,
    key: {
      jobId: text(jobs[0]),
      observationJobId: text(jobs[1]),
      requestId: a.requestId + ":observe",
      clientId: a.clientId,
    },
    identity: read(
      path.join(
        path.dirname(original.pointer.qualificationReceipt.path),
        "intent.json",
      ),
    )["identity"],
    binding: {
      purpose: "atomic-recovery-audit-v1",
      clientId: a.clientId,
      expectedProcess: expected,
      successorAuthorityHash: authorityRef.sha256,
    },
    instance: expected,
    buildHash: a.buildHash,
  } satisfies RetainedAuditInput;
  const verified = audit.verifyRetainedAuditResponse(auditInput);
  const originalReader = (
    createRequire(
      path.join(text(a["candidateRoot"]), "src/queue-atomic-recovery-audit.js"),
    )(
      "./queue-atomic-recovery-audit",
    ) as typeof import("../queue-atomic-recovery-audit")
  ).prepareRecoveryAudit(
    text(a["candidateRoot"]),
    read(
      path.join(
        path.dirname(original.pointer.qualificationReceipt.path),
        "intent.json",
      ),
    )["identity"],
    object(originalIntent["binding"]),
  );
  if (
    originalIntent["sourceSha256"] !== originalReader.sourceSha256 ||
    originalIntent["sourceArtifactHash"] !==
      originalReader.artifact.artifactHash ||
    object(verified.start["binding"])["sourceHash"] !==
      originalReader.artifact.sha256
  )
    fail(
      "Retained dispatch was not the exact original runtime read-only audit builder",
    );
  const summary = verified.summary;
  if (
    object(summary["ui"])["idle"] !== true ||
    summary["modulePresent"] !== false ||
    object(summary["commandDefinition"])["status"] !== "absent"
  )
    fail("Retained summary is not safe for current-facts admission");
  const approvedFiles = object(approval["files"]),
    actualFiles = Object.fromEntries([
      ...names
        .filter((n) => n !== "dead-epoch-current-observation")
        .map((n) => [n, ref(path.join(dir, n))] as const),
      ...Object.entries(verified.files).map(
        ([n, r]) => ["observation/" + n, r] as const,
      ),
      ...[
        "broker.lock",
        "isolated-admission-epoch.json",
        "queue-state.json",
        "instance.json",
        "active-epoch-succession.json",
        "broker-lifecycle-" + owner.nonce + ".json",
      ].map((n) => ["root/" + n, ref(path.join(client.dir, n))] as const),
    ]);
  if (!same(actualFiles, approvedFiles))
    fail(
      "Approved complete scope/dispatch cut changed; no subsequent mutation may be inferred away",
    );
  if (
    api.priorProcessAlive(original.pointer.currentInstance) !== false ||
    api.priorProcessAlive(original.pointer["originalInstance"]) !== false
  )
    fail(
      "Historical unknowns must belong only to exact dead predecessor SDK processes",
    );
  const process = freshProcess(ports, expected);
  return {
    approvalRef,
    approval,
    authorityRef,
    original,
    dir,
    observation,
    owner,
    expected,
    candidate,
    verified,
    auditInput,
    process,
    originalApproval,
    status,
    inventory: [
      { path: dir, entries: names.sort() },
      { path: observation, entries: observationNames.sort() },
    ],
    refs: [
      approvalRef,
      authorityRef,
      originalApproval,
      originalQualification,
      candidate.qualification,
      ...Object.values(actualFiles),
    ],
  };
}

export async function recoverRetainedSuccessor(
  client: RetainedSuccessorClient,
  approvalFile: string,
  apply: boolean,
  testPorts?: Partial<RetainedSuccessorPorts>,
) {
  const existing = readRetainedHandoff(client, approvalFile);
  if (existing) return existing;
  const ports = { ...defaults, ...testPorts },
    v = await inspect(client, approvalFile, ports),
    freezeInput: FreezeInput = {
      owner: v.owner,
      status: v.status,
      authority: v.authorityRef,
      refs: v.refs,
      root: client.dir,
      auditDirectory: v.dir,
      runtime: text(v.original.authority["candidateRoot"]),
      sourceCommit: v.original.authority.sourceCommit,
      buildHash: v.original.authority.buildHash,
      configHash: text(v.original.authority["configHash"]),
      expectedProcess: v.expected,
      auditInput: v.auditInput,
    },
    freeze = ports.admissionFreeze(freezeInput),
    cut = freeze.cut ?? {
      files: v.refs,
      inventory: v.inventory,
      sdkRequestsSent: 1 as const,
      allLiveSdkTerminal: true as const,
      selectedProcess: v.expected,
    },
    boundRefs = [...v.refs, freeze.evidence, ...cut.files],
    boundInventory = [
      ...new Map(
        [...v.inventory, ...cut.inventory].map((row) => [row.path, row]),
      ).values(),
    ],
    ownerProcess = ports.inspectWorker(
      v.owner,
      text(v.original.authority["candidateRoot"]),
      boundRefs,
      false,
      client.dir,
      boundInventory,
    );
  checkedRef(freeze.evidence);
  if (
    ownerProcess.retired ||
    !ownerProcess.process ||
    !ownerProcess.interpreter
  )
    fail("Original metadata worker is not exactly inspectable");
  if (!apply)
    return {
      ready: true,
      retirementPerformed: false,
      sdkRequestsSent: 1,
      currentRpcTerminal: true,
      historicalOutcome: "unknown",
      authority: v.authorityRef,
      owner: v.owner,
    };
  const handoff = path.join(v.dir, "retained-evaluator-handoff");
  if (fs.existsSync(handoff))
    fail(
      "Existing handoff intent: inspect its original outcome, never repeat a signal blindly",
    );
  fs.mkdirSync(handoff, { mode: 0o700 });
  const before = {
    version: 1,
    kind: "terminal-current-audit-metadata-handoff-before",
    createdAtUtc: new Date().toISOString(),
    approval: v.approvalRef,
    authority: v.authorityRef,
    owner: v.owner,
    process: ownerProcess,
    expectedProcess: v.expected,
    sdkProcessObservation: v.process,
    currentRpcTerminal: true,
    sdkRequestsSent: 1,
    historicalOutcome: "unknown",
    status: v.status,
    sdkDispatchCutHash: canonicalHash({
      files: v.refs,
      inventory: boundInventory,
    }),
    files: v.refs,
    inventory: boundInventory,
    admissionFreeze: { ...freeze, cut },
  };
  files.exclusive(path.join(handoff, "before.json"), before);
  // The only new directory is our own journal; every other path remains frozen.
  const inventory = boundInventory.map((row) =>
    row.path === v.dir
      ? {
          ...row,
          entries: [...row.entries, "retained-evaluator-handoff"].sort(),
        }
      : row,
  );
  freshProcess(ports, v.expected);
  const recheck = object(await client.call("queue-summary"));
  if (!same(recheck, v.status))
    fail("Metadata scope changed after the approved dispatch cut");
  const beforeRef = ref(path.join(handoff, "before.json"));
  files.exclusive(path.join(handoff, "effect-start.json"), {
    kind: "terminal-current-audit-metadata-handoff-effect-start",
    createdAtUtc: new Date().toISOString(),
    before: beforeRef,
    owner: v.owner,
    sdkRequestsSent: 1,
    currentRpcTerminal: true,
    historicalOutcome: "unknown",
  });
  try {
    const frozen = ports.inspectWorker(
      {
        ...v.owner,
        processProof: ownerProcess.process,
        interpreterProof: ownerProcess.interpreter,
      },
      text(v.original.authority["candidateRoot"]),
      [...boundRefs, beforeRef, ref(path.join(handoff, "effect-start.json"))],
      false,
      client.dir,
      inventory,
      "freeze",
    );
    if (
      frozen.retired ||
      frozen.frozen !== true ||
      !frozen.process ||
      !frozen.interpreter
    )
      fail("Metadata freeze outcome is pending");
    // SIGSTOP closes new Node dispatch, not an already submitted SDK turn. Prove
    // the entire durable producer cut again after every thread is stopped.
    const afterFreeze = ports.admissionFreeze(freezeInput),
      afterCut = afterFreeze.cut ?? {
        files: v.refs,
        inventory: v.inventory,
        sdkRequestsSent: 1 as const,
        allLiveSdkTerminal: true as const,
        selectedProcess: v.expected,
      };
    if (
      !same(afterCut, cut) ||
      afterCut.allLiveSdkTerminal !== true ||
      afterCut.sdkRequestsSent !== 1
    )
      fail(
        "Submitted scope changed or contains a nonterminal SDK turn after freeze; no kill or automatic continue",
      );
    for (const r of boundRefs)
      if (!same(ref(r.path), r))
        fail(
          "Submitted evidence changed after freeze; no kill or automatic continue",
        );
    const sdkAfterFreeze = freshProcess(ports, v.expected);
    const frozenFile = path.join(handoff, "frozen.json");
    files.exclusive(frozenFile, {
      kind: "source-bound-terminal-metadata-frozen",
      createdAtUtc: new Date().toISOString(),
      sdkProcessObservation: sdkAfterFreeze,
      before: beforeRef,
      owner: v.owner,
      process: frozen,
      dispatchCutHash: canonicalHash(cut),
      allLiveSdkTerminal: true,
      sdkRequestsSent: 1,
      historicalOutcome: "unknown",
      automaticContinueAllowed: false,
    });
    const frozenRef = ref(frozenFile),
      killStart = path.join(handoff, "retirement-effect-start.json");
    files.exclusive(killStart, {
      kind: "frozen-terminal-metadata-retirement-effect-start",
      createdAtUtc: new Date().toISOString(),
      frozen: frozenRef,
      before: beforeRef,
      owner: v.owner,
      allLiveSdkTerminal: true,
      sdkRequestsSent: 1,
      historicalOutcome: "unknown",
    });
    const retired = ports.inspectWorker(
      {
        ...v.owner,
        processProof: frozen.process,
        interpreterProof: frozen.interpreter,
      },
      text(v.original.authority["candidateRoot"]),
      [
        ...boundRefs,
        beforeRef,
        ref(path.join(handoff, "effect-start.json")),
        frozenRef,
        ref(killStart),
      ],
      true,
      client.dir,
      inventory,
      "retire-frozen",
    );
    if (!retired.retired || api.priorProcessAlive(v.owner) !== false)
      fail(
        "Metadata worker retirement outcome is pending; preserve the handoff journal",
      );
    for (const r of v.refs)
      if (!same(ref(r.path), r))
        fail("Protected scope changed during metadata retirement");
    const after = {
      version: 1,
      kind: "terminal-current-audit-metadata-handoff-retired",
      createdAtUtc: new Date().toISOString(),
      before: beforeRef,
      effectStart: ref(path.join(handoff, "effect-start.json")),
      approval: v.approvalRef,
      authority: v.authorityRef,
      owner: v.owner,
      sdkRequestsSent: 1,
      currentRpcTerminal: true,
      historicalOutcome: "unknown",
      retired: true,
      mechanism: "pidfd_send_signal:SIGKILL",
      frozen: frozenRef,
      retirementStart: ref(killStart),
      allLiveSdkTerminal: true,
    };
    files.exclusive(path.join(handoff, "after.json"), after);
    return after;
  } catch (error) {
    const pending = {
      kind: "retained-metadata-freeze-pending",
      createdAtUtc: new Date().toISOString(),
      wholeCurrentScopeTerminal: "unverified",
      approval: v.approvalRef,
      authority: v.authorityRef,
      owner: v.owner,
      receipt: ref(path.join(handoff, "effect-start.json")),
      sdkRequestsSent: 1,
      currentRpcTerminal: true,
      historicalOutcome: "unknown",
      currentFreezeState: "unverified",
      automaticKillAllowed: false,
      automaticContinueAllowed: false,
      code:
        error && typeof error === "object" && "code" in error
          ? error.code
          : "FREEZE_OUTCOME_PENDING",
    };
    files.exclusive(path.join(handoff, "pending.json"), pending);
    return pending;
  }
}

/** Inspect an unknown/partial freeze through original receipts, never an RPC to
 * a possibly stopped process and never a repeated signal or automatic thaw. */
export function readRetainedHandoff(
  client: RetainedSuccessorClient,
  approvalFile: string,
) {
  const approvalRef = ref(approvalFile),
    approval = read(approvalFile),
    authorityRef = checkedRef(approval["authority"]),
    original = read(authorityRef.path),
    journal = path.join(
      path.dirname(authorityRef.path),
      "retained-evaluator-handoff",
    );
  if (!fs.existsSync(journal)) return null;
  if (
    client.auth.clientId !== original["clientId"] ||
    api.hash(client.auth.clientToken) !== original["ownerTokenHash"] ||
    read(path.join(client.dir, "clients.json"))[client.auth.clientId] !==
      original["ownerTokenHash"]
  )
    fail("Only the existing original owner may inspect a pending freeze");
  const before = read(path.join(journal, "before.json"));
  if (
    !same(before["approval"], approvalRef) ||
    !same(before["authority"], authorityRef) ||
    !same(before["owner"], approval["owner"])
  )
    fail("Pending freeze differs from its original owner approval");
  const receipts = Object.fromEntries(
    [
      "before.json",
      "effect-start.json",
      "frozen.json",
      "retirement-effect-start.json",
      "after.json",
      "pending.json",
      "runtime.json",
      "launch-intent.json",
      "worker-claim.json",
      "worker-ready.json",
      "worker-error.json",
      "complete.json",
      "acceptance-start.json",
      "acceptance-complete.json",
    ]
      .filter((name) => fs.existsSync(path.join(journal, name)))
      .map((name) => [name, ref(path.join(journal, name))]),
  );
  if (receipts["after.json"] && receipts["pending.json"])
    fail("Conflicting freeze terminal receipts require inspection, not replay");
  return {
    kind: "retained-metadata-handoff-receipts",
    status: receipts["acceptance-complete.json"]
      ? "accepted"
      : receipts["acceptance-start.json"]
        ? "acceptance-pending"
        : receipts["complete.json"]
          ? "evaluator-ready-guarded"
          : receipts["launch-intent.json"]
            ? "evaluator-launch-pending"
            : receipts["after.json"]
              ? "retired"
              : receipts["pending.json"]
                ? "freeze-pending"
                : "prepared-or-unknown",
    authority: authorityRef,
    owner: approval["owner"],
    receipts,
    sdkRequestsSent: 1,
    currentRpcTerminal: true,
    historicalOutcome: "unknown",
    currentFreezeState: "unverified",
    automaticKillAllowed: false,
    automaticContinueAllowed: false,
    noReplay: true,
  };
}

/** An explicit qualified evaluator continuation, never a rewrite of authority.
 * Lineage readers validate the original authority first, then this one-time
 * append-only handoff. The original dispatch retains its original build. */
export function retainedEvaluatorAuthority<T extends Data>(
  root: string,
  original: T,
  authorityRef: Reference,
): T {
  const dir = path.dirname(authorityRef.path),
    journal = path.join(dir, "retained-evaluator-handoff"),
    runtimeFile = path.join(journal, "runtime.json");
  if (!fs.existsSync(runtimeFile)) return original;
  if (fs.existsSync(path.join(journal, "pending.json")))
    fail("Pending freeze evidence forbids evaluator activation");
  const handoff = read(runtimeFile),
    approvalRef = checkedRef(handoff["approval"]),
    approval = read(approvalRef.path),
    afterRef = checkedRef(handoff["retirement"]),
    after = read(afterRef.path),
    beforeRef = checkedRef(after["before"]),
    before = read(beforeRef.path),
    effectRef = checkedRef(after["effectStart"]),
    effect = read(effectRef.path),
    frozenRef = checkedRef(after["frozen"]),
    freezeProof = read(frozenRef.path),
    killRef = checkedRef(after["retirementStart"]),
    kill = read(killRef.path),
    candidate = qualifiedEvaluator(approval);
  if (
    handoff["kind"] !== "qualified-retained-successor-evaluator" ||
    !same(handoff["authority"], authorityRef) ||
    !same(approval["authority"], authorityRef) ||
    approval["purpose"] !== "retained-successor-response-acceptance-v1" ||
    approval["version"] !== 1 ||
    approval["clientId"] !== original["clientId"] ||
    approval["requestId"] !== original["requestId"] ||
    !same(approval["expectedProcess"], original["expectedProcess"]) ||
    afterRef.path !== path.join(journal, "after.json") ||
    beforeRef.path !== path.join(journal, "before.json") ||
    effectRef.path !== path.join(journal, "effect-start.json") ||
    !same(after["approval"], approvalRef) ||
    !same(before["approval"], approvalRef) ||
    !same(after["authority"], authorityRef) ||
    !same(before["authority"], authorityRef) ||
    after["kind"] !== "terminal-current-audit-metadata-handoff-retired" ||
    before["kind"] !== "terminal-current-audit-metadata-handoff-before" ||
    effect["kind"] !== "terminal-current-audit-metadata-handoff-effect-start" ||
    !same(effect["before"], beforeRef) ||
    !same(after["owner"], approval["owner"]) ||
    !same(before["owner"], approval["owner"]) ||
    !same(effect["owner"], approval["owner"]) ||
    after["retired"] !== true ||
    after["allLiveSdkTerminal"] !== true ||
    frozenRef.path !== path.join(journal, "frozen.json") ||
    killRef.path !== path.join(journal, "retirement-effect-start.json") ||
    freezeProof["kind"] !== "source-bound-terminal-metadata-frozen" ||
    !same(freezeProof["before"], beforeRef) ||
    !same(freezeProof["owner"], approval["owner"]) ||
    freezeProof["allLiveSdkTerminal"] !== true ||
    freezeProof["sdkRequestsSent"] !== 1 ||
    freezeProof["historicalOutcome"] !== "unknown" ||
    freezeProof["automaticContinueAllowed"] !== false ||
    object(freezeProof["process"])["frozen"] !== true ||
    freezeProof["dispatchCutHash"] !==
      canonicalHash(object(before["admissionFreeze"])["cut"]) ||
    kill["kind"] !== "frozen-terminal-metadata-retirement-effect-start" ||
    !same(kill["frozen"], frozenRef) ||
    !same(kill["before"], beforeRef) ||
    !same(kill["owner"], approval["owner"]) ||
    kill["allLiveSdkTerminal"] !== true ||
    kill["sdkRequestsSent"] !== 1 ||
    kill["historicalOutcome"] !== "unknown" ||
    after["mechanism"] !== "pidfd_send_signal:SIGKILL" ||
    before["sdkDispatchCutHash"] !==
      canonicalHash({
        files: before["files"],
        inventory: before["inventory"],
      }) ||
    [before, after, effect].some(
      (r) =>
        r["sdkRequestsSent"] !== 1 ||
        r["currentRpcTerminal"] !== true ||
        r["historicalOutcome"] !== "unknown",
    ) ||
    api.priorProcessAlive(approval["owner"]) !== false ||
    read(path.join(root, "clients.json"))[text(original["clientId"])] !==
      original["ownerTokenHash"]
  )
    fail(
      "Qualified evaluator handoff differs from its exact terminal metadata scope",
    );
  const frozen = handoff["frozen"];
  if (!Array.isArray(frozen) || !frozen.length)
    fail("Complete original immutable handoff evidence required");
  for (const entry of frozen) checkedRef(entry);
  checkedRef(object(before["admissionFreeze"])["evidence"]);
  const cut = object(object(before["admissionFreeze"])["cut"]);
  if (cut["sdkRequestsSent"] !== 1 || cut["allLiveSdkTerminal"] !== true)
    fail(
      "Frozen metadata scope lacks a complete terminal live-SDK dispatch inventory",
    );
  const approvedFiles = object(approval["files"]);
  const required = Object.entries(approvedFiles)
    .filter(([key]) => !key.startsWith("root/"))
    .map(([, entry]) => entry);
  if (!required.every((entry) => frozen.some((value) => same(value, entry))))
    fail("Handoff omitted original audit evidence");
  return {
    ...original,
    candidateRoot: candidate.runtime,
    buildHash: approval["buildHash"],
    sourceCommit: approval["sourceCommit"],
    qualification: candidate.qualification,
    retainedEvaluatorHandoff: ref(runtimeFile),
  };
}

export async function resumeRetainedSuccessor(
  client: RetainedSuccessorClient,
  cfg: unknown,
  approvalFile: string,
  testPorts?: Partial<RetainedSuccessorPorts>,
) {
  const ports = { ...defaults, ...testPorts };
  const approvalRef = ref(approvalFile),
    approval = read(approvalFile),
    authorityRef = checkedRef(approval["authority"]),
    dir = path.dirname(authorityRef.path),
    journal = path.join(dir, "retained-evaluator-handoff"),
    afterRef = ref(path.join(journal, "after.json")),
    after = read(afterRef.path),
    before = read(checkedRef(after["before"]).path),
    owner = approval["owner"],
    original = read(authorityRef.path),
    candidate = qualifiedEvaluator(approval);
  if (
    client.auth.clientId !== original["clientId"] ||
    api.hash(client.auth.clientToken) !== original["ownerTokenHash"] ||
    !same(after["approval"], approvalRef) ||
    api.priorProcessAlive(owner) !== false
  )
    fail(
      "Exact existing owner and completed terminal metadata retirement required",
    );
  if (fs.existsSync(path.join(journal, "pending.json")))
    fail(
      "Pending freeze outcome must be resolved from its original evidence; evaluator launch is forbidden",
    );
  if (fs.existsSync(path.join(journal, "launch-intent.json")))
    fail(
      "Existing evaluator launch intent: inspect its original receipts; no second launch",
    );
  const frozen = before["files"];
  if (!Array.isArray(frozen))
    fail("Original complete scope references required");
  for (const entry of frozen) checkedRef(entry);
  if (!same(read(path.join(client.dir, "broker.lock")), owner))
    fail("Retired metadata marker changed before evaluator handoff");
  const runtimeFile = path.join(journal, "runtime.json");
  files.exclusive(runtimeFile, {
    kind: "qualified-retained-successor-evaluator",
    approval: approvalRef,
    authority: authorityRef,
    retirement: afterRef,
    frozen: frozen.filter(
      (entry) =>
        !Object.entries(object(approval["files"])).some(
          ([key, value]) => key.startsWith("root/") && same(value, entry),
        ),
    ),
  });
  const effective = retainedEvaluatorAuthority(
    client.dir,
    original,
    authorityRef,
  );
  if (text(effective["candidateRoot"]) !== ports.evaluatorRoot())
    fail("Only this qualified evaluator can resume the metadata scope");
  freshProcess(
    ports,
    object(original["expectedProcess"]) as unknown as {
      pid: number;
      birth: string;
    },
  );
  fs.renameSync(
    path.join(client.dir, "broker.lock"),
    path.join(journal, "retired-broker.lock.json"),
  );
  const intent = read(path.join(dir, "intent.json")),
    nonce = text(intent["nonce"]),
    guard = {
      kind: "dead-epoch-successor",
      nonce,
      audit: dir,
      clientId: client.auth.clientId,
    };
  for (const name of ["recovery.lock", "atomic-migration.lock"])
    files.exclusive(path.join(client.dir, name), guard);
  files.exclusive(path.join(journal, "launch-intent.json"), {
    authority: authorityRef,
    evaluator: ref(runtimeFile),
    sdkRequestsSent: 0,
    originalCurrentScopeSdkRequestsSent: 1,
    currentRpcTerminal: true,
  });
  const out = fs.openSync(path.join(journal, "worker.stdout.log"), "ax", 0o600),
    err = fs.openSync(path.join(journal, "worker.stderr.log"), "ax", 0o600);
  const child = spawn(
    process.execPath,
    [path.join(candidate.runtime, "src/queue-epoch-successor-worker.js")],
    { detached: true, stdio: ["pipe", out, err] },
  );
  child.stdin?.end(
    JSON.stringify({
      cfg,
      dir: client.dir,
      audit: dir,
      nonce,
      workerJournal: journal,
    }),
  );
  child.unref();
  fs.closeSync(out);
  fs.closeSync(err);
  const readyFile = path.join(journal, "worker-ready.json"),
    deadline = Date.now() + 30000;
  while (!fs.existsSync(readyFile) && Date.now() < deadline) {
    if (fs.existsSync(path.join(journal, "worker-error.json")))
      fail(
        "Evaluator startup failed: " +
          String(read(path.join(journal, "worker-error.json"))["code"]) +
          "; preserve its exact launch identity",
      );
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!fs.existsSync(readyFile))
    return { status: "pending", receipt: readyFile, noReplay: true };
  const ready = read(readyFile);
  if (
    ready["buildHash"] !== approval["buildHash"] ||
    ready["sdkRequestsSent"] !== 0 ||
    !same(ready["owner"], read(path.join(client.dir, "broker.lock")))
  )
    fail("Qualified evaluator ready receipt differs");
  for (const name of ["recovery.lock", "atomic-migration.lock"]) {
    const file = path.join(client.dir, name);
    if (!same(read(file), guard)) fail("Evaluator startup guard changed");
  }
  const complete = {
    kind: "retained-successor-evaluator-ready",
    authority: authorityRef,
    evaluator: ref(runtimeFile),
    ready: ref(readyFile),
    owner: ready["owner"],
    sdkRequestsSent: 0,
    originalCurrentScopeSdkRequestsSent: 1,
    currentRpcTerminal: true,
    historicalOutcome: "unknown",
    admissionGuardsRetained: true,
  };
  files.exclusive(path.join(journal, "complete.json"), complete);
  return complete;
}

export async function acceptRetainedSuccessor(
  client: RetainedSuccessorClient,
  approvalFile: string,
  apply: boolean,
  testPorts?: Partial<RetainedSuccessorPorts>,
) {
  const ports = { ...defaults, ...testPorts },
    approvalRef = ref(approvalFile),
    approval = read(approvalFile),
    authorityRef = checkedRef(approval["authority"]),
    original = read(authorityRef.path),
    effective = retainedEvaluatorAuthority(client.dir, original, authorityRef),
    dir = path.dirname(authorityRef.path),
    journal = path.join(dir, "retained-evaluator-handoff"),
    observation = path.join(dir, "dead-epoch-current-observation"),
    complete = read(path.join(journal, "complete.json")),
    metadata = read(checkedRef(complete["ready"]).path),
    owner = metadata["owner"];
  const startup = read(path.join(dir, "intent.json")),
    guard = {
      kind: "dead-epoch-successor",
      nonce: text(startup["nonce"]),
      audit: dir,
      clientId: client.auth.clientId,
    };
  const guards = () => {
    if (complete["admissionGuardsRetained"] !== true)
      fail(
        "Evaluator must retain its original admission guards until acceptance",
      );
    for (const name of ["recovery.lock", "atomic-migration.lock"])
      if (!same(read(path.join(client.dir, name)), guard))
        fail(
          "Evaluator admission guard changed; current facts cannot be accepted",
        );
  };
  guards();
  if (
    client.auth.clientId !== original["clientId"] ||
    api.hash(client.auth.clientToken) !== original["ownerTokenHash"] ||
    effective["candidateRoot"] !== ports.evaluatorRoot() ||
    !same(complete["authority"], authorityRef) ||
    !same(read(path.join(client.dir, "broker.lock")), owner) ||
    api.priorProcessAlive(owner) !== true ||
    metadata["sdkRequestsSent"] !== 0
  )
    fail(
      "Exact qualified evaluator and original owner required before retained acceptance",
    );
  const status = object(await client.call("queue-summary")),
    control = object(status["control"]),
    successor = object(status["deadEpochSuccessor"]);
  if (
    control["activeOperations"] !== 0 ||
    !same(control["activeIds"], []) ||
    control["phase"] !== "RECOVERY_BLOCKED" ||
    control["instanceId"] !== object(owner)["nonce"] ||
    control["buildHash"] !== effective["buildHash"] ||
    status["buildHash"] !== effective["buildHash"] ||
    status["sourceCommit"] !== effective["sourceCommit"] ||
    status["stopping"] !== false ||
    successor["currentFactsAvailable"] !== false ||
    successor["requestId"] !== original["requestId"]
  )
    fail("Fresh evaluator scope must remain blocked and quiescent");
  const expected = object(original["expectedProcess"]) as unknown as {
    pid: number;
    birth: string;
  };
  freshProcess(ports, expected);
  const originalIntent = read(path.join(observation, "intent.json")),
    key = object(originalIntent["key"]) as Record<string, string>;
  const predecessor = lineage.successionAuthority(
      client.dir,
      authorityRef,
    ).pointer,
    jobs = predecessor["quarantinedJobIds"];
  if (
    !Array.isArray(jobs) ||
    jobs.length !== 2 ||
    !same(key, {
      jobId: jobs[0],
      observationJobId: jobs[1],
      requestId: text(original["requestId"]) + ":observe",
      clientId: original["clientId"],
    })
  )
    fail("Original immutable owner/job lineage differs before acceptance");
  const result = audit.verifyRetainedAuditResponse({
    directory: observation,
    key,
    identity: read(
      path.join(
        path.dirname(predecessor.qualificationReceipt.path),
        "intent.json",
      ),
    )["identity"],
    binding: {
      purpose: "atomic-recovery-audit-v1",
      clientId: original["clientId"],
      expectedProcess: expected,
      successorAuthorityHash: authorityRef.sha256,
    },
    instance: expected,
    buildHash: text(original["buildHash"]),
  });
  const baseline = object(approval["files"]);
  const auditEntries = Object.keys(baseline).filter(
    (key) => !key.includes("/"),
  );
  auditEntries.push(
    "dead-epoch-current-observation",
    "retained-evaluator-handoff",
  );
  const observationEntries = Object.keys(baseline)
    .filter((key) => key.startsWith("observation/"))
    .map((key) => key.slice("observation/".length));
  const journalEntries = [
    "before.json",
    "effect-start.json",
    "frozen.json",
    "retirement-effect-start.json",
    "after.json",
    "runtime.json",
    "retired-broker.lock.json",
    "launch-intent.json",
    "worker-claim.json",
    "worker-ready.json",
    "worker.stdout.log",
    "worker.stderr.log",
    "complete.json",
  ];
  if (
    !same(fs.readdirSync(dir).sort(), auditEntries.sort()) ||
    !same(fs.readdirSync(observation).sort(), observationEntries.sort()) ||
    !same(fs.readdirSync(journal).sort(), journalEntries.sort())
  )
    fail(
      "Subsequent dispatch, unbound journal or conflicting acceptance refuses current facts",
    );
  for (const [key, entry] of Object.entries(baseline))
    if (!key.startsWith("root/")) checkedRef(entry);
  if (
    fs.existsSync(path.join(dir, "isolated-scratch-qualification")) ||
    fs.existsSync(path.join(dir, "isolated-scratch-close")) ||
    fs.existsSync(path.join(dir, "observed-current.json"))
  )
    fail("Subsequent SDK dispatch/publication refuses retained acceptance");
  for (const name of [
    "isolated-admission-epoch.json",
    "queue-state.json",
    "instance.json",
    "active-epoch-succession.json",
  ])
    checkedRef(baseline["root/" + name]);
  const acceptedFile = path.join(observation, "retained-acceptance.json"),
    observedFile = path.join(dir, "observed-current.json");
  const accepted = {
    kind: "dead-epoch-current-observation",
    ...key,
    status: "complete",
    summary: result.summary,
    sdkRequestsSent: 1,
    nativeOutcome: "unknown",
    historicalOutcome: "unknown",
    modelValidation: "not_performed",
    rollbackVerification: "not_performed",
    recoveredFrom: result.files["result.json"],
    retainedEvidence: result.files,
    evaluator: ref(path.join(journal, "runtime.json")),
    ownerApproval: approvalRef,
    acceptanceSdkRequestsSent: 0,
  };
  if (!apply)
    return {
      ready: true,
      acceptancePerformed: false,
      sdkRequestsSent: 0,
      originalSdkRequestsSent: 1,
      historicalOutcome: "unknown",
      summary: result.summary,
    };
  if (!same(await client.call("queue-summary"), status))
    fail("Evaluator sequence changed before retained acceptance");
  const acceptanceStart = path.join(journal, "acceptance-start.json");
  files.exclusive(acceptanceStart, {
    kind: "retained-successor-acceptance-start",
    createdAtUtc: new Date().toISOString(),
    authority: authorityRef,
    approval: approvalRef,
    evaluator: ref(path.join(journal, "runtime.json")),
    ready: ref(path.join(journal, "complete.json")),
    owner,
    currentProcess: expected,
    originalEvidence: result.files,
    sdkRequestsSent: 0,
    originalSdkRequestsSent: 1,
    historicalOutcome: "unknown",
    admissionGuardsRetained: true,
  });
  freshProcess(ports, expected);
  guards();
  for (const entry of Object.values(result.files)) checkedRef(entry);
  files.exclusive(acceptedFile, accepted);
  files.exclusive(observedFile, {
    kind: "owner-bound-successor-current-facts",
    authority: authorityRef,
    currentInstance: result.currentInstance,
    sdkRequestsSent: 1,
    transportComplete: true,
    historicalOutcome: "unknown",
    files: {
      authority: authorityRef,
      result: ref(acceptedFile),
      intent: result.files["intent.json"],
      start: result.files["start.json"],
      wire: result.files["wire.json"],
      remote: result.files[path.basename(text(result.start["receipt"]))],
      raw: result.files["received-response.json"],
      originalResult: result.files["result.json"],
      evaluator: ref(path.join(journal, "runtime.json")),
      evaluatorReady: ref(path.join(journal, "complete.json")),
      approval: approvalRef,
    },
  });
  for (const name of ["recovery.lock", "atomic-migration.lock"]) {
    const file = path.join(client.dir, name);
    if (!same(read(file), guard))
      fail("Evaluator admission guard changed during release");
    files.exclusive(path.join(journal, "released-" + name + ".json"), guard);
    fs.unlinkSync(file);
  }
  const completion = {
    kind: "retained-successor-response-accepted",
    createdAtUtc: new Date().toISOString(),
    started: ref(acceptanceStart),
    acceptance: ref(acceptedFile),
    currentFacts: ref(observedFile),
    sdkRequestsSent: 0,
    originalSdkRequestsSent: 1,
    historicalOutcome: "unknown",
  };
  files.exclusive(path.join(journal, "acceptance-complete.json"), completion);
  return completion;
}

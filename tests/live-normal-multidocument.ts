import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  clientModule,
  config,
  identity,
  owned,
  broker,
  nativeState,
  parse,
  result,
  object,
  ownedCleanupSource,
  knownSettlement,
  runtimeRequire,
} from "./live-recovery-ports";
import type {
  OwnedDocument,
  LiveReport,
  Queue,
  Job,
  Result,
} from "./live-recovery-ports";
import {
  discoverOwnedUnsavedFixtureProofs,
  assertFencedClosedDocumentInventory,
  assertReceiptBoundDocumentInventory,
} from "./scenarios/fixture-provenance";
import type { OwnedUnsavedFixtureProof } from "./scenarios/fixture-provenance";
import { scenarioArtifactRoot } from "./scenarios/artifact-root";
import { NormalFixtureProducer } from "./scenarios/normal-fixture-producer";
const { QueueClient, inputFiles } = clientModule;
const { loadConfig } = config;
const { buildHash, processBirth } = identity;

export type NormalTraceRuntime = Pick<
  typeof import("../packages/node-adapters/src/telemetry/diagnostic-log"),
  "createDebugTraceContext" | "flushDebugTrace" | "readDebugTrace"
>;

export async function submitNormalCommand(
  queue: Queue,
  input: Record<string, unknown>,
  accepted: (job: Job) => void,
  directory: string,
  telemetry?: NormalTraceRuntime,
): Promise<Result> {
  let context: ReturnType<NormalTraceRuntime["createDebugTraceContext"]>;
  if (process.env["FMCAD_DEBUG_TRACE"] === "1") {
    try {
      telemetry ??= runtimeRequire(
        "./dist/node-adapters/telemetry/diagnostic-log",
      ) as NormalTraceRuntime;
      context = telemetry.createDebugTraceContext(
        String(input["requestId"]),
        queue.auth.clientId,
        "cli",
      );
    } catch {
      // Optional diagnostics must not change command admission.
    }
  }
  try {
    const job = await queue.submit(
      context ? { ...input, debugTrace: context } : input,
    );
    accepted(job);
    return await queue.wait(job.id);
  } finally {
    if (context && telemetry) {
      try {
        await telemetry.flushDebugTrace();
        fs.writeFileSync(
          path.join(directory, `debug-trace-${context.traceId}.json`),
          JSON.stringify(telemetry.readDebugTrace(context.traceId), null, 2),
          { mode: 0o600 },
        );
      } catch {
        // Retain the original success or failure even if trace export fails.
      }
    }
  }
}

export function normalInventoryExpression(group: boolean): string {
  const fileId = group ? "" : ",fileId=d.dataFile.id if d.dataFile else None";
  const key = group ? "d['id']" : "str(d['id'])";
  return `sorted([dict(id=d.creationId,name=d.name,saved=d.isSaved,modified=d.isModified${fileId}) for d in a.documents],key=lambda d:${key})`;
}

export function normalCloseSource(
  document: OwnedDocument,
  guardSource: string,
): string {
  const inventory = normalInventoryExpression(false)
    .replaceAll("dict(id=", "dict(creationId=")
    .replaceAll("d['id']", "d['creationId']");
  return `${guardSource}
before=${inventory}
assert d.close(False)
after=${inventory}
assert after == [row for row in before if row['creationId'] != ${JSON.stringify(document.creationId)}], 'Close changed another document'
print('FMCAD_RESULT '+json.dumps(dict(closed=True,creationId=${JSON.stringify(document.creationId)},inventoryFence=dict(version=1,before=before,after=after))))`;
}

/** Preserve user rows; only canonical, time-bound peer closes can remove a baseline row. */
export function assertNormalFinalInventory(
  beforeValue: unknown,
  afterValue: unknown,
  documents: readonly OwnedDocument[],
  closeReceipts: readonly {
    readonly requestId: string;
    readonly clientId?: string;
    readonly result?: unknown;
  }[],
  proofs: ReadonlyMap<string, OwnedUnsavedFixtureProof>,
  window: {
    readonly baselineFinishedAt: number;
    readonly restoreStartedAt: number;
  },
): void {
  const rows = (value: unknown) => {
    const snapshot = nativeState(value);
    const entries = snapshot.documents.map((row) => {
      const document = object(row);
      assert.ok(
        document["fileId"] === null ||
          (typeof document["fileId"] === "string" && document["fileId"]),
      );
      return document;
    });
    assert.equal(
      new Set(entries.map((row) => row["id"])).size,
      entries.length,
      "Duplicate document identity",
    );
    return {
      snapshot,
      entries,
      byId: new Map(entries.map((row) => [row["id"], row])),
    };
  };
  const before = rows(beforeValue),
    after = rows(afterValue),
    jobs = new Set<string>();
  assert.ok(
    Number.isFinite(window.baselineFinishedAt) &&
      Number.isFinite(window.restoreStartedAt) &&
      window.baselineFinishedAt <= window.restoreStartedAt,
  );
  assert.equal(
    documents.length,
    closeReceipts.length,
    "Every own document needs an exact close receipt",
  );
  assert.equal(
    new Set(documents.map((d) => d.creationId)).size,
    documents.length,
  );
  const closed = new Set<string>();
  for (const receipt of closeReceipts) {
    assert.ok(receipt.requestId && receipt.clientId);
    assert.ok(knownSettlement([receipt.result]));
    const result = object(receipt.result),
      job = object(result["job"]);
    assert.equal(job["requestId"], receipt.requestId);
    assert.equal(job["clientId"], receipt.clientId);
    assert.equal(job["state"], "succeeded");
    assert.ok(
      typeof job["id"] === "string" && job["id"] && !jobs.has(job["id"]),
    );
    jobs.add(job["id"]);
    assert.equal(typeof result["stdout"], "string");
    const markers = (result["stdout"] as string)
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("FMCAD_RESULT "));
    assert.ok(
      markers.length === 1 || markers.length === 2,
      "Own close output has ambiguous markers",
    );
    if (markers.length === 2)
      assert.deepEqual(parse(markers[1]!.slice("FMCAD_RESULT ".length)), {
        success: true,
        helperCallsOnly: [],
      });
    const value = parse(markers[0]!.slice("FMCAD_RESULT ".length));
    assert.equal(value["closed"], true);
    const document = documents.find(
      (d) => d.creationId === value["creationId"],
    );
    assert.ok(
      document && !closed.has(document.creationId),
      "Close receipt is foreign or reused",
    );
    closed.add(document.creationId);
    assert.equal(
      before.byId.has(document.creationId),
      false,
      "Own fixture predates this run",
    );
    assert.equal(
      after.byId.has(document.creationId),
      false,
      "Own fixture remains open",
    );
  }
  const visiblePeers = new Map(
    [...proofs].filter(
      ([, proof]) => proof.state === "open" || proof.state === "retained",
    ),
  );
  const closedBaseline = new Set<string>();
  for (const row of before.entries) {
    const current = after.byId.get(row["id"]);
    if (current) {
      if (visiblePeers.has(String(row["id"]))) continue;
      assert.deepEqual(
        current,
        row,
        "Baseline document identity or state changed",
      );
      continue;
    }
    const proof = proofs.get(String(row["id"]));
    assert.equal(
      proof?.state,
      "closed",
      "Baseline document disappeared without a canonical close",
    );
    const close = proof?.supplementalClose ?? proof?.closeReceipt;
    assert.ok(proof && close, "Missing time-bound close proof");
    assert.ok(
      close.startedAt >= window.baselineFinishedAt &&
        close.finishedAt <= window.restoreStartedAt &&
        close.finishedAt >= close.startedAt,
      "Peer close is stale or outside this run",
    );
    assert.ok(!jobs.has(close.jobId), "Close receipt was reused");
    jobs.add(close.jobId);
    assert.deepEqual(proof.document, {
      creationId: row["id"],
      name: row["name"],
    });
    assertFencedClosedDocumentInventory(
      close.inventoryFence["before"],
      close.inventoryFence["after"],
      proof.document,
      "Peer close changed another document",
    );
    assert.ok(Array.isArray(close.inventoryFence["before"]));
    const target = close.inventoryFence["before"]
      .map(object)
      .find((r) => r["creationId"] === row["id"]);
    assert.ok(target);
    assert.deepEqual(
      {
        id: target["creationId"],
        name: target["name"],
        fileId: target["fileId"],
        saved: target["saved"],
        modified: target["modified"],
      },
      row,
      "Peer target drifted since baseline",
    );
    closedBaseline.add(String(row["id"]));
  }
  const canonicalRows = (entries: Record<string, unknown>[]) =>
    entries.map(({ id, ...row }) => ({ ...row, creationId: id }));
  assertReceiptBoundDocumentInventory(
    canonicalRows(
      before.entries.filter((row) => !closedBaseline.has(String(row["id"]))),
    ),
    canonicalRows(after.entries),
    visiblePeers,
    "A user row changed or a new document lacks authenticated visible-peer provenance",
  );
  assert.equal(
    after.snapshot.active,
    before.snapshot.active,
    "Original active document was not restored",
  );
}

interface MultiDocumentGroup {
  readonly version: 1;
  readonly id: string;
  readonly protocol: string;
  readonly buildHash: string;
  readonly ownerCount: number;
  readonly baseline: ReturnType<typeof nativeState>;
  readonly runners: {
    readonly id: string;
    readonly documentNames: readonly string[];
  }[];
}

function readGroup(file: string, runId: string): MultiDocumentGroup {
  const resolved = path.resolve(file),
    stat = fs.lstatSync(resolved);
  assert.ok(stat.isFile() && !stat.isSymbolicLink());
  assert.ok(stat.size <= 1024 * 1024, "Multi-runner manifest is bounded");
  const value = parse(
    fs.readFileSync(resolved, "utf8"),
  ) as unknown as MultiDocumentGroup;
  assert.equal(value.version, 1);
  assert.match(value.id, /^[a-f0-9-]{36}$/u);
  assert.ok([1, 2, 10].includes(value.ownerCount));
  assert.ok(Array.isArray(value.runners) && value.runners.length >= 2);
  assert.equal(
    new Set(value.runners.map((runner) => runner.id)).size,
    value.runners.length,
  );
  assert.equal(
    value.runners.some((runner) => runner.id === runId),
    true,
    "Runner ID must be registered in the group manifest",
  );
  for (const runner of value.runners) {
    assert.match(runner.id, /^[a-f0-9-]{36}$/u);
    assert.equal(runner.documentNames.length, value.ownerCount);
    assert.equal(
      new Set(runner.documentNames).size,
      runner.documentNames.length,
    );
    assert.ok(
      runner.documentNames.every(
        (name) => typeof name === "string" && name.startsWith("FMCAD_MULTI_"),
      ),
    );
  }
  nativeState(value.baseline);
  return value;
}

function assertGroupSnapshot(
  baseline: ReturnType<typeof nativeState>,
  observed: ReturnType<typeof nativeState>,
  expectedNames: readonly string[],
  ownNames: readonly string[],
) {
  const priorIds = new Set(baseline.documents.map((document) => document.id));
  const currentById = new Map(
    observed.documents.map((document) => [document.id, document]),
  );
  for (const document of baseline.documents)
    assert.deepEqual(
      currentById.get(document.id),
      document,
      "Original document identity or state changed during independent runners",
    );
  const extras = observed.documents.filter(
    (document) => !priorIds.has(document.id),
  );
  const allowedNames = new Set(expectedNames);
  assert.ok(
    extras.every((document) => allowedNames.has(document.name)),
    "Only registered multi-runner fixtures may exist beside the baseline",
  );
  assert.ok(
    extras.every((document) => !ownNames.includes(document.name)),
    "This runner left one of its own documents open",
  );
  if (observed.active !== baseline.active && observed.active !== null) {
    const active = currentById.get(observed.active);
    assert.ok(
      active && allowedNames.has(active.name),
      "Active document must be original or one of the registered live fixtures",
    );
  }
  return {
    originalDocumentsPreserved: baseline.documents.length,
    peerDocumentsObserved: extras.map((document) => ({
      id: document.id,
      name: document.name,
    })),
    activeIsOriginal: observed.active === baseline.active,
  };
}

async function awaitGroupStart(
  groupFile: string,
  runId: string,
  build: string,
): Promise<void> {
  const readyFile = process.env["FMCAD_MULTIDOC_READY_FILE"],
    startFile = process.env["FMCAD_MULTIDOC_START_FILE"],
    abortFile = process.env["FMCAD_MULTIDOC_ABORT_FILE"];
  if (!readyFile && !startFile && !abortFile) return;
  assert.ok(
    readyFile && startFile && abortFile,
    "Incomplete runner gate paths",
  );
  const root = path.dirname(path.resolve(groupFile));
  for (const file of [readyFile, startFile, abortFile]) {
    const relative = path.relative(root, path.resolve(file));
    assert.ok(
      relative !== "" &&
        !relative.startsWith(".." + path.sep) &&
        relative !== ".." &&
        !path.isAbsolute(relative),
      "Runner gate files must remain under the group root",
    );
  }
  fs.writeFileSync(
    readyFile,
    JSON.stringify({ runId, pid: process.pid, buildHash: build }) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  for (;;) {
    if (fs.existsSync(abortFile))
      throw new Error("Independent runner group aborted before SDK work");
    if (fs.existsSync(startFile)) {
      const stat = fs.lstatSync(startFile);
      assert.ok(stat.isFile() && !stat.isSymbolicLink());
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function main() {
  assert.ok(process.argv.includes("--run"), "Explicit --run required");
  const resumeFile = process.env["FMCAD_MULTIDOC_RESUME_REPORT"];
  const resume = resumeFile ? parse(fs.readFileSync(resumeFile, "utf8")) : null;
  const groupFile = process.env["FMCAD_MULTIDOC_GROUP_FILE"];
  const runId = process.env["FMCAD_MULTIDOC_RUN_ID"] || randomUUID();
  assert.match(runId, /^[a-f0-9-]{36}$/u);
  assert.ok(!groupFile || !resume, "Grouped runs do not resume prior reports");
  const root = process.env["FMCAD_MULTIDOC_RUN_ROOT"]
    ? path.resolve(process.env["FMCAD_MULTIDOC_RUN_ROOT"])
    : path.join("/tmp/opencode/fmcad-normal-multidocument", runId);
  const ownerCount = process.env["FMCAD_MULTIDOC_OWNER_COUNT"]
    ? Number(process.env["FMCAD_MULTIDOC_OWNER_COUNT"])
    : 2;
  assert.ok(
    Number.isSafeInteger(ownerCount) && [1, 2, 10].includes(ownerCount),
  );
  fs.mkdirSync(root, { recursive: true });
  const { cfg } = loadConfig({ routing: "queue" });
  const group = groupFile ? readGroup(groupFile, runId) : undefined;
  const groupRunner = group?.runners.find((runner) => runner.id === runId);
  if (group) {
    assert.ok(groupRunner);
    assert.equal(cfg.backend, group.protocol);
    assert.equal(buildHash(), group.buildHash);
    assert.equal(group.ownerCount, ownerCount);
    assert.ok(
      group.baseline.active !== null,
      "Multi-process lifecycle proof requires an original active document that can be restored",
    );
    const groupRoot = path.dirname(path.resolve(groupFile!));
    const relative = path.relative(groupRoot, root);
    assert.ok(
      relative !== "" &&
        !relative.startsWith(".." + path.sep) &&
        relative !== ".." &&
        !path.isAbsolute(relative),
      "Runner evidence must remain under its group directory",
    );
  }
  const report: LiveReport = {
    runId,
    buildHash: buildHash(),
    status: "running",
    processIdentity: { pid: process.pid, birth: processBirth() },
    ...(group && groupRunner
      ? {
          processGroup: {
            id: group.id,
            runnerId: runId,
            ownerCount,
            expectedDocumentNames: [...groupRunner.documentNames],
          },
        }
      : {}),
    receipts: [],
    documents: [],
  };
  // Only new qualified ADDIN nongroup runs adopt the canonical producer identity.
  // Historical reports, grouped requests and resume credentials are unchanged.
  const producer =
    !group && !resume && cfg.backend === "addin"
      ? new NormalFixtureProducer(
          scenarioArtifactRoot(path.resolve(__dirname, "../.."), "fusion"),
          runId,
          ownerCount,
          report.buildHash,
        )
      : undefined;
  const platform = createRequire(path.resolve(__dirname, "../../package.json"))(
    "./src/dist/config-platform",
  ) as typeof import("../packages/node-adapters/src/config-platform/platform");
  const persist = () => {
    const file = path.join(root, "report.json"),
      temporary = file + ".new";
    fs.writeFileSync(temporary, JSON.stringify(report, null, 2) + "\n", {
      flag: "w",
      mode: 0o600,
    });
    fs.renameSync(temporary, file);
  };
  const clients = Array.from(
    { length: ownerCount },
    (_, index) =>
      new QueueClient(
        producer?.owners[index]?.clientId ??
          "live:multidocument:" + (resume?.["runId"] || runId) + ":" + index,
        {
          cfg: { ...cfg, queue: { ...cfg.queue, autoStart: false } },
          existingCredentialsOnly: !!resume,
        },
      ),
  );
  // Read-only observations interleave with both owners' polling. This is
  // sampled live evidence, not a replacement for the scheduler invariant.
  report.executorObservations = [];
  for (const queue of clients) {
    const raw = queue.call.bind(queue);
    queue.call = async (action, values) => {
      const value = await raw(action, values);
      if (action === "submit" || action === "result") {
        const control = object(await raw("control-status"));
        const count = control["activeOperations"];
        assert.ok(
          typeof count === "number" &&
            Number.isSafeInteger(count) &&
            count >= 0,
        );
        report.executorObservations?.push({
          clientId: queue.auth.clientId,
          at: new Date().toISOString(),
          activeOperations: count,
        });
      }
      return value;
    };
  }
  async function script(
    index: number,
    phase: string,
    body: string,
    document?: OwnedDocument,
  ): Promise<Record<string, unknown>> {
    const queue = clients[index];
    assert.ok(queue);
    const requestId =
      producer?.begin(index, phase) ?? runId + ":" + index + ":" + phase;
    if (producer && phase === "create")
      body += producer.creationTail(index, requestId, (file) =>
        platform.toWindowsPath(file, platform.detectPlatform()),
      );
    if (producer && phase === "close") {
      assert.ok(document);
      body += producer.closeTail(document);
    }
    const file = path.join(root, index + "-" + phase + ".py");
    fs.writeFileSync(
      file,
      "import adsk.core, adsk.fusion, json, time\nfrom typing import cast\nDOC_NAME = None\ndef run(context: str):\n" +
        body
          .split("\n")
          .map((line) => "    " + line)
          .join("\n") +
        "\n",
      { flag: "wx" },
    );
    const argv = [
      "run",
      file,
      ...(document
        ? [
            "--doc",
            document.name,
            "--doc-id",
            document.creationId,
            "--helpers",
            "cad-v1",
          ]
        : []),
    ];
    report.receipts.push({ requestId, phase, clientId: queue.auth.clientId });
    persist();
    let acceptedJob: Job | undefined;
    const receiptIndex = report.receipts.findIndex(
      (row) => row.requestId === requestId,
    );
    const result = await submitNormalCommand(
      queue,
      {
        requestId,
        kind: "command",
        argv,
        cwd: root,
        timeoutMs: 180000,
        backend: cfg.backend,
        buildHash: report.buildHash,
        inputFiles: inputFiles(argv, root),
        description: "Owned multi-document native test: " + phase,
      },
      (job) => {
        acceptedJob = job;
        report.receipts[receiptIndex] = {
          requestId,
          phase,
          clientId: queue.auth.clientId,
          job,
        };
        persist();
      },
      root,
    );
    assert.ok(acceptedJob);
    const job = acceptedJob;
    // Retain the original response even when recovery deliberately omits an
    // execution settlement envelope. Missing evidence never permits cleanup.
    report.receipts[receiptIndex] = {
      requestId,
      phase,
      clientId: queue.auth.clientId,
      job,
      result,
    };
    persist();
    if (
      result.job?.id !== job.id ||
      result.job.requestId !== requestId ||
      result.job.clientId !== queue.auth.clientId ||
      !knownSettlement([result])
    )
      throw new Error(
        "Original multidocument request identity or settlement differs; retain both fixtures",
      );
    assert.equal(result.job.state, "succeeded", JSON.stringify(result));
    if (producer)
      await producer.publish(index, requestId, job.id, file, () =>
        queue.call("result", { jobId: job.id }),
      );
    const marker = result.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith("FMCAD_RESULT "));
    assert.ok(marker, "Missing native result marker: " + result.stdout);
    return parse(marker.slice("FMCAD_RESULT ".length));
  }
  const snapshot = (phase = "baseline") =>
    script(
      0,
      phase,
      `a=adsk.core.Application.get()
print('FMCAD_RESULT '+json.dumps(dict(active=a.activeDocument.creationId if a.activeDocument else None,
    documents=${normalInventoryExpression(!!group)})))`,
    );
  const guard = (document: OwnedDocument) => `started=time.perf_counter()
a=adsk.core.Application.get()
owned=[d for d in a.documents if d.creationId==${JSON.stringify(document.creationId)}]
assert len(owned)==1 and owned[0].name==${JSON.stringify(document.name)} and not owned[0].isSaved
d=owned[0]
design=cast(adsk.fusion.Design, d.products.itemByProductType('DesignProductType'))
assert design is not None`;
  try {
    await Promise.all(
      clients.map((client) => client.register({ autoStart: false })),
    );
    const first = clients[0];
    assert.ok(first);
    report.broker = broker(await first.call("queue-summary"));
    assert.equal(report.broker.buildHash, report.buildHash);
    assert.equal(report.broker.admissionScope, "normal-multidocument");
    if (group) await awaitGroupStart(groupFile!, runId, report.buildHash);
    if (resume) {
      // Continue only this fixture's two proven creations and locally rejected
      // writes. This is not a generic retry path for arbitrary failed workflows.
      assert.equal(resume["buildHash"], report.buildHash);
      assert.equal(
        ownerCount,
        2,
        "Historical recovery reports have two owners",
      );
      const documents = resume["documents"],
        receipts = resume["receipts"];
      assert.ok(
        Array.isArray(documents) &&
          documents.length === ownerCount &&
          Array.isArray(receipts),
      );
      for (let index = 0; index < 2; index++) {
        const queue = clients[index];
        assert.ok(queue);
        const created = receipts
          .map((item) => parse(JSON.stringify(item)))
          .find(
            (row) =>
              row["requestId"] === resume["runId"] + ":" + index + ":create",
          );
        const write = receipts
          .map((item) => parse(JSON.stringify(item)))
          .find(
            (row) =>
              row["requestId"] === resume["runId"] + ":" + index + ":write",
          );
        assert.ok(created && write);
        const creationRecord = result(created["result"]),
          rejectionRecord = result(write["result"]);
        const creation = result(
          await queue.call("result", { jobId: creationRecord.job.id }),
        );
        const rejected = result(
          await queue.call("result", { jobId: rejectionRecord.job.id }),
        );
        assert.equal(creation.job.state, "succeeded");
        assert.equal(creation.execution.sdkSettled, true);
        assert.equal(rejected.job.state, "failed");
        assert.equal(rejected.job.code, "LOCAL_EXECUTION_FAILED");
        assert.equal(rejected.execution.mayHaveMutated, false);
        assert.equal(rejected.execution.sdkSettled, true);
        assert.equal(rejected.job.dispatch?.rpcCount || 0, 0);
      }
      assert.ok(resumeFile);
      report.continues = resumeFile;
      report.before = nativeState(resume["before"]);
      report.documents = documents.map(owned);
    } else {
      report.before = group
        ? group.baseline
        : nativeState(await snapshot("baseline"));
      producer?.baseline(
        report.before.documents.map(({ id, ...row }) => ({
          ...row,
          creationId: id,
        })),
      );
      if (group) {
        const observed = nativeState(await snapshot("group-before"));
        assert.ok(groupRunner);
        const expected = group.runners.flatMap(
          (runner) => runner.documentNames,
        );
        report.processGroup!.observedBefore = observed;
        assertGroupSnapshot(
          report.before,
          observed,
          expected,
          groupRunner.documentNames,
        );
      }
      persist();
      // All clients have unique owner identities; SDK turns still use the one broker queue.
      const created = await Promise.allSettled(
        clients.map((client, index) => {
          const name =
            groupRunner?.documentNames[index] ??
            "FMCAD_MULTI_" + runId.replaceAll("-", "_") + "_" + index;
          return script(
            index,
            "create",
            `a=adsk.core.Application.get()
assert not any(d.name==${JSON.stringify(name)} for d in a.documents)
d=a.documents.add(cast(adsk.core.DocumentTypes, adsk.core.DocumentTypes.FusionDesignDocumentType))
d.name=${JSON.stringify(name)}
print('FMCAD_RESULT '+json.dumps(dict(name=d.name,creationId=d.creationId,saved=d.isSaved)))`,
          ).then((value) => {
            const document = owned(value);
            report.documents[index] = document;
            persist();
            return document;
          });
        }),
      );
      for (const result of created)
        if (result.status === "rejected") throw result.reason;
    }
    assert.equal(report.documents.length, ownerCount);
    assert.ok(report.documents.every((document) => document));
    assert.equal(
      new Set(report.documents.map((document) => document.creationId)).size,
      ownerCount,
    );
    report.writes = await Promise.all(
      report.documents.map((document, index) =>
        script(
          index,
          "write",
          `${guard(document)}
assert design.userParameters.count==0
p=design.userParameters.add('OwnedCounter',adsk.core.ValueInput.createByString('${index + 2} mm'),'mm','multi-client regression')
assert p is not None
print('FMCAD_RESULT '+json.dumps(dict(creationId=d.creationId,count=design.userParameters.count,value=p.value,started=started,finished=time.perf_counter())))`,
          document,
        ),
      ),
    );
    report.readbacks = await Promise.all(
      report.documents.map((document, index) =>
        script(
          index,
          "read",
          `${guard(document)}
p=design.userParameters.itemByName('OwnedCounter')
assert p is not None and design.userParameters.count==1 and abs(p.value-${(index + 2) / 10})<1e-9
print('FMCAD_RESULT '+json.dumps(dict(creationId=d.creationId,count=design.userParameters.count,value=p.value,started=started,finished=time.perf_counter())))`,
          document,
        ),
      ),
    );
    // The intervals cover these owners' script bodies on Fusion's monotonic
    // clock, not local preparation or work from unrelated clients.
    report.sdkIntervals = [...report.writes, ...report.readbacks].map(
      (value) => {
        const interval = object(value),
          started = interval["started"],
          finished = interval["finished"];
        assert.ok(typeof started === "number" && Number.isFinite(started));
        assert.ok(
          typeof finished === "number" &&
            Number.isFinite(finished) &&
            finished > started,
        );
        assert.equal(typeof interval["creationId"], "string");
        return {
          creationId: String(interval["creationId"]),
          started,
          finished,
        };
      },
    );
    const events = report.sdkIntervals
      .flatMap((interval) => [
        { time: interval.started, delta: 1 },
        { time: interval.finished, delta: -1 },
      ])
      .sort(
        (left, right) => left.time - right.time || left.delta - right.delta,
      );
    let concurrent = 0,
      maximum = 0;
    for (const event of events) {
      concurrent += event.delta;
      maximum = Math.max(maximum, concurrent);
    }
    assert.equal(
      maximum,
      1,
      "Owned SDK script bodies overlapped in the same Fusion process",
    );
    assert.equal(concurrent, 0);
    report.maxOwnScriptConcurrency = maximum;
    // Cleanup is serial and exact. No uncertain mutation is retried or closed.
    assert.ok(report.before);
    report.cleanup = [];
    for (let index = 0; index < ownerCount; index++) {
      const document = report.documents[index];
      assert.ok(document);
      report.cleanup.push(
        await script(
          index,
          "close",
          group
            ? `${guard(document)}\n${ownedCleanupSource(document, report.before.active, "FMCAD_RESULT ")}`
            : normalCloseSource(document, guard(document)),
          document,
        ),
      );
    }
    assert.ok(report.before);
    report.after = nativeState(
      await script(
        0,
        "restore",
        `a=adsk.core.Application.get()
previous=[d for d in a.documents if d.creationId==${report.before.active === null ? "None" : JSON.stringify(report.before.active)}]
if previous: assert previous[0].activate()
print('FMCAD_RESULT '+json.dumps(dict(active=a.activeDocument.creationId if a.activeDocument else None,
    documents=${normalInventoryExpression(!!group)})))`,
      ),
    );
    if (group) {
      assert.ok(groupRunner);
      report.processGroup!.groupAudit = assertGroupSnapshot(
        report.before,
        report.after,
        group.runners.flatMap((runner) => runner.documentNames),
        groupRunner.documentNames,
      );
      assert.ok(
        report.cleanup.every(
          (receipt) =>
            object(receipt)["closed"] === true &&
            (report.before!.active === null ||
              object(receipt)["active"] === report.before!.active),
        ),
        "Every owned close receipt must restore the shared original active document",
      );
    } else {
      const baseline = report.receipts.find(
        (receipt) => receipt.phase === "baseline",
      )?.result;
      const restore = report.receipts.find(
        (receipt) => receipt.phase === "restore",
      )?.result;
      const baselineFinishedAt = object(object(baseline)["job"])["finishedAt"];
      const restoreStartedAt = object(object(restore)["job"])["startedAt"];
      assert.ok(
        typeof baselineFinishedAt === "number" &&
          typeof restoreStartedAt === "number",
      );
      const peers = discoverOwnedUnsavedFixtureProofs(
        scenarioArtifactRoot(path.resolve(__dirname, "../.."), "fusion"),
        {
          identity: "fusion:addin:" + report.buildHash,
          mode: "fusion",
          protocol: "addin",
          qualification: "broker",
        },
      );
      assertNormalFinalInventory(
        report.before,
        report.after,
        report.documents,
        report.receipts.filter((receipt) => receipt.phase === "close"),
        peers,
        { baselineFinishedAt, restoreStartedAt },
      );
    }
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.error = String(error instanceof Error ? error.stack : error);
    if (report.before) {
      const allSettled = knownSettlement(
        report.receipts.map((receipt) => receipt.result),
      );
      if (!allSettled)
        report.cleanupDeferredReason =
          "Original work has no known settled result; retain exact fixture, never replay or close uncertain work";
      else {
        const missingSlots = Array.from(
            { length: ownerCount },
            (_, index) => index,
          ).filter((index) => !report.documents[index]),
          provenUncreated = (index: number): boolean => {
            const queue = clients[index],
              requestId = producer
                ? report.receipts.find(
                    (receipt) =>
                      receipt.clientId === queue?.auth.clientId &&
                      receipt.phase === "create",
                  )?.requestId
                : runId + ":" + index + ":create",
              matches = report.receipts.filter(
                (receipt) => receipt.requestId === requestId,
              );
            if (!queue || matches.length !== 1) return false;
            const receipt = matches[0],
              failed = receipt?.result;
            return !!(
              receipt &&
              receipt.phase === "create" &&
              receipt.clientId === queue.auth.clientId &&
              receipt.job &&
              receipt.job.id === failed?.job.id &&
              receipt.job.requestId === requestId &&
              receipt.job.clientId === queue.auth.clientId &&
              failed &&
              failed.job.state === "failed" &&
              failed.job.requestId === requestId &&
              failed.job.clientId === queue.auth.clientId &&
              failed.execution.sdkSettled === true &&
              failed.execution.mayHaveMutated === false
            );
          };
        const uncertainSlots = missingSlots.filter(
          (index) => !provenUncreated(index),
        );
        if (uncertainSlots.length)
          report.cleanupDeferredReason =
            "Create slot(s) " +
            uncertainSlots.join(", ") +
            " lack an exact terminal no-mutation receipt; retain unknown products and skip failure cleanup";
        else {
          try {
            const first = clients[0];
            assert.ok(first);
            const status = object(await first.call("queue-summary")),
              control = object(status["control"]);
            if (status["blocked"] || status["held"] || control["unresolved"])
              report.cleanupDeferredReason =
                "Shared executor is uncertain; no cleanup submitted";
            else {
              report.failureCleanup = [];
              report.failureCleanupErrors = [];
              for (let index = 0; index < ownerCount; index++) {
                const document = report.documents[index];
                if (!document) continue;
                try {
                  report.failureCleanup.push(
                    await script(
                      index,
                      "failure-close",
                      ownedCleanupSource(
                        document,
                        report.before.active,
                        "FMCAD_RESULT ",
                      ),
                    ),
                  );
                } catch (cleanupError) {
                  const message = String(
                    cleanupError instanceof Error
                      ? cleanupError.stack
                      : cleanupError,
                  );
                  report.failureCleanupErrors.push({
                    creationId: document.creationId,
                    message,
                  });
                  const requestId = producer
                      ? report.receipts.find(
                          (receipt) =>
                            receipt.clientId ===
                              clients[index]?.auth.clientId &&
                            receipt.phase === "failure-close",
                        )?.requestId
                      : runId + ":" + index + ":failure-close",
                    receipts = report.receipts.filter(
                      (receipt) => receipt.requestId === requestId,
                    ),
                    receipt = receipts[0],
                    queue = clients[index],
                    submittedJob = receipt?.job,
                    closeResult = receipt?.result;
                  const settledClose =
                    receipts.length === 1 &&
                    !!receipt &&
                    receipt.phase === "failure-close" &&
                    !!queue &&
                    receipt.clientId === queue.auth.clientId &&
                    !!submittedJob &&
                    submittedJob.id === closeResult?.job.id &&
                    submittedJob.requestId === requestId &&
                    submittedJob.clientId === queue.auth.clientId &&
                    !!closeResult &&
                    closeResult.job.requestId === requestId &&
                    closeResult.job.clientId === queue.auth.clientId &&
                    knownSettlement([closeResult]);
                  if (!settledClose) {
                    report.cleanupDeferredReason =
                      "Failure cleanup result for creation ID " +
                      document.creationId +
                      " is uncertain; later owned documents were retained";
                    break;
                  }
                }
              }
              if (report.failureCleanupErrors.length)
                report.cleanupError = report.failureCleanupErrors
                  .map((entry) => entry.creationId + ": " + entry.message)
                  .join("\n");
            }
          } catch (cleanupError) {
            report.cleanupError = String(
              cleanupError instanceof Error ? cleanupError.stack : cleanupError,
            );
          }
        }
      }
    }
    throw error;
  } finally {
    producer?.finish(report.status === "passed");
    clients.forEach((client) => client.dispose());
    report.finishedAt = new Date().toISOString();
    persist();
    console.log("MULTIDOCUMENT_REPORT " + path.join(root, "report.json"));
  }
}
export { main };
if (require.main === module)
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });

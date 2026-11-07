import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
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
} from "./live-recovery-ports";
import type { OwnedDocument, LiveReport } from "./live-recovery-ports";
const { QueueClient, inputFiles } = clientModule;
const { loadConfig } = config;
const { buildHash } = identity;

async function main() {
  assert.ok(process.argv.includes("--run"), "Explicit --run required");
  const resumeFile = process.env["FMCAD_MULTIDOC_RESUME_REPORT"];
  const resume = resumeFile ? parse(fs.readFileSync(resumeFile, "utf8")) : null;
  const runId = randomUUID(),
    root = path.join("/tmp/opencode/fmcad-normal-multidocument", runId);
  fs.mkdirSync(root, { recursive: true });
  const { cfg } = loadConfig({ routing: "queue" });
  const report: LiveReport = {
    runId,
    buildHash: buildHash(),
    status: "running",
    receipts: [],
    documents: [],
  };
  const persist = () =>
    fs.writeFileSync(
      path.join(root, "report.json"),
      JSON.stringify(report, null, 2),
    );
  const clients = [0, 1].map(
    (index) =>
      new QueueClient(
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
    const requestId = runId + ":" + index + ":" + phase;
    report.receipts.push({ requestId, phase, clientId: queue.auth.clientId });
    persist();
    const job = await queue.submit({
      requestId,
      kind: "command",
      argv,
      cwd: root,
      timeoutMs: 180000,
      backend: cfg.backend,
      buildHash: report.buildHash,
      inputFiles: inputFiles(argv, root),
      description: "Owned multi-document native test: " + phase,
    });
    const result = await queue.wait(job.id);
    report.receipts[
      report.receipts.findIndex((row) => row.requestId === requestId)
    ] = { requestId, phase, job, result };
    persist();
    assert.equal(result.job.state, "succeeded", JSON.stringify(result));
    const marker = result.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith("FMCAD_RESULT "));
    assert.ok(marker, "Missing native result marker: " + result.stdout);
    return parse(marker.slice("FMCAD_RESULT ".length));
  }
  const snapshot = () =>
    script(
      0,
      "baseline",
      `a=adsk.core.Application.get()
print('FMCAD_RESULT '+json.dumps(dict(active=a.activeDocument.creationId if a.activeDocument else None,
    documents=sorted([dict(id=d.creationId,name=d.name,saved=d.isSaved,modified=d.isModified) for d in a.documents],key=lambda d:d['id']))))`,
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
    if (resume) {
      // Continue only this fixture's two proven creations and locally rejected
      // writes. This is not a generic retry path for arbitrary failed workflows.
      assert.equal(resume["buildHash"], report.buildHash);
      const documents = resume["documents"],
        receipts = resume["receipts"];
      assert.ok(
        Array.isArray(documents) &&
          documents.length === 2 &&
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
      report.before = nativeState(await snapshot());
      persist();
      // Both requests use the same physical queue; only preparation is parallel.
      const created = await Promise.allSettled(
        clients.map((client, index) => {
          const name =
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
    assert.ok(report.documents[0] && report.documents[1]);
    assert.notEqual(
      report.documents[0].creationId,
      report.documents[1].creationId,
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
    // The intervals cover these two owners' script bodies on the same Fusion
    // monotonic clock, not local preparation or work from unrelated clients.
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
    report.cleanup = [];
    for (let index = 0; index < 2; index++) {
      const document = report.documents[index];
      assert.ok(document);
      report.cleanup.push(
        await script(
          index,
          "close",
          `${guard(document)}
assert d.close(False)
print('FMCAD_RESULT '+json.dumps(dict(closed=True,creationId=${JSON.stringify(document.creationId)})))`,
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
    documents=sorted([dict(id=d.creationId,name=d.name,saved=d.isSaved,modified=d.isModified) for d in a.documents],key=lambda d:d['id']))))`,
      ),
    );
    assert.deepEqual(report.after, report.before);
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.error = String(error instanceof Error ? error.stack : error);
    if (report.documents.length && report.before) {
      const allSettled = knownSettlement(
        report.receipts.map((receipt) => receipt.result),
      );
      if (!allSettled)
        report.cleanupDeferredReason =
          "Original work has no known settled result; retain exact fixture, never replay or close uncertain work";
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
            for (let index = 0; index < report.documents.length; index++) {
              const document = report.documents[index];
              assert.ok(document);
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
            }
          }
        } catch (cleanupError) {
          report.cleanupError = String(
            cleanupError instanceof Error ? cleanupError.stack : cleanupError,
          );
        }
      }
    }
    throw error;
  } finally {
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

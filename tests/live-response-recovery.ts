// Fault injection is confined to this client's response boundary. The broker,
// physical transport and Fusion are never interrupted or replayed.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import NativeModule from "node:module";
import {
  runtime,
  clientModule as installedClient,
  config,
  identity,
  owned,
  broker,
  parse,
  result,
  object,
  ownedCleanupSource,
  knownSettlement,
} from "./live-recovery-ports";
import type {
  ClientModule,
  OwnedDocument,
  Result,
  Job,
} from "./live-recovery-ports";
const clientModule = path.join(runtime, "src/queue-client.js");
const { final, inputFiles } = installedClient;
const { loadConfig } = config;
const { buildHash } = identity;

interface Report {
  id: string;
  name: string;
  clientId: string;
  clientSourceSha256: string;
  mutationsSubmitted: number;
  dropped: string[];
  native: boolean;
  mutationJob?: Job;
  originalResult?: Result;
  receipts?: Result[];
  broker?: { readonly buildHash: string; readonly admissionScope: string };
  before?: Record<string, unknown>;
  identity?: OwnedDocument;
  mutation?: Record<string, unknown>;
  automaticRecovery?: boolean;
  clientError?: { message: string; code?: unknown };
  manualObservation?: unknown;
  readback?: Record<string, unknown>;
  cleanup?: Record<string, unknown>;
  after?: Record<string, unknown>;
  status?: string;
  error?: string;
  finishedAt?: string;
  attemptedMutation?: boolean;
  failureCleanup?: Record<string, unknown>;
  cleanupError?: string;
  cleanupDeferredReason?: string;
}

async function main() {
  assert.ok(process.argv.includes("--run"), "Explicit --run required");
  const id = randomUUID(),
    name = "FMCAD_ACK_" + id.replaceAll("-", "_");
  const clientId = "live:response-recovery:" + id;
  const { cfg } = loadConfig({ routing: "queue" });
  // An immutable copy of the pre-fix client can be tested against the same
  // installed broker. This changes only this process, never shared runtime bytes.
  const clientFile =
    process.env["FMCAD_RECOVERY_CLIENT_SOURCE"] || clientModule;
  const clientSource = fs.readFileSync(clientFile, "utf8");
  const Module = NativeModule as unknown as new (
    filename: string,
    parent: NodeModule,
  ) => {
    filename: string;
    paths: string[];
    exports: ClientModule;
    _compile(source: string, filename: string): void;
  };
  const loaded = new Module(clientModule, module);
  loaded.filename = clientModule;
  loaded.paths = module.paths;
  loaded._compile(clientSource, loaded.filename);
  const queue = new loaded.exports.QueueClient(clientId, {
    cfg: { ...cfg, queue: { ...cfg.queue, autoStart: false } },
  });
  const raw = queue.call.bind(queue);
  const directory = path.resolve(
    process.env["FMCAD_RECOVERY_REPORT_DIR"] ||
      "/tmp/opencode/fmcad-response-recovery",
    id,
  );
  fs.mkdirSync(directory, { recursive: true });
  const report: Report = {
    id,
    name,
    clientId: queue.auth.clientId,
    clientSourceSha256: createHash("sha256").update(clientSource).digest("hex"),
    mutationsSubmitted: 0,
    dropped: [],
    native: false,
  };
  const persist = () =>
    fs.writeFileSync(
      path.join(directory, "report.json"),
      JSON.stringify(report, null, 2),
    );
  let armed = false,
    mutationJob: Job | undefined,
    settled: Result | undefined;
  const observe = async (jobId: string): Promise<Result> => {
    const deadline = Date.now() + 300000;
    do {
      const observed = object(await raw("result", { jobId }));
      const job = object(observed["job"]);
      assert.equal(typeof job["state"], "string");
      if (final(String(job["state"]))) return result(observed);
      await new Promise((resolve) => setTimeout(resolve, 250));
    } while (Date.now() < deadline);
    throw new Error(
      "Original mutation did not settle; retain fixture, never replay",
    );
  };
  queue.call = async (action, values) => {
    const response = await raw(action, values);
    if (armed && action === "submit") {
      report.mutationsSubmitted++;
      const admitted = object(response);
      assert.equal(typeof admitted["id"], "string");
      assert.equal(typeof admitted["requestId"], "string");
      mutationJob = response as Job;
      report.mutationJob = mutationJob;
      persist();
      settled = await observe(mutationJob.id);
      report.originalResult = settled;
      assert.equal(
        settled.job.state,
        "succeeded",
        "Fault requires proven native success",
      );
      assert.equal(
        settled.job.dispatch?.rpcCount,
        1,
        "Synthetic mutation must have exactly one native SDK dispatch",
      );
      report.dropped.push("submit");
      persist();
      throw Object.assign(
        new Error("Test dropped admission response after native completion"),
        { code: "QUEUE_IPC_RESPONSE_LOST" },
      );
    }
    if (
      armed &&
      action === "result" &&
      values?.["jobId"] === mutationJob?.id &&
      !report.dropped.includes("result")
    ) {
      report.dropped.push("result");
      persist();
      throw Object.assign(new Error("Test dropped terminal result response"), {
        code: "QUEUE_IPC_RESPONSE_LOST",
      });
    }
    return response;
  };
  let phase = 0;
  const script = async (
    body: string,
    pinFixture = true,
  ): Promise<Record<string, unknown>> => {
    const file = path.join(directory, "phase-" + ++phase + ".py");
    fs.writeFileSync(
      file,
      "import adsk.core, adsk.fusion, json\nfrom typing import cast\nDOC_NAME = None\ndef run(context: str):\n" +
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
      ...(pinFixture && report.identity && !report.cleanup
        ? [
            "--doc",
            name,
            "--doc-id",
            report.identity.creationId,
            "--helpers",
            "cad-v1",
          ]
        : []),
    ];
    const job = await queue.submit({
      kind: "command",
      requestId: id + ":" + phase,
      argv,
      cwd: directory,
      timeoutMs: 180000,
      backend: cfg.backend,
      buildHash: buildHash(),
      inputFiles: inputFiles(argv, directory),
    });
    const result = await queue.wait(job.id);
    if (armed) {
      assert.ok(mutationJob);
      assert.equal(
        result.job.id,
        mutationJob.id,
        "Recovery must return the original admitted job",
      );
      assert.equal(
        result.job.requestId,
        mutationJob.requestId,
        "Recovery must retain the stable request identity",
      );
      assert.equal(result.job.dispatch?.rpcCount, 1);
    }
    (report.receipts ||= []).push(result);
    persist();
    assert.equal(result.job.state, "succeeded", JSON.stringify(result));
    const nativeOutput = result.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith("{"));
    assert.ok(nativeOutput, "Missing native test output");
    return parse(nativeOutput);
  };
  const state = () =>
    script(
      'a=adsk.core.Application.get()\nprint(json.dumps(dict(documents=sorted([dict(id=d.creationId,name=d.name,saved=d.isSaved,modified=d.isModified) for d in a.documents],key=lambda d:d["id"]))))',
    );
  try {
    await queue.register({ autoStart: false });
    report.broker = broker(await raw("status"));
    assert.equal(
      report.broker.buildHash,
      buildHash(),
      "Coordinate matching installed runtime before LIVE; no reload attempted",
    );
    assert.equal(
      report.broker.admissionScope,
      "normal-multidocument",
      "Normal owned-document lifecycle is required",
    );
    persist();
    report.before = await state();
    report.identity = owned(
      await script(`a=adsk.core.Application.get()
assert not any(d.name == ${JSON.stringify(name)} for d in a.documents)
previous=a.activeDocument.creationId if a.activeDocument else None
d=a.documents.add(cast(adsk.core.DocumentTypes, adsk.core.DocumentTypes.FusionDesignDocumentType))
d.name=${JSON.stringify(name)}
print(json.dumps(dict(name=d.name,creationId=d.creationId,previous=previous)))`),
    );
    persist();
    const ownedGuard = `a=adsk.core.Application.get()
owned=[d for d in a.documents if d.creationId == ${JSON.stringify(report.identity.creationId)}]
assert len(owned)==1 and owned[0].name==${JSON.stringify(name)} and not owned[0].isSaved
d=owned[0]
design=cast(adsk.fusion.Design, d.products.itemByProductType('DesignProductType'))
assert design is not None`;
    report.attemptedMutation = true;
    armed = true;
    try {
      report.mutation = await script(`${ownedGuard}
assert design.userParameters.count == 0
p=design.userParameters.add('LostAckCounter', adsk.core.ValueInput.createByString('7 mm'), 'mm', 'owned response recovery test')
assert p is not None
print(json.dumps(dict(count=design.userParameters.count,value=p.value)))`);
      report.automaticRecovery = true;
    } catch (error) {
      report.automaticRecovery = false;
      report.clientError = {
        message: error instanceof Error ? error.message : String(error),
        code:
          error && typeof error === "object" && "code" in error
            ? error.code
            : undefined,
      };
      if (!mutationJob || !settled || settled.job.state !== "succeeded")
        throw error;
      // RED baseline: observation is safe; never submit the mutation again.
      report.manualObservation = await raw("find-request", {
        requestId: mutationJob.requestId,
      });
      assert.equal(
        object(object(report.manualObservation)["job"])["id"],
        mutationJob.id,
      );
    } finally {
      armed = false;
      persist();
    }
    report.readback = await script(`${ownedGuard}
p=design.userParameters.itemByName('LostAckCounter')
assert p is not None and design.userParameters.count == 1
assert abs(p.value - 0.7) < 1e-9
print(json.dumps(dict(count=design.userParameters.count,value=p.value)))`);
    report.native = true;
    report.cleanup = await script(`${ownedGuard}
assert d.close(False)
previous=[item for item in a.documents if item.creationId==${report.identity.previous ? JSON.stringify(report.identity.previous) : "None"}]
if previous: assert previous[0].activate()
print(json.dumps(dict(closed=True,active=a.activeDocument.creationId if a.activeDocument else None)))`);
    report.after = await state();
    assert.deepEqual(
      report.after,
      report.before,
      "Foreign document state changed",
    );
    assert.equal(
      report.cleanup["active"],
      report.identity.previous,
      "Active document restore failed",
    );
    assert.equal(report.mutationsSubmitted, 1);
    assert.equal(
      report.automaticRecovery,
      true,
      "Native mutation succeeded once, but client failed to recover its lost response",
    );
    assert.deepEqual(report.dropped, ["submit", "result"]);
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.error = String(error instanceof Error ? error.stack : error);
    if (report.identity && report.cleanup?.["closed"] !== true) {
      const settled = knownSettlement([
        ...(report.receipts || []),
        ...(report.attemptedMutation ? [report.originalResult] : []),
      ]);
      if (!settled)
        report.cleanupDeferredReason =
          "Original work has no known settled result; retain exact fixture without replay or uncertain close";
      else {
        try {
          const status = object(await raw("queue-summary")),
            control = object(status["control"]);
          if (status["blocked"] || status["held"] || control["unresolved"])
            report.cleanupDeferredReason =
              "Shared executor is uncertain; no cleanup submitted";
          else
            report.failureCleanup = await script(
              ownedCleanupSource(
                report.identity,
                report.identity.previous ?? null,
                "",
              ),
              false,
            );
        } catch (cleanupError) {
          report.cleanupError = String(
            cleanupError instanceof Error ? cleanupError.stack : cleanupError,
          );
        }
      }
    }
    throw error;
  } finally {
    queue.dispose();
    report.finishedAt = new Date().toISOString();
    persist();
    console.log(
      "RESPONSE_RECOVERY_REPORT " + path.join(directory, "report.json"),
    );
  }
}

export { main };
if (require.main === module)
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });

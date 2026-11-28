import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { record, text, type Owner, type Document } from "./contracts";
import { currentProcessIdentity } from "./fixture-provenance";
import { queueExecution } from "./queue-backend";

/** Canonical producer for NEW normal runs; never imports historical identities. */
export class NormalFixtureProducer {
  readonly directory: string;
  readonly owners: readonly Owner[];
  readonly #reports: Record<string, unknown>[];
  readonly #index: Record<string, unknown>;
  constructor(root: string, runId: string, count: number, buildHash: string) {
    assert.match(runId, /^[a-f0-9-]{36}$/u);
    assert.match(buildHash, /^[a-f0-9]{64}$/u);
    assert.ok([1, 2, 10].includes(count));
    this.directory = path.join(root, runId);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.directory, { mode: 0o700 });
    this.owners = Array.from({ length: count }, (_, index) => {
      const scenarioId = "normal-owner-" + index;
      return {
        runId,
        scenarioId,
        clientId: "scenario:" + runId + ":" + scenarioId,
      };
    });
    const binding = {
      mode: "fusion",
      qualification: "broker",
      protocol: "addin",
      backendIdentity: "fusion:addin:" + buildHash,
    };
    this.#index = {
      runId,
      ...binding,
      processIdentity: currentProcessIdentity(),
      scenarioIds: this.owners.map((owner) => owner.scenarioId),
      status: "running",
      before: { documents: [] },
    };
    this.#reports = this.owners.map((owner) => {
      const directory = path.join(this.directory, owner.scenarioId);
      fs.mkdirSync(directory, { mode: 0o700 });
      return {
        owner,
        directory,
        ...binding,
        scope: "owned-document",
        status: "running",
        cleanup: "not-created",
        requests: [],
      };
    });
    this.#persist();
  }
  #persist(): void {
    const write = (file: string, value: unknown) => {
      fs.writeFileSync(file + ".new", JSON.stringify(value, null, 2) + "\n", {
        mode: 0o600,
      });
      fs.renameSync(file + ".new", file);
    };
    this.#reports.forEach((report) =>
      write(path.join(text(report["directory"]), "report.json"), report),
    );
    write(path.join(this.directory, "index.json"), this.#index);
  }
  baseline(documents: readonly Record<string, unknown>[]): void {
    assert.ok(
      this.#reports.every((report) =>
        (report["requests"] as Record<string, unknown>[]).every(
          (entry) => entry["phase"] === "baseline",
        ),
      ),
    );
    this.#index["before"] = { documents };
    this.#persist();
  }
  begin(index: number, phase: string): string {
    const report = this.#reports[index],
      owner = this.owners[index];
    assert.ok(report && owner);
    const requests = report["requests"] as Record<string, unknown>[];
    const requestId = owner.clientId + ":" + requests.length;
    requests.push({
      requestId,
      phase: phase === "close" ? "cleanup" : phase,
      intent: { kind: "script" },
    });
    this.#persist();
    return requestId;
  }
  creationTail(
    index: number,
    requestId: string,
    mapPath: (file: string) => string,
  ): string {
    const owner = this.owners[index],
      report = this.#reports[index];
    assert.ok(owner && report && requestId.startsWith(owner.clientId + ":"));
    const file = mapPath(path.join(text(report["directory"]), "creation.json"));
    return `\nidentity=dict(name=d.name,creationId=d.creationId,activeCreationId=a.activeDocument.creationId if a.activeDocument else None,requestId=${JSON.stringify(requestId)},clientId=${JSON.stringify(owner.clientId)})
with open(${JSON.stringify(file)}, 'x', encoding='utf-8') as stream:
    _ = stream.write(json.dumps(identity))
print('FMCAD_SCENARIO '+json.dumps(identity))`;
  }
  closeTail(document: Document): string {
    return `\nprint('FMCAD_SCENARIO '+json.dumps(dict(closed=True,creationId=${JSON.stringify(document.creationId)})))`;
  }
  async publish(
    index: number,
    requestId: string,
    jobId: string,
    sourceFile: string,
    readOriginal: () => Promise<unknown>,
  ): Promise<void> {
    const owner = this.owners[index],
      report = this.#reports[index];
    assert.ok(owner && report);
    const requests = report["requests"] as Record<string, unknown>[];
    const matches = requests.filter(
      (entry) => entry["requestId"] === requestId,
    );
    assert.equal(matches.length, 1);
    const entry = matches[0]!;
    assert.equal(
      entry["result"],
      undefined,
      "Never republish an original request",
    );
    const raw = record(await readOriginal()),
      job = record(raw["job"]);
    assert.equal(job["id"], jobId);
    const result = queueExecution(raw, owner, requestId);
    assert.equal(result.state, "succeeded");
    assert.equal(result.sdkSettled, true);
    if (entry["phase"] === "create" || entry["phase"] === "cleanup")
      assert.equal(result.mayHaveMutated, true);
    const provenance = record(raw["provenance"]);
    assert.equal(provenance["status"], "available");
    assert.ok(Array.isArray(provenance["inputs"]));
    const sources = provenance["inputs"]
      .map(record)
      .filter((input) => input["kind"] === "source");
    assert.equal(sources.length, 1);
    const bytes = fs.readFileSync(sourceFile);
    assert.equal(sources[0]!["originalPath"], sourceFile);
    assert.equal(sources[0]!["bytes"], bytes.length);
    assert.equal(
      sources[0]!["sha256"],
      createHash("sha256").update(bytes).digest("hex"),
    );
    if (entry["phase"] === "create") {
      const markers = result.stdout
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("FMCAD_SCENARIO "));
      assert.equal(markers.length, 1);
      const identity = record(
        JSON.parse(markers[0]!.slice("FMCAD_SCENARIO ".length)),
      );
      assert.equal(identity["requestId"], requestId);
      assert.equal(identity["clientId"], owner.clientId);
      assert.equal(identity["activeCreationId"], identity["creationId"]);
      assert.deepEqual(
        JSON.parse(
          fs.readFileSync(
            path.join(text(report["directory"]), "creation.json"),
            "utf8",
          ),
        ),
        identity,
      );
      report["document"] = {
        creationId: text(identity["creationId"]),
        name: text(identity["name"]),
      };
      report["cleanup"] = "pending";
    }
    if (entry["phase"] === "cleanup") report["cleanup"] = "complete";
    entry["result"] = result;
    entry["original"] = raw;
    entry["sourceFile"] = sourceFile;
    entry["sourceHash"] = sources[0]!["sha256"];
    this.#persist();
  }
  finish(passed: boolean): void {
    this.#index["status"] = passed ? "passed" : "failed";
    for (const report of this.#reports) {
      report["status"] = passed ? "passed" : "failed";
      if (report["cleanup"] === "pending") report["cleanup"] = "deferred";
    }
    this.#persist();
  }
}

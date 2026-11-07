import * as fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Document, Execution, Owner, ScenarioBackend } from "./contracts";
import { record, text } from "./contracts";
import * as programs from "./programs";
import { boundedMap, concurrencyLimit, defaultConcurrency } from "./scheduling";

export interface Scenario {
  readonly id: string;
  readonly requires: readonly string[];
  run(session: ScenarioSession): Promise<void>;
}
export interface ScenarioReport {
  readonly owner: Owner;
  readonly directory: string;
  readonly mode: ScenarioBackend["mode"];
  readonly qualification: ScenarioBackend["qualification"];
  readonly protocol: ScenarioBackend["protocol"];
  readonly backendIdentity: string;
  status: "running" | "passed" | "failed" | "unsupported";
  cleanup: "pending" | "complete" | "deferred" | "failed" | "not-created";
  document?: Document;
  readonly requests: { requestId: string; phase: string; result?: Execution }[];
  error?: string;
  cleanupError?: string;
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function creationProof(
  value: Record<string, unknown>,
  owner: Owner,
  requestId: string,
): Document {
  const name = "FMCAD_SCENARIO_" + owner.runId + "_" + owner.scenarioId;
  if (
    value["name"] !== name ||
    value["requestId"] !== requestId ||
    value["clientId"] !== owner.clientId
  )
    throw new Error(
      "Creation receipt does not belong to this scenario request",
    );
  return Object.freeze({ name, creationId: text(value["creationId"]) });
}
function readCreation(directory: string): Record<string, unknown> {
  const file = path.join(directory, "creation.json");
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("Expected an owned regular creation receipt");
  return record(JSON.parse(fs.readFileSync(file, "utf8")) as unknown);
}
function persist(filename: string, value: unknown): void {
  const temporary = filename + ".new";
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });
  fs.renameSync(temporary, filename);
}
export class ScenarioSession {
  #uncertain = false;
  #sequence = 0;
  #document: Document | undefined;
  readonly report: ScenarioReport;
  readonly file: string;
  constructor(
    readonly backend: ScenarioBackend,
    owner: Owner,
    readonly directory: string,
    readonly signal?: AbortSignal,
  ) {
    fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
    this.file = path.join(directory, "fixture.f3d");
    this.report = {
      owner: Object.freeze({ ...owner }),
      directory,
      mode: backend.mode,
      qualification: backend.qualification,
      backendIdentity: backend.identity,
      protocol: backend.protocol,
      status: "running",
      cleanup: "not-created",
      requests: [],
    };
    this.persist();
  }
  get document(): Document {
    if (!this.#document) throw new Error("Scenario has no owned document");
    return this.#document;
  }
  persist(): void {
    persist(path.join(this.directory, "report.json"), this.report);
  }
  async execute(
    phase: string,
    source: string,
    target: Document = this.document,
  ): Promise<Record<string, unknown>> {
    this.signal?.throwIfAborted();
    if (["create", "export", "cleanup"].includes(phase))
      throw new Error("Lifecycle phases are owned by the runner");
    const owned = this.document;
    if (target.creationId !== owned.creationId || target.name !== owned.name)
      throw new Error("Target does not belong to this scenario");
    return this.#dispatch(phase, source, owned);
  }
  async #dispatch(
    phase: string,
    source: string | ((requestId: string) => string),
    target?: Document,
  ): Promise<Record<string, unknown>> {
    if (this.#uncertain)
      throw new Error(
        "Unsettled original request; inspect before continuing, never replay",
      );
    const requestId = this.report.owner.clientId + ":" + this.#sequence++;
    const entry: ScenarioReport["requests"][number] = { requestId, phase };
    this.report.requests.push(entry);
    this.persist(); // Durable intent before a possibly mutating send.
    let execution: Execution;
    try {
      execution = await this.backend.execute({
        owner: this.report.owner,
        requestId,
        source: typeof source === "string" ? source : source(requestId),
        directory: this.directory,
        ...(target ? { target } : {}),
      });
    } catch (error) {
      this.#uncertain = true; // A transport exception never proves not-started.
      throw error;
    }
    entry.result = execution;
    this.#uncertain =
      execution.requestId !== requestId ||
      !execution.sdkSettled ||
      execution.state === "unknown";
    this.persist();
    if (this.#uncertain)
      throw new Error(
        "Unsettled or mismatched original request; cleanup deferred, never replay",
      );
    if (
      phase === "create" &&
      execution.state === "failed" &&
      !execution.mayHaveMutated
    )
      this.report.cleanup = "not-created";
    if (execution.state !== "succeeded")
      throw new Error(execution.error || "Fusion operation failed");
    const lines = execution.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith(programs.marker));
    if (lines.length !== 1)
      throw new Error("Expected exactly one scenario result marker");
    const value = record(
      JSON.parse(text(lines[0]).slice(programs.marker.length)) as unknown,
    );
    if (target && value["creationId"] !== target.creationId) {
      this.#uncertain = true;
      throw new Error(
        "Foreign document result; recover the original request before cleanup",
      );
    }
    return value;
  }
  async setup(): Promise<void> {
    this.signal?.throwIfAborted();
    const name =
      "FMCAD_SCENARIO_" +
      this.report.owner.runId +
      "_" +
      this.report.owner.scenarioId;
    this.report.cleanup = "pending";
    this.persist();
    const value = await this.#dispatch("create", (requestId) =>
      programs.create(
        name,
        this.backend.fusionPath(path.join(this.directory, "creation.json")),
        { requestId, clientId: this.report.owner.clientId },
      ),
    );
    try {
      const requestId = text(this.report.requests.at(-1)?.requestId);
      const returned = creationProof(value, this.report.owner, requestId);
      const durable = creationProof(
        readCreation(this.directory),
        this.report.owner,
        requestId,
      );
      if (returned.creationId !== durable.creationId)
        throw new Error("Returned and durable creation identities differ");
      this.#document = returned;
    } catch (error) {
      this.#uncertain = true;
      throw error;
    }
    this.report.document = this.#document;
    this.persist();
    this.signal?.throwIfAborted();
    await this.#dispatch(
      "export",
      programs.exportFile(this.document, this.backend.fusionPath(this.file)),
      this.document,
    );
    if (!fs.statSync(this.file).isFile())
      throw new Error("Fixture export did not produce a local file");
  }
  async cleanup(): Promise<void> {
    if (this.report.cleanup === "complete") return;
    // A malformed creation result can still leave a durable identity written by the exact original request.
    if (!this.#document && !this.#uncertain) {
      const receipt = path.join(this.directory, "creation.json");
      if (fs.existsSync(receipt)) {
        const creation = this.report.requests.find(
          (entry) => entry.phase === "create",
        );
        this.#document = creationProof(
          readCreation(this.directory),
          this.report.owner,
          text(creation?.requestId),
        );
        this.report.document = this.#document;
      }
    }
    if (
      this.#uncertain ||
      (!this.#document && this.report.cleanup === "pending")
    ) {
      this.report.cleanup = "deferred";
      this.persist();
      return;
    }
    if (this.#document) {
      let result: Record<string, unknown>;
      try {
        result = await this.#dispatch(
          "cleanup",
          programs.close(this.#document),
          this.#document,
        );
      } catch (error) {
        this.report.cleanup = this.#uncertain ? "deferred" : "failed";
        throw error;
      }
      if (
        result["closed"] !== true ||
        result["creationId"] !== this.#document.creationId
      )
        throw new Error(
          "Cleanup result does not prove closure of the owned document",
        );
    }
    fs.rmSync(this.file, { force: true });
    this.report.cleanup = "complete";
    this.persist();
  }
}
export async function runScenario(
  backend: ScenarioBackend,
  scenario: Scenario,
  owner: Owner,
  directory: string,
  signal?: AbortSignal,
): Promise<ScenarioReport> {
  const session = new ScenarioSession(backend, owner, directory, signal);
  if (
    scenario.requires.some(
      (capability) => !backend.capabilities.has(capability),
    )
  ) {
    session.report.status = "unsupported";
    session.report.error =
      "Missing capabilities: " +
      scenario.requires.filter((c) => !backend.capabilities.has(c)).join(", ");
    session.persist();
    return session.report;
  }
  try {
    await session.setup();
    await scenario.run(session);
    session.report.status = "passed";
  } catch (error) {
    session.report.status = "failed";
    session.report.error = errorText(error);
  } finally {
    try {
      await session.cleanup();
    } catch (error) {
      if (session.report.cleanup !== "deferred")
        session.report.cleanup = "failed";
      session.report.cleanupError = errorText(error);
    }
    if (session.report.cleanup !== "complete") session.report.status = "failed";
    session.persist();
  }
  return session.report;
}
export async function runScenarios(
  backend: ScenarioBackend,
  scenarios: readonly Scenario[],
  root: string,
  concurrency = defaultConcurrency(backend.mode),
  signal?: AbortSignal,
): Promise<ScenarioReport[]> {
  concurrencyLimit(concurrency);
  const ids = new Set<string>();
  for (const scenario of scenarios) {
    if (
      !/^[a-z0-9][a-z0-9_-]{0,100}$/.test(scenario.id) ||
      ids.has(scenario.id)
    )
      throw new Error("Invalid or duplicate scenario id: " + scenario.id);
    ids.add(scenario.id);
  }
  const runId = randomUUID();
  const runRoot = path.resolve(root, runId);
  fs.mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  const coordinator = path.join(runRoot, "_coordinator");
  fs.mkdirSync(coordinator, { mode: 0o700 });
  const observation = async (
    phase: string,
    source: string,
  ): Promise<Record<string, unknown>> => {
    const owner = {
      runId,
      scenarioId: "coordinator",
      clientId: "scenario:" + runId + ":coordinator",
    };
    const requestId = owner.clientId + ":" + phase;
    persist(path.join(coordinator, phase + ".intent.json"), {
      requestId,
      phase,
    });
    const result = await backend.execute({
      owner,
      requestId,
      directory: coordinator,
      source,
    });
    persist(path.join(coordinator, phase + ".result.json"), result);
    if (
      result.requestId !== requestId ||
      !result.sdkSettled ||
      result.state !== "succeeded"
    )
      throw new Error(
        "Coordinator observation did not settle: " +
          phase +
          " " +
          (result.error ?? result.state),
      );
    const lines = result.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith(programs.marker));
    if (lines.length !== 1) throw new Error("Invalid coordinator result");
    return record(
      JSON.parse(text(lines[0]).slice(programs.marker.length)) as unknown,
    );
  };
  const hasSupported = scenarios.some((s) =>
    s.requires.every((c) => backend.capabilities.has(c)),
  );
  const before =
    hasSupported && !signal?.aborted
      ? await observation("before", programs.snapshot())
      : undefined;
  const reports = await boundedMap(scenarios, concurrency, async (scenario) => {
    const owner = {
      runId,
      scenarioId: scenario.id,
      clientId: "scenario:" + runId + ":" + scenario.id,
    };
    return runScenario(
      backend,
      scenario,
      owner,
      path.join(runRoot, scenario.id),
      signal,
    );
  });
  let auditError: string | undefined;
  try {
    if (
      before &&
      reports.every(
        (r) => r.cleanup === "complete" || r.status === "unsupported",
      )
    ) {
      const after = await observation("after", programs.snapshot());
      const documents = (value: unknown): string => {
        if (!Array.isArray(value))
          throw new Error("Missing coordinator document inventory");
        return JSON.stringify(
          value
            .map(record)
            .sort((a, b) =>
              text(a["creationId"]).localeCompare(text(b["creationId"])),
            ),
        );
      };
      if (documents(before["documents"]) !== documents(after["documents"]))
        throw new Error(
          "Original documents changed or scenario documents remain after cleanup",
        );
      if (typeof before["active"] === "string")
        await observation("restore", programs.restoreActive(before["active"]));
    }
  } catch (error) {
    auditError = errorText(error);
    // Preserve individual errors; a failed global audit invalidates otherwise successful scenarios.
    for (const report of reports)
      if (report.status === "passed") {
        report.status = "failed";
        report.error = auditError;
        persist(path.join(report.directory, "report.json"), report);
      }
  }
  persist(path.join(runRoot, "index.json"), {
    runId,
    concurrency,
    mode: backend.mode,
    qualification: backend.qualification,
    protocol: backend.protocol,
    before,
    auditError,
    reports,
  });
  return reports;
}

/** Resume cleanup from original broker evidence only; never rerun scenario steps. */
export async function resumeCleanup(
  backend: ScenarioBackend,
  filename: string,
): Promise<ScenarioReport> {
  if (!backend.lookup)
    throw new Error("Backend cannot recover original request evidence");
  const file = path.resolve(filename),
    directory = path.dirname(file);
  if (
    path.basename(file) !== "report.json" ||
    fs.lstatSync(file).isSymbolicLink() ||
    fs.lstatSync(directory).isSymbolicLink()
  )
    throw new Error("Expected an owned regular scenario report");
  const raw = record(JSON.parse(fs.readFileSync(file, "utf8")) as unknown);
  const identity = record(raw["owner"]);
  const owner: Owner = {
    runId: text(identity["runId"]),
    scenarioId: text(identity["scenarioId"]),
    clientId: text(identity["clientId"]),
  };
  if (
    !/^[a-f0-9-]{36}$/.test(owner.runId) ||
    !/^[a-z0-9][a-z0-9_-]{0,100}$/.test(owner.scenarioId) ||
    owner.clientId !== "scenario:" + owner.runId + ":" + owner.scenarioId ||
    path.basename(directory) !== owner.scenarioId ||
    path.basename(path.dirname(directory)) !== owner.runId ||
    raw["directory"] !== directory ||
    raw["backendIdentity"] !== backend.identity ||
    raw["mode"] !== backend.mode ||
    raw["protocol"] !== backend.protocol ||
    raw["qualification"] !== backend.qualification ||
    !Array.isArray(raw["requests"])
  )
    throw new Error(
      "Cleanup report ownership/runtime does not match this backend",
    );
  const requests = raw["requests"].map((entry: unknown) => {
    const row = record(entry);
    return { requestId: text(row["requestId"]), phase: text(row["phase"]) };
  });
  if (
    new Set(requests.map((r) => r.requestId)).size !== requests.length ||
    requests.some((r) => !r.requestId.startsWith(owner.clientId + ":"))
  )
    throw new Error("Invalid original request inventory");
  // Every result is reread from the backend, not trusted from editable report JSON.
  const recovered: ScenarioReport["requests"] = [];
  for (const entry of requests) {
    const result = await backend.lookup(owner, entry.requestId);
    if (
      !result ||
      result.requestId !== entry.requestId ||
      !result.sdkSettled ||
      result.state === "unknown"
    )
      throw new Error(
        "Original request remains unsettled; cleanup must stay deferred: " +
          entry.requestId,
      );
    recovered.push({ ...entry, result });
  }
  const creation = recovered.filter((entry) => entry.phase === "create");
  if (creation.length !== 1 || creation[0]?.result?.state !== "succeeded")
    throw new Error(
      "No single successful original creation receipt; inspect before cleanup",
    );
  const lines = creation[0].result.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith(programs.marker));
  if (lines.length !== 1) throw new Error("Invalid original creation result");
  const created = record(
    JSON.parse(text(lines[0]).slice(programs.marker.length)) as unknown,
  );
  const document = creationProof(created, owner, creation[0].requestId);
  if (fs.existsSync(path.join(directory, "creation.json"))) {
    const durable = creationProof(
      readCreation(directory),
      owner,
      creation[0].requestId,
    );
    if (durable.creationId !== document.creationId)
      throw new Error("Original and durable creation identities differ");
  }
  const report: ScenarioReport = {
    owner,
    directory,
    mode: backend.mode,
    qualification: backend.qualification,
    protocol: backend.protocol,
    backendIdentity: backend.identity,
    status: "failed",
    cleanup: "pending",
    document,
    requests: recovered,
    error:
      typeof raw["error"] === "string"
        ? raw["error"]
        : "Recovered cleanup; scenario assertions were not rerun",
  };
  const priorCleanup = recovered.at(-1);
  if (
    priorCleanup?.phase === "cleanup" &&
    priorCleanup.result?.state === "succeeded"
  ) {
    const markers = priorCleanup.result.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith(programs.marker));
    if (markers.length === 1) {
      const proof = record(
        JSON.parse(text(markers[0]).slice(programs.marker.length)) as unknown,
      );
      if (
        proof["closed"] === true &&
        proof["creationId"] === document.creationId
      ) {
        fs.rmSync(path.join(directory, "fixture.f3d"), { force: true });
        report.cleanup = "complete";
        persist(file, report);
        return report;
      }
    }
  }
  const requestId = owner.clientId + ":cleanup-" + randomUUID();
  const entry: ScenarioReport["requests"][number] = {
    requestId,
    phase: "cleanup",
  };
  report.requests.push(entry);
  persist(file, report);
  try {
    const result = await backend.execute({
      owner,
      requestId,
      directory,
      target: document,
      source: programs.close(document),
    });
    entry.result = result;
    if (
      result.requestId !== requestId ||
      !result.sdkSettled ||
      result.state === "unknown"
    ) {
      report.cleanup = "deferred";
      throw new Error(
        "Cleanup did not settle; recover its original result before continuing",
      );
    }
    if (result.state !== "succeeded")
      throw new Error(result.error || "Cleanup failed");
    const values = result.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith(programs.marker));
    if (values.length !== 1) throw new Error("Missing cleanup proof");
    const proof = record(
      JSON.parse(text(values[0]).slice(programs.marker.length)) as unknown,
    );
    if (proof["closed"] !== true || proof["creationId"] !== document.creationId)
      throw new Error("Mismatched cleanup proof");
    fs.rmSync(path.join(directory, "fixture.f3d"), { force: true });
    report.cleanup = "complete";
  } catch (error) {
    if (!entry.result || report.cleanup === "deferred")
      report.cleanup = "deferred";
    else report.cleanup = "failed";
    report.cleanupError = errorText(error);
  }
  persist(file, report);
  return report;
}

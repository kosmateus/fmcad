import * as fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Document,
  Execution,
  FixtureFolder,
  Owner,
  ScenarioBackend,
} from "./contracts";
import { record, text } from "./contracts";
import * as programs from "./programs";
import { scopedMap, concurrencyLimit, defaultConcurrency } from "./scheduling";
import * as savedPrograms from "./saved-programs";
import {
  cleanupSavedFile,
  observeSavedFile,
  recoveredFile,
  resultValue,
  saveIntent,
  UnsettledCloudOperation,
  SavedEvidenceError,
} from "./saved-files";
import { revisionProgram, recoverRevision } from "./revision";
import { reopenProgram, recoveredReopen } from "./reopen";
import { auditRecovery } from "./recovery-audit";

export interface Scenario {
  readonly scope?: "owned-document" | "exclusive-instance";
  readonly id: string;
  readonly requires: readonly string[];
  readonly fixture?: FixtureFolder;
  run(session: ScenarioSession): Promise<void>;
}
export interface ScenarioReport {
  readonly owner: Owner;
  readonly directory: string;
  readonly mode: ScenarioBackend["mode"];
  readonly qualification: ScenarioBackend["qualification"];
  readonly protocol: ScenarioBackend["protocol"];
  readonly backendIdentity: string;
  readonly fixture?: FixtureFolder;
  status: "running" | "passed" | "failed" | "unsupported" | "not-run";
  scope?: "owned-document" | "exclusive-instance";
  cleanup: "pending" | "complete" | "deferred" | "failed" | "not-created";
  document?: Document;
  originalDocument?: Document;
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
    fixture?: FixtureFolder,
    restored?: ScenarioReport,
  ) {
    if (!restored) fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
    this.file = path.join(directory, "fixture.f3d");
    this.report = restored ?? {
      owner: Object.freeze({ ...owner }),
      directory,
      mode: backend.mode,
      qualification: backend.qualification,
      backendIdentity: backend.identity,
      protocol: backend.protocol,
      status: "running",
      cleanup: "not-created",
      requests: [],
      ...(fixture ? { fixture: Object.freeze({ ...fixture }) } : {}),
    };
    this.#document = restored?.document;
    this.#sequence = restored?.requests.length ?? 0;
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
    helpers?: "cad-v1",
  ): Promise<Record<string, unknown>> {
    this.signal?.throwIfAborted();
    if (
      [
        "create",
        "export",
        "cleanup",
        "save",
        "save-observe",
        "reopen-close",
        "reopen-open",
        "revision-save",
        "revision-observe",
        "cleanup-close",
        "cleanup-delete",
        "cleanup-observe",
      ].includes(phase)
    )
      throw new Error("Lifecycle phases are owned by the runner");
    const owned = this.document;
    if (target.creationId !== owned.creationId || target.name !== owned.name)
      throw new Error("Target does not belong to this scenario");
    return this.#dispatch(phase, source, owned, true, helpers);
  }
  async cad(
    phase: string,
    operation: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.signal?.throwIfAborted();
    if (!this.document.file)
      throw new Error("CAD scenarios require a saved fixture");
    if (!phase.startsWith("cad-"))
      throw new Error("CAD phase must use cad- prefix");
    return this.#dispatch(phase, "", this.document, true, undefined, {
      operation,
      data: structuredClone(data),
    });
  }
  async #dispatch(
    phase: string,
    source: string | ((requestId: string) => string),
    target?: Document,
    routeTarget = true,
    helpers?: "cad-v1",
    command?: { operation: string; data: Record<string, unknown> },
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
        ...(helpers ? { helpers } : {}),
        ...(command ? { command } : {}),
        ...(target && routeTarget ? { target } : {}),
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
    if (command && execution.stdout.trim()) {
      const output = record(JSON.parse(execution.stdout) as unknown);
      if (typeof output["success"] !== "boolean")
        throw new Error("CAD result has no explicit outcome");
      if (!target) throw new Error("CAD command has no owned target");
      if (output["context"] !== undefined) {
        const context = record(output["context"]);
        if (
          context["doc"] !== target?.name ||
          context["docId"] !== target.creationId ||
          context["docFileId"] !== target.file?.fileId
        ) {
          this.#uncertain = true;
          throw new Error(
            "Foreign CAD context; recover the original command before cleanup",
          );
        }
      } else if (
        output["success"] === true &&
        !["preview", "validate"].includes(String(command.data["mode"])) &&
        ["definition.instantiate", "batch.run"].includes(command.operation)
      ) {
        this.#uncertain = true;
        throw new Error("Successful batch has no pinned context");
      }
      return output;
    }
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
    if (this.report.fixture) {
      this.signal?.throwIfAborted();
      const folder = this.report.fixture;
      await this.#dispatch(
        "save",
        (requestId) =>
          savedPrograms.save(
            this.document,
            folder,
            this.report.owner,
            requestId,
            this.backend.fusionPath(
              path.join(this.directory, "save-intent.json"),
            ),
          ),
        this.document,
      );
      try {
        const intent = saveIntent(
          this.directory,
          this.document,
          this.report.owner,
          this.report.requests,
        );
        if (
          !intent ||
          intent.projectId !== folder.projectId ||
          intent.folderId !== folder.folderId
        )
          throw new Error("Configured and accepted fixture folders differ");
      } catch (error) {
        this.#uncertain = true;
        throw error;
      }
      // Acceptance is deliberately separate from cloud completion.
      let file;
      try {
        file = await observeSavedFile(
          this.document,
          folder,
          this.#dispatch.bind(this),
          false,
        );
      } catch (error) {
        if (
          error instanceof SavedEvidenceError ||
          error instanceof UnsettledCloudOperation
        )
          this.#uncertain = true;
        throw error;
      }
      if (!file) throw new Error("Saved fixture has no file identity");
      this.#document = Object.freeze({ ...this.document, file });
      this.report.document = this.#document;
      this.persist();
      this.signal?.throwIfAborted();
    }
  }
  async saveRevision(): Promise<void> {
    this.signal?.throwIfAborted();
    if (!this.document.file)
      throw new Error("Revision requires a saved fixture");
    if (
      this.report.requests.some(
        (r) => r.phase.startsWith("revision-") || r.phase.startsWith("reopen-"),
      )
    )
      throw new Error(
        "Save one revision before reopening; recover original evidence instead of retrying",
      );
    const original = this.document;
    this.report.originalDocument = original;
    this.persist();
    try {
      await this.#dispatch(
        "revision-save",
        (requestId) =>
          revisionProgram(
            original,
            this.report.owner,
            requestId,
            this.backend.fusionPath(path.join(this.directory, "revision.json")),
          ),
        original,
      );
      this.#document = await recoverRevision(
        original,
        this.report.owner,
        this.report.requests,
        this.directory,
        this.#dispatch.bind(this),
      );
      this.report.document = this.#document;
      this.persist();
      this.signal?.throwIfAborted();
    } catch (error) {
      if (!this.#uncertain) {
        try {
          this.#document = await recoverRevision(
            original,
            this.report.owner,
            this.report.requests,
            this.directory,
            this.#dispatch.bind(this),
          );
          this.report.document = this.#document;
        } catch {
          this.#uncertain = true;
        }
      }
      this.persist();
      throw error;
    }
  }
  /** Read-only receipt recovery may poll publication; it never resubmits save/open/close. */
  async recoverSavedTransitions(): Promise<void> {
    const original = this.document;
    const revised = await recoverRevision(
      original,
      this.report.owner,
      this.report.requests,
      this.directory,
      this.#dispatch.bind(this),
    );
    this.#document = recoveredReopen(
      revised,
      this.report.owner,
      this.report.requests,
      this.directory,
    );
    this.report.originalDocument = original;
    this.report.document = this.#document;
    this.persist();
  }
  /** Close once and reopen the exact completed file. Unknown results never retry. */
  async reopen(): Promise<void> {
    this.signal?.throwIfAborted();
    if (!this.document.file) throw new Error("Reopen requires a saved fixture");
    if (this.report.requests.some((r) => r.phase.startsWith("reopen-")))
      throw new Error(
        "A scenario may reopen only once; recover original evidence instead",
      );
    const original = this.document;
    this.report.originalDocument = original;
    this.persist();
    try {
      await this.#dispatch("reopen-close", programs.close(original), original);
      this.signal?.throwIfAborted();
      await this.#dispatch("reopen-open", (requestId) =>
        reopenProgram(
          original,
          this.report.owner,
          requestId,
          this.backend.fusionPath(path.join(this.directory, "reopen.json")),
        ),
      );
      this.#document = recoveredReopen(
        original,
        this.report.owner,
        this.report.requests,
        this.directory,
      );
      this.report.document = this.#document;
      this.persist();
      this.signal?.throwIfAborted();
    } catch (error) {
      // Even a settled Python failure may occur after native open. Only original
      // receipts can authorize a handoff; failed assertions never permit replay.
      try {
        this.#document = recoveredReopen(
          original,
          this.report.owner,
          this.report.requests,
          this.directory,
        );
        this.report.document = this.#document;
      } catch {
        this.#uncertain = true;
      }
      this.persist();
      throw error;
    }
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
      try {
        const folder = saveIntent(
          this.directory,
          this.report.originalDocument ?? this.#document,
          this.report.owner,
          this.report.requests,
        );
        if (folder && !this.#document.file) {
          const accepted = resultValue(
            this.report.requests.find((entry) => entry.phase === "save"),
          );
          const file = await observeSavedFile(
            this.#document,
            folder,
            this.#dispatch.bind(this),
            accepted?.["accepted"] !== true,
          );
          if (file) {
            this.#document = Object.freeze({ ...this.#document, file });
            this.report.document = this.#document;
            this.persist();
          }
        }
        if (this.#document.file) {
          await cleanupSavedFile(
            this.#document,
            this.report.requests,
            this.#dispatch.bind(this),
          );
          fs.rmSync(this.file, { force: true });
          this.report.cleanup = "complete";
          this.persist();
          return;
        }
      } catch (error) {
        this.report.cleanup =
          this.#uncertain ||
          error instanceof UnsettledCloudOperation ||
          error instanceof SavedEvidenceError
            ? "deferred"
            : "failed";
        throw error;
      }
      const prior = resultValue(
        this.report.requests.findLast((entry) => entry.phase === "cleanup"),
      );
      if (
        prior?.["closed"] === true &&
        prior["creationId"] === this.#document.creationId
      ) {
        fs.rmSync(this.file, { force: true });
        this.report.cleanup = "complete";
        this.persist();
        return;
      }
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
  const session = new ScenarioSession(
    backend,
    owner,
    directory,
    signal,
    scenario.fixture,
  );
  session.report.scope = scenario.scope ?? "owned-document";
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
    if (
      scenario.scope !== undefined &&
      !["owned-document", "exclusive-instance"].includes(scenario.scope)
    )
      throw new Error("Invalid scenario scope");
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
  const folders = [
    ...new Map(
      scenarios
        .filter(
          (s) =>
            s.fixture && s.requires.every((c) => backend.capabilities.has(c)),
        )
        .map((s) => [JSON.stringify(s.fixture), s.fixture!]),
    ).values(),
  ];
  const cloudBefore: Record<string, unknown>[] = [];
  if (before) {
    for (const [index, folder] of folders.entries())
      cloudBefore.push(
        await observation(
          "files-before-" + index,
          savedPrograms.inventory(folder),
        ),
      );
  }
  persist(path.join(runRoot, "index.json"), {
    runId,
    mode: backend.mode,
    qualification: backend.qualification,
    protocol: backend.protocol,
    before,
    cloudBefore,
    scenarioIds: scenarios.map((s) => s.id),
    status: "running",
  });
  const tasks = scenarios.map((scenario) => {
    const owner = {
      runId,
      scenarioId: scenario.id,
      clientId: "scenario:" + runId + ":" + scenario.id,
    };
    const directory = path.join(runRoot, scenario.id);
    return {
      exclusive: scenario.scope === "exclusive-instance",
      run: () => runScenario(backend, scenario, owner, directory, signal),
      blocked: (reason: string): ScenarioReport => {
        fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
        const report: ScenarioReport = {
          owner,
          directory,
          mode: backend.mode,
          qualification: backend.qualification,
          backendIdentity: backend.identity,
          protocol: backend.protocol,
          scope: scenario.scope ?? "owned-document",
          status: "not-run",
          cleanup: "not-created",
          requests: [],
          error: reason,
          ...(scenario.fixture ? { fixture: scenario.fixture } : {}),
        };
        persist(path.join(directory, "report.json"), report);
        return report;
      },
    };
  });
  const reports = await scopedMap(tasks, concurrency, (report) => {
    if (report.status === "passed" && report.cleanup === "complete")
      return "passed";
    if (report.cleanup === "complete" || report.cleanup === "not-created")
      return "settled-failure";
    return "unsettled";
  });
  let auditError: string | undefined;
  try {
    if (
      before &&
      reports.every(
        (r) =>
          r.cleanup === "complete" ||
          r.status === "unsupported" ||
          (r.status === "not-run" && r.cleanup === "not-created"),
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
      const files = (value: Record<string, unknown>): string => {
        if (!Array.isArray(value["files"]))
          throw new Error("Missing fixture folder inventory");
        return JSON.stringify(
          value["files"]
            .map(record)
            .map((file) => ({
              fileId: text(file["fileId"]),
              name: text(file["name"]),
              version: file["version"],
            }))
            .sort((a, b) => a.fileId.localeCompare(b.fileId)),
        );
      };
      for (const [index, folder] of folders.entries()) {
        const afterFiles = await observation(
          "files-after-" + index,
          savedPrograms.inventory(folder),
        );
        if (files(cloudBefore[index]!) !== files(afterFiles))
          throw new Error(
            "Original cloud files changed or scenario files remain after cleanup",
          );
      }
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
    cloudBefore,
    scenarioIds: scenarios.map((s) => s.id),
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
  let document = creationProof(created, owner, creation[0].requestId);
  if (fs.existsSync(path.join(directory, "creation.json"))) {
    const durable = creationProof(
      readCreation(directory),
      owner,
      creation[0].requestId,
    );
    if (durable.creationId !== document.creationId)
      throw new Error("Original and durable creation identities differ");
  }
  const folder = saveIntent(directory, document, owner, recovered);
  if (folder) {
    const saved = recoveredFile(document, folder, recovered);
    if (saved) document = Object.freeze({ ...document, file: saved });
  }
  const originalDocument = document;

  const report: ScenarioReport = {
    originalDocument,
    owner: Object.freeze(owner),
    directory,
    mode: backend.mode,
    qualification: backend.qualification,
    protocol: backend.protocol,
    backendIdentity: backend.identity,
    status: "failed",
    cleanup: "pending",
    document,
    requests: recovered,
    ...(folder ? { fixture: folder } : {}),
    error:
      typeof raw["error"] === "string"
        ? raw["error"]
        : "Recovered cleanup; scenario assertions were not rerun",
  };
  const session = new ScenarioSession(
    backend,
    owner,
    directory,
    undefined,
    folder,
    report,
  );
  await session.recoverSavedTransitions();
  try {
    await session.cleanup();
  } catch (error) {
    if (
      error instanceof SavedEvidenceError ||
      error instanceof UnsettledCloudOperation
    )
      report.cleanup = "deferred";
    if (report.cleanup !== "deferred") report.cleanup = "failed";
    report.cleanupError = errorText(error);
  }
  session.persist();
  if (report.cleanup === "complete") await auditRecovery(backend, report);
  return report;
}

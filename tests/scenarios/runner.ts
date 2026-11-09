import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import {
  recoverLegacyInvocations,
  writeHandoff,
  childProcessIdentity,
  type LegacyLease,
} from "./legacy-handoff";
import { commandResult } from "./command-result";
import * as fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Document,
  Execution,
  FixtureFolder,
  Owner,
  ScenarioBackend,
  ScriptRequest,
} from "./contracts";
import { record, text } from "./contracts";
import * as programs from "./programs";
import {
  captureOriginalView,
  restoreOriginalView,
} from "./original-view-programs";
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
  readonly lifecycle?: "read-only";
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
  lifecycle?: "read-only";
  cleanup: "pending" | "complete" | "deferred" | "failed" | "not-created";
  document?: Document;
  originalDocument?: Document;
  readonly requests: {
    requestId: string;
    phase: string;
    intent?: Record<string, unknown>;
    result?: Execution;
  }[];
  error?: string;
  cleanupError?: string;
  cleanupHold?: { requestId: string; reason: string };
  peers?: Owner[];
}
function errorText(error: unknown): string {
  if (error instanceof AggregateError)
    return error.message + ": " + error.errors.map(errorText).join("; ");
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
  #parentSession: ScenarioSession | undefined;
  readonly #peerSessions = new Map<string, ScenarioSession>();
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
  get uncertain(): boolean {
    return this.#uncertain;
  }
  /** A second real readonly client, linked before creation to this same lifecycle. */
  createReadonlyPeer(label: string): ScenarioSession {
    if (
      this.report.lifecycle !== "read-only" ||
      this.report.scope !== "exclusive-instance" ||
      this.#document ||
      this.#parentSession ||
      this.#uncertain ||
      !/^[a-z][a-z0-9-]{0,20}$/u.test(label)
    )
      throw new Error(
        "Readonly peer requires an exclusive settled parent and a bounded label",
      );
    const scenarioId = this.report.owner.scenarioId + "-peer-" + label;
    if (
      scenarioId.length > 100 ||
      this.report.peers?.some((peer) => peer.scenarioId === scenarioId)
    )
      throw new Error(
        "Readonly peer already exists or has an invalid identity",
      );
    const owner = {
      runId: this.report.owner.runId,
      scenarioId,
      clientId: "scenario:" + this.report.owner.runId + ":" + scenarioId,
    };
    (this.report.peers ??= []).push(owner);
    this.persist();
    const peer = new ScenarioSession(
      this.backend,
      owner,
      path.join(path.dirname(this.directory), scenarioId),
      this.signal,
    );
    peer.report.lifecycle = "read-only";
    peer.report.scope = "exclusive-instance";
    peer.#parentSession = this;
    peer.persist();
    this.#peerSessions.set(scenarioId, peer);
    return peer;
  }
  get originalView(): Record<string, unknown> {
    const result = this.report.requests.find(
      (entry) => entry.phase === "original-user-view-capture",
    )?.result;
    if (!result?.sdkSettled || result.state !== "succeeded")
      throw new Error(
        "Original user view has no successful bound capture receipt",
      );
    const lines = result.stdout
      .split(/\r?\n/u)
      .filter((line) => line.startsWith(programs.marker));
    if (lines.length !== 1)
      throw new Error("Invalid original user view capture");
    return record(
      JSON.parse(text(lines[0]).slice(programs.marker.length)) as unknown,
    );
  }
  async captureUserView(strictCamera = false): Promise<void> {
    if (this.#document || this.report.scope !== "exclusive-instance")
      throw new Error(
        "Original view capture requires an exclusive scenario before fixture creation",
      );
    await this.#dispatch(
      "original-user-view-capture",
      captureOriginalView(strictCamera),
    );
  }
  async restoreUserView(): Promise<void> {
    if (
      !this.report.requests.some(
        (entry) => entry.phase === "original-user-view-capture",
      )
    )
      return;
    if (this.report.cleanup !== "complete") return;
    try {
      const prior = this.report.requests.find(
        (entry) => entry.phase === "original-user-view-restore",
      );
      if (prior) {
        if (!prior.result?.sdkSettled || prior.result.state !== "succeeded")
          throw new Error(
            "Original user view restoration remains unverified; never replay it",
          );
        const lines = prior.result.stdout
          .split(/\r?\n/u)
          .filter((line) => line.startsWith(programs.marker));
        if (
          lines.length !== 1 ||
          record(
            JSON.parse(text(lines[0]).slice(programs.marker.length)) as unknown,
          )["restored"] !== true
        )
          throw new Error(
            "Original restoration receipt does not prove the user view",
          );
        return;
      }
      const value = await this.#dispatch(
        "original-user-view-restore",
        restoreOriginalView(this.originalView),
      );
      assert.equal(
        value["restored"],
        true,
        "Original user view was not restored",
      );
    } catch (error) {
      this.#uncertain = true;
      this.report.cleanup = "deferred";
      this.persist();
      throw error;
    }
  }
  /** Register a checkpoint/import child before its original SDK request is sent. */
  prepareChildReceipt(
    phase: string,
    requestId: string,
    inputPath: string,
    options: { allowCopiedCreationId?: true } = {},
  ): string {
    if (
      !/^[a-z][a-z0-9-]{0,90}$/u.test(phase) ||
      this.report.requests.at(-1)?.requestId !== requestId ||
      this.report.requests.at(-1)?.phase !== phase ||
      !path.resolve(inputPath).startsWith(this.directory + path.sep)
    )
      throw new Error(
        "Child import intent does not belong to the current owned request",
      );
    const folder = path.join(this.directory, "children");
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const receipt = path.join(folder, phase + ".receipt.json");
    writeHandoff(
      path.join(folder, phase + ".intent.json"),
      {
        version: 1,
        owner: this.report.owner,
        requestId,
        phase,
        parentCreationId: this.document.creationId,
        ...(options.allowCopiedCreationId
          ? { allowCopiedCreationId: true }
          : {}),
        path: this.backend.fusionPath(path.resolve(inputPath)),
        receipt: this.backend.fusionPath(receipt),
      },
      true,
    );
    return this.backend.fusionPath(receipt);
  }
  #verifyChildClosures(): void {
    const folder = path.join(this.directory, "children");
    if (!fs.existsSync(folder)) return;
    const read = (filename: string) => {
      const stat = fs.lstatSync(filename);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error("Expected an owned child receipt");
      return record(JSON.parse(fs.readFileSync(filename, "utf8")) as unknown);
    };
    for (const filename of fs
      .readdirSync(folder)
      .filter((name) => name.endsWith(".intent.json"))) {
      if (!/^[a-z][a-z0-9-]{0,90}\.intent\.json$/u.test(filename))
        throw new Error("Invalid child intent name");
      const intent = read(path.join(folder, filename)),
        identity = record(intent["owner"]);
      assert.deepEqual(identity, this.report.owner);
      const phase = filename.slice(0, -".intent.json".length);
      assert.equal(intent["phase"], phase);
      assert.equal(intent["version"], 1);
      assert.equal(intent["parentCreationId"], this.document.creationId);
      const original = this.report.requests.find(
        (entry) =>
          entry.requestId === intent["requestId"] && entry.phase === phase,
      );
      assert.ok(
        original?.result?.sdkSettled && original.result.state !== "unknown",
        "Original child request remains unsettled",
      );
      const filenameProof = path.join(folder, phase + ".receipt.json");
      assert.equal(intent["receipt"], this.backend.fusionPath(filenameProof));
      const proof = read(filenameProof);
      assert.equal(proof["requestId"], intent["requestId"]);
      assert.equal(proof["clientId"], this.report.owner.clientId);
      assert.equal(proof["parentCreationId"], this.document.creationId);
      assert.equal(proof["path"], intent["path"]);
      const childCreationId = text(proof["creationId"]);
      const childName = text(proof["name"]);
      if (childCreationId === this.document.creationId) {
        assert.equal(intent["allowCopiedCreationId"], true);
        assert.equal(
          proof["identityMode"],
          "native-object-in-original-request",
        );
        assert.ok(childName.startsWith(this.document.name + "_"));
      }
      assert.equal(proof["saved"], false);
      assert.equal(proof["fileId"], null);
      assert.equal(
        proof["status"],
        "closed",
        "Owned child closure is unverified; leave both documents for original-request recovery",
      );
    }
  }
  /** Check original child closure evidence before deleting case-owned files. */
  verifyChildClosures(): void {
    try {
      this.#verifyChildClosures();
    } catch (error) {
      this.#uncertain = true;
      this.report.cleanup = "deferred";
      this.persist();
      throw error;
    }
  }
  persist(): void {
    persist(path.join(this.directory, "report.json"), this.report);
  }
  /** A case can preserve a domain-specific uncertain mutation without retrying it. */
  deferCleanup(reason: string): never {
    this.#uncertain = true;
    this.report.cleanup = "deferred";
    this.report.cleanupHold = {
      requestId: text(this.report.requests.at(-1)?.requestId),
      reason,
    };
    this.persist();
    throw new Error(reason);
  }
  /** Observe exact owned state without the CLI activating the target first. */
  async observe(
    phase: string,
    source: string,
  ): Promise<Record<string, unknown>> {
    this.signal?.throwIfAborted();
    if (!phase.startsWith("observe-"))
      throw new Error("Observation phase must use observe- prefix");
    return this.#dispatch(phase, source, this.document, false);
  }
  /** Retained full-inventory guards require the existing exclusive-instance barrier. */
  async verifyOwnedUnsaved(phase: string): Promise<void> {
    if (this.report.scope !== "exclusive-instance")
      throw new Error(
        "Full foreign inventory observation requires an exclusive scenario",
      );
    try {
      const filename = path.join(this.directory, "..", "index.json");
      const stat = fs.lstatSync(filename);
      assert.ok(stat.isFile() && !stat.isSymbolicLink());
      const coordinator = record(
        JSON.parse(fs.readFileSync(filename, "utf8")) as unknown,
      );
      assert.equal(coordinator["runId"], this.report.owner.runId);
      assert.ok(
        Array.isArray(coordinator["scenarioIds"]) &&
          coordinator["scenarioIds"].includes(this.report.owner.scenarioId),
      );
      const before = record(coordinator["before"]);
      const current = await this.observe(
        phase,
        programs.unsavedState(this.document),
      );
      const documents = (value: unknown) => {
        assert.ok(Array.isArray(value));
        return value
          .map(record)
          .filter(
            (document) => document["creationId"] !== this.document.creationId,
          )
          .sort((left, right) =>
            text(left["creationId"]).localeCompare(text(right["creationId"])),
          );
      };
      assert.deepEqual(
        documents(current["documents"]),
        documents(before["documents"]),
        "A non-fixture document changed during the owned unsaved case",
      );
    } catch (error) {
      if (this.#uncertain) throw error;
      this.deferCleanup(
        "Owned unsaved fixture guard failed; inspect original identity before cleanup: " +
          errorText(error),
      );
    }
  }
  async execute(
    phase: string,
    source: string | ((requestId: string) => string),
    target: Document = this.document,
    helpers?: "cad-v1",
    routeTarget = true,
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
    return this.#dispatch(phase, source, owned, routeTarget, helpers);
  }
  /** Run one retained native CLI case under this same durable owner/cleanup ledger. */
  async legacyScript(
    source:
      | "tests/live-data-import.ts"
      | "tests/scenarios/legacy-owned-driver.ts" = "tests/live-data-import.ts",
  ): Promise<void> {
    if (this.report.scope !== "exclusive-instance" || this.document.file)
      throw new Error(
        "Native import requires the exclusive owned unsaved fixture",
      );
    return this.legacyCli(
      source,
      source === "tests/live-data-import.ts"
        ? "native-data-import"
        : "native-legacy-cli",
      "owned-unsaved-script",
    );
  }
  async legacyCli(
    source: string,
    testCase: string,
    mode?: "owned-unsaved-script",
  ): Promise<void> {
    if (this.#uncertain)
      throw new Error("Unsettled original request; never start another child");
    if (
      this.backend.qualification !== "broker" ||
      !this.backend.lookup ||
      (!this.document.file && mode !== "owned-unsaved-script")
    )
      throw new Error(
        "Retained native CLI cases require a broker-owned saved fixture and original request lookup",
      );
    const root = path.resolve(__dirname, "../../.."),
      filename = path.resolve(
        root,
        mode ? "dist/" + source.replace(/\.ts$/u, ".js") : source,
      );
    if (
      mode
        ? ![
            "tests/live-data-import.ts",
            "tests/scenarios/legacy-owned-driver.ts",
          ].includes(source) ||
          this.document.file ||
          this.report.scope !== "exclusive-instance"
        : !(
            source.startsWith("tests/integration/") ||
            source === "tests/fixtures/owned-cli/handoff.test.js"
          ) ||
          !source.endsWith(".test.js") ||
          !(
            filename.startsWith(
              path.join(root, "tests/integration") + path.sep,
            ) ||
            filename ===
              path.join(root, "tests/fixtures/owned-cli/handoff.test.js")
          ) ||
          fs.lstatSync(filename).isSymbolicLink()
    )
      throw new Error("Expected a retained integration test source");
    if (
      !fs.lstatSync(filename).isFile() ||
      fs.lstatSync(filename).isSymbolicLink()
    )
      throw new Error("Expected a regular retained child program");
    const directory = path.join(this.directory, "legacy");
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.mkdirSync(path.join(directory, "intents"), { mode: 0o700 });
    const lease: LegacyLease = {
      version: 1,
      owner: this.report.owner,
      document: this.document,
      directory: this.directory,
      source,
      testCase,
      protocol: this.backend.protocol,
      ...(mode ? { mode } : {}),
    };
    const scopeFile = path.join(directory, "lease.json"),
      launchFile = path.join(directory, "launch.json");
    writeHandoff(scopeFile, lease, true);
    writeHandoff(launchFile, { state: "preparing" }, true);
    this.#uncertain = true;
    this.persist();
    const stdoutFile = path.join(directory, "stdout.log"),
      stderrFile = path.join(directory, "stderr.log");
    const stdout = fs.openSync(stdoutFile, "wx", 0o600),
      stderr = fs.openSync(stderrFile, "wx", 0o600);
    let code: number | null;
    try {
      const pattern =
        "^" + testCase.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&") + "$";
      const child = spawn(
        process.execPath,
        mode
          ? [filename, "--run"]
          : [
              "--test",
              "--experimental-test-isolation=none",
              "--test-reporter=tap",
              "--test-name-pattern=" + pattern,
              filename,
            ],
        {
          cwd: root,
          stdio: ["ignore", stdout, stderr],
          env: {
            ...process.env,
            FMCAD_TEST_DOC: this.document.name,
            FMCAD_TEST_CASE: testCase,
            FMCAD_LIVE_CLIENT: this.report.owner.clientId,
            FMCAD_CLIENT: this.report.owner.clientId,
            FMCAD_LIVE_ROUTING: "queue",
            FMCAD_ROUTING: "queue",
            FMCAD_LIVE_OWNED_SCOPE: scopeFile,
            FMCAD_LIVE_SUITE: source,
            FMCAD_LIVE_FIXTURE_NAME: this.document.name,
            FMCAD_LIVE_FIXTURE_ID: this.document.creationId,
          },
        },
      );
      const completed = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      });
      if (!child.pid) await completed;
      if (!child.pid)
        throw new Error(
          "Retained child has no process identity; inspect handoff before cleanup",
        );
      const launched = {
        pid: child.pid,
        birth: childProcessIdentity.processBirth(child.pid),
      };
      writeHandoff(launchFile, { state: "running", ...launched });
      code = await completed;
      writeHandoff(launchFile, { state: "completed", ...launched, code });
    } finally {
      fs.closeSync(stdout);
      fs.closeSync(stderr);
    }
    // Read real original broker receipts, including commands whose caller lost its reply.
    const recovered = await recoverLegacyInvocations(
      this.backend,
      this.directory,
      this.report.owner,
    );
    this.report.requests.push(...recovered);
    if (mode) {
      const completionFile = path.join(directory, "completion.json");
      if (
        !fs.existsSync(completionFile) ||
        fs.lstatSync(completionFile).isSymbolicLink()
      )
        this.deferCleanup(
          "Native import child lacks its durable completion disposition; inspect original requests",
        );
      const completion = record(
        JSON.parse(fs.readFileSync(completionFile, "utf8")) as unknown,
      );
      assert.deepEqual(completion["owner"], this.report.owner);
      assert.deepEqual(completion["document"], this.document);
      if (completion["safeForCleanup"] !== true)
        this.deferCleanup(
          "Native import child retained an uncertain outcome; inspect original requests",
        );
    }
    this.#uncertain = false;
    this.persist();
    const output = fs.readFileSync(stdoutFile, "utf8");
    const selected = output
      .split(/\r?\n/u)
      .filter(
        (line) =>
          /^ok \d+ - /u.test(line) &&
          line.includes(testCase) &&
          !line.includes("# SKIP"),
      );
    if (code !== 0 || (!mode && selected.length !== 1))
      throw new Error(
        "Retained owned CLI case did not pass exactly once; inspect its original child logs",
      );
  }
  async cad(
    phase: string,
    operation: string,
    data: Record<string, unknown>,
    options: { component?: string; spelling?: readonly string[] } = {},
  ): Promise<Record<string, unknown>> {
    this.signal?.throwIfAborted();
    if (!phase.startsWith("cad-"))
      throw new Error("CAD phase must use cad- prefix");
    return this.#dispatch(phase, "", this.document, true, undefined, {
      operation,
      data: structuredClone(data),
      ...options,
    });
  }
  /** Inspect a real rejected terminal command; never manufacture a CLI exit code. */
  async cadRejected(
    phase: string,
    operation: string,
    data: Record<string, unknown>,
    options: { component?: string; spelling?: readonly string[] } = {},
  ): Promise<Execution> {
    this.signal?.throwIfAborted();
    if (!phase.startsWith("cad-"))
      throw new Error("CAD phase must use cad- prefix");
    await this.#dispatch(phase, "", this.document, true, undefined, {
      operation,
      data: structuredClone(data),
      ...options,
      expectRejected: true,
    });
    const execution = this.report.requests.at(-1)?.result;
    assert.ok(
      execution && execution.sdkSettled && execution.state === "failed",
      "Expected a rejected settled command receipt",
    );
    return execution;
  }
  /** Preserve exact public readonly CLI output and its original terminal receipt. */
  async inspectCli(
    phase: string,
    command: "active" | "doc-list",
  ): Promise<Execution> {
    if (!phase.startsWith("inspect-"))
      throw new Error("CLI inspection phase must use inspect- prefix");
    await this.#dispatch(
      phase,
      "",
      undefined,
      false,
      undefined,
      undefined,
      command,
    );
    const execution = this.report.requests.at(-1)?.result;
    assert.ok(execution?.sdkSettled && execution.state === "succeeded");
    return execution;
  }
  /** Bind an existing transport's original request to this same durable ledger. */
  async registeredRequest<T>(
    phase: string,
    intent: Record<string, unknown>,
    dispatch: (context: {
      owner: Owner;
      requestId: string;
      directory: string;
    }) => Promise<{ execution: Execution; value: T }>,
  ): Promise<T> {
    this.signal?.throwIfAborted();
    return this.#registeredRequest(phase, intent, dispatch);
  }
  async #registeredRequest<T>(
    phase: string,
    intent: Record<string, unknown>,
    dispatch: (context: {
      owner: Owner;
      requestId: string;
      directory: string;
    }) => Promise<{ execution: Execution; value: T }>,
  ): Promise<T> {
    if (this.report.lifecycle === "read-only" && intent["readOnly"] !== true)
      throw new Error(
        "Readonly scenario requests require explicit readonly intent",
      );
    if (
      this.#uncertain ||
      (this.#parentSession && this.#parentSession.#uncertain)
    )
      throw new Error(
        "Unsettled original request; inspect before continuing, never replay",
      );
    const requestId = this.report.owner.clientId + ":" + this.#sequence++;
    const entry: ScenarioReport["requests"][number] = {
      requestId,
      phase,
      intent: structuredClone(intent),
    };
    this.report.requests.push(entry);
    this.persist();
    let result: { execution: Execution; value: T };
    try {
      result = await dispatch({
        owner: this.report.owner,
        requestId,
        directory: this.directory,
      });
    } catch (error) {
      this.#uncertain = true;
      if (this.#parentSession) {
        this.#parentSession.#uncertain = true;
        this.#parentSession.persist();
      }
      this.persist();
      throw error;
    }
    entry.result = result.execution;
    const receipt = result.execution.brokerReceipt;
    this.#uncertain =
      result.execution.requestId !== requestId ||
      !result.execution.sdkSettled ||
      result.execution.state === "unknown" ||
      (receipt !== undefined &&
        (receipt.requestId !== requestId ||
          receipt.clientId !== this.report.owner.clientId ||
          !receipt.jobId ||
          receipt.state !== result.execution.state));
    if (this.#uncertain && this.#parentSession) {
      this.#parentSession.#uncertain = true;
      this.#parentSession.persist();
    }
    this.persist();
    if (this.#uncertain)
      throw new Error(
        "Unsettled or mismatched original request; cleanup deferred, never replay",
      );
    // Native import receipts must settle before a case catch/finally can issue
    // further probes or delete the file that proves its original child identity.
    if (fs.existsSync(path.join(this.directory, "children")))
      this.verifyChildClosures();
    return result.value;
  }
  async #dispatch(
    phase: string,
    source: string | ((requestId: string) => string),
    target?: Document,
    routeTarget = true,
    helpers?: "cad-v1",
    command?: ScriptRequest["command"],
    inspectCli?: ScriptRequest["inspectCli"],
  ): Promise<Record<string, unknown>> {
    const execution = await this.#registeredRequest(
      phase,
      {
        kind: inspectCli ? "inspect-cli" : command ? "cad" : "script",
        ...(inspectCli ? { readOnly: true } : {}),
        ...(inspectCli ? { command: inspectCli } : {}),
      },
      async ({ owner, requestId, directory }) => {
        const execution = await this.backend.execute({
          owner,
          requestId,
          source: typeof source === "string" ? source : source(requestId),
          directory,
          ...(helpers ? { helpers } : {}),
          ...(command ? { command } : {}),
          ...(inspectCli ? { inspectCli } : {}),
          ...(target && routeTarget ? { target } : {}),
        });
        return { execution, value: execution };
      },
    );
    if (
      this.backend.qualification === "broker" &&
      execution.state === "succeeded"
    )
      assert.equal(
        execution.exitCode,
        0,
        "Successful public CLI command lacks its original zero exit status",
      );
    if (
      phase === "create" &&
      execution.state === "failed" &&
      !execution.mayHaveMutated
    )
      this.report.cleanup = "not-created";
    if (command?.expectRejected && execution.state === "failed") {
      try {
        if (execution.stdout.trim())
          commandResult(execution.stdout, target ? [target] : undefined);
      } catch (error) {
        this.#uncertain = true;
        this.persist();
        throw error;
      }
      return {};
    }
    if (command && execution.stdout.trim()) {
      if (!target) throw new Error("CAD command has no owned target");
      try {
        const output = commandResult(execution.stdout, [target]);
        if (
          output["context"] === undefined &&
          output["success"] === true &&
          !["preview", "validate"].includes(String(command.data["mode"])) &&
          ["definition.instantiate", "batch.run"].includes(command.operation)
        )
          throw new Error("Successful batch has no pinned context");
        return output;
      } catch (error) {
        this.#uncertain = true;
        this.persist();
        throw error;
      }
    }
    if (execution.state !== "succeeded")
      throw new Error(execution.error || "Fusion operation failed");
    if (inspectCli) return {};
    const lines = execution.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith(programs.marker));
    try {
      if (lines.length !== 1)
        throw new Error("Expected exactly one scenario result marker");
      const value = record(
        JSON.parse(text(lines[0]).slice(programs.marker.length)) as unknown,
      );
      if (target && value["creationId"] !== target.creationId)
        throw new Error(
          "Foreign document result; recover the original request before cleanup",
        );
      return value;
    } catch (error) {
      this.#uncertain = true;
      this.persist();
      throw error;
    }
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
      const durableValue = readCreation(this.directory);
      const durable = creationProof(durableValue, this.report.owner, requestId);
      if (returned.creationId !== durable.creationId)
        throw new Error("Returned and durable creation identities differ");
      if (value["activeCreationId"] !== durableValue["activeCreationId"])
        throw new Error(
          "Returned and durable creation active observations differ",
        );
      this.#document = returned;
    } catch (error) {
      this.#uncertain = true;
      throw error;
    }
    this.report.document = this.#document;
    this.persist();
    if (value["activeCreationId"] !== this.document.creationId)
      throw new Error(
        "Newly created document was not active at creation completion",
      );
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
    if (this.report.cleanup === "complete" && !this.#uncertain) return;
    for (const peer of this.#peerSessions.values()) {
      await peer.cleanup();
      if (peer.report.cleanup !== "complete") this.#uncertain = true;
    }
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
        this.#verifyChildClosures();
      } catch (error) {
        this.#uncertain = true;
        this.report.cleanup = "deferred";
        this.persist();
        throw error;
      }
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
  if (scenario.lifecycle === "read-only") {
    if (scenario.scope !== "exclusive-instance" || scenario.fixture)
      throw new Error(
        "Readonly transport scenarios require exclusive scope without a fixture",
      );
    session.report.lifecycle = "read-only";
  }
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
    if (
      scenario.requires.includes("original-user-view") ||
      scenario.requires.includes("original-user-view-absolute-camera")
    )
      await session.captureUserView(
        scenario.requires.includes("original-user-view-absolute-camera"),
      );
    if (scenario.lifecycle !== "read-only") await session.setup();
    await scenario.run(session);
    session.report.status = "passed";
  } catch (error) {
    session.report.status = "failed";
    session.report.error = errorText(error);
  } finally {
    try {
      await session.cleanup();
      await session.restoreUserView();
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
    return {
      requestId: text(row["requestId"]),
      phase: text(row["phase"]),
      ...(row["intent"] ? { intent: record(row["intent"]) } : {}),
    };
  });
  if (
    new Set(requests.map((r) => r.requestId)).size !== requests.length ||
    requests.some((r) => !r.requestId.startsWith(owner.clientId + ":"))
  )
    throw new Error("Invalid original request inventory");
  if (raw["cleanupHold"] !== undefined)
    throw new Error(
      "Case-specific mutation outcome remains unresolved; original SDK completion alone cannot release its cleanup hold",
    );
  // A crashed parent may not yet have appended the child's durable original request IDs.
  const legacy = await recoverLegacyInvocations(backend, directory, owner);
  for (const entry of legacy)
    if (!requests.some((request) => request.requestId === entry.requestId))
      requests.push({ requestId: entry.requestId, phase: entry.phase });
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
    if (entry.phase.startsWith("cad-") && result.stdout.trim())
      commandResult(result.stdout);
    recovered.push({ ...entry, result });
  }
  const creation = recovered.filter((entry) => entry.phase === "create");
  if (raw["lifecycle"] === "read-only") {
    assert.equal(raw["scope"], "exclusive-instance");
    assert.equal(raw["document"], undefined);
    assert.equal(raw["fixture"], undefined);
    assert.equal(creation.length, 0);
    assert.ok(
      recovered.every(
        (entry) =>
          entry.intent?.["readOnly"] === true &&
          entry.result?.mayHaveMutated === false,
      ),
      "Original readonly receipts do not prove no mutation",
    );
    const peers: Owner[] = [];
    if (raw["peers"] !== undefined) {
      assert.ok(Array.isArray(raw["peers"]) && raw["peers"].length <= 10);
      for (const value of raw["peers"]) {
        const peer = record(value);
        const scenarioId = text(peer["scenarioId"]);
        assert.ok(scenarioId.startsWith(owner.scenarioId + "-peer-"));
        assert.match(
          scenarioId.slice((owner.scenarioId + "-peer-").length),
          /^[a-z][a-z0-9-]{0,20}$/u,
        );
        assert.equal(peer["runId"], owner.runId);
        assert.equal(
          peer["clientId"],
          "scenario:" + owner.runId + ":" + scenarioId,
        );
        const identity = {
          runId: owner.runId,
          scenarioId,
          clientId: text(peer["clientId"]),
        };
        assert.ok(!peers.some((prior) => prior.clientId === identity.clientId));
        const result = await resumeCleanup(
          backend,
          path.join(path.dirname(directory), scenarioId, "report.json"),
        );
        assert.equal(result.lifecycle, "read-only");
        assert.equal(result.cleanup, "complete");
        peers.push(identity);
      }
    }
    const report: ScenarioReport = {
      owner,
      directory,
      mode: backend.mode,
      qualification: backend.qualification,
      protocol: backend.protocol,
      backendIdentity: backend.identity,
      lifecycle: "read-only",
      scope: "exclusive-instance",
      status: "failed",
      cleanup: "complete",
      requests: recovered,
      ...(peers.length ? { peers } : {}),
      error: "Recovered readonly requests; assertions were not rerun",
    };
    persist(file, report);
    await auditRecovery(backend, report);
    return report;
  }
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
    for (const entry of recovered)
      if (entry.phase.startsWith("cad-") && entry.result?.stdout.trim())
        commandResult(entry.result.stdout, [
          originalDocument,
          session.document,
        ]);
  } catch (error) {
    report.cleanup = "deferred";
    report.cleanupError = errorText(error);
    session.persist();
    throw error;
  }
  try {
    await session.cleanup();
    await session.restoreUserView();
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

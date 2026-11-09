import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import {
  decodePublicResult,
  type JsonValue,
  type OperationContract,
  type OperationResult,
} from "@fmcad/core";
import type { Execution } from "./contracts";
import type { Scenario } from "./runner";
import { concurrencyLimit } from "./scheduling";
import {
  nativeModelingHarness,
  nativeResultUncertain,
} from "./native-modeling-support";
type JsonRecord = Record<string, JsonValue>;
type Operation =
  | "sketch.dimension-plan"
  | "sketch.dimension-apply"
  | "sketch.mirror"
  | "sketch.offset"
  | "sketch.pattern"
  | "sketch.project"
  | "sketch.transform"
  | "sketch.coordinate-check"
  | "sketch.check";
type SketchReference = JsonRecord & {
  token: string;
};
type DocumentRow = {
  raw: string;
  name: string | null;
  id: string | null;
  creationId: string | null;
  active: boolean | null;
};
type OwnedDocument = {
  name: string;
  creationId: string;
};
type QueueReceipt = {
  requestId: string;
  jobId: string;
  clientId: string;
  state: string;
  operationResult: OperationResult;
};
type CommandEvidence = {
  args: string[];
  exitCode: number | null;
  signal?: string;
  error?: string;
  stdoutBytes: number;
  stdoutSha256: string;
  stdout: string;
  stderr: string;
  status: string;
  queue?: QueueReceipt;
};
type MethodEvidence = {
  operation: string;
  status: "invoked" | "pass";
  supportOnly: boolean;
  service: string;
  sdk: string;
  readOnly: boolean;
  creationId: string | null;
  queue: QueueReceipt;
  result: JsonRecord;
  assertions?: string[];
  evidence?: string;
  offsetParameter?: string | null;
};
type AssertionEvidence = {
  operation: string;
  label: string;
  actual: JsonValue;
  expected: JsonValue;
  tolerance: number;
  status: "pass" | "fail";
};
type InventorySnapshot = {
  count: number;
  stableSha256: string;
  activeSha256: string | null;
  ownDocumentCount: number;
};
type TestEvidence = {
  name: string;
  status: string;
  error?: string;
};
type Contract = Pick<
  OperationContract,
  "operation" | "service" | "readOnlyRequested" | "cli"
> & {
  declaration: JsonRecord;
  requirements: Pick<OperationContract["requirements"], "sdk" | "document">;
};
type InstalledCatalog = {
  contracts: Readonly<Record<string, Contract>>;
  catalog: Readonly<Record<string, JsonRecord>>;
  localInvocation(input: {
    operation: string;
    data: JsonRecord;
    preview: false;
  }): boolean;
  validateCad(operation: string, data: JsonRecord): unknown;
};
type InstalledCommandRoute = {
  key: string;
  target: string;
  kind: string;
};
type InstalledCommandRegistry = {
  findCommand(argv: string[]): InstalledCommandRoute | undefined;
};
type LiveReport = {
  suite: string;
  sourceCommit: string;
  startedAt: string;
  clientId: string;
  runtime: {
    root: string;
    buildHash: string;
    catalogCount: number;
  };
  document: {
    name: string;
    creationId?: string;
    savedBefore?: boolean;
    modifiedBefore?: boolean;
    fileIdBefore?: string | null;
  };
  scope: string;
  operations: readonly Operation[];
  supportOnly: readonly string[];
  commands: CommandEvidence[];
  supportResults: MethodEvidence[];
  methodResults: MethodEvidence[];
  assertions: AssertionEvidence[];
  tests: TestEvidence[];
  inventory: {
    before?: InventorySnapshot;
    afterCreate?: InventorySnapshot;
    after?: InventorySnapshot;
    userDocumentsUnchanged?: boolean;
  };
  fixtureClosed: boolean;
  cleanup: string;
  cleanupError?: string;
  limitations: string[];
  sketchNames?: Record<string, string>;
  fixtureRefs?: string[];
  operationCoverage?: Array<Record<string, JsonValue>>;
  finishedAt?: string;
};
type SketchSuite = {
  sketchNames: {
    dimension: string;
    operations: string;
    projectSource: string;
    projectTarget: string;
  };
  refs: Record<string, SketchReference>;
};
class PreDispatchError extends Error {}
const operations: readonly Operation[] = [
  "sketch.dimension-plan",
  "sketch.dimension-apply",
  "sketch.mirror",
  "sketch.offset",
  "sketch.pattern",
  "sketch.project",
  "sketch.transform",
  "sketch.coordinate-check",
  "sketch.check",
];
const operationSet: ReadonlySet<string> = new Set(operations);
const readOnlyOperations = new Set<Operation>([
  "sketch.dimension-plan",
  "sketch.coordinate-check",
  "sketch.check",
]);
const terminalStates = new Set(["succeeded", "failed", "cancelled", "expired"]);
export const nativeSketchOperationsCapability = "native-sketch-operations";
export function nativeSketchOperationsScenarios(owners = 10): Scenario[] {
  concurrencyLimit(owners);
  return Array.from({ length: owners }, (_, index): Scenario => ({
    id: "native-sketch-operations-" + index,
    requires: ["documents", nativeSketchOperationsCapability],
    scope: "exclusive-instance",
    async run(session) {
      const harness = await nativeModelingHarness(
        session,
        "tests/live-sketch-operations.ts",
        [],
        operations,
      );
      const identity: OwnedDocument = session.document;
      const runId = createHash("sha256")
        .update(session.report.owner.clientId)
        .digest("hex")
        .slice(0, 12)
        .toUpperCase();
      const documentName = identity.name,
        fixturePrefix = `NQSKETCHOPS${runId}`;
      const projectRoot = path.resolve(__dirname, "../../..");
      const reportPath = path.join(
        session.directory,
        "native-sketch-operations.json",
      );
      const report: LiveReport = {
        suite: "sketch-operations",
        sourceCommit: "not-read",
        startedAt: new Date().toISOString(),
        clientId: session.report.owner.clientId,
        runtime: {
          root: "not-loaded",
          buildHash: "not-loaded",
          catalogCount: 0,
        },
        document: { name: documentName },
        scope:
          "One newly created unsaved document owned by this suite; no save, cloud writes, existing-document edits, or preference changes.",
        operations,
        supportOnly: [
          "active",
          "doc list",
          "doc new",
          "document.status",
          "sketch.create",
          "sketch.geometry",
          "sketch.inspect",
          "doc close --discard",
        ],
        commands: [],
        supportResults: [],
        methodResults: [],
        assertions: [],
        tests: [],
        inventory: {},
        fixtureClosed: false,
        cleanup: "not-started",
        limitations: [
          "Readbacks cover native sketch entities and solver state, not BRep creation or physical certification.",
        ],
      };
      let runtimeRoot = "",
        cliPath = "",
        sequence = 0;
      let installedCatalog: InstalledCatalog | undefined;
      let installedCommands: InstalledCommandRegistry | undefined;
      let baselineStable: string[] = [];
      let unknownExecution = false;
      let blockedReason: string | undefined;
      let failure: Error | undefined;
      function isRecord(value: unknown): value is Record<string, unknown> {
        return (
          value !== null && typeof value === "object" && !Array.isArray(value)
        );
      }
      function record(value: unknown, label: string): Record<string, unknown> {
        assert.ok(isRecord(value), `${label} must be an object`);
        return value;
      }
      function jsonValue(value: unknown, label: string): JsonValue {
        if (
          value === null ||
          typeof value === "string" ||
          typeof value === "boolean" ||
          (typeof value === "number" && Number.isFinite(value))
        )
          return value;
        if (Array.isArray(value))
          return value.map((item) => jsonValue(item, label));
        assert.ok(isRecord(value), `${label} must contain JSON values`);
        const result: JsonRecord = {};
        for (const [key, child] of Object.entries(value))
          result[key] = jsonValue(child, `${label}.${key}`);
        return result;
      }
      function jsonRecord(value: unknown, label: string): JsonRecord {
        const source = record(value, label);
        const result: JsonRecord = {};
        for (const [key, child] of Object.entries(source))
          result[key] = jsonValue(child, `${label}.${key}`);
        return result;
      }
      function stringValue(value: unknown, label: string): string {
        if (typeof value !== "string")
          throw new TypeError(`${label} must be a string`);
        return value;
      }
      function numberValue(value: unknown, label: string): number {
        if (typeof value !== "number" || !Number.isFinite(value))
          throw new TypeError(`${label} must be a finite number`);
        return value;
      }
      function booleanValue(value: unknown, label: string): boolean {
        if (typeof value !== "boolean")
          throw new TypeError(`${label} must be boolean`);
        return value;
      }
      function arrayValue(value: unknown, label: string): unknown[] {
        if (!Array.isArray(value))
          throw new TypeError(`${label} must be an array`);
        return value;
      }
      function fieldRecord(
        value: Record<string, unknown>,
        key: string,
        label = key,
      ): Record<string, unknown> {
        return record(value[key], label);
      }
      function fieldString(
        value: Record<string, unknown>,
        key: string,
        label = key,
      ): string {
        return stringValue(value[key], label);
      }
      function fieldNumber(
        value: Record<string, unknown>,
        key: string,
        label = key,
      ): number {
        return numberValue(value[key], label);
      }
      function fieldBoolean(
        value: Record<string, unknown>,
        key: string,
        label = key,
      ): boolean {
        return booleanValue(value[key], label);
      }
      function fieldArray(
        value: Record<string, unknown>,
        key: string,
        label = key,
      ): unknown[] {
        return arrayValue(value[key], label);
      }
      function fieldOptionalString(
        value: Record<string, unknown>,
        key: string,
      ): string | null {
        const item = value[key];
        if (item === null || item === undefined) return null;
        return stringValue(item, key);
      }
      function requiredEnv(key: string): string {
        const value = process.env[key];
        if (!value?.trim())
          throw new Error(
            `${key} is required; no live test starts without it.`,
          );
        return value;
      }
      function parseJsonRecord(text: string, label: string): JsonRecord {
        let value: unknown;
        try {
          value = JSON.parse(text);
        } catch {
          throw new Error(`${label} did not return valid JSON`);
        }
        return jsonRecord(value, label);
      }
      function gitText(args: string[]): string {
        const result = spawnSync("git", args, {
          cwd: projectRoot,
          encoding: "utf8",
        });
        assert.equal(
          result.status,
          0,
          result.stderr || `git ${args.join(" ")} failed`,
        );
        return result.stdout.trim();
      }
      function loadInstalledRuntime(): void {
        runtimeRoot = fs.realpathSync(requiredEnv("FMCAD_LIVE_RUNTIME_ROOT"));
        cliPath = path.join(runtimeRoot, "dist/bin/fmcad.js");
        assert.equal(
          fs.realpathSync(cliPath),
          cliPath,
          "CLI must resolve from the selected installed runtime.",
        );
        const distRoot = fs.realpathSync(path.join(runtimeRoot, "dist"));
        const runtimeRequire = createRequire(__filename);
        const runtimeModule = record(
          runtimeRequire(
            path.join(distRoot, "src/queue-instance.js"),
          ) as unknown,
          "installed queue runtime",
        );
        const buildHashFunction = runtimeModule["buildHash"];
        assert.ok(
          typeof buildHashFunction === "function",
          "Installed runtime has no buildHash function.",
        );
        const buildHash = stringValue(
          buildHashFunction(),
          "installed build hash",
        );
        const installedIdentity = parseJsonRecord(
          fs.readFileSync(path.join(distRoot, "runtime-build.json"), "utf8"),
          "installed runtime identity",
        );
        assert.equal(buildHash, fieldString(installedIdentity, "fingerprint"));
        const catalogModule = record(
          runtimeRequire(
            path.join(distRoot, "src/catalog/index.js"),
          ) as unknown,
          "installed catalog",
        );
        const catalog = record(
          catalogModule["catalog"],
          "installed declarations",
        );
        const contracts = record(
          catalogModule["contracts"],
          "installed contracts",
        );
        const localInvocationFunction = catalogModule["localInvocation"];
        const validateCadFunction = catalogModule["validateCad"];
        assert.ok(typeof localInvocationFunction === "function");
        assert.ok(typeof validateCadFunction === "function");
        installedCatalog = {
          catalog: Object.fromEntries(
            Object.entries(catalog).map(([key, value]) => [
              key,
              jsonRecord(value, `catalog ${key}`),
            ]),
          ),
          contracts: Object.fromEntries(
            Object.entries(contracts).map(([key, value]) => [
              key,
              parseContract(key, value),
            ]),
          ),
          localInvocation: (input) =>
            Boolean(
              localInvocationFunction({
                operation: input.operation,
                data: input.data,
                preview: input.preview,
              }),
            ),
          validateCad: (operation, data) =>
            validateCadFunction(operation, data),
        };
        const commandModule = record(
          runtimeRequire(path.join(distRoot, "src/commands.js")) as unknown,
          "installed command registry",
        );
        const findCommandFunction = commandModule["findCommand"];
        assert.ok(typeof findCommandFunction === "function");
        installedCommands = {
          findCommand: (argv) => {
            const route: unknown = findCommandFunction(argv);
            if (route === undefined) return undefined;
            const value = record(route, "installed command route");
            return {
              key: fieldString(value, "key"),
              target: fieldString(value, "target"),
              kind: fieldString(value, "kind"),
            };
          },
        };
        report.sourceCommit = gitText(["rev-parse", "HEAD"]);
        report.clientId = session.report.owner.clientId;
        report.runtime = {
          root: runtimeRoot,
          buildHash,
          catalogCount: Object.keys(catalog).length,
        };
        validateInstalledContracts();
      }
      function parseContract(operation: string, value: unknown): Contract {
        const source = record(value, `contract ${operation}`);
        const service = fieldRecord(source, "service", `${operation} service`);
        const requirements = fieldRecord(
          source,
          "requirements",
          `${operation} requirements`,
        );
        const cli = fieldRecord(source, "cli", `${operation} CLI route`);
        return {
          operation: fieldString(source, "operation"),
          declaration: jsonRecord(
            source["declaration"],
            `${operation} declaration`,
          ),
          service: {
            kind: enumValue(
              fieldString(service, "kind"),
              ["local", "coordinator", "python"],
              `${operation} service kind`,
            ),
            handler: fieldString(service, "handler"),
          },
          requirements: {
            sdk: enumValue(
              fieldString(requirements, "sdk"),
              ["none", "required", "conditional"],
              `${operation} SDK requirement`,
            ),
            document: fieldBoolean(requirements, "document"),
          },
          readOnlyRequested: fieldBoolean(source, "readOnlyRequested"),
          cli: {
            key: fieldString(cli, "key"),
            aliases: fieldArray(cli, "aliases").map((value) =>
              stringValue(value, `${operation} CLI alias`),
            ),
          },
        };
      }
      function enumValue<const Values extends readonly string[]>(
        value: string,
        allowed: Values,
        label: string,
      ): Values[number] {
        const selected = allowed.find((candidate) => candidate === value);
        if (selected === undefined)
          throw new Error(`${label} is not in the installed DTO union.`);
        return selected;
      }
      function isSketchOperation(value: string): value is Operation {
        return operationSet.has(value);
      }
      function validateInstalledContracts(): void {
        const runtimeCatalog = installedCatalog;
        if (!runtimeCatalog)
          throw new Error("Installed catalog is not loaded.");
        for (const operation of operations) {
          const contract: Contract | undefined =
            runtimeCatalog.contracts[operation];
          const declaration: JsonRecord | undefined =
            runtimeCatalog.catalog[operation];
          assert.ok(
            contract && declaration,
            `Installed runtime is missing ${operation}.`,
          );
          commandRoute(contract.cli.key, operation);
          assert.equal(
            contract.service.kind,
            "python",
            `${operation} must use the Fusion Python service.`,
          );
          assert.equal(
            contract.requirements.sdk,
            "required",
            `${operation} must require the SDK.`,
          );
          assert.equal(
            contract.requirements.document,
            true,
            `${operation} must be document-scoped.`,
          );
          assert.equal(
            contract.readOnlyRequested,
            readOnlyOperations.has(operation),
            operation,
          );
          const example = jsonRecord(
            declaration["example"],
            `${operation} example`,
          );
          assert.equal(
            runtimeCatalog.localInvocation({
              operation,
              data: example,
              preview: false,
            }),
            false,
            `${operation} must not use a local/offline path.`,
          );
          runtimeCatalog.validateCad(operation, example);
        }
        for (const [key, target] of [
          ["active", "activeCmd"],
          ["doc list", "docListCmd"],
          ["doc new", "docNewCmd"],
          ["doc close", "docCloseCmd"],
        ] as const)
          commandRoute(key, target);
      }
      function persist(): void {
        fs.mkdirSync(path.dirname(reportPath), { recursive: true });
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", {
          flag: "w",
        });
      }
      function commandRoute(
        commandKey: string,
        expectedTarget?: string,
      ): InstalledCommandRoute {
        if (!installedCommands)
          throw new Error("Installed command registry is not loaded.");
        const route = installedCommands.findCommand(commandKey.split(" "));
        if (!route)
          throw new Error(
            `Installed CLI does not generate route ${commandKey}.`,
          );
        assert.equal(
          route.key,
          commandKey,
          `Installed CLI resolved an unexpected route for ${commandKey}.`,
        );
        if (expectedTarget !== undefined)
          assert.equal(
            route.target,
            expectedTarget,
            `Installed CLI route ${commandKey} targets the wrong operation.`,
          );
        return route;
      }
      function sketchReference(value: unknown, label: string): SketchReference {
        const ref = jsonRecord(value, label);
        assert.ok(
          fieldString(ref, "token", `${label}.token`).length > 0,
          `${label} token must not be empty.`,
        );
        return { ...ref, token: fieldString(ref, "token", `${label}.token`) };
      }
      function assertReadOnlyDispatch(operation: string): Contract {
        const runtimeCatalog = installedCatalog;
        if (!runtimeCatalog)
          throw new Error("Installed catalog is not loaded.");
        const contract: Contract | undefined =
          runtimeCatalog.contracts[operation];
        if (!contract)
          throw new Error(`Installed runtime does not expose ${operation}.`);
        return contract;
      }
      function verifyOriginalReceipt(
        execution: Execution,
        requestId: string,
        operation: string,
      ): QueueReceipt {
        const raw = execution.brokerReceipt;
        if (!raw)
          return session.deferCleanup(
            "Native sketch command has no original broker receipt; inspect, never retry.",
          );
        let operationResult: OperationResult;
        try {
          operationResult = decodePublicResult(raw.operationResult);
        } catch {
          unknownExecution = true;
          return session.deferCleanup(
            "Queue terminal result has no valid typed operationResult; inspect, never retry.",
          );
        }
        if (
          raw.requestId !== requestId ||
          raw.clientId !== session.report.owner.clientId ||
          operationResult.requestId !== requestId ||
          operationResult.jobId !== raw.jobId
        ) {
          unknownExecution = true;
          session.deferCleanup(
            "Queue receipt identity mismatch; inspect the original request, never retry.",
          );
        }
        if (
          !terminalStates.has(raw.state) ||
          ["unknown", "active", "partial"].includes(
            operationResult.executionOutcome,
          )
        ) {
          unknownExecution = true;
          session.deferCleanup(
            "Queue execution outcome is unknown or partial; inspect, never retry.",
          );
        }
        if (operationResult.executionOutcome === "not_started") {
          blockedReason =
            operationResult.code ?? `${operation} did not start in Fusion.`;
          throw new PreDispatchError(blockedReason);
        }
        if (
          (raw.state === "succeeded") !==
          (operationResult.executionOutcome === "succeeded")
        ) {
          unknownExecution = true;
          session.deferCleanup(
            "Queue state conflicts with its typed execution outcome; inspect, never retry.",
          );
        }
        if (operationResult.executionOutcome === "failed") {
          if (operationResult.mayHaveMutated !== false) {
            unknownExecution = true;
            session.deferCleanup(
              `${operation} failed after possible mutation; inspect the owned document and never retry.`,
            );
          }
          throw new Error(
            `${operation} terminated without mutation: ${operationResult.code ?? "unspecified failure"}`,
          );
        }
        if (operationResult.executionOutcome !== "succeeded") {
          unknownExecution = true;
          session.deferCleanup(
            `${operation} has no settled successful execution result; inspect, never retry.`,
          );
        }
        return {
          requestId: raw.requestId,
          jobId: raw.jobId,
          clientId: raw.clientId,
          state: raw.state,
          operationResult,
        };
      }
      async function inspect(
        command: "active" | "doc-list",
      ): Promise<Execution> {
        const execution = await session.inspectCli(
          "inspect-sketch-" + sequence++,
          command,
        );
        const request = session.report.requests.at(-1);
        assert.ok(
          request?.result,
          "Original read-only CLI evidence is unavailable",
        );
        const receipt = verifyOriginalReceipt(
          execution,
          request.requestId,
          command,
        );
        assert.equal(
          execution.state,
          "succeeded",
          execution.stderr ?? execution.stdout,
        );
        if (execution.exitCode !== undefined)
          assert.equal(
            execution.exitCode,
            0,
            execution.stderr ?? execution.stdout,
          );
        assert.equal(
          receipt.state,
          "succeeded",
          execution.stderr ?? execution.stdout,
        );
        return execution;
      }
      async function invokeCad(
        operation: string,
        data: JsonRecord,
        options: {
          supportOnly?: boolean;
          docName?: string;
          pin?: boolean;
        } = {},
      ): Promise<{
        result: JsonRecord;
        evidence: MethodEvidence;
      }> {
        const contract = assertReadOnlyDispatch(operation);
        const docName = options.docName ?? identity?.name ?? documentName;
        const pin = true; // The shared lifecycle always requires the exact creationId.
        assert.equal(
          contract.service.kind,
          "python",
          `${operation} must dispatch to Fusion Python.`,
        );
        assert.equal(
          contract.requirements.sdk,
          "required",
          `${operation} requires SDK dispatch.`,
        );
        assert.equal(
          contract.requirements.document,
          true,
          `${operation} must have a document scope.`,
        );
        if (isSketchOperation(operation)) {
          assert.equal(
            contract.readOnlyRequested,
            readOnlyOperations.has(operation),
            operation,
          );
        }
        const runtimeCatalog = installedCatalog;
        if (!runtimeCatalog)
          throw new Error("Installed catalog is not loaded.");
        assert.equal(
          runtimeCatalog.localInvocation({ operation, data, preview: false }),
          false,
          operation,
        );
        runtimeCatalog.validateCad(operation, data);
        if (pin && !identity)
          throw new Error(`${operation} requires the exact owned creationId.`);
        assert.equal(
          docName,
          identity.name,
          "Every native sketch command must remain owned",
        );
        if (!contract.readOnlyRequested) await harness.guard();
        let output: Record<string, unknown>;
        try {
          output = await session.cad(
            "cad-sketch-" + sequence++,
            operation,
            data,
            { spelling: contract.cli.key.split(" ") },
          );
        } catch (error) {
          const failed = session.report.requests.at(-1)?.result;
          if (session.uncertain || failed?.mayHaveMutated !== false) {
            unknownExecution = true;
            if (session.uncertain) throw error;
            session.deferCleanup(
              `${operation} failed after possible mutation; inspect the owned document and never retry.`,
            );
          }
          throw error;
        }
        const request = session.report.requests.at(-1);
        assert.ok(
          request?.result,
          "No original native request execution evidence",
        );
        const execution = request.result;
        const receipt = verifyOriginalReceipt(
          execution,
          request.requestId,
          operation,
        );
        if (nativeResultUncertain(output))
          return session.deferCleanup(
            `${operation} result is unknown/pending; inspect, never retry.`,
          );
        const responseOperation = fieldString(output, "operation"),
          responseDocument = fieldString(output, "document");
        const success = fieldBoolean(output, "success"),
          result = jsonRecord(output["result"], `${operation} result`);
        const evidence: MethodEvidence = {
          operation,
          status: "invoked",
          supportOnly: options.supportOnly ?? false,
          service: contract.service.kind,
          sdk: contract.requirements.sdk,
          readOnly: contract.readOnlyRequested,
          creationId: identity.creationId,
          queue: receipt,
          result,
        };
        if (options.supportOnly) report.supportResults.push(evidence);
        else report.methodResults.push(evidence);
        persist();
        assert.equal(responseOperation, operation);
        assert.equal(responseDocument, docName);
        assert.equal(
          execution.state,
          "succeeded",
          execution.error ?? execution.stdout,
        );
        if (execution.exitCode !== undefined)
          assert.equal(
            execution.exitCode,
            0,
            execution.stderr ?? execution.stdout,
          );
        assert.equal(
          receipt.state,
          "succeeded",
          execution.error ?? execution.stdout,
        );
        assert.equal(success, true, execution.stdout);
        return { result, evidence };
      }
      function fieldValue(line: string, key: string): string | null {
        const pattern = new RegExp(
          `(?:^|\\s)${key}=(.*?)(?=\\s+(?:name|id|creationId|isActive|isModified|isSaved)=|$)`,
          "u",
        );
        return line.match(pattern)?.[1]?.trim() ?? null;
      }

      function stableDocument(row: DocumentRow): string {
        return row.raw
          .replace(/\s+isActive=(?:true|false)(?=\s|$)/u, "")
          .replace(/\s+/gu, " ")
          .trim();
      }

      function stableRows(rows: readonly DocumentRow[]): string[] {
        return rows.map(stableDocument).sort();
      }

      function activeDocumentKey(rows: readonly DocumentRow[]): string | null {
        const active = rows.filter((row) => row.active === true);
        assert.ok(
          active.length <= 1,
          "Fusion listed multiple active documents.",
        );
        if (rows.length > 0 && active.length !== 1)
          throw new Error(
            "Document inventory did not expose the active document; safe restore cannot be verified.",
          );
        const row = active[0];
        return row
          ? createHash("sha256").update(stableDocument(row)).digest("hex")
          : null;
      }

      function ownRows(rows: readonly DocumentRow[]): DocumentRow[] {
        return rows.filter(
          (row) =>
            row.name === documentName ||
            row.raw.startsWith(`DOC name=${documentName} `),
        );
      }

      async function assertFusionIdle(): Promise<void> {
        const run = await inspect("active");
        if (run.stdout.trim() === "NONE") return;
        const value = parseJsonRecord(
          run.stdout.trim(),
          "active command response",
        );
        const active = value["activeCommand"];
        const commandId = isRecord(active) ? active["id"] : active;
        assert.ok(
          commandId === null ||
            commandId === undefined ||
            commandId === "" ||
            commandId === "SelectCommand",
          "Fusion has an interactive command active; stop before mutation or close.",
        );
      }
      async function readDocumentList(): Promise<DocumentRow[]> {
        const run = await inspect("doc-list");
        assert.match(run.stdout, /(?:^|\r?\n)DONE(?:\r?\n|$)/u);
        return run.stdout
          .split(/\r?\n/u)
          .filter((line) => line.startsWith("DOC "))
          .map((raw) => ({
            raw,
            name: fieldValue(raw, "name"),
            id: fieldValue(raw, "id"),
            creationId: fieldValue(raw, "creationId"),
            active:
              fieldValue(raw, "isActive") === null
                ? null
                : fieldValue(raw, "isActive") === "true",
          }));
      }
      function assertOtherDocumentsPreserved(
        rows: readonly DocumentRow[],
      ): void {
        const remaining = stableRows(
          rows.filter((row) => !ownRows([row]).length),
        );
        for (const expected of baselineStable) {
          const index = remaining.indexOf(expected);
          assert.notEqual(
            index,
            -1,
            "A pre-existing document changed or disappeared.",
          );
          remaining.splice(index, 1);
        }
      }

      async function guardOwned(): Promise<JsonRecord> {
        assert.ok(identity, "No exact test document identity.");
        await harness.guard();
        const { result: status } = await invokeCad(
          "document.status",
          {},
          { supportOnly: true },
        );
        assertion(
          "document.status",
          "name remains the owned name",
          status["name"],
          identity.name,
        );
        assertion(
          "document.status",
          "creationId remains exact",
          status["creationId"],
          identity.creationId,
        );
        assertion(
          "document.status",
          "owned document remains unsaved",
          status["saved"],
          false,
        );
        assertion(
          "document.status",
          "owned document has no cloud file",
          status["fileId"],
          null,
        );
        await harness.guard();
        const rows = await readDocumentList();
        assertOtherDocumentsPreserved(rows);
        activeDocumentKey(rows);
        const own = ownRows(rows);
        assert.equal(
          own.length,
          1,
          "Exact test document must be uniquely open.",
        );
        if (own[0]?.creationId !== null && own[0]?.creationId !== undefined)
          assert.equal(own[0].creationId, identity.creationId);
        assert.equal(
          own[0]?.active,
          true,
          "Test document must be active before CAD work or close.",
        );
        await assertFusionIdle();
        return status;
      }
      function assertion(
        operation: string,
        label: string,
        actual: unknown,
        expected: unknown,
      ): void {
        const actualJson = jsonValue(actual, `${label} actual`);
        const expectedJson = jsonValue(expected, `${label} expected`);
        const passed = isDeepStrictEqual(actualJson, expectedJson);
        report.assertions.push({
          operation,
          label,
          actual: actualJson,
          expected: expectedJson,
          tolerance: 0,
          status: passed ? "pass" : "fail",
        });
        const method = [...report.methodResults]
          .reverse()
          .find(
            (row) => row.operation === operation && row.status === "invoked",
          );
        if (method) method.assertions = [...(method.assertions ?? []), label];
        persist();
        assert.ok(
          passed,
          `${label}: ${JSON.stringify({ actual: actualJson, expected: expectedJson })}`,
        );
      }
      function near(
        operation: string,
        label: string,
        actual: number,
        expected: number,
        tolerance = 1e-8,
      ): void {
        const passed =
          Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
        const row: AssertionEvidence = {
          operation,
          label,
          actual,
          expected,
          tolerance,
          status: passed ? "pass" : "fail",
        };
        report.assertions.push(row);
        const method = [...report.methodResults]
          .reverse()
          .find(
            (item) => item.operation === operation && item.status === "invoked",
          );
        if (method) method.assertions = [...(method.assertions ?? []), label];
        persist();
        assert.ok(passed, JSON.stringify(row));
      }
      function validated(evidence: MethodEvidence, note: string): void {
        assert.ok(
          evidence,
          "Invocation evidence must exist before validation.",
        );
        evidence.status = "pass";
        evidence.evidence = note;
        persist();
      }
      async function group(
        name: string,
        action: () => Promise<void>,
      ): Promise<boolean> {
        try {
          await action();
          report.tests.push({ name, status: "pass" });
          persist();
          return true;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          failure ??= error instanceof Error ? error : new Error(message);
          report.tests.push({
            name,
            status: unknownExecution
              ? "unknown"
              : blockedReason
                ? "blocked"
                : "fail",
            error: message,
          });
          persist();
          if (unknownExecution || session.uncertain) throw error;
          return false;
        }
      }
      async function createSketch(sketchName: string): Promise<void> {
        const { result } = await invokeCad(
          "sketch.create",
          { name: sketchName, plane: "XY" },
          { supportOnly: true },
        );
        const reference = sketchReference(result["sketch"], "created sketch");
        assertion(
          "sketch.create",
          "created sketch name is exact",
          reference["name"],
          sketchName,
        );
      }
      async function addGeometry(
        sketchName: string,
        specs: JsonValue[],
      ): Promise<Record<string, SketchReference>> {
        const { result } = await invokeCad(
          "sketch.geometry",
          { sketch: sketchName, frame: "sketch", geometry: specs },
          { supportOnly: true },
        );
        const entities = fieldArray(result, "entities");
        assertion(
          "sketch.geometry",
          "native geometry entity count",
          entities.length,
          specs.length,
        );
        const refsRecord = record(result["refs"], "sketch geometry named refs");
        const refs: Record<string, SketchReference> = {};
        for (const spec of specs) {
          const specRecord = record(spec, "geometry specification");
          if (typeof specRecord["name"] === "string") {
            const key = specRecord["name"];
            refs[key] = sketchReference(refsRecord[key], `geometry ref ${key}`);
          }
        }
        return refs;
      }
      async function inspectSketch(sketchName: string): Promise<JsonRecord> {
        const { result } = await invokeCad(
          "sketch.inspect",
          { sketch: sketchName },
          { supportOnly: true },
        );
        fieldArray(result, "curves");
        fieldArray(result, "points");
        fieldArray(result, "dimensions");
        return result;
      }
      async function curveByToken(
        sketchName: string,
        ref: SketchReference,
      ): Promise<JsonRecord> {
        const curves = fieldArray(await inspectSketch(sketchName), "curves")
          .map((item) => record(item, "sketch curve"))
          .filter((curve) => curve["token"] === ref["token"]);
        assert.equal(
          curves.length,
          1,
          "sketch.inspect must return exactly the selected native curve.",
        );
        const curve = curves[0];
        assert.ok(curve);
        return jsonRecord(curve, "selected sketch curve");
      }
      async function coordinateCheck(
        sketchName: string,
        expectations: JsonValue[],
        label: string,
      ): Promise<void> {
        const { result, evidence } = await invokeCad(
          "sketch.coordinate-check",
          {
            schemaVersion: 1,
            sketch: sketchName,
            tolerance: "0.001 mm",
            expectations,
          },
        );
        assertion(
          "sketch.coordinate-check",
          `${label} overall status`,
          result["status"],
          "pass",
        );
        assertion(
          "sketch.coordinate-check",
          `${label} geometry status`,
          result["geometryStatus"],
          "pass",
        );
        const analytic = fieldRecord(result, "analytic");
        const entities = fieldArray(analytic, "entities");
        assertion(
          "sketch.coordinate-check",
          `${label} expectation count`,
          entities.length,
          expectations.length,
        );
        for (const [index, value] of entities.entries()) {
          const entity = record(value, `${label} entity ${index}`);
          assertion(
            "sketch.coordinate-check",
            `${label} entity status`,
            entity["status"],
            "pass",
          );
          const checks = fieldArray(entity, "checks");
          assert.ok(
            checks.length > 0,
            `${label} must return native coordinate checks.`,
          );
          for (const checkValue of checks) {
            const check = record(checkValue, `${label} check`);
            assertion(
              "sketch.coordinate-check",
              `${label} ${fieldString(check, "check")} status`,
              check["status"],
              "pass",
            );
          }
        }
        validated(
          evidence,
          "Native sketch/model/world coordinates and model-to-sketch roundtrip passed.",
        );
      }
      async function dimensionGroup(
        sketchNames: SketchSuite["sketchNames"],
        refs: Record<string, SketchReference>,
      ): Promise<void> {
        const before = await inspectSketch(sketchNames.dimension);
        const circleRef = refs["dimensionCircle"];
        const ellipseRef = refs["dimensionEllipse"];
        assert.ok(circleRef && ellipseRef);
        const { result: plan, evidence: planEvidence } = await invokeCad(
          "sketch.dimension-plan",
          {
            schemaVersion: 1,
            sketch: sketchNames.dimension,
            entities: [circleRef, ellipseRef],
            maxEntities: 20,
          },
        );
        assertion(
          "sketch.dimension-plan",
          "read-only mutation flag",
          plan["mutation"],
          false,
        );
        assertion(
          "sketch.dimension-plan",
          "recognized circle and ellipse",
          fieldArray(plan, "recognized").length,
          2,
        );
        const planRecord = fieldRecord(plan, "plan");
        const proposals = fieldArray(planRecord, "proposals").map((value) =>
          record(value, "dimension proposal"),
        );
        assertion(
          "sketch.dimension-plan",
          "circle and ellipse size proposals",
          proposals.length,
          3,
        );
        const circleProposal = proposals.find((proposal) => {
          const data = fieldRecord(proposal, "data");
          const entities = fieldArray(data, "entities").map((value) =>
            record(value, "proposal entity"),
          );
          return (
            data["type"] === "radius" &&
            entities.some((entity) => entity["token"] === circleRef.token)
          );
        });
        assert.ok(
          circleProposal,
          "dimension-plan must include the circle radius proposal.",
        );
        const ellipseProposals = proposals.filter((proposal) => {
          const data = fieldRecord(proposal, "data");
          const entities = fieldArray(data, "entities").map((value) =>
            record(value, "proposal entity"),
          );
          return entities.some(
            (entity) => entity["token"] === ellipseRef.token,
          );
        });
        const ellipseTypes = ellipseProposals
          .map((proposal) => fieldString(fieldRecord(proposal, "data"), "type"))
          .sort();
        assertion(
          "sketch.dimension-plan",
          "ellipse major/minor radius proposals",
          ellipseTypes,
          ["majorRadius", "minorRadius"],
        );
        assertion(
          "sketch.dimension-plan",
          "proposal has explicit ID",
          typeof circleProposal["id"],
          "string",
        );
        const afterPlan = await inspectSketch(sketchNames.dimension);
        assertion(
          "sketch.dimension-plan",
          "read-only curves unchanged",
          afterPlan["curves"],
          before["curves"],
        );
        assertion(
          "sketch.dimension-plan",
          "read-only points unchanged",
          afterPlan["points"],
          before["points"],
        );
        assertion(
          "sketch.dimension-plan",
          "read-only dimensions unchanged",
          afterPlan["dimensions"],
          before["dimensions"],
        );
        assertion(
          "sketch.dimension-plan",
          "plan added no dimensions",
          fieldArray(afterPlan, "dimensions").length,
          0,
        );
        validated(
          planEvidence,
          "Read-only native circle/ellipse recognition; no dimensions were added.",
        );
        const proposalId = fieldString(circleProposal, "id");
        const { result: applied, evidence: applyEvidence } = await invokeCad(
          "sketch.dimension-apply",
          {
            sketch: sketchNames.dimension,
            plan: jsonRecord(planRecord, "dimension plan payload"),
            accept: [proposalId],
          },
        );
        assertion(
          "sketch.dimension-apply",
          "apply status",
          applied["status"],
          "pass",
        );
        const completed = fieldArray(applied, "completed").map((value) =>
          record(value, "completed dimension"),
        );
        assertion(
          "sketch.dimension-apply",
          "one reviewed proposal completed",
          completed.length,
          1,
        );
        const completion = completed[0];
        assert.ok(completion);
        assertion(
          "sketch.dimension-apply",
          "completed proposal ID",
          completion["id"],
          proposalId,
        );
        assertion(
          "sketch.dimension-apply",
          "solver conflicts",
          fieldArray(applied, "conflicts").length,
          0,
        );
        assertion(
          "sketch.dimension-apply",
          "accepted IDs left unapplied",
          fieldArray(applied, "notApplied").length,
          0,
        );
        const dimensionResult = fieldRecord(completion, "result");
        const proposalData = fieldRecord(circleProposal, "data");
        assertion(
          "sketch.dimension-apply",
          "native expression",
          dimensionResult["expression"],
          proposalData["expression"],
        );
        assert.ok(
          typeof dimensionResult["parameter"] === "string" &&
            dimensionResult["parameter"].length > 0,
        );
        const afterApply = await inspectSketch(sketchNames.dimension);
        const dimensions = fieldArray(afterApply, "dimensions").map((value) =>
          record(value, "native dimension"),
        );
        assertion(
          "sketch.dimension-apply",
          "one driving dimension read back",
          dimensions.length,
          1,
        );
        const dimension = dimensions[0];
        assert.ok(dimension);
        assertion(
          "sketch.dimension-apply",
          "dimension expression readback",
          dimension["expression"],
          dimensionResult["expression"],
        );
        assertion(
          "sketch.dimension-apply",
          "dimension is driving",
          dimension["isDriving"],
          true,
        );
        validated(
          applyEvidence,
          "Only the selected circle radius proposal became a native driving dimension.",
        );
        const { result: replanned, evidence: replanEvidence } = await invokeCad(
          "sketch.dimension-plan",
          {
            schemaVersion: 1,
            sketch: sketchNames.dimension,
            entities: [circleRef, ellipseRef],
            maxEntities: 20,
          },
        );
        const replan = fieldRecord(replanned, "plan");
        const remaining = fieldArray(replan, "proposals").map((value) =>
          record(value, "replanned proposal"),
        );
        const duplicateRadius = remaining.some((proposal) => {
          const data = fieldRecord(proposal, "data");
          return (
            data["type"] === "radius" &&
            fieldArray(data, "entities")
              .map((value) => record(value, "replanned entity"))
              .some((entity) => entity["token"] === circleRef.token)
          );
        });
        assertion(
          "sketch.dimension-plan",
          "applied radius is no longer proposed",
          duplicateRadius,
          false,
        );
        assertion(
          "sketch.dimension-plan",
          "remaining ellipse proposals",
          remaining.length,
          2,
        );
        validated(
          replanEvidence,
          "Replan recognized the applied native dimension without duplication.",
        );
        await coordinateCheck(
          sketchNames.dimension,
          [
            {
              entity: circleRef,
              frame: "sketch",
              center: ["-20 mm", "0 mm", "0 mm"],
              radius: "5 mm",
            },
            {
              entity: circleRef,
              frame: "model",
              center: ["-20 mm", "0 mm", "0 mm"],
              diameter: "10 mm",
            },
            {
              entity: ellipseRef,
              frame: "sketch",
              center: ["20 mm", "0 mm", "0 mm"],
            },
          ],
          "dimension local/model coordinates",
        );
        const inspected = await inspectSketch(sketchNames.dimension);
        const ellipse = fieldArray(inspected, "curves")
          .map((value) => record(value, "inspected curve"))
          .find((curve) => curve["token"] === ellipseRef.token);
        assert.ok(ellipse, "Ellipse must remain in native inspection.");
        const ellipseGeometry = fieldRecord(ellipse, "geometry");
        near(
          "sketch.dimension-apply",
          "ellipse major radius mm",
          fieldNumber(ellipseGeometry, "majorRadius") * 10,
          8,
          0.001,
        );
        near(
          "sketch.dimension-apply",
          "ellipse minor radius mm",
          fieldNumber(ellipseGeometry, "minorRadius") * 10,
          4,
          0.001,
        );
      }
      async function mirrorGroup(
        sketchNames: SketchSuite["sketchNames"],
        refs: Record<string, SketchReference>,
      ): Promise<void> {
        const mirrorSeed = refs["mirrorSeed"];
        const mirrorAxis = refs["mirrorAxis"];
        assert.ok(mirrorSeed && mirrorAxis);
        const { result, evidence } = await invokeCad("sketch.mirror", {
          sketch: sketchNames.operations,
          entities: [mirrorSeed],
          line: mirrorAxis,
        });
        const entities = fieldArray(result, "entities");
        assertion(
          "sketch.mirror",
          "one native mirrored primitive",
          entities.length,
          1,
        );
        assertion(
          "sketch.mirror",
          "one native symmetry constraint",
          fieldArray(result, "constraints").length,
          1,
        );
        const mirroredValue = entities[0];
        assert.ok(mirroredValue);
        const mirrored = sketchReference(mirroredValue, "mirrored entity");
        await coordinateCheck(
          sketchNames.operations,
          [
            {
              entity: mirrorSeed,
              frame: "sketch",
              center: ["5 mm", "15 mm", "0 mm"],
              radius: "2 mm",
            },
            {
              entity: mirrored,
              frame: "model",
              center: ["-5 mm", "15 mm", "0 mm"],
              radius: "2 mm",
            },
          ],
          "mirror source/reflected geometry",
        );
        const curve = await curveByToken(sketchNames.operations, mirrored);
        const geometry = fieldRecord(curve, "geometry");
        assertion(
          "sketch.mirror",
          "mirrored analytic type",
          geometry["type"],
          "Circle3D",
        );
        near(
          "sketch.mirror",
          "mirrored circle radius mm",
          fieldNumber(geometry, "radius") * 10,
          2,
          0.001,
        );
        validated(
          evidence,
          "Reflected center/radius and native symmetry relation read back.",
        );
      }
      async function offsetGroup(
        sketchNames: SketchSuite["sketchNames"],
        refs: Record<string, SketchReference>,
      ): Promise<void> {
        const offsetSeed = refs["offsetSeed"];
        assert.ok(offsetSeed);
        const { result, evidence } = await invokeCad("sketch.offset", {
          sketch: sketchNames.operations,
          entities: [offsetSeed],
          distance: "2 mm",
        });
        const entities = fieldArray(result, "entities");
        assertion(
          "sketch.offset",
          "one native child curve",
          entities.length,
          1,
        );
        assert.ok(isRecord(result["constraint"]));
        const parameter = result["offsetParameter"];
        evidence.offsetParameter =
          typeof parameter === "string" ? parameter : null;
        const childValue = entities[0];
        assert.ok(childValue);
        const child = await curveByToken(
          sketchNames.operations,
          sketchReference(childValue, "offset child"),
        );
        const geometry = fieldRecord(child, "geometry");
        assertion(
          "sketch.offset",
          "child analytic type",
          geometry["type"],
          "Line3D",
        );
        const endpoints: Array<[number, number, number]> = [
          toMillimetreVector(geometry["startPoint"], "offset start point"),
          toMillimetreVector(geometry["endPoint"], "offset end point"),
        ].sort((a, b) => a[1] - b[1]);
        const expected: ReadonlyArray<readonly [number, number, number]> = [
          [22, 10, 0],
          [22, 20, 0],
        ];
        for (const [index, point] of endpoints.entries()) {
          const target = expected[index];
          assert.ok(target);
          for (const axis of [0, 1, 2] as const)
            near(
              "sketch.offset",
              `positive right-side endpoint ${index} ${"xyz"[axis]} mm`,
              point[axis],
              target[axis],
              0.001,
            );
        }
        validated(
          evidence,
          "Positive offset moved the upward source line to its right; native child endpoints read back.",
        );
      }
      async function patternGroup(
        sketchNames: SketchSuite["sketchNames"],
        refs: Record<string, SketchReference>,
      ): Promise<void> {
        const circularSeed = refs["patternCircularSeed"];
        const patternCenter = refs["patternCenter"];
        const rectangularSeed = refs["patternRectSeed"];
        const direction = refs["patternDirection"];
        assert.ok(
          circularSeed && patternCenter && rectangularSeed && direction,
        );
        const circular = await invokeCad("sketch.pattern", {
          sketch: sketchNames.operations,
          type: "circular",
          entities: [circularSeed],
          center: patternCenter,
          quantity: 4,
          angle: "360 deg",
        });
        assert.ok(isRecord(circular.result["constraint"]));
        const rectangular = await invokeCad("sketch.pattern", {
          sketch: sketchNames.operations,
          type: "rectangular",
          entities: [rectangularSeed],
          direction,
          quantity: 3,
          distance: "10 mm",
          distanceType: "spacing",
        });
        assert.ok(isRecord(rectangular.result["constraint"]));
        const inspected = await inspectSketch(sketchNames.operations);
        const circles = fieldArray(inspected, "curves")
          .map((value) => record(value, "pattern curve"))
          .map((curve) => ({
            curve,
            geometry: isRecord(curve["geometry"]) ? curve["geometry"] : {},
          }))
          .filter(
            ({ geometry }) =>
              typeof geometry["radius"] === "number" &&
              Math.abs(geometry["radius"] - 0.1) <= 1e-8,
          );
        assertion(
          "sketch.pattern",
          "circular and rectangular native instance count",
          circles.length,
          7,
        );
        const expected = [
          [5, 45, 0],
          [-35, 5, 0],
          [5, -35, 0],
          [45, 5, 0],
          [55, 45, 0],
          [65, 45, 0],
          [75, 45, 0],
        ];
        const remaining = circles.map(({ geometry }) =>
          vector3(geometry["center"], "pattern center").map(
            (value) => value * 10,
          ),
        );
        for (const wanted of expected) {
          const index = remaining.findIndex((actual) =>
            actual.every(
              (value, axis) => Math.abs(value - wanted[axis]!) <= 0.001,
            ),
          );
          assert.notEqual(
            index,
            -1,
            `Pattern is missing expected native center ${JSON.stringify(wanted)}.`,
          );
          const found = remaining.splice(index, 1)[0];
          assert.ok(found);
          assertion(
            "sketch.pattern",
            "native pattern center xyz mm",
            found,
            wanted,
          );
        }
        assertion(
          "sketch.pattern",
          "no unexpected pattern instances",
          remaining.length,
          0,
        );
        validated(
          circular.evidence,
          "Native circular pattern constraint and generated instances read back.",
        );
        validated(
          rectangular.evidence,
          "Native rectangular pattern constraint and generated instances read back.",
        );
      }
      async function projectGroup(
        sketchNames: SketchSuite["sketchNames"],
        refs: Record<string, SketchReference>,
      ): Promise<void> {
        const sourceCircle = refs["projectSourceCircle"];
        assert.ok(sourceCircle);
        const { result, evidence } = await invokeCad("sketch.project", {
          sketch: sketchNames.projectTarget,
          entities: [sourceCircle],
          linked: true,
        });
        const entities = fieldArray(result, "entities");
        assertion(
          "sketch.project",
          "one projected native entity",
          entities.length,
          1,
        );
        const projectedValue = entities[0];
        assert.ok(projectedValue);
        const projected = sketchReference(projectedValue, "projected entity");
        await coordinateCheck(
          sketchNames.projectTarget,
          [
            {
              entity: projected,
              frame: "sketch",
              center: ["-30 mm", "-25 mm", "0 mm"],
              radius: "3 mm",
            },
            {
              entity: projected,
              frame: "world",
              center: ["-30 mm", "-25 mm", "0 mm"],
            },
          ],
          "linked projection local/world geometry",
        );
        const curve = await curveByToken(sketchNames.projectTarget, projected);
        const geometry = fieldRecord(curve, "geometry");
        assertion(
          "sketch.project",
          "projected analytic type",
          geometry["type"],
          "Circle3D",
        );
        near(
          "sketch.project",
          "projected circle radius mm",
          fieldNumber(geometry, "radius") * 10,
          3,
          0.001,
        );
        validated(
          evidence,
          "Linked projected circle center/radius read back in target sketch and world frame.",
        );
      }
      async function transformGroup(
        sketchNames: SketchSuite["sketchNames"],
        refs: Record<string, SketchReference>,
      ): Promise<void> {
        const transformSeed = refs["transformSeed"];
        assert.ok(transformSeed);
        const { result, evidence } = await invokeCad("sketch.transform", {
          sketch: sketchNames.operations,
          entities: [transformSeed],
          frame: "sketch",
          rotate: { angle: "90 deg", center: ["0 mm", "0 mm", "0 mm"] },
          translate: ["-5 mm", "5 mm", "0 mm"],
        });
        assertion(
          "sketch.transform",
          "solver transform status",
          result["status"],
          "pass",
        );
        assertion(
          "sketch.transform",
          "native transform success",
          result["success"],
          true,
        );
        const before = fieldRecord(result, "before");
        const after = fieldRecord(result, "after");
        assert.ok(
          Array.isArray(before["points"]) && Array.isArray(after["points"]),
        );
        assert.notDeepEqual(
          before["points"],
          after["points"],
          "Transform must move native sketch points.",
        );
        await coordinateCheck(
          sketchNames.operations,
          [
            {
              entity: transformSeed,
              frame: "sketch",
              center: ["-15 mm", "90 mm", "0 mm"],
              radius: "2 mm",
            },
            {
              entity: transformSeed,
              frame: "model",
              center: ["-15 mm", "90 mm", "0 mm"],
            },
          ],
          "rotation-then-translation local/model geometry",
        );
        const transformed = await curveByToken(
          sketchNames.operations,
          transformSeed,
        );
        const geometry = fieldRecord(transformed, "geometry");
        const center = vector3(geometry["center"], "transformed circle center");
        near(
          "sketch.transform",
          "transformed x mm",
          center[0] * 10,
          -15,
          0.001,
        );
        near("sketch.transform", "transformed y mm", center[1] * 10, 90, 0.001);
        validated(
          evidence,
          "Before/after solver state and independent sketch/model coordinate readback passed.",
        );
      }
      async function checkGroup(
        sketchNames: SketchSuite["sketchNames"],
      ): Promise<void> {
        const { result, evidence } = await invokeCad("sketch.check", {
          sketch: sketchNames.operations,
        });
        assertion(
          "sketch.check",
          "native check status",
          result["status"],
          "pass",
        );
        assertion(
          "sketch.check",
          "native solver health",
          result["healthState"],
          0,
        );
        assertion(
          "sketch.check",
          "closed profile count",
          result["profileCount"],
          10,
        );
        assertion(
          "sketch.check",
          "underconstraint list is disclosed",
          Array.isArray(result["underconstrainedPoints"]),
          true,
        );
        validated(
          evidence,
          "Fusion solver health, ten closed profiles, and underconstraint read back.",
        );
      }
      function vector3(
        value: unknown,
        label: string,
      ): [number, number, number] {
        const values = arrayValue(value, label);
        assert.equal(values.length, 3, `${label} must contain xyz.`);
        return [
          numberValue(values[0], `${label}.x`),
          numberValue(values[1], `${label}.y`),
          numberValue(values[2], `${label}.z`),
        ];
      }
      function toMillimetreVector(
        value: unknown,
        label: string,
      ): [number, number, number] {
        const [x, y, z] = vector3(value, label);
        return [x * 10, y * 10, z * 10];
      }
      async function setupSketches(): Promise<SketchSuite> {
        await guardOwned();
        const sketchNames = {
          dimension: `${fixturePrefix}_Dimension`,
          operations: `${fixturePrefix}_Operations`,
          projectSource: `${fixturePrefix}_ProjectSource`,
          projectTarget: `${fixturePrefix}_ProjectTarget`,
        };
        for (const sketchName of Object.values(sketchNames))
          await createSketch(sketchName);
        const refs = {
          ...(await addGeometry(sketchNames.dimension, [
            {
              type: "circle",
              name: "dimensionCircle",
              center: ["-20 mm", "0 mm", "0 mm"],
              radius: "5 mm",
            },
            {
              type: "ellipse",
              name: "dimensionEllipse",
              center: ["20 mm", "0 mm", "0 mm"],
              majorRadius: "8 mm",
              minorRadius: "4 mm",
            },
          ])),
          ...(await addGeometry(sketchNames.operations, [
            {
              type: "line",
              name: "mirrorAxis",
              start: ["0 mm", "10 mm", "0 mm"],
              end: ["0 mm", "20 mm", "0 mm"],
            },
            {
              type: "circle",
              name: "mirrorSeed",
              center: ["5 mm", "15 mm", "0 mm"],
              radius: "2 mm",
            },
            {
              type: "line",
              name: "offsetSeed",
              start: ["20 mm", "10 mm", "0 mm"],
              end: ["20 mm", "20 mm", "0 mm"],
            },
            {
              type: "point",
              name: "patternCenter",
              point: ["5 mm", "5 mm", "0 mm"],
            },
            {
              type: "circle",
              name: "patternCircularSeed",
              center: ["5 mm", "45 mm", "0 mm"],
              radius: "1 mm",
            },
            {
              type: "circle",
              name: "patternRectSeed",
              center: ["55 mm", "45 mm", "0 mm"],
              radius: "1 mm",
            },
            {
              type: "line",
              name: "patternDirection",
              start: ["0 mm", "70 mm", "0 mm"],
              end: ["10 mm", "70 mm", "0 mm"],
            },
            {
              type: "circle",
              name: "transformSeed",
              center: ["85 mm", "10 mm", "0 mm"],
              radius: "2 mm",
            },
          ])),
          ...(await addGeometry(sketchNames.projectSource, [
            {
              type: "circle",
              name: "projectSourceCircle",
              center: ["-30 mm", "-25 mm", "0 mm"],
              radius: "3 mm",
            },
          ])),
        };
        report.sketchNames = sketchNames;
        report.fixtureRefs = Object.keys(refs);
        persist();
        return { sketchNames, refs };
      }
      async function runOperations(suite: SketchSuite): Promise<void> {
        await guardOwned();
        await group(
          "dimension-plan/apply",
          async () => await dimensionGroup(suite.sketchNames, suite.refs),
        );
        if (!unknownExecution && !blockedReason)
          await group(
            "mirror",
            async () => await mirrorGroup(suite.sketchNames, suite.refs),
          );
        if (!unknownExecution && !blockedReason)
          await group(
            "offset",
            async () => await offsetGroup(suite.sketchNames, suite.refs),
          );
        if (!unknownExecution && !blockedReason)
          await group(
            "pattern",
            async () => await patternGroup(suite.sketchNames, suite.refs),
          );
        if (!unknownExecution && !blockedReason)
          await group(
            "project",
            async () => await projectGroup(suite.sketchNames, suite.refs),
          );
        if (!unknownExecution && !blockedReason)
          await group(
            "transform",
            async () => await transformGroup(suite.sketchNames, suite.refs),
          );
        if (!unknownExecution && !blockedReason)
          await group("check", async () => await checkGroup(suite.sketchNames));
      }
      loadInstalledRuntime();
      // The coordinator already captured and verified the pre-creation full metadata inventory.
      // Retain the real CLI formatting and subsequent exact raw-row comparison separately.
      await harness.guard();
      const initialRows = await readDocumentList();
      baselineStable = stableRows(
        initialRows.filter((row) => !ownRows([row]).length),
      );
      await assertFusionIdle();
      const status = await guardOwned();
      assert.match(identity.creationId, /^[0-9a-f-]{36}$/iu);
      assert.equal(fieldBoolean(status, "saved"), false);
      assert.equal(fieldBoolean(status, "modified"), false);
      assert.equal(fieldOptionalString(status, "fileId"), null);
      await runOperations(await setupSketches());
      await guardOwned();
      report.operationCoverage = operations.map((operation) => {
        const rows = report.methodResults.filter(
          (item) => item.operation === operation,
        );
        return {
          operation,
          canonical: true,
          test: "tests/live-sketch-operations.ts",
          invocations: rows.length,
          status:
            rows.length > 0 && rows.every((item) => item.status === "pass")
              ? "pass"
              : "not-passed",
          evidence: rows.map((item) => item.evidence ?? null),
        };
      });
      report.cleanup =
        "Lifecycle closure and original active restoration are recorded by ScenarioSession/report.json";
      persist();
      assert.ok(
        report.operationCoverage.every((row) => row["status"] === "pass") &&
          !failure,
        "All nine native sketch methods must pass their independent readbacks",
      );
    },
  }));
}

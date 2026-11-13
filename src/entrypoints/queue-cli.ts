import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { FmcadConfiguration } from "../api";

const runtimeRequire = createRequire(__filename);

interface QueueCliDependencies {
  loadConfig(options: QueueOptions): { cfg: FmcadConfiguration };
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  invocationContext?: { purpose?: string };
}

type QueueOptions = Record<string, string>;
type QueueResult = {
  id: string;
  requestId: string;
  state?: string;
  code?: string | null;
  stdout?: string;
  stderr?: string;
  outputs?: unknown;
  job?: { id: string; state: string; code?: string | null };
};

interface QueueClientPort {
  auth: { clientId: string };
  submit(input: Record<string, unknown>): Promise<QueueResult>;
  wait(jobId: string): Promise<QueueResult>;
  register(): Promise<void>;
  call(action: string, options?: Record<string, unknown>): Promise<unknown>;
  dispose(): void;
}

interface QueueClientConstructor {
  new (
    clientId: string | undefined,
    options: {
      cfg: FmcadConfiguration;
      configPath?: string;
      existingCredentialsOnly?: boolean;
    },
  ): QueueClientPort;
}

interface QueueAutostart {
  reclaimStart(directory: string): unknown;
}

interface ProductionMigrator {
  (options: {
    jobId: string;
    requestId: string;
    approval: string;
    confirmOwnership: boolean;
  }): Promise<unknown>;
  preflight(
    approval: string,
    requestId: string,
    jobId: string,
  ): Promise<unknown>;
}

interface QueueControls {
  observeAtomic(
    client: QueueClientPort,
    options: { jobId: string; requestId: string; buildHash: string },
  ): Promise<unknown>;
}

interface BrokerControl {
  read(): Promise<{ instanceId: string; generation: number }>;
  execute(
    action: string,
    options: {
      requestId: string;
      instanceId: string;
      expectedGeneration: number;
    },
  ): Promise<unknown>;
}

interface RuntimeModules {
  savedFixtureAction(
    client: QueueClientPort,
    action: string,
    options: Record<string, string>,
    buildHash: string,
  ): Promise<unknown>;
  nativeFixtureAction(
    client: QueueClientPort,
    options: Record<string, string>,
    buildHash: string,
  ): Promise<unknown>;
  QueueClient: QueueClientConstructor;
  queueDirectory(): string;
  inputFiles(argv: string[], cwd: string): { path: string; sha256: string }[];
  pinCommand(argv: string[]): string[];
  sequenceOptions(
    options: Record<string, string | boolean>,
  ): Record<string, unknown> | undefined;
  buildHash(): string;
  brokerComposition(): typeof import("./broker.js");
  queueAutostart(): QueueAutostart;
  createProductionMigrator(
    client: QueueClientPort,
    config: FmcadConfiguration,
  ): ProductionMigrator;
  observeAtomic(
    client: QueueClientPort,
    options: { jobId: string; requestId: string; buildHash: string },
  ): Promise<unknown>;
  createBrokerControlPort(client: QueueClientPort): unknown;
  createBrokerControl(port: unknown): BrokerControl;
  parseFlags(argv: string[]): { opts: Record<string, string | boolean> };
  invocationPurpose(): string | undefined;
  auditAtomic(
    client: QueueClientPort,
    options: {
      jobId: string;
      observationJobId: string;
      requestId: string;
      buildHash: string;
    },
  ): Promise<unknown>;
  auditFactsAction(
    client: QueueClientPort,
    action: string,
    options: Record<string, unknown>,
    buildHash: string,
  ): Promise<unknown>;
  scratchEpochAction(
    client: QueueClientPort,
    action: string,
    options: Record<string, unknown>,
    buildHash: string,
  ): Promise<unknown>;
  bootstrapSuccessor(
    client: QueueClientPort,
    config: FmcadConfiguration,
    options: {
      approval: string;
      requestId: string;
      preflight: boolean;
      confirmOwnership: boolean;
    },
  ): Promise<unknown>;
  observeSuccessor(
    client: QueueClientPort,
    options: {
      jobId: string;
      observationJobId: string;
      requestId: string;
    },
    buildHash: string,
  ): Promise<unknown>;
  prepareClosedSuccessor(
    client: QueueClientPort,
    options: { approval: string; requestId: string },
    buildHash: string,
  ): Promise<unknown>;
}

const runtime = {
  savedFixtureAction: (client: QueueClientPort, action: string, options: Record<string, string>, buildHash: string) =>
    (runtimeRequire("../../queue-saved-fixture-control.js") as Pick<RuntimeModules, "savedFixtureAction">)
      .savedFixtureAction(client, action, options, buildHash),
  nativeFixtureAction: (
    client: QueueClientPort,
    options: Record<string, string>,
    buildHash: string,
  ) =>
    (
      runtimeRequire("../../queue-native-fixture-grant.js") as Pick<
        RuntimeModules,
        "nativeFixtureAction"
      >
    ).nativeFixtureAction(client, options, buildHash),
  prepareClosedSuccessor: (
    client: QueueClientPort,
    options: { approval: string; requestId: string },
    buildHash: string,
  ) =>
    (
      runtimeRequire("../../queue-closed-epoch-successor.js") as Pick<
        RuntimeModules,
        "prepareClosedSuccessor"
      >
    ).prepareClosedSuccessor(client, options, buildHash),
  ...(runtimeRequire("../../queue-client.js") as {
    QueueClient: QueueClientConstructor;
    inputFiles: RuntimeModules["inputFiles"];
    pinCommand: RuntimeModules["pinCommand"];
    sequenceOptions: RuntimeModules["sequenceOptions"];
  }),
  queueDirectory: (
    runtimeRequire("../../queue-connection.js") as {
      queueDirectory(): string;
    }
  ).queueDirectory,
  buildHash: () =>
    (
      runtimeRequire("../../queue-instance.js") as {
        buildHash(): string;
      }
    ).buildHash(),
  brokerComposition: () =>
    runtimeRequire("./broker.js") as typeof import("./broker.js"),
  queueAutostart: () =>
    runtimeRequire("../../queue-autostart.js") as QueueAutostart,
  createProductionMigrator: (
    client: QueueClientPort,
    config: FmcadConfiguration,
  ) =>
    (
      runtimeRequire("../../queue-atomic-migration-runtime.js") as {
        createProductionMigrator: RuntimeModules["createProductionMigrator"];
      }
    ).createProductionMigrator(client, config),
  observeAtomic: (client: QueueClientPort, options) =>
    (
      runtimeRequire("../../queue-atomic-control.js") as QueueControls
    ).observeAtomic(client, options),
  createBrokerControlPort: (client: QueueClientPort) =>
    (
      runtimeRequire("../node-adapters/broker-ipc/control.js") as {
        createBrokerControlPort: RuntimeModules["createBrokerControlPort"];
      }
    ).createBrokerControlPort(client),
  createBrokerControl: (port: unknown) =>
    (
      runtimeRequire("../core/application/broker-control.js") as {
        createBrokerControl: RuntimeModules["createBrokerControl"];
      }
    ).createBrokerControl(port),
  parseFlags: (argv: string[]) =>
    (
      runtimeRequire("../../cli.js") as {
        parseFlags: RuntimeModules["parseFlags"];
      }
    ).parseFlags(argv),
  invocationPurpose: () =>
    (
      runtimeRequire("../../invocation.js") as {
        context: { getStore(): { description?: string } | undefined };
      }
    ).context.getStore()?.description,
  auditAtomic: (client: QueueClientPort, options) =>
    (
      runtimeRequire("../../queue-atomic-recovery-audit.js") as {
        auditAtomic: RuntimeModules["auditAtomic"];
      }
    ).auditAtomic(client, options),
  auditFactsAction: (client, action, options, buildHash) =>
    (
      runtimeRequire("../../queue-audit-facts-capture.js") as Pick<
        RuntimeModules,
        "auditFactsAction"
      >
    ).auditFactsAction(client, action, options, buildHash),
  scratchEpochAction: (client, action, options, buildHash) =>
    (
      runtimeRequire("../../queue-scratch-control.js") as Pick<
        RuntimeModules,
        "scratchEpochAction"
      >
    ).scratchEpochAction(client, action, options, buildHash),
  bootstrapSuccessor: (client, config, options) =>
    (
      runtimeRequire("../../queue-epoch-successor.js") as Pick<
        RuntimeModules,
        "bootstrapSuccessor"
      >
    ).bootstrapSuccessor(client, config, options),
  observeSuccessor: (client, options, buildHash) =>
    (
      runtimeRequire("../../queue-epoch-successor.js") as Pick<
        RuntimeModules,
        "observeSuccessor"
      >
    ).observeSuccessor(client, options, buildHash),
} satisfies RuntimeModules;

const summaries = {
  "transition-backend":
    "Explicit owner-bound physical addin/MCP transition on the same idle live Fusion and shared SDK queue; never rewrites historical identities or receipts.",
  serve:
    "Run one local multi-agent Fusion broker. Requires explicit ownership handoff and an idle Fusion. Does not start/restart Fusion.",
  exec: "Autostart/connect to the shared broker, submit one whole fmcad command and wait. Startup/queue waiting do not consume execution timeout.",
  submit:
    "Autostart/connect to the shared broker and durably submit one whole fmcad command; return jobId immediately. No automatic replay.",
  status:
    "Inspect broker health and queue totals, or one job with --job, without Fusion traffic.",
  result:
    "Read the submitting client's durable job output without Fusion traffic.",
  cancel:
    "Cancel a queued job before its first SDK turn only. Started Fusion work is never cancelled.",
  release: "End an owned idle sequence without another Fusion command.",
  pause: "Stop granting new jobs; current execution may finish.",
  resume: "Resume grants only if no unresolved operation holds Fusion.",
  stop: "Stop an idle broker with a generation fence. Pause/drain active work first; unresolved execution retains ownership.",
  reclaim:
    "Recover a dead broker or interrupted startup marker after PID/birth verification. Preserves unknown jobs; never retries.",
  reconcile:
    "Reconcile an owned unknown job. For the exact scoped atomic holder proof, --accept-outcome is an explicit owner acknowledgment; it never verifies rollback or model state.",
  "observe-atomic":
    "Submit the exact owner-bound read-only atomic_status observer, using existing CLI authentication; requires --job and a stable --request-id. Never replay the original batch.",
  "audit-atomic":
    "Read present facts for the exact unavailable atomic holder; owner-only, no activation, acceptance or resume. Requires --job, --observation-job and --request-id.",
  "migrate-atomic":
    "One-time explicitly approved external broker-owner migration; --preflight true is read-only. Requires approved production admission, exact owner and immutable escrow. Never restarts Fusion or resolves the holder.",
  "capture-audit-facts":
    "Explicit one-shot NEW read-only current-facts observation bound to an existing failed audit; --confirm-read-only true required. Never replays the original audit or target work.",
  "authorize-isolated-scratch":
    "Owner approval of actual durable captured facts for ONE future proven-new scratch. Metadata only, no SDK and no global modeling release.",
  "create-isolated-scratch":
    "Owner-only one-shot creation of a proven-new empty scratch in a separate admission epoch; requires a qualified durable current audit. Never adopts existing documents or resolves historical work.",
  "close-isolated-scratch":
    "Owner-only one-shot discard/close of the exact newly qualified unsaved scratch. Optional --admission-mode normal-multidocument --confirm-ownership true restores ordinary shared-broker admission only after proven close/restore; historical unknown stays quarantined.",
  "grant-isolated-scratch":
    "Owner-only grant to one registered authenticated client for this exact scratch/epoch; no broker administration or old-document access.",
  "successor-epoch":
    "Owner-authenticated metadata-only startup for an exactly pinned dead predecessor and qualified successor runtime; no SDK or grant copying. Requires --request-id and --succession-approval, plus --preflight true or --confirm-ownership true.",
  "observe-successor":
    "One owner-bound read-only current-process observation for an existing dead-epoch successor authority; requires exact --job, --observation-job and --request-id. Never replays unknown work.",
  "authorize-closed-successor":
    "Owner-only metadata approval for one new scratch after verified cleanup/restore of this exact epoch on the same live Fusion process. Requires --succession-approval, --request-id and --confirm-ownership true. No SDK or grant copying.",
  "grant-native-fixture":
    "Owner-only explicit fixture scope for a separate registered client on a proven-new unsaved scratch: a bounded typed subset or one exact registered cad-v1 program. Requires --epoch-id, --grant-client, --fixture-id, --request-id and --confirm-ownership true. Never broadens an existing grant or admits arbitrary Python/file/cloud work.",
  "probe-saved-destination":
    "Owner-only read of actual native project/hub and approved folder IDs, bound to a genuine readiness job and explicit destination approval. No save, hub switching or modeling grant.",
  "grant-saved-first-save":
    "Owner-only scope for one stable first-save request on the proven-new unchanged origin, with independently observed native project and exact new folder pins. Never adopts an existing file or issues saved modeling scope.",
  "observe-saved-first-save":
    "Owner-only separate publication read for the original settled first-save job. Never submits another save; accepted/pending/complete facts do not grant modeling authority.",
  "retain-saved-fixture":
    "Owner-only one UI close of the exact separately published unmodified new file, retaining the DataFile and restoring the captured active document. No cloud deletion, implicit save or retry after uncertainty.",
} as const;

const optionsHelp = `
Options: --client LABEL, --request-id ID, --timeout MS (active command execution), --queue-timeout MS (waiting only), --sequence-action begin|continue|end, --sequence-id ID, --sequence-mode automatic|exclusive, --expected-revision N.
serve: --backend mcp|addin, --config PATH, --confirm-ownership true; optional --confirm-version-transition true, --idle-ms MS, --lease-ms MS, --max-queued N, --max-per-client N. Version transition additionally requires a dead prior Fusion process, an unpaused queue with no active, blocked, leased or nonterminal work, an idle UI and all current documents unmodified; it records the transition and does not restart Fusion.
transition-backend: after an owner-authenticated idle stop, --backend mcp|addin --backend-approval PATH --confirm-ownership true. The private JSON approval pins requestId, existing epoch clientId/clientToken, previousConfig and nextConfig; a preserved stop pause additionally requires its exact completed stopRequestId. Only backend, URL, headers, tool and protocolVersion may change; all other settings remain exact. Same live Fusion, settled normal epoch and clean documents are required; immutable predecessor identities/receipts are retained. The stop pause remains closed until a separate explicit owner resume. This starts the sole shared broker, not a second SDK queue.
status without --job returns bounded queue totals and broker control state; with --job it returns that job. result/cancel/reconcile require --job ID. Atomic owner acknowledgment: reconcile --job ID --accept-outcome committed|aborted, only after reviewing the exact scoped proof; this does not claim rollback or model validation. release: --sequence-id ID.
Separate child fmcad argv with -- for exec/submit. CLI stdout remains child stdout; job/sequence receipts use FMCAD_QUEUE_RESULT on stderr.
Default sequence mode is automatic: CLI preparation runs locally before SDK readiness, one SDK turn is exclusive, and the slot is yielded before local processing/publication. Further SDK turns of the same command rejoin the shared queue and compare the live pinned document/references with the previous turn. Local states are preparing/processing; neither occupies the Fusion slot. A continuation compares the live pinned document and its references, not the global queue counter. DOCUMENT_CHANGED returns refreshed state in the same turn without executing the stale operation. Existing --doc/--doc-id/--doc-file-id flags pin the target; unscoped/unreadable continuations fail closed. Explicit --expected-revision still requests a separate initial global revision fence. Queue waiting starts at SDK readiness; SDK and local processing have separate cumulative timeout budgets.
Explicit --sequence-mode exclusive keeps an uninterrupted reservation across calls, for workflows that cannot be split. Never use it around offline work. The MCP queue_begin tool retains explicit exclusive semantics. No sequence mode releases active/unknown work. Neither mode is a rollback transaction.
No direct fallback, remote cancellation or automatic replay. Python running inside Fusion remains SDK work; arbitrary Python is not automatically offloaded. See docs/QUEUE.md and docs/QUEUE_PHASES_20261020.md.
`;

type QueueCommandName = keyof typeof summaries;
interface QueueDescriptor {
  usage: string;
  desc: string;
  example: string;
  extra: string;
}

export const descriptors = Object.fromEntries(
  Object.entries(summaries).map(([name, description]) => [
    name,
    {
      usage: `queue ${name}${["exec", "submit"].includes(name) ? " [options] -- <fmcad argv...>" : " [options]"}`,
      desc: description,
      example:
        name === "serve"
          ? "fmcad queue serve --backend addin --confirm-ownership true"
          : name === "release"
            ? "fmcad queue release --sequence-id SEQUENCE_ID"
            : ["exec", "submit"].includes(name)
              ? `fmcad queue ${name} --client agent-a -- doc list`
              : name === "observe-atomic"
                ? "fmcad queue observe-atomic --job JOB_ID --request-id STABLE_OBSERVER_REQUEST_ID"
                : name === "audit-atomic"
                  ? "fmcad queue audit-atomic --job JOB_ID --observation-job PRIOR_OBSERVER_ID --request-id STABLE_AUDIT_REQUEST_ID"
                  : name === "migrate-atomic"
                    ? "fmcad queue migrate-atomic --job JOB_ID --request-id STABLE_MIGRATION_REQUEST_ID --migration-approval /absolute/approval.json --preflight true"
                    : `fmcad queue ${name}${["result", "cancel", "reconcile"].includes(name) ? " --job JOB_ID" : ""}`,
      extra: optionsHelp,
    },
  ]),
) as Record<QueueCommandName, QueueDescriptor>;

function parse(argv: string[]): { opts: QueueOptions; rest: string[] } {
  const delimiter = argv.indexOf("--");
  const own = delimiter < 0 ? argv : argv.slice(0, delimiter);
  const rest = delimiter < 0 ? [] : argv.slice(delimiter + 1);
  const allowed = new Set([
    "observation-job",
    "client",
    "request-id",
    "timeout",
    "queue-timeout",
    "sequence-action",
    "sequence-id",
    "expected-revision",
    "backend",
    "config",
    "confirm-ownership",
    "admission-mode",
    "confirm-version-transition",
    "idle-ms",
    "lease-ms",
    "max-queued",
    "max-per-client",
    "job",
    "sequence-mode",
    "accept-outcome",
    "migration-approval",
    "preflight",
    "epoch-id",
    "grant-client",
    "fixture-id",
    "save-request-id",
    "authority-file",
    "folder-proof-file",
    "confirm-read-only",
    "confirm-current-facts",
    "facts-approval",
    "succession-approval",
    "backend-approval",
  ]);
  const opts: QueueOptions = {};
  for (let index = 0; index < own.length; index++) {
    const key = own[index]!.slice(2);
    const value = own[++index];
    if (
      !own[index - 1]!.startsWith("--") ||
      !allowed.has(key) ||
      Object.hasOwn(opts, key) ||
      value === undefined ||
      value.startsWith("--")
    )
      throw new Error("Invalid or duplicate queue option: " + own[index - 1]);
    opts[key] = value;
  }
  return { opts, rest };
}

export async function queueCommand(
  argv: string[],
  deps: QueueCliDependencies,
): Promise<number> {
  const name = argv[0] ?? "";
  if (!Object.hasOwn(descriptors, name))
    throw new Error("Unknown queue command");
  const { opts, rest } = parse(argv.slice(1));
  if (opts["backend-approval"] !== undefined && name !== "transition-backend")
    throw new Error(
      "--backend-approval requires transition-backend; ordinary serve never reconfigures",
    );
  if (opts["admission-mode"] !== undefined && (name !== "close-isolated-scratch" ||
      opts["admission-mode"] !== "normal-multidocument" || opts["confirm-ownership"] !== "true"))
    throw new Error("--admission-mode normal-multidocument requires close-isolated-scratch and --confirm-ownership true");
  const scratchAction = [
    "create-isolated-scratch",
    "close-isolated-scratch",
  ].includes(name);
  const captureAction = name === "capture-audit-facts";
  const factsApprovalAction = name === "authorize-isolated-scratch";
  const successorAction = name === "successor-epoch";
  const closedSuccessorAction = name === "authorize-closed-successor";
  const nativeGrantAction = name === "grant-native-fixture";
  const savedFixtureAction = ["probe-saved-destination", "grant-saved-first-save", "observe-saved-first-save", "retain-saved-fixture"].includes(name);
  if (savedFixtureAction) {
    const grant = name === "grant-saved-first-save";
    const probe = name === "probe-saved-destination";
    const specific = grant ? ["grant-client", "save-request-id", "authority-file", "folder-proof-file"]
      : probe ? ["job", "authority-file", "folder-proof-file"] : ["job"];
    if (!opts["epoch-id"] || !opts["request-id"] || opts["confirm-ownership"] !== "true" || rest.length ||
        specific.some(key => !opts[key]) || Object.keys(opts).some(key =>
          !["epoch-id", "request-id", "confirm-ownership", "config", ...specific].includes(key)))
      throw new Error("Saved fixture actions require exact epoch/request, explicit ownership, approved destination or original parent job; no overrides");
  } else if (["save-request-id", "authority-file", "folder-proof-file"].some(key => opts[key] !== undefined)) {
    throw new Error("Saved fixture approval flags are restricted to saved fixture actions");
  }
  if (
    nativeGrantAction &&
    (!opts["epoch-id"] ||
      !opts["grant-client"] ||
      !opts["fixture-id"] ||
      !opts["request-id"] ||
      opts["confirm-ownership"] !== "true" ||
      rest.length ||
      Object.keys(opts).some(
        (key) =>
          ![
            "epoch-id",
            "grant-client",
            "fixture-id",
            "request-id",
            "confirm-ownership",
            "config",
          ].includes(key),
      ))
  )
    throw new Error(
      "grant-native-fixture requires exact epoch/client/fixture/request and --confirm-ownership true; no overrides",
    );
  if (!nativeGrantAction && opts["fixture-id"] !== undefined)
    throw new Error("--fixture-id is restricted to grant-native-fixture");
  const successorObservation = name === "observe-successor";
  if (
    successorAction &&
    (!opts["request-id"] ||
      !opts["succession-approval"] ||
      rest.length ||
      (opts["preflight"] !== undefined && opts["preflight"] !== "true") ||
      (opts["preflight"] !== "true" && opts["confirm-ownership"] !== "true") ||
      Object.keys(opts).some(
        (key) =>
          ![
            "request-id",
            "succession-approval",
            "preflight",
            "confirm-ownership",
            "config",
          ].includes(key),
      ))
  )
    throw new Error(
      "successor-epoch requires exact --request-id, --succession-approval and --preflight true or --confirm-ownership true; no overrides",
    );
  if (
    closedSuccessorAction &&
    (!opts["request-id"] ||
      !opts["succession-approval"] ||
      opts["confirm-ownership"] !== "true" ||
      rest.length ||
      Object.keys(opts).some(
        (key) =>
          ![
            "request-id",
            "succession-approval",
            "confirm-ownership",
            "config",
          ].includes(key),
      ))
  )
    throw new Error(
      "authorize-closed-successor requires exact --request-id, --succession-approval and --confirm-ownership true; no overrides",
    );
  if (
    !successorAction &&
    !closedSuccessorAction &&
    opts["succession-approval"] !== undefined
  )
    throw new Error("--succession-approval is restricted to successor-epoch");
  if (
    successorObservation &&
    (!opts["job"] ||
      !opts["observation-job"] ||
      !opts["request-id"] ||
      rest.length ||
      Object.keys(opts).some(
        (key) =>
          !["job", "observation-job", "request-id", "config"].includes(key),
      ))
  )
    throw new Error(
      "observe-successor requires exact --job, --observation-job and --request-id; no overrides",
    );
  if (
    captureAction &&
    (!opts["job"] ||
      !opts["observation-job"] ||
      !opts["request-id"] ||
      opts["confirm-read-only"] !== "true" ||
      rest.length ||
      Object.keys(opts).some(
        (key) =>
          ![
            "job",
            "observation-job",
            "request-id",
            "confirm-read-only",
            "config",
          ].includes(key),
      ))
  )
    throw new Error(
      "capture-audit-facts requires ORIGINAL --job, --observation-job, --request-id and --confirm-read-only true; no overrides",
    );
  if (
    factsApprovalAction &&
    (!opts["request-id"] ||
      !opts["facts-approval"] ||
      opts["confirm-current-facts"] !== "true" ||
      rest.length ||
      Object.keys(opts).some(
        (key) =>
          ![
            "request-id",
            "facts-approval",
            "confirm-current-facts",
            "config",
          ].includes(key),
      ))
  )
    throw new Error(
      "authorize-isolated-scratch requires ORIGINAL --request-id, --facts-approval and --confirm-current-facts true",
    );
  if (
    (!captureAction && opts["confirm-read-only"] !== undefined) ||
    (!factsApprovalAction &&
      (opts["facts-approval"] !== undefined ||
        opts["confirm-current-facts"] !== undefined))
  )
    throw new Error(
      "Facts recovery options are restricted to the exact recovery command",
    );
  if (
    scratchAction &&
    (!opts["job"] ||
      !opts["observation-job"] ||
      !opts["request-id"] ||
      rest.length ||
      Object.keys(opts).some(
        (key) =>
          !["job", "observation-job", "request-id", "config",
            ...(name === "close-isolated-scratch" && opts["admission-mode"] ? ["admission-mode", "confirm-ownership"] : [])].includes(key),
      ))
  )
    throw new Error(
      "Isolated scratch requires exact --job, --observation-job and --request-id; no client/document override",
    );
  if (
    name === "grant-isolated-scratch" &&
    (!opts["epoch-id"] ||
      !opts["grant-client"] ||
      rest.length ||
      Object.keys(opts).some(
        (key) => !["epoch-id", "grant-client", "config"].includes(key),
      ))
  )
    throw new Error(
      "Scratch grant requires --epoch-id and --grant-client; no client override",
    );
  if (
    name !== "grant-isolated-scratch" &&
    !nativeGrantAction &&
    !savedFixtureAction &&
    (opts["epoch-id"] !== undefined || opts["grant-client"] !== undefined)
  )
    throw new Error(
      "--epoch-id and --grant-client are available only for grant-isolated-scratch",
    );
  if (
    name === "audit-atomic" &&
    (!opts["job"] ||
      !opts["observation-job"] ||
      !opts["request-id"] ||
      rest.length ||
      Object.keys(opts).some(
        (key) =>
          !["job", "observation-job", "request-id", "config"].includes(key),
      ))
  )
    throw new Error(
      "audit-atomic requires --job, --observation-job and --request-id; no client/payload override",
    );
  if (
    name !== "audit-atomic" &&
    !scratchAction &&
    !captureAction &&
    !successorObservation &&
    opts["observation-job"] !== undefined
  )
    throw new Error(
      "--observation-job is available only for scoped audit/scratch commands",
    );
  if (
    name !== "migrate-atomic" &&
    !successorAction &&
    (Object.hasOwn(opts, "preflight") ||
      Object.hasOwn(opts, "migration-approval"))
  )
    throw new Error(
      "--preflight and --migration-approval are available only for queue migrate-atomic",
    );
  if (
    name === "observe-atomic" &&
    (!opts["job"] ||
      !opts["request-id"] ||
      Object.keys(opts).some(
        (key) => !["job", "request-id", "config"].includes(key),
      ))
  )
    throw new Error(
      "observe-atomic requires --job and --request-id; only --config is additionally accepted (no client override)",
    );
  if (
    name === "migrate-atomic" &&
    (!opts["job"] ||
      !opts["request-id"] ||
      !opts["migration-approval"] ||
      rest.length ||
      (opts["preflight"] !== undefined && opts["preflight"] !== "true") ||
      (opts["preflight"] !== "true" && opts["confirm-ownership"] !== "true") ||
      Object.keys(opts).some(
        (key) =>
          ![
            "job",
            "request-id",
            "migration-approval",
            "preflight",
            "confirm-ownership",
            "config",
          ].includes(key),
      ))
  )
    throw new Error(
      "migrate-atomic requires --job, --request-id, --migration-approval and either --preflight true or --confirm-ownership true; no client override",
    );

  const write = (value: unknown) =>
    deps.stdout.write(JSON.stringify(value, null, 2) + "\n");
  if (name === "reclaim") {
    const directory = runtime.queueDirectory();
    if (fs.existsSync(path.join(directory, "broker.lock")))
      write(runtime.brokerComposition().reclaimBroker(directory));
    else write(runtime.queueAutostart().reclaimStart(directory));
    return 0;
  }
  if (name === "serve" || name === "transition-backend") {
    const { cfg } = deps.loadConfig(opts);
    let backendTransition:
      | import("../queue-backend-transition").BackendTransitionApproval
      | undefined;
    if (name === "transition-backend") {
      if (
        !opts["backend-approval"] ||
        opts["confirm-ownership"] !== "true" ||
        rest.length ||
        Object.keys(opts).some(
          (key) =>
            ![
              "backend",
              "config",
              "backend-approval",
              "confirm-ownership",
            ].includes(key),
        )
      )
        throw new Error(
          "transition-backend requires an exact private --backend-approval and explicit ownership; no tuning overrides",
        );
      const fd = fs.openSync(opts["backend-approval"], fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > 1024 * 1024 || (stat.mode & 0o077) !== 0)
          throw new Error("Backend approval must be a bounded private regular file (mode 0600)");
        backendTransition = JSON.parse(fs.readFileSync(fd, "utf8")) as typeof backendTransition;
      } finally { fs.closeSync(fd); }
      if (!backendTransition) throw new Error("Invalid backend approval");
    }
    const stateOptions: Record<string, number> = {};
    for (const [flag, field] of [
      ["idle-ms", "idleMs"],
      ["lease-ms", "leaseMs"],
      ["max-queued", "maxQueued"],
      ["max-per-client", "maxPerClient"],
    ] as const) {
      if (opts[flag] !== undefined) {
        const value = Number(opts[flag]);
        if (!Number.isSafeInteger(value) || value <= 0)
          throw new Error("--" + flag + " must be a positive integer");
        stateOptions[field] = value;
      }
    }
    const handle = await runtime.brokerComposition().serveBroker(cfg, {
      confirmOwnership: opts["confirm-ownership"] === "true",
      confirmVersionTransition: opts["confirm-version-transition"] === "true",
      stateOptions,
      autoReconcile: cfg.queue?.autoRecover !== false,
      ...(backendTransition ? { backendTransition } : {}),
    });
    write({
      state: "listening",
      socket: handle.socket,
      buildHash: handle.buildHash,
      limitations:
        "Cooperative single-host ownership. No replay or physical qualification.",
    });
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        handle
          .close()
          .catch((error: unknown) =>
            deps.stderr.write(
              `Broker remains reserved: ${error instanceof Error ? error.message : String(error)}. Resolve/drain before stopping.\n`,
            ),
          );
      });
    }
    return 0;
  }

  const { cfg } = deps.loadConfig(opts);
  const client = new runtime.QueueClient(
    opts["client"] ?? process.env["FMCAD_CLIENT"] ?? cfg.queue?.client,
    {
      cfg: { ...cfg, routing: "queue" },
      ...(opts["config"] === undefined ? {} : { configPath: opts["config"] }),
      existingCredentialsOnly: [
        "migrate-atomic",
        "observe-atomic",
        "audit-atomic",
        "create-isolated-scratch",
        "close-isolated-scratch",
        "grant-isolated-scratch",
        "capture-audit-facts",
        "authorize-isolated-scratch",
        "successor-epoch",
        "observe-successor",
        "authorize-closed-successor",
        "grant-native-fixture",
        "probe-saved-destination",
        "grant-saved-first-save",
        "observe-saved-first-save",
        "retain-saved-fixture",
      ].includes(name),
    },
  );
  if (savedFixtureAction) {
    try {
      const options: Record<string, string> = { epochId: opts["epoch-id"]!, requestId: opts["request-id"]! };
      if (name === "grant-saved-first-save") {
        options["grantClientId"] = opts["grant-client"]!;
        options["saveRequestId"] = opts["save-request-id"]!;
      } else options["jobId"] = opts["job"]!;
      if (name === "grant-saved-first-save" || name === "probe-saved-destination") {
        options["authorityFile"] = opts["authority-file"]!;
        options["folderProofFile"] = opts["folder-proof-file"]!;
      }
      write(await runtime.savedFixtureAction(client, name, options, runtime.buildHash()));
      return 0;
    } finally { client.dispose(); }
  }
  if (nativeGrantAction) {
    try {
      write(
        await runtime.nativeFixtureAction(
          client,
          {
            epochId: opts["epoch-id"]!,
            grantClientId: opts["grant-client"]!,
            fixtureId: opts["fixture-id"]!,
            requestId: opts["request-id"]!,
          },
          runtime.buildHash(),
        ),
      );
      return 0;
    } finally {
      client.dispose();
    }
  }
  if (closedSuccessorAction) {
    try {
      write(
        await runtime.prepareClosedSuccessor(
          client,
          {
            approval: opts["succession-approval"]!,
            requestId: opts["request-id"]!,
          },
          runtime.buildHash(),
        ),
      );
      return 0;
    } finally {
      client.dispose();
    }
  }
  if (successorAction || successorObservation) {
    try {
      write(
        successorAction
          ? await runtime.bootstrapSuccessor(client, cfg, {
              approval: opts["succession-approval"]!,
              requestId: opts["request-id"]!,
              preflight: opts["preflight"] === "true",
              confirmOwnership: opts["confirm-ownership"] === "true",
            })
          : await runtime.observeSuccessor(
              client,
              {
                jobId: opts["job"]!,
                observationJobId: opts["observation-job"]!,
                requestId: opts["request-id"]!,
              },
              runtime.buildHash(),
            ),
      );
      return 0;
    } finally {
      client.dispose();
    }
  }
  if (captureAction || factsApprovalAction) {
    try {
      write(
        await runtime.auditFactsAction(
          client,
          name,
          captureAction
            ? {
                jobId: opts["job"],
                observationJobId: opts["observation-job"],
                requestId: opts["request-id"],
                confirmReadOnly: true,
              }
            : {
                requestId: opts["request-id"],
                approval: opts["facts-approval"],
                confirmCurrentFacts: true,
              },
          runtime.buildHash(),
        ),
      );
      return 0;
    } finally {
      client.dispose();
    }
  }
  if (scratchAction || name === "grant-isolated-scratch") {
    try {
      write(
        await runtime.scratchEpochAction(
          client,
          name,
          scratchAction
            ? {
                jobId: opts["job"],
                observationJobId: opts["observation-job"],
                requestId: opts["request-id"],
                ...(opts["admission-mode"] ? { admissionMode: opts["admission-mode"] } : {}),
              }
            : {
                epochId: opts["epoch-id"],
                grantClientId: opts["grant-client"],
              },
          runtime.buildHash(),
        ),
      );
      return 0;
    } finally {
      client.dispose();
    }
  }
  if (name === "migrate-atomic") {
    try {
      const migrate = runtime.createProductionMigrator(client, cfg);
      write(
        opts["preflight"] === "true"
          ? await migrate.preflight(
              opts["migration-approval"]!,
              opts["request-id"]!,
              opts["job"]!,
            )
          : await migrate({
              jobId: opts["job"]!,
              requestId: opts["request-id"]!,
              approval: opts["migration-approval"]!,
              confirmOwnership: opts["confirm-ownership"] === "true",
            }),
      );
      return 0;
    } finally {
      client.dispose();
    }
  }
  if (["exec", "submit"].includes(name)) {
    try {
      if (!rest.length)
        throw new Error(`queue ${name} requires -- followed by fmcad argv`);
      const commandGlobals = runtime.parseFlags(rest).opts;
      const sequence = runtime.sequenceOptions({ ...commandGlobals, ...opts });
      const pinned = runtime.pinCommand(rest);
      const commandRequestId =
        opts["request-id"] ??
        (typeof commandGlobals["request-id"] === "string"
          ? commandGlobals["request-id"]
          : undefined) ??
        randomUUID();
      const input: Record<string, unknown> = {
        requestId: commandRequestId,
        kind: "command",
        argv: pinned,
        cwd: process.cwd(),
        backend:
          (typeof commandGlobals["backend"] === "string"
            ? commandGlobals["backend"]
            : undefined) ?? cfg.backend,
        timeoutMs: Number(
          opts["timeout"] ??
            (typeof commandGlobals["timeoutMs"] === "string"
              ? commandGlobals["timeoutMs"]
              : undefined) ??
            cfg.timeoutMs,
        ),
        inputFiles: runtime.inputFiles(pinned, process.cwd()),
        buildHash: runtime.buildHash(),
        ...(sequence ? { sequence } : {}),
      };
      const queueTimeout =
        opts["queue-timeout"] ??
        (typeof commandGlobals["queue-timeout"] === "string"
          ? commandGlobals["queue-timeout"]
          : undefined) ??
        cfg.queue?.waitTimeoutMs;
      const purpose =
        (typeof commandGlobals["description"] === "string"
          ? commandGlobals["description"]
          : undefined) ??
        deps.invocationContext?.purpose ??
        runtime.invocationPurpose();
      if (purpose) input["description"] = purpose;
      const revision =
        opts["expected-revision"] ??
        (typeof commandGlobals["expected-revision"] === "string"
          ? commandGlobals["expected-revision"]
          : undefined);
      if (queueTimeout !== undefined)
        input["queueTimeoutMs"] = Number(queueTimeout);
      if (revision !== undefined) input["expectedRevision"] = Number(revision);
      deps.stderr.write(
        "FMCAD_QUEUE_REQUEST " +
          JSON.stringify({
            requestId: commandRequestId,
            clientId: client.auth.clientId,
          }) +
          "\n",
      );
      const job = await client.submit(input);
      if (name === "submit") {
        write(job);
        return 0;
      }
      deps.stderr.write(
        "FMCAD_QUEUE_JOB " +
          JSON.stringify({ jobId: job.id, requestId: commandRequestId }) +
          "\n",
      );
      const value = await client.wait(job.id);
      if (value.stdout) deps.stdout.write(value.stdout);
      if (value.stderr) deps.stderr.write(value.stderr);
      if (value.outputs)
        deps.stderr.write(
          "FMCAD_QUEUE_OUTPUTS " + JSON.stringify(value.outputs) + "\n",
        );
      deps.stderr.write(
        "FMCAD_QUEUE_RESULT " + JSON.stringify(value.job) + "\n",
      );
      return value.job?.state === "succeeded" ? 0 : 1;
    } finally {
      client.dispose();
    }
  }
  if (rest.length) throw new Error("Unexpected child argv");
  await client.register(); // Metadata/control commands must not start Fusion access.
  if (name === "audit-atomic") {
    try {
      write(
        await runtime.auditAtomic(client, {
          jobId: opts["job"]!,
          observationJobId: opts["observation-job"]!,
          requestId: opts["request-id"]!,
          buildHash: runtime.buildHash(),
        }),
      );
      return 0;
    } finally {
      client.dispose();
    }
  }
  if (name === "observe-atomic") {
    write(
      await runtime.observeAtomic(client, {
        jobId: opts["job"]!,
        requestId: opts["request-id"]!,
        buildHash: runtime.buildHash(),
      }),
    );
    return 0;
  }
  const action = name === "status" && !opts["job"] ? "queue-summary" : name;
  if (["result", "cancel", "reconcile"].includes(name) && !opts["job"])
    throw new Error(`${name} requires --job`);
  if (
    opts["accept-outcome"] !== undefined &&
    (name !== "reconcile" ||
      !["committed", "aborted"].includes(opts["accept-outcome"]))
  )
    throw new Error(
      "--accept-outcome is available only for queue reconcile and must be committed or aborted",
    );
  if (name === "release" && !opts["sequence-id"])
    throw new Error("release requires --sequence-id");
  if (["pause", "resume", "stop"].includes(name)) {
    const control = runtime.createBrokerControl(
      runtime.createBrokerControlPort(client),
    );
    const before = await control.read();
    const value = await control.execute(name, {
      requestId: opts["request-id"] ?? randomUUID(),
      instanceId: before.instanceId,
      expectedGeneration: before.generation,
    });
    write(value);
    return 0;
  }
  const value = await client.call(action, {
    ...(opts["job"] ? { jobId: opts["job"] } : {}),
    ...(opts["sequence-id"] ? { sequenceId: opts["sequence-id"] } : {}),
    ...(opts["accept-outcome"]
      ? { acceptedOutcome: opts["accept-outcome"] }
      : {}),
  });
  write(value);
  return 0;
}

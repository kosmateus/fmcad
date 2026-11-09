import { createRequire } from "node:module";
import type {
  ObservationEvent,
  ConsoleTelemetryTimingSample,
  ProcessIdentity,
} from "@fmcad/core";

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
const load = createRequire(
  path.join(process.cwd(), "tests/console-telemetry.test.ts"),
);
const core = load("../packages/core/dist") as typeof import("@fmcad/core");
const adapters = load(
  "../packages/node-adapters/dist/telemetry",
) as typeof import("../packages/node-adapters/src/telemetry");

function present<T>(value: T | null | undefined): T {
  assert.ok(
    value !== null && value !== undefined,
    "Expected observed telemetry value",
  );
  return value;
}

const readAtMs = 10_000;
const base = {
  sourceId: "queue:fixture-project",
  epoch: "broker-epoch-1",
  sequence: 12,
  revision: 24,
  observedAtMs: 9_999,
  readAtMs,
  projectId: "project:fixture",
  transport: "mcp",
};

function job(
  id: string,
  state: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    requestId: "request-" + id,
    clientId: "client-mcp",
    state,
    submittedAt: 1_000,
    request: {
      requestId: "request-" + id,
      clientId: "client-mcp",
      phased: false,
      transport: "mcp",
      clientContext: {
        projectId: "project:fixture",
        sessionId: "session-canonical",
        docId: "document-stable-id",
        docFileId: "file-stable-id",
        purpose: "Inspect the fixture model",
      },
      inputFiles: [{ path: "input.py", sha256: "a".repeat(64) }],
    },
    ...overrides,
  };
}

test("job normalizer preserves source identities, purpose, file provenance and declared actor only", () => {
  const normalized = core.normalizeConsoleTelemetryJob(
    job("job-1", "succeeded", {
      startedAt: 1_050,
      finishedAt: 1_900,
      physicalTurns: 0,
      outputFiles: [{ artifactId: "artifact-7", path: "result.json" }],
      agent: undefined,
    }),
    base,
  );
  assert.equal(normalized.identity.projectId.value, "project:fixture");
  assert.equal(normalized.identity.requestId.value, "request-job-1");
  assert.equal(normalized.identity.jobId.value, "job-1");
  assert.equal(normalized.identity.clientId.value, "client-mcp");
  assert.equal(normalized.identity.sessionId.value, "session-canonical");
  assert.equal(normalized.identity.documentId.value, "document-stable-id");
  assert.equal(normalized.identity.documentFileId.value, "file-stable-id");
  assert.equal(normalized.identity.purpose.value, "Inspect the fixture model");
  assert.equal(normalized.actor.transport.value, "mcp");
  assert.equal(normalized.actor.agent.value, null);
  assert.equal(normalized.actor.agent.availability, "missing");
  assert.equal(normalized.actor.model.availability, "missing");
  assert.equal(normalized.actor.role.availability, "missing");
  assert.equal(normalized.physicalTurns.value, 0);
  assert.equal(present(normalized.sourceFiles.value).length, 1);
  assert.equal(
    present(present(normalized.sourceFiles.value)[0]).sha256.value,
    "a".repeat(64),
  );
  assert.equal(
    present(present(normalized.sourceFiles.value)[0]).provenance.value,
    "queue-state.job.request.inputFiles",
  );
  assert.equal(present(normalized.outputFiles.value).length, 1);
  assert.equal(
    present(present(normalized.outputFiles.value)[0]).artifactId.value,
    "artifact-7",
  );
  assert.equal(normalized.timings.totalWorkflowMs.value, 900);
  assert.equal(normalized.timings.queueWaitMs.value, null);
  assert.equal(normalized.timings.queueWaitMs.availability, "missing");
  assert.equal(normalized.timings.sdkActiveMs.value, 0);
  assert.match(present(normalized.metadata.eventId.value), /job-1$/u);
  for (const field of [
    normalized.identity.jobId,
    normalized.identity.purpose,
    normalized.actor.transport,
    normalized.physicalTurns,
    normalized.timings.totalWorkflowMs,
  ]) {
    assert.equal(typeof field.source, "string");
    assert.ok(field.unit !== undefined);
    assert.ok(field.scope);
    assert.ok(field.availability);
    assert.equal(field.readAtMs, readAtMs);
  }
});

test("phased multi-turn workflow times stay distinct and SDK-active sums only observed turn spans", () => {
  const normalized = core.normalizeConsoleTelemetryJob(
    job("multi-turn", "succeeded", {
      submittedAt: 100,
      startedAt: 130,
      finishedAt: 300,
      physicalTurns: 2,
      request: {
        phased: true,
        clientContext: { projectId: "project:fixture" },
      },
      prepareIntervals: [{ startedAtMs: 100, finishedAtMs: 120 }],
      queueWaitIntervals: [
        { startedAtMs: 120, finishedAtMs: 130 },
        { startedAtMs: 220, finishedAtMs: 250 },
      ],
      turnTimings: [
        { sdkStartedAtMs: 130, sdkFinishedAtMs: 160 },
        { sdkStartedAtMs: 250, sdkFinishedAtMs: 270 },
      ],
      pauseIntervals: [{ startedAtMs: 160, finishedAtMs: 180 }],
      finalizeIntervals: [{ startedAtMs: 280, finishedAtMs: 300 }],
      sequencePauseMs: 99_999,
    }),
    base,
  );
  assert.equal(normalized.physicalTurns.value, 2);
  assert.equal(normalized.timings.prepareMs.value, 20);
  assert.equal(normalized.timings.queueWaitMs.value, 40);
  assert.equal(normalized.timings.sdkActiveMs.value, 50);
  assert.equal(normalized.timings.pauseMs.value, 20);
  assert.equal(normalized.timings.finalizeMs.value, 20);
  assert.equal(normalized.timings.totalWorkflowMs.value, 200);
  assert.notEqual(normalized.timings.sdkActiveMs.value, 200);
  assert.notEqual(normalized.timings.pauseMs.value, 99_999);
});

test("phase mapping covers lifecycle, terminal and unresolved states; legacy missing remains explicit", () => {
  const states = [
    ["preparing", "preparing"],
    ["queued", "queued"],
    ["sending", "sending"],
    ["running", "running"],
    ["processing", "processing"],
    ["succeeded", "terminal"],
    ["failed", "terminal"],
    ["cancelled", "terminal"],
    ["needs_reconciliation", "unresolved"],
  ] as const;
  for (const [state, phase] of states) {
    const normalized = core.normalizeConsoleTelemetryJob(
      job("state", state),
      base,
    );
    assert.equal(normalized.phase.value, phase, state);
    assert.equal(normalized.phase.availability, "available");
  }
  const unrecognized = core.normalizeConsoleTelemetryJob(
    job("state", "unexpected-old-state"),
    base,
  );
  assert.equal(unrecognized.state.value, "unexpected-old-state");
  assert.equal(unrecognized.phase.value, null);
  assert.equal(unrecognized.phase.availability, "unknown");
  const old = core.normalizeConsoleTelemetryJob({ id: "old" }, base);
  assert.equal(old.phase.value, null);
  assert.equal(old.phase.availability, "unknown");
  assert.equal(old.physicalTurns.value, null);
  assert.equal(old.physicalTurns.availability, "missing");
  assert.equal(old.timings.totalWorkflowMs.value, null);
  assert.equal(old.timings.totalWorkflowMs.availability, "unknown");
  assert.equal(old.timings.sdkActiveMs.value, null);
  assert.equal(old.timings.sdkActiveMs.availability, "unknown");
  assert.equal(old.worker.alive.availability, "unknown");
  assert.equal(old.fusion.source.availability, "missing");
  assert.equal(old.sourceFiles.value, null);
  assert.equal(old.sourceFiles.availability, "missing");
  assert.equal(old.outputFiles.availability, "missing");
});

test("OpenCode source aliases remain reported aliases and do not become client/session IDs", () => {
  const invocation = core.createInvocationContext({
    clientId: "opencode:derived-client-alias",
    requestId: "request-real",
    jobId: "job-real",
    projectId: "project:fixture",
    documentId: "document-real",
    sessionId: "opencode-session:derived-session-alias",
    turnId: "turn-real",
    instanceId: "opencode-instance",
    source: "opencode",
    purpose: "declared purpose",
  });
  const event: ObservationEvent = {
    version: 1,
    invocation,
    atMs: 9_900,
    name: "opencode.session.activity",
    data: { status: "active", agent: "Reviewer" },
  };
  const normalized = core.normalizeConsoleObservation(event, base);
  assert.equal(normalized.actor.transport.value, "opencode");
  assert.equal(normalized.actor.agent.value, "Reviewer");
  assert.equal(normalized.actor.model.availability, "missing");
  assert.equal(normalized.identity.clientId.value, null);
  assert.equal(normalized.identity.clientId.availability, "unknown");
  assert.equal(
    normalized.identity.reportedClientId.value,
    "opencode:derived-client-alias",
  );
  assert.equal(normalized.identity.sessionId.value, null);
  assert.equal(
    normalized.identity.reportedSessionId.value,
    "opencode-session:derived-session-alias",
  );
  assert.equal(normalized.identity.requestId.value, "request-real");
  assert.equal(normalized.identity.jobId.value, "job-real");
  assert.equal(normalized.identity.turnId.value, "turn-real");
  assert.equal(normalized.identity.documentId.value, "document-real");
  assert.equal(normalized.identity.purpose.value, "declared purpose");
});

test("current counts require complete state and percentiles use the whole in-window sample set", () => {
  const jobs = [
    job("a", "queued"),
    job("b", "running"),
    job("c", "succeeded"),
    job("d", "needs_reconciliation"),
    job("e", "not-a-known-state"),
  ];
  const counts = core.currentConsoleTelemetryCounts(
    jobs,
    true,
    "broker",
    readAtMs,
    "full-state",
  );
  assert.deepEqual(counts.value, {
    preparing: 0,
    queued: 1,
    sending: 0,
    running: 1,
    processing: 0,
    terminal: 1,
    unresolved: 2,
  });
  assert.equal(
    core.currentConsoleTelemetryCounts(
      jobs,
      false,
      "broker",
      readAtMs,
      "bounded-history",
    ).value,
    null,
  );
  assert.equal(
    core.currentConsoleTelemetryCounts(
      jobs,
      false,
      "broker",
      readAtMs,
      "bounded-history",
    ).availability,
    "unknown",
  );
  const all: ConsoleTelemetryTimingSample[] = Array.from(
    { length: 200 },
    (_, index) => ({
      kind: "queueWait",
      valueMs: index + 1,
      observedAtMs: readAtMs,
    }),
  );
  all.push({
    kind: "queueWait",
    valueMs: 10_000,
    observedAtMs: readAtMs - 3_601_000,
  });
  const percentiles = core.consoleTelemetryPercentiles(
    all,
    readAtMs,
    3_600_000,
    "broker",
    "retained-full-sample-set",
  );
  assert.equal(percentiles.sampleCount.value, 200);
  assert.equal(percentiles.p50Ms.value, 100.5);
  assert.equal(percentiles.p95Ms.value, 190);
  const empty = core.consoleTelemetryPercentiles(
    [],
    readAtMs,
    60_000,
    "project",
    "empty-but-read",
  );
  assert.equal(empty.sampleCount.value, 0);
  assert.equal(empty.sampleCount.availability, "available");
  assert.equal(empty.p50Ms.value, null);
  assert.equal(empty.p50Ms.availability, "missing");
});

test("canonical Overview fields map to complete scoped counts and retained queue-wait samples", () => {
  const sampleWindowMs = 60 * 60 * 1000;
  const jobs = [
    job("pending", "queued"),
    job("running", "running"),
    job("unresolved", "needs_reconciliation"),
    job("failed", "failed", { finishedAt: readAtMs - 100 }),
  ];
  const snapshot = core.collectConsoleTelemetry({
    projectId: "project:fixture",
    sourceId: "queue:project:fixture",
    readAtMs,
    jobs,
    jobsComplete: true,
    jobsScope: "project",
    jobSource: { ...base, revision: 24 },
    presenceSources: [
      {
        projectId: "project:fixture",
        source: "opencode-diagnostic-presence",
        pid: 42,
        birth: "boot:42",
        sessionId: "session-live",
        observedAtMs: readAtMs,
        alive: true,
      },
    ],
    presenceComplete: { clients: "available", openCode: "available" },
    timingSamples: [
      { kind: "queueWait", valueMs: 20, observedAtMs: readAtMs - 10 },
      { kind: "queueWait", valueMs: 40, observedAtMs: readAtMs - 20 },
      {
        kind: "queueWait",
        valueMs: 99_999,
        observedAtMs: readAtMs - sampleWindowMs - 1,
      },
    ],
    timingAvailability: "available",
    timingWindowMs: sampleWindowMs,
    timingScope: "project",
    executions: [
      { state: "failed", finishedAtMs: readAtMs - 100 },
      { state: "succeeded", finishedAtMs: readAtMs - 90 },
    ],
    executionsAvailability: "available",
  });
  assert.deepEqual(
    Object.keys(snapshot.overview).sort(),
    [
      "pendingProject",
      "running",
      "unresolved",
      "samples",
      "failedExecutions",
      "waitMedianMs",
      "waitP95Ms",
      "liveReportingSessions",
      "sampleWindow",
    ].sort(),
  );
  assert.equal(snapshot.overview.pendingProject.value, 1);
  assert.equal(snapshot.overview.pendingProject.scope, "project");
  assert.equal(snapshot.overview.running.value, 1);
  assert.equal(snapshot.overview.unresolved.value, 1);
  assert.equal(snapshot.overview.failedExecutions.value, 1);
  assert.equal(snapshot.overview.samples.value, 2);
  assert.equal(snapshot.overview.waitMedianMs.value, 30);
  assert.equal(snapshot.overview.waitP95Ms.value, 40);
  assert.equal(snapshot.overview.liveReportingSessions.value, 1);
  assert.deepEqual(snapshot.overview.sampleWindow.value, {
    from: 0,
    to: readAtMs,
  });

  const partial = core.collectConsoleTelemetry({
    projectId: "project:fixture",
    sourceId: "queue:project:fixture",
    readAtMs,
    jobs: jobs.slice(0, 1),
    jobsComplete: false,
    jobsScope: "project",
    jobSource: { ...base, revision: 24 },
    presenceSources: null,
    presenceComplete: { clients: "missing", openCode: "missing" },
    timingSamples: null,
    timingAvailability: "missing",
    timingWindowMs: sampleWindowMs,
    timingScope: "project",
    executions: null,
    executionsAvailability: "missing",
  });
  assert.equal(partial.overview.pendingProject.value, null);
  assert.equal(partial.overview.pendingProject.availability, "unknown");
  assert.equal(partial.overview.samples.value, null);
  assert.equal(partial.overview.waitMedianMs.value, null);
  assert.equal(partial.overview.liveReportingSessions.availability, "missing");
  assert.equal(partial.overview.sampleWindow.value, null);

  const global = core.collectConsoleTelemetry({
    projectId: null,
    sourceId: "queue:global",
    readAtMs,
    jobs: [
      job("p1-running", "running", {
        request: {
          clientContext: { projectId: "project:p1" },
        },
      }),
      job("p1-queued", "queued", {
        request: {
          clientContext: { projectId: "project:p1" },
        },
      }),
      job("p2-unresolved", "needs_reconciliation", {
        request: {
          clientContext: { projectId: "project:p2" },
        },
      }),
    ],
    jobsComplete: true,
    jobsScope: "broker",
    registeredProjectIds: ["project:p1", "project:p2", "project:p3"],
    registeredProjectsComplete: true,
    jobSource: {
      sourceId: "queue:global",
      epoch: "global-epoch",
      revision: 80,
      observedAtMs: readAtMs,
    },
    presenceSources: null,
    presenceComplete: { clients: "missing", openCode: "missing" },
    timingSamples: [],
    timingAvailability: "available",
    timingWindowMs: sampleWindowMs,
    timingScope: "broker",
    executions: [],
    executionsAvailability: "available",
  });
  assert.equal(global.overview.pendingProject.value, 2);
  assert.equal(global.overview.pendingProject.scope, "broker");
  assert.deepEqual(
    present(global.events.value).map((event) => event.identity.projectId.value),
    ["project:p1", "project:p1", "project:p2"],
  );
});

test("presence merges duplicate process observations by PID and birth, scopes projects, and separates aliases", () => {
  const presence = [
    {
      projectId: "project:one",
      source: "project-client-process-heartbeat",
      pid: 101,
      birth: "boot:1",
      clientId: "client:one",
      observedAtMs: readAtMs,
      alive: true,
    },
    {
      projectId: "project:one",
      source: "opencode-diagnostic-presence",
      pid: 101,
      birth: "boot:1",
      reportedClientId: "opencode:alias",
      reportedSessionId: "session:source-hash",
      observedAtMs: readAtMs,
      alive: true,
      agent: "Engineer",
    },
    {
      projectId: "project:one",
      source: "project-client-process-heartbeat",
      pid: 101,
      birth: "boot:2",
      clientId: "client:one",
      observedAtMs: readAtMs,
      alive: true,
    },
    {
      projectId: "project:two",
      source: "project-client-process-heartbeat",
      pid: 202,
      birth: "boot:3",
      clientId: "client:two",
      observedAtMs: readAtMs,
      alive: true,
    },
  ];
  const summary = core.summarizeConsolePresence(
    "project:one",
    presence,
    {
      clients: "available",
      openCode: "available",
    },
    readAtMs,
  );
  assert.equal(summary.processCount.value, 2);
  assert.equal(summary.clientCount.value, 1);
  assert.equal(summary.sessionCount.value, 1);
  assert.equal(summary.declaredAgentCount.value, 1);
  const noOpenCode = core.summarizeConsolePresence(
    "project:one",
    presence.slice(0, 1),
    {
      clients: "available",
      openCode: "missing",
    },
    readAtMs,
  );
  assert.equal(noOpenCode.clientCount.value, 1);
  assert.equal(noOpenCode.sessionCount.value, null);
  assert.equal(noOpenCode.sessionCount.availability, "missing");
  const reused = core.summarizeConsolePresence(
    "project:one",
    [{ ...present(presence[0]), alive: false }],
    true,
    readAtMs,
  );
  assert.equal(reused.processCount.value, 0);
  assert.equal(reused.clientCount.value, 0);
  const stale = core.summarizeConsolePresence(
    "project:one",
    [{ ...present(presence[0]), observedAtMs: readAtMs - 20_000 }],
    true,
    readAtMs,
  );
  assert.equal(stale.processCount.value, 1);
  assert.equal(stale.processCount.availability, "stale");
  const unknown = core.summarizeConsolePresence(
    "project:one",
    [{ ...present(presence[0]), alive: null }],
    true,
    readAtMs,
  );
  assert.equal(unknown.clientCount.value, null);
  assert.equal(unknown.clientCount.availability, "unknown");
});

test("host, panel, worker, lock and OpenCode sources keep explicit units and availability", () => {
  const host = core.normalizeConsoleHostMetrics(
    {
      readAt: readAtMs,
      host: {
        hostname: "fixture-host",
        cpuPercent: null,
        ramUsedBytes: 0,
        ramTotalBytes: 1024,
        swapUsedBytes: null,
        swapTotalBytes: null,
        load: [0, 0.1, 0.2],
        disk: { usedBytes: null, totalBytes: 0, path: "/fixture" },
        network: {
          interface: null,
          rxBytesPerSecond: null,
          txBytesPerSecond: null,
        },
        uptimeSeconds: 30,
        processCount: 2,
      },
    },
    readAtMs,
  );
  assert.equal(host.hostname.value, "fixture-host");
  assert.equal(host.ramUsedBytes.value, 0);
  assert.equal(host.ramUsedBytes.availability, "available");
  assert.equal(host.ramUsedBytes.unit, "bytes");
  assert.equal(host.cpuPercent.value, null);
  assert.equal(host.cpuPercent.availability, "unknown");
  for (const field of Object.values(host)) {
    assert.equal(typeof field.source, "string");
    assert.ok(field.unit !== undefined);
    assert.ok(field.scope);
    assert.ok(field.availability);
  }
  const unsupported = core.normalizeConsoleHostMetrics(
    { host: { hostname: "fixture-host" } },
    readAtMs,
    "unsupported",
  );
  assert.equal(unsupported.hostname.value, null);
  assert.equal(unsupported.hostname.availability, "unsupported");
  const processes = core.collectConsoleTelemetry({
    projectId: "project:fixture",
    sourceId: "source:fixture",
    readAtMs,
    jobs: [],
    jobsComplete: true,
    jobsScope: "broker",
    jobSource: { ...base, revision: 24 },
    presenceSources: [],
    presenceComplete: true,
    panelProcess: {
      pid: process.pid,
      birth: "panel:birth",
      alive: true,
      rssBytes: 0,
    },
    workerProcesses: [
      { pid: 77, birth: "worker:birth", alive: true, rssBytes: null },
    ],
    workersComplete: true,
    locks: {
      status: "unknown",
      source: "fixture-lock-reader",
      reason: "No verified lock owner",
    },
    timingSamples: [],
    timingWindowMs: 60_000,
    timingScope: "broker",
  });
  assert.equal(processes.processes.panel.kind, "panel");
  assert.equal(processes.processes.panel.identity.pid.value, process.pid);
  assert.equal(processes.processes.panel.rssBytes.value, 0);
  assert.equal(
    present(present(processes.processes.workers.value)[0]).kind,
    "worker",
  );
  assert.equal(
    present(present(processes.processes.workers.value)[0]).rssBytes
      .availability,
    "unknown",
  );
  assert.equal(processes.locks.status.value, "unknown");
  assert.match(
    present(processes.locks.status.reason),
    /ABSENCE_IS_NOT_UNLOCKED/u,
  );
  assert.equal(processes.gaps.value, null);
  assert.equal(processes.gaps.availability, "unknown");
  assert.equal(present(processes.events.value).length, 0);
  assert.equal(processes.timingPercentiles.sampleCount.value, 0);
});

test("Fusion facts come only from existing receipts and exact captured document state", () => {
  const receipt = core.normalizeConsoleFusionReceipt(
    {
      jobId: "job-real",
      source: "preflight",
      observedAtMs: readAtMs,
      receipt: {
        completed: true,
        idle: true,
        instance: {
          pid: 9,
          birth: "fusion:birth",
          version: "fixture-version",
          documents: [{ id: "unselected-doc", fileId: "unselected-file" }],
          documentState: {
            status: "complete",
            state: {
              identity: {
                creationId: "selected-doc",
                fileId: "selected-file",
              },
            },
          },
        },
      },
    },
    "preflight",
    { sourceId: "existing-receipt", readAtMs },
  );
  assert.equal(receipt.state.value, "observed");
  assert.equal(receipt.idle.value, true);
  assert.equal(receipt.documentId.value, "selected-doc");
  assert.equal(receipt.documentFileId.value, "selected-file");
  assert.equal(receipt.source.value, "preflight");
  const noCapturedDocument = core.normalizeConsoleFusionReceipt(
    {
      completed: true,
      instance: { documents: [{ id: "do-not-promote", fileId: "file" }] },
    },
    "postflight",
    { sourceId: "existing-receipt", readAtMs },
  );
  assert.equal(noCapturedDocument.documentId.value, null);
  assert.equal(noCapturedDocument.documentFileId.value, null);
});

test("OpenCode presence uses the process birth and explicit declarations without promoting source aliases", () => {
  const input = [
    {
      schemaVersion: 1,
      pid: 88,
      birth: "boot:88",
      updatedAt: readAtMs,
      sessions: [
        {
          id: "hashed-session-source-id",
          clientId: "opencode:hashed-client-source-id",
          project: "/fixture/project",
          status: "active",
          lastActivityAt: 123,
          agent: "Planner",
        },
        {
          id: "foreign-session",
          project: "/fixture/project-other",
          status: "active",
          lastActivityAt: readAtMs,
        },
      ],
    },
  ];
  const records = adapters.normalizeOpenCodePresenceRecords(
    input,
    "project:fixture",
    "/fixture/project",
    readAtMs,
    (identity) => identity.birth === "boot:88",
  );
  assert.equal(records.length, 1);
  assert.equal(present(records[0]).sessionId, undefined);
  assert.equal(present(records[0]).clientId, undefined);
  assert.equal(
    present(records[0]).reportedSessionId,
    "hashed-session-source-id",
  );
  assert.equal(
    present(records[0]).reportedClientId,
    "opencode:hashed-client-source-id",
  );
  assert.equal(present(records[0]).agent, "Planner");
  assert.equal(present(records[0]).model, undefined);
  assert.equal(present(records[0]).presence, "observed");
  const withoutAgent = { ...present(records[0]) };
  // Retain the historical explicit-undefined input at this runtime boundary.
  Reflect.set(withoutAgent, "agent", undefined);
  const noAgent = core.summarizeConsolePresence(
    "project:fixture",
    [withoutAgent],
    { clients: "available", openCode: "available" },
    readAtMs,
  );
  assert.equal(noAgent.declaredAgentCount.value, 0);
  assert.equal(noAgent.declaredAgentCount.availability, "available");
  assert.equal(noAgent.clientCount.value, 0);
  assert.equal(noAgent.sessionCount.value, 1);
});

test("event cursors preserve epoch, identify gaps and enforce bounded replay", () => {
  const events = [1, 2, 5].map((sequence) =>
    core.normalizeConsoleTelemetryJob(job("job-" + sequence, "queued"), {
      ...base,
      sequence,
      revision: null,
      eventId: `source:epoch:sequence:${sequence}:job-${sequence}`,
    }),
  );
  const cursor = present(core.consoleTelemetryEventCursor(present(events[1])));
  assert.equal(cursor.position, 2);
  assert.equal(cursor.epoch, "broker-epoch-1");
  const replay = core.boundedConsoleTelemetryReplay(
    events,
    cursor,
    1,
    readAtMs,
  );
  assert.equal(present(replay.events.value).length, 1);
  assert.equal(
    present(present(replay.events.value)[0]).metadata.sequence.value,
    5,
  );
  assert.deepEqual(present(replay.gaps.value)[0], {
    sourceId: "queue:fixture-project",
    epoch: "broker-epoch-1",
    fromPosition: 3,
    toPosition: 4,
    positionKind: "sequence",
    detectedAtMs: readAtMs,
    reason: "SOURCE_POSITION_ADVANCED_WITHOUT_REPLAYED_RECORDS",
  });
  const truncated = core.boundedConsoleTelemetryReplay(
    events,
    null,
    2,
    readAtMs,
  );
  assert.equal(truncated.truncated, true);
  assert.equal(present(truncated.events.value).length, 2);
  assert.equal(truncated.gaps.value, null);
  assert.equal(truncated.gaps.availability, "unknown");
  const lostPrefix = core.boundedConsoleTelemetryReplay(
    [present(events[2])],
    null,
    10,
    readAtMs,
  );
  assert.deepEqual(lostPrefix.gaps.value, [
    {
      sourceId: "queue:fixture-project",
      epoch: "broker-epoch-1",
      fromPosition: 1,
      toPosition: 4,
      positionKind: "sequence",
      detectedAtMs: readAtMs,
      reason: "SOURCE_PREFIX_NOT_REPLAYED",
    },
  ]);
  assert.throws(() =>
    core.boundedConsoleTelemetryReplay(events, null, 0, readAtMs),
  );
  assert.equal(
    core.detectConsoleTelemetryGap(
      cursor,
      { ...cursor, epoch: "new-epoch", position: 6 },
      readAtMs,
    ),
    null,
  );
  assert.throws(
    () =>
      core.boundedConsoleTelemetryReplay(
        [
          ...events,
          core.normalizeConsoleTelemetryJob(job("new-epoch", "queued"), {
            ...base,
            epoch: "broker-epoch-2",
            sequence: 1,
            revision: null,
          }),
        ],
        cursor,
        10,
        readAtMs,
      ),
    /epoch changed/u,
  );
  const duplicateRevision = ["job-a", "job-b"].map((id) =>
    core.normalizeConsoleTelemetryJob(job(id, "queued"), {
      ...base,
      sequence: null,
      revision: 60,
    }),
  );
  assert.equal(
    present(core.consoleTelemetryEventCursor(present(duplicateRevision[0])))
      .positionKind,
    "revision",
  );
  const firstRevisionPage = core.boundedConsoleTelemetryReplay(
    duplicateRevision,
    null,
    1,
    readAtMs,
  );
  assert.equal(
    present(present(firstRevisionPage.events.value)[0]).identity.jobId.value,
    "job-a",
  );
  const secondRevisionPage = core.boundedConsoleTelemetryReplay(
    duplicateRevision,
    firstRevisionPage.cursor.value,
    1,
    readAtMs,
  );
  assert.equal(
    present(present(secondRevisionPage.events.value)[0]).identity.jobId.value,
    "job-b",
  );
  assert.equal(secondRevisionPage.gaps.availability, "available");
  assert.deepEqual(secondRevisionPage.gaps.value, []);
});

test("passive collectors read complete bounded heartbeat sets, worker identity and existing Fusion receipts only", (t) => {
  const root = fs.mkdtempSync(
    path.join(
      os.tmpdir(),
      `fmcad-console-telemetry-${process.pid}-${randomUUID()}-`,
    ),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  const queue = path.join(root, "queue");
  const clients = path.join(project, ".cad", "telemetry", "clients");
  const jobs = path.join(queue, "jobs");
  fs.mkdirSync(clients, { recursive: true });
  fs.mkdirSync(path.join(jobs, "job-1"), { recursive: true });
  fs.mkdirSync(path.join(jobs, "job-held"), { recursive: true });
  for (let index = 0; index < 270; index++) {
    const record = {
      version: 1,
      instanceId: `instance-${index}`,
      clientId: `client-${index}`,
      project,
      pid: 1000 + index,
      birth: "boot:1",
      observedAt: readAtMs,
      closed: false,
    };
    fs.writeFileSync(
      path.join(clients, `${String(index).padStart(64, "0")}.json`),
      JSON.stringify(record),
    );
  }
  fs.writeFileSync(
    path.join(jobs, "job-1", "worker-identity.json"),
    JSON.stringify({ pid: 42, birth: "boot:old" }),
  );
  fs.writeFileSync(
    path.join(jobs, "job-1", "preflight.json"),
    JSON.stringify({ completed: true, instance: { version: "fixture" } }),
  );
  fs.writeFileSync(
    path.join(jobs, "job-1", "postflight.json"),
    JSON.stringify({ completed: true, instance: { version: "after" } }),
  );
  fs.writeFileSync(
    path.join(jobs, "job-held", "postflight.json"),
    JSON.stringify({ completed: true, instance: {} }),
  );
  const now = () => readAtMs;
  const clientsRead = adapters.readProjectClientPresenceRecords(project, {
    now,
    maxRecords: 300,
  });
  assert.equal(clientsRead.status, "available");
  assert.equal(present(clientsRead.value).length, 270);
  assert.equal(
    adapters.readProjectClientPresenceRecords(project, { now, maxRecords: 200 })
      .status,
    "unknown",
  );
  const alive = (identity: ProcessIdentity) =>
    identity.pid !== 42 ? true : identity.birth === "boot:new";
  const worker = adapters.readWorkerIdentity(queue, "job-1", {
    now,
    processAlive: alive,
  });
  assert.equal(present(worker.value).pid, 42);
  assert.equal(present(worker.value).alive, false);
  const fusion = adapters.readExistingFusionReceipts(
    queue,
    [
      { jobId: "job-1", state: "succeeded" },
      { jobId: "job-held", state: "needs_reconciliation" },
    ],
    { now },
  );
  assert.equal(fusion.status, "available");
  assert.equal(present(fusion.value).length, 2);
  assert.deepEqual(
    present(fusion.value).map((item) => item.source),
    ["preflight", "postflight"],
  );
  assert.equal(
    present(fusion.value).some((item) => item.jobId === "job-held"),
    false,
  );
  const lock = core.normalizeConsoleLocks(null, readAtMs);
  assert.equal(lock.status.value, null);
  assert.equal(lock.status.availability, "missing");
  const unknownLock = core.normalizeConsoleLocks(
    { status: "unknown", reason: "No verified matching advisory owner" },
    readAtMs,
  );
  assert.equal(unknownLock.status.value, "unknown");
  assert.match(present(unknownLock.status.reason), /ABSENCE_IS_NOT_UNLOCKED/u);
});

test("event source sequences and serializes writes without allowing sink failure to fail CAD", async () => {
  const saved: import("@fmcad/core").ConsoleTelemetryEvent[] = [];
  let release!: () => void;
  const firstWrite = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const reportedGaps: import("@fmcad/core").ConsoleTelemetryGap[] = [];
  const source = adapters.createConsoleTelemetrySource({
    sourceId: "producer:test",
    epoch: "producer-epoch",
    now: () => readAtMs,
    sink: {
      async append(event) {
        calls++;
        if (calls === 1) await firstWrite;
        if (calls === 2) throw new Error("fixture sink failure");
        saved.push(event);
      },
    },
    onGap: (gap) => reportedGaps.push(gap),
  });
  const first = source.publishJob(job("first", "queued"));
  const second = source.publishJob(job("second", "queued"));
  assert.equal(first.status, "queued");
  assert.equal(second.status, "queued");
  assert.equal(present(first.event).metadata.sequence.value, 1);
  assert.equal(present(second.event).metadata.sequence.value, 2);
  assert.equal(source.cursor(), null);
  release();
  await source.flush();
  assert.equal(calls, 2);
  assert.equal(saved.length, 1);
  assert.equal(present(source.cursor()).position, 1);
  assert.equal(present(source.readGaps().gaps[0]).fromPosition, 2);
  assert.equal(reportedGaps.length, 1);
  const third = source.publishJob(job("third", "queued"));
  await source.flush();
  assert.equal(present(third.event).metadata.sequence.value, 3);
  assert.equal(present(source.cursor()).position, 3);
  await source.close();
  assert.deepEqual(source.publishJob(job("after-close", "queued")), {
    event: null,
    status: "dropped",
  });
  const invalidClock = adapters.createConsoleTelemetrySource({
    sourceId: "queue:invalid-clock",
    epoch: "epoch",
    now: () => -1,
    sink: { append: async () => {} },
    onGap: () => {},
  });
  assert.deepEqual(invalidClock.publishJob(job("clock", "queued")), {
    event: null,
    status: "dropped",
  });
  await invalidClock.close();
});

test("bounded telemetry producer reports queue overflow as a retained source gap", async () => {
  let release!: () => void;
  const gapReports: import("@fmcad/core").ConsoleTelemetryGap[] = [];
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const source = adapters.createConsoleTelemetrySource({
    sourceId: "queue:bounded",
    epoch: "epoch",
    maxPendingEvents: 1,
    now: () => readAtMs,
    sink: {
      append: async () => pending,
    },
    onGap: (gap) => gapReports.push(gap),
  });
  const accepted = source.publishJob(job("first", "queued"));
  const dropped = source.publishJob(job("second", "queued"));
  assert.equal(accepted.status, "queued");
  assert.equal(dropped.status, "dropped");
  assert.equal(present(dropped.event).identity.jobId.value, "second");
  assert.equal(present(dropped.gap).fromPosition, 2);
  assert.equal(present(gapReports[0]).fromPosition, 2);
  assert.equal(source.readGaps().gaps.length, 1);
  release();
  await source.flush();
  assert.equal(present(source.cursor()).position, 1);
  source.acknowledgeGaps(2);
  assert.equal(source.readGaps().gaps.length, 0);
  await source.close();
});

test("source producer records a physical SDK turn interval with exact turn identity", async () => {
  const appended: import("@fmcad/core").ConsoleTelemetryEvent[] = [];
  const source = adapters.createConsoleTelemetrySource({
    sourceId: "queue:project:fixture",
    epoch: "broker-epoch",
    now: () => readAtMs,
    sink: {
      append: async (event) => {
        appended.push(event);
      },
    },
    onGap: () => {},
  });
  const queued = source.publishPhaseInterval({
    phase: "sdkActive",
    job: {
      id: "job-real",
      requestId: "request-real",
      clientId: "mcp-client",
      projectId: "project:fixture",
      turnId: "turn-physical-2",
      sessionId: "session-real",
      documentId: "document-real",
      documentFileId: "file-real",
      purpose: "Continue second physical turn",
      state: "running",
      transport: "mcp",
      agentId: null,
      agent: null,
      model: null,
      role: null,
      revision: 40,
      physicalTurns: 2,
      physicalTurnOrdinal: 2,
    },
    startedAtMs: 300,
    finishedAtMs: 420,
  });
  assert.equal(queued.status, "queued");
  assert.ok(queued.event);
  assert.equal(queued.event.eventType, "queue.phase-interval");
  assert.equal(queued.event.eventName.value, "queue.phase.sdkActive");
  assert.equal(queued.event.phaseIntervalKind.value, "sdkActive");
  assert.equal(queued.event.metadata.observedAtMs.value, null);
  assert.equal(queued.event.metadata.observedAtMs.availability, "missing");
  assert.equal(queued.event.metadata.readAtMs.value, readAtMs);
  assert.equal(queued.event.identity.turnId.value, "turn-physical-2");
  assert.equal(queued.event.identity.requestId.value, "request-real");
  assert.equal(queued.event.identity.documentFileId.value, "file-real");
  assert.equal(
    queued.event.identity.purpose.value,
    "Continue second physical turn",
  );
  assert.equal(queued.event.physicalTurns.value, 2);
  assert.equal(queued.event.physicalTurnOrdinal.value, 2);
  assert.equal(queued.event.timings.sdkActiveMs.value, 120);
  assert.equal(queued.event.timings.sdkActiveMs.scope, "turn");
  assert.equal(queued.event.timings.prepareMs.availability, "missing");
  assert.equal(queued.event.timings.totalWorkflowMs.value, null);
  await source.flush();
  assert.equal(appended.length, 1);
  assert.equal(
    present(appended[0]).metadata.eventId.value,
    queued.event.metadata.eventId.value,
  );
});

test("read adapter preserves attached-client presence without OpenCode and skips unresolved Fusion receipts", () => {
  const calls: string[] = [];
  const jobs = [
    job("done", "succeeded", { finishedAt: readAtMs, physicalTurns: 0 }),
    job("held", "needs_reconciliation", { physicalTurns: 1 }),
  ];
  const adapter = adapters.createConsoleTelemetryReadAdapter({
    now: () => readAtMs,
    queueJobs: () => ({
      status: "available",
      source: "complete-project-queue-snapshot",
      sourceId: "queue:project:fixture",
      epoch: "broker-epoch",
      sequence: 8,
      revision: 12,
      observedAtMs: readAtMs,
      value: { jobs, complete: true, scope: "project" },
    }),
    registeredProjects: () => ({
      status: "available",
      source: "project-registry",
      sourceId: "registry:global",
      observedAtMs: readAtMs,
      value: ["project:fixture"],
    }),
    presence: () => ({
      status: "available",
      source: "project-presence-directories",
      sourceId: "presence:project:fixture",
      observedAtMs: readAtMs,
      value: {
        clientRecords: [
          {
            version: 1,
            instanceId: "client-instance",
            clientId: "mcp-client:one",
            project: "/fixture/project",
            pid: 500,
            birth: "boot:500",
            observedAt: readAtMs,
            closed: false,
          },
        ],
        clientStatus: "available",
        openCodeRecords: [],
        openCodeStatus: "missing",
      },
    }),
    systemMetrics: () => ({
      status: "available",
      source: "system-metrics",
      sourceId: "host:fixture",
      observedAtMs: readAtMs,
      value: {
        readAt: readAtMs,
        host: { hostname: "fixture-host", processCount: 1 },
      },
    }),
    panelProcess: () => ({ pid: 700, birth: "panel:700", alive: true }),
    workerIdentity: (id) => ({ pid: 800, birth: `worker:${id}` }),
    fusionReceipt: (id, kind) => {
      calls.push(`${id}:${kind}`);
      return null;
    },
    locks: () => ({
      status: "available",
      source: "console-locks-read-only",
      sourceId: "locks:project:fixture",
      observedAtMs: readAtMs,
      value: {
        status: "unknown",
        source: "linux-proc-locks",
        readAt: readAtMs,
        entries: [],
      },
    }),
    timingSamples: () => ({
      status: "available",
      source: "retained-full-timing-samples",
      sourceId: "timings:project:fixture",
      observedAtMs: readAtMs,
      value: [],
    }),
    terminalExecutions: () => ({
      status: "available",
      source: "retained-terminal-execution-events",
      sourceId: "history:project:fixture",
      observedAtMs: readAtMs,
      value: [{ state: "failed", finishedAtMs: readAtMs - 1 }],
    }),
    processAlive: (identity) =>
      identity.birth.startsWith("boot:") ||
      identity.birth.startsWith("worker:"),
  });
  const snapshot = adapter.read({
    scope: {
      kind: "project",
      projectId: "project:fixture",
      projectDirectory: "/fixture/project",
    },
    timingWindowMs: 60_000,
  });
  assert.equal(snapshot.events.availability, "available");
  assert.equal(present(snapshot.events.value).length, 2);
  assert.equal(present(snapshot.currentCounts.value).terminal, 1);
  assert.equal(present(snapshot.currentCounts.value).unresolved, 1);
  assert.equal(snapshot.overview.failedExecutions.value, 1);
  assert.equal(snapshot.presence.clientSource.value, "available");
  assert.equal(snapshot.presence.clientCount.value, 1);
  assert.equal(snapshot.presence.openCodeSource.value, "missing");
  assert.equal(snapshot.presence.sessionCount.value, null);
  assert.equal(snapshot.presenceObservations.records.length, 1);
  assert.equal(snapshot.presenceObservations.sources.clients, "available");
  assert.equal(snapshot.presenceObservations.sources.openCode, "missing");
  assert.equal(snapshot.processes.panel.kind, "panel");
  assert.equal(snapshot.processes.panel.identity.pid.value, 700);
  assert.equal(Object.hasOwn(snapshot.processes, "browser"), false);
  assert.equal(snapshot.locks.status.value, "unknown");
  assert.equal(calls.includes("held:preflight"), false);
  assert.equal(calls.includes("held:postflight"), false);
});

test("global read keeps registered-project counts, deduped presence and host metrics single-sourced", () => {
  let systemReads = 0;
  const jobs = [
    job("p1-queued", "queued", {
      request: { clientContext: { projectId: "project:p1" } },
    }),
    job("p1-running", "running", {
      request: { clientContext: { projectId: "project:p1" } },
    }),
    job("p2-unresolved", "needs_reconciliation", {
      request: { clientContext: { projectId: "project:p2" } },
    }),
  ];
  const adapter = adapters.createConsoleTelemetryReadAdapter({
    now: () => readAtMs,
    queueJobs: (projectId) => {
      assert.equal(projectId, null);
      return {
        status: "available",
        source: "one-global-queue-snapshot",
        sourceId: "queue:global",
        epoch: "broker-global-epoch",
        revision: 44,
        observedAtMs: readAtMs,
        value: { jobs, complete: true, scope: "broker" },
      };
    },
    registeredProjects: () => ({
      status: "available",
      source: "registered-project-store",
      sourceId: "registry:global",
      observedAtMs: readAtMs,
      value: ["project:p1", "project:p2", "project:p3"],
    }),
    presence: () => {
      throw new Error(
        "Global reads must not open one project's presence folder",
      );
    },
    globalPresence: () => ({
      status: "available",
      source: "registry-scoped-global-presence",
      sourceId: "presence:global",
      observedAtMs: readAtMs,
      value: {
        records: [
          {
            projectId: "project:p1",
            source: "project-client-process-heartbeat",
            pid: 91,
            birth: "boot:91",
            clientId: "client:shared",
            observedAtMs: readAtMs,
            alive: true,
          },
          {
            projectId: "project:p2",
            source: "opencode-diagnostic-presence",
            pid: 91,
            birth: "boot:91",
            sessionId: "session:p2",
            observedAtMs: readAtMs,
            alive: true,
          },
        ],
        clientStatus: "available",
        openCodeStatus: "available",
      },
    }),
    systemMetrics: () => {
      systemReads++;
      return {
        status: "available",
        source: "single-global-host-read",
        sourceId: "host:global",
        observedAtMs: readAtMs,
        value: {
          readAt: readAtMs,
          host: { hostname: "host-once", processCount: 5 },
        },
      };
    },
    panelProcess: () => ({ pid: 1, birth: "panel:1", alive: true }),
    workerIdentity: () => null,
    fusionReceipt: () => null,
    locks: () => {
      throw new Error("Global reads must not read one project's locks");
    },
    globalLocks: () => ({
      status: "available",
      source: "global-read-only-lock-observation",
      sourceId: "locks:global",
      observedAtMs: readAtMs,
      value: { status: "unknown", entries: [], reason: "No owner observed" },
    }),
    timingSamples: (projectId) => {
      assert.equal(projectId, null);
      return {
        status: "available",
        source: "global-complete-wait-samples",
        sourceId: "waits:global",
        observedAtMs: readAtMs,
        value: [{ kind: "queueWait", valueMs: 25, observedAtMs: readAtMs }],
      };
    },
    terminalExecutions: () => ({
      status: "available",
      source: "global-terminal-history",
      sourceId: "execution-history:global",
      observedAtMs: readAtMs,
      value: [],
    }),
    processAlive: () => true,
  });
  // The public read scope is global; aggregate metric provenance remains broker-scoped.
  const snapshot = adapter.read({ scope: { kind: "global" } });
  assert.equal(snapshot.projectId.value, null);
  assert.equal(snapshot.currentCounts.scope, "broker");
  assert.equal(snapshot.overview.pendingProject.value, 2);
  assert.equal(snapshot.overview.pendingProject.scope, "broker");
  assert.equal(snapshot.overview.running.value, 1);
  assert.equal(snapshot.overview.unresolved.value, 1);
  assert.equal(snapshot.overview.failedExecutions.value, 0);
  assert.equal(snapshot.overview.waitMedianMs.value, 25);
  assert.equal(snapshot.presence.processCount.value, 1);
  assert.equal(snapshot.presence.clientCount.value, 1);
  assert.equal(snapshot.presence.sessionCount.value, 1);
  assert.equal(snapshot.host.hostname.value, "host-once");
  assert.equal(systemReads, 1);
});

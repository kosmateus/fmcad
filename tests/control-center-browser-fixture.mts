"use strict";

import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { createServer } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as assetsApi from "../packages/control-center/dist/resources/index.js";
import * as serverApi from "../packages/control-center/dist/server/index.js";
import type {
  ConsoleArtifactKind,
  ConsoleArtifactRequest,
  ConsoleAgentRecord,
  ConsoleDataCollection,
  ConsoleLogRecord,
  ConsoleOverviewRecord,
  ConsoleQueryHandler,
  ConsoleQueryPrincipal,
  ConsoleQueryRecord,
  ConsoleRevisionListener,
  ConsoleQueryScope,
  ConsoleSourceStatus,
  ConsoleTaskRecord,
} from "../packages/control-center/src/contracts/query.js";
import type {
  ConsoleArtifactRead,
  ConsoleOwnedArtifactReference,
  ConsoleQueryDataSnapshot,
  ConsoleQueryReadPort,
} from "../packages/control-center/src/server/query/port.js";

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const projectId = "project-e2e-alpha";

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Test server did not bind an IP address");
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

interface RetainedTestArtifact {
  readonly artifactId: string;
  readonly kind: ConsoleArtifactKind;
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface BrowserBackendCall {
  readonly method: "snapshot" | "query" | "export" | "detail" | "subscribe";
  readonly request?: unknown;
  readonly scope?: unknown;
}

interface RunningBrowserFixture {
  readonly origin: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  close(): Promise<void>;
}

export interface BrowserFixture {
  readonly calls: BrowserBackendCall[];
  readonly artifactHashes: {
    readonly originalSource: string;
    readonly response: string;
  };
  start(): Promise<RunningBrowserFixture>;
}

export function createBrowserFixture(): BrowserFixture {
  const fixtureParent = path.join(os.tmpdir(), "opencode");
  fs.mkdirSync(fixtureParent, { recursive: true });
  const artifactRoot = fs.mkdtempSync(
    path.join(fixtureParent, "fmcad-control-center-e2e-data-"),
  );
  const now = Date.now();
  const project = {
    id: projectId,
    name: "E2E Synthetic Project",
    color: "#8c75d9",
    pending: 2,
    state: "active",
  };
  const sourceContent = [
    "def e2e_fixture():",
    "    return 'synthetic retained source'",
    "",
  ].join("\n");
  const responseContent = "Synthetic E2E retained response.\n";
  const writeArtifact = (
    relativePath: string,
    content: string,
  ): RetainedTestArtifact => {
    const filePath = path.join(artifactRoot, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, { flag: "wx" });
    const bytes = fs.readFileSync(filePath);
    return {
      artifactId: `artifact-${relativePath.replaceAll("/", "-")}`,
      kind: relativePath.endsWith(".py")
        ? ("original-source" as const)
        : ("response" as const),
      path: relativePath,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  };
  const sourceArtifact = writeArtifact(
    "task-e2e-queued/original-source.py",
    sourceContent,
  );
  const responseArtifact = writeArtifact(
    "task-e2e-queued/response.txt",
    responseContent,
  );
  const retainedArtifacts = [sourceArtifact, responseArtifact] as const;
  const taskArtifacts: NonNullable<ConsoleTaskRecord["artifacts"]> = {
    originalSource: {
      artifactId: sourceArtifact.artifactId,
      sourceHash: sourceArtifact.sha256,
    },
    response: {
      artifactId: responseArtifact.artifactId,
      sourceHash: responseArtifact.sha256,
    },
    stdout: {
      state: "missing",
      reason: "No retained stdout in the synthetic browser record.",
    },
  };
  const tasks: ConsoleTaskRecord[] = [
    {
      id: "task-e2e-queued",
      label: "E2E queued task",
      state: "queued",
      projectId,
      projectName: project.name,
      clientId: "client-e2e",
      clientName: "E2E browser client",
      agentId: "agent-e2e-active",
      requestId: "request-e2e-queued",
      document: "queued-model.f3d",
      submittedAt: now - 1_000,
      waitMs: 25,
      executionMs: null,
      artifacts: taskArtifacts,
    },
    {
      id: "task-e2e-processing",
      label: "E2E processing task",
      state: "processing",
      projectId,
      projectName: project.name,
      clientId: "client-e2e",
      clientName: "E2E browser client",
      requestId: "request-e2e-processing",
      document: "processing-model.f3d",
      submittedAt: now - 2_000,
      startedAt: now - 1_500,
      waitMs: 500,
      executionMs: null,
    },
    {
      id: "task-e2e-completed",
      label: "E2E completed task",
      state: "completed",
      projectId,
      projectName: project.name,
      clientId: "client-e2e",
      clientName: "E2E browser client",
      requestId: "request-e2e-completed",
      document: "completed-model.f3d",
      submittedAt: now - 3_000,
      finishedAt: now - 120_000,
      waitMs: 125,
      executionMs: 1_250,
    },
    {
      id: "task-e2e-failed",
      label: "E2E failed task",
      state: "failed",
      projectId,
      projectName: project.name,
      clientId: "client-e2e",
      clientName: "E2E browser client",
      requestId: "request-e2e-failed",
      document: "failed-model.f3d",
      submittedAt: now - 4_000,
      finishedAt: now - 180_000,
      waitMs: 375,
      executionMs: 425,
    },
  ];
  for (let index = 4; index < 15; index += 1) {
    tasks.push({
      id: `task-e2e-page-${String(index).padStart(2, "0")}`,
      label: `E2E pagination task ${String(index).padStart(2, "0")}`,
      state: index % 2 === 0 ? "completed" : "queued",
      projectId,
      projectName: project.name,
      clientId: "client-e2e",
      clientName: "E2E browser client",
      requestId: `request-e2e-page-${index}`,
      document: `page-${index}.f3d`,
      submittedAt: now - index * 1_000,
      ...(index % 2 === 0 ? { finishedAt: now - index * 10_000 } : {}),
      waitMs: index * 10,
      executionMs: index % 2 === 0 ? index * 100 : null,
    });
  }

  const agents: ConsoleAgentRecord[] = [
    {
      id: "agent-e2e-active",
      name: "E2E Active Agent",
      kind: "OpenCode",
      presence: "active",
      projectId,
      sessionId: "session-e2e-active",
      work: "Reading the synthetic project",
      lastSeen: now - 1_000,
    },
    {
      id: "agent-e2e-history",
      name: "E2E Historical Agent",
      kind: "Codex",
      presence: "unknown",
      projectId,
      sessionId: "session-e2e-history",
      work: "Historical synthetic session",
      lastSeen: now - 60_000,
    },
  ];
  const logs: ConsoleLogRecord[] = [
    {
      id: "log-e2e-queued",
      projectId,
      taskId: "task-e2e-queued",
      requestId: "request-e2e-queued",
      clientId: "agent-e2e-history",
      timestamp: now - 900,
      level: "INFO",
      source: "e2e-worker",
      event: "TASK_QUEUED",
      message: "E2E queued task was accepted",
    },
    {
      id: "log-e2e-heartbeat",
      projectId,
      timestamp: now - 800,
      level: "DEBUG",
      source: "e2e-worker",
      event: "HEARTBEAT",
      message: "E2E synthetic heartbeat",
    },
    {
      id: "log-e2e-error",
      projectId,
      taskId: "task-e2e-failed",
      requestId: "request-e2e-failed",
      timestamp: now - 700,
      level: "ERROR",
      source: "e2e-broker",
      event: "TASK_FAILED",
      message: "E2E synthetic failure detail",
    },
  ];
  const overview: ConsoleOverviewRecord = {
    id: "overview-e2e",
    pendingProject: 2,
    running: 1,
    unresolved: 1,
    samples: 2,
    failedExecutions: 1,
    waitMedianMs: 250,
    waitP95Ms: 500,
    liveReportingSessions: 1,
    sampleWindow: { from: now - 3_600_000, to: now },
  };
  const system: ConsoleQueryRecord = {
    id: "system-e2e",
    host: {
      cpuPercent: 23,
      memoryUsedGiB: 4.5,
      memoryTotalGiB: 16,
      uptimeHours: 10,
    },
  };
  const source = (
    name: string,
    state: ConsoleSourceStatus["state"] = "available",
  ): ConsoleSourceStatus => ({
    state,
    source: `synthetic-${name}`,
    observedAt: now - (state === "stale" ? 60_000 : 250),
    ...(state === "stale" ? { reason: "E2E stale-data scenario" } : {}),
  });
  const collections: Partial<
    Record<ConsoleDataCollection, readonly ConsoleQueryRecord[]>
  > = {
    projects: [project],
    overview: [overview],
    tasks,
    agents,
    sessions: [],
    files: [],
    logs,
    system: [system],
  };
  const globalSnapshot: ConsoleQueryDataSnapshot = {
    revision: { epoch: "e2e-global", revision: 7 },
    capturedAt: now,
    scope: { kind: "global" },
    collections,
    sources: {
      projects: source("projects"),
      overview: source("overview"),
      tasks: source("tasks"),
      agents: source("agents"),
      sessions: source("sessions"),
      files: source("files"),
      logs: source("logs"),
      system: source("system"),
    },
    artifacts: retainedArtifacts.map((artifact) => ({
      projectId,
      taskId: "task-e2e-queued",
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      locator: {
        type: "project-file",
        path: artifact.path,
        bytes: artifact.bytes,
        sha256: artifact.sha256,
      },
    })),
  };
  const projectCollections: ConsoleQueryDataSnapshot["collections"] = {
    ...collections,
    projects: [project],
    tasks: tasks.filter((task) => task.projectId === projectId),
  };
  const projectSnapshot: ConsoleQueryDataSnapshot = {
    revision: { epoch: "e2e-project-alpha", revision: 11 },
    capturedAt: now,
    scope: { kind: "project", projectId },
    collections: projectCollections,
    sources: {
      projects: source("projects"),
      overview: source("overview"),
      agents: source("agents"),
      sessions: source("sessions"),
      files: source("files"),
      logs: source("logs"),
      system: source("system"),
      tasks: source("tasks", "stale"),
    },
    artifacts: retainedArtifacts.map((artifact) => ({
      projectId,
      taskId: "task-e2e-queued",
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      locator: {
        type: "project-file",
        path: artifact.path,
        bytes: artifact.bytes,
        sha256: artifact.sha256,
      },
    })),
  };
  const snapshots: readonly ConsoleQueryDataSnapshot[] = [
    globalSnapshot,
    projectSnapshot,
  ];
  const calls: BrowserBackendCall[] = [];
  const revisionListeners = new Set<ConsoleRevisionListener>();
  const readPort: ConsoleQueryReadPort = {
    async readSnapshot(
      scope: ConsoleQueryScope,
    ): Promise<ConsoleQueryDataSnapshot> {
      const snapshot =
        scope.kind === "global"
          ? globalSnapshot
          : snapshots.find(
              (item) =>
                item.scope.kind === "project" &&
                item.scope.projectId === scope.projectId,
            );
      if (!snapshot) throw new Error(`Unknown synthetic project scope`);
      return structuredClone(snapshot);
    },
    async readArtifact(
      reference: ConsoleOwnedArtifactReference,
      request: ConsoleArtifactRequest,
    ): Promise<ConsoleArtifactRead> {
      const artifact = retainedArtifacts.find(
        (item) =>
          item.artifactId === reference.artifactId &&
          item.kind === reference.kind &&
          reference.locator?.type === "project-file" &&
          item.path === reference.locator.path,
      );
      if (!artifact)
        return {
          state: "missing",
          content: null,
          offset: 0,
          length: 0,
          totalLength: null,
          reason: "No artifact is retained for this synthetic task.",
        };
      const filePath = path.resolve(artifactRoot, artifact.path);
      if (!filePath.startsWith(`${artifactRoot}${path.sep}`))
        throw new Error(
          "Synthetic artifact path escaped the owned fixture root",
        );
      const metadata = fs.lstatSync(filePath);
      if (!metadata.isFile() || metadata.isSymbolicLink())
        throw new Error("Synthetic artifact must be an owned regular file");
      const bytes = fs.readFileSync(filePath);
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== artifact.sha256 || bytes.length !== artifact.bytes)
        throw new Error(
          "Synthetic artifact does not match its retained snapshot",
        );
      const offset = Math.min(request.offset ?? 0, bytes.length);
      const end = Math.min(
        offset + (request.length ?? 64 * 1024),
        bytes.length,
      );
      const content = bytes.subarray(offset, end).toString("utf8");
      return {
        state: content.length ? "available" : "empty",
        content,
        offset,
        length: end - offset,
        totalLength: bytes.length,
      };
    },
  };
  const composition = serverApi.composeControlCenterService({
    readPort,
    resolvePrincipal: (): ConsoleQueryPrincipal => ({
      subject: "synthetic-browser-e2e",
      projectIds: [projectId],
      globalRead: true,
    }),
    subscribeRevisions(listener) {
      revisionListeners.add(listener);
      return () => revisionListeners.delete(listener);
    },
    queryOptions: { now: () => now },
  });
  const query: ConsoleQueryHandler = {
    snapshot(scope, principal) {
      calls.push({ method: "snapshot", request: structuredClone(scope) });
      return composition.query.snapshot(scope, principal);
    },
    query(request, principal) {
      calls.push({ method: "query", request: structuredClone(request) });
      return composition.query.query(request, principal);
    },
    export(request, principal) {
      calls.push({ method: "export", request: structuredClone(request) });
      return composition.query.export(request, principal);
    },
    detail(request, principal) {
      calls.push({ method: "detail", request: structuredClone(request) });
      return composition.query.detail(request, principal);
    },
    subscribe(scope, after, principal, listener) {
      calls.push({ method: "subscribe", scope: structuredClone(scope) });
      return composition.query.subscribe(scope, after, principal, listener);
    },
  };

  return {
    calls,
    artifactHashes: {
      originalSource: sourceArtifact.sha256,
      response: responseArtifact.sha256,
    },
    async start() {
      try {
        const port = await availablePort();
        const server = serverApi.createControlCenterHttpServer({
          identity: {
            port,
            protocolVersion: serverApi.CONTROL_CENTER_PROTOCOL_VERSION,
            buildIdentity: "a".repeat(64),
            pid: process.pid,
            processBirth: `browser-e2e:${process.pid}`,
            instanceNonce: randomBytes(32).toString("hex"),
            probeSecret: randomBytes(32).toString("hex"),
          },
          assets: assetsApi.loadConsoleHttpAssets(
            path.join(repository, "dist"),
          ),
          query,
          resolvePrincipal: composition.resolvePrincipal,
        });
        await server.start();
        return {
          origin: `http://localhost:${port}`,
          start: () => server.start(),
          stop: () => server.close(),
          async close() {
            await server.close();
            await composition.close?.();
            revisionListeners.clear();
            fs.rmSync(artifactRoot, { recursive: true, force: true });
          },
        };
      } catch (error) {
        await composition.close?.();
        revisionListeners.clear();
        fs.rmSync(artifactRoot, { recursive: true, force: true });
        throw error;
      }
    },
  };
}

export { projectId };

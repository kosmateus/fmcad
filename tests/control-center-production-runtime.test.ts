import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import type { ConsoleQueryScope } from "../packages/control-center/dist/contracts/query.js";
import { setupProjects } from "./control-center-test-support.js";

const root = process.cwd();
const { createControlCenterComposition } = require(
  path.join(root, "dist/src/dist/composition/control-center.js"),
) as typeof import("../dist/library-build/src/composition/control-center.js");
const { createPassiveConsoleTelemetry } = require(
  path.join(
    root,
    "dist/src/dist/node-adapters/control-center/passive-runtime.js",
  ),
) as typeof import("../packages/node-adapters/dist/control-center/passive-runtime.js");
const digest = (file: string): string =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");

test("installed project controls persist aliases and refuse unfenced archival", async (t) => {
  const fixture = setupProjects(t, ["project-a", "project-b"]);
  const composition = createControlCenterComposition(
    {
      port: 4748,
      installationRoot: path.join(root, "dist"),
      stateDirectory: path.join(fixture.root, "service"),
      buildIdentity: "a".repeat(64),
      protocolVersion: 1,
      instanceNonce: "b".repeat(64),
    },
    {
      registry: { filePath: fixture.registry.readonlyPath },
      queueDirectory: path.join(fixture.root, "absent-queue"),
      openCodePresenceDirectory: path.join(fixture.root, "absent-presence"),
    },
  );
  t.after(() => composition.close?.());
  const principal = await composition.resolvePrincipal({
    subject: "local-browser",
    createdAt: Date.now(),
  });
  const scope = { kind: "project" as const, projectId: "project-a" };
  const snapshot = await composition.query.snapshot(scope, principal);
  assert.ok("revision" in snapshot);
  const alias = await composition.projectActions!(principal, {
    version: 1,
    action: "set-alias",
    projectId: "project-a",
    expectedRevision: snapshot.revision,
    alias: "Production assembly",
  });
  assert.equal(alias.state, "ok");
  const refreshed = await composition.query.snapshot(scope, principal);
  assert.ok("revision" in refreshed);
  const archived = await composition.projectActions!(principal, {
    version: 1,
    action: "archive",
    projectId: "project-a",
    expectedRevision: refreshed.revision,
  });
  assert.notEqual(archived.state, "ok");
  assert.equal(fixture.registry.lookup("project-a")?.monitoring, true);
  const forbidden = await composition.projectActions!(
    { ...principal, projectIds: ["project-b"] },
    {
      version: 1,
      action: "set-alias",
      projectId: "project-a",
      expectedRevision: refreshed.revision,
      alias: "Unauthorized",
    },
  );
  assert.notEqual(forbidden.state, "ok");
  assert.equal(fs.existsSync(path.join(fixture.root, "absent-queue")), false);
});

test("installed composition reads registered SQLite histories without crossing project boundaries", async (t) => {
  const fixture = setupProjects(t, ["project-a", "project-b"]);
  // Hash every existing file, including outputs and SQLite histories, before observation.
  const files = fs
    .readdirSync(fixture.root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
  const before = new Map(files.map((file) => [file, digest(file)]));
  const composition = createControlCenterComposition(
    {
      port: 4748,
      installationRoot: path.join(root, "dist"),
      stateDirectory: path.join(fixture.root, "service"),
      buildIdentity: "a".repeat(64),
      protocolVersion: 1,
      instanceNonce: "b".repeat(64),
    },
    {
      registry: { filePath: fixture.registry.readonlyPath },
      queueDirectory: path.join(fixture.root, "absent-queue"),
      openCodePresenceDirectory: path.join(fixture.root, "absent-presence"),
    },
  );
  t.after(() => composition.close?.());
  const principal = await composition.resolvePrincipal({
    subject: "local-browser",
    createdAt: Date.now(),
  });
  assert.deepEqual(principal.projectIds, ["project-a", "project-b"]);
  for (const projectId of principal.projectIds) {
    const scope: ConsoleQueryScope = { kind: "project", projectId };
    const snapshot = await composition.query.snapshot(scope, principal);
    assert.ok("snapshotToken" in snapshot);
    const tasks = await composition.query.query(
      {
        version: 1,
        scope,
        collection: "tasks",
        snapshotToken: snapshot.snapshotToken,
      },
      principal,
    );
    assert.ok("rows" in tasks);
    assert.equal(tasks.rows.length, 1);
    assert.equal(tasks.rows[0]!["id"], `task-${projectId}`);
    assert.equal(tasks.rows[0]!["projectId"], projectId);
    assert.ok(
      !JSON.stringify(tasks).includes(
        `task-${projectId === "project-a" ? "project-b" : "project-a"}`,
      ),
    );
  }
  const unknownProject = await composition.query.snapshot(
    { kind: "project", projectId: "unregistered" },
    principal,
  );
  assert.ok("code" in unknownProject);
  assert.equal(unknownProject.code, "READ_MODEL_UNAVAILABLE");
  const forbidden = await composition.query.snapshot(
    { kind: "project", projectId: "project-b" },
    { ...principal, projectIds: ["project-a"], globalRead: false },
  );
  assert.ok("code" in forbidden);
  assert.equal(forbidden.code, "SCOPE_FORBIDDEN");
  await composition.close?.();
  for (const [file, hash] of before)
    assert.equal(digest(file), hash, `Read mutated ${file}`);
  assert.equal(fs.existsSync(path.join(fixture.root, "absent-queue")), false);
});

test("passive queue reads isolate owners and preserve pending recovery evidence", (t) => {
  const fixture = setupProjects(t, ["project-a", "project-b"]);
  const queueDirectory = path.join(fixture.root, "broker");
  fs.mkdirSync(queueDirectory);
  const queueFile = path.join(queueDirectory, "queue-state.json");
  const jobs = Object.fromEntries(
    ["project-a", "project-b"].map((projectId) => [
      `job-${projectId}`,
      {
        id: `job-${projectId}`,
        state: "running",
        requestId: `request-${projectId}`,
        clientId: `client-${projectId}`,
        submittedAt: 100,
        startedAt: 125,
        request: {
          cwd: fixture.projects.get(projectId)!.projectRoot,
          clientContext: { projectId },
        },
      },
    ]),
  );
  fs.writeFileSync(
    queueFile,
    JSON.stringify({ version: 1, revision: 2, epoch: 1, jobs }),
  );
  const before = digest(queueFile);
  const reader = createPassiveConsoleTelemetry({
    registry: fixture.registry,
    queueDirectory,
    openCodePresenceDirectory: path.join(fixture.root, "missing-presence"),
    inspectLocks: () => ({
      status: "unknown",
      source: "test-observation",
      entries: [],
    }),
  });
  const scope = {
    kind: "project",
    projectId: "project-a",
    projectDirectory: fixture.projects.get("project-a")!.projectRoot,
  } as const;
  const snapshot = reader.read({ scope });
  assert.equal(snapshot.events.availability, "available");
  assert.deepEqual(
    snapshot.events.value?.map((event) => event.identity.jobId.value),
    ["job-project-a"],
  );
  assert.equal(snapshot.overview.running.value, 1);
  const global = reader.read({ scope: { kind: "global" } });
  assert.equal(global.events.value?.length, 2);
  const savedQueue = fs.readFileSync(queueFile);
  fs.writeFileSync(
    queueFile,
    JSON.stringify({
      version: 1,
      revision: 3,
      epoch: 1,
      jobs: {
        ambiguous: { ...jobs["job-project-a"], projectId: "project-b" },
      },
    }),
  );
  const ambiguous = reader.read({ scope });
  assert.notEqual(
    ambiguous.events.availability,
    "available",
    "Contradictory registered project bindings must not be assigned to either owner",
  );
  assert.equal(ambiguous.overview.running.value, null);
  fs.writeFileSync(queueFile, savedQueue);
  const pending = path.join(queueDirectory, "queue-state.pending.json");
  fs.writeFileSync(pending, "recovery evidence belongs to the broker");
  const unavailable = reader.read({ scope });
  assert.notEqual(unavailable.events.availability, "available");
  assert.equal(unavailable.overview.running.value, null);
  assert.equal(digest(queueFile), before);
  assert.equal(
    fs.readFileSync(pending, "utf8"),
    "recovery evidence belongs to the broker",
  );
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createReporter } = require("../src/opencode/presence.cjs");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("OpenCode reporter scopes host sessions to one process instance and closes only its own snapshot", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-presence-"));
  const directory = path.join(root, "presence");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const firstEvents = [];
  const secondEvents = [];
  const first = createReporter(root, directory, {
    async publish(event) {
      firstEvents.push(event);
    },
    dispose() {},
  });
  const second = createReporter(root, directory, {
    async publish(event) {
      secondEvents.push(event);
    },
    dispose() {},
  });
  assert.ok(first && second);
  assert.notEqual(first.instanceId, second.instanceId);
  first.touch("session-with-private-title", {
    agent: "build",
    title: "Local title",
    lastTool: "fmcad_execute",
    status: "busy",
    requestId: "request:first",
    jobId: "job:first",
    documentId: "doc:first",
    turnId: "turn:first",
  });
  second.event({
    type: "session.created",
    properties: {
      requestID: "request:second",
      jobID: "job:second",
      turnID: "turn:second",
      info: {
        id: "another-session",
        title: "Another title",
        directory: root,
        documentID: "doc:second",
      },
    },
  });
  await sleep(160);
  const firstSnapshot = JSON.parse(await fs.readFile(first.file, "utf8"));
  const secondSnapshot = JSON.parse(await fs.readFile(second.file, "utf8"));
  assert.equal(firstSnapshot.schemaVersion, 1);
  assert.equal(firstSnapshot.instanceId, first.instanceId);
  assert.equal(firstSnapshot.pid, process.pid);
  assert.equal(typeof firstSnapshot.birth, "string");
  assert.equal(firstSnapshot.sessions.length, 1);
  assert.match(firstSnapshot.sessions[0].clientId, /^opencode:/);
  assert.equal(firstSnapshot.sessions[0].title, "Local title");
  assert.equal(secondSnapshot.sessions.length, 1);
  assert.equal(firstEvents[0].invocation.requestId, "request:first");
  assert.equal(firstEvents[0].invocation.jobId, "job:first");
  assert.equal(firstEvents[0].invocation.documentId, "doc:first");
  assert.equal(firstEvents[0].invocation.turnId, "turn:first");
  assert.equal(firstEvents[0].invocation.source, "opencode");
  assert.equal(secondEvents[0].invocation.requestId, "request:second");
  assert.equal(secondEvents[0].invocation.jobId, "job:second");
  assert.equal(secondEvents[0].invocation.documentId, "doc:second");
  assert.equal(secondEvents[0].invocation.turnId, "turn:second");
  await first.close();
  await assert.rejects(fs.access(first.file));
  await fs.access(second.file);
  await second.close();
  await assert.rejects(fs.access(second.file));
});

test("OpenCode reporter caps retained sessions and shutdown does not wait for a refresh timer", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "opencode-presence-bound-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const reporter = createReporter(root, path.join(root, "presence"));
  assert.ok(reporter);
  for (let index = 0; index < 220; index++)
    reporter.touch("session-" + index, { agent: "build" });
  await sleep(160);
  const snapshot = JSON.parse(await fs.readFile(reporter.file, "utf8"));
  assert.equal(snapshot.sessions.length, 200);
  await reporter.close();
});

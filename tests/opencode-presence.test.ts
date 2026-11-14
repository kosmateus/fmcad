import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { ObservationEvent } from "@fmcad/core";
const { createReporter } = createRequire(__filename)(
  path.join(process.cwd(), "src/opencode/presence.cjs"),
) as typeof import("../src/composition/library-opencode-presence");
function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function sessions(value: Record<string, unknown>): Record<string, unknown>[] {
  const items = value["sessions"];
  assert(Array.isArray(items));
  return items.map(object);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("OpenCode reporter scopes host sessions to one process instance and closes only its own snapshot", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-presence-"));
  const directory = path.join(root, "presence");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const firstEvents: ObservationEvent[] = [];
  const secondEvents: ObservationEvent[] = [];
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
  const firstSnapshot = object(
    JSON.parse(await fs.readFile(first.file, "utf8")) as unknown,
  );
  const secondSnapshot = object(
    JSON.parse(await fs.readFile(second.file, "utf8")) as unknown,
  );
  assert.equal(firstSnapshot["schemaVersion"], 1);
  assert.equal(firstSnapshot["instanceId"], first.instanceId);
  assert.equal(firstSnapshot["pid"], process.pid);
  assert.equal(typeof firstSnapshot["birth"], "string");
  assert.equal(sessions(firstSnapshot).length, 1);
  const firstSession = sessions(firstSnapshot)[0];
  assert(firstSession);
  assert.equal(typeof firstSession["clientId"], "string");
  assert.match(firstSession["clientId"] as string, /^opencode:/);
  assert.equal(firstSession["title"], "Local title");
  assert.equal(sessions(secondSnapshot).length, 1);
  assert(firstEvents[0] && secondEvents[0]);
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
  const snapshot = object(
    JSON.parse(await fs.readFile(reporter.file, "utf8")) as unknown,
  );
  assert.equal(sessions(snapshot).length, 200);
  await reporter.close();
});

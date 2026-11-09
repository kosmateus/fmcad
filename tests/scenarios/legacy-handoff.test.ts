import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ScenarioBackend, Owner } from "./contracts";
import {
  assertLegacyChildExited,
  finishCliIntent,
  observeCliIntent,
  ownedLease,
  recoverLegacyInvocations,
  reserveCli,
  writeHandoff,
} from "./legacy-handoff";
import type { TestContext } from "node:test";
function setup(t: TestContext) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "fmcad-owned-child-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, "legacy/intents"), { recursive: true });
  const owner: Owner = {
    runId: randomUUID(),
    scenarioId: "test",
    clientId: "",
  };
  const identity = { ...owner, clientId: "scenario:" + owner.runId + ":test" };
  const document = {
    creationId: "original-document",
    name: "Exact Name v1",
    file: {
      fileId: "original-file",
      projectId: "project",
      folderId: "folder",
      version: 1,
    },
  };
  const scope = path.join(directory, "legacy/lease.json");
  writeHandoff(path.join(directory, "creation.json"), {
    ...document,
    clientId: identity.clientId,
    requestId: identity.clientId + ":0",
  });
  writeHandoff(scope, {
    version: 1,
    owner: identity,
    document,
    directory,
    source: "tests/integration/example.test.js",
    testCase: "one case",
    protocol: "mcp",
  });
  const env = {
    FMCAD_LIVE_OWNED_SCOPE: scope,
    FMCAD_LIVE_CLIENT: identity.clientId,
    FMCAD_TEST_DOC: document.name,
  };
  return { directory, owner: identity, document, env };
}
test("owned child handoff refuses foreign document/file pins before durable submission intent", (t) => {
  const f = setup(t);
  assert.equal(ownedLease(f.env)?.document.creationId, f.document.creationId);
  assert.throws(
    () => reserveCli(["document", "status", "--doc", "base-name"], f.env),
    /Foreign legacy CLI pin/,
  );
  assert.throws(
    () => reserveCli(["document", "status", "--doc-file-id", "foreign"], f.env),
    /Foreign legacy CLI pin/,
  );
  assert.deepEqual(
    fs.readdirSync(path.join(f.directory, "legacy/intents")),
    [],
  );
  const reserved = reserveCli(["document", "status"], f.env)!;
  assert.ok(fs.existsSync(reserved.filename));
  assert.ok(reserved.words.includes(f.document.creationId));
  assert.ok(reserved.words.includes(f.document.file.fileId));
});
test("owned unsaved import handoff requires an explicit source mode and refuses cloud pins", (t) => {
  const f = setup(t);
  const scope = f.env.FMCAD_LIVE_OWNED_SCOPE;
  const lease = JSON.parse(fs.readFileSync(scope, "utf8")) as Record<
    string,
    unknown
  >;
  lease["document"] = {
    name: f.document.name,
    creationId: f.document.creationId,
  };
  writeHandoff(scope, lease);
  assert.throws(() => ownedLease(f.env), /incomplete/);
  lease["mode"] = "owned-unsaved-script";
  writeHandoff(scope, lease);
  assert.throws(() => ownedLease(f.env), /Invalid owned/);
  lease["source"] = "tests/live-data-import.ts";
  writeHandoff(scope, lease);
  assert.equal(ownedLease(f.env)?.document.file, undefined);
  assert.throws(
    () => reserveCli(["param", "list", "--doc-file-id", "foreign"], f.env),
    /cloud file pin/,
  );
  assert.throws(
    () => reserveCli(["param", "list", "--doc-id", "foreign"], f.env),
    /Foreign legacy CLI pin/,
  );
  const reserved = reserveCli(["param", "list"], f.env)!;
  assert.ok(reserved.words.includes(f.document.creationId));
  assert.equal(reserved.words.includes("--doc-file-id"), false);
  assert.ok(fs.existsSync(reserved.filename));
});
test("before-admission marker persists exact original request and foreign callbacks are refused", (t) => {
  const f = setup(t),
    reserved = reserveCli(["document", "status"], f.env)!;
  const intent = JSON.parse(fs.readFileSync(reserved.filename, "utf8")) as {
    requestId: string;
    admissionRequested: boolean;
  };
  const env = { ...f.env, FMCAD_LIVE_COMMAND_INTENT: reserved.filename };
  assert.throws(
    () =>
      observeCliIntent(
        'FMCAD_QUEUE_REQUEST {"requestId":"foreign","clientId":"foreign"}\n',
        env,
      ),
    /Foreign original/,
  );
  observeCliIntent(
    "FMCAD_QUEUE_REQUEST " +
      JSON.stringify({
        requestId: intent.requestId,
        clientId: f.owner.clientId,
      }) +
      "\n",
    env,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(reserved.filename, "utf8")).admissionRequested,
    true,
  );
  finishCliIntent(1, env);
  assert.equal(
    JSON.parse(fs.readFileSync(reserved.filename, "utf8")).exitCode,
    1,
  );
});
test("recovery uses original backend evidence once and never resubmits uncertain work", async (t) => {
  const f = setup(t),
    reserved = reserveCli(["document", "status"], f.env)!;
  const raw = JSON.parse(fs.readFileSync(reserved.filename, "utf8")) as Record<
    string,
    unknown
  >;
  writeHandoff(reserved.filename, {
    ...raw,
    admissionRequested: true,
    completed: true,
    pid: 2147483647,
    birth: "test-boot:0",
  });
  let lookups = 0,
    executions = 0,
    settled = false;
  const backend: ScenarioBackend = {
    identity: "test",
    mode: "simulator",
    qualification: "broker",
    protocol: "mcp",
    capabilities: new Set(),
    fusionPath: (value) => value,
    execute: async () => {
      executions++;
      throw new Error("Must never replay");
    },
    lookup: async (owner, requestId) => {
      assert.equal(owner.clientId, f.owner.clientId);
      assert.equal(requestId, raw["requestId"]);
      lookups++;
      return {
        requestId,
        state: settled ? "succeeded" : "unknown",
        sdkSettled: settled,
        mayHaveMutated: true,
        stdout: "original",
      };
    },
  };
  await assert.rejects(
    recoverLegacyInvocations(backend, f.directory, f.owner),
    /remains unsettled/,
  );
  settled = true;
  const recovered = await recoverLegacyInvocations(
    backend,
    f.directory,
    f.owner,
  );
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.result.stdout, "original");
  assert.equal(lookups, 2);
  assert.equal(executions, 0);
});
test("a possibly active child fences cleanup even if a launch file claims completion", (t) => {
  const f = setup(t);
  writeHandoff(path.join(f.directory, "legacy/launch.json"), {
    state: "completed",
    pid: 123,
    birth: "original",
  });
  assert.throws(
    () => assertLegacyChildExited(f.directory, () => true),
    /may still submit/,
  );
  assert.throws(
    () => assertLegacyChildExited(f.directory, () => null),
    /may still submit/,
  );
  assert.doesNotThrow(() => assertLegacyChildExited(f.directory, () => false));
});

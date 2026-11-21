import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import type {
  McpQueueClient,
  QueueRecovery,
} from "../src/composition/library-mcp-queue";

const root = process.cwd();
const load = createRequire(path.join(root, "package.json"));
const { createQueuePost } = load(
  path.join(root, "src/dist/composition/library-mcp-queue"),
) as typeof import("../src/composition/library-mcp-queue");

const ports = {
  catalog: () => ({
    tools: [],
    contracts: {},
    fromMcp: () => assert.fail("queue lookup is not a CAD call"),
    isLocal: () => false,
  }),
  resolveProjectDirectory: (selection: { projectDirectory?: string }) => ({
    projectDirectory: selection.projectDirectory ?? null,
    source: "test",
  }),
  buildHash: () => "a".repeat(64),
  readOwnedResult: () => Buffer.from(""),
  responseMessages: (raw: string) => JSON.parse(raw),
};

function queueRequest(client: McpQueueClient, requestId: string) {
  return createQueuePost(
    client,
    { backend: "mcp" },
    undefined,
    { clientId: "owner" },
    ports,
  )({
    jsonrpc: "2.0",
    id: "lookup-response",
    method: "tools/call",
    params: {
      name: "fmcad_queue_request",
      arguments: { requestId },
    },
  });
}

function clientForLookup(value: QueueRecovery | null) {
  const calls: string[] = [];
  const client: McpQueueClient = {
    dir: "/unused",
    auth: { clientId: "owner" },
    register: async () => {
      calls.push("register");
    },
    call: async (action) => {
      calls.push(action);
      return undefined;
    },
    submit: async () => assert.fail("request lookup must never submit"),
    findRequest: async () => {
      calls.push("findRequest");
      return value;
    },
    wait: async () => assert.fail("request lookup must never wait"),
  };
  return { client, calls };
}

function structuredContent(response: { raw: string }) {
  return JSON.parse(response.raw).result.structuredContent as Record<
    string,
    unknown
  >;
}

test("public request lookup separates missing records from accepted unresolved jobs", async () => {
  const missing = clientForLookup(null);
  const missingResponse = await queueRequest(missing.client, "request-missing");
  const missingResult = structuredContent(missingResponse);
  assert.equal(missingResult["status"], "needs_reconciliation");
  assert.equal(missingResult["jobId"], null);
  assert.equal(missingResult["lookupState"], "no_owned_job");
  assert.equal(missingResult["acceptanceState"], "unknown");
  assert.equal(missingResult["jobState"], null);
  assert.equal(missingResult["globalQueueState"], "not_read");
  assert.equal(missingResult["reason"], "no_owned_job_record");
  assert.match(String(missingResult["instruction"]), /acceptance is unknown/i);
  assert.match(
    String(missingResult["instruction"]),
    /global queue state was not read/i,
  );
  assert(!Object.hasOwn(missingResult, "queueBlocked"));
  assert.deepEqual(missing.calls, ["register", "findRequest"]);

  const job = {
    id: "job-unresolved",
    requestId: "request-unresolved",
    clientId: "owner",
    state: "needs_reconciliation",
    revision: 4,
  };
  const accepted = clientForLookup({ job, context: { clientId: "owner" } });
  const acceptedResponse = await queueRequest(
    accepted.client,
    "request-unresolved",
  );
  const acceptedResult = structuredContent(acceptedResponse);
  assert.equal(acceptedResult["status"], "needs_reconciliation");
  assert.equal(acceptedResult["jobId"], job.id);
  assert.equal(acceptedResult["lookupState"], "job_found");
  assert.equal(acceptedResult["acceptanceState"], "accepted");
  assert.equal(acceptedResult["jobState"], "needs_reconciliation");
  assert.equal(acceptedResult["reason"], "accepted_job_needs_reconciliation");
  assert.equal(acceptedResult["globalQueueState"], "not_read");
  assert(!Object.hasOwn(acceptedResult, "queueBlocked"));
  assert.deepEqual(accepted.calls, ["register", "findRequest"]);
});

test("source-authenticated backend mismatch reports rejection before admission", async () => {
  const calls: string[] = [];
  const mismatch = Object.assign(new Error("Job backend differs from broker"), {
    code: "BACKEND_MISMATCH",
  });
  const client: McpQueueClient = {
    dir: "/unused",
    auth: { clientId: "owner" },
    register: async () => {
      calls.push("register");
    },
    call: async (action) => {
      calls.push(action);
      return undefined;
    },
    submit: async () => {
      calls.push("submit");
      throw mismatch;
    },
    findRequest: async () => {
      calls.push("findRequest");
      return null;
    },
    wait: async () => assert.fail("rejected requests must not wait"),
  };
  const response = await createQueuePost(
    client,
    { backend: "addin" },
    undefined,
    { clientId: "owner", projectDirectory: "/tmp" },
    ports,
  )({
    jsonrpc: "2.0",
    id: "rejected-response",
    method: "tools/call",
    params: { name: "unregistered_tool", arguments: {} },
  });
  const body = JSON.parse(response.raw);
  assert.equal(body.error.data.requestStatus, "rejected-before-admission");
  assert.equal(body.error.data.acceptanceState, "rejected-before-admission");
  assert.equal(body.error.data.globalQueueState, "not_read");
  assert.equal(typeof body.error.data.requestId, "string");
  assert.ok(body.error.data.requestId.length > 0);
  assert.match(body.error.message, /BACKEND_MISMATCH/);
  assert.deepEqual(calls, ["register", "submit", "findRequest"]);
});
